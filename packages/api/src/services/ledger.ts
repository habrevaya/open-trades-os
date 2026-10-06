import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m } from "@opentradesos/core";
import { guardedRead, timezoneOf, type ServiceContext } from "./context";
import { assertPeriodOpen } from "./history";
import { branchesOf } from "./ledger-branch";

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
  /**
   * The branch of each entry, worked out here for the same reason the period
   * is checked here: this is the one door, and a branch decided in each
   * service that posts is a branch missing from whichever one forgot.
   */
  const branches = await branchesOf(tx, posting);

  await tx.insert(schema.ledgerEntry).values(
    posting.entries.map((entry, index) => ({
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
      ...(branches[index] ? { businessUnitId: branches[index]! } : {}),
      ...(entry.memo ? { memo: entry.memo } : {}),
      ...(entry.reversesEntryId ? { reversesEntryId: entry.reversesEntryId } : {}),
    })),
  );

  return transactionId;
}

/* ------------------------------------------------- reading the books back */

/**
 * `ledger:read` AND `ledger:post` WERE GRANTED TO ROLES AND CHECKED BY
 * NOTHING, and the two were owed for different reasons.
 *
 * `ledger:post` was owed deliberately, for the day a manual journal was
 * genuinely needed, because an operator who can post freely can make the
 * books say anything without a document behind it. That day came: an
 * accountant's accruals, depreciation and payroll had no way onto this ledger,
 * so every report here disagreed with the books by exactly their work. It is
 * now enforced by `services/journals.ts`, with the refusals that make it safe
 * stated there.
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
   * report is suspect and the report says so instead of hiding it. That is
   * the whole company's claim: a report narrowed to a branch need not
   * balance by itself (see `trialBalance`).
   */
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  /** The window, echoed, because a trial balance with no dates is unreadable. */
  from: string | null;
  to: string | null;
  /**
   * What the branch dimension covers in this window, so a branch's figures are
   * never read as the whole of its books or the company's as all of it
   * branched.
   */
  branch: {
    /** What the report was narrowed to: a branch's id, "none", or null for the company. */
    filter: string | null;
    /** Every entry in the window, whatever it was narrowed to. */
    entries: number;
    /** How many of them carry no branch. */
    withoutBranch: number;
    /** What the debits among them add up to, which is the size of what no branch holds. */
    withoutBranchDebits: string;
    /** The first day, in the company's calendar, any entry carries a branch. Everything before it has none. */
    firstBranchedOn: string | null;
  };
}

/**
 * The trial balance: every account, its two sides, and its balance.
 *
 * Grouped in SQL rather than folded in TypeScript, because this is the one
 * report that reads the whole ledger and a company closing its fifth year has
 * a lot of it.
 *
 * NARROWED TO A BRANCH, AND HONEST ABOUT WHAT THAT HOLDS.
 *
 * The filter was withheld for as long as nothing wrote
 * `ledger_entry.business_unit_id`, because a filter that matched nothing is at
 * least obviously wrong and a filter that matched a branch's revenue and none
 * of its payments is not. Every posting now carries the branch it can be traced
 * to (`ledger-branch.ts` says how), so the filter is the branch's invoices,
 * their payments, write offs, credit notes and deposits, the cost posted on its
 * jobs, and the journal lines that name it.
 *
 * What it still cannot hold is said in the answer rather than left to be found:
 * `branch` counts the entries in the window that carry no branch and what they
 * add up to, and the day the first branch was written. Everything before that
 * day has none, because nothing old is migrated (the table cannot be updated,
 * and a branch guessed into a ledger is a guess for good), and so do the
 * postings that belong to the company (payroll, the release of deferred
 * revenue) or to two branches at once (a payment spread over both).
 *
 * A BRANCH'S TOTALS NEED NOT BALANCE BY THEMSELVES, and `balanced` is only the
 * whole company's claim. A journal can give each of its lines a branch of its
 * own (rent for two shops on one bill), so one branch holds one side of it.
 */
