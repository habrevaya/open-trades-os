import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  comms, customerPortal as cp, money as m, SYSTEM_USER_ID, type Actor, type Permission,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, scopeOf, timezoneOf,
  ConflictError, NotFoundError, type RequestMeta, type ServiceContext,
} from "./context";
import { invoiceScopeFilter } from "./scope";
import * as payments from "./payments";
import * as invoiceDelivery from "./invoice-delivery";
import { sendTransactional, quietHoursFor } from "./comms-send";
import { inGrant } from "./portal";
import { sessionFor, type PortalSession } from "./portal-sign-in";

/**
 * A SAVED CARD THE COMPANY MAY CHARGE, AND PAYING BILLS AUTOMATICALLY
 *
 * A saved card is a reference the customer uses by pressing Pay (see
 * `saved-cards.ts`). This file is the other way to use one: the office, or
 * the worker paying a bill automatically, charges it with nobody on the page.
 *
 * ONLY WITH THE CUSTOMER'S RECORDED AGREEMENT. The customer, signed in to
 * their own account (never from a link, which can be forwarded), reads the
 * words core builds for that card and agrees; the words, the moment, the sign
 * in, the contact when it was a contact, and where from are kept on
 * `payment_agreement`. Without a live agreement for that very card there is
 * no charge: this file refuses, and `payments.intent` refuses again inside
 * the transaction that asks the processor, so a path that forgot to ask is
 * still stopped. The customer withdraws it from the same screen, and taking
 * the card off withdraws it too.
 *
 * THE PROCESSOR'S DOCUMENTED WAY. An off session payment intent with the
 * saved payment method, confirmed at once. A bank that wants the cardholder
 * to approve it answers `authentication_required`, and the answer to that is
 * the customer's own link to pay, sent to them, never a silent failure.
 *
 * STILL SETTLED ONLY BY THE WEBHOOK. A charge here is an attempt like any
 * other card payment; the invoice shows paid when the processor's signed
 * webhook says the money moved, through the one settlement path.
 *
 * PAYING AUTOMATICALLY is a second agreement on the first, and is the
 * worker's: each invoice the customer pays that is issued after they turned
 * it on is charged once, keyed on the invoice under a unique index. A
 * declined card is tried once more the next day and never again; a failure
 * sends the customer the link to pay another way and puts a task in the
 * office queue. Reconciled rather than hooked into every place an invoice
 * is issued: the worker asks which bills are owed and not yet charged.
 */

/* ---------------------------------------------------------------- shapes */

export interface AgreementView {
  id: string;
  cardId: string;
  wording: string;
  agreedAt: string;
  /** The contact who agreed, when a contact signed in as the customer. */
  agreedByContact: string | null;
  autopay: boolean;
  autopayAt: string | null;
  autopayWording: string | null;
}

const view = (row: typeof schema.paymentAgreement.$inferSelect, contactName: string | null = null): AgreementView => ({
  id: row.id,
  cardId: row.savedPaymentMethodId,
  wording: row.wording,
  agreedAt: row.agreedAt.toISOString(),
  agreedByContact: contactName,
  autopay: row.autopayAt !== null,
  autopayAt: row.autopayAt?.toISOString() ?? null,
  autopayWording: row.autopayWording,
});

/** The words a customer would agree to for this card, now. */
export interface CardWording { agreement: string; autopay: string }

function wordingFor(company: string, card: { kind: string; brand: string | null; last4: string | null }): CardWording {
  const input = {
    company,
    method: cp.methodLabel(card),
    kind: card.kind === "bank_account" ? "bank_account" as const : "card" as const,
  };
  return { agreement: cp.agreementWording(input), autopay: cp.autopayWording(input) };
}

/* --------------------------------------------------- the customer's side */

async function liveCard(tx: Database, session: PortalSession, cardId: string) {
  const [card] = await tx.select().from(schema.savedPaymentMethod)
    .where(and(
      eq(schema.savedPaymentMethod.id, cardId),
      eq(schema.savedPaymentMethod.customerId, session.customerId),
      isNull(schema.savedPaymentMethod.removedAt),
    )).limit(1);
  if (!card) throw new NotFoundError("Card");
  return card;
}

