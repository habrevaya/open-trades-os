import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerPortal as cp, money as m, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, inTenant,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as billing from "./billing";
import * as deposits from "./deposits";
import { assertPeriodOpen } from "./history";
import * as tips from "./tips";
import { settingsWithin as portalSettingsWithin } from "./portal-settings";
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

/**
 * The company's connection and an adapter for it, for a service beside this
 * one that talks to the same processor (saving a card). One way to reach the
 * processor, so the secret is read the same way whoever is asking.
 */
export async function processorFor(
  tx: Database, organizationId: string, deps: PaymentDeps = DEFAULT_DEPS,
): Promise<{ connection: Connection; provider: PaymentProvider }> {
  const connection = await connectionFor(tx, organizationId);
  return { connection, provider: await providerFrom(connection, deps) };
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
  /**
   * A deposit this pays, instead of invoices. The amount is what the deposit
   * still has outstanding, read here like an invoice balance, and the money
   * lands on the deposit through `deposits.record` when the processor's
   * webhook says it arrived: a liability, not a sale.
   */
  depositId?: string | undefined;
  /**
   * A tip for the technicians, on top of ONE invoice's balance, as the
   * customer typed it. Checked here against the company's tip settings and
   * the balance, split between the technicians on the invoice's job, and
   * carried on the attempt until the money arrives. Only the portal passes
   * it: the office takes tips the way it takes any other money.
   */
  tip?: string | undefined;
  /**
   * A card this customer saved, by our id for it. The charge is confirmed
   * with it on the spot rather than handed to a payment form.
   */
  savedCardId?: string | undefined;
  /**
   * Where the customer was and what they used when they pressed Pay, for
   * the mandate a bank debit carries. Only the portal passes it.
   */
  acceptance?: { ip?: string | undefined; userAgent?: string | undefined } | undefined;
}

/** What the attempt remembers about a tip, for the moment the money arrives. */
interface TipPlan {
  tip: string;
  invoiceId: string;
  jobId: string | null;
  technicianIds: string[];
  /** The invoice part the tip was added to, so settlement pays the bill first. */
  invoicePart: string;
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
    let tipPlan: TipPlan | null = null;

    if (input.tip !== undefined && (input.depositId || !input.invoiceIds || input.invoiceIds.length !== 1)) {
      throw new ConflictError("A tip goes with paying one invoice, and nothing else.");
    }

