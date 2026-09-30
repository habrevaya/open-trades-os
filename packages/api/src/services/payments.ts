import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, inTenant,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as billing from "./billing";
import {
  createPaymentProvider, PaymentProviderNotConfiguredError,
  type PaymentEvent, type PaymentProvider, type WebhookRequest,
} from "../payments/provider";

/**
 * TAKING A CARD
 *
 * Everything under this file already existed: `payment` with a `processor`
 * column defaulting to "stripe", a `processor_payment_id` beside it, an
 * `idempotency_key` documented as "written BEFORE the processor call", a fee
 * column, and a ledger posting that debits a processing fee to an expense
 * account. None of it had ever been reached by a processor, because there was
 * no way to take a card. A company using this could record that a card had
 * been taken somewhere else, which is a different product.
 *
 * THE MONEY NEVER TOUCHES THIS SOFTWARE. The operator supplies a restricted
 * key for their own Stripe account, the homeowner pays that account directly,
 * and this codebase learns about it afterwards. There is no platform account,
 * no Connect, and no cut. See `payments/provider.ts` for why that is the only
 * posture that survives self hosting.
 *
 * THE WEBHOOK IS THE ONLY AUTHORITY ON WHETHER MONEY MOVED.
 *
 * A browser saying the payment succeeded is a claim by a browser. It can be
 * wrong honestly, because the customer closed the tab between the card being
 * charged and the page loading, and it can be wrong dishonestly, because the
 * request came from a script rather than a payment form. Both produce an
 * invoice marked paid with no money behind it, and nothing downstream will
 * ever catch it: the balance is zero, the job closes, the customer is never
 * chased, and the first person to notice is a bookkeeper in a later quarter.
 *
 * So `intent` below creates nothing in this database that says money arrived.
 * It records an ATTEMPT. `receive` is what turns an attempt into a payment,
 * and it only runs on a body that carried a valid signature.
 *
 * AND NO PAYMENT ROW EXISTS UNTIL THE MONEY DOES.
 *
 * The obvious design writes a `payment` row with status `pending` when the
 * intent is made. It is wrong here: most intents are never completed,
 * somebody opens the payment page and thinks better of it, and a table of
 * abandoned pending payments is a table every report has to learn to exclude.
 * The attempt is recorded on `integration_event`, which is the table for
 * exactly that, and the payment row is written by the settlement path that
 * already exists.
 */

/** Two decimal places, in minor units, because processors speak cents. */
const toMinor = (amount: string): number => Math.round(Number(amount) * 100);
const fromMinor = (minor: number): string => (minor / 100).toFixed(2);
const usd = (value: string) => m.money(value, "USD");

/** Our own reference on the processor's object, so a human can trace one back. */
const METADATA_ATTEMPT = "otos_attempt";
const METADATA_ORG = "otos_organization";

/* --------------------------------------------------------- the connection */

/**
 * Where the two secrets live, and why there are two.
 *
 * `credentialRef` points at the API key, the same way the messaging
 * connection points at a carrier token. The webhook signing secret is a
 * SEPARATE value that Stripe issues per endpoint, so it is a second reference
 * held in `settings`. One field could not hold both, and putting the signing
 * secret in the same place as the API key would mean rotating either one
 * rotates the other.
 *
 * Both are references into whatever the deployment uses for secrets, never
 * the secrets themselves. A row in this database is not a secret store.
 */
export interface Connection {
  id: string;
  organizationId: string;
  provider: string;
  credentialRef: string;
  webhookSecretRef: string | null;
  settings: Record<string, unknown>;
}

function readConnection(row: typeof schema.integrationConnection.$inferSelect): Connection {
  const settings = row.settings ?? {};
  const webhookSecretRef = settings["webhookSecretRef"];
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    credentialRef: row.credentialRef ?? "",
    webhookSecretRef: typeof webhookSecretRef === "string" ? webhookSecretRef : null,
    settings,
  };
}

/**
 * The payments connection for one company.
 *
 * Exported because the webhook route needs it BEFORE any tenant exists: the
 * connection id in the URL is what establishes which company this delivery
 * belongs to, so it is read with the service role and nothing about the
 * request is trusted until the signature has been checked.
 */
