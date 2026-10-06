import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@opentradesos/db";
import type { ledger } from "@opentradesos/core";

/**
 * WHICH BRANCH A POSTING BELONGS TO
 *
 * `ledger_entry.business_unit_id` was written by nothing, and the trial balance
 * said why it had no branch filter: filling the column on the invoice path alone
 * would give a branch a trial balance holding its revenue and none of its
 * payments, write offs or deposits, which is plausible, wrong, and not something
 * anybody checking it against a bank statement would find the cause of. Making
 * it true meant carrying the branch through every path that posts.
 *
 * This is that, written once, at the door every posting goes through, so a
 * thirteenth kind of posting cannot forget it (`ledger-branch.test.ts` fails on
 * a posting kind that is in neither list below).
 *
 * THE RULES.
 *
 *   A branch is a job's. Reports, scope and the job list all read the branch off
 *   the job ("an invoice or a visit belongs to whichever branch its job does"),
 *   so an invoice's branch is its job's, and only an invoice with no job falls
 *   back to the branch written on the invoice itself.
 *
 *   One branch per posting, taken from the document the posting is about, so
 *   everything the posting writes (the receivable, the revenue, the tax) lands in
 *   the same branch and a branch's trial balance balances. A payment follows the
 *   invoices it was applied to, and only when they are all in ONE branch: a
 *   payment spread over two branches belongs to neither, because splitting it
 *   would be a number nobody recorded.
 *
 *   A line that names its own branch (a journal line) keeps it. A line with a job
 *   and no branch takes the job's, which is how late freight on parts a job used
 *   reaches the job's branch though its bill belongs to none.
 *
 *   Everything else has no branch, and says so: payroll, the release of deferred
 *   revenue and agreement breakage are the company's, and nothing old is
 *   migrated, because the table cannot be updated and a guess written into a
 *   ledger is a guess forever.
 */

/** The branch of an invoice: its job's, else the one on the invoice itself. */
const invoiceBranch = (invoiceId: SQL | string) => sql`(
  select coalesce(j.business_unit_id, i.business_unit_id)
  from public.invoice i left join public.job j on j.id = i.job_id
  where i.id = ${invoiceId}
)`;

/**
 * The single branch of a set of invoices, or nothing: every invoice has to be in
 * a branch and it has to be the same one.
 */
const sharedBranch = (invoices: SQL) => sql`(
  select case when count(*) > 0 and count(b.unit) = count(*) and count(distinct b.unit) = 1
              then min(b.unit::text)::uuid end
  from (
    select coalesce(j.business_unit_id, i.business_unit_id) as unit
    from public.invoice i left join public.job j on j.id = i.job_id
    where i.id in (${invoices})
  ) b
)`;

/** What each kind of posting resolves its branch from, by its `sourceType`. */
const FROM_SOURCE: Record<string, (sourceId: string) => SQL> = {
  /** `sourceId` is the invoice. */
  invoice: invoiceBranch,
  void: invoiceBranch,
  write_off: invoiceBranch,
  agreement_billing: invoiceBranch,

  /** `sourceId` is the payment, and a refund or a credit applied is about the same payment. */
  payment: (id) => sharedBranch(sql`select pa.invoice_id from public.payment_allocation pa where pa.payment_id = ${id}`),
  refund: (id) => sharedBranch(sql`select pa.invoice_id from public.payment_allocation pa where pa.payment_id = ${id}`),
  credit_application: (id) => sharedBranch(sql`select pa.invoice_id from public.payment_allocation pa where pa.payment_id = ${id}`),

  /** `sourceId` is the deposit: its job's branch, else the invoice it was applied to. */
  deposit: depositBranch,
  deposit_application: depositBranch,
  deposit_refund: depositBranch,
  deposit_forfeiture: depositBranch,

  /** `sourceId` is the credit note, which is about the invoice it credits. */
  credit_note: creditNoteBranch,
  credit_note_application: creditNoteBranch,
  credit_note_void: creditNoteBranch,
  /** `sourceId` is the payout, which is about its credit note. */
  credit_note_payout: (id) => sql`(
    select ${creditNoteBranch(sql`p.credit_note_id`)} from public.credit_note_payout p where p.id = ${id}
  )`,

  /** `sourceId` is the application for payment: its invoice's branch, else the project's. */
  retainage: applicationBranch,
  retainage_reversal: applicationBranch,

  /** `sourceId` is the commission event, or the reversal of one. */
  commission: (id) => sql`(
    select coalesce(j.business_unit_id, ${invoiceBranch(sql`e.invoice_id`)})
    from public.commission_event e left join public.job j on j.id = e.job_id where e.id = ${id}
  )`,
  commission_reversal: (id) => sql`(
    select coalesce(j.business_unit_id, ${invoiceBranch(sql`e.invoice_id`)})
    from public.commission_reversal r
    join public.commission_event e on e.id = r.event_id
    left join public.job j on j.id = e.job_id
    where r.id = ${id}
  )`,
};