    if (input.depositId) {
      if (input.invoiceIds && input.invoiceIds.length > 0) {
        throw new ConflictError("A payment is for a deposit or for invoices, not both.");
      }
      const [deposit] = await tx.select().from(schema.deposit)
        .where(and(
          eq(schema.deposit.id, input.depositId),
          eq(schema.deposit.customerId, input.customerId),
        )).limit(1);
      if (!deposit) throw new NotFoundError("Deposit");
      if (deposit.status !== "requested" && deposit.status !== "held") {
        throw new ConflictError(`This deposit is ${deposit.status} and cannot take a payment.`);
      }
      const outstanding = m.subtract(usd(deposit.amountRequested), usd(deposit.amountReceived));
      if (!m.isPositive(outstanding)) {
        throw new ConflictError("This deposit has been paid. There is nothing outstanding on it.");
      }
      amount = m.toString(outstanding);
    } else if (input.invoiceIds && input.invoiceIds.length > 0) {
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

      if (input.tip !== undefined) {
        const invoiceId = input.invoiceIds[0]!;
        const settings = await portalSettingsWithin(tx, ctx.actor.organizationId);
        const checked = cp.checkTip(input.tip, total, settings.tipping);
        if (!checked.ok) throw new ConflictError(checked.reason);
        if (m.isPositive(checked.tip)) {
          const crew = await tips.techniciansFor(tx, invoiceId);
          if (crew.technicians.length === 0) {
            /**
             * Refused before the card is charged rather than after: a tip
             * with nobody to give it to would sit as money owed to nobody.
             */
            throw new ConflictError(
              "Nobody is recorded as having done this work yet, so there is nobody to give a tip to. "
              + "Pay the invoice without one.",
            );
          }
          tipPlan = {
            tip: m.toString(checked.tip),
            invoiceId,
            jobId: crew.jobId,
            technicianIds: crew.technicians.map((t) => t.id),
            invoicePart: amount,
          };
          amount = m.toString(cp.chargeFor(total, checked.tip));
        }
      }
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
     * A SAVED CARD BELONGS TO THE CUSTOMER BEING CHARGED, checked here
     * whoever the caller is. A card id from another customer is the same
     * not found as one that does not exist.
     */
    let saved: { customerRef: string; paymentMethodRef: string; id: string; kind: string } | null = null;
    if (input.savedCardId) {
      const [card] = await tx.select({
        id: schema.savedPaymentMethod.id,
        kind: schema.savedPaymentMethod.kind,
        paymentMethodRef: schema.savedPaymentMethod.externalRef,
        customerRef: schema.paymentProfile.externalRef,
        connectionId: schema.paymentProfile.connectionId,
      })
        .from(schema.savedPaymentMethod)
        .innerJoin(schema.paymentProfile, eq(schema.paymentProfile.id, schema.savedPaymentMethod.profileId))
        .where(and(
          eq(schema.savedPaymentMethod.id, input.savedCardId),
          eq(schema.savedPaymentMethod.customerId, input.customerId),
          isNull(schema.savedPaymentMethod.removedAt),
        )).limit(1);
      if (!card) throw new NotFoundError("Saved card");
      if (card.connectionId !== connection.id) {
        /**
         * Saved against a processor account this company has since
         * replaced. The reference names a card in the old account, which
         * the new key cannot charge.
         */
        throw new ConflictError("That card was saved before the company changed how it takes payments. Add it again.");
      }
      saved = { id: card.id, kind: card.kind, customerRef: card.customerRef, paymentMethodRef: card.paymentMethodRef };
    }
    const bank = saved?.kind === "bank_account";

    /**
     * NOT TWICE WHILE A BANK PAYMENT IS ON ITS WAY. A bank debit takes days
     * to arrive, and the invoice stays open until it does: a customer who
     * looks again on Wednesday and pays the same bill by card has paid it
     * twice, and the second refund is a phone call. Asked of every path,
     * the office's included, for the same reason.
     */
    if (allocations.length > 0) {
      const pending = await pendingBankPayments(tx, { invoiceIds: allocations.map((a) => a.invoiceId) });
      if (pending.length > 0) {
        throw new ConflictError(
          `A bank payment of ${m.format(usd(pending[0]!.amount))} for this invoice is already on its way, `
          + "started " + pending[0]!.startedAt.toISOString().slice(0, 10) + ". Bank payments take a few "
          + "business days to arrive. If it fails, the invoice can be paid another way then.",
        );
      }
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
      requestPayload: {
        amount, allocations, connectionId: connection.id,
        ...(input.depositId ? { depositId: input.depositId } : {}),
        ...(tipPlan ? { tip: tipPlan } : {}),
        ...(saved ? { savedCardId: saved.id } : {}),
        /** Remembered so settlement books it as a bank payment and a failure is told to the office. */
        ...(bank ? { method: "ach" } : {}),
      },
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
      ...(saved ? { customerRef: saved.customerRef, paymentMethodRef: saved.paymentMethodRef } : {}),
      ...(bank ? { methodKind: "bank_account" as const, ...(input.acceptance ? { acceptance: input.acceptance } : {}) } : {}),
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
      /**
       * `in_flight` is a payment the processor has accepted and not yet
       * settled: a bank debit, for days. It is what the invoice and the
       * customer's account read as "on its way".
       */
      ...(outcome.intent.status === "processing" ? { status: "in_flight" as const } : {}),
      attempts: 1,
      updatedAt: new Date(),
    }).where(eq(schema.integrationEvent.id, attempt!.id));

