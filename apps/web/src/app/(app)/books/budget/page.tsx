import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branches, budgets, jobs } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { saveBudgetLine, importBudgetFile, chooseForecast } from "../actions";

export const dynamic = "force-dynamic";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dollars = (value: string) =>
  Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Over or under, in words a person reads, with the colour only as a second signal. */
function Verdict({ favourable, children }: { favourable: boolean | null; children: React.ReactNode }) {
  const tone = favourable === null ? "text-ink-700" : favourable ? "text-green-700" : "text-red-600";
  return <span className={tone}>{children}</span>;
}

/**
 * BOOKS → BUDGET
 *
 * The year's budget beside what the ledger says happened, by line and month,
 * with how far off each is and whether that is good. Entered here a line at a
 * time, or loaded from a spreadsheet.
 *
 * For the whole company, one branch or one job type. A branch's budget is
 * its own lines against what the ledger put in that branch, and the page says
 * how much of the year's ledger carries no branch, because a branch that looks
 * under budget may only be missing the postings nobody could trace to it. A
 * job type's is the same against the entries on its jobs, and says how much
 * was booked to no job.
 *
 * Every line has a year end forecast beside it, with the assumption it rests
 * on written above the table: an estimate, never a promise.
 */
export default async function BudgetPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const query = await searchParams;
  const thisYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: user.organizationTimezone, year: "numeric" }).format(new Date()));
  const asked = Number(typeof query["year"] === "string" ? query["year"] : thisYear);
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : thisYear;

  if (!can(user.actor, "report.financial:read")) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
        <PageHeader title="Budget" />
        <Empty title="Not shown to your role">The budget is a financial report, and needs the View financial reports permission.</Empty>
      </div>
    );
  }

  const ctx = { actor: user.actor, db: getDb() };
  /** The branch choice is offered only to somebody who may list branches, and only when there are some. */
  const options = (["job:read", "customer:read", "invoice:read", "estimate:read", "report:read"] as const).some((p) => can(user.actor, p))
    ? (await branches.options(ctx)).branches
    : [];
  /** Job types, switched off ones too, because a year already budgeted for one can still be read. */
  const types = can(user.actor, "job:read") ? (await jobs.listTypes(ctx, { includeInactive: true })).data : [];
  const picked = typeof query["branch"] === "string" ? query["branch"] : "";
  const pickedType = typeof query["type"] === "string" ? query["type"] : "";
  const chosenBranch = options.some((b) => b.id === picked) ? picked : "";
  const chosenType = types.some((t) => t.id === pickedType) ? pickedType : "";
  /** A line is a branch's or a job type's, never both: asked for both, the page says so and shows the company. */
  const both = chosenBranch !== "" && chosenType !== "";
  const businessUnitId = both ? "" : chosenBranch;
  const jobTypeId = both ? "" : chosenType;
  const report = await budgets.report(ctx, {
    year, ...(businessUnitId ? { businessUnitId } : {}), ...(jobTypeId ? { jobTypeId } : {}),
  });
  const writes = can(user.actor, "finance:configure");
  const branchHidden: Record<string, string> = businessUnitId ? { businessUnitId } : jobTypeId ? { jobTypeId } : {};
  const here = (y: number) =>
    `/books/budget?year=${y}${businessUnitId ? `&branch=${businessUnitId}` : ""}${jobTypeId ? `&type=${jobTypeId}` : ""}`;
  const scopeName = report.branch?.name ?? report.jobType?.name ?? null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title={`Budget ${year}${scopeName ? `, ${scopeName}` : ""}`} action={
        <nav aria-label="Year" className="flex gap-3 text-sm">
          <a href={here(year - 1)} className="underline underline-offset-4">{year - 1}</a>
          <a href={here(year + 1)} className="underline underline-offset-4">{year + 1}</a>
        </nav>
      } />
      {options.length > 0 || types.length > 0 ? (
        <form method="get" action="/books/budget" className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="year" value={String(year)} />
          {options.length > 0 ? (
            <label className="text-sm">
              <span className="block text-ink-700">Branch</span>
              <select name="branch" defaultValue={businessUnitId} className="mt-1 h-9 rounded border border-steel-300 bg-canvas px-2">
                <option value="">The whole company</option>
                {options.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          ) : null}
          {types.length > 0 ? (
            <label className="text-sm">
              <span className="block text-ink-700">Job type</span>
              <select name="type" defaultValue={jobTypeId} className="mt-1 h-9 rounded border border-steel-300 bg-canvas px-2">
                <option value="">Every job type</option>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.active ? "" : " (switched off)"}</option>)}
              </select>
            </label>
          ) : null}
          <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
            Show
          </button>
        </form>
      ) : null}
      {both ? (
        <p role="alert" className="mt-2 max-w-3xl text-sm text-red-600">
          A budget is the whole company&apos;s, one branch&apos;s or one job type&apos;s. Pick a branch or a job type, not
          both. This is the whole company&apos;s.
        </p>
      ) : null}
      <p className="mt-2 max-w-3xl text-sm text-ink-700">{report.caveat}</p>
      {report.jobType ? (
        <p className="mt-2 max-w-3xl text-sm text-ink-700" data-testid="budget-job-type-coverage">
          This is the {report.jobType.name} budget against what the books put on {report.jobType.name} jobs: their
          invoices, discounts, card fees and anything journalled to one of them. In {year},{" "}
          {report.jobType.entriesWithoutJob} ledger {report.jobType.entriesWithoutJob === 1 ? "entry is" : "entries are"} on
          no job (debits of <Money value={report.jobType.withoutJobDebits} />): rent, trucks, payroll and anything not booked
          to a job. None of that is in these figures.
        </p>
      ) : report.branch ? (
        <p className="mt-2 max-w-3xl text-sm text-ink-700" data-testid="budget-branch-coverage">
          This is {report.branch.name}&apos;s own budget against what the books put in {report.branch.name}. In {year},{" "}
          {report.branch.entriesWithoutBranch} ledger {report.branch.entriesWithoutBranch === 1 ? "entry carries" : "entries carry"} no
          branch (debits of <Money value={report.branch.withoutBranchDebits} />): payroll, payments spread over two branches and
          anything from before branches were recorded. None of that is in these figures.
        </p>
      ) : options.length > 0 || types.length > 0 ? (
        <p className="mt-2 max-w-3xl text-sm text-ink-700">
          The whole company&apos;s budget is the lines set for the company. A branch&apos;s lines are its own and are not added in here.
          {types.length > 0 ? " Nor are a job type's." : null}
        </p>
      ) : null}

      {report.lines.length > 0 ? (
        <p className="mt-4 max-w-3xl text-sm text-ink-700" data-testid="budget-forecast-assumption">
          <strong>How the forecast is made.</strong> {report.forecast.assumption}
        </p>
      ) : null}

      {report.lines.length === 0 ? (
        <Empty title={`No budget for ${year}${scopeName ? ` for ${scopeName}` : ""} yet`}>Add a line below, or load the year from a spreadsheet.</Empty>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm" aria-label={`Budget against actual, ${year}`}>
            <thead>
              <tr className="border-b border-steel-200 text-left text-ink-500">
                <th className="py-2 pr-3 font-medium">Line</th>
                {MONTHS.map((m) => <th key={m} className="py-2 pr-2 text-right font-medium">{m}</th>)}
                <th className="py-2 pr-3 text-right font-medium">Year to date</th>
                <th className="py-2 text-right font-medium">Year end forecast</th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((line) => (
                <tr key={line.line} className="border-b border-steel-200 align-top">
                  <td className="py-2 pr-3 font-medium">{line.label}</td>
                  {line.months.map((month) => (
                    <td key={month.month} className="py-2 pr-2 text-right">
                      <span className="block text-xs text-ink-500">{month.budget === null ? "" : <Money value={month.budget} muted />}</span>
                      {month.month <= report.through ? <Money value={month.actual} /> : null}
                      {month.variance !== null ? (
                        <span className="block text-xs"><Verdict favourable={month.favourable}>{dollars(month.variance)}</Verdict></span>
                      ) : null}
                    </td>
                  ))}
                  <td className="py-2 pr-3 text-right">
                    <span className="block text-xs text-ink-500">Budget <Money value={line.toDate.budget} muted /></span>
                    <Money value={line.toDate.actual} />
                    <span className="block text-xs">
                      <Verdict favourable={line.toDate.favourable}>
                        {line.toDate.favourable === null ? "On budget" : line.toDate.favourable ? "Better by " : "Worse by "}
                        {line.toDate.favourable === null ? null : dollars(line.toDate.variance.replace("-", ""))}
                        {line.toDate.percent !== null && line.toDate.favourable !== null ? ` (${Math.abs(line.toDate.percent)}%)` : ""}
                      </Verdict>
                    </span>
                  </td>
                  <td className="py-2 text-right" data-testid="budget-forecast">
                    <span className="block text-xs text-ink-500">Year&apos;s budget <Money value={line.year.budget} muted /></span>
                    <Money value={line.forecast.forecast} />
                    <span className="block text-xs">
                      <Verdict favourable={line.forecast.favourable}>
                        {line.forecast.favourable === null ? "On budget" : line.forecast.favourable ? "Better by " : "Worse by "}
                        {line.forecast.favourable === null ? null : dollars(line.forecast.variance.replace("-", ""))}
                      </Verdict>
                    </span>
                    {line.forecast.unbudgetedMonths > 0 ? (
                      <span className="block text-xs text-ink-500">
                        {line.forecast.unbudgetedMonths} {line.forecast.unbudgetedMonths === 1 ? "month" : "months"} with no budget counted as nothing
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-500">
            Each month: the budget above, what the ledger says below, and the difference under that.
            {report.net ? <> Revenue less costs, year to date: budget <Money value={report.net.budget} />, actual <Money value={report.net.actual} />.</> : null}
            {report.forecast.net ? <> At year end, forecast <Money value={report.forecast.net.forecast} /> against a budget of <Money value={report.forecast.net.budget} />.</> : null}
          </p>
        </div>
      )}

      {writes ? (
        <>
          <section aria-label="The forecast" className="mt-8 rounded-md border border-steel-200 p-4">
            <h2 className="text-base font-semibold">The forecast</h2>
            <p className="mt-1 text-sm text-ink-700">
              The months already over are what the books say. Choose how this month and the rest of {year} are
              counted. The budget is the safer choice. The run rate is the average month so far, which suits a
              year that has stopped looking like its budget and misleads in a seasonal business. This choice is
              for the whole of {year}, and every branch and job type uses it too.
            </p>
            <ActionForm action={chooseForecast} submit="Use this" hidden={{ year: String(year) }} className="mt-3 flex flex-wrap items-end gap-3">
              <Select label="The months to come" name="method" defaultValue={report.forecast.chosen} options={[
                { value: "budget", label: "At their budget" },
                { value: "run_rate", label: "At the run rate so far" },
              ]} />
            </ActionForm>
          </section>

          <section aria-label="Set a line" className="mt-8 rounded-md border border-steel-200 p-4">
            <h2 className="text-base font-semibold">Set a line</h2>
            <p className="mt-1 text-sm text-ink-700">
              Revenue, Materials, Labour, Overhead, or an account number such as 6100. Setting a line again replaces
              all twelve months; leave a month empty for no budget in it.
            </p>
            <ActionForm action={saveBudgetLine} submit="Save line" hidden={{ year: String(year), ...branchHidden }} className="mt-3 space-y-3">
              <TextField label="Line" name="line" placeholder="Revenue" required className="block max-w-xs" />
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
                {MONTHS.map((m, i) => (
                  <TextField key={m} label={m} name={`month:${i + 1}`} inputMode="decimal" />
                ))}
              </div>
            </ActionForm>
            {report.lines.length > 0 ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium">Change a line already in the budget</summary>
                {report.lines.map((line) => (
                  <ActionForm key={line.line} action={saveBudgetLine} submit={`Save ${line.label}`}
                              hidden={{ year: String(year), line: line.line, ...branchHidden }} className="mt-3 space-y-2">
                    <p className="text-sm font-medium">{line.label}</p>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
                      {line.months.map((month) => (
                        <TextField key={month.month} label={MONTHS[month.month - 1]!} name={`month:${month.month}`}
                                   inputMode="decimal" defaultValue={month.budget === null ? "" : Number(month.budget).toFixed(2)} />
                      ))}
                    </div>
                  </ActionForm>
                ))}
              </details>
            ) : null}
          </section>

          <section aria-label="Load from a spreadsheet" className="mt-6 rounded-md border border-steel-200 p-4">
            <h2 className="text-base font-semibold">Load from a spreadsheet</h2>
            <p className="mt-1 text-sm text-ink-700">
              A CSV with a header row of months and one row per line: <code className="text-xs">Line,Jan,Feb,...,Dec</code>.
              Each line in the file replaces that line; lines not in it are kept. Nothing is loaded unless the whole file reads.
            </p>
            <ActionForm action={importBudgetFile} submit="Load the budget" hidden={{ year: String(year), ...branchHidden }} className="mt-3 space-y-3">
              <label className="block text-sm">
                <span className="font-medium text-ink-700">File</span>
                <input type="file" name="file" accept=".csv,text/csv" className="mt-1 block text-sm" />
              </label>
              <TextArea label="Or paste it" name="csv" rows={4} placeholder={"Line,Jan,Feb,Mar\nRevenue,80000,85000,90000"} />
            </ActionForm>
          </section>
        </>
      ) : null}
    </div>
  );
}
