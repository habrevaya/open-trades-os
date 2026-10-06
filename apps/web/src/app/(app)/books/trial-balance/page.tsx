import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branches, ledgerReports } from "@opentradesos/api/services";
import { can, time } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { formatDay } from "@/lib/dates";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * BOOKS → TRIAL BALANCE
 *
 * Every account with its two sides, for the whole company or for one branch,
 * between two days in the company's own calendar.
 *
 * A BRANCH'S FIGURES SAY WHAT THEY LEAVE OUT. Postings carry a branch from the
 * day branches were carried on them, and only where the posting can be traced
 * to one: older postings have none, and neither do payroll, the release of
 * deferred revenue, or a payment spread over two branches. So under every
 * report is a line saying how many entries in these days carry no branch and
 * what they add up to, and "No branch" is a choice, so they can be read too.
 */
export default async function TrialBalancePage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const query = await searchParams;
  const one = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : "");

  if (!can(user.actor, "ledger:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Trial balance" />
        <Empty title="Not shown to your role">The books need the View the general ledger permission.</Empty>
      </div>
    );
  }

  const tz = user.organizationTimezone;
  const ctx = { actor: user.actor, db: getDb() };
  const from = DAY.test(one("from")) ? one("from") : "";
  const to = DAY.test(one("to")) ? one("to") : "";
  const options = await branches.options(ctx);
  const picked = one("branch");
  const businessUnitId = picked === "none" || options.branches.some((b) => b.id === picked) ? picked : "";

  /** Whole days where the company is: the end is the last moment of its day. */
  const report = await ledgerReports.trialBalance(ctx, {
    ...(from ? { from: time.startOfDayIn(from, tz).toISOString() } : {}),
    ...(to ? { to: new Date(time.startOfDayIn(time.addDays(to, 1), tz).getTime() - 1).toISOString() } : {}),
    ...(businessUnitId ? { businessUnitId } : {}),
  });
  const branchName = businessUnitId === "none"
    ? "No branch"
    : options.branches.find((b) => b.id === businessUnitId)?.name ?? null;
  const whole = businessUnitId === "";
  const covered = report.branch.entries - report.branch.withoutBranch;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title={`Trial balance${branchName ? `, ${branchName}` : ""}`} action={
        <a href="/books" className="text-sm underline underline-offset-4">Journal entries</a>
      } />

      <form method="get" action="/books/trial-balance" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-ink-700">From</span>
          <input type="date" name="from" defaultValue={from} className="mt-1 h-9 rounded border border-steel-300 bg-canvas px-2" />
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">To</span>
          <input type="date" name="to" defaultValue={to} className="mt-1 h-9 rounded border border-steel-300 bg-canvas px-2" />
        </label>
        {options.branches.length > 0 ? (
          <label className="text-sm">
            <span className="block text-ink-700">Branch</span>
            <select name="branch" defaultValue={businessUnitId} className="mt-1 h-9 rounded border border-steel-300 bg-canvas px-2">
              <option value="">Whole company</option>
              {options.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              <option value="none">No branch</option>
            </select>
          </label>
        ) : null}
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
          Show
        </button>
        <span className="text-xs text-ink-500">Both days are included.</span>
      </form>

      {report.rows.length === 0 ? (
        <Empty title="Nothing posted">No entries match these days{branchName ? ` in ${branchName}` : ""}.</Empty>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Trial balance">
            <thead>
              <tr className="border-b border-steel-200 text-left text-ink-500">
                <th className="py-2 pr-3 font-medium">Account</th>
                <th className="py-2 pr-3 text-right font-medium">Debits</th>
                <th className="py-2 pr-3 text-right font-medium">Credits</th>
                <th className="py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={`${row.accountCode}-${row.currency}`} className="border-b border-steel-200">
                  <td className="py-1.5 pr-3 font-mono">{row.accountCode}</td>
                  <td className="py-1.5 pr-3 text-right"><Money value={row.debits} /></td>
                  <td className="py-1.5 pr-3 text-right"><Money value={row.credits} /></td>
                  <td className="py-1.5 text-right"><Money value={row.balance} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td className="py-2 pr-3">Total</td>
                <td className="py-2 pr-3 text-right"><Money value={report.totalDebits} /></td>
                <td className="py-2 pr-3 text-right"><Money value={report.totalCredits} /></td>
                <td className="py-2" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {whole && !report.balanced ? (
        <p role="alert" className="mt-4 rounded-md border border-red-600 bg-red-tint p-3 text-sm text-red-600">
          The debits and the credits are not equal. Every other figure here is in doubt until that is explained.
        </p>
      ) : null}
      {!whole ? (
        <p className="mt-4 max-w-2xl text-sm text-ink-700">
          One branch&apos;s debits and credits need not be equal. A journal can give each of its lines a branch of its own,
          so a branch can hold one side of an entry.
        </p>
      ) : null}

      <p className="mt-4 max-w-2xl text-sm text-ink-700" data-testid="branch-coverage">
        {report.branch.entries === 0
          ? "There are no entries in these days."
          : report.branch.withoutBranch === 0
            ? `Every one of the ${report.branch.entries} entries in these days carries a branch.`
            : `${report.branch.withoutBranch} of the ${report.branch.entries} entries in these days carry no branch (${covered} do), and their debits add up to `}
        {report.branch.withoutBranch > 0 ? <Money value={report.branch.withoutBranchDebits} /> : null}
        {report.branch.withoutBranch > 0 ? "." : null}
      </p>
      <p className="mt-2 max-w-2xl text-xs text-ink-500">
        {report.branch.firstBranchedOn
          ? `Entries carry a branch from ${formatDay(report.branch.firstBranchedOn, tz)} on. Anything older has none, and nothing old is changed.`
          : "No entry carries a branch yet."}{" "}
        Payroll, deferred revenue released, and a payment spread over two branches belong to the company and have none.
      </p>
    </div>
  );
}
