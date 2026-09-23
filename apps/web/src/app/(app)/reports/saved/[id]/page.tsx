import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports } from "@opentradesos/api/services";
import { can, type reporting } from "@opentradesos/core";
import { PageHeader } from "@/components/Table";
import { queryFor } from "@/lib/report-params";
import { RunView } from "../../RunView";

export const dynamic = "force-dynamic";

/**
 * A report somebody saved.
 *
 * The definition is re-resolved against whoever is looking at it, not against
 * whoever saved it. That is what makes a saved report a stored question
 * rather than a stored permission: an owner saving "revenue by month" does
 * not thereby hand it to a technician, and the refusal says which permission
 * is missing.
 */
export default async function SavedReportPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireSetupUser();
  const { id } = await params;
  const range = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "report:read")) notFound();

  /**
   * Found in the list rather than fetched by id, so a report that row level
   * security hides is a 404 and not a distinguishable "exists but not
   * yours". There are tens of these, not thousands.
   */
  const saved = (await reports.list(ctx)).find((r) => r.id === id);
  if (!saved) notFound();

  const stored = saved.definition as unknown as reporting.ReportDefinition;
  const definition = {
    ...stored,
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <a href="/reports" className="text-sm text-ink-500 hover:underline">Reports</a>
      <div className="mt-2">
        <PageHeader
          title={saved.name}
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
      {saved.description ? <p className="mt-1 text-sm text-ink-700">{saved.description}</p> : null}

      <RunView
        ctx={ctx}
        definition={definition}
        action={`/reports/saved/${id}`}
        timezone={user.organizationTimezone}
      />
    </div>
  );
}
