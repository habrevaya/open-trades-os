import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { can, ledger, money as m, time, work, SYSTEM_USER_ID } from "@opentradesos/core";
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
 *
 * A LINE CAN SAY WHAT IT IS ABOUT: a branch, a job, a customer. Rent for one
 * shop, a subcontractor's bill for one job and a cost that is one customer's
 * are the commonest reasons an accountant books a journal, and without a place
 * to say so they stayed company wide lines and the job's margin never saw them
 * (M15 reads a job's ledger entries, journal lines included, so a line on a job
 * is in its costs the same day). Each is checked to be THIS company's before
 * anything is written, naming the line: a foreign key alone would accept
 * another company's job, because a foreign key is not row level security.
 * Nothing is sent to the books about them: QuickBooks and Xero are sent each
 * line's account and amount, as before.
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
  lines: JournalLineView[];
}

export interface JournalLineView {
  entryId: string;
  accountCode: string;
  direction: "debit" | "credit";
  amount: string;
  memo: string | null;
  /** What the line is about. The id is always given; the words only to somebody who may read what they name. */
  businessUnitId: string | null;
  branchName: string | null;
  jobId: string | null;
  jobNumber: string | null;
  customerId: string | null;
  customerName: string | null;
}

async function views(tx: Database, ctx: ServiceContext, rows: (typeof schema.journalEntry.$inferSelect)[]): Promise<JournalView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const entries = await tx.select().from(schema.ledgerEntry)
    .where(and(eq(schema.ledgerEntry.sourceType, "journal"), inArray(schema.ledgerEntry.sourceId, ids)))
    .orderBy(asc(schema.ledgerEntry.createdAt), asc(schema.ledgerEntry.direction));
  const reversals = await tx.select({
    id: schema.journalEntry.id, number: schema.journalEntry.number, reverses: schema.journalEntry.reversesJournalId,
  }).from(schema.journalEntry).where(inArray(schema.journalEntry.reversesJournalId, ids));
  const originals = rows.map((r) => r.reversesJournalId).filter((x): x is string => !!x);
  const names = await aboutNames(tx, ctx, entries);
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
      lines: entries.filter((e) => e.sourceId === r.id).map((e): JournalLineView => ({
        entryId: e.id, accountCode: e.accountCode, direction: e.direction, amount: e.amount, memo: e.memo,
        businessUnitId: e.businessUnitId,
        branchName: e.businessUnitId ? names.branches.get(e.businessUnitId) ?? null : null,
        jobId: e.jobId,
        jobNumber: e.jobId ? names.jobs.get(e.jobId) ?? null : null,
        customerId: e.customerId,
        customerName: e.customerId ? names.customers.get(e.customerId) ?? null : null,
      })),
    };
  });
}

/**
 * The words for a line's branch, job and customer, for a reader allowed to read
 * what each names. The ledger's own permission is not the customer list's: a
 * role built with `ledger:read` alone sees that a line is about a customer and
 * not who, the same as it sees the id and no more.
 */
async function aboutNames(tx: Database, ctx: ServiceContext, entries: (typeof schema.ledgerEntry.$inferSelect)[]) {
  const unique = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))];
  const branches = new Map<string, string>();
  const jobs = new Map<string, string>();
  const customers = new Map<string, string>();

  const unitIds = unique(entries.map((e) => e.businessUnitId));
  if (unitIds.length > 0) {
    for (const row of await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
      .from(schema.businessUnit).where(inArray(schema.businessUnit.id, unitIds))) branches.set(row.id, row.name);
  }
  const jobIds = unique(entries.map((e) => e.jobId));
  if (jobIds.length > 0 && can(ctx.actor, "job:read")) {
    for (const row of await tx.select({
      id: schema.job.id, number: schema.job.number, prefix: schema.job.numberPrefix,
    }).from(schema.job).where(inArray(schema.job.id, jobIds))) jobs.set(row.id, work.documentNumber(row.prefix, row.number));
  }
  const customerIds = unique(entries.map((e) => e.customerId));
  if (customerIds.length > 0 && can(ctx.actor, "customer:read")) {
    for (const row of await tx.select({ id: schema.customer.id, name: schema.customer.name })
      .from(schema.customer).where(inArray(schema.customer.id, customerIds))) customers.set(row.id, row.name);
  }
  return { branches, jobs, customers };
}

