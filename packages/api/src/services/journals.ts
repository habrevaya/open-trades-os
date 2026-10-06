import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m, time, SYSTEM_USER_ID } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, timezoneOf,
  ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { writePosting } from "./ledger";
import { nextNumber } from "./jobs";

/**
 * M14. MANUAL JOURNAL ENTRIES
 *
 * The ledger has said since it was written that there is no bare journal
 * entry surface, and why: an operator who can post freely can make the books
 * say anything with no document behind it. That was right as a default and it
 * left an accountant with no way to book the things that have no document in
 * this product: a month's depreciation, an accrual, the payroll the bureau
 * ran, the supplier bills for materials, a correction their year end review
 * found. Every one of those was done in QuickBooks and never reached the
 * ledger this product reports from, so the budget report and the trial
 * balance here disagreed with the books by exactly the accountant's work.
 *
 * So there is one, and the reasons for not having one are answered rather
 * than dropped:
 *
 *   A PERMISSION OF ITS OWN. `ledger:post`, which has waited in the catalogue
 *   for exactly this. The owner and the accountant hold it; the administrator
 *   preset deliberately does not.
 *
 *   BALANCED OR REFUSED, line by line, with the imbalance stated (core's
 *   `checkJournal`), and again by the ledger's own deferred trigger.
 *
 *   NOT INTO A CLOSED PERIOD, because `writePosting` refuses that for every
 *   posting, and NOT INTO THE FUTURE.
 *
 *   NOT INTO A CONTROL ACCOUNT. The receivable, deposits held, tips and
 *   commission owed and deferred revenue each follow a set of documents, and
 *   a journal to one makes it disagree with them. Core names the document to
 *   use instead.
 *
 *   REVERSED, NEVER EDITED. A mistake is undone by a reversing entry that
 *   points at the one it takes back, line for line, and an entry is reversed
 *   once.
 *
 *   AUDITED, every entry and every reversal, with who and when.
 *
 * And it reaches the accounting system like the documents do: the sync sends
 * each entry as a QuickBooks JournalEntry or a Xero manual journal once every
 * account on it is mapped (M14).
 */

export interface JournalView {
  id: string;
  number: number;
  occurredOn: string;
  memo: string;
  total: string;
  currency: string;
  reversesJournalId: string | null;
  reversesNumber: number | null;
  reversedByJournalId: string | null;
  reversedByNumber: number | null;
  createdByUserId: string | null;
  createdAt: string;
  lines: { entryId: string; accountCode: string; direction: "debit" | "credit"; amount: string; memo: string | null }[];
}

async function views(tx: Database, rows: (typeof schema.journalEntry.$inferSelect)[]): Promise<JournalView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const entries = await tx.select().from(schema.ledgerEntry)
    .where(and(eq(schema.ledgerEntry.sourceType, "journal"), inArray(schema.ledgerEntry.sourceId, ids)))
    .orderBy(asc(schema.ledgerEntry.createdAt), asc(schema.ledgerEntry.direction));
  const reversals = await tx.select({
    id: schema.journalEntry.id, number: schema.journalEntry.number, reverses: schema.journalEntry.reversesJournalId,
  }).from(schema.journalEntry).where(inArray(schema.journalEntry.reversesJournalId, ids));
  const originals = rows.map((r) => r.reversesJournalId).filter((x): x is string => !!x);
  const reversed = originals.length
    ? await tx.select({ id: schema.journalEntry.id, number: schema.journalEntry.number })
      .from(schema.journalEntry).where(inArray(schema.journalEntry.id, originals))
    : [];
  return rows.map((r) => {
    const by = reversals.find((x) => x.reverses === r.id);
    return {
      id: r.id,
      number: r.number,
      occurredOn: r.occurredOn,
      memo: r.memo,
      total: r.total,
      currency: r.currency,
      reversesJournalId: r.reversesJournalId,
      reversesNumber: r.reversesJournalId ? reversed.find((x) => x.id === r.reversesJournalId)?.number ?? null : null,
      reversedByJournalId: by?.id ?? null,
      reversedByNumber: by?.number ?? null,
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt.toISOString(),
      lines: entries.filter((e) => e.sourceId === r.id).map((e) => ({
        entryId: e.id, accountCode: e.accountCode, direction: e.direction, amount: e.amount, memo: e.memo,
      })),
    };
  });
}