async function liveAgreement(tx: Database, cardId: string) {
  const [row] = await tx.select().from(schema.paymentAgreement)
    .where(and(eq(schema.paymentAgreement.savedPaymentMethodId, cardId), isNull(schema.paymentAgreement.withdrawnAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The agreements on these cards and the words each card would be agreed
 * under, for the signed in customer's list. Read inside the caller's grant.
 */
export async function forCardsWithin(
  tx: Database, organizationName: string,
  cards: readonly { id: string; kind: string; brand: string | null; last4: string | null }[],
): Promise<Map<string, { agreement: AgreementView | null; wording: CardWording }>> {
  const out = new Map<string, { agreement: AgreementView | null; wording: CardWording }>();
  if (cards.length === 0) return out;
  const rows = await tx.select({ agreement: schema.paymentAgreement, contactName: schema.contact.name })
    .from(schema.paymentAgreement)
    .leftJoin(schema.contact, eq(schema.contact.id, schema.paymentAgreement.contactId))
    .where(and(
      inArray(schema.paymentAgreement.savedPaymentMethodId, cards.map((c) => c.id)),
      isNull(schema.paymentAgreement.withdrawnAt),
    ));
  for (const card of cards) {
    const row = rows.find((r) => r.agreement.savedPaymentMethodId === card.id);
    out.set(card.id, {
      agreement: row ? view(row.agreement, row.contactName) : null,
      wording: wordingFor(organizationName, card),
    });
  }
  return out;
}

/**
 * The customer agrees to let the company charge this card, having read the
 * words they send back. Signed in only.
 *
 * The words are built again here from the company and the card and must be
 * the ones the customer saw: a page left open while the company changed its
 * name, or a request that sends other words, is refused rather than stored
 * as something the customer did not read. Agreeing to a card already agreed
 * returns the agreement that stands.
 */
export async function agree(
  db: Database, input: { token: string; cardId: string; wording: string }, meta?: RequestMeta,
): Promise<AgreementView> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx, ctx) => {
    const card = await liveCard(tx, session, input.cardId);
    const expected = wordingFor(session.organizationName, card).agreement;
    if (!cp.sameWording(input.wording, expected)) {
      throw new ConflictError("The words on this page have changed. Refresh it, read them again and agree if you still want to.");
    }
    const already = await liveAgreement(tx, card.id);
    if (already) return view(already, session.contact?.name ?? null);

    const inserted = await tx.insert(schema.paymentAgreement).values({
      organizationId: session.grant.organizationId,
      customerId: session.customerId,
      savedPaymentMethodId: card.id,
      wording: expected,
      agreedVia: "portal_sign_in",
      grantId: session.grant.grantId,
      contactId: session.contact?.id ?? null,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent?.slice(0, 500) ?? null,
    }).onConflictDoNothing().returning();
    const row = inserted[0] ?? await liveAgreement(tx, card.id);
    if (!row) throw new ConflictError("That could not be saved. Try again.");
    if (inserted[0]) {
      await audit(tx, ctx, "portal.card.agreement_given", "customer", session.customerId, null, {
        agreementId: row.id, cardId: card.id, wording: row.wording, ip: row.ip,
      });
    }
    return view(row, session.contact?.name ?? null);
  });
}

/**
 * Turn paying each bill automatically on or off, with this card. On needs
 * the card's agreement first and the autopay words the customer read; one
 * card pays automatically at a time, so turning it on for this one turns it
 * off on any other.
 */
export async function setAutopay(
  db: Database, input: { token: string; cardId: string; on: boolean; wording?: string | undefined },
): Promise<AgreementView> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx, ctx) => {
    const card = await liveCard(tx, session, input.cardId);
    const agreement = await liveAgreement(tx, card.id);
    if (!agreement) {
      throw new ConflictError("Agree to let the company charge this card first. Paying automatically needs that agreement.");
    }
    if (!input.on) {
      if (agreement.autopayAt === null) return view(agreement);
      const [after] = await tx.update(schema.paymentAgreement)
        .set({ autopayAt: null, autopayWording: null, autopayGrantId: null, updatedAt: new Date() })
        .where(eq(schema.paymentAgreement.id, agreement.id)).returning();
      await audit(tx, ctx, "portal.card.autopay_off", "customer", session.customerId,
        { autopayAt: agreement.autopayAt, autopayWording: agreement.autopayWording }, { agreementId: agreement.id });
      return view(after!);
    }
    const expected = wordingFor(session.organizationName, card).autopay;
    if (!cp.sameWording(input.wording ?? "", expected)) {
      throw new ConflictError("The words on this page have changed. Refresh it, read them again and turn it on if you still want to.");
    }
    if (agreement.autopayAt !== null) return view(agreement);

    const others = await tx.update(schema.paymentAgreement)
      .set({ autopayAt: null, autopayWording: null, autopayGrantId: null, updatedAt: new Date() })
      .where(and(
        eq(schema.paymentAgreement.customerId, session.customerId),
        isNull(schema.paymentAgreement.withdrawnAt),
        sql`${schema.paymentAgreement.autopayAt} is not null`,
      )).returning({ id: schema.paymentAgreement.id });
    const [after] = await tx.update(schema.paymentAgreement)
      .set({ autopayAt: new Date(), autopayWording: expected, autopayGrantId: session.grant.grantId, updatedAt: new Date() })
      .where(eq(schema.paymentAgreement.id, agreement.id)).returning();
    await audit(tx, ctx, "portal.card.autopay_on", "customer", session.customerId, null, {
      agreementId: agreement.id, cardId: card.id, wording: expected, turnedOffOn: others.map((o) => o.id),
    });
    return view(after!);
  });
}

/** Withdraw the agreement: nothing further is charged to this card without the customer pressing Pay. */
export async function withdraw(
  db: Database, input: { token: string; cardId: string },
): Promise<{ ok: true }> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx, ctx) => {
    const [card] = await tx.select({ id: schema.savedPaymentMethod.id }).from(schema.savedPaymentMethod)
      .where(and(
        eq(schema.savedPaymentMethod.id, input.cardId),
        eq(schema.savedPaymentMethod.customerId, session.customerId),
      )).limit(1);
    if (!card) throw new NotFoundError("Card");
    await withdrawWithin(tx, ctx, { customerId: session.customerId, cardId: card.id, reason: "customer", grantId: session.grant.grantId });
    return { ok: true as const };
  });
}

/**
 * End the live agreement on a card, if there is one, inside the caller's
 * transaction: the customer withdrawing it, or the card being taken off.
 * Locked first, so a charge being checked at the same moment either sees
 * it withdrawn or finishes before it is.
 */
