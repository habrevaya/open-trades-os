import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { assertCan, marketing as mk, money as m } from "@opentradesos/core";
import { guardedRead, ConflictError, type ServiceContext } from "./context";
import { funnel } from "./marketing-report";

/**
 * THE MARKETING OVERVIEW: WHAT GOOGLE SAW BESIDE WHAT THE COMPANY GOT
 *
 * The funnel answers "what did each channel bring". It cannot answer "how many
 * people looked", because a visit that did not ring or fill in a form is not
 * a lead. Google Analytics and Search Console know that half, and until now
 * nothing read them back. This puts them side by side for one date range:
 *
 *   SESSIONS BY SOURCE from Google Analytics, filed under the same catalogue
 *   keys the leads are, so "organic search: 1,240 sessions, 31 leads, 9
 *   booked" is one row.
 *
 *   SEARCHES from Search Console: what people typed, how often the site was
 *   shown and how often it was clicked.
 *
 *   LEADS, BOOKED JOBS AND REVENUE from the funnel, by the same rules and the
 *   same attribution model, so this page and the funnel never disagree.
 *
 * Sessions and leads are not matched one to one and never could be: a
 * session is Google's count of visits and a lead is a person. What is shown is
 * the rate, leads per hundred sessions, which is the honest comparison.
 */

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

export interface OverviewRow {
  source: string;
  label: string;
  channels: string[];
  sessions: number;
  engagedSessions: number;
  /** People credited to this source, a fraction under a split model. */
  leads: number;
  /** The same in ten thousandths of a person. */
  leadsWeight: number;
  booked: string;
  revenue: string;
  /** Leads per hundred sessions, or null with no sessions to divide by. */
  leadsPer100Sessions: string | null;
}