export async function connectionById(
  db: Database, connectionId: string,
): Promise<Connection | null> {
  const [row] = await db.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.id, connectionId),
      eq(schema.integrationConnection.capability, "payments"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    )).limit(1);
  return row ? readConnection(row) : null;
}

async function connectionFor(tx: Database, organizationId: string): Promise<Connection> {
  const [row] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "payments"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    )).limit(1);

  if (!row) throw new PaymentProviderNotConfiguredError("payments");
  return readConnection(row);
}

/**
 * How a secret is fetched.
 *
 * Injected rather than imported, for the reason the outbox gives: a
 * deployment keeps these in Supabase Vault, a KMS, or a file the orchestrator
 * mounted, and a service that read `process.env` directly would work in
 * exactly one of those. It also means a test never has to put a plausible
 * looking API key anywhere.
 */
export type ReadSecret = (ref: string) => Promise<string>;

/**
 * The default, which reads an environment variable named by the reference.
 *
 * The smallest thing that works and keeps the secret out of the database,
 * matching what the worker already does for carrier credentials. A deployment
 * with a real secret store passes its own reader instead; nothing in this
 * file assumes otherwise.
 *
 * It throws rather than returning an empty string. An empty API key reaches
 * Stripe as an unauthenticated request and comes back as a 401, which
 * presents to the operator as "Stripe rejected our key" when the truth is
 * that nobody ever gave us one.
 */
export const secretFromEnvironment: ReadSecret = async (ref: string) => {
  const value = process.env[ref];
  if (!value) {
    throw new ConflictError(
      `No payments credential in the environment under "${ref}". The connection points `
      + "at that name and nothing is set there, so no card can be charged.",
    );
  }
  return value;
};

const DEFAULT_DEPS: PaymentDeps = { readSecret: secretFromEnvironment };

export interface PaymentDeps {
  readSecret: ReadSecret;
  /** Injected so a test never reaches a processor and a deployment never fakes one. */
  provider?: PaymentProvider | undefined;
}

async function providerFrom(
  connection: Connection, deps: PaymentDeps,
): Promise<PaymentProvider> {
  if (deps.provider) return deps.provider;
  const key = await deps.readSecret(connection.credentialRef);
  return createPaymentProvider(connection.provider, connection.settings, key);
}

/* ------------------------------------------------------------- the charge */

export interface IntentInput {
  customerId: string;
  /** Omit and the open balance on the named invoices is used. */
  amount?: string | undefined;
  /**
   * Which invoices this is meant to settle.
   *
   * Carried through the processor and back, so the money lands where the
   * person paying intended. Omit it and settlement falls to the oldest
   * balance first rule in `billing.pay`, which is correct for a cheque
   * arriving in the post and wrong for a customer who clicked pay on one
   * invoice out of four.
   */
  invoiceIds?: string[] | undefined;
  description?: string | undefined;
  receiptEmail?: string | undefined;
}

/**
 * Start a card payment, and record that we asked.
 *
 * Returns what a payment form needs and nothing that says money moved.
 */
