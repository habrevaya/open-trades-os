import { reports, ConflictError, type ServiceContext } from "@opentradesos/api/services";
import type { reporting } from "@opentradesos/core";
import { ReportTable } from "@/components/ReportTable";

/**
 * Run a definition and show what came back, or say why it did not.
 *
 * Shared by the built-in reports, the saved ones and the builder, so a
 * refusal reads the same wherever it happens. `resolveReport` already writes
 * refusals in words somebody can act on ("This report needs: job.cost:read"),
 * and the job here is to put them on the screen rather than to rephrase them.
 */
export async function RunView({
  ctx, definition, action, timezone, hideRange,
}: {
  ctx: ServiceContext;
  definition: reporting.ReportDefinition;
  /** Where the date range form submits. */
  action: string;
  timezone: string;
  hideRange?: boolean;
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

  return (
    <div className="mt-6">
      {hideRange ? null : (
        /*
          A plain GET form, so the range ends up in the URL and a report
          somebody sends to their bookkeeper opens on the same months.
        */
        <form action={action} method="get" className="flex flex-wrap items-end gap-3">
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
        <ReportTable result={result!} timezone={timezone} />
      )}
    </div>
  );
}