    await audit(tx, ctx, "payment.intent_created", "customer", input.customerId, null, {
      attemptId: attempt!.id, intentId: outcome.intent.intentId, amount,
      ...(tipPlan ? { tip: tipPlan.tip } : {}),
      ...(saved ? { savedCardId: saved.id } : {}),
    });

    return {
      attemptId: attempt!.id,
      intentId: outcome.intent.intentId,
      clientSecret: outcome.intent.clientSecret,
      publishableKey: provider.publishableKey,
      amount,
      currency: outcome.intent.currency,
      allocations,
      /** What the processor said, which only matters for a saved card confirmed on the spot. */
      status: outcome.intent.status,
      tip: tipPlan?.tip ?? "0.0000",
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
    grants: ["payment:collect", "payment:refund", "deposit:collect"],
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
    await record("succeeded", settled.paymentId ?? null);
    return {
      handled: true, kind: event.kind, eventId: event.eventId,
      ...(settled.paymentId ? { paymentId: settled.paymentId } : {}),
      ...(settled.depositId ? { note: `deposit ${settled.depositId}` } : {}),
    };
  }

  if (event.kind === "refunded" || event.kind === "disputed") {
    let touched: string | null;
    try {
      touched = await adjust(ctx, connection.provider, event);
    } catch (error) {
      /**
       * A refund against money that sat on an invoice since voided or
       * written off cannot reopen it, by the same rule a recorded refund
       * follows. That is a fact about this company's books that no retry
       * changes, so it is recorded where an operator sees failed events,
       * with the reason, rather than thrown back at Stripe to retry for days.
       */
      if (!(error instanceof ConflictError)) throw error;
      await record("failed", null, error.message);
      return { handled: false, kind: event.kind, eventId: event.eventId, note: error.message };
    }
    await record(touched ? "succeeded" : "failed", touched, touched ? undefined
      : "No payment here matches that processor id.");
    return {
      handled: touched !== null, kind: event.kind, eventId: event.eventId,
      ...(touched ? { paymentId: touched } : {}),
      ...(touched ? {} : { note: "no matching payment" }),
    };
  }

  if (event.kind === "processing") {
    /**
     * On its way and not arrived. The attempt is marked so, which is what
     * the invoice and the customer's account read as pending; nothing is
     * booked until the processor says it succeeded.
     */
    await inTenant(ctx, async (tx) => {
      if (!event.intentId) return;
      await tx.update(schema.integrationEvent)
        .set({
          status: "in_flight",
          ...(event.methodType === "us_bank_account"
            ? { requestPayload: sql`${schema.integrationEvent.requestPayload} || '{"method":"ach"}'::jsonb` }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.integrationEvent.organizationId, connection.organizationId),
          eq(schema.integrationEvent.direction, "outbound"),
          eq(schema.integrationEvent.eventType, "payment.intent"),
          eq(schema.integrationEvent.status, "pending"),
          sql`${schema.integrationEvent.responsePayload}->>'intentId' = ${event.intentId}`,
        ));
    });
    await record("succeeded", null);
    return { handled: true, kind: event.kind, eventId: event.eventId };
  }