export async function withdrawWithin(
  tx: Database, ctx: ServiceContext,
  input: { customerId: string; cardId: string; reason: "customer" | "card_removed"; grantId: string | null },
): Promise<boolean> {
  const [row] = await tx.select().from(schema.paymentAgreement)
    .where(and(
      eq(schema.paymentAgreement.savedPaymentMethodId, input.cardId),
      eq(schema.paymentAgreement.customerId, input.customerId),
      isNull(schema.paymentAgreement.withdrawnAt),
    )).limit(1).for("update");
  if (!row) return false;
  await tx.update(schema.paymentAgreement).set({
    withdrawnAt: new Date(), withdrawnReason: input.reason, withdrawnGrantId: input.grantId,
    autopayAt: null, autopayWording: null, autopayGrantId: null, updatedAt: new Date(),
  }).where(eq(schema.paymentAgreement.id, row.id));
  await audit(tx, ctx, "portal.card.agreement_withdrawn", "customer", input.customerId,
    { agreementId: row.id, autopay: row.autopayAt !== null }, { reason: input.reason });
  return true;
}

/* ------------------------------------------------------ the office's side */

export interface CardOnFile {
  agreementId: string;
  cardId: string;
  kind: "card" | "bank_account";
  label: string;
  agreedAt: string;
  agreedByContact: string | null;
  autopay: boolean;
}

export interface ChargeView {
  id: string;
  trigger: "office" | "autopay";
  attempt: number;
  status: string;
  amount: string | null;
  card: string;
  requestedBy: string | null;
  failureReason: string | null;
  retryAt: string | null;
  customerTold: string | null;
  customerToldNote: string | null;
  createdAt: string;
}

/** The invoice as a charge needs it: open, owed, and whose card it is. Inside the actor's own invoice scope. */
async function chargeableInvoice(tx: Database, ctx: ServiceContext, invoiceId: string) {
  const [invoice] = await tx.select({
    id: schema.invoice.id, number: schema.invoice.number, status: schema.invoice.status,
    balance: schema.invoice.balance, currency: schema.invoice.currency,
    customerId: schema.invoice.customerId, payerCustomerId: schema.invoice.payerCustomerId,
  }).from(schema.invoice)
    .where(and(
      eq(schema.invoice.id, invoiceId),
      isNull(schema.invoice.deletedAt),
      invoiceScopeFilter(scopeOf(ctx, "invoice"), ctx.actor),
    )).limit(1);
  if (!invoice) throw new NotFoundError("Invoice");
  return { ...invoice, payer: invoice.payerCustomerId ?? invoice.customerId };
}

async function cardsOnFileWithin(tx: Database, customerId: string): Promise<CardOnFile[]> {
  const rows = await tx.select({ agreement: schema.paymentAgreement, card: schema.savedPaymentMethod, contactName: schema.contact.name })
    .from(schema.paymentAgreement)
    .innerJoin(schema.savedPaymentMethod, eq(schema.savedPaymentMethod.id, schema.paymentAgreement.savedPaymentMethodId))
    .leftJoin(schema.contact, eq(schema.contact.id, schema.paymentAgreement.contactId))
    .where(and(
      eq(schema.paymentAgreement.customerId, customerId),
      isNull(schema.paymentAgreement.withdrawnAt),
      isNull(schema.savedPaymentMethod.removedAt),
    ))
    .orderBy(desc(schema.paymentAgreement.agreedAt));
  return rows.map(({ agreement, card, contactName }) => ({
    agreementId: agreement.id,
    cardId: card.id,
    kind: card.kind === "bank_account" ? "bank_account" as const : "card" as const,
    label: cp.methodLabel(card),
    agreedAt: agreement.agreedAt.toISOString(),
    agreedByContact: contactName,
    autopay: agreement.autopayAt !== null,
  }));
}

async function chargesWithin(tx: Database, invoiceId: string): Promise<ChargeView[]> {
  const rows = await tx.select({
    charge: schema.cardOnFileCharge, card: schema.savedPaymentMethod,
    /** Written out, because a select list strips the table from an interpolated column. */
    by: sql<string | null>`coalesce("user"."name", "user"."email")`,
    settled: schema.integrationEvent.status, error: schema.integrationEvent.error,
  })
    .from(schema.cardOnFileCharge)
    .innerJoin(schema.savedPaymentMethod, eq(schema.savedPaymentMethod.id, schema.cardOnFileCharge.savedPaymentMethodId))
    .leftJoin(schema.user, eq(schema.user.id, schema.cardOnFileCharge.requestedByUserId))
    .leftJoin(schema.integrationEvent, eq(schema.integrationEvent.id, schema.cardOnFileCharge.attemptEventId))
    .where(eq(schema.cardOnFileCharge.invoiceId, invoiceId))
    .orderBy(desc(schema.cardOnFileCharge.createdAt))
    .limit(20);
  /**
   * A charge the processor took reads as what became of it since, straight
   * from its payment attempt, so the screen does not wait on the worker to
   * say a webhook arrived.
   */
  const now = (charge: typeof schema.cardOnFileCharge.$inferSelect, settled: string | null) =>
    charge.status !== "submitted" ? charge.status
      : settled === "succeeded" ? "paid" : settled === "failed" ? "failed" : "submitted";
  return rows.map(({ charge, card, by, settled, error }) => ({
    id: charge.id,
    trigger: charge.trigger === "autopay" ? "autopay" as const : "office" as const,
    attempt: charge.attempt,
    status: now(charge, settled),
    amount: charge.amount,
    card: cp.methodLabel(card),
    requestedBy: by ?? null,
    failureReason: charge.failureReason ?? (now(charge, settled) === "failed" ? error : null),
    retryAt: charge.retryAt?.toISOString() ?? null,
    customerTold: charge.customerTold,
    customerToldNote: charge.customerToldNote,
    createdAt: charge.createdAt.toISOString(),
  }));
}

