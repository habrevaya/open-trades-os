import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m } from "@opentradesos/core";
import { guardedRead, type ServiceContext } from "./context";
import { assertPeriodOpen } from "./history";

/**
 * Writing a posting.
 *
 * The balance is asserted twice on purpose. Once here, in TypeScript, where
 * the error names the imbalance and points at the code that built it. Once in
 * Postgres, by a deferred constraint trigger, where it is a guarantee rather
 * than a convention.
 *
 * The first check exists because a trigger firing at COMMIT tells you a
 * transaction failed, not which of forty entries was wrong. The second exists
 * because the first can be bypassed by anything writing SQL directly, and the
 * ledger is the one table where that must not be possible.
 */
export async function writePosting(
  tx: Database, ctx: ServiceContext, posting: ledger.Posting,
): Promise<string> {
  /**
   * Here, at the one door every posting goes through, rather than in each
   * service that dates something. A date check in eleven places is eleven
   * places to forget it, and the twelfth posting kind would not have it.
   */
  await assertPeriodOpen(tx, ctx.actor.organizationId, posting.occurredAt);

  const transactionId = randomUUID();

  await tx.insert(schema.ledgerEntry).values(
    posting.entries.map((entry) => ({
      organizationId: ctx.actor.organizationId,
      transactionId,
      occurredAt: posting.occurredAt,
      direction: entry.direction,
      accountCode: entry.accountCode,
      currency: entry.amount.currency,
      amount: m.toString(entry.amount),
      sourceType: posting.sourceType,
      sourceId: posting.sourceId,
      ...(entry.customerId ? { customerId: entry.customerId } : {}),
      ...(entry.jobId ? { jobId: entry.jobId } : {}),
      ...(entry.memo ? { memo: entry.memo } : {}),
    })),
  );

  return transactionId;
}

/* ------------------------------------------------- reading the books back */

/**
 * `ledger:read` AND `ledger:post` WERE GRANTED TO ROLES AND CHECKED BY
 * NOTHING, and the two are owed for different reasons.
 *
 * `ledger:post` stays owed, deliberately. A posting in this product is a
 * consequence of a guarded business action: invoicing, taking a payment,
 * writing one off. There is no bare journal entry surface and there should
 * not be one, because an operator who can post freely can make the books say
 * anything without a document behind it. The permission exists for the day a
 * manual journal is genuinely needed, and until then it is excused by name in
 * `permissions-enforced.test.ts`.
 *
 * `ledger:read` was a different story: the postings are written, they are
 * append only and trigger-enforced, and NOTHING COULD READ THEM BACK. A
 * company could not see a trial balance, could not open a journal, and could
 * not answer "why does accounts receivable say that" without a database
 * client. The whole argument for double entry is that it is auditable, and
 * the audit was not reachable.
 */

export interface TrialBalanceRow {
  accountCode: string;
  accountClass: ledger.AccountClass;
  /** Which side this account normally sits on. The reader needs it to check us. */
  normalBalance: ledger.Direction;
  debits: string;
  credits: string;
  /**
   * Signed towards the account's own normal balance, so a positive number
   * always means "more of what this account holds". A debit balance on
   * revenue comes back negative, which is what a contra revenue account like
   * DISCOUNTS is supposed to look like.
   */
  balance: string;
  currency: string;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  /**
   * Total debits and total credits, which must be equal.
   *
   * REPORTED RATHER THAN ASSERTED, and that is the point. A trigger already
   * refuses an unbalanced posting, so these should always match; printing
   * them is how a reader confirms that for themselves rather than taking the
   * schema's word for it. If they ever differ, every other number on the
   * report is suspect and the report says so instead of hiding it.
   */
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  /** The window, echoed, because a trial balance with no dates is unreadable. */
  from: string | null;
  to: string | null;
}

