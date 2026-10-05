import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branches, journals } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField } from "@/components/ActionForm";
import { formatDay, formatIn } from "@/lib/dates";
import { postJournal, reverseJournal } from "./actions";
import { JOURNAL_ROWS } from "./rows";

export const dynamic = "force-dynamic";

/**
 * BOOKS → JOURNAL ENTRIES
 *
 * What an accountant books that has no document here: rent, depreciation,
 * the payroll the bureau ran, supplier bills for materials, an accrual, a
 * correction. Balanced or refused, never into a closed month or into an
 * account the product keeps in step with invoices and deposits, reversed
 * rather than edited, and sent to QuickBooks or Xero on the next sync once its
 * accounts are mapped.
 */
export default async function BooksPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const tz = user.organizationTimezone;

  if (!can(user.actor, "ledger:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Journal entries" />
        <Empty title="Not shown to your role">The books need the View the general ledger permission.</Empty>
      </div>
    );
  }

  const { journals: entries } = await journals.list(ctx, { limit: 100 });
  const posts = can(user.actor, "ledger:post");
  /** Only for somebody who can post, and only when the company has branches to choose from. */
  const branchOptions = posts ? await branches.options(ctx) : null;
  const unitChoices = branchOptions?.branches ?? [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Journal entries" count={entries.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        For what has no invoice or payment behind it here. Each one has to balance, cannot go into a closed
        month, and cannot touch receivables, customer deposits, tips or commission owed, or deferred revenue:
        those follow their documents. A mistake is reversed, not edited.
      </p>
      <p className="mt-2 text-sm">
        <a href="/books/trial-balance" className="underline underline-offset-4">Trial balance, by branch if you like</a>
        {" "}
        <span className="text-ink-500">and</span>
        {" "}
        <a href="/books/budget" className="underline underline-offset-4">budget against actual</a>
      </p>

      {posts ? (
        <section aria-label="New journal entry" className="mt-6 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">New journal entry</h2>
          <ActionForm action={postJournal} submit="Post journal entry" className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <TextField label="Date" name="occurredOn" type="date" />
              <TextField label="What it is for" name="memo" placeholder="September rent" required />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-ink-500">
                    <th className="py-1 pr-2 font-medium">Account</th>
                    <th className="py-1 pr-2 font-medium">Debit</th>
                    <th className="py-1 pr-2 font-medium">Credit</th>
                    <th className="py-1 pr-2 font-medium">Line note</th>
                    {unitChoices.length > 0 ? <th className="py-1 pr-2 font-medium">Branch</th> : null}
                    <th className="py-1 pr-2 font-medium">Job number</th>
                    <th className="py-1 font-medium">Customer</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: JOURNAL_ROWS }, (_, i) => (
                    <tr key={i}>
                      <td className="py-1 pr-2"><input name={`account:${i}`} aria-label={`Line ${i + 1} account`} placeholder={i === 0 ? "6500" : ""} className="h-9 w-24 rounded border border-steel-300 bg-canvas px-2 font-mono" /></td>
                      <td className="py-1 pr-2"><input name={`debit:${i}`} aria-label={`Line ${i + 1} debit`} inputMode="decimal" className="h-9 w-32 rounded border border-steel-300 bg-canvas px-2 text-right font-mono" /></td>
                      <td className="py-1 pr-2"><input name={`credit:${i}`} aria-label={`Line ${i + 1} credit`} inputMode="decimal" className="h-9 w-32 rounded border border-steel-300 bg-canvas px-2 text-right font-mono" /></td>
                      <td className="py-1 pr-2"><input name={`memo:${i}`} aria-label={`Line ${i + 1} note`} className="h-9 w-full min-w-40 rounded border border-steel-300 bg-canvas px-2" /></td>
                      {unitChoices.length > 0 ? (
                        <td className="py-1 pr-2">
                          <select name={`branch:${i}`} aria-label={`Line ${i + 1} branch`} defaultValue="" className="h-9 rounded border border-steel-300 bg-canvas px-2">
                            <option value="">No branch</option>
                            {unitChoices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        </td>
                      ) : null}
                      <td className="py-1 pr-2"><input name={`job:${i}`} aria-label={`Line ${i + 1} job number`} placeholder={i === 0 ? "1042" : ""} className="h-9 w-24 rounded border border-steel-300 bg-canvas px-2 font-mono" /></td>
                      <td className="py-1"><input name={`customer:${i}`} aria-label={`Line ${i + 1} customer`} className="h-9 w-40 rounded border border-steel-300 bg-canvas px-2" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-ink-500">
              Accounts by number: 1000 cash, 5000 materials, 5100 to 5999 labour, 6000 and up expenses. Leave a date empty for today.
            </p>
            <p className="text-xs text-ink-500">
              A line can say what it is about: a branch, a job by its number, a customer by their name. A line on a job
              counts in that job&apos;s margin: revenue, materials (account 5000) and card fees. Hours are counted from the
              clock, so a labour line on a job is shown there and not counted. A cost that is already on one of the job&apos;s
              lines should not be booked to the job again here.
            </p>
          </ActionForm>
        </section>
      ) : null}

      {entries.length === 0 ? (
        <Empty title="No journal entries yet">Everything on the ledger so far came from an invoice, a payment or another document.</Empty>
      ) : (
        <ul className="mt-6 space-y-4">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-md border border-steel-200 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="font-medium">
                  Journal <span className="font-mono tabular-nums">{entry.number}</span>, {formatDay(entry.occurredOn, tz)}
                </p>
                <Money value={entry.total} />
              </div>
              <p className="mt-1 text-sm text-ink-700">{entry.memo}</p>
              <p className="mt-1 text-xs text-ink-500">
                Posted {formatIn(entry.createdAt, tz)}
                {entry.reversesNumber !== null ? `. Reverses journal ${entry.reversesNumber}` : ""}
                {entry.reversedByNumber !== null ? `. Reversed by journal ${entry.reversedByNumber}` : ""}
              </p>
              <table className="mt-2 w-full text-sm" aria-label={`Lines of journal ${entry.number}`}>
                <tbody>
                  {entry.lines.map((line) => (
                    <tr key={line.entryId}>
                      <td className="py-0.5 pr-3 font-mono">{line.accountCode}</td>
                      <td className="py-0.5 pr-3 text-ink-700">
                        {line.memo}
                        {line.businessUnitId || line.jobId || line.customerId ? (
                          <span className="ml-2 text-xs text-ink-500">
                            {[
                              line.businessUnitId ? line.branchName ?? "A branch" : null,
                              line.jobId ? `job ${line.jobNumber ?? ""}`.trim() : null,
                              line.customerId ? line.customerName ?? "A customer" : null,
                            ].filter(Boolean).join(", ")}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-0.5 pr-3 text-right">{line.direction === "debit" ? <Money value={line.amount} /> : null}</td>
                      <td className="py-0.5 text-right">{line.direction === "credit" ? <Money value={line.amount} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {posts && entry.reversesJournalId === null && entry.reversedByJournalId === null ? (
                <ActionForm action={reverseJournal} submit="Reverse it" tone="quiet" hidden={{ id: entry.id }} className="mt-2 flex items-center gap-3" />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