/**
 * What the office sees on an invoice: the cards its payer agreed may be
 * charged, and every charge of one on this invoice, by whom and what became
 * of it.
 */
export async function forInvoice(ctx: ServiceContext, input: { invoiceId: string }) {
  return guardedRead(ctx, "payment:read", async (tx) => {
    const invoice = await chargeableInvoice(tx, ctx, input.invoiceId);
    return { cards: await cardsOnFileWithin(tx, invoice.payer), charges: await chargesWithin(tx, invoice.id) };
  });
}

/** The cards one customer agreed may be charged, for their page. */
export async function forCustomer(ctx: ServiceContext, input: { customerId: string }) {
  return guardedRead(ctx, "payment:read", async (tx) => ({ cards: await cardsOnFileWithin(tx, input.customerId) }));
}

export interface ChargeResult {
  chargeId: string;
  /** `submitted`, `failed`, `needs_customer` or `cancelled`: what the office is told. */
  status: string;
  /** In words, for the person who pressed Charge. */
  message: string;
}

/**
 * The office charges a card the invoice's payer agreed may be charged.
 *
 * `payment:charge_saved`, which a technician does not hold, and
 * `payment:collect`, because it takes a payment. Only a card of the person
 * paying this invoice, only with a live agreement, only what the invoice
 * owes. The person is named on the charge and in the audit log. A double
 * press with the same request key is the same charge.
 */
export async function charge(
  ctx: ServiceContext, input: { invoiceId: string; cardId: string }, deps?: payments.PaymentDeps,
): Promise<ChargeResult> {
  const row = await guardedWrite(ctx, "payment:charge_saved", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select().from(schema.cardOnFileCharge)
        .where(eq(schema.cardOnFileCharge.idempotencyKey, ctx.idempotencyKey)).limit(1);
      if (seen) return { row: seen, replay: true };
    }
    const invoice = await chargeableInvoice(tx, ctx, input.invoiceId);
    if ((invoice.status !== "open" && invoice.status !== "partially_paid")
      || !m.isPositive(m.money(invoice.balance, invoice.currency))) {
      throw new ConflictError(`Invoice ${invoice.number} has nothing outstanding to charge.`);
    }
    const [card] = await tx.select({ id: schema.savedPaymentMethod.id }).from(schema.savedPaymentMethod)
      .where(and(
        eq(schema.savedPaymentMethod.id, input.cardId),
        eq(schema.savedPaymentMethod.customerId, invoice.payer),
        isNull(schema.savedPaymentMethod.removedAt),
      )).limit(1);
    if (!card) throw new NotFoundError("Saved card");
    /**
     * Not while another charge of this invoice is with the processor. The
     * invoice still shows the balance until the webhook says the money
     * moved, and a second press in that minute would be a second charge.
     */
    const [waiting] = await tx.select({ id: schema.cardOnFileCharge.id }).from(schema.cardOnFileCharge)
      .leftJoin(schema.integrationEvent, eq(schema.integrationEvent.id, schema.cardOnFileCharge.attemptEventId))
      .where(and(
        eq(schema.cardOnFileCharge.invoiceId, invoice.id),
        or(
          eq(schema.cardOnFileCharge.status, "charging"),
          and(
            eq(schema.cardOnFileCharge.status, "submitted"),
            inArray(schema.integrationEvent.status, ["pending", "in_flight"]),
          ),
        ),
      )).limit(1);
    if (waiting) {
      throw new ConflictError(
        `A charge for invoice ${invoice.number} is already with the card processor. `
        + "It shows as paid when the processor confirms it; refresh the page in a minute.",
      );
    }
    const agreement = await liveAgreement(tx, card.id);
    if (!agreement || agreement.customerId !== invoice.payer) {
      throw new ConflictError(
        "This customer has not agreed to let you charge that card, or has withdrawn it. "
        + "Send them the invoice to pay, or ask them to agree from their account.",
      );
    }
    const [created] = await tx.insert(schema.cardOnFileCharge).values({
      organizationId: ctx.actor.organizationId,
      invoiceId: invoice.id,
      customerId: invoice.payer,
      agreementId: agreement.id,
      savedPaymentMethodId: card.id,
      trigger: "office",
      requestedByUserId: isPerson(ctx.actor) ? ctx.actor.userId : null,
      amount: invoice.balance,
      idempotencyKey: ctx.idempotencyKey ?? null,
    }).returning();
    return { row: created!, replay: false };
  });
  if (row.replay) return resultOf(row.row);
  try {
    return await attempt(ctx, row.row, deps);
  } catch (error) {
    /**
     * Something other than the processor's answer went wrong. The person
     * who pressed Charge is told, and the row says so rather than sitting
     * as `charging` for a worker to pick up: an office charge is never
     * tried again by itself.
     */
    await inTenant(ctx, (tx) => tx.update(schema.cardOnFileCharge).set({
      status: "failed", failureReason: "It could not be charged. Nothing was taken. Try again in a moment.",
      updatedAt: new Date(),
    }).where(and(eq(schema.cardOnFileCharge.id, row.row.id), eq(schema.cardOnFileCharge.status, "charging"))));
    throw error;
  }
}