export async function intent(
  ctx: ServiceContext, input: IntentInput, deps: PaymentDeps = DEFAULT_DEPS,
) {
  return guardedWrite(ctx, "payment:collect", async (tx) => {
    const [customer] = await tx.select({ id: schema.customer.id, email: schema.customer.email })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, input.customerId), isNull(schema.customer.deletedAt)))
      .limit(1);
    if (!customer) throw new NotFoundError("Customer");

    const connection = await connectionFor(tx, ctx.actor.organizationId);

    /**
     * THE AMOUNT IS COMPUTED HERE, not accepted from the caller, whenever
     * invoices are named.
     *
     * The caller of this is frequently a customer portal, which is to say a
     * browser. A browser that can name both the invoices and the amount can
     * name a dollar against a four thousand dollar invoice, and the
     * settlement path below will dutifully allocate the dollar and mark
     * nothing paid, which is fine, and then the SAME trust would let it name
     * four thousand against a one dollar invoice and take a credit. Reading
     * the balance out of the database costs one query.
     */
    let amount: string;
    const allocations: { invoiceId: string; amount: string }[] = [];

    if (input.invoiceIds && input.invoiceIds.length > 0) {
      const invoices = await tx.select({
        id: schema.invoice.id, balance: schema.invoice.balance, status: schema.invoice.status,
      }).from(schema.invoice)
        .where(and(
          inArray(schema.invoice.id, input.invoiceIds),
          isNull(schema.invoice.deletedAt),
        ));

      if (invoices.length !== input.invoiceIds.length) throw new NotFoundError("Invoice");

      let total = m.money("0", "USD");
      for (const invoice of invoices) {
        const balance = usd(invoice.balance);
        if (!m.isPositive(balance)) {
          throw new ConflictError(
            `Invoice ${invoice.id} has nothing outstanding, so there is nothing to pay.`,
          );
        }
        allocations.push({ invoiceId: invoice.id, amount: m.toString(balance) });
        total = m.add(total, balance);
      }
      amount = m.toString(total);
    } else {
      if (!input.amount) {
        throw new ConflictError(
          "Say which invoices this pays, or how much it is. A charge for an amount "
          + "nobody named is one nothing can reconcile.",
        );
      }
      amount = m.toString(usd(input.amount));
    }

    const minor = toMinor(amount);
    if (minor <= 0) {
      throw new ConflictError("A card payment has to be for more than nothing.");
    }

    /**
     * THE ATTEMPT IS WRITTEN BEFORE THE PROCESSOR IS CALLED.
     *
     * Its id is the idempotency key sent to Stripe, so a retry of this whole
     * function after a lost response returns the same intent rather than
     * creating a second one against the same invoices. The column comment on
     * `payment.idempotency_key` says "written BEFORE the processor call" and
     * this is the call it was written for.
     */
    const [attempt] = await tx.insert(schema.integrationEvent).values({
      organizationId: ctx.actor.organizationId,
      direction: "outbound",
      provider: connection.provider,
      eventType: "payment.intent",
      idempotencyKey: ctx.idempotencyKey ?? crypto.randomUUID(),
      status: "pending",
      entityType: "customer",
      entityId: input.customerId,
      requestPayload: { amount, allocations, connectionId: connection.id },
    }).returning();

    const provider = await providerFrom(connection, deps);
    const outcome = await provider.charge({
      amountMinor: minor,
      currency: "usd",
      idempotencyKey: attempt!.id,
      ...(input.description ? { description: input.description } : {}),
      ...(input.receiptEmail ?? customer.email
        ? { receiptEmail: input.receiptEmail ?? customer.email! }
        : {}),
      metadata: {
        [METADATA_ATTEMPT]: attempt!.id,
        [METADATA_ORG]: ctx.actor.organizationId,
      },
    });

    if (!outcome.ok) {
      await tx.update(schema.integrationEvent)
        .set({ status: "failed", error: `${outcome.code}: ${outcome.message}`, updatedAt: new Date() })
        .where(eq(schema.integrationEvent.id, attempt!.id));
      throw new ConflictError(outcome.message);
    }

    /**
     * The intent id is stored on the attempt, which is how the webhook finds
     * its way back here. Stripe's metadata carries the attempt id as well,
     * and both are used: the metadata is the fast path, and the intent id is
     * the one that still works if somebody completes a payment through the
     * Stripe dashboard where our metadata was never attached.
     */
    await tx.update(schema.integrationEvent).set({
      responsePayload: { intentId: outcome.intent.intentId, status: outcome.intent.status },
      attempts: 1,
      updatedAt: new Date(),
    }).where(eq(schema.integrationEvent.id, attempt!.id));

    await audit(tx, ctx, "payment.intent_created", "customer", input.customerId, null, {
      attemptId: attempt!.id, intentId: outcome.intent.intentId, amount,
    });

    return {
      attemptId: attempt!.id,
      intentId: outcome.intent.intentId,
      clientSecret: outcome.intent.clientSecret,
      publishableKey: provider.publishableKey,
      amount,
      currency: outcome.intent.currency,
      allocations,
    };
  });
}

/* ------------------------------------------------------- what came back */

/**
 * The actor a webhook enters a tenant as.
 *
 * Two grants and nothing else, the same way the webhook delivery pass names
 * its own. The rule in this service layer is that every function goes through
 * a guard, and a rule with one exception for inbound provider traffic is a
 * rule nobody can check by reading.
 */
function webhookActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["payment:collect", "payment:refund"],
    agentId: "payments",
  };
}

export interface ReceiveOutcome {
  /** False when this exact event has already been handled. */
  handled: boolean;
  kind: string;
  eventId: string;
  paymentId?: string | undefined;
  note?: string | undefined;
}

/**
 * A verified delivery from the processor.
 *
 * The signature check happens in the route, before this is called, because
 * verification needs the raw bytes and the URL that the deployment knows
 * about. What this owns is everything after: deduplication, dispatch, and
 * the refusal to act on an event it does not understand.
 */
export async function receive(
  db: Database,
  input: { connection: Connection; event: PaymentEvent },
): Promise<ReceiveOutcome> {
  const { connection, event } = input;
  const ctx: ServiceContext = {
    actor: webhookActor(connection.organizationId),
    db,
    /**
     * The processor's event id becomes our idempotency key, which is what
     * makes settlement safe to attempt twice. Stripe retries a delivery for
     * days if our answer was slow or our deploy was mid restart, and it is
     * the same event each time: settling it twice pays an invoice twice and
     * writes two balanced ledger transactions that both look deliberate.
     */
    idempotencyKey: event.eventId,
  };

  /**
   * SEEN BEFORE IS ANSWERED BEFORE ANYTHING ELSE HAPPENS.
   *
   * `billing.pay` has its own idempotency check on the same key and would
   * catch a repeat of a settlement. This catches a repeat of ANY event,
   * including the refund and dispute paths that write through a different
   * function, and it means the answer to a retry is one SELECT rather than a
   * transaction that does a lot of work to change nothing.
   */
  const already = await inTenant(ctx, async (tx) =>
    tx.select({ id: schema.integrationEvent.id })
      .from(schema.integrationEvent)
      .where(and(
        eq(schema.integrationEvent.provider, connection.provider),
        eq(schema.integrationEvent.idempotencyKey, event.eventId),
        eq(schema.integrationEvent.direction, "inbound"),
      )).limit(1));

  if (already.length > 0) {
    return { handled: false, kind: event.kind, eventId: event.eventId, note: "already handled" };
  }

  const record = async (
    status: "succeeded" | "failed", entityId: string | null, error?: string,
  ): Promise<void> => {
    await inTenant(ctx, async (tx) => {
      await tx.insert(schema.integrationEvent).values({
        organizationId: connection.organizationId,
        direction: "inbound",
        provider: connection.provider,
        eventType: event.type,
        idempotencyKey: event.eventId,
        status,
        entityType: entityId ? "payment" : null,
        entityId,
        requestPayload: {
          intentId: event.intentId,
          amountMinor: event.amountMinor,
          feeMinor: event.feeMinor,
        },
        ...(error ? { error } : {}),
        completedAt: new Date(),
      });
    });
  };

  if (event.kind === "succeeded") {
    const settled = await settle(ctx, connection, event);
    await record("succeeded", settled.paymentId);
    return {
      handled: true, kind: event.kind, eventId: event.eventId, paymentId: settled.paymentId,
    };
  }

  if (event.kind === "refunded" || event.kind === "disputed") {
    const touched = await adjust(ctx, event);
    await record(touched ? "succeeded" : "failed", touched, touched ? undefined
      : "No payment here matches that processor id.");
    return {
      handled: touched !== null, kind: event.kind, eventId: event.eventId,
      ...(touched ? { paymentId: touched } : {}),
      ...(touched ? {} : { note: "no matching payment" }),
    };
  }

  if (event.kind === "failed") {
    await inTenant(ctx, async (tx) => {
      if (!event.intentId) return;
      await tx.update(schema.integrationEvent)
        .set({
          status: "failed",
          error: event.failureMessage ?? "The card was declined.",
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.integrationEvent.organizationId, connection.organizationId),
          eq(schema.integrationEvent.direction, "outbound"),
          sql`${schema.integrationEvent.responsePayload}->>'intentId' = ${event.intentId}`,
        ));
    });
    await record("succeeded", null);
    return { handled: true, kind: event.kind, eventId: event.eventId };
  }

  /**
   * AN EVENT THIS DOES NOT MODEL IS RECORDED AND NOT GUESSED AT.
   *
   * An operator can turn on events in their own dashboard that nothing here
   * anticipated. Storing the row means the delivery is deduplicated and
   * visible; acting on it because the name looked familiar is how a
   * `charge.failed` gets booked as a refund.
   */
  await record("succeeded", null, `Not handled: ${event.type}`);
  return { handled: false, kind: event.kind, eventId: event.eventId, note: `unhandled: ${event.type}` };
}