  if (event.kind === "failed") {
    const note = await failed(ctx, connection, event);
    await record("succeeded", note.paymentId ?? null);
    return {
      handled: true, kind: event.kind, eventId: event.eventId,
      ...(note.paymentId ? { paymentId: note.paymentId } : {}),
      ...(note.note ? { note: note.note } : {}),
    };
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
/**
 * Money for a deposit, through the path a deposit taken by hand uses.
 *
 * `deposits.record` posts cash against the deposit liability and nothing to
 * revenue, which is the whole difference between a deposit and a payment.
 *
 * The attempt is claimed first with a conditional update, because unlike
 * `billing.pay` the deposit path has no idempotency key of its own: two
 * deliveries of one event racing past the duplicate check above would
 * otherwise record the deposit twice. If recording fails the claim is
 * released, so the processor's retry can try again.
 */
async function settleDeposit(
  ctx: ServiceContext, attemptId: string, depositId: string, amount: string, event: PaymentEvent,
): Promise<string> {
  const claimed = await inTenant(ctx, async (tx) => tx.update(schema.integrationEvent).set({
    status: "succeeded", entityType: "deposit", entityId: depositId,
    completedAt: new Date(), updatedAt: new Date(),
  }).where(and(
    eq(schema.integrationEvent.id, attemptId),
    sql`${schema.integrationEvent.status} <> 'succeeded'`,
  )).returning({ id: schema.integrationEvent.id }));
  if (claimed.length === 0) return depositId;

  try {
    await deposits.record(ctx, {
      depositId,
      amount,
      ...(event.feeMinor !== null ? { processingFee: fromMinor(event.feeMinor) } : {}),
    });
  } catch (error) {
    await inTenant(ctx, async (tx) => tx.update(schema.integrationEvent)
      .set({ status: "pending", completedAt: null, updatedAt: new Date() })
      .where(eq(schema.integrationEvent.id, attemptId)));
    throw error;
  }
  return depositId;
}

async function settle(
  ctx: ServiceContext, connection: Connection, event: PaymentEvent,
): Promise<{ paymentId?: string; depositId?: string }> {
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
    amount?: string; allocations?: { invoiceId: string; amount: string }[]; depositId?: string;
    tip?: TipPlan; method?: string;
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

  if (request.depositId && attempt) {
    return { depositId: await settleDeposit(ctx, attempt.id, request.depositId, amount, event) };
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
  /**
   * THE TIP COMES OUT OF WHAT ARRIVED, AFTER THE BILL.
   *
   * The charge was the balance plus the tip, and `payment.amount` is what
   * goes on invoices while `payment.tip_amount` is held for the
   * technicians, so the two are separated here. When less arrived than was
   * asked, core pays the invoice first and the tip takes what is left: see
   * `customerPortal.settleTip`.
   */
  const plan = request.tip ?? null;
  let applied = amount;
  let tip = m.zero("USD");
  if (plan) {
    const split = cp.settleTip({
      reported: usd(amount), invoicePart: usd(plan.invoicePart), tip: usd(plan.tip),
    });
    applied = m.toString(split.applied);
    tip = split.tip;
  }

  const asked = (request.allocations ?? []).reduce(
    (total, one) => m.add(total, usd(one.amount)), m.money("0", "USD"),
  );
  const fits = request.allocations && request.allocations.length > 0
    && m.compare(asked, usd(applied)) === 0;

  /**
   * The payment and the tip's shares in one transaction, so a tip is never
   * on the books as owed without anybody it is owed to. `billing.pay` runs
   * inside it as a nested transaction, which is how the rest of this layer
   * puts one guarded write inside another.
   */
  const result = await inTenant(ctx, async (tx) => {
    const paid = await billing.pay({ ...ctx, db: tx }, {
      customerId,
      /** A bank debit is booked as one, so the office can tell the slow money from the card money. */
      method: request.method === "ach" || event.methodType === "us_bank_account" ? "ach" : "card",
      amount: applied,
      tipAmount: m.toString(tip),
      ...(event.feeMinor !== null ? { feeAmount: fromMinor(event.feeMinor) } : {}),
      ...(fits ? { allocations: request.allocations! } : {}),
      ...(event.intentId ? { processorPaymentId: event.intentId } : {}),
    });
    if (plan && m.isPositive(tip)) {
      const [row] = await tx.select({ receivedAt: schema.payment.receivedAt })
        .from(schema.payment).where(eq(schema.payment.id, paid.id)).limit(1);
      await tips.writeShares(tx, {
        organizationId: connection.organizationId,
        paymentId: paid.id,
        invoiceId: plan.invoiceId,
        jobId: plan.jobId,
        tip,
        technicianIds: plan.technicianIds,
        occurredAt: row?.receivedAt ?? new Date(),
      });
    }
    return paid;
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
async function adjust(
  ctx: ServiceContext, provider: string, event: PaymentEvent,
): Promise<string | null> {
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
    /**
     * Locked, because refund events for one payment arrive in bursts and
     * each reads what the others have already booked. Without the lock two
     * of them both find nothing recorded and both post.
     */
    const [payment] = await tx.select().from(schema.payment)
      .where(eq(schema.payment.processorPaymentId, event.intentId!)).limit(1)
      .for("update");

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

    return refundFromProcessor(tx, ctx, provider, payment, event);
  });
}

/**
 * A refund the processor reports, put on the books.
 *
 * THIS USED TO MOVE ONE COLUMN. The payment's refunded total and status
 * changed and nothing else did: no posting, no invoice reopened. A card
 * refund therefore left cash on the balance sheet that had gone back to the
 * customer and an invoice marked paid that no longer was, and the ledger,
 * which every financial report reads, disagreed with the bank from that day
 * on. It now goes through `billing.reverseForRefund`, the same path a refund
 * recorded by hand takes, so the two reopen the same invoices and post the
 * same entries.
 *
 * IDEMPOTENT ON THE PROCESSOR'S REFUND ID, not on the event id. Stripe
 * reports one refund as `refund.created`, `refund.updated` and
 * `charge.refunded`: three event ids, one refund, and keying on the event
 * would book it three times. Each refund id posted is recorded as an
 * inbound integration event keyed on that id, and the payment row is locked
 * first, so two of those events arriving together wait for each other
 * rather than both finding nothing recorded.
 *
 * An event naming no refunds carries only the cumulative total refunded, so
 * the difference between that and what is already booked is posted. That
 * money has no refund id, and a later event that does name the refund finds
 * it already counted: what the payment shows refunded beyond the refunds it
 * can name is attributed to the refund before anything new is posted.
 *
 * Only a refund Stripe calls `succeeded` is booked. A pending one has moved
 * no money and a failed one never will.
 */
async function refundFromProcessor(
  tx: Database, ctx: ServiceContext, provider: string,
  payment: typeof schema.payment.$inferSelect, event: PaymentEvent,
): Promise<string> {
  const before = payment;
  let current = payment;
  const posted: { refundId: string | null; amount: string; refundedAt: string }[] = [];

  const book = async (amount: m.Money, at: Date | null | undefined, refundId: string | null) => {
    const left = m.subtract(usd(current.amount), usd(current.refundedAmount));
    const take = m.compare(amount, left) <= 0 ? amount : left;
    if (!m.isPositive(take)) return;
    const refundedAt = await openDateFor(tx, ctx.actor.organizationId, at ?? new Date());
    const { after } = await billing.reverseForRefund(tx, ctx, current, take, refundedAt);
    current = after;
    posted.push({ refundId, amount: m.toString(take), refundedAt: refundedAt.toISOString() });
  };

  const named = (event.refunds ?? []).filter((r) => r.status === null || r.status === "succeeded");

  if (named.length > 0) {
    for (const refund of named) {
      const seen = await tx.select({ id: schema.integrationEvent.id })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.provider, provider),
          eq(schema.integrationEvent.idempotencyKey, refund.refundId),
          eq(schema.integrationEvent.eventType, REFUND_POSTED),
        )).limit(1);
      if (seen.length > 0) continue;

      const amount = usd(fromMinor(refund.amountMinor));
      /**
       * Money already refunded on this payment that no recorded refund id
       * accounts for: a cumulative-only event got here first, or somebody
       * recorded the same refund by hand. It covers this refund before
       * anything new is posted, so the same dollars are never booked twice.
       */
      const attributed = await tx.select({ amount: sql<string>`(${schema.integrationEvent.requestPayload}->>'amount')` })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.provider, provider),
          eq(schema.integrationEvent.eventType, REFUND_POSTED),
          eq(schema.integrationEvent.entityId, current.id),
        ));
      const named_ = attributed.reduce((sum, row) => m.add(sum, usd(row.amount ?? "0")), usd("0"));
      const unnamed = m.subtract(usd(current.refundedAmount), named_);
      const covered = m.isPositive(unnamed)
        ? (m.compare(unnamed, amount) >= 0 ? amount : unnamed)
        : usd("0");