const isPerson = (actor: Actor) => actor.userId !== SYSTEM_USER_ID && !actor.userId.startsWith("portal:");

function resultOf(row: typeof schema.cardOnFileCharge.$inferSelect): ChargeResult {
  const message = row.status === "submitted" || row.status === "paid"
    ? "The charge went to the card processor. The invoice shows paid when the processor confirms the money moved."
    : row.status === "needs_customer"
      ? `Their bank wants them to confirm this payment themselves. ${toldText(row)}`
      : row.status === "cancelled"
        ? row.failureReason ?? "There was nothing to charge."
        : `It did not go through: ${row.failureReason ?? "the card was declined."}`;
  return { chargeId: row.id, status: row.status, message };
}

const toldText = (row: { customerTold: string | null; customerToldNote: string | null }) =>
  row.customerTold === "email" ? "We emailed them the link to pay."
    : row.customerTold === "text" ? "We texted them the link to pay."
      : `We could not send them the link${row.customerToldNote ? `: ${row.customerToldNote}` : "."} Send them the invoice.`;

/* ------------------------------------------------------- one try, shared */

/**
 * Ask the processor for one charge on file, and record what it said. The
 * office's charge and the worker's both come here.
 *
 * The charge row's id is the processor's idempotency key, so asking again
 * for a row a worker abandoned gets the same charge. A refusal by the
 * processor is recorded with its reason; a bank that wants the customer to
 * confirm it sends the customer their link; an automatic payment that fails
 * sends the link and raises an office task, and is tried once more the next
 * day when that could help.
 */
async function attempt(
  ctx: ServiceContext, row: typeof schema.cardOnFileCharge.$inferSelect, deps?: payments.PaymentDeps,
): Promise<ChargeResult> {
  const now = new Date();
  const [invoice] = await inTenant(ctx, (tx) => tx.select({ number: schema.invoice.number })
    .from(schema.invoice).where(eq(schema.invoice.id, row.invoiceId)).limit(1));
  const number = invoice?.number ?? 0;
  /**
   * A worker that died after the processor took the charge and before this
   * row said so left the attempt behind it. That attempt is the charge:
   * adopted, never asked for again.
   */
  const [prior] = await inTenant(ctx, (tx) => tx.select().from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.direction, "outbound"),
      eq(schema.integrationEvent.eventType, "payment.intent"),
      eq(schema.integrationEvent.idempotencyKey, `card-on-file:${row.id}`),
      sql`${schema.integrationEvent.responsePayload}->>'intentId' is not null`,
    )).limit(1));
  if (prior) {
    const [after] = await inTenant(ctx, (tx) => tx.update(schema.cardOnFileCharge).set({
      status: "submitted", attemptEventId: prior.id,
      intentId: (prior.responsePayload as { intentId?: string } | null)?.intentId ?? null, updatedAt: new Date(),
    }).where(eq(schema.cardOnFileCharge.id, row.id)).returning());
    return resultOf(after!);
  }
  try {
    const started = await payments.intent(
      { ...ctx, idempotencyKey: `card-on-file:${row.id}` },
      {
        customerId: row.customerId,
        invoiceIds: [row.invoiceId],
        description: `Invoice ${number}`,
        savedCardId: row.savedPaymentMethodId,
        offSession: { agreementId: row.agreementId },
        processorKey: row.id,
      },
      deps,
    );
    /**
     * Off session, a bank asking for the cardholder comes back as an error
     * rather than a status. Should a processor answer with a status that
     * wants the customer anyway, it is treated the same way.
     */
    if (started.status === "requires_action" || started.status === "requires_payment_method") {
      return failedWith(ctx, row, number, { code: cp.NEEDS_CUSTOMER, reason: "Their bank wants them to confirm it." }, now);
    }
    const [after] = await inTenant(ctx, (tx) => tx.update(schema.cardOnFileCharge).set({
      status: "submitted", amount: started.amount, attemptEventId: started.attemptId, intentId: started.intentId,
      updatedAt: new Date(),
    }).where(eq(schema.cardOnFileCharge.id, row.id)).returning());
    await inTenant(ctx, (tx) => audit(tx, ctx, "payment.charged_on_file", "invoice", row.invoiceId, null, {
      chargeId: row.id, trigger: row.trigger, attempt: row.attempt, agreementId: row.agreementId,
      cardId: row.savedPaymentMethodId, amount: started.amount, intentId: started.intentId, status: started.status,
    }));
    return resultOf(after!);
  } catch (error) {
    if (error instanceof payments.ChargeDeclinedError) {
      return failedWith(ctx, row, number, { code: error.code, reason: error.message }, now);
    }
    if (error instanceof ConflictError) {
      /**
       * Nothing to charge any more, or no longer allowed to: paid another
       * way, a bank payment already on its way, the agreement withdrawn.
       * Recorded and left; nobody needs a link or a task for a bill that is
       * being paid or a card they may no longer charge.
       */
      const [after] = await inTenant(ctx, (tx) => tx.update(schema.cardOnFileCharge).set({
        status: "cancelled", failureReason: error.message, retryAt: null, updatedAt: new Date(),
      }).where(eq(schema.cardOnFileCharge.id, row.id)).returning());
      if (row.trigger === "office") throw error;
      return resultOf(after!);
    }
    throw error;
  }
}

