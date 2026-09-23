import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { PageHeader } from "@/components/Table";
import { queryFor } from "@/lib/report-params";
import { RunView } from "../../RunView";

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
  searchParams: Promise<{ from?: string; to?: string }>;
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
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <a href="/reports" className="text-sm text-ink-500 hover:underline">Reports</a>
      <div className="mt-2">
        <PageHeader
          title={report.name}
          action={can(user.actor, "report:build") ? (
            <a
              href={`/reports/new?${queryFor(definition)}`}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100"
            >
              Edit a copy
            </a>
          ) : null}
        />
      </div>
      <p className="mt-1 text-sm text-ink-700">{report.question}</p>

      <RunView
        ctx={ctx}
        definition={definition}
        action={`/reports/built-in/${slug}`}
        timezone={user.organizationTimezone}
      />
    </div>
  );
}
