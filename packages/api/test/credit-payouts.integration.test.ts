import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import * as creditPayouts from "../src/services/credit-payouts";
import * as customers from "../src/services/customers";
import * as payments from "../src/services/payments";
import * as statements from "../src/services/statements";
import type { PaymentEvent, PaymentProvider, RefundOutcome } from "../src/payments/provider";
import { ConflictError, guardedRead, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * CREDIT PAID OUT AS MONEY
 *
 * A credit note leaves what the company owes a customer on their account.
 * These tests give it back: to the card they paid with, through the card
 * processor, and by cash or cheque. The numbers that have to agree afterwards
 * are the credit left on the note, what the ledger holds for the customer,
 * the cash, and the card payment the money went back through, which must
 * still say it paid the invoice it paid.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cpo:org");
const USER = fixtureId("cpo:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});

interface Asked { intentId: string; amountMinor?: number | undefined; idempotencyKey: string }

/** A processor that never reaches the network, and answers each refund with the outcome given. */
function fakeProvider(asked: Asked[], outcome?: (n: number) => RefundOutcome): PaymentProvider {
  return {
    name: "stripe",
    publishableKey: "pk_test_123",
    async charge(request) {
      return {
        ok: true,
        intent: {
          intentId: `pi_cpo_${Math.random().toString(36).slice(2)}`, clientSecret: "secret",
          amountMinor: request.amountMinor, currency: "usd", status: "requires_payment_method",
        },
      };
    },
    async refund(request): Promise<RefundOutcome> {
      asked.push({ intentId: request.intentId, amountMinor: request.amountMinor, idempotencyKey: request.idempotencyKey });
      return outcome?.(asked.length) ?? {
        ok: true,
        refund: { refundId: `re_cpo_${asked.length}`, amountMinor: request.amountMinor ?? 0, status: "pending" },
      };
    },
    verify: () => true,
    parseEvent: () => null,
  };
}
const deps = (provider: PaymentProvider): payments.PaymentDeps => ({ readSecret: async () => "sk_test", provider });

async function connectStripe(): Promise<payments.Connection> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'payments', 'stripe', 'connected', 'TEST_KEY',
            ${raw.json({ publishableKey: "pk_test_123", webhookSecretRef: "TEST_HOOK" } as never)})
    returning id`;
  return (await payments.connectionById(db(), row!.id))!;
}

function event(over: Partial<PaymentEvent>): PaymentEvent {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    kind: "succeeded", type: "payment_intent.succeeded", intentId: null,
    amountMinor: null, currency: "usd", feeMinor: null, refundedMinor: null,
    metadata: {}, failureMessage: null,
    ...over,
  };
}

/** Net on one account across the company, debits positive. */
async function account(code: string): Promise<string> {
  const [row] = await raw<{ net: string }[]>`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} and account_code = ${code}`;
  return row!.net;
}
async function balanced(): Promise<boolean> {
  const [row] = await raw<{ off: string }[]>`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::text as off
    from public.ledger_entry where organization_id = ${ORG}`;
  return Number(row!.off) === 0;
}

let customerId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Payout Co", slug: "payout-co" });
  customerId = (await customers.create(owner(), {
    type: "residential", name: "Petra Payout", phone: "+15125550170",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id;
});

/** An invoice for 200 of taxable work at 8.25%, paid in full by card through the processor. */
async function paidByCard() {
  const connection = await connectStripe();
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Water heater flush", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: true, taxRate: "0.0825" }],
  });
  const attempt = await payments.intent(owner(), { customerId, invoiceIds: [invoice.id as string] }, deps(fakeProvider([])));
  await payments.receive(db(), {
    connection, event: event({ intentId: attempt.intentId, amountMinor: 21650 }),
  });
  const [payment] = await raw<{ id: string }[]>`select id from public.payment where organization_id = ${ORG}`;
  return { connection, invoiceId: invoice.id as string, intentId: attempt.intentId, paymentId: payment!.id };
}

/** A credit of 54.13 (50 and its 8.25% tax) against the paid invoice, left on the account. */
async function creditAgainst(invoiceId: string) {
  const invoice = await billing.get(owner(), { id: invoiceId });
  return creditNotes.create(owner(), {
    invoiceId, reason: "price_adjustment", draft: false, apply: true,
    lines: [{ invoiceLineId: invoice.lines[0]!.id, quantity: "1", unitPrice: "50.00" }],
  });
}

run("paying a credit back by cash or cheque", () => {
  it("posts it out of what is held for the customer, leaves the rest on the account, and says so on the statement", async () => {
    const note = await creditNotes.create(owner(), {
      customerId, reason: "goodwill", note: "Second visit to fix our own mistake", draft: false, apply: false,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "80.00" }],
    });
    expect(await account("2300")).toBe("-80.0000");

    const after = await creditPayouts.payOut(owner(), {
      id: note.id, method: "check", amount: "30.00", reference: "1042",
    });
    expect(after).toMatchObject({ amountPaidOut: "30.0000", balance: "50.0000", status: "partially_applied" });
    expect(after.payouts).toHaveLength(1);
    expect(after.payouts[0]).toMatchObject({ method: "check", status: "paid", amount: "30.0000", reference: "1042" });

    /** Customer deposits down by the payout, cash down by it, nothing on the receivable. */
    expect(await account("2300")).toBe("-50.0000");
    expect(await account("1000")).toBe("-30.0000");
    expect(await account("1200")).toBe("0.0000");
    expect(await balanced()).toBe(true);

    const statement = await statements.statement(owner(), { id: customerId });
    const line = statement.lines.find((l) => l.kind === "credit_payout")!;
    expect(line.description).toBe(`Credit note ${note.number} paid back by cheque 1042`);
    expect(line.charge).toBe("30.0000");
  });

  it("pays out what is left when no amount is given, and then there is nothing to use or void", async () => {
    const note = await creditNotes.create(owner(), {
      customerId, reason: "goodwill", note: "Late arrival", draft: false, apply: false,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "25.00" }],
    });
    const after = await creditPayouts.payOut(owner(), { id: note.id, method: "cash" });
    expect(after).toMatchObject({ amountPaidOut: "25.0000", balance: "0.0000", status: "applied" });
    await expect(creditPayouts.payOut(owner(), { id: note.id, method: "cash", amount: "1.00" }))
      .rejects.toThrow(/has nothing left to pay out/);
    await expect(creditNotes.voidNote(owner(), { id: note.id, reason: "changed my mind" }))
      .rejects.toThrow(/paid out to the customer/);
    expect(await account("2300")).toBe("0.0000");
  });

  it("refuses more than is left, a draft, and a day that has not happened", async () => {
    const note = await creditNotes.create(owner(), {
      customerId, reason: "goodwill", note: "Muddy boots", draft: false, apply: false,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "10.00" }],
    });
    await expect(creditPayouts.payOut(owner(), { id: note.id, method: "cash", amount: "10.01" }))
      .rejects.toThrow(/has \$?10\.00 left/);
    const draft = await creditNotes.create(owner(), {
      customerId, reason: "goodwill", note: "Draft", draft: true, apply: false,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "10.00" }],
    });
    await expect(creditPayouts.payOut(owner(), { id: draft.id, method: "cash" })).rejects.toThrow(/is a draft/);
    await expect(creditPayouts.payOut(owner(), { id: note.id, method: "cash", paidOn: "2099-01-01" }))
      .rejects.toThrow(/in the future/);
    /** None of the refusals took anything off it. */
    expect((await creditNotes.get(owner(), { id: note.id })).balance).toBe("10.0000");
  });

  it("is the same payout when retried with the same key", async () => {
    const note = await creditNotes.create(owner(), {
      customerId, reason: "goodwill", note: "Retry", draft: false, apply: false,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "40.00" }],
    });
    await creditPayouts.payOut(owner("payout-once"), { id: note.id, method: "cash", amount: "15.00" });
    const again = await creditPayouts.payOut(owner("payout-once"), { id: note.id, method: "cash", amount: "15.00" });
    expect(again.payouts).toHaveLength(1);
    expect(await account("1000")).toBe("-15.0000");
  });

  it("is refused to somebody who may credit an invoice and not send money back", async () => {
    const note = await creditNotes.create(owner(), {
      customerId, reason: "goodwill", note: "Who may", draft: false, apply: false,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "40.00" }],
    });
    const technician: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] }, db: db(),
    };
    await expect(creditPayouts.payOut(technician, { id: note.id, method: "cash" })).rejects.toThrow(/payment:refund/);
  });
});

run("paying a credit back to the card", () => {
  it("asks the processor, posts nothing until it says the money moved, and then posts it as a payout", async () => {
    const { connection, invoiceId, intentId, paymentId } = await paidByCard();
    const note = await creditAgainst(invoiceId);
    /** The invoice was paid, so the credit sits on the account. */
    expect(note).toMatchObject({ total: "54.1300", balance: "54.1300", status: "open" });

    const asked: Asked[] = [];
    const pending = await creditPayouts.payOut(owner(), { id: note.id, method: "card" }, deps(fakeProvider(asked)));
    expect(asked).toEqual([{ intentId, amountMinor: 5413, idempotencyKey: pending.payouts[0]!.id }]);
    expect(pending).toMatchObject({ amountPaidOut: "54.1300", balance: "0.0000" });
    expect(pending.payouts[0]).toMatchObject({ method: "card", status: "pending", paymentId });

    /** Set aside: it cannot be used on an invoice while it is on its way. */
    const next = await billing.create(owner(), {
      customerId, lines: [{ name: "Anode rod", quantity: "1", unitPrice: "40.00", discountAmount: "0", taxable: false }],
    });
    await expect(creditNotes.apply(owner(), { id: note.id, applications: [{ invoiceId: next.id as string, amount: "10.00" }] }))
      .rejects.toBeInstanceOf(ConflictError);
    /** And nothing is in the ledger for it yet. */
    expect(await account("2300")).toBe("-54.1300");
    expect(await account("1000")).toBe("216.5000");

    await payments.receive(db(), {
      connection,
      event: event({
        kind: "refunded", type: "refund.updated", intentId,
        refunds: [{ refundId: "re_cpo_1", amountMinor: 5413, createdAt: new Date(), status: "succeeded" }],
      }),
    });

    const paid = await creditNotes.get(owner(), { id: note.id });
    expect(paid.payouts[0]).toMatchObject({ status: "paid" });
    expect(await account("2300")).toBe("0.0000");
    expect(await account("1000")).toBe("162.3700");
    /**
     * Revenue and tax are what was billed (the flush and the anode rod) less
     * the credit, and the receivable is only the anode rod's: the payout
     * reopened nothing.
     */
    expect(await account("4000")).toBe("-190.0000");
    expect(await account("2200")).toBe("-12.3700");
    expect(await account("1200")).toBe("40.0000");
    expect(await balanced()).toBe(true);

    /** The card payment says the money went back, and still says it paid the invoice. */
    const payment = await guardedRead(owner(), "payment:read", (tx) => billing.loadPayment(tx, owner(), paymentId));
    expect(payment).toMatchObject({
      refundedAmount: "54.1300", paidOutAmount: "54.1300", status: "partially_refunded", unappliedAmount: "0.0000",
    });
    const invoice = await billing.get(owner(), { id: invoiceId });
    expect(invoice).toMatchObject({ status: "paid", balance: "0.0000" });

    /** The same refund reported again books nothing more. */
    await payments.receive(db(), {
      connection,
      event: event({
        kind: "refunded", type: "charge.refunded", intentId, refundedMinor: 5413,
        refunds: [{ refundId: "re_cpo_1", amountMinor: 5413, createdAt: new Date(), status: "succeeded" }],
      }),
    });
    expect(await account("1000")).toBe("162.3700");
  });

  it("recognises its own refund when the processor reports only the running total", async () => {
    const { connection, invoiceId, intentId } = await paidByCard();
    const note = await creditAgainst(invoiceId);
    await creditPayouts.payOut(owner(), { id: note.id, method: "card", amount: "20.00" }, deps(fakeProvider([])));

    await payments.receive(db(), {
      connection, event: event({ kind: "refunded", type: "charge.refunded", intentId, refundedMinor: 2000 }),
    });
    /** Posted as the payout, so nothing reopened the invoice. */
    expect(await account("1200")).toBe("0.0000");
    expect(await account("2300")).toBe("-34.1300");
    expect((await billing.get(owner(), { id: invoiceId })).status).toBe("paid");

    /** And the event naming it afterwards finds it already counted. */
    await payments.receive(db(), {
      connection,
      event: event({
        kind: "refunded", type: "refund.updated", intentId,
        refunds: [{ refundId: "re_cpo_1", amountMinor: 2000, createdAt: new Date(), status: "succeeded" }],
      }),
    });
    expect(await account("1000")).toBe("196.5000");
    expect(await balanced()).toBe(true);
  });

  it("puts the credit back on the account when the processor reports the refund failed", async () => {
    const { connection, invoiceId, intentId } = await paidByCard();
    const note = await creditAgainst(invoiceId);
    await creditPayouts.payOut(owner(), { id: note.id, method: "card" }, deps(fakeProvider([])));

    await payments.receive(db(), {
      connection,
      event: event({
        kind: "refunded", type: "refund.updated", intentId,
        refunds: [{ refundId: "re_cpo_1", amountMinor: 5413, createdAt: new Date(), status: "failed" }],
      }),
    });
    const after = await creditNotes.get(owner(), { id: note.id });
    expect(after).toMatchObject({ amountPaidOut: "0.0000", balance: "54.1300", status: "open" });
    expect(after.payouts[0]).toMatchObject({ status: "failed" });
    expect(await account("2300")).toBe("-54.1300");
  });

  it("keeps nothing when the processor declines, and says why", async () => {
    const { invoiceId } = await paidByCard();
    const note = await creditAgainst(invoiceId);
    const declining = fakeProvider([], () => ({ ok: false, code: "charge_disputed", message: "This charge is disputed.", retryable: false }));
    await expect(creditPayouts.payOut(owner(), { id: note.id, method: "card" }, deps(declining)))
      .rejects.toThrow(/would not refund it: This charge is disputed/);
    const after = await creditNotes.get(owner(), { id: note.id });
    expect(after).toMatchObject({ balance: "54.1300", payouts: [] });
  });

  it("refuses a card payment with too little left, and counts a payout on its way against an ordinary refund", async () => {
    const { invoiceId, paymentId } = await paidByCard();
    const note = await creditAgainst(invoiceId);
    await creditPayouts.payOut(owner(), { id: note.id, method: "card", amount: "50.00", paymentId }, deps(fakeProvider([])));
    /** 216.50 paid, 50 on its way back: 166.50 is all the processor would still refund. */
    await expect(payments.refund(owner(), { paymentId, amount: "170.00" }, deps(fakeProvider([]))))
      .rejects.toThrow(/166\.5/);
    const listed = await creditPayouts.refundablePayments(owner(), { id: note.id });
    expect(listed.payments.map((p) => p.refundable)).toEqual(["166.5000"]);
  });

  it("refuses a customer with no card payment, and points at cash or a cheque", async () => {
    await connectStripe();
    const note = await creditNotes.create(owner(), {
      customerId, reason: "goodwill", note: "No card", draft: false, apply: false,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "12.00" }],
    });
    await expect(creditPayouts.payOut(owner(), { id: note.id, method: "card" }, deps(fakeProvider([]))))
      .rejects.toThrow(/no card payment to refund the credit to/);
  });
});
