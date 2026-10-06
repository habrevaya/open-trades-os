import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { history, isSystem, money as m } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { admitDate } from "./history";
import {
  failCardPayout, loadNote, lockNote, pendingPayoutsOn, postPayout, reservePayout,
  type PayoutMethod,
} from "./credit-notes";
import { processorFor, type PaymentDeps, secretFromEnvironment } from "./payments";

/**
 * CREDIT PAID OUT AS MONEY
 *
 * A credit note leaves what the company owes the customer on their account,
 * to be used on a later invoice. Often there is no later invoice: the job was
 * the last one, the customer moved, the complaint was about the only visit.
 * Until this file the only honest thing to do with that credit was to leave
 * it there for ever, and the dishonest thing, refunding a payment by hand,
 * reopened an invoice the customer had paid and left the books saying they
 * owed it again.
 *
 * TWO WAYS BACK, and they post the same.
 *
 *   BY CARD, through the processor, as a refund against one of the
 *   customer's earlier card payments: the card they paid with is where the
 *   money goes back to, and a processor will only refund against a charge.
 *   Asked for here, POSTED WHEN THE PROCESSOR SAYS THE MONEY MOVED, exactly as
 *   a card refund is (`payments.receive`): a refund that was asked for has
 *   not moved money, and one that fails never will. The credit is set aside
 *   from the moment it is asked for, so it cannot also be used on an invoice
 *   while the refund is on its way, and goes back on the account if the
 *   processor refuses.
 *
 *   BY HAND, cash or a cheque handed over, recorded once it has gone and
 *   posted on the day it went.
 *
 * Either way the posting is `ledger.postCreditNotePayout`: customer deposits
 * down, cash down, and no invoice touched. The card payment the money went
 * back through records it as refunded and as paid out, so it still says it
 * paid what it paid.
 *
 * THE AUTHORITY IS `payment:refund`, the permission for sending money back.
 * Raising the credit was `invoice:credit`, a different decision usually made
 * by a different person: what the customer is owed is not the same question
 * as whether money leaves the bank today.
 */

const usd = (value: string) => m.money(value, "USD");
const say = (value: m.Money) => m.edit(m.round(value, 2));
/** Cents, because processors speak cents. The amount is already whole cents. */
const toMinor = (amount: m.Money): number => Math.round(Number(m.toString(m.round(amount, 2))) * 100);

const DEFAULT_DEPS: PaymentDeps = { readSecret: secretFromEnvironment };

export interface PayOutInput {
  id: string;
  method: PayoutMethod;
  amount?: string | undefined;
  paymentId?: string | undefined;
  reference?: string | undefined;
  paidOn?: string | undefined;
  note?: string | undefined;
}

type PaymentRow = typeof schema.payment.$inferSelect;

/**
 * What the processor would still refund on a payment: its amount, less what
 * has been refunded and what other credit payouts are waiting on it. A
 * pending payout is counted because the processor already counts it.
 */
async function refundableOn(tx: Database, payment: PaymentRow): Promise<m.Money> {
  const waiting = await pendingPayoutsOn(tx, payment.id);
  const held = m.sum(waiting.map((p) => usd(p.amount)), "USD");
  const left = m.subtract(m.subtract(usd(payment.amount), usd(payment.refundedAmount)), held);
  return m.isNegative(left) ? usd("0") : left;
}

/** The customer's payments taken through a processor, newest first, that have anything left to refund. */
async function cardPaymentsOf(tx: Database, customerId: string) {
  const rows = await tx.select().from(schema.payment)
    .where(and(
      eq(schema.payment.customerId, customerId),
      isNotNull(schema.payment.processorPaymentId),
      inArray(schema.payment.status, ["succeeded", "partially_refunded"]),
    ))
    .orderBy(desc(schema.payment.receivedAt), desc(schema.payment.id));
  const out: Array<{ payment: PaymentRow; refundable: m.Money }> = [];
  for (const payment of rows) {
    const refundable = await refundableOn(tx, payment);
    if (m.isPositive(refundable)) out.push({ payment, refundable });
  }
  return out;
}

export async function refundablePayments(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "payment:read", async (tx) => {
    const note = await loadNote(tx, input.id);
    const found = await cardPaymentsOf(tx, note.customerId);
    return {
      payments: found.map(({ payment, refundable }) => ({
        id: payment.id,
        method: payment.method,
        amount: payment.amount,
        refundable: m.toString(refundable),
        receivedAt: payment.receivedAt.toISOString(),
      })),
    };
  });
}

/**
 * Pay some or all of what is left on a credit note back to the customer.
 *
 * Every refusal is a sentence: a draft, a credit with nothing left, more
 * than is left, a card payment of somebody else's or with too little left to
 * refund, and a processor's own answer when it declines.
 */
