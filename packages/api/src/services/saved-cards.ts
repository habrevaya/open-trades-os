import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m } from "@opentradesos/core";
import {
  audit, ConflictError, NotFoundError, type RequestMeta,
} from "./context";
import * as payments from "./payments";
import { inGrant } from "./portal";
import { sessionFor, type PortalSession } from "./portal-sign-in";
import { payerContext, processorConnected } from "./invoice-delivery";
import { settingsWithin as portalSettingsWithin } from "./portal-settings";

/**
 * A CUSTOMER'S SAVED CARDS, AND BANK ACCOUNTS
 *
 * A bank account is saved and paid with exactly as a card is, through the
 * processor's own setup flow, with two differences said where they bite: it
 * is offered only when the company has turned bank payments on, and paying
 * with one is pending for days (see `payments.failed` for when it fails).
 *
 * Saved, listed, removed and paid with, by the customer, from their own
 * signed in account and from nowhere else (see `saved_payment_method` for
 * why a link is not enough).
 *
 * THE CARD NEVER REACHES THIS SERVER. Saving is the processor's own setup
 * flow: this asks the processor to start one for the customer, the browser
 * collects the card in the processor's own element and confirms it there,
 * and the processor sends the customer back. What comes back is a setup id,
 * and the card it names is recorded only after the setup is READ FROM THE
 * PROCESSOR with the company's key and found to have succeeded, for the
 * processor customer this company made for this customer, from a setup this
 * customer's own session started. A browser saying "it worked" is a claim,
 * exactly as it is for a payment.
 *
 * PAYING WITH ONE STILL SETTLES ONLY FROM THE WEBHOOK. The charge is
 * confirmed on the spot because the customer pressed Pay, and the invoice
 * shows paid when the processor's signed webhook says the money moved, like
 * every other card payment in this product.
 */

const SETUP_EVENT = "card.setup";

export interface SavedCard {
  id: string;
  /** `card`, or `bank_account` for a bank account saved the same way. */
  kind: "card" | "bank_account";
  /** The card brand, or the bank's name for a bank account. */
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  savedAt: string;
}

const shape = (row: typeof schema.savedPaymentMethod.$inferSelect): SavedCard => ({
  id: row.id,
  kind: row.kind === "bank_account" ? "bank_account" : "card",
  brand: row.brand,
  last4: row.last4,
  expMonth: row.expMonth,
  expYear: row.expYear,
  savedAt: row.createdAt.toISOString(),
});

/**
 * The cards and bank accounts this customer has saved, newest first, and
 * whether they could save one of each now. A bank account only when the
 * company has turned bank payments on.
 */
export async function list(
  db: Database, input: { token: string },
): Promise<{ cards: SavedCard[]; canSave: boolean; canSaveBank: boolean }> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx) => {
    const rows = await tx.select().from(schema.savedPaymentMethod)
      .where(and(
        eq(schema.savedPaymentMethod.customerId, session.customerId),
        isNull(schema.savedPaymentMethod.removedAt),
      ))
      .orderBy(desc(schema.savedPaymentMethod.createdAt));
    const connected = await processorConnected(tx);
    const settings = await portalSettingsWithin(tx, session.grant.organizationId);
    return { cards: rows.map(shape), canSave: connected, canSaveBank: connected && settings.bankAccounts };
  });
}

/**
 * The processor's record of this customer, made the first time they save a
 * card and kept, one per customer per connection.
 *
 * The processor is asked with a key derived from the customer and the
 * connection, so two first saves racing each other are one customer at the
 * processor rather than two, and the insert here does nothing on the second.
 */