async function failedWith(
  ctx: ServiceContext, row: typeof schema.cardOnFileCharge.$inferSelect, number: number,
  failure: { code: string | null; reason: string }, now: Date,
): Promise<ChargeResult> {
  const kind = cp.failureKind(failure.code);
  const trigger = row.trigger === "autopay" ? "autopay" as const : "office" as const;
  const retry = cp.retryAt({ trigger, attempt: row.attempt, code: failure.code, now });
  const [card] = await inTenant(ctx, (tx) => tx.select().from(schema.savedPaymentMethod)
    .where(eq(schema.savedPaymentMethod.id, row.savedPaymentMethodId)).limit(1));
  const method = card ? cp.methodLabel(card) : "saved card";

  /**
   * The customer gets the link when only they can finish it, and whenever
   * an automatic payment fails. A decline from the office is the office's
   * to handle: the person who pressed Charge is looking at the answer.
   */
  const tellCustomer = kind === "needs_customer" || trigger === "autopay";
  const told = tellCustomer
    ? await sendPayLink(ctx, {
      invoiceId: row.invoiceId, customerId: row.customerId,
      note: cp.payLinkNote({ kind, method, retrying: retry !== null }),
    })
    : null;

  const taskId = trigger === "autopay"
    ? await inTenant(ctx, async (tx) => {
      const [customer] = await tx.select({ name: schema.customer.name })
        .from(schema.customer).where(eq(schema.customer.id, row.customerId)).limit(1);
      const amount = row.amount ? m.format(m.money(row.amount, "USD")) : "the balance";
      const [task] = await tx.insert(schema.task).values({
        organizationId: ctx.actor.organizationId,
        title: `${customer?.name ?? "A customer"}'s automatic payment of ${amount} for invoice #${number} did not go through`,
        body: `${method}: ${kind === "needs_customer" ? "their bank wants them to confirm the payment themselves." : failure.reason} `
          + (told?.told === "email" ? "They were emailed the link to pay. "
            : told?.told === "text" ? "They were texted the link to pay. "
              : `The link to pay could not be sent${told?.note ? ` (${told.note})` : ""}; send them the invoice. `)
          + (retry ? "It will be tried once more tomorrow. " : "It will not be tried again. ")
          + "Ask them for another way to pay if it is still owed.",
        priority: "high",
        entityType: "invoice",
        entityId: row.invoiceId,
        queue: "office",
      }).returning({ id: schema.task.id });
      return task!.id;
    })
    : null;

  const [after] = await inTenant(ctx, async (tx) => {
    const updated = await tx.update(schema.cardOnFileCharge).set({
      status: kind === "needs_customer" ? "needs_customer" : "failed",
      failureCode: failure.code,
      failureReason: kind === "needs_customer" ? "Their bank wants them to confirm the payment themselves." : failure.reason,
      retryAt: retry,
      customerTold: told?.told ?? null,
      customerToldNote: told?.note ?? null,
      taskId,
      updatedAt: new Date(),
    }).where(eq(schema.cardOnFileCharge.id, row.id)).returning();
    await audit(tx, ctx, "payment.charge_on_file_failed", "invoice", row.invoiceId, null, {
      chargeId: row.id, trigger, attempt: row.attempt, code: failure.code, reason: failure.reason,
      customerTold: told?.told ?? null, retryAt: retry?.toISOString() ?? null,
    });
    return updated;
  });
  return resultOf(after!);
}

/* ------------------------------------------------ telling the customer */

/**
 * Send the customer the link to pay this invoice themselves, with a line
 * saying why: by email when there is an address, through the same send the
 * invoice itself goes by (so it is a delivery on the invoice and passes the
 * email consent gate), and by text otherwise, through the consent gate every
 * text goes through and never in quiet hours. Never thrown: what happened is
 * the answer, and the office task says it.
 */
async function sendPayLink(
  ctx: ServiceContext, input: { invoiceId: string; customerId: string; note: string },
): Promise<{ told: "email" | "text" | "not_sent"; note: string | null }> {
  /**
   * Sending the link is part of the charge, so it goes with the transport
   * permissions added to whoever is charging, as an invoice send adds the
   * mail permission. A permission somebody had taken away still wins.
   */
  const { idempotencyKey: _key, ...rest } = ctx;
  const sender: ServiceContext = {
    ...rest,
    actor: { ...ctx.actor, grants: [...(ctx.actor.grants ?? []), "invoice:send", "message:send"] as Permission[] },
  };
  const contacts = await inTenant(ctx, async (tx) => {
    const [row] = await tx.select({ email: schema.customer.email, phone: schema.customer.phone })
      .from(schema.customer).where(eq(schema.customer.id, input.customerId)).limit(1);
    return row ?? { email: null, phone: null };
  });
  let emailRefusal: string | null = null;
  if (contacts.email) {
    try {
      const sent = await invoiceDelivery.send(sender, { invoiceId: input.invoiceId, channel: "email", resend: true, note: input.note });
      if (!sent.reason) return { told: "email", note: null };
      emailRefusal = sent.explanation ?? sent.reason;
    } catch (error) {
      emailRefusal = error instanceof Error ? error.message : "The email could not be sent.";
    }
  }
  if (contacts.phone) {
    try {
      const quiet = await inTenant(ctx, (tx) => quietHoursFor(tx, ctx.actor.organizationId, new Date()));
      if (quiet.window && comms.inQuietHours(quiet.localHour, quiet.window)) {
        return { told: "not_sent", note: emailRefusal ?? "It is inside your quiet hours, so no text went." };
      }
      const link = await invoiceDelivery.send(sender, { invoiceId: input.invoiceId, channel: "portal_link", resend: true });
      const sent = await inTenant(ctx, (tx) => sendTransactional(tx, {
        organizationId: ctx.actor.organizationId, address: contacts.phone!,
        body: `${input.note}\n\n${link.portalUrl}`, customerId: input.customerId,
        sentByUserId: isPerson(ctx.actor) ? ctx.actor.userId : null,
      }));
      if (sent.sent) return { told: "text", note: null };
      return { told: "not_sent", note: emailRefusal ?? sent.explanation };
    } catch (error) {
      return { told: "not_sent", note: emailRefusal ?? (error instanceof Error ? error.message : "The text could not be sent.") };
    }
  }
  return { told: "not_sent", note: emailRefusal ?? "They have no email address or mobile number on file." };
}

