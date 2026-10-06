import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports, branches, ConflictError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ReportTable } from "@/components/ReportTable";
import { ReportChart, additivityFor } from "@/components/ReportChart";
import { PrintButton } from "@/components/PrintButton";
import { definitionFrom, type Params } from "@/lib/report-params";
import { describeDefinition } from "@/lib/report-words";
import { safeBack } from "@/lib/drill";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Print a report" };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

/**
 * A REPORT ON PAPER, OR AS A PDF
 *
 * The same definition the screen ran, run again from the address (as the
 * builder and the records behind a number are), and laid out for a printer:
 * the company's name, what the report is, the dates and filters in words, the
 * chart and every row. "Save as PDF" is the browser's own print dialog, which
 * every browser has and which produces a better PDF than anything this
 * product would generate on the server, with nothing to install.
 *
 * Every number is printed, not linked: a printed link opens nothing, and the
 * screen version is a click away for anybody who wants the records.
 */
export default async function PrintReportPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireSetupUser();
  if (!can(user.actor, "report:read")) notFound();
  const params = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };

  const definition = definitionFrom(params);
  if (!definition) notFound();
  const title = first(params.title) ?? "Report";
  const chart = first(params.chart);
  const measure = first(params.measure);
  const split = first(params.split);
  const arrange = first(params.arrange) === "grouped" ? "grouped" as const : first(params.arrange) === "stacked" ? "stacked" as const : undefined;
  const back = safeBack(params.back);

  let result: reports.ReportResult | null = null;
  let refusal: string | null = null;
  try {
    result = await reports.run(ctx, definition);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    refusal = error.message;
  }

  /** The company's own catalogue, so a report on a custom field or a kind of record finds its labels. */
  const dataset = (await reports.datasetFor(ctx, definition.dataset)) ?? undefined;
  const branchName = definition.branchId
    ? (await branches.options(ctx)).branches.find((b) => b.id === definition.branchId)?.name ?? null
    : null;
  const described = describeDefinition(definition, dataset, user.organizationTimezone, branchName);
  const printed = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium", timeStyle: "short", timeZone: user.organizationTimezone,
  }).format(new Date());

  return (
    <article>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <a href={back} className="text-sm text-ink-500 hover:underline">Back</a>
        <PrintButton label="Print or save as PDF" />
      </div>

      <header className="mt-6 border-b border-steel-200 pb-4 print:mt-0">
        <p className="text-sm text-ink-500">{user.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-ink-700">
          {described.length > 0 ? `${described.join(". ")}.` : "Every date, every record this report reads."}
        </p>
        <p className="mt-1 text-xs text-ink-500">Printed {printed} by {user.name ?? user.email}.</p>
      </header>

      {refusal ? (
        <p role="alert" className="mt-6 rounded-md border border-red-600 bg-red-tint p-4 text-sm text-red-600">
          {refusal}
        </p>
      ) : (
        <>
          {result!.rows.length > 0 ? (
            <ReportChart
              result={result!}
              measure={measure}
              split={split}
              arrange={arrange}
              prefer={chart === "columns" ? "columns" : chart === "line" ? "line" : undefined}
              additive={additivityFor(dataset)}
              title={title}
            />
          ) : null}
          <div className="mt-6">
            <ReportTable result={result!} timezone={user.organizationTimezone} />
          </div>
        </>
      )}
    </article>
  );
}
