import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketingOverview } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { todayIn, formatIn } from "@/lib/dates";
import { funnelQuery } from "../funnel-params";

export const dynamic = "force-dynamic";

/**
 * THE MARKETING OVERVIEW
 *
 * What Google saw beside what the company got, for one range of days: sessions
 * by source from Google Analytics and searches from Search Console, next to
 * the leads, booked jobs and revenue each source brought, by the funnel's own
 * rules and model. Sessions and leads are compared as a rate, never matched
 * one to one: a session is Google's count of visits and a lead is a person.
 */
export default async function OverviewPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const asked = funnelQuery(await searchParams, todayIn(user.organizationTimezone));
  const view = await marketingOverview.overview(ctx, { from: asked.from, to: asked.to });
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Marketing overview" />
      <p className="mt-2 max-w-3xl text-sm text-ink-700">
        Visits and searches as Google counts them, beside the leads, booked jobs and revenue each source brought,
        credited under {view.modelLabel.toLowerCase()}.
      </p>

      <form method="get" className="mt-5 flex flex-wrap items-end gap-3 rounded-md border border-steel-200 p-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">From</span>
          <input type="date" name="from" defaultValue={view.from} className="h-9 rounded border border-steel-300 px-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">To</span>
          <input type="date" name="to" defaultValue={view.to} className="h-9 rounded border border-steel-300 px-2" />
        </label>
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
          Show
        </button>
      </form>

      <section className="mt-6" aria-label="Where the figures come from">
        <ul className="flex flex-wrap gap-3 text-sm">
          {view.sources.map((s) => (
            <li key={s.provider} className="rounded border border-steel-200 px-3 py-2">
              <span className="font-medium">{s.label}</span>{" "}
              {s.status === "connected"
                ? <Chip tone="success">Connected</Chip>
                : s.status ? <Chip tone="warning">Needs attention</Chip> : <Chip tone="neutral">Not connected</Chip>}
              <span className="block text-xs text-ink-500">
                {s.lastPulledAt ? `Last read ${formatIn(s.lastPulledAt, zone)}` : s.status ? "Not read yet" : "Connect it on Settings, Integrations"}
              </span>
              {s.lastError ? <span className="block text-xs text-red-600">{s.lastError}</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <dl className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Sessions", String(view.totals.sessions)],
          ["Searches that clicked through", String(view.totals.searchClicks)],
          ["Times shown in search", String(view.totals.searchImpressions)],
          ["Leads", String(view.totals.leads)],
          ["Booked jobs", view.totals.booked],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-steel-200 p-3">
            <dt className="text-xs text-ink-500">{label}</dt>
            <dd className="text-lg font-semibold">{value}</dd>
          </div>
        ))}
        <div className="rounded border border-steel-200 p-3">
          <dt className="text-xs text-ink-500">Revenue</dt>
          <dd className="text-lg font-semibold"><Money value={view.totals.revenue} /></dd>
        </div>
      </dl>

      <section className="mt-8">
        <h2 className="text-base font-semibold">By source</h2>
        {view.rows.length === 0 ? (
          <Empty title="Nothing in this range">No sessions read and no leads recorded between these days.</Empty>
        ) : (
          <Table label="By source" head={<><Th>Source</Th><Th>Sessions</Th><Th>Engaged</Th><Th>Leads</Th><Th>Leads per 100 sessions</Th><Th>Booked</Th><Th>Revenue</Th></>}>
            {view.rows.map((r) => (
              <tr key={r.source}>
                <Td>
                  <span className="font-medium">{r.label}</span>
                  {r.channels.length > 0 ? <span className="block text-xs text-ink-500">{r.channels.join(", ")}</span> : null}
                </Td>
                <Td>{r.sessions}</Td>
                <Td>{r.engagedSessions}</Td>
                <Td>{r.leads}</Td>
                <Td>{r.leadsPer100Sessions ?? ""}</Td>
                <Td>{r.booked}</Td>
                <Td><Money value={r.revenue} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">What people searched</h2>
        {view.queries.length === 0 ? (
          <Empty title="No searches read">Connect Google Search Console on Settings, Integrations to see what people typed before they arrived.</Empty>
        ) : (
          <Table label="Searches" head={<><Th>Search</Th><Th>Clicks</Th><Th>Times shown</Th><Th>Average position</Th></>}>
            {view.queries.map((q) => (
              <tr key={q.query}>
                <Td>{q.query}</Td>
                <Td>{q.clicks}</Td>
                <Td>{q.impressions}</Td>
                <Td>{q.position ?? ""}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