/**
 * THE BRANCH, JOB AND CUSTOMER ON EACH LINE ARE THIS COMPANY'S OWN, or the
 * entry is not posted.
 *
 * `ledger_entry` references `job`, `customer` and `business_unit` by foreign
 * key, and a foreign key accepts any row that exists, in any company. Row level
 * security hides another company's job from a SELECT, so it is not found here,
 * and that is the check; the organization is said anyway so it does not read as
 * an id taken on trust. A removed job or customer, and a retired branch, are
 * refused too: nothing new is booked against something the company has put
 * away.
 */
async function assertAbout(tx: Database, ctx: ServiceContext, lines: readonly ledger.JournalLineInput[]): Promise<void> {
  const org = ctx.actor.organizationId;
  const problems: { path: string; message: string }[] = [];
  const ids = (pick: (l: ledger.JournalLineInput) => string | undefined) =>
    [...new Set(lines.map((l) => pick(l)?.trim().toLowerCase()).filter((v): v is string => !!v))];

  const unitIds = ids((l) => l.businessUnitId);
  const jobIds = ids((l) => l.jobId);
  const customerIds = ids((l) => l.customerId);

  const units = unitIds.length === 0 ? [] : await tx.select({
    id: schema.businessUnit.id, name: schema.businessUnit.name, active: schema.businessUnit.active,
  }).from(schema.businessUnit).where(and(inArray(schema.businessUnit.id, unitIds), eq(schema.businessUnit.organizationId, org)));
  const jobs = jobIds.length === 0 ? [] : await tx.select({
    id: schema.job.id, number: schema.job.number, prefix: schema.job.numberPrefix,
  }).from(schema.job).where(and(
    inArray(schema.job.id, jobIds), eq(schema.job.organizationId, org), isNull(schema.job.deletedAt),
  ));
  const customers = customerIds.length === 0 ? [] : await tx.select({ id: schema.customer.id, name: schema.customer.name })
    .from(schema.customer).where(and(
      inArray(schema.customer.id, customerIds), eq(schema.customer.organizationId, org), isNull(schema.customer.deletedAt),
    ));

  lines.forEach((line, index) => {
    const at = `lines.${index}`;
    const n = index + 1;
    const unitId = line.businessUnitId?.trim().toLowerCase();
    if (unitId) {
      const unit = units.find((u) => u.id === unitId);
      if (!unit) problems.push({ path: `${at}.businessUnitId`, message: `Line ${n}: that branch is not one of yours.` });
      else if (!unit.active) {
        problems.push({ path: `${at}.businessUnitId`, message: `Line ${n}: ${unit.name} has been retired, so nothing new is put in it.` });
      }
    }
    const jobId = line.jobId?.trim().toLowerCase();
    if (jobId && !jobs.some((j) => j.id === jobId)) {
      problems.push({ path: `${at}.jobId`, message: `Line ${n}: that job is not one of yours, or it has been removed.` });
    }
    const customerId = line.customerId?.trim().toLowerCase();
    if (customerId && !customers.some((c) => c.id === customerId)) {
      problems.push({ path: `${at}.customerId`, message: `Line ${n}: that customer is not one of yours, or has been removed.` });
    }
  });
  if (problems.length > 0) throw new UnprocessableError("The journal cannot be posted", problems);
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
  return row ? (await views(tx, ctx, [row]))[0]! : null;
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
    await assertAbout(tx, ctx, input.lines);
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
      lines: checked.entries.map((e) => ({
        account: e.accountCode, direction: e.direction, amount: m.toString(e.amount),
        ...(e.businessUnitId ? { businessUnitId: e.businessUnitId } : {}),
        ...(e.jobId ? { jobId: e.jobId } : {}),
        ...(e.customerId ? { customerId: e.customerId } : {}),
      })),
    });
    return (await views(tx, ctx, [posted!]))[0]!;
  });
}