export async function payOut(
  ctx: ServiceContext, input: PayOutInput, deps: PaymentDeps = DEFAULT_DEPS,
) {
  return guardedWrite(ctx, "payment:refund", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "credit_note_payout"),
        )).limit(1);
      if (seen?.entityId) return loadNote(tx, seen.entityId);
    }

    const note = await lockNote(tx, input.id);
    const amount = input.amount ? usd(input.amount) : usd(note.balance);
    await reservePayout(tx, note, amount);

    const [payout] = await tx.insert(schema.creditNotePayout).values({
      organizationId: ctx.actor.organizationId,
      creditNoteId: note.id,
      customerId: note.customerId,
      method: input.method,
      status: "pending",
      amount: m.toString(amount),
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || null,
      createdByUserId: ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId,
    }).returning();

    if (input.method === "card") {
      await sendToCard(tx, ctx, { payout: payout!, amount, paymentId: input.paymentId, deps, customerId: note.customerId });
    } else {
      if (input.paymentId) {
        throw new UnprocessableError("Cash and cheques do not go back through a card payment", [{
          path: "paymentId", message: "Leave the payment off, or pay it back to the card.",
        }]);
      }
      /**
       * On the day the office says it went, by the rules every business date
       * here follows: not in the future, and not in a closed period, which
       * `writePosting` refuses in words.
       */
      const admitted = input.paidOn ? await admitDate(tx, ctx, input.paidOn, "paidOn") : null;
      const at = input.paidOn && admitted
        ? history.postingInstant(input.paidOn, admitted.timeZone, new Date())
        : new Date();
      await postPayout(tx, ctx, payout!, at);
    }

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "credit_note.payout",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "credit_note_payout", entityId: note.id,
      });
    }
    return loadNote(tx, note.id);
  });
}

/**
 * Ask the processor to refund the payout against a card payment.
 *
 * The attempt is written to `integration_event` before the call, keyed by
 * the payout's own id, so a retry of a call whose answer was lost is the
 * same refund at the processor rather than a second one. A refusal rolls the
 * whole payout back, reservation and all: nothing left, so nothing is owed
 * an explanation beyond the processor's own words.
 */
async function sendToCard(
  tx: Database, ctx: ServiceContext,
  input: {
    payout: typeof schema.creditNotePayout.$inferSelect; amount: m.Money;
    paymentId: string | undefined; deps: PaymentDeps; customerId: string;
  },
): Promise<void> {
  const choices = await cardPaymentsOf(tx, input.customerId);
  const chosen = input.paymentId
    ? choices.find((c) => c.payment.id === input.paymentId)
    : choices.find((c) => m.compare(c.refundable, input.amount) >= 0);
  if (input.paymentId && !chosen) {
    const [other] = await tx.select({ customerId: schema.payment.customerId, processorPaymentId: schema.payment.processorPaymentId })
      .from(schema.payment).where(eq(schema.payment.id, input.paymentId)).limit(1);
    if (!other) throw new NotFoundError("Payment");
    throw new ConflictError(
      other.customerId !== input.customerId
        ? "That payment is another customer's. A credit goes back to the card of the customer it is owed to."
        : !other.processorPaymentId
          ? "That payment was not taken through the card processor, so nothing can be refunded through it. Pay the credit out by cash or cheque."
          : "That payment has nothing left that the processor would refund.",
    );
  }
  if (!chosen) {
    throw new ConflictError(
      choices.length === 0
        ? "This customer has no card payment to refund the credit to. Pay it out by cash or cheque."
        : `None of this customer's card payments has ${say(input.amount)} left to refund. Pay out less, or by cash or cheque.`,
    );
  }
  if (m.compare(input.amount, chosen.refundable) > 0) {
    throw new ConflictError(
      `That payment has ${say(chosen.refundable)} left that the processor would refund, less than ${say(input.amount)}.`,
    );
  }
  const { connection, provider } = await processorFor(tx, ctx.actor.organizationId, input.deps);
  const [attempt] = await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId,
    direction: "outbound",
    provider: connection.provider,
    eventType: "credit_note.payout_refund",
    idempotencyKey: input.payout.id,
    status: "pending",
    entityType: "credit_note_payout",
    entityId: input.payout.id,
    requestPayload: { amount: m.toString(input.amount), paymentId: chosen.payment.id },
  }).returning();

  const outcome = await provider.refund({
    intentId: chosen.payment.processorPaymentId!,
    amountMinor: toMinor(input.amount),
    idempotencyKey: input.payout.id,
    reason: "requested_by_customer",
  });
  if (!outcome.ok) {
    await tx.update(schema.integrationEvent)
      .set({ status: "failed", error: `${outcome.code}: ${outcome.message}`, updatedAt: new Date() })
      .where(eq(schema.integrationEvent.id, attempt!.id));
    throw new ConflictError(`The card processor would not refund it: ${outcome.message}`);
  }

  await tx.update(schema.integrationEvent).set({
    status: "succeeded",
    responsePayload: { refundId: outcome.refund.refundId, status: outcome.refund.status },
    completedAt: new Date(), updatedAt: new Date(),
  }).where(eq(schema.integrationEvent.id, attempt!.id));

  const [sent] = await tx.update(schema.creditNotePayout).set({
    paymentId: chosen.payment.id,
    processor: connection.provider,
    processorRefundId: outcome.refund.refundId,
    updatedAt: new Date(),
  }).where(eq(schema.creditNotePayout.id, input.payout.id)).returning();

  await audit(tx, ctx, "credit_note.payout_requested", "credit_note", input.payout.creditNoteId, null, {
    payoutId: input.payout.id, paymentId: chosen.payment.id, refundId: outcome.refund.refundId,
    amount: m.toString(input.amount),
  });

  /**
   * A refund the processor already calls failed or cancelled will never
   * move money, so the credit goes back now rather than waiting for a
   * webhook that would say the same.
   */
  if (outcome.refund.status === "failed" || outcome.refund.status === "canceled") {
    await failCardPayout(tx, ctx, sent!, `The card processor reported the refund ${outcome.refund.status}.`);
  }
}

export const handlers = {
  payOutCreditNote: (ctx: ServiceContext, input: PayOutInput) => payOut(ctx, input),
  refundableCardPayments: (ctx: ServiceContext, input: { id: string }) => refundablePayments(ctx, input),
} as const;
