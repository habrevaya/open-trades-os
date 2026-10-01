import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { createHmac } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as payments from "../src/services/payments";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as leadIntake from "../src/services/lead-intake";
import {
  stripeProvider, verifyStripeSignature, SIGNATURE_HEADER, MAX_SKEW_MS,
} from "../src/payments/stripe";
import type {
  ChargeOutcome, PaymentEvent, PaymentProvider, RefundOutcome, WebhookRequest,
} from "../src/payments/provider";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * TAKING A CARD
 *
 * Everything under this feature already existed and had never been reached: a
 * `processor` column defaulting to "stripe", a `processor_payment_id` beside
 * it, a fee column, and a ledger posting with a processing fee leg that
 * nothing ever fed. A company running this could record that a card had been
 * taken somewhere else.
 *
 * THE PROPERTY THIS FILE IS MOSTLY ABOUT IS THAT NOTHING MARKS AN INVOICE
 * PAID EXCEPT A VERIFIED WEBHOOK. Every other rule here is downstream of it.
 * A forged or replayed `payment_intent.succeeded` closes an invoice against
 * money that is not in the bank, and nothing after this point can tell: the
 * balance is zero, the job closes, the customer is never chased, and the
 * ledger balances perfectly. There is no reconciliation step that catches it
 * because every system downstream believes the event.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pay13:org");
const USER = fixtureId("pay13:user");
const KEY_REF = "TEST_STRIPE_KEY";
const HOOK_REF = "TEST_STRIPE_WEBHOOK";
const HOOK_SECRET = "whsec_test_secret";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
  ...extra,
});

/** What the provider was asked for, so a test can assert on the request as well as the answer. */
interface Recorder {
  charges: { amountMinor: number; idempotencyKey: string; metadata: Record<string, string> }[];
  refunds: { intentId: string; amountMinor?: number | undefined }[];
}

/**
 * A processor that never reaches the network.
 *
 * Injected rather than intercepted, for the reason the outbox gives: a test
 * that monkey patches `fetch` passes against a provider whose shape has
 * drifted, and the point of the seam is that the shape is the contract.
 */
function fakeProvider(recorder: Recorder, over: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    name: "stripe",
    publishableKey: "pk_test_123",
    async charge(request): Promise<ChargeOutcome> {
      recorder.charges.push({
        amountMinor: request.amountMinor,
        idempotencyKey: request.idempotencyKey,
        metadata: request.metadata ?? {},
      });
      return {
        ok: true,
        intent: {
          intentId: `pi_${recorder.charges.length}`,
          clientSecret: `pi_${recorder.charges.length}_secret`,
          amountMinor: request.amountMinor,
          currency: "usd",
          status: "requires_payment_method",
        },
      };
    },
    async refund(request): Promise<RefundOutcome> {
      recorder.refunds.push({ intentId: request.intentId, amountMinor: request.amountMinor });
      return {
        ok: true,
        refund: { refundId: `re_${recorder.refunds.length}`, amountMinor: request.amountMinor ?? 0, status: "pending" },
      };
    },
    verify: () => true,
    parseEvent: () => null,
    ...over,
  };
}

const deps = (provider: PaymentProvider): payments.PaymentDeps => ({
  readSecret: async () => "sk_test_notreal",
  provider,
});

async function connectStripe(settings: Record<string, unknown> = {}): Promise<string> {
  const [row] = await raw`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', ${KEY_REF},
            ${raw.json({ publishableKey: "pk_test_123", webhookSecretRef: HOOK_REF, ...settings } as never)})
    returning id`;
  return (row as { id: string }).id;
}

async function accountBalance(account: string): Promise<string> {
  const [row] = await raw`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} and account_code = ${account}`;
  return (row as { net: string }).net;
}