/**
 * A job by the number it is printed with ("1042", or "AUS-1042" where the
 * company prints its branch's mark), and a customer by their exact name, for
 * the journal form, where nobody has a job's id to hand. Each refusal says what
 * to do about it: a name two customers share is not guessed between.
 *
 * `ledger:post` and nothing wider, because the answer is an id for a line the
 * caller is about to post, and the lookup reads only the one job or customer
 * they named.
 */
export function findAbout(ctx: ServiceContext, input: { job?: string | undefined; customer?: string | undefined }) {
  return guardedRead(ctx, "ledger:post", async (tx): Promise<{ jobId: string | null; customerId: string | null }> => {
    const out: { jobId: string | null; customerId: string | null } = { jobId: null, customerId: null };
    const org = ctx.actor.organizationId;

    const typed = input.job?.trim();
    if (typed) {
      const found = /^(?:([A-Za-z0-9]{1,8})-)?(\d{1,9})$/.exec(typed.replace(/^#/, ""));
      if (!found) {
        throw new UnprocessableError("Not a job number", [{ path: "job", message: `"${typed}" is not a job number. It looks like 1042, or AUS-1042 where your numbers carry a branch.` }]);
      }
      const [row] = await tx.select({ id: schema.job.id, prefix: schema.job.numberPrefix }).from(schema.job)
        .where(and(
          eq(schema.job.organizationId, org), eq(schema.job.number, Number(found[2])), isNull(schema.job.deletedAt),
        )).limit(1);
      if (!row || (found[1] && (row.prefix ?? "").toUpperCase() !== found[1].toUpperCase())) {
        throw new UnprocessableError("No such job", [{ path: "job", message: `There is no job ${typed}.` }]);
      }
      out.jobId = row.id;
    }

    const name = input.customer?.trim();
    if (name) {
      const rows = await tx.select({ id: schema.customer.id }).from(schema.customer)
        .where(and(
          eq(schema.customer.organizationId, org), isNull(schema.customer.deletedAt),
          sql`lower(${schema.customer.name}) = lower(${name})`,
        )).limit(2);
      if (rows.length === 0) {
        throw new UnprocessableError("No such customer", [{ path: "customer", message: `There is no customer called "${name}". Type the name exactly as it is on their page.` }]);
      }
      if (rows.length > 1) {
        throw new UnprocessableError("More than one customer", [{
          path: "customer",
          message: `More than one customer is called "${name}", so it is not clear which you mean. Name the job instead, or leave the customer off this line.`,
        }]);
      }
      out.customerId = rows[0]!.id;
    }
    return out;
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
        businessUnitId: e.businessUnitId, jobId: e.jobId, customerId: e.customerId,
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
    return (await views(tx, ctx, [posted!]))[0]!;
  });
}

export async function list(ctx: ServiceContext, input: { limit?: number | undefined } = {}): Promise<{ journals: JournalView[] }> {
  return guardedRead(ctx, "ledger:read", async (tx) => {
    const rows = await tx.select().from(schema.journalEntry)
      .where(eq(schema.journalEntry.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.journalEntry.number))
      .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
    return { journals: await views(tx, ctx, rows) };
  });
}

export async function get(ctx: ServiceContext, input: { id: string }): Promise<JournalView> {
  return guardedRead(ctx, "ledger:read", async (tx) => {
    const [row] = await tx.select().from(schema.journalEntry)
      .where(and(eq(schema.journalEntry.id, input.id), eq(schema.journalEntry.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("Journal entry");
    return (await views(tx, ctx, [row]))[0]!;
  });
}

export const handlers = {
  listJournalEntries: (ctx: ServiceContext, input: { limit?: number | undefined }) => list(ctx, input),
  getJournalEntry: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  createJournalEntry: (ctx: ServiceContext, input: {
    occurredOn?: string | undefined; memo: string;
    lines: {
      accountCode: string; debit?: string | undefined; credit?: string | undefined; memo?: string | undefined;
      businessUnitId?: string | undefined; jobId?: string | undefined; customerId?: string | undefined;
    }[];
  }) => create(ctx, input),
  reverseJournalEntry: (ctx: ServiceContext, input: { id: string; occurredOn?: string | undefined; memo?: string | undefined }) =>
    reverse(ctx, input),
} as const;