      await book(m.subtract(amount, covered), refund.createdAt ?? event.occurredAt, refund.refundId);

      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound",
        provider,
        eventType: REFUND_POSTED,
        idempotencyKey: refund.refundId,
        status: "succeeded",
        entityType: "payment",
        entityId: current.id,
        requestPayload: { amount: m.toString(amount), eventId: event.eventId },
        completedAt: new Date(),
      });
    }
  } else if (event.refundedMinor !== null) {
    /**
     * The processor reports the CUMULATIVE amount refunded, not this
     * refund's amount. Booking it whole would double count the moment a
     * second partial refund arrives, so only the increase is posted.
     */
    const delta = m.subtract(usd(fromMinor(event.refundedMinor)), usd(current.refundedAmount));
    if (m.isPositive(delta)) await book(delta, event.occurredAt, null);
  }

  if (posted.length > 0) {
    await audit(tx, ctx, "payment.refunded", "payment", current.id, before, {
      ...current, refunds: posted,
    });
  }
  return current.id;
}

/** The inbound row that says a processor refund id has been booked. */
const REFUND_POSTED = "payment.refund_posted";

/**
 * The date a processor refund is booked on.
 *
 * Its own date when that period is open. When the books are closed through
 * it, today, which is what an accountant does with a correction to a filed
 * period and what `assertPeriodOpen` says to do. Refusing instead would fail
 * the webhook, Stripe would retry it for days, and the refund, which has
 * already left the bank, would never be booked at all.
 */