/** A customer with one open invoice for the given total. */
async function customerWithInvoice(total: string) {
  const customer = await customers.create(ctx(), {
    type: "residential", name: "Card Payer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const invoice = await billing.create(ctx(), {
    customerId: customer.id,
    lines: [{ name: "Repair", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return { customerId: customer.id, invoiceId: invoice.id as string, invoice };
}

/** An event shaped the way the provider hands one over, already parsed. */
function event(over: Partial<payments.PaymentEvent> = {}): payments.PaymentEvent {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    kind: "succeeded",
    type: "payment_intent.succeeded",
    intentId: "pi_1",
    amountMinor: 45800,
    currency: "usd",
    feeMinor: null,
    refundedMinor: null,
    metadata: {},
    failureMessage: null,
    ...over,
  };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Card Co", slug: "card-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  /**
   * The whole organization, through the helper, rather than a list of
   * deletes.
   *
   * `ledger_entry` refuses a DELETE by a trigger, which is correct and is one
   * of the properties this project rests on, so a teardown that tried to
   * clear it directly failed on its own first statement. The helper suspends
   * user triggers for its own session and restores them, which is the
   * standard teardown mechanism and changes nothing about the trigger.
   */
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Card Co", slug: "card-co" });
});

/* ============================================================ the signature */

describe("the signature, which is the whole of the authentication", () => {
  const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });

  const signed = (secret: string, at: number, raw_ = body): WebhookRequest => {
    const t = Math.floor(at / 1000);
    return {
      headers: {
        [SIGNATURE_HEADER]:
          `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw_}`).digest("hex")}`,
      },
      body: raw_,
    };
  };

  it("accepts a delivery signed with the endpoint's secret", () => {
    const now = Date.now();
    expect(verifyStripeSignature(signed(HOOK_SECRET, now), HOOK_SECRET, () => now)).toBe(true);
  });

  it("refuses a delivery signed with a different secret", () => {
    const now = Date.now();
    expect(verifyStripeSignature(signed("whsec_other", now), HOOK_SECRET, () => now)).toBe(false);
  });

  it("refuses a body that changed after it was signed", () => {
    /**
     * The signature covers the RAW body. This is what catches an attacker
     * who replays a real delivery with the amount edited, and it is also why
     * nothing between the socket and the check may reparse the body: a
     * JSON round trip moves one byte of whitespace and every genuine
     * delivery starts failing, which presents as "the secret is wrong".
     */
    const now = Date.now();
    const request = signed(HOOK_SECRET, now);
    expect(verifyStripeSignature({ ...request, body: `${body} ` }, HOOK_SECRET, () => now)).toBe(false);
  });

  it("refuses a delivery older than the tolerance", () => {
    /**
     * Without the window, one captured delivery verifies forever. The event
     * id check stops a replay being ACTED on twice; this stops it being
     * believed at all, and the two guard different things: the first is a
     * database lookup that a fresh forgery walks past, this is arithmetic.
     */
    const now = Date.now();
    expect(
      verifyStripeSignature(signed(HOOK_SECRET, now - MAX_SKEW_MS - 1000), HOOK_SECRET, () => now),
    ).toBe(false);
  });

  it("accepts a header carrying a second signature from a rotation", () => {
    /**
     * Stripe sends several `v1` values while a secret is being rotated, and
     * the header is valid if ANY of them matches. Parsing it into a flat
     * object keeps the last one and rejects everything signed with the
     * other secret, which presents as random webhook failures during the one
     * week somebody is rotating.
     */
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const ours = createHmac("sha256", HOOK_SECRET).update(`${t}.${body}`).digest("hex");

    /**
     * BOTH ORDERS, and the first one is the test that bites. A first version
     * of this only put ours last, so an implementation that read the final
     * `v1` and ignored the rest passed it. That is precisely the bug: during
     * a rotation Stripe signs with the old secret and the new one, in an
     * order nobody controls, and reading one position rejects half the
     * deliveries for as long as the rotation lasts.
     */
    for (const header of [`t=${t},v1=deadbeef,v1=${ours}`, `t=${t},v1=${ours},v1=deadbeef`]) {
      const request: WebhookRequest = { headers: { [SIGNATURE_HEADER]: header }, body };
      expect(verifyStripeSignature(request, HOOK_SECRET, () => now), header).toBe(true);
    }
  });

  it("refuses a delivery with no signature header at all", () => {
    expect(verifyStripeSignature({ headers: {}, body }, HOOK_SECRET)).toBe(false);
  });
});

/* =============================================================== parsing */

describe("reading what the processor said", () => {
  const provider = stripeProvider({}, "sk_test");
  const parse = (payload: unknown) =>
    provider.parseEvent({ headers: {}, body: JSON.stringify(payload) });

  it("finds the intent on a charge event as well as an intent event", () => {
    /**
     * A charge names its intent in `payment_intent`; an intent IS the intent
     * and names it in `id`. Reading only one makes every refund unmatchable,
     * which presents as a refund that verified, parsed, logged and changed
     * nothing at all.
     */
    expect(parse({
      id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_9" } },
    })?.intentId).toBe("pi_9");

    expect(parse({
      id: "evt_2", type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: "pi_9" } },
    })?.intentId).toBe("pi_9");
  });

  it("reports no fee as null rather than as zero", () => {
    /**
     * Stripe puts the fee on the balance transaction, which does not always
     * exist when the payment succeeds. Zero is a claim that the payment was
     * free, and a company that believes it reports card revenue it never
     * received.
     */
    expect(parse({
      id: "evt_3", type: "payment_intent.succeeded",
      data: { object: { id: "pi_1", amount: 1000 } },
    })?.feeMinor).toBeNull();

    expect(parse({
      id: "evt_4", type: "payment_intent.succeeded",
      data: { object: { id: "pi_1", amount: 1000, latest_charge: { balance_transaction: { fee: 59 } } } },
    })?.feeMinor).toBe(59);
  });

  it("calls an event it does not model 'other' rather than guessing", () => {
    expect(parse({
      id: "evt_5", type: "charge.failed", data: { object: { id: "ch_2" } },
    })?.kind).toBe("other");
  });

  it("refuses a body that is not an event", () => {
    expect(provider.parseEvent({ headers: {}, body: "not json" })).toBeNull();
    expect(parse({ id: "evt_6" })).toBeNull();
  });
});

/* ============================================================== charging */

run("starting a payment", () => {
  it("reads the amount from the invoice rather than from the caller", async () => {
    /**
     * The caller is usually a browser. One that can name both the invoices
     * and the amount can name a number that suits it, and this path is
     * reached by a customer portal where the person paying is the person who
     * would benefit.
     */
    await connectStripe();
    const { customerId, invoiceId } = await customerWithInvoice("458.00");
    const recorder: Recorder = { charges: [], refunds: [] };

    const result = await payments.intent(
      ctx(), { customerId, invoiceIds: [invoiceId], amount: "1.00" },
      deps(fakeProvider(recorder)),
    );

    /** Money carries four decimal places through this product, not two. */
    expect(result.amount).toBe("458.0000");
    expect(recorder.charges[0]!.amountMinor).toBe(45800);
  });

  it("writes no payment, because nothing has been paid", async () => {
    /**
     * The obvious design writes a `pending` payment row here. Most intents
     * are never completed: somebody opens the payment page and thinks better
     * of it. A table of abandoned pending payments is one every report has to
     * learn to exclude, and the first report that forgets shows revenue that
     * does not exist.
     */
    await connectStripe();
    const { customerId, invoiceId } = await customerWithInvoice("100.00");
    await payments.intent(ctx(), { customerId, invoiceIds: [invoiceId] },
      deps(fakeProvider({ charges: [], refunds: [] })));

    const rows = await raw`select count(*)::int as n from public.payment where organization_id = ${ORG}`;
    expect((rows[0] as { n: number }).n).toBe(0);

    const invoice = await billing.get(ctx(), { id: invoiceId });
    expect(invoice.status).toBe("open");
  });

  it("sends an idempotency key the processor can deduplicate on", async () => {
    /**
     * A card charge is the one request in this product where a retry that is
     * not deduplicated takes a second thousand dollars off somebody, and the
     * failure that causes it is ordinary: the charge succeeded and the
     * response was lost.
     */
    await connectStripe();
    const { customerId, invoiceId } = await customerWithInvoice("50.00");
    const recorder: Recorder = { charges: [], refunds: [] };
    await payments.intent(ctx(), { customerId, invoiceIds: [invoiceId] }, deps(fakeProvider(recorder)));

    expect(recorder.charges[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses an invoice with nothing outstanding", async () => {
    await connectStripe();
    const { customerId, invoiceId } = await customerWithInvoice("80.00");
    await billing.pay(ctx({ idempotencyKey: "cash-1" }), {
      customerId, method: "cash", amount: "80.00", tipAmount: "0",
      allocations: [{ invoiceId, amount: "80.00" }],
    });

    await expect(payments.intent(ctx(), { customerId, invoiceIds: [invoiceId] },
      deps(fakeProvider({ charges: [], refunds: [] }))))
      .rejects.toThrow(/nothing outstanding/i);
  });

  it("refuses a charge for an amount nobody named", async () => {
    await connectStripe();
    const { customerId } = await customerWithInvoice("10.00");
    await expect(payments.intent(ctx(), { customerId },
      deps(fakeProvider({ charges: [], refunds: [] }))))
      .rejects.toThrow(/which invoices|how much/i);
  });

  it("refuses when no processor is connected", async () => {
    const { customerId, invoiceId } = await customerWithInvoice("10.00");
    await expect(payments.intent(ctx(), { customerId, invoiceIds: [invoiceId] },
      deps(fakeProvider({ charges: [], refunds: [] }))))
      .rejects.toThrow(/No payment provider configured/i);
  });
});

/* ============================================================= settling */

run("what a verified event does", () => {
  async function started(total: string) {
    const connectionId = await connectStripe();
    const connection = (await payments.connectionById(db(), connectionId))!;
    const { customerId, invoiceId } = await customerWithInvoice(total);
    const recorder: Recorder = { charges: [], refunds: [] };
    const attempt = await payments.intent(
      ctx(), { customerId, invoiceIds: [invoiceId] }, deps(fakeProvider(recorder)),
    );
    return { connection, customerId, invoiceId, attempt };
  }

  it("closes the invoice and posts the ledger", async () => {
    const { connection, invoiceId, attempt } = await started("458.00");

    const outcome = await payments.receive(db(), {
      connection,
      event: event({ intentId: attempt.intentId, amountMinor: 45800 }),
    });

    expect(outcome.handled).toBe(true);
    const invoice = await billing.get(ctx(), { id: invoiceId });
    expect(invoice.status).toBe("paid");
    expect(invoice.balance).toBe("0.0000");
    expect(await accountBalance("1200")).toBe("0.0000");
  });

  it("posts the processor's fee to an expense rather than to cash", async () => {
    /**
     * `postPayment` has debited a processing fee since it was written and
     * `billing.pay` never passed one, so every card payment booked its gross
     * amount to cash. That overstates the bank by the fee on every card the
     * company has ever taken, and nothing shows it until somebody reconciles
     * against a statement.
     */
    const { connection, attempt } = await started("100.00");

    await payments.receive(db(), {
      connection,
      event: event({ intentId: attempt.intentId, amountMinor: 10000, feeMinor: 320 }),
    });

    expect(await accountBalance("1000")).toBe("96.8000");  // cash net of the fee
    expect(await accountBalance("6100")).toBe("3.2000");   // the fee, as an expense
  });

  it("does not settle the same event twice", async () => {
    /**
     * Stripe retries a delivery for days when our answer was slow or our
     * deploy was mid restart, and it is the same event each time. Settling it
     * twice pays an invoice twice and writes two balanced ledger
     * transactions that both look deliberate.
     */
    const { connection, attempt } = await started("200.00");
    const same = event({ intentId: attempt.intentId, amountMinor: 20000 });

    const first = await payments.receive(db(), { connection, event: same });
    const second = await payments.receive(db(), { connection, event: same });

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(false);

    const rows = await raw`select count(*)::int as n from public.payment where organization_id = ${ORG}`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("believes the processor's amount over the one we asked for", async () => {
    /**
     * They can differ: a partial capture is real, and so is somebody
     * charging a different amount through the Stripe dashboard. Believing
     * our own request would close an invoice on money that never arrived,
     * which is the failure this whole feature is arranged to prevent.
     */
    const { connection, invoiceId, attempt } = await started("458.00");

    await payments.receive(db(), {
      connection,
      event: event({ intentId: attempt.intentId, amountMinor: 20000 }),
    });

    const invoice = await billing.get(ctx(), { id: invoiceId });
    expect(invoice.status).toBe("partially_paid");
    expect(invoice.balance).toBe("258.0000");
  });

  it("refuses an event for a payment nothing here started", async () => {
    /**
     * Logged rather than guessed at. An event naming an intent this product
     * never created has no customer to credit, and picking one would put
     * somebody else's money on a stranger's account.
     */
    const connectionId = await connectStripe();
    const connection = (await payments.connectionById(db(), connectionId))!;

    await expect(payments.receive(db(), {
      connection, event: event({ intentId: "pi_never_seen" }),
    })).rejects.toThrow(ConflictError);
  });

  it("marks a dispute without moving the money", async () => {
    /**
     * A dispute is not a refund. The bank has pulled the money back pending
     * a decision that can go either way, so writing it off now would have to
     * be written back on roughly half of them.
     */
    const { connection, attempt } = await started("300.00");
    await payments.receive(db(), {
      connection, event: event({ intentId: attempt.intentId, amountMinor: 30000 }),
    });

    await payments.receive(db(), {
      connection,
      event: event({ kind: "disputed", type: "charge.dispute.created", intentId: attempt.intentId }),
    });

    const [row] = await raw`
      select status, refunded_amount::text from public.payment where organization_id = ${ORG}`;
    expect((row as { status: string }).status).toBe("disputed");
    expect((row as { refunded_amount: string }).refunded_amount).toBe("0.0000");
  });

  it("takes the refunded total from the processor rather than adding to it", async () => {
    /**
     * Stripe reports the CUMULATIVE amount refunded. Adding it to what we
     * hold double counts the moment a second partial refund arrives, and the
     * payment then reads as more than fully refunded.
     */
    const { connection, attempt } = await started("100.00");
    await payments.receive(db(), {
      connection, event: event({ intentId: attempt.intentId, amountMinor: 10000 }),
    });

    for (const cumulative of [2500, 4000]) {
      await payments.receive(db(), {
        connection,
        event: event({
          kind: "refunded", type: "charge.refunded",
          intentId: attempt.intentId, refundedMinor: cumulative,
        }),
      });
    }

    const [row] = await raw`
      select status, refunded_amount::text from public.payment where organization_id = ${ORG}`;
    expect((row as { refunded_amount: string }).refunded_amount).toBe("40.0000");
    expect((row as { status: string }).status).toBe("partially_refunded");
  });

  it("records an event it does not model instead of acting on it", async () => {
    const connectionId = await connectStripe();
    const connection = (await payments.connectionById(db(), connectionId))!;

    const outcome = await payments.receive(db(), {
      connection, event: event({ kind: "other", type: "charge.failed", intentId: null }),
    });

    expect(outcome.handled).toBe(false);
    const rows = await raw`
      select count(*)::int as n from public.integration_event
      where organization_id = ${ORG} and direction = 'inbound'`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

/* =============================================================== refunds */

run("giving it back", () => {
  async function paid(total: string) {
    const connectionId = await connectStripe();
    const connection = (await payments.connectionById(db(), connectionId))!;
    const { customerId, invoiceId } = await customerWithInvoice(total);
    const recorder: Recorder = { charges: [], refunds: [] };
    const attempt = await payments.intent(
      ctx(), { customerId, invoiceIds: [invoiceId] }, deps(fakeProvider(recorder)),
    );
    await payments.receive(db(), {
      connection,
      event: event({ intentId: attempt.intentId, amountMinor: Math.round(Number(total) * 100) }),
    });
    const [row] = await raw`select id from public.payment where organization_id = ${ORG}`;
    return { connection, recorder, paymentId: (row as { id: string }).id };
  }

  it("refuses more than is left", async () => {
    const { paymentId, recorder } = await paid("100.00");
    await expect(payments.refund(ctx(), { paymentId, amount: "150.00" }, deps(fakeProvider(recorder))))
      .rejects.toThrow(/left to refund/i);
  });

  it("refuses a payment that never went through a processor", async () => {
    /**
     * Money that arrived as a cheque goes back as a cheque. Asking Stripe to
     * refund a charge it never took returns an error that reads like a bug in
     * this product rather than a description of what happened.
     */
    await connectStripe();
    const { customerId, invoiceId } = await customerWithInvoice("60.00");
    const cheque = await billing.pay(ctx({ idempotencyKey: "chq-1" }), {
      customerId, method: "check", amount: "60.00", tipAmount: "0",
      allocations: [{ invoiceId, amount: "60.00" }],
    });

    await expect(payments.refund(ctx(), { paymentId: cheque.id },
      deps(fakeProvider({ charges: [], refunds: [] }))))
      .rejects.toThrow(/not taken through a card processor/i);
  });

  it("does not write the refund until the webhook says the money moved", async () => {
    /**
     * Stripe answers with a refund that is PENDING. Writing the column here
     * as well as on the webhook is two paths to one number, and they
     * disagree on the day a refund is created and then fails.
     */
    const { paymentId, recorder } = await paid("100.00");
    const result = await payments.refund(ctx(), { paymentId, amount: "25.00" },
      deps(fakeProvider(recorder)));

    expect(result.settled).toBe(false);
    expect(recorder.refunds[0]!.amountMinor).toBe(2500);

    const [row] = await raw`
      select refunded_amount::text, status from public.payment where id = ${paymentId}`;
    expect((row as { refunded_amount: string }).refunded_amount).toBe("0.0000");
    expect((row as { status: string }).status).toBe("succeeded");
  });
});

/* ================================================ a refund Stripe reports */

run("a refund the processor reports, on the books", () => {
  /**
   * The webhook used to move `refunded_amount` and nothing else, so a card
   * refund left cash on the books that had gone back to the customer and an
   * invoice marked paid that was not. These are the properties of putting it
   * on the books the way a recorded refund is.
   */
  async function cardPaid(total: string) {
    const connectionId = await connectStripe();
    const connection = (await payments.connectionById(db(), connectionId))!;
    const { customerId, invoiceId } = await customerWithInvoice(total);
    const attempt = await payments.intent(
      ctx(), { customerId, invoiceIds: [invoiceId] }, deps(fakeProvider({ charges: [], refunds: [] })),
    );
    const minor = Math.round(Number(total) * 100);
    await payments.receive(db(), {
      connection, event: event({ intentId: attempt.intentId, amountMinor: minor }),
    });
    return { connection, invoiceId, intentId: attempt.intentId };
  }

  const refundEvent = (intentId: string, over: Partial<PaymentEvent> = {}): PaymentEvent => event({
    kind: "refunded", type: "refund.updated", intentId, amountMinor: null, refundedMinor: null,
    ...over,
  });

  const refundPostings = () => raw<{ occurred_at: Date; n: string }[]>`
    select occurred_at, count(*)::text as n from public.ledger_entry
    where organization_id = ${ORG} and source_type = 'refund'
    group by transaction_id, occurred_at order by occurred_at`;

  it("posts the refund, dated when it was made, and reopens the invoice", async () => {
    const { connection, invoiceId, intentId } = await cardPaid("100.00");
    const madeAt = new Date(Date.now() - 2 * 3600_000);

    await payments.receive(db(), {
      connection,
      event: refundEvent(intentId, {
        refunds: [{ refundId: "re_A", amountMinor: 2500, createdAt: madeAt, status: "succeeded" }],
      }),
    });

    /** Cash goes back out and the receivable comes back, by the refund. */
    expect(await accountBalance("1000")).toBe("75.0000");
    expect(await accountBalance("1200")).toBe("25.0000");
    const postings = await refundPostings();
    expect(postings).toHaveLength(1);
    expect(postings[0]!.occurred_at.toISOString()).toBe(madeAt.toISOString());

    const invoice = await billing.get(ctx(), { id: invoiceId });
    expect(invoice.status).toBe("partially_paid");
    expect(invoice.balance).toBe("25.0000");
    const [row] = await raw<{ refunded_amount: string; status: string }[]>`
      select refunded_amount::text, status from public.payment where organization_id = ${ORG}`;
    expect(row!.refunded_amount).toBe("25.0000");
    expect(row!.status).toBe("partially_refunded");
  });

  it("books one refund once, however many events report it", async () => {
    /**
     * Stripe sends `refund.created`, `refund.updated` and `charge.refunded`
     * for one refund, three event ids between them. Keyed on the event, this
     * was three postings.
     */
    const { connection, intentId } = await cardPaid("100.00");
    const refund = { refundId: "re_B", amountMinor: 4000, createdAt: new Date(), status: "succeeded" };
    await payments.receive(db(), {
      connection, event: refundEvent(intentId, { type: "refund.created", refunds: [refund] }),
    });
    await payments.receive(db(), {
      connection, event: refundEvent(intentId, { type: "refund.updated", refunds: [refund] }),
    });
    await payments.receive(db(), {
      connection,
      event: refundEvent(intentId, { type: "charge.refunded", refundedMinor: 4000, refunds: [refund] }),
    });

    expect(await refundPostings()).toHaveLength(1);
    expect(await accountBalance("1000")).toBe("60.0000");
  });

  it("does not book a refund twice when the cumulative total arrived first", async () => {
    /**
     * On API versions that no longer list refunds on the charge,
     * `charge.refunded` carries only the cumulative total. That is booked,
     * and the `refund.updated` naming the same refund afterwards finds the
     * money already counted.
     */
    const { connection, intentId } = await cardPaid("100.00");
    await payments.receive(db(), {
      connection, event: refundEvent(intentId, { type: "charge.refunded", refundedMinor: 3000 }),
    });
    await payments.receive(db(), {
      connection,
      event: refundEvent(intentId, {
        refunds: [{ refundId: "re_C", amountMinor: 3000, createdAt: new Date(), status: "succeeded" }],
      }),
    });

    expect(await refundPostings()).toHaveLength(1);
    expect(await accountBalance("1000")).toBe("70.0000");

    /** And a second, different refund after that is booked in full. */
    await payments.receive(db(), {
      connection,
      event: refundEvent(intentId, {
        refunds: [{ refundId: "re_D", amountMinor: 1000, createdAt: new Date(), status: "succeeded" }],
      }),
    });
    expect(await refundPostings()).toHaveLength(2);
    expect(await accountBalance("1000")).toBe("60.0000");
  });

  it("records a refund it cannot book against a void invoice instead of failing the webhook", async () => {
    const { connection, invoiceId, intentId } = await cardPaid("100.00");
    await raw`update public.invoice set status = 'void' where id = ${invoiceId}`;
    const outcome = await payments.receive(db(), {
      connection,
      event: refundEvent(intentId, {
        refunds: [{ refundId: "re_V", amountMinor: 1000, createdAt: new Date(), status: "succeeded" }],
      }),
    });
    expect(outcome.handled).toBe(false);
    expect(outcome.note).toMatch(/void/);
    expect(await refundPostings()).toHaveLength(0);
    const [failed] = await raw<{ status: string; error: string }[]>`
      select status, error from public.integration_event
      where organization_id = ${ORG} and direction = 'inbound' and status = 'failed'`;
    expect(failed!.error).toMatch(/void/);
  });

  it("books nothing for a refund that has not succeeded", async () => {
    const { connection, intentId } = await cardPaid("100.00");
    await payments.receive(db(), {
      connection,
      event: refundEvent(intentId, {
        type: "refund.created",
        refunds: [{ refundId: "re_E", amountMinor: 1000, createdAt: new Date(), status: "pending" }],
      }),
    });
    expect(await refundPostings()).toHaveLength(0);
    expect(await accountBalance("1000")).toBe("100.0000");
  });

  it("dates a refund into a closed period today rather than refusing it", async () => {
    /**
     * The money has left the bank. Refusing would fail the webhook, Stripe
     * would retry for days, and the refund would never be booked.
     */
    const { connection, intentId } = await cardPaid("100.00");
    const lastYear = new Date(Date.now() - 400 * 86_400_000);
    await raw`insert into public.accounting_period (organization_id, period_end)
              values (${ORG}, ${lastYear.toISOString().slice(0, 10)})`;
    await payments.receive(db(), {
      connection,
      event: refundEvent(intentId, {
        refunds: [{ refundId: "re_F", amountMinor: 1000, createdAt: lastYear, status: "succeeded" }],
      }),
    });
    const postings = await refundPostings();
    expect(postings).toHaveLength(1);
    expect(postings[0]!.occurred_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

/* ======================================================= parsing a refund */

describe("reading a refund out of Stripe's two shapes", () => {
  const provider = stripeProvider({}, "sk_test");
  const parse = (payload: unknown) =>
    provider.parseEvent({ headers: {}, body: JSON.stringify(payload) });

  it("reads a refund event's own object as the refund", () => {
    const parsed = parse({
      id: "evt_r1", type: "refund.updated", created: 1_780_000_000,
      data: { object: {
        object: "refund", id: "re_1", amount: 2500, created: 1_779_999_000,
        status: "succeeded", payment_intent: "pi_7",
      } },
    });
    expect(parsed?.kind).toBe("refunded");
    expect(parsed?.intentId).toBe("pi_7");
    expect(parsed?.refunds).toEqual([{
      refundId: "re_1", amountMinor: 2500, createdAt: new Date(1_779_999_000_000), status: "succeeded",
    }]);
  });

  it("reads the list on a charge when the API version includes it, and nothing when not", () => {
    const listed = parse({
      id: "evt_r2", type: "charge.refunded",
      data: { object: {
        object: "charge", id: "ch_1", payment_intent: "pi_7", amount_refunded: 2500,
        refunds: { data: [{ id: "re_1", amount: 2500, created: 1_779_999_000, status: "succeeded" }] },
      } },
    });
    expect(listed?.refunds?.map((r) => r.refundId)).toEqual(["re_1"]);

    const bare = parse({
      id: "evt_r3", type: "charge.refunded",
      data: { object: { object: "charge", id: "ch_1", payment_intent: "pi_7", amount_refunded: 2500 } },
    });
    expect(bare?.refunds).toEqual([]);
    expect(bare?.refundedMinor).toBe(2500);
  });
});

/* ================================================================ status */

run("what the settings screen is told", () => {
  it("says separately whether it is connected and whether the webhook is set", async () => {
    /**
     * The two fail differently, and collapsing them is the expensive
     * mistake. A connection with no signing secret takes cards perfectly
     * well and never learns that any of them succeeded: every invoice stays
     * open, every customer is chased for money they have already paid, and
     * the screen says connected.
     */
    await raw`
      insert into public.integration_connection
        (organization_id, capability, provider, status, credential_ref, settings)
      values (${ORG}, 'payments', 'stripe', 'connected', ${KEY_REF}, '{}'::jsonb)`;

    const view = await payments.status(ctx());
    expect(view.connected).toBe(true);
    expect(view.webhookConfigured).toBe(false);
    expect(view.webhookPath).toMatch(/^\/api\/webhooks\/payments\/[0-9a-f-]{36}$/);
  });

  it("says nothing is connected when nothing is", async () => {
    const view = await payments.status(ctx());
    expect(view.connected).toBe(false);
    expect(view.connectionId).toBeNull();
  });
});

run("connecting it", () => {
  /**
   * THE PATH AN OPERATOR ACTUALLY TAKES, rather than the row a test inserts.
   *
   * Every test above puts the connection in with raw SQL, which proves the
   * payment code works against a connection that exists and proves nothing
   * about whether anybody can make one. The claim being made on the settings
   * screen is that Stripe can be turned on from there, and that claim is
   * exactly the kind this catalogue was built to stop being made without
   * evidence.
   */
  it("turns on from the connector screen and leaves a usable connection", async () => {
    const connected = await leadIntake.connect(ctx(), {
      provider: "stripe",
      credentialRef: KEY_REF,
      settings: { publishableKey: "pk_live_x", webhookSecretRef: HOOK_REF },
    });
    expect(connected.status).toBe("connected");

    const view = await payments.status(ctx());
    expect(view.connected).toBe(true);
    expect(view.provider).toBe("stripe");
    expect(view.publishableKey).toBe("pk_live_x");
    expect(view.webhookConfigured).toBe(true);
    expect(view.webhookPath).toBe(`/api/webhooks/payments/${connected.id}`);

    /**
     * And the webhook route can find it by that id with the service role,
     * which is the lookup that happens before any tenant exists.
     */
    const resolved = await payments.connectionById(db(), connected.id);
    expect(resolved?.organizationId).toBe(ORG);
    expect(resolved?.webhookSecretRef).toBe(HOOK_REF);
  });

  it("files it under payments rather than under whatever came first", async () => {
    /**
     * `connect` reads the capability off the catalogue entry, and the
     * uniqueness constraint on the connection is (organization, capability,
     * provider). A Stripe row filed under the wrong capability is invisible
     * to every lookup in this file, so cards would appear connected on the
     * connector screen and unconfigured on the payments one.
     */
    await leadIntake.connect(ctx(), { provider: "stripe", credentialRef: KEY_REF });
    const [row] = await raw`
      select capability from public.integration_connection
      where organization_id = ${ORG} and provider = 'stripe'`;
    expect((row as { capability: string }).capability).toBe("payments");
  });

  it("can be turned off, and then nothing can be charged", async () => {
    await leadIntake.connect(ctx(), {
      provider: "stripe", credentialRef: KEY_REF,
      settings: { webhookSecretRef: HOOK_REF },
    });
    await leadIntake.disconnect(ctx(), "stripe");

    const { customerId, invoiceId } = await customerWithInvoice("25.00");
    await expect(payments.intent(ctx(), { customerId, invoiceIds: [invoiceId] },
      deps(fakeProvider({ charges: [], refunds: [] }))))
      .rejects.toThrow(/No payment provider configured/i);
  });
});