/**
 * Turn a succeeded attempt into a payment, through the path that already
 * exists.
 *
 * `billing.pay` allocates across invoices in a total order, updates the
 * balances, moves the job, emits `invoice.paid` and `payment.received`,
 * writes the balanced ledger pair and audits it. Reimplementing any of that
 * here would be a second settlement path that drifts from the first, and the
 * first is the one with the tests.
 */
async function settle(
  ctx: ServiceContext, connection: Connection, event: PaymentEvent,
): Promise<{ paymentId: string }> {
  const attempt = await inTenant(ctx, async (tx) => {
    const byMetadata = event.metadata[METADATA_ATTEMPT];
    if (byMetadata) {
      const [row] = await tx.select().from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.id, byMetadata),
          eq(schema.integrationEvent.organizationId, connection.organizationId),
        )).limit(1);
      if (row) return row;
    }
    if (!event.intentId) return null;
    const [row] = await tx.select().from(schema.integrationEvent)
      .where(and(
        eq(schema.integrationEvent.organizationId, connection.organizationId),
        eq(schema.integrationEvent.direction, "outbound"),
        sql`${schema.integrationEvent.responsePayload}->>'intentId' = ${event.intentId}`,
      ))
      .orderBy(desc(schema.integrationEvent.createdAt))
      .limit(1);
    return row ?? null;
  });

  const request = (attempt?.requestPayload ?? {}) as {
    amount?: string; allocations?: { invoiceId: string; amount: string }[];
  };

  /**
   * THE AMOUNT COMES FROM THE PROCESSOR, not from what we asked for.
   *
   * They can differ: a customer can be charged a different amount through
   * the Stripe dashboard, and a partial capture is a real thing. Believing
   * our own request over the processor's report would close an invoice on
   * money that never arrived, which is the failure this whole file is
   * arranged to prevent.
   */
  const amount = event.amountMinor !== null
    ? fromMinor(event.amountMinor)
    : request.amount;

  if (!amount) {
    /**
     * No amount from either side. Refusing beats guessing: an event with no
     * money in it is not a payment, and writing a zero payment would close
     * nothing while looking like it had been dealt with.
     */
    throw new ConflictError(
      `Stripe reported ${event.type} with no amount, so there is nothing to record.`,
    );
  }

  const customerId = attempt?.entityId ?? null;
  if (!customerId) {
    throw new ConflictError(
      `Nothing here started the payment ${event.intentId ?? "(no intent)"}, so there is `
      + "no customer to credit it to. It has been logged rather than guessed at.",
    );
  }

  /**
   * ALLOCATIONS ARE CARRIED ONLY WHEN THEY STILL FIT THE MONEY.
   *
   * We asked for the full balance on three invoices and the processor
   * reports less: the split we computed no longer describes what arrived,
   * and applying it anyway would mark invoices paid past what was received.
   * Handing `billing.pay` no allocations puts it on the oldest balance
   * first, which is the rule for money that arrives without instructions,
   * and that is exactly what this is.
   */
  const asked = (request.allocations ?? []).reduce(
    (total, one) => m.add(total, usd(one.amount)), m.money("0", "USD"),
  );
  const fits = request.allocations && request.allocations.length > 0
    && m.compare(asked, usd(amount)) === 0;

  const result = await billing.pay(ctx, {
    customerId,
    method: "card",
    amount,
    tipAmount: "0",
    ...(event.feeMinor !== null ? { feeAmount: fromMinor(event.feeMinor) } : {}),
    ...(fits ? { allocations: request.allocations! } : {}),
    ...(event.intentId ? { processorPaymentId: event.intentId } : {}),
  });

  await inTenant(ctx, async (tx) => {
    if (!attempt) return;
    await tx.update(schema.integrationEvent).set({
      status: "succeeded", entityType: "payment", entityId: result.id,
      completedAt: new Date(), updatedAt: new Date(),
    }).where(eq(schema.integrationEvent.id, attempt.id));
  });

  return { paymentId: result.id };
}