/** A booking date: a calendar day, not in the future in the company's calendar. */
async function bookingDate(tx: Database, organizationId: string, date: string | undefined): Promise<{ date: string; at: Date }> {
  const tz = await timezoneOf(tx, organizationId);
  const today = time.dateIn(new Date(), tz);
  const day = date ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new UnprocessableError("Not a date", [{ path: "occurredOn", message: "The date is a calendar date." }]);
  }
  if (day > today) {
    throw new UnprocessableError("occurredOn is in the future", [{
      path: "occurredOn", message: `${day} has not happened yet. Book it on or before ${today}.`,
    }]);
  }
  /** Midnight at the start of the day, in the company's zone, so the entry falls in that day's month everywhere. */
  return { date: day, at: time.startOfDayIn(day, tz) };
}

/** Replay of the same request: the entry the first one made. */
async function replayed(tx: Database, ctx: ServiceContext, eventType: string) {
  if (!ctx.idempotencyKey) return null;
  const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId }).from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.provider, "api"),
      eq(schema.integrationEvent.eventType, eventType),
      eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
    )).limit(1);
  if (!seen?.entityId) return null;
  const [row] = await tx.select().from(schema.journalEntry).where(eq(schema.journalEntry.id, seen.entityId)).limit(1);
  return row ? (await views(tx, [row]))[0]! : null;
}

async function remember(tx: Database, ctx: ServiceContext, eventType: string, id: string) {
  if (!ctx.idempotencyKey) return;
  await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId, direction: "inbound", provider: "api", eventType,
    idempotencyKey: ctx.idempotencyKey, status: "succeeded", entityType: "journal_entry", entityId: id,
    completedAt: new Date(),
  });
}

const userOf = (ctx: ServiceContext) =>
  ctx.actor.userId === SYSTEM_USER_ID || ctx.actor.userId.includes(":") ? null : ctx.actor.userId;

/** Post a manual journal entry. */
export async function create(
  ctx: ServiceContext,
  input: { occurredOn?: string | undefined; memo: string; lines: ledger.JournalLineInput[] },
): Promise<JournalView> {
  return guardedWrite(ctx, "ledger:post", async (tx) => {
    const again = await replayed(tx, ctx, "journal.create");
    if (again) return again;

    const memo = input.memo.trim();
    if (memo === "") {
      throw new UnprocessableError("Say what it is for", [{
        path: "memo", message: "A journal says what it is for. It is the first thing an auditor reads.",
      }]);
    }
    const checked = ledger.checkJournal(input.lines);
    if (!checked.ok) {
      throw new UnprocessableError("The journal cannot be posted", checked.problems.map((p) => ({
        path: p.line === null ? "lines" : `lines.${p.line - 1}`,
        message: p.line === null ? p.message : `Line ${p.line}: ${p.message}`,
      })));
    }
    const { date, at } = await bookingDate(tx, ctx.actor.organizationId, input.occurredOn);

    const number = await nextNumber(tx, ctx.actor.organizationId, "journal_entry");
    /**
     * The posting first, under an id chosen here, so the header is written
     * once with its transaction rather than inserted and then corrected.
     * `writePosting` refuses a closed period, and the refusal names it.
     */
    const id = randomUUID();
    const transactionId = await writePosting(tx, ctx, ledger.postJournal({
      journalId: id, occurredAt: at, entries: checked.entries,
    }));
    const [row] = await tx.insert(schema.journalEntry).values({
      id,
      organizationId: ctx.actor.organizationId,
      number,
      occurredOn: date,
      memo,
      total: m.toString(checked.total),
      ledgerTransactionId: transactionId,
      createdByUserId: userOf(ctx),
    }).returning();
    const posted = row;

    await remember(tx, ctx, "journal.create", row!.id);
    await audit(tx, ctx, "journal.posted", "journal_entry", row!.id, null, {
      number, occurredOn: date, memo, total: posted!.total,
      lines: checked.entries.map((e) => ({ account: e.accountCode, direction: e.direction, amount: m.toString(e.amount) })),
    });
    return (await views(tx, [posted!]))[0]!;
  });
}

/**
 * Reverse an entry: a new entry, every line on the other side, pointing at
 * the one it takes back. Dated today unless another open day is given,
 * because the period the original sits in may be closed, and correcting it
 * in the open period is what an accountant does anyway.
 */