async function profileFor(
  tx: Database, session: PortalSession,
  connection: payments.Connection, vault: NonNullable<import("../payments/provider").PaymentProvider["cards"]>,
): Promise<{ id: string; externalRef: string }> {
  const existing = async () => {
    const [row] = await tx.select({ id: schema.paymentProfile.id, externalRef: schema.paymentProfile.externalRef })
      .from(schema.paymentProfile)
      .where(and(
        eq(schema.paymentProfile.connectionId, connection.id),
        eq(schema.paymentProfile.customerId, session.customerId),
      )).limit(1);
    return row ?? null;
  };
  const found = await existing();
  if (found) return found;

  const [customer] = await tx.select({ email: schema.customer.email, name: schema.customer.name })
    .from(schema.customer).where(eq(schema.customer.id, session.customerId)).limit(1);
  const made = await vault.createCustomer({
    idempotencyKey: `profile-${connection.id}-${session.customerId}`,
    ...(customer?.email ? { email: customer.email } : {}),
    ...(customer?.name ? { name: customer.name } : {}),
    metadata: { otos_customer: session.customerId, otos_organization: session.grant.organizationId },
  });
  if (!made.ok) throw new ConflictError(made.message);

  await tx.insert(schema.paymentProfile).values({
    organizationId: session.grant.organizationId,
    customerId: session.customerId,
    connectionId: connection.id,
    provider: connection.provider,
    externalRef: made.value.customerRef,
  }).onConflictDoNothing();
  const after = await existing();
  if (!after) throw new ConflictError("The card could not be set up. Try again in a moment.");
  return after;
}

export interface CardSetupStart {
  setupId: string;
  clientSecret: string;
  publishableKey: string | null;
}

/** Begin saving a card: what the processor's element needs to collect it in the browser. */
export async function startSave(
  db: Database, input: { token: string; kind?: "card" | "bank_account" | undefined },
  meta?: RequestMeta, deps?: payments.PaymentDeps,
): Promise<CardSetupStart> {
  const session = await sessionFor(db, input.token);
  const kind = input.kind ?? "card";
  return inGrant(db, session.grant, async (tx, ctx) => {
    if (kind === "bank_account" && !(await portalSettingsWithin(tx, session.grant.organizationId)).bankAccounts) {
      throw new ConflictError("This company does not take bank payments online. Save a card instead.");
    }
    const { connection, provider } = await payments.processorFor(tx, session.grant.organizationId, deps);
    if (!provider.cards) {
      throw new ConflictError("This company's card processor does not keep cards. Pay with a card each time instead.");
    }
    const profile = await profileFor(tx, session, connection, provider.cards);
    const started = await provider.cards.startSetup({
      customerRef: profile.externalRef,
      idempotencyKey: meta?.idempotencyKey ?? randomUUID(),
      kind,
      metadata: {
        otos_customer: session.customerId,
        otos_organization: session.grant.organizationId,
        otos_grant: session.grant.grantId,
      },
    });
    if (!started.ok) throw new ConflictError(started.message);

    /**
     * Written down so the confirmation can check that THIS customer started
     * THIS setup. Without it, a setup id from somebody else's browser could
     * be posted here, and the card it names would be read and recorded on
     * the wrong account.
     */
    await tx.insert(schema.integrationEvent).values({
      organizationId: session.grant.organizationId,
      direction: "outbound",
      provider: connection.provider,
      eventType: SETUP_EVENT,
      idempotencyKey: `setup-${started.value.setupId}`,
      status: "pending",
      entityType: "customer",
      entityId: session.customerId,
      requestPayload: { profileId: profile.id, connectionId: connection.id, kind },
      responsePayload: { setupId: started.value.setupId },
    });
    await audit(tx, ctx, "portal.card.setup_started", "customer", session.customerId, null, {
      setupId: started.value.setupId, kind,
    });
    return {
      setupId: started.value.setupId,
      clientSecret: started.value.clientSecret,
      publishableKey: provider.publishableKey,
    };
  });
}

/**
 * The processor sent the customer back: record the card, if the processor
 * says there is one.
 *
 * Safe to run twice for one setup, because the page the processor returns to
 * can be refreshed: the second run finds the card already recorded and
 * returns it.
 */
