import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerPortal as cp, money as m, payExtras as px } from "@opentradesos/core";
import { guardedRead, type ServiceContext } from "./context";
import { settingsWithin } from "./portal-settings";
import { settingsWithin as payExtrasWithin } from "./pay-extras";

/**
 * TIPS
 *
 * A customer paying an invoice from the portal can add something for the
 * technicians who did the work, when the company has turned tipping on.
 *
 * WHAT A TIP IS ON THE BOOKS, decided once and stated here because it is the
 * part most software gets wrong. A tip is not revenue: it is money the
 * customer handed to the company to pass on. It arrives with the payment and
 * `ledger.postPayment` credits it to Tips payable (2250), a liability, beside
 * the receivable the rest of the payment clears. It leaves through payroll,
 * where `ledger.postTipPayout` debits that liability against cash. Nothing in
 * between touches revenue, sales tax or commission: a tip is not a sale, it
 * is not taxed as one, and a technician is not paid commission on their own
 * tip.
 *
 * WHO IT IS FOR. Everybody assigned to a visit on the invoice's job that was
 * not cancelled. Decided when the customer chooses the tip, so the page can
 * say whose it is, and carried through the processor to the moment the money
 * arrives, when the shares are written.
 *
 * HOW IT IS SHARED is the company's rule (`payroll:configure`, on Pay rules):
 * evenly to the cent, as it always was; by the hours each person was clocked
 * in on the job; or all to the lead on the job's visits. The rule in force
 * when the money arrives is the one used and is kept on each share, so a
 * change of rule applies to tips from then on and never re-splits one already
 * shared. A rule with nothing to go on (no hours recorded, no lead marked)
 * shares evenly and says so on the share.
 */

/** Everybody who came out for this invoice's work. Empty when nobody is recorded. */
export async function techniciansFor(tx: Database, invoiceId: string): Promise<{
  jobId: string | null;
  technicians: { id: string; displayName: string }[];
}> {
  const [invoice] = await tx.select({ jobId: schema.invoice.jobId })
    .from(schema.invoice).where(eq(schema.invoice.id, invoiceId)).limit(1);
  if (!invoice?.jobId) return { jobId: null, technicians: [] };

  const rows = await tx.selectDistinct({
    id: schema.technician.id,
    displayName: schema.technician.displayName,
  })
    .from(schema.visitAssignment)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(and(
      eq(schema.visit.jobId, invoice.jobId),
      ne(schema.visit.status, "cancelled"),
    ))
    .orderBy(asc(schema.technician.id));
  return { jobId: invoice.jobId, technicians: rows };
}

export interface TipOffer {
  /** False when the company does not take tips, or nobody is recorded on the job to give one to. */
  available: boolean;
  presets: { percent: number; amount: string }[];
  /** First names only: enough for "Your tip goes to Sam and Priya", and no more. */
  for: string[];
}

/**
 * What the pay control offers on one invoice.
 *
 * Not offered on an invoice with no job, or a job nobody was assigned to,
 * because a tip with nobody to receive it would sit as a liability owed to
 * nobody until somebody noticed.
 */
export async function offerFor(
  tx: Database, organizationId: string, invoiceId: string, balance: m.Money,
): Promise<TipOffer> {
  const settings = await settingsWithin(tx, organizationId);
  if (!settings.tipping.enabled || !m.isPositive(balance)) return { available: false, presets: [], for: [] };
  const { technicians } = await techniciansFor(tx, invoiceId);
  if (technicians.length === 0) return { available: false, presets: [], for: [] };
  return {
    available: true,
    presets: cp.tipChoices(balance, settings.tipping.presets)
      .map((c) => ({ percent: c.percent, amount: m.toString(c.amount) })),
    for: technicians.map((t) => t.displayName.trim().split(/\s+/)[0] ?? t.displayName),
  };
}

/**
 * What the company's rule needs to know about each person on a job: the
 * seconds they were clocked in on it, closed punches that are paid time, and
 * whether any of the job's visits that were not cancelled marks them lead.
 */
async function tipPeople(
  tx: Database, jobId: string | null, technicianIds: readonly string[],
): Promise<px.TipPerson[]> {
  const people = [...new Set(technicianIds)];
  if (people.length === 0) return [];
  if (jobId === null) return people.map((technicianId) => ({ technicianId, seconds: 0, isLead: false }));

  const worked = await tx.select({
    technicianId: schema.timeclockEntry.technicianId,
    minutes: sql<number>`coalesce(sum(${schema.timeclockEntry.minutes}), 0)::int`,
  }).from(schema.timeclockEntry)
    .where(and(
      eq(schema.timeclockEntry.jobId, jobId),
      isNotNull(schema.timeclockEntry.endedAt),
      ne(schema.timeclockEntry.kind, "unpaid_break"),
      inArray(schema.timeclockEntry.technicianId, people),
    ))
    .groupBy(schema.timeclockEntry.technicianId);
  const leads = await tx.selectDistinct({ technicianId: schema.visitAssignment.technicianId })
    .from(schema.visitAssignment)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
    .where(and(
      eq(schema.visit.jobId, jobId),
      ne(schema.visit.status, "cancelled"),
      eq(schema.visitAssignment.isLead, true),
      inArray(schema.visitAssignment.technicianId, people),
    ));
  const minutes = new Map(worked.map((r) => [r.technicianId, r.minutes]));
  const lead = new Set(leads.map((r) => r.technicianId));
  return people.map((technicianId) => ({
    technicianId, seconds: (minutes.get(technicianId) ?? 0) * 60, isLead: lead.has(technicianId),
  }));
}