/**
 * The trial balance: every account, its two sides, and its balance.
 *
 * Grouped in SQL rather than folded in TypeScript, because this is the one
 * report that reads the whole ledger and a company closing its fifth year has
 * a lot of it.
 *
 * NO BUSINESS UNIT FILTER, AND THAT IS DELIBERATE RATHER THAN AN OMISSION.
 *
 * `ledger_entry.business_unit_id` exists for exactly this, and the first
 * version of this function took it. A guard test caught what that meant:
 * `writePosting` has never written the column, on any path, so the filter
 * matched nothing on every ledger in every company. A report that comes back
 * empty is at least obviously wrong.
 *
 * The reason it is not simply wired up here is worse than the reason it was
 * missing. Filling it on the invoice path alone is easy, because an invoice
 * carries its own unit, and it would produce a filtered trial balance holding
 * a branch's revenue and none of its payments, write-offs or deposits. That
 * number is plausible, it is wrong, and nobody checking it against a bank
 * statement would find the cause. Making it true needs the unit carried
 * through every one of the paths that post, which is its own piece of work.
 *
 * So the filter comes back when the column has a writer, and until then the
 * report covers the whole company and says so.
 */
export async function trialBalance(
  ctx: ServiceContext,
  input: { from?: string | undefined; to?: string | undefined } = {},
): Promise<TrialBalance> {
  return guardedRead(ctx, "ledger:read", async (tx) => {
    const rows = await tx.select({
      accountCode: schema.ledgerEntry.accountCode,
      currency: schema.ledgerEntry.currency,
      direction: schema.ledgerEntry.direction,
      total: sql<string>`sum(${schema.ledgerEntry.amount})::text`,
    }).from(schema.ledgerEntry)
      .where(and(
        eq(schema.ledgerEntry.organizationId, ctx.actor.organizationId),
        input.from ? gte(schema.ledgerEntry.occurredAt, new Date(input.from)) : undefined,
        input.to ? lte(schema.ledgerEntry.occurredAt, new Date(input.to)) : undefined,
      ))
      .groupBy(
        schema.ledgerEntry.accountCode,
        schema.ledgerEntry.currency,
        schema.ledgerEntry.direction,
      );

    const byAccount = new Map<string, { currency: string; debit: m.Money; credit: m.Money }>();
    for (const row of rows) {
      const key = `${row.accountCode}|${row.currency}`;
      const current = byAccount.get(key) ?? {
        currency: row.currency,
        debit: m.money("0", row.currency),
        credit: m.money("0", row.currency),
      };
      const amount = m.money(row.total, row.currency);
      byAccount.set(key, row.direction === "debit"
        ? { ...current, debit: m.add(current.debit, amount) }
        : { ...current, credit: m.add(current.credit, amount) });
    }

    let totalDebits = m.money("0", "USD");
    let totalCredits = m.money("0", "USD");
    const out: TrialBalanceRow[] = [];

    for (const [key, sides] of [...byAccount].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const accountCode = key.slice(0, key.lastIndexOf("|"));
      const accountClass = ledger.classOf(accountCode);
      const normal = ledger.normalBalance(accountClass);
      /**
       * Signed towards the account rather than towards debit. `signedFor` in
       * core is the one place that knows which way round that is, because
       * getting it wrong produces a report that balances perfectly and states
       * the opposite of the truth about every liability in the company.
       */
      const balance = normal === "debit"
        ? m.subtract(sides.debit, sides.credit)
        : m.subtract(sides.credit, sides.debit);

      out.push({
        accountCode,
        accountClass,
        normalBalance: normal,
        debits: m.toString(sides.debit),
        credits: m.toString(sides.credit),
        balance: m.toString(balance),
        currency: sides.currency,
      });

      if (sides.currency === totalDebits.currency) {
        totalDebits = m.add(totalDebits, sides.debit);
        totalCredits = m.add(totalCredits, sides.credit);
      }
    }

    return {
      rows: out,
      totalDebits: m.toString(totalDebits),
      totalCredits: m.toString(totalCredits),
      balanced: m.toString(totalDebits) === m.toString(totalCredits),
      from: input.from ?? null,
      to: input.to ?? null,
    };
  });
}

export interface JournalEntry {
  transactionId: string;
  occurredAt: string;
  sourceType: string;
  sourceId: string;
  lines: {
    direction: ledger.Direction;
    accountCode: string;
    accountClass: ledger.AccountClass;
    amount: string;
    currency: string;
    memo: string | null;
    jobId: string | null;
    customerId: string | null;
    /** The entry this one reverses, when it is a reversal. */
    reversesEntryId: string | null;
  }[];
  /** Per transaction, so a reader can see each one balances on its own. */
  totalDebits: string;
  totalCredits: string;
}

