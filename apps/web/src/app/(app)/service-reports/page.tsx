import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { serviceReports } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { REPORT_STATUS, REPORT_TONE } from "./labels";

export const dynamic = "force-dynamic";

const STATUSES = ["submitted", "published", "draft", "skipped"] as const;
type Status = (typeof STATUSES)[number];

/**
 * SERVICE REPORTS
 *
 * What was done at each visit, newest first, `GET /v1/service-reports` under
 * `servicereport:read` and the person's own scope (a branch manager sees their
 * branch's). "Out of range only" is the morning question: which visits had a
 * reading outside what the template says is normal. Filters are in the
 * address, so a filtered list can be bookmarked or sent to somebody.
 */
export default async function ServiceReportsPage({
  searchParams,
}: { searchParams: Promise<{ status?: string; out?: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "servicereport:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Service reports" />
        <Empty title="Service reports are not part of your access">Somebody who can change roles can turn this on.</Empty>
      </div>
    );
  }

  const params = await searchParams;
  const status = STATUSES.includes(params.status as Status) ? params.status as Status : undefined;
  const outOfRangeOnly = params.out === "1";
  const { reports } = await serviceReports.list(ctx, {
    ...(status ? { status } : {}), outOfRangeOnly, limit: 200,
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Service reports" count={reports.length} />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        What the technician recorded at each visit. A report reaches the customer only when somebody publishes it.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3" aria-label="Filter reports">
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Status</span>
          <select name="status" defaultValue={status ?? ""}
                  className="mt-1 h-10 rounded border border-steel-300 bg-canvas px-3 text-sm">
            <option value="">Any</option>
            {STATUSES.map((s) => <option key={s} value={s}>{REPORT_STATUS[s]}</option>)}
          </select>
        </label>
        <label className="inline-flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" name="out" value="1" defaultChecked={outOfRangeOnly} />
          Out of range only
        </label>
        <button type="submit"
                className="inline-flex h-10 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
          Show
        </button>
      </form>

      {reports.length === 0 ? (
        <Empty title={outOfRangeOnly ? "No reading out of range" : "No reports"}>
          {outOfRangeOnly
            ? "Every reading on these reports was inside the range its template allows."
            : "A report is written on the technician's phone at the visit."}
        </Empty>
      ) : (
        <Table label="Service reports"
               head={<><Th>When</Th><Th>Customer</Th><Th>Job</Th><Th>Readings</Th><Th>Status</Th></>}>
          {reports.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap">
                <a href={`/service-reports/${r.id}`} className="font-medium text-blue-600 underline underline-offset-4">
                  {r.submittedAt ? formatIn(r.submittedAt, zone) : "Not submitted"}
                </a>
              </Td>
              <Td>
                {r.customerName}
                {r.address ? <span className="block text-xs text-ink-500">{r.address}</span> : null}
                {r.summary ? <span className="block max-w-sm truncate text-xs text-ink-500">{r.summary}</span> : null}
              </Td>
              <Td className="font-mono tabular-nums">{r.jobNumber}</Td>
              <Td>
                {r.fieldCount}
                {r.outOfRangeCount > 0 ? (
                  <span className="ml-2"><Chip tone="warning">{r.outOfRangeCount} out of range</Chip></span>
                ) : null}
              </Td>
              <Td><Chip tone={REPORT_TONE[r.status]}>{REPORT_STATUS[r.status]}</Chip></Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