/* ------------------------------------------------------------ the worker */

/** What the worker acts as: it charges cards on file and tells customers and the office about it. */
function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["invoice:read", "payment:read", "payment:collect", "payment:charge_saved"],
    agentId: "autopay",
  };
}

export interface AutopayResult {
  organizationId: string;
  charged: number;
  failed: number;
  settled: number;
  error: string | null;
}

/**
 * One company's pass: settle what the processor has answered since, try
 * again what a worker abandoned, take the one next day try that is due, and
 * charge each bill that is owed by a customer paying automatically and has
 * not been charged.
 */
export async function autopayFor(
  db: Database, organizationId: string,
  options: { now?: Date | undefined; deps?: payments.PaymentDeps | undefined } = {},
): Promise<AutopayResult> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  const now = options.now ?? new Date();
  const result: AutopayResult = { organizationId, charged: 0, failed: 0, settled: 0, error: null };
  const count = (outcome: ChargeResult) => {
    if (outcome.status === "submitted") result.charged += 1;
    else if (outcome.status === "failed" || outcome.status === "needs_customer") result.failed += 1;
  };

  /* What the processor has answered since a charge was taken. */
  result.settled += await reconcile(ctx);

  /* Abandoned by a worker that died between asking and hearing back: asked again with the same key. */
  const abandoned = await inTenant(ctx, (tx) => tx.select().from(schema.cardOnFileCharge)
    .where(and(
      eq(schema.cardOnFileCharge.trigger, "autopay"),
      eq(schema.cardOnFileCharge.status, "charging"),
      lte(schema.cardOnFileCharge.updatedAt, new Date(now.getTime() - cp.ABANDONED_AFTER_MS)),
    )).limit(20));
  for (const row of abandoned) count(await attempt(ctx, row, options.deps));

  /* The one next day try. Claimed by the unique index on the invoice and the try. */
  const due = await inTenant(ctx, (tx) => tx.select().from(schema.cardOnFileCharge)
    .where(and(
      eq(schema.cardOnFileCharge.trigger, "autopay"),
      eq(schema.cardOnFileCharge.status, "failed"),
      eq(schema.cardOnFileCharge.attempt, 1),
      lte(schema.cardOnFileCharge.retryAt, now),
    )).limit(20));
  for (const first of due) {
    const second = await inTenant(ctx, async (tx) => {
      await tx.update(schema.cardOnFileCharge).set({ retryAt: null, updatedAt: new Date() })
        .where(eq(schema.cardOnFileCharge.id, first.id));
      const live = await liveAgreement(tx, first.savedPaymentMethodId);
      if (!live || live.autopayAt === null) return null;
      const [row] = await tx.insert(schema.cardOnFileCharge).values({
        organizationId, invoiceId: first.invoiceId, customerId: first.customerId, agreementId: live.id,
        savedPaymentMethodId: first.savedPaymentMethodId, trigger: "autopay", attempt: 2, amount: first.amount,
      }).onConflictDoNothing().returning();
      return row ?? null;
    });
    if (second) count(await attempt(ctx, second, options.deps));
  }

  /* Bills owed by customers paying automatically, issued since they turned it on, not yet charged. */
  const owed = await inTenant(ctx, async (tx) => {
    const zone = await timezoneOf(tx, organizationId);
    return tx.execute<{ invoice_id: string; customer_id: string; agreement_id: string; card_id: string; balance: string }>(sql`
      select i.id as invoice_id, a.customer_id, a.id as agreement_id, a.saved_payment_method_id as card_id, i.balance
        from public.invoice i
        join public.payment_agreement a
          on a.customer_id = coalesce(i.payer_customer_id, i.customer_id)
         and a.withdrawn_at is null and a.autopay_at is not null
        join public.saved_payment_method s on s.id = a.saved_payment_method_id and s.removed_at is null
       where i.status in ('open', 'partially_paid')
         and i.balance > 0
         and i.deleted_at is null
         and i.issued_on is not null
         and i.issued_on >= (a.autopay_at at time zone ${zone})::date
         and coalesce(
               (select min(e.occurred_at) from public.domain_event e
                 where e.entity_type = 'invoice' and e.entity_id = i.id and e.name = 'invoice.issued'),
               i.created_at) >= a.autopay_at
         and not exists (
               select 1 from public.card_on_file_charge c
                where c.invoice_id = i.id
                  and ((c.trigger = 'autopay' and c.attempt = 1) or c.status in ('charging', 'submitted')))
       order by i.issued_on, i.number
       limit 20`);
  });
  for (const bill of owed) {
    const row = await inTenant(ctx, async (tx) => {
      const [created] = await tx.insert(schema.cardOnFileCharge).values({
        organizationId, invoiceId: bill.invoice_id, customerId: bill.customer_id, agreementId: bill.agreement_id,
        savedPaymentMethodId: bill.card_id, trigger: "autopay", attempt: 1, amount: bill.balance,
      }).onConflictDoNothing().returning();
      return created ?? null;
    });
    if (row) count(await attempt(ctx, row, options.deps));
  }
  return result;
}