/**
 * A refund or a dispute against a payment we already have.
 *
 * Returns the payment id it touched, or null when nothing here matches. Null
 * is a real answer rather than an error: an operator can refund a charge in
 * the Stripe dashboard that this software never recorded, and the honest
 * response is a logged event saying so.
 */
async function adjust(ctx: ServiceContext, event: PaymentEvent): Promise<string | null> {
  if (!event.intentId) return null;

  return guardedWrite(ctx, "payment:refund", async (tx) => {
    /**
     * NO `deleted_at` FILTER, because nothing soft deletes a payment and
     * nothing should.
     *
     * A payment is reversed by a refund or a reversing ledger entry, never
     * removed: the money either arrived or it did not, and a row that can
     * disappear is a book that can be rewritten. A filter here would read as
     * a guard while its answer was decided before the query ran, which is the
     * exact defect `unwritten-columns.test.ts` counts, and it caught this one.
     */
    const [payment] = await tx.select().from(schema.payment)
      .where(eq(schema.payment.processorPaymentId, event.intentId!)).limit(1);

    if (!payment) return null;

    if (event.kind === "disputed") {
      /**
       * A dispute is NOT a refund and the amount is not adjusted here.
       *
       * The bank has pulled the money back pending a decision that can go
       * either way, so writing it off now would have to be written back on
       * roughly half of them. The status is what an operator needs to see,
       * and the money stays where it is until the dispute resolves into an
       * actual refund event.
       */
      const [after] = await tx.update(schema.payment)
        .set({ status: "disputed", updatedAt: new Date() })
        .where(eq(schema.payment.id, payment.id)).returning();
      await audit(tx, ctx, "payment.disputed", "payment", payment.id, payment, after!);
      return payment.id;
    }

    /**
     * The processor reports the CUMULATIVE amount refunded, not this
     * refund's amount. Adding it to what we hold would double count the
     * moment a second partial refund arrives.
     */
    const refunded = event.refundedMinor !== null
      ? usd(fromMinor(event.refundedMinor))
      : usd(payment.refundedAmount);
    const paid = usd(payment.amount);
    const fully = m.compare(refunded, paid) >= 0;

    const [after] = await tx.update(schema.payment).set({
      refundedAmount: m.toString(refunded),
      status: fully ? "refunded" : "partially_refunded",
      updatedAt: new Date(),
    }).where(eq(schema.payment.id, payment.id)).returning();

    await audit(tx, ctx, "payment.refunded", "payment", payment.id, payment, after!);
    return payment.id;
  });
}

/* ------------------------------------------------------- giving it back */

/**
 * Refund a card payment, from here rather than from the processor's own
 * dashboard.
 *
 * The row is NOT updated on the way out. Stripe answers with a refund that
 * is pending, and the webhook reports it when the money has actually moved,
 * through the same `adjust` above. Writing the refund here as well would be
 * a second path to the same column, and the two would disagree on the day a
 * refund is created and then fails.
 */
