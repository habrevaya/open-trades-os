import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports, branches } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { PageHeader } from "@/components/Table";
import { queryFor, rangeQuery } from "@/lib/report-params";
import { RunView, PrintLink, printHref } from "../../RunView";

export const dynamic = "force-dynamic";

/**
 * One of the reports that ships with the product.
 *
 * Runs the stored definition through exactly the same path a hand-built one
 * takes, which is the point of writing them as definitions rather than as
 * eight special cases: a built-in report cannot see anything a person's own
 * report could not, and "edit a copy" is a link rather than a feature.
 */
export default async function BuiltInReportPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; to?: string; branch?: string; chart?: string; measure?: string }>;
}) {
  const user = await requireSetupUser();
  const { slug } = await params;
  const range = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "report:read")) notFound();

  /**
   * Looked up in the list the CALLER may run, not the whole set. A report
   * they cannot run is a 404 rather than a refusal page, so the URL does not
   * confirm that a report by that name exists.
   */
  const report = reports.builtIn(ctx).find((r) => r.slug === slug);
  if (!report) notFound();

  // The dates come off the URL so a range survives being shared, and so the
  // built-in reports get a range picker without each one declaring a default
  // that would go stale.
  const definition = {
    ...report.definition,
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...(range.branch ? { branchId: range.branch } : {}),
  };
  const view = { chart: range.chart, measure: range.measure };
  const branchOptions = await branches.options(ctx);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <a href="/reports" className="text-sm text-ink-500 hover:underline">Reports</a>
      <div className="mt-2">
        <PageHeader
          title={report.name}
          action={
            <div className="flex flex-wrap gap-2">
              <PrintLink href={printHref(queryFor(definition), report.name, view, `/reports/built-in/${slug}${rangeQuery(definition)}`)} />
              {can(user.actor, "report:build") ? (<>
              {/*
                Beside the report it sends, because "send me this every
                Monday" is a thought somebody has while looking at it.
              */}
              <a
                href={`/reports/schedules/new?report=${encodeURIComponent(`builtIn:${slug}`)}`}
                className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100"
              >
                Email on a schedule
              </a>
              <a
                href={`/reports/new?${queryFor(definition)}`}
                className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100"
              >
                Edit a copy
              </a>
              </>) : null}
            </div>
          }
        />
      </div>
      <p className="mt-1 text-sm text-ink-700">{report.question}</p>

      <RunView
        ctx={ctx}
        definition={definition}
        action={`/reports/built-in/${slug}`}
        timezone={user.organizationTimezone}
        title={report.name}
        back={`/reports/built-in/${slug}${rangeQuery(definition)}`}
        view={view}
        branchOptions={branchOptions}
      />
    </div>
  );
}
