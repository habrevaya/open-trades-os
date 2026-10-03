import { reports, ConflictError, type ServiceContext, type branches } from "@opentradesos/api/services";
import type { reporting } from "@opentradesos/core";
import { ReportTable } from "@/components/ReportTable";
import { ReportChart, additivityFor } from "@/components/ReportChart";
import { drillHref } from "@/lib/drill";

export interface ChartView {
  /** `line` or `columns`, for a dated report. */
  chart?: string | undefined;
  /** Which measure the chart draws. */
  measure?: string | undefined;
}

/**
 * Run a definition and show what came back, or say why it did not.
 *
 * Shared by the built-in reports, the saved ones and the builder, so a
 * refusal reads the same wherever it happens. `resolveReport` already writes
 * refusals in words somebody can act on ("This report needs: job.cost:read"),
 * and the job here is to put them on the screen rather than to rephrase them.
 *
 * The chart is drawn from the same result as the table, once, above it. Not a
 * second query: a chart and a table that came from two reads are two answers
 * that can disagree.
 */
export async function RunView({
  ctx, definition, action, timezone, hideRange, title, back, view = {}, here, branchOptions,
}: {
  ctx: ServiceContext;
  definition: reporting.ReportDefinition;
  /** Where the date range form submits. */
  action: string;
  timezone: string;
  hideRange?: boolean;
  /** The report's name, which the records behind a number are headed with. */
  title: string;
  /** This page with its dates, which the records behind a number link back to. */
  back: string;
  /** How the chart is drawn, from the address. */
  view?: ChartView;
  /**
   * This page's address with its dates and branch, so the chart's toggles
   * keep them. Defaults to `back`, which is the same thing on every page that
   * has a range.
   */
  here?: string;
  /** The branches to offer, or nothing when there are none or the reader sees one already. */
  branchOptions?: branches.BranchOptions | null;
}) {
  let result: reports.ReportResult | null = null;
  let refusal: string | null = null;

  try {
    result = await reports.run(ctx, definition);
  } catch (error) {
    // A refusal is an answer, not a crash. Anything else is a crash and
    // belongs in the error boundary rather than swallowed here.
    if (!(error instanceof ConflictError)) throw error;
    refusal = error.message;
  }

  const offerBranches = !!branchOptions && !branchOptions.narrowed && branchOptions.branches.length > 0;
  const prefer = view.chart === "columns" ? "columns" as const : view.chart === "line" ? "line" as const : undefined;
  /** This page as it is now, chart choices included, so changing one keeps the other. */
  const current = withParams(here ?? back, {
    ...(view.chart ? { chart: view.chart } : {}),
    ...(view.measure ? { measure: view.measure } : {}),
  });
  const toggle = (kind: string) => withParams(current, { chart: kind });
  const dataset = reports.CATALOGUE.find((d) => d.key === definition.dataset);

  return (
    <div className="mt-6">
      {hideRange ? null : (
        /*
          A plain GET form, so the range ends up in the URL and a report
          somebody sends to their bookkeeper opens on the same months.
        */
        <form action={action} method="get" className="flex flex-wrap items-end gap-3 print:hidden">
          <label className="text-sm">
            <span className="block text-ink-700">From</span>
            <input
              type="date" name="from" defaultValue={definition.from ?? ""}
              className="mt-1 h-9 rounded border border-steel-300 px-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-ink-700">To</span>
            <input
              type="date" name="to" defaultValue={definition.to ?? ""}
              className="mt-1 h-9 rounded border border-steel-300 px-2"
            />
          </label>
          {offerBranches ? (
            /*
              Only for somebody who sees the whole company. A Houston manager
              is already looking at Houston, and a list of other branches to
              pick would be a list of empty reports.
            */
            <label className="text-sm">
              <span className="block text-ink-700">Branch</span>
              <select
                name="branch" defaultValue={definition.branchId ?? ""}
                className="mt-1 h-9 rounded border border-steel-300 px-2"
              >
                <option value="">Every branch</option>
                {branchOptions.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          ) : null}
          {view.chart ? <input type="hidden" name="chart" value={view.chart} /> : null}
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100"
          >
            Apply
          </button>
          {/*
            Said where the dates are set, because an exclusive end date is the
            thing people get wrong about every reporting tool they have used.
          */}
          <span className="text-xs text-ink-500">To is exclusive.</span>
        </form>
      )}

      {refusal ? (
        <p role="alert" className="mt-6 rounded-md border border-red-600 bg-red-tint p-4 text-sm text-red-600">
          {refusal}
        </p>
      ) : (
        <>
          {result!.rows.length > 0 ? (
            <ReportChart
              result={result!}
              measure={view.measure}
              prefer={prefer}
              additive={additivityFor(dataset)}
              drill={(row) => drillHref(definition, row, { title, back })}
              title={title}
              toggle={toggle}
              pick={(key) => withParams(current, { measure: key })}
            />
          ) : null}
          <ReportTable
            result={result!} timezone={timezone}
            drill={(row) => drillHref(definition, row, { title, back })}
          />
        </>
      )}
    </div>
  );
}

/** An address with some query parameters set, keeping the rest. */
export function withParams(address: string, extra: Record<string, string>): string {
  const [path, query = ""] = address.split("?");
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const text = params.toString();
  return text ? `${path}?${text}` : path!;
}

/**
 * The print view of a definition, with the chart that was on the screen.
 * The whole definition travels in the address, as it does for the builder
 * and the records behind a number, so the printed page is the same report
 * run again rather than a copy of this one.
 */
export function printHref(query: string, title: string, view: ChartView = {}, back?: string): string {
  const params = new URLSearchParams(query);
  params.set("title", title);
  if (back) params.set("back", back);
  if (view.chart) params.set("chart", view.chart);
  if (view.measure) params.set("measure", view.measure);
  return `/reports/print?${params.toString()}`;
}

/** The link to the print view, beside the other actions on a report. */
export function PrintLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100"
    >
      Print or save as PDF
    </a>
  );
}