export async function trialBalance(
  ctx: ServiceContext,
  input: {
    from?: string | undefined;
    to?: string | undefined;
    /** A branch, or "none" for the postings that carry none. Left out is the whole company. */
    businessUnitId?: string | undefined;
  } = {},
): Promise<TrialBalance> {
  return guardedRead(ctx, "ledger:read", async (tx) => {
    const inWindow = and(
      eq(schema.ledgerEntry.organizationId, ctx.actor.organizationId),
      input.from ? gte(schema.ledgerEntry.occurredAt, new Date(input.from)) : undefined,
      input.to ? lte(schema.ledgerEntry.occurredAt, new Date(input.to)) : undefined,
    );
    const rows = await tx.select({
      accountCode: schema.ledgerEntry.accountCode,
      currency: schema.ledgerEntry.currency,
      direction: schema.ledgerEntry.direction,
      total: sql<string>`sum(${schema.ledgerEntry.amount})::text`,
    }).from(schema.ledgerEntry)
      .where(and(inWindow, branchFilter(input.businessUnitId)))
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

    const tz = await timezoneOf(tx, ctx.actor.organizationId);
    const [coverage] = await tx.select({
      entries: sql<string>`count(*)::text`,
      without: sql<string>`count(*) filter (where ${schema.ledgerEntry.businessUnitId} is null)::text`,
      withoutDebits: sql<string>`coalesce(sum(${schema.ledgerEntry.amount}) filter (
        where ${schema.ledgerEntry.businessUnitId} is null and ${schema.ledgerEntry.direction} = 'debit'
      ), 0)::numeric(14,4)::text`,
    }).from(schema.ledgerEntry).where(inWindow);
    const [first] = await tx.select({
      day: sql<string | null>`to_char(min(${schema.ledgerEntry.occurredAt}) at time zone ${tz}, 'YYYY-MM-DD')`,
    }).from(schema.ledgerEntry).where(and(
      eq(schema.ledgerEntry.organizationId, ctx.actor.organizationId),
      isNotNull(schema.ledgerEntry.businessUnitId),
    ));

    return {
      rows: out,
      totalDebits: m.toString(totalDebits),
      totalCredits: m.toString(totalCredits),
      balanced: m.toString(totalDebits) === m.toString(totalCredits),
      from: input.from ?? null,
      to: input.to ?? null,
      branch: {
        filter: input.businessUnitId ?? null,
        entries: Number(coverage?.entries ?? 0),
        withoutBranch: Number(coverage?.without ?? 0),
        withoutBranchDebits: coverage?.withoutDebits ?? "0.0000",
        firstBranchedOn: first?.day ?? null,
      },
    };
  });
}

/**
 * The branch condition both ledger reports share: one branch, or "none" for the
 * entries that carry no branch, or nothing at all.
 */
function branchFilter(businessUnitId: string | undefined) {
  if (businessUnitId === undefined) return undefined;
  return businessUnitId === "none"
    ? isNull(schema.ledgerEntry.businessUnitId)
    : eq(schema.ledgerEntry.businessUnitId, businessUnitId);
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
    /** The branch the entry belongs to, or null when it has none: see the trial balance. */
    businessUnitId: string | null;
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
    /** A branch, or "none" for the entries that carry none. */
    businessUnitId?: string | undefined;
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
        branchFilter(input.businessUnitId),
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
          businessUnitId: line.businessUnitId,
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
    from?: string | undefined; to?: string | undefined; businessUnitId?: string | undefined;
  }): Promise<TrialBalance> => trialBalance(ctx, input),
  listJournal: (ctx: ServiceContext, input: {
    from?: string | undefined; to?: string | undefined;
    jobId?: string | undefined; customerId?: string | undefined;
    accountCode?: string | undefined; businessUnitId?: string | undefined; limit?: number | undefined;
  }): Promise<{ transactions: JournalEntry[] }> => journal(ctx, input),
} as const;
