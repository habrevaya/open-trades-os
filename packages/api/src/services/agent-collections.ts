import { and, eq, gt, inArray, isNull, lt, not, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { agents as a, assertCan, comms, time, work } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, scopeOf, ConflictError, type ServiceContext,
} from "./context";
import { invoiceScopeFilter } from "./scope";
import * as invoiceDelivery from "./invoice-delivery";
import * as payments from "./payments";
import { sendTransactional, quietHoursFor } from "./comms-send";
import * as base from "./agents";
import { companyOf } from "./agent-facts";
import type { AiDeps } from "./ai";

/**
 * THE COLLECTIONS AGENT
 *
 * An invoice three days late gets a friendly nudge, at fourteen a clearer one,
 * at thirty a firm one: the steps and how each should sound are the company's,
 * on the agent's settings. The agent writes each reminder in the company's
 * tone, holds it to the amount the invoice really owes (a reminder naming any
 * other amount is refused), and proposes it. A person sends it with one click,
 * or the company lets it send on its own.
 *
 * SENT THROUGH THE PATHS THAT ALREADY EXIST, AND ONLY THOSE. By email it is the
 * invoice itself, sent again with the reminder above the payment button, so it
 * is recorded as a delivery on the invoice and goes through the email consent
 * gate. By text it is the invoice's own payment link after the reminder, sent
 * through `sendTransactional`, which honours a STOP like every other text, and
 * never in quiet hours.
 *
 * One step per invoice at a time, never back to a softer one: `dueStep`.
 */

interface ReminderDraft {
  invoiceId: string;
  invoiceNumber: number;
  customerId: string;
  customerName: string;
  channel: "email" | "text";
  to: string;
  body: string;
  stepDays: number;
  amountOwed: string;
  daysOverdue: number;
}

/**
 * Draft the reminders that are due, for this company, now.
 *
 * Started by a person (the "check now" button) it runs as them; from the
 * worker it runs as the person on the settings, once a day at most per
 * invoice because a step is only ever taken once.
 */