async function openDateFor(tx: Database, organizationId: string, at: Date): Promise<Date> {
  try {
    await assertPeriodOpen(tx, organizationId, at);
    return at;
  } catch (error) {
    if (error instanceof ConflictError) return new Date();
    throw error;
  }
}

/* ------------------------------------------------------- money that did not come */

/**
 * A payment the processor says failed.
 *
 * Most failures are a card declined with the customer on the page, who sees
 * it there, and those only close the attempt. A BANK PAYMENT IS DIFFERENT:
 * it failed days after the customer pressed Pay, they have walked away
 * believing the bill is settled, and nobody will look. So when the attempt
 * was a bank debit on its way, the office is told in its queue, in words,
 * with what to do next.
 *
 * And when a payment had already been BOOKED for this charge (a bank that
 * returns a debit after the processor first called it settled), it is
 * reversed: the invoices it paid are reopened and the ledger takes the cash
 * back out, through the same path a refund takes, and the payment is marked
 * failed rather than refunded, because nobody gave anything back. The
 * office is told that too. Safe to receive twice: a payment already marked
 * failed is not reversed again.
 */
async function failed(
  ctx: ServiceContext, connection: Connection, event: PaymentEvent,
): Promise<{ paymentId?: string; note?: string }> {
  if (!event.intentId) return {};
  const reason = event.failureMessage ?? "The payment was declined.";

  const attempt = await inTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(schema.integrationEvent)
      .where(and(
        eq(schema.integrationEvent.organizationId, connection.organizationId),
        eq(schema.integrationEvent.direction, "outbound"),
        eq(schema.integrationEvent.eventType, "payment.intent"),
        sql`${schema.integrationEvent.responsePayload}->>'intentId' = ${event.intentId}`,
      ))
      .orderBy(desc(schema.integrationEvent.createdAt)).limit(1);
    if (row && row.status !== "succeeded" && row.status !== "failed") {
      await tx.update(schema.integrationEvent)
        .set({ status: "failed", error: reason, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.integrationEvent.id, row.id));
    }
    return row ?? null;
  });
  const request = (attempt?.requestPayload ?? {}) as { amount?: string; allocations?: { invoiceId: string }[]; method?: string };
  const bank = request.method === "ach" || event.methodType === "us_bank_account";
  const wasOnItsWay = attempt?.status === "in_flight" || (bank && attempt?.status === "pending");

  const reversed = await guardedWrite(ctx, "payment:refund", async (tx) => {
    const [payment] = await tx.select().from(schema.payment)
      .where(eq(schema.payment.processorPaymentId, event.intentId!)).limit(1)
      .for("update");
    if (!payment || payment.status === "failed") return null;
    const left = m.subtract(usd(payment.amount), usd(payment.refundedAmount));
    const reopened = await tx.select({ invoiceId: schema.paymentAllocation.invoiceId })
      .from(schema.paymentAllocation).where(eq(schema.paymentAllocation.paymentId, payment.id));
    let after = payment;
    if (m.isPositive(left)) {
      const at = await openDateFor(tx, ctx.actor.organizationId, event.occurredAt ?? new Date());
      after = (await billing.reverseForRefund(tx, ctx, payment, left, at)).after;
    }
    const [marked] = await tx.update(schema.payment)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(schema.payment.id, payment.id)).returning();
    await audit(tx, ctx, "payment.returned", "payment", payment.id, after, { ...marked!, reason });
    return { payment, amount: left, invoiceIds: [...new Set(reopened.map((r) => r.invoiceId))] };
  });

  if (!reversed && !(bank && wasOnItsWay)) return {};

  await inTenant(ctx, async (tx) => {
    const customerId = reversed?.payment.customerId ?? attempt?.entityId ?? null;
    if (!customerId) return;
    const [customer] = await tx.select({ name: schema.customer.name })
      .from(schema.customer).where(eq(schema.customer.id, customerId)).limit(1);
    const invoiceIds = reversed?.invoiceIds ?? (request.allocations ?? []).map((a) => a.invoiceId);
    const invoices = invoiceIds.length > 0
      ? await tx.select({ id: schema.invoice.id, number: schema.invoice.number })
        .from(schema.invoice).where(inArray(schema.invoice.id, invoiceIds))
      : [];
    const numbers = invoices.map((i) => `#${i.number}`).join(", ");
    const amount = reversed ? m.format(reversed.amount) : m.format(usd(request.amount ?? "0"));
    const who = customer?.name ?? "A customer";
    const what = bank ? "bank payment" : "payment";
    await tx.insert(schema.task).values({
      organizationId: connection.organizationId,
      title: reversed
        ? `${who}'s ${what} of ${amount} was returned and has been taken back off ${numbers ? `invoice ${numbers}` : "their account"}`
        : `${who}'s ${what} of ${amount}${numbers ? ` for invoice ${numbers}` : ""} did not go through`,
      body: reversed
        ? `Their bank returned it after it had been recorded as paid: ${reason} `
          + `The invoice is open again for what it covered, and the books no longer count the money. `
          + "Ask them for another way to pay."
        : `Their bank refused it: ${reason} Nothing was recorded as paid, so the invoice is still open. `
          + "Ask them for another way to pay.",
      priority: "high",
      entityType: invoices.length === 1 ? "invoice" : "customer",
      entityId: invoices.length === 1 ? invoices[0]!.id : customerId,
      queue: "office",
    });
  });

  return reversed
    ? { paymentId: reversed.payment.id, note: "payment reversed" }
    : { note: "bank payment failed" };
}

