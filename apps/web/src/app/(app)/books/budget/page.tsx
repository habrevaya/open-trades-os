import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { budgets } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { saveBudgetLine, importBudgetFile } from "../actions";

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

  const report = await budgets.report({ actor: user.actor, db: getDb() }, { year });
  const writes = can(user.actor, "finance:configure");

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title={`Budget ${year}`} action={
        <nav aria-label="Year" className="flex gap-3 text-sm">
          <a href={`/books/budget?year=${year - 1}`} className="underline underline-offset-4">{year - 1}</a>
          <a href={`/books/budget?year=${year + 1}`} className="underline underline-offset-4">{year + 1}</a>
        </nav>
      } />
      <p className="mt-2 max-w-3xl text-sm text-ink-700">{report.caveat}</p>

      {report.lines.length === 0 ? (
        <Empty title={`No budget for ${year} yet`}>Add a line below, or load the year from a spreadsheet.</Empty>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm" aria-label={`Budget against actual, ${year}`}>
            <thead>
              <tr className="border-b border-steel-200 text-left text-ink-500">
                <th className="py-2 pr-3 font-medium">Line</th>
                {MONTHS.map((m) => <th key={m} className="py-2 pr-2 text-right font-medium">{m}</th>)}
                <th className="py-2 text-right font-medium">Year to date</th>
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
                  <td className="py-2 text-right">
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
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-500">
            Each month: the budget above, what the ledger says below, and the difference under that.
            {report.net ? <> Revenue less costs, year to date: budget <Money value={report.net.budget} />, actual <Money value={report.net.actual} />.</> : null}
          </p>
        </div>
      )}

      {writes ? (
        <>
          <section aria-label="Set a line" className="mt-8 rounded-md border border-steel-200 p-4">
            <h2 className="text-base font-semibold">Set a line</h2>
            <p className="mt-1 text-sm text-ink-700">
              Revenue, Materials, Labour, Overhead, or an account number such as 6100. Setting a line again replaces
              all twelve months; leave a month empty for no budget in it.
            </p>
            <ActionForm action={saveBudgetLine} submit="Save line" hidden={{ year: String(year) }} className="mt-3 space-y-3">
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
                              hidden={{ year: String(year), line: line.line }} className="mt-3 space-y-2">
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
            <ActionForm action={importBudgetFile} submit="Load the budget" hidden={{ year: String(year) }} className="mt-3 space-y-3">
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
