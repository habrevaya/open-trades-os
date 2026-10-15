import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, location as loc, reporting, time, type Actor } from "@opentradesos/core";
import { inTenant, timezoneOf, type ServiceContext } from "./context";

/**
 * A PERSON'S ROUTE DAY, KEPT AFTER THE POSITIONS ARE GONE
 *
 * Route density (the pest and lawn packs) is completed stops over the miles
 * driven between them, for a month. The miles can only come from the phone's
 * positions, and those are deleted after the company's retention (three days
 * unless it says otherwise) on purpose: a history of where a person went is a
 * record a company should not hold without a reason. So a month's figure
 * could never be read from them.
 *
 * What is kept instead is the smallest thing the figure needs: for each person
 * and each finished day, how many stops they completed, how many drives there
 * were between them, and how far those drives were. Worked out by core's
 * `reporting.routeDay`, which never reads the way out to the first stop or the
 * way home from the last, and keeps a day whose positions have a gap on a
 * drive as `gap`, with no miles, rather than reading it short.
 *
 * WHEN. On the worker's pass, before the purge, for every day that has ended
 * in the company's calendar and still has positions. A day is read again when
 * positions for it arrived after it was last read (a phone that was offline
 * and synced the next morning), and never from fewer positions than it was
 * read from before, so the purge taking the first hours of a day away cannot
 * shrink a day already summed. A day with fewer than two stops is kept as
 * `no_route`, so it is not read again on every pass, and is counted nowhere.
 *
 * TURNED OFF MEANS GONE. Turning sharing off for the company or for a person
 * deletes their route days with their positions (`location.ts`), because they
 * are made from where that person drove.
 */

function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID, organizationId, roles: [], grants: ["visit:read", "timesheet:read"], agentId: "route-days",
  };
}

interface DueDay {
  technician_id: string;
  day: string;
  fixes: number;
}

/**
 * Sum every finished day of one company's positions that is not summed yet,
 * or that has positions newer than its sum. Returns how many days it wrote.
 */
export async function summariseFor(db: Database, organizationId: string, now: Date = new Date()): Promise<number> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const zone = await timezoneOf(tx, organizationId);
    const today = time.dateIn(now, zone);
    const [org] = await tx.select({ settings: schema.organization.settings })
      .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
    const settings = loc.sharingSettings(((org?.settings ?? {}) as Record<string, unknown>)["locationSharing"]);
    const gapSeconds = reporting.routeGapSeconds(settings.intervalSeconds);

    const due = await tx.execute<DueDay>(sql`
      with held as (
        select p.technician_id, (p.recorded_at at time zone ${zone})::date as day,
               count(*)::int as fixes, max(p.received_at) as last_received
        from public.technician_position p
        where (p.recorded_at at time zone ${zone})::date < ${today}::date
        group by 1, 2
      )
      select h.technician_id, h.day::text as day, h.fixes
      from held h
      left join public.route_day r on r.technician_id = h.technician_id and r.day = h.day
      where r.id is null or (h.last_received > r.computed_at and h.fixes >= r.fixes)
      order by h.day, h.technician_id
    `);

    let written = 0;
    for (const person of due) {
      const { start, end } = time.dayBoundsIn(person.day, zone);
      const fixes = await tx.select({
        at: schema.technicianPosition.recordedAt,
        lat: schema.technicianPosition.latitude,
        lng: schema.technicianPosition.longitude,
      }).from(schema.technicianPosition)
        .where(and(
          eq(schema.technicianPosition.technicianId, person.technician_id),
          sql`${schema.technicianPosition.recordedAt} >= ${start.toISOString()}::timestamptz`,
          sql`${schema.technicianPosition.recordedAt} < ${end.toISOString()}::timestamptz`,
        ));
      /**
       * The person's stops that day: visits completed, with an arrival, that
       * they were sent on by name or with a crew they are on, dated by the
       * arrival in the company's calendar. The same reading of "their visits"
       * the positions were taken in under.
       */
      const stops = await tx.execute<{ arrived_at: Date | string; completed_at: Date | string }>(sql`
        select v.arrived_at, v.completed_at
        from public.visit v
        where v.deleted_at is null and v.status = 'completed'
          and v.arrived_at is not null and v.completed_at is not null
          and v.arrived_at >= ${start.toISOString()}::timestamptz and v.arrived_at < ${end.toISOString()}::timestamptz
          and (
            exists (select 1 from public.visit_assignment a where a.visit_id = v.id and a.technician_id = ${person.technician_id})
            or exists (select 1 from public.crew_member m where m.crew_id = v.crew_id and m.technician_id = ${person.technician_id})
          )
      `);
      const summary = reporting.routeDay({
        zone,
        gapSeconds,
        fixes: fixes.map((f) => ({ at: f.at, lat: Number(f.lat), lng: Number(f.lng) })),
        stops: stops.map((s) => ({ arrivedAt: new Date(s.arrived_at), completedAt: new Date(s.completed_at) })),
      });
      const row = summary
        ? { stops: summary.stops, drives: summary.drives, miles: summary.miles.toFixed(3), status: summary.status, note: summary.note }
        : { stops: stops.length, drives: 0, miles: "0.000", status: "no_route" as const, note: "Fewer than two stops, so no drive between stops." };
      await tx.insert(schema.routeDay).values({
        organizationId,
        technicianId: person.technician_id,
        day: person.day,
        ...row,
        fixes: person.fixes,
        computedAt: now,
      }).onConflictDoUpdate({
        target: [schema.routeDay.technicianId, schema.routeDay.day],
        set: { ...row, fixes: person.fixes, computedAt: now },
      });
      written += 1;
    }
    return written;
  });
}

/**
 * Every company holding positions, one at a time, each in its own
 * transaction, so one company's failure is kept to that company. Run before
 * the purge on the same pass.
 */
export async function routeDayPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean } = {},
): Promise<Array<{ organizationId: string; written: number; error?: string }>> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.route_day_organizations(${options.limit ?? 200})`,
  );
  const results: Array<{ organizationId: string; written: number; error?: string }> = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push({ organizationId: row.organization_id, written: await summariseFor(db, row.organization_id, options.now) });
    } catch (error) {
      results.push({ organizationId: row.organization_id, written: 0, error: (error as Error).message });
    }
  }
  return results;
}