/**
 * Bank payments on their way: accepted by the processor and not yet
 * arrived, for some invoices or one customer. What an invoice shows as
 * pending, and what stops it being paid twice in the meantime.
 */
export interface PendingBankPayment {
  attemptId: string;
  customerId: string;
  amount: string;
  invoiceIds: string[];
  startedAt: Date;
}

export async function pendingBankPayments(
  tx: Database, input: { invoiceIds?: string[] | undefined; customerId?: string | undefined },
): Promise<PendingBankPayment[]> {
  if (input.invoiceIds && input.invoiceIds.length === 0) return [];
  const rows = await tx.select().from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.direction, "outbound"),
      eq(schema.integrationEvent.eventType, "payment.intent"),
      eq(schema.integrationEvent.status, "in_flight"),
      input.customerId ? eq(schema.integrationEvent.entityId, input.customerId) : undefined,
      input.invoiceIds
        ? sql`exists (select 1 from jsonb_array_elements(${schema.integrationEvent.requestPayload}->'allocations') a
            where a->>'invoiceId' in ${sql`(${sql.join(input.invoiceIds.map((id) => sql`${id}`), sql`, `)})`})`
        : undefined,
    ))
    .orderBy(desc(schema.integrationEvent.createdAt))
    .limit(50);
  return rows.map((row) => {
    const request = (row.requestPayload ?? {}) as { amount?: string; allocations?: { invoiceId: string }[] };
    return {
      attemptId: row.id,
      customerId: row.entityId ?? "",
      amount: request.amount ?? "0",
      invoiceIds: (request.allocations ?? []).map((a) => a.invoiceId),
      startedAt: row.createdAt,
    };
  });
}