export async function confirmSave(
  db: Database, input: { token: string; setupId: string }, deps?: payments.PaymentDeps,
): Promise<SavedCard> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx, ctx) => {
    const [attempt] = await tx.select().from(schema.integrationEvent)
      .where(and(
        eq(schema.integrationEvent.eventType, SETUP_EVENT),
        eq(schema.integrationEvent.entityId, session.customerId),
        sql`${schema.integrationEvent.responsePayload}->>'setupId' = ${input.setupId}`,
      )).limit(1);
    if (!attempt) throw new NotFoundError("Card setup");
    const plan = attempt.requestPayload as { profileId?: string; connectionId?: string };

    const { connection, provider } = await payments.processorFor(tx, session.grant.organizationId, deps);
    if (!provider.cards || plan.connectionId !== connection.id || !plan.profileId) {
      throw new ConflictError("That card was being saved with a payment account this company no longer uses. Add it again.");
    }
    const [profile] = await tx.select().from(schema.paymentProfile)
      .where(and(
        eq(schema.paymentProfile.id, plan.profileId),
        eq(schema.paymentProfile.customerId, session.customerId),
      )).limit(1);
    if (!profile) throw new NotFoundError("Card setup");

    const read = await provider.cards.readSetup(input.setupId);
    if (!read.ok) throw new ConflictError(read.message);
    const setup = read.value;
    const bank = setup.bankAccount ?? null;
    const what = bank ? "bank account" : "card";
    if (setup.status !== "succeeded" || (!setup.card && !bank)) {
      throw new ConflictError(setup.status === "processing"
        ? `Your bank is still checking the ${what}. Refresh this page in a minute.`
        : `The ${what} was not saved. Nothing was charged. Try adding it again.`);
    }
    /** The processor's customer has to be the one made for this customer, or it is somebody else's card. */
    if (setup.customerRef !== profile.externalRef) throw new NotFoundError("Card setup");
    const ref = bank ? bank.ref : setup.card!.ref;

    await tx.insert(schema.savedPaymentMethod).values({
      organizationId: session.grant.organizationId,
      customerId: session.customerId,
      profileId: profile.id,
      provider: connection.provider,
      kind: bank ? "bank_account" : "card",
      externalRef: ref,
      brand: bank ? bank.bankName : setup.card!.brand,
      last4: bank ? bank.last4 : setup.card!.last4,
      expMonth: bank ? null : setup.card!.expMonth,
      expYear: bank ? null : setup.card!.expYear,
      savedByGrantId: session.grant.grantId,
    }).onConflictDoNothing();

    const [saved] = await tx.select().from(schema.savedPaymentMethod)
      .where(and(
        eq(schema.savedPaymentMethod.externalRef, ref),
        eq(schema.savedPaymentMethod.customerId, session.customerId),
        isNull(schema.savedPaymentMethod.removedAt),
      )).limit(1);
    if (!saved) throw new NotFoundError("Card");

    if (attempt.status !== "succeeded") {
      await tx.update(schema.integrationEvent).set({
        status: "succeeded", completedAt: new Date(), updatedAt: new Date(),
      }).where(eq(schema.integrationEvent.id, attempt.id));
      await audit(tx, ctx, "portal.card.saved", "customer", session.customerId, null, {
        cardId: saved.id, kind: saved.kind, brand: saved.brand, last4: saved.last4,
      });
    }
    return shape(saved);
  });
}

/**
 * Take a card off. The processor is told to forget it first, and the row is
 * marked only when it has: a card the customer removed here and the
 * processor still holds is a card they believe is gone.
 */