export async function run(
  db: Database, organizationId: string,
  options: { startedBy?: ServiceContext | undefined; deps?: AiDeps | undefined; limit?: number | undefined } = {},
): Promise<{ drafted: number; sent: number; reason: string | null }> {
  const deps = options.deps ?? base.DEFAULT_AGENT_DEPS;
  const acting = await base.actingAs(db, organizationId, "collections", options.startedBy);
  if (!acting.ok) return { drafted: 0, sent: 0, reason: acting.reason };
  if (!acting.settings.enabled) return { drafted: 0, sent: 0, reason: "The collections agent is off." };
  const { ctx, settings } = acting;
  const now = (deps.now ?? (() => new Date()))();

  /** Reminders already proposed and waiting, when the company lets them go on their own: quiet hours may have held them. */
  let sent = 0;
  if (a.actsAlone("collections", settings)) {
    const waiting = await inTenant(ctx, (tx) => tx.select().from(schema.aiAgentProposal)
      .where(and(eq(schema.aiAgentProposal.agent, "collections"), eq(schema.aiAgentProposal.status, "proposed"))).limit(20));
    for (const row of waiting) {
      if (await trySend(ctx, row.id, true, now)) sent += 1;
    }
  }

  const due = await guardedRead(ctx, "invoice:read", async (tx) => {
    const company = await companyOf(tx, organizationId, now);
    const invoices = await tx.select({
      id: schema.invoice.id, number: schema.invoice.number, numberPrefix: schema.invoice.numberPrefix,
      dueOn: schema.invoice.dueOn,
      balance: schema.invoice.balance, customerId: schema.invoice.customerId,
      customerName: schema.customer.name, email: schema.customer.email, phone: schema.customer.phone,
    }).from(schema.invoice)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
      .where(and(
        inArray(schema.invoice.status, ["open", "partially_paid"]),
        gt(schema.invoice.balance, "0"),
        lt(schema.invoice.dueOn, company.today),
        isNull(schema.invoice.voidedAt),
        /** Paid by bank and not yet confirmed: not money to chase while the bank decides. */
        not(payments.bankPaymentOnItsWay),
        invoiceScopeFilter(scopeOf(ctx, "invoice"), ctx.actor),
      ))
      .orderBy(schema.invoice.dueOn)
      .limit(200);
    const out: { invoice: (typeof invoices)[number]; step: a.CollectionsStep; daysOverdue: number; reminders: number }[] = [];
    for (const invoice of invoices) {
      const earlier = await tx.select({ status: schema.aiAgentProposal.status, draft: schema.aiAgentProposal.draft })
        .from(schema.aiAgentProposal)
        .where(and(
          eq(schema.aiAgentProposal.agent, "collections"),
          eq(schema.aiAgentProposal.sourceKind, "invoice"),
          eq(schema.aiAgentProposal.sourceId, invoice.id),
        ));
      /** Waiting for a person already: nothing new until that one is sent or dismissed. */
      if (earlier.some((e) => e.status === "proposed")) continue;
      /** A dismissed step counts as taken: the office said no to it, and asking again tomorrow is nagging the office. */
      const taken = earlier.filter((e) => e.status === "applied" || e.status === "dismissed")
        .map((e) => Number(e.draft["stepDays"])).filter(Number.isFinite);
      const daysOverdue = Math.round((time.startOfDayIn(company.today, company.timezone).getTime()
        - time.startOfDayIn(invoice.dueOn!, company.timezone).getTime()) / 864e5);
      const step = a.dueStep(daysOverdue, settings.collections.steps, taken);
      if (step) out.push({ invoice, step, daysOverdue, reminders: earlier.filter((e) => e.status === "applied").length });
      if (out.length >= (options.limit ?? 10)) break;
    }
    return { company, out };
  });

  let drafted = 0;
  for (const { invoice, step, daysOverdue, reminders } of due.out) {
    const channel = step.channel === "text" && invoice.phone ? "text" : invoice.email ? "email" : invoice.phone ? "text" : null;
    if (!channel) {
      await inTenant(ctx, (tx) => base.note(tx, ctx, {
        agent: "collections", kind: "skipped",
        detail: `Invoice ${invoice.number} is ${daysOverdue} days overdue and the customer has no email or phone number on file.`,
      }));
      continue;
    }
    const amountOwed = invoice.balance.replace(/(\.\d{2})\d*$/, "$1");
    const prompt = a.collectionsPrompt({
      company: due.company, tone: settings.tone, stepTone: step.tone,
      facts: {
        /** The number the customer's invoice is printed with, so the reminder quotes what they hold. */
        customerName: invoice.customerName, invoiceNumber: work.documentNumber(invoice.numberPrefix, invoice.number), amountOwed,
        dueDate: invoice.dueOn!, daysOverdue, remindersSoFar: reminders, channel,
      },
    });
    const answer = await base.ask(acting, "collections", prompt, "collections:reminder", deps);
    if (!answer.ok) {
      if (answer.refusal === "limit" || answer.refusal === "model") break;
      continue;
    }
    const body = String(answer.input["body"]);
    /** The only amount a reminder may name is the one the invoice owes. */
    const wrong = a.unlistedPrices(body, [invoice.balance]);
    if (wrong.length > 0) {
      await inTenant(ctx, (tx) => base.note(tx, ctx, {
        agent: "collections", kind: "refused",
        detail: `A reminder for invoice ${invoice.number} named an amount the invoice does not owe. It was not kept.`,
      }));
      continue;
    }
    const draft: ReminderDraft = {
      invoiceId: invoice.id, invoiceNumber: invoice.number, customerId: invoice.customerId,
      customerName: invoice.customerName, channel,
      to: channel === "email" ? invoice.email! : invoice.phone!,
      body, stepDays: step.afterDays, amountOwed, daysOverdue,
    };
    const { row, created } = await inTenant(ctx, (tx) => base.propose(tx, acting, {
      agent: "collections", action: "draft_reminder", sourceKind: "invoice", sourceId: invoice.id,
      summary: `Invoice ${invoice.number}, ${daysOverdue} days overdue: a reminder to ${invoice.customerName} by ${channel}`,
      draft: draft as unknown as Record<string, unknown>, usageId: answer.usageId,
    }));
    if (created) drafted += 1;
    if (created && a.actsAlone("collections", settings) && await trySend(ctx, row.id, true, now)) sent += 1;
  }
  return { drafted, sent, reason: null };
}

/** Send, on its own; a refusal is recorded on the draft and leaves it for a person. */
async function trySend(ctx: ServiceContext, id: string, automatic: boolean, now: Date): Promise<boolean> {
  try {
    await send(ctx, { id }, { automatic, now });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "It could not be sent.";
    await inTenant(ctx, async (tx) => {
      const row = await base.proposalWithin(tx, "collections", id);
      await base.markFailed(tx, ctx, row, `Not sent on its own: ${reason} It is waiting for a person.`, automatic);
    });
    return false;
  }
}

/**
 * Send a reminder, as drafted or as a person edited it.
 *
 * `invoice:send` first: sending a reminder is sending the invoice again. A
 * text also needs `message:send`, asserted when the reminder is a text,
 * because texting a customer is its own permission in this product.
 */