/** A bank payment as the office and the customer see it: on its way, or failed recently and why. */
export interface BankPaymentView {
  id: string;
  status: "pending" | "failed";
  amount: string;
  invoiceIds: string[];
  startedAt: string;
  failedAt: string | null;
  reason: string | null;
}

/**
 * One customer's bank payments that are on their way, and the ones that
 * failed in the last thirty days, newest first. Read inside a caller's
 * transaction, because the portal reads it through a grant and the office
 * through its own guard.
 */
export async function bankPaymentsWithin(
  tx: Database, input: { customerId?: string | undefined; invoiceId?: string | undefined },
): Promise<BankPaymentView[]> {
  const since = new Date(Date.now() - 30 * 864e5);
  const rows = await tx.select().from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.direction, "outbound"),
      eq(schema.integrationEvent.eventType, "payment.intent"),
      sql`${schema.integrationEvent.requestPayload}->>'method' = 'ach'`,
      input.customerId ? eq(schema.integrationEvent.entityId, input.customerId) : undefined,
      input.invoiceId
        ? sql`exists (select 1 from jsonb_array_elements(${schema.integrationEvent.requestPayload}->'allocations') a
            where a->>'invoiceId' = ${input.invoiceId})`
        : undefined,
      sql`(${schema.integrationEvent.status} = 'in_flight'
        or (${schema.integrationEvent.status} = 'failed' and ${schema.integrationEvent.updatedAt} >= ${since.toISOString()}::timestamptz))`,
    ))
    .orderBy(desc(schema.integrationEvent.createdAt))
    .limit(20);
  return rows.map((row) => {
    const request = (row.requestPayload ?? {}) as { amount?: string; allocations?: { invoiceId: string }[] };
    return {
      id: row.id,
      status: row.status === "in_flight" ? "pending" as const : "failed" as const,
      amount: request.amount ?? "0",
      invoiceIds: (request.allocations ?? []).map((a) => a.invoiceId),
      startedAt: row.createdAt.toISOString(),
      failedAt: row.status === "failed" ? (row.completedAt ?? row.updatedAt).toISOString() : null,
      reason: row.status === "failed" ? row.error : null,
    };
  });
}

/** The office's read of the same thing, for an invoice or a customer. */
export async function bankPayments(
  ctx: ServiceContext, input: { customerId?: string | undefined; invoiceId?: string | undefined },
): Promise<{ bankPayments: BankPaymentView[] }> {
  return guardedRead(ctx, "payment:read", async (tx) => ({ bankPayments: await bankPaymentsWithin(tx, input) }));
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