export async function refund(
  ctx: ServiceContext,
  input: { paymentId: string; amount?: string | undefined; reason?: string | undefined },
  deps: PaymentDeps = DEFAULT_DEPS,
) {
  return guardedWrite(ctx, "payment:refund", async (tx) => {
    /** No `deleted_at` filter. See `adjust`: a payment is reversed, never removed. */
    const [payment] = await tx.select().from(schema.payment)
      .where(eq(schema.payment.id, input.paymentId)).limit(1);
    if (!payment) throw new NotFoundError("Payment");

    if (!payment.processorPaymentId) {
      throw new ConflictError(
        "That payment was not taken through a card processor, so there is nothing to "
        + "refund through one. Return it the way it arrived and record it against the invoice.",
      );
    }

    const alreadyRefunded = usd(payment.refundedAmount);
    const remaining = m.subtract(usd(payment.amount), alreadyRefunded);
    if (!m.isPositive(remaining)) {
      throw new ConflictError("That payment has already been refunded in full.");
    }

    const asked = input.amount ? usd(input.amount) : remaining;
    if (m.compare(asked, remaining) > 0) {
      throw new ConflictError(
        `Only ${m.toString(remaining)} of that payment is left to refund.`,
      );
    }

    const connection = await connectionFor(tx, ctx.actor.organizationId);
    const provider = await providerFrom(connection, deps);

    const [attempt] = await tx.insert(schema.integrationEvent).values({
      organizationId: ctx.actor.organizationId,
      direction: "outbound",
      provider: connection.provider,
      eventType: "payment.refund",
      idempotencyKey: ctx.idempotencyKey ?? crypto.randomUUID(),
      status: "pending",
      entityType: "payment",
      entityId: payment.id,
      requestPayload: { amount: m.toString(asked) },
    }).returning();

    const outcome = await provider.refund({
      intentId: payment.processorPaymentId,
      amountMinor: toMinor(m.toString(asked)),
      idempotencyKey: attempt!.id,
      ...(input.reason ? { reason: input.reason } : {}),
    });

    if (!outcome.ok) {
      await tx.update(schema.integrationEvent)
        .set({ status: "failed", error: `${outcome.code}: ${outcome.message}`, updatedAt: new Date() })
        .where(eq(schema.integrationEvent.id, attempt!.id));
      throw new ConflictError(outcome.message);
    }

    await tx.update(schema.integrationEvent).set({
      status: "succeeded",
      responsePayload: { refundId: outcome.refund.refundId, status: outcome.refund.status },
      completedAt: new Date(), updatedAt: new Date(),
    }).where(eq(schema.integrationEvent.id, attempt!.id));

    await audit(tx, ctx, "payment.refund_requested", "payment", payment.id, null, {
      refundId: outcome.refund.refundId, amount: m.toString(asked),
    });

    return {
      paymentId: payment.id,
      refundId: outcome.refund.refundId,
      amount: m.toString(asked),
      status: outcome.refund.status,
      /** The row changes when the webhook says the money moved, not now. */
      settled: false as const,
    };
  });
}

/* ------------------------------------------------------------ reading it */

export async function status(ctx: ServiceContext) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const [row] = await tx.select().from(schema.integrationConnection)
      .where(and(
        eq(schema.integrationConnection.organizationId, ctx.actor.organizationId),
        eq(schema.integrationConnection.capability, "payments"),
        isNull(schema.integrationConnection.deletedAt),
      )).limit(1);

    if (!row) {
      return {
        connected: false, provider: null, publishableKey: null,
        webhookConfigured: false, connectionId: null, webhookPath: null, lastError: null,
      };
    }

    const connection = readConnection(row);
    const publishable = connection.settings["publishableKey"];

    return {
      connected: row.status === "connected",
      provider: row.provider,
      publishableKey: typeof publishable === "string" ? publishable : null,
      /**
       * Said out loud, because a payments connection with no signing secret
       * takes cards perfectly well and never learns that any of them
       * succeeded. Every invoice stays open, every customer gets chased for
       * money they have already paid, and the settings screen says connected.
       */
      webhookConfigured: connection.webhookSecretRef !== null,
      connectionId: row.id,
      /**
       * The path rather than the whole URL, because this process does not
       * reliably know its own public address: behind a load balancer or a
       * tunnel the request arrives on an internal hostname, and a settings
       * screen that showed an operator a URL rebuilt from `Host` would have
       * them paste an unreachable one into Stripe and wait for events that
       * never come.
       */
      webhookPath: `/api/webhooks/payments/${row.id}`,
      lastError: row.lastError,
    };
  });
}

export const handlers = {
  getPaymentsStatus: (ctx: ServiceContext) => status(ctx),

  createPaymentIntent: (
    ctx: ServiceContext,
    input: {
      customerId: string; amount?: string | undefined;
      invoiceIds?: string[] | undefined;
      description?: string | undefined; receiptEmail?: string | undefined;
    },
  ) => intent(ctx, input),

  refundPayment: (
    ctx: ServiceContext,
    input: { paymentId: string; amount?: string | undefined; reason?: string | undefined },
  ) => refund(ctx, input),
} as const;

export type { PaymentEvent, WebhookRequest };