export async function send(
  ctx: ServiceContext, input: { id: string; body?: string | undefined },
  options: { automatic?: boolean | undefined; now?: Date | undefined } = {},
) {
  const row = await guardedRead(ctx, "invoice:send", (tx) => base.proposalWithin(tx, "collections", input.id));
  if (row.status === "applied") return base.shape(row);
  if (row.status !== "proposed") throw new ConflictError(`This reminder was ${row.status}, so there is nothing to send.`);
  const draft = row.draft as unknown as ReminderDraft;
  /**
   * Asked again at the moment of sending, because a reminder drafted on
   * Monday can be sent on Wednesday, after the customer paid by bank.
   */
  const onItsWay = await guardedRead(ctx, "invoice:read", (tx) =>
    payments.pendingBankPayments(tx, { invoiceIds: [draft.invoiceId] }));
  if (onItsWay.length > 0) {
    throw new ConflictError(
      `A bank payment for invoice ${draft.invoiceNumber} is on its way, so no reminder goes. `
      + "If the bank turns it down, the invoice can be chased then.",
    );
  }
  const body = (input.body ?? draft.body).trim();
  if (body === "") throw new ConflictError("The reminder is empty.");
  if (body.length > 500) throw new ConflictError("Keep a reminder under 500 characters.");
  const automatic = options.automatic ?? false;

  let outcome: Record<string, unknown>;
  if (draft.channel === "email") {
    const result = await invoiceDelivery.send(ctx, {
      invoiceId: draft.invoiceId, channel: "email", to: draft.to, resend: true, note: body,
    });
    if (result.reason) throw new ConflictError(result.explanation ?? "The email could not be sent.");
    outcome = { deliveryId: result.deliveryId, messageId: result.messageId, channel: "email" };
  } else {
    assertCan(ctx.actor, "message:send");
    const quiet = await inTenant(ctx, (tx) => quietHoursFor(tx, ctx.actor.organizationId, options.now ?? new Date()));
    if (quiet.window && comms.inQuietHours(quiet.localHour, quiet.window)) {
      throw new ConflictError("It is inside your quiet hours, so no text goes now. Send it in the morning.");
    }
    const link = await invoiceDelivery.send(ctx, { invoiceId: draft.invoiceId, channel: "portal_link", resend: true });
    const sent = await guardedWrite(ctx, "message:send", (tx) => sendTransactional(tx, {
      organizationId: ctx.actor.organizationId, address: draft.to,
      body: `${body}\n\nPay here: ${link.portalUrl}`, customerId: draft.customerId,
      sentByUserId: automatic ? null : ctx.actor.userId,
    }));
    if (!sent.sent) throw new ConflictError(sent.explanation);
    outcome = { deliveryId: link.deliveryId, messageId: sent.messageId, channel: "text" };
  }

  return guardedWrite(ctx, "invoice:send", async (tx) => {
    if (input.body !== undefined && input.body.trim() !== draft.body) {
      await tx.update(schema.aiAgentProposal)
        .set({ draft: sql`${schema.aiAgentProposal.draft} || ${JSON.stringify({ body, edited: true })}::jsonb` })
        .where(eq(schema.aiAgentProposal.id, row.id));
    }
    const applied = await base.markApplied(tx, ctx, row, {
      automatic, outcome,
      detail: `Sent the ${draft.stepDays} day reminder for invoice ${draft.invoiceNumber} by ${draft.channel}${automatic ? " on its own" : ""}.`,
    });
    return base.shape(applied);
  });
}

/** "Check now", as the person pressing it. */
export async function runNow(ctx: ServiceContext, deps?: AiDeps) {
  assertCan(ctx.actor, "invoice:send");
  const outcome = await run(ctx.db, ctx.actor.organizationId, { startedBy: ctx, deps });
  if (outcome.reason) throw new ConflictError(outcome.reason);
  return { drafted: outcome.drafted, sent: outcome.sent };
}

export const handlers = {
  listCollectionReminders: (ctx: ServiceContext, input: {
    status?: ("proposed" | "applied" | "dismissed" | "failed" | "superseded")[] | undefined; limit?: number | undefined;
  }) => base.proposals(ctx, "invoice:read", "collections", input),
  runCollections: (ctx: ServiceContext) => runNow(ctx),
  sendCollectionReminder: (ctx: ServiceContext, input: { id: string; body?: string | undefined }) => send(ctx, input),
  dismissCollectionReminder: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    base.dismiss(ctx, "invoice:send", "collections", input),
} as const;