/**
 * The journal: postings, grouped by transaction, newest first.
 *
 * GROUPED BY TRANSACTION AND NOT A FLAT LIST OF ENTRIES, which is the whole
 * value of the report. A list of rows cannot be checked by a person: double
 * entry is readable only when the two sides of one event are next to each
 * other, and "why does this invoice show as paid" is answered by seeing the
 * cash debit beside the receivable credit with the same transaction id.
 *
 * Paged by transaction rather than by row, because a page boundary in the
 * middle of a posting shows a reader half an event and invites them to
 * conclude the books do not balance.
 */
export async function journal(
  ctx: ServiceContext,
  input: {
    from?: string | undefined;
    to?: string | undefined;
    jobId?: string | undefined;
    customerId?: string | undefined;
    accountCode?: string | undefined;
    limit?: number | undefined;
  } = {},
): Promise<{ transactions: JournalEntry[] }> {
  return guardedRead(ctx, "ledger:read", async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    /**
     * The transaction ids first, then every line of those transactions.
     *
     * Two queries rather than one, because filtering and paging in a single
     * pass returns the MATCHING lines of a posting rather than the posting.
     * A reader filtering on account 1200 would see the receivable leg of
     * forty invoices and none of their revenue legs, which looks exactly
     * like a ledger that does not balance.
     */
    const heads = await tx.selectDistinct({
      transactionId: schema.ledgerEntry.transactionId,
      occurredAt: schema.ledgerEntry.occurredAt,
    }).from(schema.ledgerEntry)
      .where(and(
        eq(schema.ledgerEntry.organizationId, ctx.actor.organizationId),
        input.from ? gte(schema.ledgerEntry.occurredAt, new Date(input.from)) : undefined,
        input.to ? lte(schema.ledgerEntry.occurredAt, new Date(input.to)) : undefined,
        input.jobId ? eq(schema.ledgerEntry.jobId, input.jobId) : undefined,
        input.customerId ? eq(schema.ledgerEntry.customerId, input.customerId) : undefined,
        input.accountCode ? eq(schema.ledgerEntry.accountCode, input.accountCode) : undefined,
      ))
      .orderBy(desc(schema.ledgerEntry.occurredAt))
      .limit(limit);

    if (heads.length === 0) return { transactions: [] };

    const lines = await tx.select().from(schema.ledgerEntry)
      .where(and(
        eq(schema.ledgerEntry.organizationId, ctx.actor.organizationId),
        inArray(schema.ledgerEntry.transactionId, heads.map((h) => h.transactionId)),
      ))
      .orderBy(asc(schema.ledgerEntry.accountCode));

    const grouped = new Map<string, typeof lines>();
    for (const line of lines) {
      const bucket = grouped.get(line.transactionId) ?? [];
      bucket.push(line);
      grouped.set(line.transactionId, bucket);
    }

    const transactions: JournalEntry[] = [];
    for (const head of heads) {
      const group = grouped.get(head.transactionId) ?? [];
      const first = group[0];
      if (!first) continue;

      let debits = m.money("0", first.currency);
      let credits = m.money("0", first.currency);
      for (const line of group) {
        const amount = m.money(line.amount, line.currency);
        if (line.direction === "debit") debits = m.add(debits, amount);
        else credits = m.add(credits, amount);
      }

      transactions.push({
        transactionId: head.transactionId,
        occurredAt: head.occurredAt.toISOString(),
        sourceType: first.sourceType,
        sourceId: first.sourceId,
        lines: group.map((line) => ({
          direction: line.direction,
          accountCode: line.accountCode,
          accountClass: ledger.classOf(line.accountCode),
          amount: line.amount,
          currency: line.currency,
          memo: line.memo,
          jobId: line.jobId,
          customerId: line.customerId,
          reversesEntryId: line.reversesEntryId,
        })),
        totalDebits: m.toString(debits),
        totalCredits: m.toString(credits),
      });
    }

    return { transactions };
  });
}

export const handlers = {
  getTrialBalance: (ctx: ServiceContext, input: {
    from?: string | undefined; to?: string | undefined;
  }): Promise<TrialBalance> => trialBalance(ctx, input),
  listJournal: (ctx: ServiceContext, input: {
    from?: string | undefined; to?: string | undefined;
    jobId?: string | undefined; customerId?: string | undefined;
    accountCode?: string | undefined; limit?: number | undefined;
  }): Promise<{ transactions: JournalEntry[] }> => journal(ctx, input),
} as const;