export async function overview(ctx: ServiceContext, input: { from: string; to: string }) {
  /** Who may read it first, so somebody who may not learns nothing from a refused range. */
  assertCan(ctx.actor, "adspend:read");
  if (!isoDate.test(input.from) || !isoDate.test(input.to) || input.from > input.to) {
    throw new ConflictError("Choose a range: a first day and a last day, the first not after the last.");
  }
  if (mk.daysBetween(input.from, input.to) > MAX_DAYS) throw new ConflictError("Choose a range of at most four hundred days.");
  const byChannel = await funnel(ctx, { from: input.from, to: input.to, by: "channel" });

  return guardedRead(ctx, "adspend:read", async (tx) => {
    const org = ctx.actor.organizationId;
    const channels = await tx.select({ id: schema.marketingChannel.id, name: schema.marketingChannel.name, sourceKey: schema.marketingChannel.sourceKey })
      .from(schema.marketingChannel).where(eq(schema.marketingChannel.organizationId, org));
    const keyOf = new Map(channels.map((c) => [c.id, c.sourceKey]));

    const sessions = await tx.select({
      source: schema.analyticsSessionDay.source,
      sessions: sql<number>`sum(${schema.analyticsSessionDay.sessions})::int`,
      engaged: sql<number>`sum(${schema.analyticsSessionDay.engagedSessions})::int`,
    }).from(schema.analyticsSessionDay).where(and(
      eq(schema.analyticsSessionDay.organizationId, org),
      gte(schema.analyticsSessionDay.day, input.from), lte(schema.analyticsSessionDay.day, input.to),
    )).groupBy(schema.analyticsSessionDay.source);

    const rows = new Map<string, { channels: string[]; sessions: number; engaged: number; leadsWeight: number; bookedWeight: number; revenue: m.Money }>();
    const at = (key: string) => {
      let row = rows.get(key);
      if (!row) {
        row = { channels: [], sessions: 0, engaged: 0, leadsWeight: 0, bookedWeight: 0, revenue: m.zero() };
        rows.set(key, row);
      }
      return row;
    };
    for (const s of sessions) {
      const row = at(s.source);
      row.sessions += s.sessions;
      row.engaged += s.engaged;
    }
    for (const r of byChannel.rows) {
      const key = keyOf.get(r.key) ?? "unknown";
      const row = at(key);
      row.channels.push(r.label);
      row.leadsWeight += r.leadsWeight;
      row.bookedWeight += r.bookedWeight;
      row.revenue = m.add(row.revenue, m.money(r.revenue));
    }

    const out: OverviewRow[] = [...rows.entries()].map(([source, r]) => ({
      source,
      label: source === "unknown" ? "Not attributed" : mk.leadSourceLabel(source),
      channels: r.channels,
      sessions: r.sessions,
      engagedSessions: r.engaged,
      leads: r.leadsWeight / mk.WEIGHT_SCALE,
      leadsWeight: r.leadsWeight,
      booked: mk.weightText(r.bookedWeight),
      revenue: m.toString(m.round(r.revenue, 2)),
      leadsPer100Sessions: r.sessions > 0 ? ((r.leadsWeight * 100) / (r.sessions * mk.WEIGHT_SCALE)).toFixed(1) : null,
    })).sort((a, b) => b.sessions - a.sessions || b.leadsWeight - a.leadsWeight || a.label.localeCompare(b.label));

    const queries = await tx.select({
      query: schema.searchQueryDay.query,
      clicks: sql<number>`sum(${schema.searchQueryDay.clicks})::int`,
      impressions: sql<number>`sum(${schema.searchQueryDay.impressions})::int`,
      /** Average position weighted by impressions, which is how Search Console itself averages it. */
      position: sql<string | null>`round(sum(${schema.searchQueryDay.position} * ${schema.searchQueryDay.impressions}) / nullif(sum(${schema.searchQueryDay.impressions}), 0), 1)::text`,
    }).from(schema.searchQueryDay).where(and(
      eq(schema.searchQueryDay.organizationId, org),
      gte(schema.searchQueryDay.day, input.from), lte(schema.searchQueryDay.day, input.to),
    )).groupBy(schema.searchQueryDay.query)
      .orderBy(desc(sql`sum(${schema.searchQueryDay.clicks})`), desc(sql`sum(${schema.searchQueryDay.impressions})`))
      .limit(50);
    const [searchTotals] = await tx.select({
      clicks: sql<number>`coalesce(sum(${schema.searchQueryDay.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${schema.searchQueryDay.impressions}), 0)::int`,
    }).from(schema.searchQueryDay).where(and(
      eq(schema.searchQueryDay.organizationId, org),
      gte(schema.searchQueryDay.day, input.from), lte(schema.searchQueryDay.day, input.to),
    ));

    /** Whether each read back is connected, and when it last read, so an empty table says why. */
    const connections = await tx.select().from(schema.integrationConnection).where(and(
      eq(schema.integrationConnection.organizationId, org),
      inArray(schema.integrationConnection.provider, ["search_console", "ga4_data"]),
      isNull(schema.integrationConnection.deletedAt),
    ));
    const sources = [];
    for (const provider of ["ga4_data", "search_console"] as const) {
      const connection = connections.find((c) => c.provider === provider && c.status !== "disconnected");
      const [run] = connection
        ? await tx.select().from(schema.syncRun).where(and(
          eq(schema.syncRun.connectionId, connection.id), eq(schema.syncRun.entityType, "analytics"),
        )).orderBy(desc(schema.syncRun.startedAt)).limit(1)
        : [];
      sources.push({
        provider,
        label: provider === "ga4_data" ? "Google Analytics 4 reports" : "Google Search Console",
        status: connection?.status ?? null,
        lastPulledAt: run?.finishedAt?.toISOString() ?? null,
        lastError: run?.error ?? connection?.lastError ?? null,
      });
    }

    return {
      from: input.from,
      to: input.to,
      model: byChannel.model,
      modelLabel: byChannel.modelLabel,
      rows: out,
      totals: {
        sessions: out.reduce((sum, r) => sum + r.sessions, 0),
        engagedSessions: out.reduce((sum, r) => sum + r.engagedSessions, 0),
        leads: byChannel.total.leads,
        leadsWeight: byChannel.total.leadsWeight,
        booked: byChannel.total.booked,
        revenue: m.toString(m.round(m.money(byChannel.total.revenue), 2)),
        searchClicks: searchTotals?.clicks ?? 0,
        searchImpressions: searchTotals?.impressions ?? 0,
      },
      queries: queries.map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, position: q.position })),
      sources,
    };
  });
}