export async function reverse(
  ctx: ServiceContext, input: { id: string; occurredOn?: string | undefined; memo?: string | undefined },
): Promise<JournalView> {
  return guardedWrite(ctx, "ledger:post", async (tx) => {
    const again = await replayed(tx, ctx, "journal.reverse");
    if (again) return again;

    const [original] = await tx.select().from(schema.journalEntry)
      .where(and(eq(schema.journalEntry.id, input.id), eq(schema.journalEntry.organizationId, ctx.actor.organizationId)))
      .limit(1).for("update");
    if (!original) throw new NotFoundError("Journal entry");
    if (original.reversesJournalId) {
      throw new ConflictError(`Journal ${original.number} is itself a reversal. Post the entry again rather than reversing the reversal.`);
    }
    const [already] = await tx.select({ number: schema.journalEntry.number }).from(schema.journalEntry)
      .where(eq(schema.journalEntry.reversesJournalId, original.id)).limit(1);
    if (already) throw new ConflictError(`Journal ${original.number} was already reversed by journal ${already.number}.`);

    const { date, at } = await bookingDate(tx, ctx.actor.organizationId, input.occurredOn);
    if (date < original.occurredOn) {
      throw new UnprocessableError("Before the entry it reverses", [{
        path: "occurredOn", message: `A reversal cannot be dated before the entry it takes back (${original.occurredOn}).`,
      }]);
    }
    const entries = await tx.select().from(schema.ledgerEntry)
      .where(and(eq(schema.ledgerEntry.sourceType, "journal"), eq(schema.ledgerEntry.sourceId, original.id)));

    const memo = input.memo?.trim() || `Reverses journal ${original.number}: ${original.memo}`;
    const number = await nextNumber(tx, ctx.actor.organizationId, "journal_entry");
    const id = randomUUID();
    const transactionId = await writePosting(tx, ctx, ledger.reverseJournal({
      journalId: id, occurredAt: at, memo,
      original: entries.map((e) => ({
        id: e.id, direction: e.direction, accountCode: e.accountCode, amount: m.money(e.amount, e.currency), memo: e.memo,
      })),
    }));
    const [row] = await tx.insert(schema.journalEntry).values({
      id,
      organizationId: ctx.actor.organizationId,
      number,
      occurredOn: date,
      memo,
      total: original.total,
      reversesJournalId: original.id,
      ledgerTransactionId: transactionId,
      createdByUserId: userOf(ctx),
    }).returning();
    const posted = row;

    await remember(tx, ctx, "journal.reverse", row!.id);
    await audit(tx, ctx, "journal.reversed", "journal_entry", original.id, { number: original.number }, {
      reversedBy: row!.id, reversalNumber: number, occurredOn: date,
    });
    return (await views(tx, [posted!]))[0]!;
  });
}

export async function list(ctx: ServiceContext, input: { limit?: number | undefined } = {}): Promise<{ journals: JournalView[] }> {
  return guardedRead(ctx, "ledger:read", async (tx) => {
    const rows = await tx.select().from(schema.journalEntry)
      .where(eq(schema.journalEntry.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.journalEntry.number))
      .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
    return { journals: await views(tx, rows) };
  });
}

export async function get(ctx: ServiceContext, input: { id: string }): Promise<JournalView> {
  return guardedRead(ctx, "ledger:read", async (tx) => {
    const [row] = await tx.select().from(schema.journalEntry)
      .where(and(eq(schema.journalEntry.id, input.id), eq(schema.journalEntry.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("Journal entry");
    return (await views(tx, [row]))[0]!;
  });
}

export const handlers = {
  listJournalEntries: (ctx: ServiceContext, input: { limit?: number | undefined }) => list(ctx, input),
  getJournalEntry: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  createJournalEntry: (ctx: ServiceContext, input: {
    occurredOn?: string | undefined; memo: string;
    lines: { accountCode: string; debit?: string | undefined; credit?: string | undefined; memo?: string | undefined }[];
  }) => create(ctx, input),
  reverseJournalEntry: (ctx: ServiceContext, input: { id: string; occurredOn?: string | undefined; memo?: string | undefined }) =>
    reverse(ctx, input),
} as const;