/**
 * Charges the processor took, settled since: paid once the payment is on
 * the books, and failed when the processor later said no (a bank payment
 * returned days later). A failed one sends the customer the link, and an
 * automatic one raises the office's task unless the bank payment's own
 * failure already raised one.
 */
async function reconcile(ctx: ServiceContext): Promise<number> {
  const rows = await inTenant(ctx, (tx) => tx.select({ charge: schema.cardOnFileCharge, attempt: schema.integrationEvent })
    .from(schema.cardOnFileCharge)
    .innerJoin(schema.integrationEvent, eq(schema.integrationEvent.id, schema.cardOnFileCharge.attemptEventId))
    .where(and(
      eq(schema.cardOnFileCharge.status, "submitted"),
      or(eq(schema.integrationEvent.status, "succeeded"), eq(schema.integrationEvent.status, "failed")),
    ))
    .orderBy(asc(schema.cardOnFileCharge.createdAt))
    .limit(50));
  let settled = 0;
  for (const { charge: row, attempt: event } of rows) {
    if (event.status === "succeeded") {
      await inTenant(ctx, (tx) => tx.update(schema.cardOnFileCharge).set({ status: "paid", updatedAt: new Date() })
        .where(eq(schema.cardOnFileCharge.id, row.id)));
      settled += 1;
      continue;
    }
    const bank = (event.requestPayload as { method?: string } | null)?.method === "ach";
    const reason = event.error ?? "The payment did not go through.";
    const [card] = await inTenant(ctx, (tx) => tx.select().from(schema.savedPaymentMethod)
      .where(eq(schema.savedPaymentMethod.id, row.savedPaymentMethodId)).limit(1));
    const told = await sendPayLink(ctx, {
      invoiceId: row.invoiceId, customerId: row.customerId,
      note: cp.payLinkNote({ kind: "declined", method: card ? cp.methodLabel(card) : "saved card", retrying: false }),
    });
    await inTenant(ctx, async (tx) => {
      let taskId: string | null = null;
      if (row.trigger === "autopay" && !bank) {
        const [task] = await tx.insert(schema.task).values({
          organizationId: ctx.actor.organizationId,
          title: "An automatic card payment did not go through",
          body: `${reason} ${told.told === "not_sent" ? "The link to pay could not be sent; send them the invoice." : "They were sent the link to pay."}`,
          priority: "high", entityType: "invoice", entityId: row.invoiceId, queue: "office",
        }).returning({ id: schema.task.id });
        taskId = task!.id;
      }
      await tx.update(schema.cardOnFileCharge).set({
        status: "failed", failureReason: reason, customerTold: told.told, customerToldNote: told.note,
        ...(taskId ? { taskId } : {}), updatedAt: new Date(),
      }).where(eq(schema.cardOnFileCharge.id, row.id));
    });
    settled += 1;
  }
  return settled;
}

/** When this process last went round, so the worker's few second loop does not charge cards every few seconds. */
let lastPass: number | null = null;

/**
 * The worker's pass over every company with somebody paying automatically or
 * a charge to follow up. Once a minute at most per process; one company's
 * failure is recorded and the pass goes on.
 */
export async function autopayPass(
  db: Database,
  options: {
    now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean; deps?: payments.PaymentDeps;
  } = {},
): Promise<AutopayResult[]> {
  const at = (options.now ?? new Date()).getTime();
  if (!options.force && lastPass !== null && at - lastPass < 60_000 && at >= lastPass) return [];
  lastPass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.autopay_organizations(${options.limit ?? 200})`,
  );
  const results: AutopayResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push(await autopayFor(db, row.organization_id, {
        ...(options.now ? { now: options.now } : {}), ...(options.deps ? { deps: options.deps } : {}),
      }));
    } catch (error) {
      results.push({ organizationId: row.organization_id, charged: 0, failed: 0, settled: 0, error: (error as Error).message });
    }
  }
  return results;
}

export const handlers = {
  agreeToPortalCardCharges: (db: Database, input: { token: string; cardId: string; wording: string }, meta?: RequestMeta) =>
    agree(db, input, meta),
  setPortalCardAutopay: (db: Database, input: { token: string; cardId: string; on: boolean; wording?: string | undefined }) =>
    setAutopay(db, input),
  withdrawPortalCardAgreement: (db: Database, input: { token: string; cardId: string }) => withdraw(db, input),
  listInvoiceCardsOnFile: (ctx: ServiceContext, input: { id: string }) => forInvoice(ctx, { invoiceId: input.id }),
  chargeInvoiceCardOnFile: (ctx: ServiceContext, input: { id: string; cardId: string }) =>
    charge(ctx, { invoiceId: input.id, cardId: input.cardId }),
} as const;