function depositBranch(id: string): SQL {
  return sql`(
    select coalesce(j.business_unit_id, ${invoiceBranch(sql`d.applied_invoice_id`)})
    from public.deposit d left join public.job j on j.id = d.job_id where d.id = ${id}
  )`;
}

function creditNoteBranch(id: SQL | string): SQL {
  return sql`(select ${invoiceBranch(sql`c.invoice_id`)} from public.credit_note c where c.id = ${id})`;
}

function applicationBranch(id: string): SQL {
  return sql`(
    select coalesce(${invoiceBranch(sql`a.invoice_id`)}, p.business_unit_id)
    from public.project_application a join public.project p on p.id = a.project_id where a.id = ${id}
  )`;
}

/**
 * The kinds of posting that have NO branch of their own, each with the reason.
 * An entry in one of them still takes its job's branch where a line carries a
 * job (late freight on a job's parts does), and has none where it does not.
 *
 * A kind in neither this list nor `FROM_SOURCE` fails `ledger-branch.test.ts`:
 * the decision is made when a posting is added, not discovered when a branch's
 * books are found to be missing something.
 */
export const NO_SOURCE_BRANCH: Record<string, string> = {
  journal: "Every line of a journal names its own branch, or takes its job's.",
  landed_cost_bill: "A supplier's bill belongs to no branch; each line of it is on the job whose parts it landed on.",
  stock_movement: "Stock belongs to a location, not a branch; a line is on the job that used the part.",
  agreement_recognition: "Each line is on the job of the visit delivered, when it has one.",
  deferred_release: "An agreement belongs to the company, and a branch's share of unearned revenue is not recorded.",
  agreement_breakage: "An agreement belongs to the company, and breakage is released at the end of its term.",
  commission_payment: "Payroll is run for the company.",
  tip_payout: "Payroll is run for the company.",
};

/** Every kind of posting that has a way to its branch, either way. */
export const POSTING_SOURCES: readonly string[] = [...Object.keys(FROM_SOURCE), ...Object.keys(NO_SOURCE_BRANCH)];

/**
 * The branch of each entry of a posting, in the order of its entries: null where
 * it belongs to none.
 *
 * A line's own branch first, then the document's, then its job's. The document's
 * comes before the job's so that every line of an invoice lands in one branch
 * even if somebody moved the job on afterwards; a job carried on a line with no
 * document behind it (late freight) is the only thing left to go on.
 */
export async function branchesOf(tx: Database, posting: ledger.Posting): Promise<(string | null)[]> {
  const resolve = FROM_SOURCE[posting.sourceType];
  let fromSource: string | null = null;
  if (resolve) {
    const rows = await tx.execute<{ unit: string | null }>(sql`select ${resolve(posting.sourceId)} as unit`);
    fromSource = rows[0]?.unit ?? null;
  }

  const jobs = [...new Set(posting.entries.filter((e) => !e.businessUnitId && !fromSource && e.jobId).map((e) => e.jobId!))];
  const unitOfJob = new Map<string, string | null>();
  if (jobs.length > 0) {
    const rows = await tx.execute<{ id: string; unit: string | null }>(sql`
      select j.id, j.business_unit_id as unit from public.job j
      where j.id in (${sql.join(jobs.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
    for (const row of rows) unitOfJob.set(row.id, row.unit);
  }

  return posting.entries.map((entry) =>
    entry.businessUnitId ?? fromSource ?? (entry.jobId ? unitOfJob.get(entry.jobId) ?? null : null));
}