/**
 * The shares, written once, when the money has arrived.
 *
 * Idempotent on the payment: the settlement path can be run twice for one
 * processor event (a retry after a failure part way), and the second run
 * finds the shares already there and writes nothing.
 */
export async function writeShares(tx: Database, input: {
  organizationId: string;
  paymentId: string;
  invoiceId: string | null;
  jobId: string | null;
  tip: m.Money;
  technicianIds: string[];
  occurredAt: Date;
}): Promise<number> {
  const existing = await tx.select({ id: schema.tipShare.id }).from(schema.tipShare)
    .where(eq(schema.tipShare.paymentId, input.paymentId)).limit(1);
  if (existing.length > 0) return 0;
  const rule = (await payExtrasWithin(tx, input.organizationId)).tipSplit;
  const split = px.splitTipByRule(rule, input.tip, await tipPeople(tx, input.jobId, input.technicianIds));
  if (split.shares.length === 0) return 0;
  await tx.insert(schema.tipShare).values(split.shares.map((share) => ({
    organizationId: input.organizationId,
    paymentId: input.paymentId,
    invoiceId: input.invoiceId,
    jobId: input.jobId,
    technicianId: share.technicianId,
    amount: m.toString(share.amount),
    currency: share.amount.currency,
    occurredAt: input.occurredAt,
    splitRule: split.rule,
    splitNote: split.note === "" ? null : split.note,
  })));
  return split.shares.length;
}

export interface InvoiceTip {
  paymentId: string;
  receivedAt: Date;
  amount: string;
  /** The company's rule the tip was shared by, which is "even" when the chosen one had nothing to go on. */
  splitRule: string;
  /** Said when the chosen rule could not be followed, empty otherwise. */
  splitNote: string;
  shares: { technicianId: string; technicianName: string; amount: string; paidAt: Date | null }[];
}

/** The tips that came with payments on one invoice, and who each is for. */
export async function forInvoiceWithin(tx: Database, invoiceId: string): Promise<InvoiceTip[]> {
  const rows = await tx.select({
    share: schema.tipShare,
    technicianName: schema.technician.displayName,
    receivedAt: schema.payment.receivedAt,
  })
    .from(schema.tipShare)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.tipShare.technicianId))
    .innerJoin(schema.payment, eq(schema.payment.id, schema.tipShare.paymentId))
    .where(eq(schema.tipShare.invoiceId, invoiceId))
    .orderBy(asc(schema.payment.receivedAt), asc(schema.technician.displayName));

  const byPayment = new Map<string, InvoiceTip & { total: m.Money }>();
  for (const row of rows) {
    const current = byPayment.get(row.share.paymentId) ?? {
      paymentId: row.share.paymentId, receivedAt: row.receivedAt, amount: "0", shares: [], total: m.zero("USD"),
      splitRule: row.share.splitRule, splitNote: row.share.splitNote ?? "",
    };
    current.total = m.add(current.total, m.money(row.share.amount, "USD"));
    current.amount = m.toString(current.total);
    current.shares.push({
      technicianId: row.share.technicianId,
      technicianName: row.technicianName,
      amount: row.share.amount,
      paidAt: row.share.paidAt,
    });
    byPayment.set(row.share.paymentId, current);
  }
  return [...byPayment.values()].map(({ total: _total, ...rest }) => rest);
}

export async function forInvoice(ctx: ServiceContext, input: { invoiceId: string }) {
  return guardedRead(ctx, "invoice:read", async (tx) => ({ tips: await forInvoiceWithin(tx, input.invoiceId) }));
}

/**
 * Everything still owed, per person, that arrived before an instant.
 *
 * Cumulative rather than windowed to one pay period, for the reason the
 * commission version gives: a tip that arrived in a fortnight nobody
 * declared a period for would otherwise never be paid by anything.
 */
export async function unpaidBefore(tx: Database, organizationId: string, until: Date) {
  const rows = await tx.select().from(schema.tipShare)
    .where(and(
      eq(schema.tipShare.organizationId, organizationId),
      isNull(schema.tipShare.paidAt),
    ))
    .orderBy(asc(schema.tipShare.technicianId), asc(schema.tipShare.occurredAt));
  const byPerson = new Map<string, { technicianId: string; amount: m.Money; ids: string[]; earliest: Date }>();
  for (const row of rows) {
    if (row.occurredAt >= until) continue;
    const current = byPerson.get(row.technicianId)
      ?? { technicianId: row.technicianId, amount: m.zero("USD"), ids: [], earliest: row.occurredAt };
    current.amount = m.add(current.amount, m.money(row.amount, "USD"));
    current.ids.push(row.id);
    if (row.occurredAt < current.earliest) current.earliest = row.occurredAt;
    byPerson.set(row.technicianId, current);
  }
  return [...byPerson.values()];
}

/** Mark shares paid, in the same transaction as the posting that paid them. */
export async function markPaid(tx: Database, ids: string[], paidAt: Date, periodId: string): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(schema.tipShare)
    .set({ paidAt, paidInPeriodId: periodId, updatedAt: new Date() })
    .where(inArray(schema.tipShare.id, ids));
}

export const handlers = {
  listInvoiceTips: (ctx: ServiceContext, input: { invoiceId: string }) => forInvoice(ctx, input),
} as const;