export async function remove(
  db: Database, input: { token: string; cardId: string }, meta?: RequestMeta, deps?: payments.PaymentDeps,
): Promise<{ ok: true }> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx, ctx) => {
    const [card] = await tx.select().from(schema.savedPaymentMethod)
      .where(and(
        eq(schema.savedPaymentMethod.id, input.cardId),
        eq(schema.savedPaymentMethod.customerId, session.customerId),
      )).limit(1);
    if (!card) throw new NotFoundError("Card");
    if (card.removedAt) return { ok: true as const };

    const { provider } = await payments.processorFor(tx, session.grant.organizationId, deps);
    if (provider.cards) {
      const detached = await provider.cards.detach(card.externalRef, meta?.idempotencyKey ?? `detach-${card.id}`);
      if (!detached.ok) throw new ConflictError(detached.message);
    }
    await tx.update(schema.savedPaymentMethod).set({ removedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.savedPaymentMethod.id, card.id));
    await audit(tx, ctx, "portal.card.removed", "customer", session.customerId, null, { cardId: card.id });
    return { ok: true as const };
  });
}

export interface SavedCardPayment {
  intentId: string;
  /**
   * `succeeded`, `processing`, or `requires_action` when the bank wants to
   * check it is them. A bank account always answers `processing`: the money
   * is on its way, and arrives in a few business days or fails.
   */
  status: string;
  clientSecret: string;
  publishableKey: string | null;
  amount: string;
  tip: string;
  currency: string;
}

/**
 * Pay one of this customer's invoices with a card they saved, and a tip if
 * they chose one.
 *
 * Only an invoice this customer is the one paying: their own, or one billed
 * to them as payer. A homeowner's card does not pay a warranty company's
 * share of their job, and a payer's card does not pay the homeowner's.
 */
export async function pay(
  db: Database,
  input: { token: string; invoiceId: string; cardId: string; tip?: string | undefined },
  meta?: RequestMeta,
  deps?: payments.PaymentDeps,
): Promise<SavedCardPayment> {
  const session = await sessionFor(db, input.token);
  const invoice = await inGrant(db, session.grant, async (tx) => {
    const [row] = await tx.select({
      id: schema.invoice.id,
      number: schema.invoice.number,
      status: schema.invoice.status,
      balance: schema.invoice.balance,
      currency: schema.invoice.currency,
      customerId: schema.invoice.customerId,
      payerCustomerId: schema.invoice.payerCustomerId,
    }).from(schema.invoice)
      .where(and(
        eq(schema.invoice.id, input.invoiceId),
        or(eq(schema.invoice.customerId, session.customerId), eq(schema.invoice.payerCustomerId, session.customerId)),
        isNull(schema.invoice.deletedAt),
      )).limit(1);
    if (!row || row.status === "draft") throw new NotFoundError("Invoice");
    return row;
  });
  if ((invoice.payerCustomerId ?? invoice.customerId) !== session.customerId) {
    throw new ConflictError(`Invoice ${invoice.number} is billed to somebody else. Pay it with a new card instead.`);
  }
  if ((invoice.status !== "open" && invoice.status !== "partially_paid")
    || !m.isPositive(m.money(invoice.balance, invoice.currency))) {
    throw new ConflictError(`Invoice ${invoice.number} has nothing outstanding. It may already have been paid.`);
  }

  const result = await payments.intent({
    ...payerContext(db, session.grant),
    ...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
  }, {
    customerId: session.customerId,
    invoiceIds: [invoice.id],
    description: `Invoice ${invoice.number}`,
    savedCardId: input.cardId,
    ...(input.tip !== undefined ? { tip: input.tip } : {}),
    acceptance: { ip: meta?.ip, userAgent: meta?.userAgent },
  }, deps);

  return {
    intentId: result.intentId,
    status: result.status,
    clientSecret: result.clientSecret,
    publishableKey: result.publishableKey,
    amount: result.amount,
    tip: result.tip,
    currency: result.currency,
  };
}

export const handlers = {
  listPortalCards: (db: Database, input: { token: string }) => list(db, input),
  startPortalCardSetup: (
    db: Database, input: { token: string; kind?: "card" | "bank_account" | undefined }, meta?: RequestMeta,
  ) => startSave(db, input, meta),
  confirmPortalCardSetup: (db: Database, input: { token: string; setupId: string }) => confirmSave(db, input),
  removePortalCard: (db: Database, input: { token: string; cardId: string }, meta?: RequestMeta) =>
    remove(db, input, meta),
} as const;
