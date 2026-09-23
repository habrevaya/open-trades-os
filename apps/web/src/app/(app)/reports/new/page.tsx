import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { PageHeader, Empty } from "@/components/Table";
import { definitionFrom, queryFor, type Params } from "@/lib/report-params";
import { RunView } from "../RunView";
import { Builder } from "./Builder";
import { SaveReport } from "./SaveReport";

export const dynamic = "force-dynamic";

/**
 * THE CUSTOM REPORT BUILDER
 *
 * Pick a dataset, pick what to group by, pick what to count. The whole state
 * lives in the query string, which means the builder needs no client state at
 * all: every change is a link or a form submit, the result is shareable, and
 * the back button does what it looks like it does.
 *
 * What it will not do is let anybody write SQL. The catalogue in
 * `report-catalogue.ts` is the entire vocabulary, and `available` trims it to
 * what the reader holds, so cost and margin are missing from a dispatcher's
 * list rather than present and refused.
 */
export default async function NewReportPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const user = await requireSetupUser();
  const params = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "report:build")) notFound();

  const datasets = reports.available(ctx);
  const definition = definitionFrom(params);
  const dataset = datasets.find((d) => d.key === definition?.dataset);

  /**
   * A definition is only run once it names a measure. Running an empty one
   * would greet somebody with a refusal before they had done anything wrong,
   * which teaches them the builder is broken.
   */
  const runnable = definition && dataset && definition.measures.length > 0;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <a href="/reports" className="text-sm text-ink-500 hover:underline">Reports</a>
      <div className="mt-2">
        <PageHeader title="Build a report" />
      </div>

      {datasets.length === 0 ? (
        <Empty title="Nothing to report on yet">
          A dataset needs the permission for the records it reads, and you hold
          none of them.
        </Empty>
      ) : (
        <>
          <Builder datasets={datasets} definition={definition} />

          {runnable ? (
            <>
              <RunView
                ctx={ctx}
                definition={definition}
                action="/reports/new"
                timezone={user.organizationTimezone}
                hideRange
              />
              <SaveReport query={queryFor(definition)} />
            </>
          ) : (
            <p className="mt-6 text-sm text-ink-500">
              {definition
                ? "Pick at least one thing to measure. A report with no measure is a list, and the record screens do lists better."
                : "Start by choosing what the report is about."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
