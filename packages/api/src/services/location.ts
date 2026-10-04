import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { geo, location as loc, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError,
  type ServiceContext,
} from "./context";
import { peek, inGrant, requireScope, pickVisit, InvalidGrantError } from "./portal";
import { travelMatrix, type TravelDeps } from "./travel-times";
import { portalBase } from "../lib/portal-base";

/**
 * LIVE TECHNICIAN LOCATION
 *
 * Four things, and the privacy choices are the design rather than a section
 * of it. The rules themselves are in `packages/core/src/location`.
 *
 *   1. The company's setting and each person's. Off for the company until an
 *      owner turns it on (`settings:write`); on for each person once it is,
 *      unless the office turns it off for them (`user:write`). Turning either
 *      off deletes what was already kept, there and then, rather than leaving
 *      it to age out: "stop tracking me" means the history too.
 *   2. Taking positions in, in batches through the field sync. Every fix is
 *      judged against the server's own record of the clock and the visits,
 *      and one outside working time is dropped, never stored.
 *   3. Showing them: the latest position of each technician on the dispatch
 *      map, to people who dispatch (`visit:dispatch`) and nobody else. A CSR
 *      or a technician reads the board and not where their colleagues are.
 *   4. The customer's tracking link: one pin, only while the technician is on
 *      the way to THEIR visit after telling them so, only fixes taken for that
 *      visit, and nothing at all once they have arrived.
 *
 * Positions are deleted after the company's retention by the worker
 * (`purgePositions`), three days unless it says otherwise.
 */

/* --------------------------------------------------------------- settings */

async function settingsOf(tx: Database, organizationId: string): Promise<loc.SharingSettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return loc.sharingSettings(((row?.settings ?? {}) as Record<string, unknown>)["locationSharing"]);
}

/** The company's setting. Anybody who reads the schedule may read it: a technician should be able to see it. */
export async function sharing(ctx: ServiceContext): Promise<loc.SharingSettings> {
  return guardedRead(ctx, "visit:read", (tx) => settingsOf(tx, ctx.actor.organizationId));
}

export async function setSharing(ctx: ServiceContext, input: {
  enabled?: boolean | undefined;
  retentionDays?: number | undefined;
  intervalSeconds?: number | undefined;
}): Promise<loc.SharingSettings> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await settingsOf(tx, ctx.actor.organizationId);
    const after: loc.SharingSettings = {
      enabled: input.enabled ?? before.enabled,
      retentionDays: input.retentionDays ?? before.retentionDays,
      intervalSeconds: input.intervalSeconds ?? before.intervalSeconds,
    };
    if (!Number.isInteger(after.retentionDays)
      || after.retentionDays < loc.RETENTION_DAYS.min || after.retentionDays > loc.RETENTION_DAYS.max) {
      throw new ConflictError(`Positions are kept for between ${loc.RETENTION_DAYS.min} and ${loc.RETENTION_DAYS.max} days.`);
    }
    if (!Number.isInteger(after.intervalSeconds)
      || after.intervalSeconds < loc.INTERVAL_SECONDS.min || after.intervalSeconds > loc.INTERVAL_SECONDS.max) {
      throw new ConflictError(`A phone takes a position between every ${loc.INTERVAL_SECONDS.min} seconds and every ${loc.INTERVAL_SECONDS.max / 60} minutes.`);
    }
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ locationSharing: after })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));

    /** Off means off, including what was kept while it was on. */
    let removed = 0;
    if (before.enabled && !after.enabled) {
      const gone = await tx.delete(schema.technicianPosition)
        .where(eq(schema.technicianPosition.organizationId, ctx.actor.organizationId))
        .returning({ id: schema.technicianPosition.id });
      removed = gone.length;
    } else if (after.retentionDays < before.retentionDays) {
      /** A shorter retention applies to what is already kept, not only to what comes next. */
      const gone = await tx.delete(schema.technicianPosition).where(and(
        eq(schema.technicianPosition.organizationId, ctx.actor.organizationId),
        lte(schema.technicianPosition.recordedAt, loc.retentionCutoff(new Date(), after.retentionDays)),
      )).returning({ id: schema.technicianPosition.id });
      removed = gone.length;
    }
    await audit(tx, ctx, "location.sharing_set", "organization", ctx.actor.organizationId, before, { ...after, removed });
    return after;
  });
}

/**
 * One person's setting, set by the office. Turning it off deletes their
 * positions now, for the reason the company switch does.
 */
export async function setPersonSharing(tx: Database, ctx: ServiceContext, technicianId: string, share: boolean) {
  if (!share) {
    await tx.delete(schema.technicianPosition).where(and(
      eq(schema.technicianPosition.organizationId, ctx.actor.organizationId),
      eq(schema.technicianPosition.technicianId, technicianId),
    ));
  }
}

/**
 * What the phone needs to decide for itself, sent with the day: whether the
 * company shares, whether it is on for this person, and how often to take a
 * fix. The phone shows the person which it is.
 */
export async function forDevice(tx: Database, organizationId: string, technicianId: string) {
  const settings = await settingsOf(tx, organizationId);
  const [person] = await tx.select({ share: schema.technician.shareLocation })
    .from(schema.technician).where(eq(schema.technician.id, technicianId)).limit(1);
  return {
    companyEnabled: settings.enabled,
    personEnabled: person?.share ?? false,
    intervalSeconds: settings.intervalSeconds,
    retentionDays: settings.retentionDays,
  };
}

/* ---------------------------------------------------------------- taking in */

export interface IncomingFix {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | undefined;
  heading?: number | undefined;
  speed?: number | undefined;
  recordedAt: string;
}

export interface Ingested {
  stored: number;
  /** Fixes not kept, by why: `company_off`, `person_off`, `off_the_clock`, or a `refuseFix` reason. */
  dropped: Record<string, number>;
}

/**
 * The longest a visit marked on the way and never finished counts as working
 * time. A technician who tapped On my way yesterday and never closed the
 * visit is not on the way to it tonight.
 */
const OPEN_VISIT_HOURS = 12;

/**
 * Positions from one device, inside the sync's transaction, AFTER its
 * operations, so a punch in sent in the same batch as the first fixes of
 * the day is on the record when those fixes are judged.
 */
export async function ingest(
  tx: Database,
  ctx: ServiceContext,
  device: { id: string; technicianId: string },
  fixes: readonly IncomingFix[],
  now: Date,
): Promise<Ingested> {
  const out: Ingested = { stored: 0, dropped: {} };
  if (fixes.length === 0) return out;
  const drop = (why: string, n = 1) => { out.dropped[why] = (out.dropped[why] ?? 0) + n; };

  const settings = await settingsOf(tx, ctx.actor.organizationId);
  if (!settings.enabled) {
    drop("company_off", fixes.length);
    return out;
  }
  const [person] = await tx.select({ share: schema.technician.shareLocation })
    .from(schema.technician).where(eq(schema.technician.id, device.technicianId)).limit(1);
  if (!person?.share) {
    drop("person_off", fixes.length);
    return out;
  }

  const usable: { fix: IncomingFix; at: Date }[] = [];
  for (const fix of fixes) {
    const at = new Date(fix.recordedAt);
    const refused = loc.refuseFix({ ...fix, recordedAt: at }, { now, retentionDays: settings.retentionDays });
    if (refused) drop(refused);
    else usable.push({ fix, at });
  }
  if (usable.length === 0) return out;
  const earliest = new Date(Math.min(...usable.map((u) => u.at.getTime())));

  const clock = await tx.select({ startedAt: schema.timeclockEntry.startedAt, endedAt: schema.timeclockEntry.endedAt })
    .from(schema.timeclockEntry)
    .where(and(
      eq(schema.timeclockEntry.technicianId, device.technicianId),
      lte(schema.timeclockEntry.startedAt, now),
      or(isNull(schema.timeclockEntry.endedAt), gte(schema.timeclockEntry.endedAt, earliest)),
    ));

  /** Their visits, whether they were sent alone or with a crew they are on. */
  const begun = sql`coalesce(${schema.visit.enRouteAt}, ${schema.visit.arrivedAt})`;
  const visits = await tx.select({
    visitId: schema.visit.id,
    enRouteAt: schema.visit.enRouteAt,
    arrivedAt: schema.visit.arrivedAt,
    completedAt: schema.visit.completedAt,
  }).from(schema.visit)
    .where(and(
      eq(schema.visit.organizationId, ctx.actor.organizationId),
      sql`${begun} is not null and ${begun} <= ${now.toISOString()}::timestamptz`,
      or(isNull(schema.visit.completedAt), gte(schema.visit.completedAt, earliest)),
      sql`${schema.visit.status} not in ('cancelled', 'no_show')`,
      or(
        sql`exists (select 1 from public.visit_assignment a where a.visit_id = ${schema.visit.id} and a.technician_id = ${device.technicianId})`,
        sql`exists (select 1 from public.crew_member m where m.crew_id = ${schema.visit.crewId} and m.technician_id = ${device.technicianId})`,
      ),
    ));
  const facts = {
    now,
    clock,
    visits: visits.map((v) => {
      const from = v.enRouteAt ?? v.arrivedAt!;
      const cap = new Date(from.getTime() + OPEN_VISIT_HOURS * 3_600_000);
      return { ...v, completedAt: v.completedAt ?? (cap < now ? cap : null) };
    }),
  };

  const covered: { fix: IncomingFix; at: Date; reason: loc.SharingReason; visitId: string | null }[] = [];
  for (const { fix, at } of usable) {
    const why = loc.coveringReason(at, facts);
    if (why) covered.push({ fix, at, ...why });
    else drop("off_the_clock");
  }
  if (covered.length > 0) {
    /** A batch resent after a dropped answer is the same fixes, kept once. */
    const kept = await tx.insert(schema.technicianPosition).values(covered.map(({ fix, at, reason, visitId }) => ({
      organizationId: ctx.actor.organizationId,
      technicianId: device.technicianId,
      deviceId: device.id,
      recordedAt: at,
      receivedAt: now,
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracyMeters: fix.accuracyMeters === undefined ? null : Math.round(fix.accuracyMeters),
      heading: fix.heading === undefined ? null : Math.round(fix.heading) % 360,
      speed: fix.speed ?? null,
      reason,
      visitId,
    })))
      .onConflictDoNothing({ target: [schema.technicianPosition.deviceId, schema.technicianPosition.recordedAt] })
      .returning({ id: schema.technicianPosition.id });
    out.stored = kept.length;
    if (kept.length < covered.length) drop("already_had", covered.length - kept.length);
  }
  return out;
}

/* ------------------------------------------------------------------ the map */

export interface LivePosition {
  technicianId: string;
  displayName: string;
  color: string | null;
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  recordedAt: string;
  reason: loc.SharingReason;
  visitId: string | null;
  freshness: loc.Freshness;
  lastSeen: string;
}

/**
 * The latest position of each technician today, for people who dispatch.
 *
 * Today in the company's zone and nothing earlier, even inside the
 * retention: the map is where people are, and yesterday afternoon is not
 * that. Empty when the company does not share locations.
 */
export async function latest(ctx: ServiceContext): Promise<{ enabled: boolean; positions: LivePosition[] }> {
  return guardedRead(ctx, "visit:dispatch", (tx) => latestWithin(tx, ctx.actor.organizationId));
}

export async function latestWithin(tx: Database, organizationId: string): Promise<{ enabled: boolean; positions: LivePosition[] }> {
  const settings = await settingsOf(tx, organizationId);
  if (!settings.enabled) return { enabled: false, positions: [] };
  const zone = await timezoneOf(tx, organizationId);
  const now = new Date();
  const { start } = time.dayBoundsIn(time.dateIn(now, zone), zone);

  const rows = await tx.execute<{
    technician_id: string; display_name: string; color: string | null; latitude: number; longitude: number;
    accuracy_meters: number | null; recorded_at: Date | string; reason: loc.SharingReason; visit_id: string | null;
  }>(sql`
    select distinct on (p.technician_id)
           p.technician_id, t.display_name, t.color, p.latitude, p.longitude, p.accuracy_meters,
           p.recorded_at, p.reason::text as reason, p.visit_id
      from public.technician_position p
      join public.technician t on t.id = p.technician_id
     where p.organization_id = ${organizationId}
       and p.recorded_at >= ${start.toISOString()}::timestamptz
       and t.active and t.share_location
     order by p.technician_id, p.recorded_at desc`);
  return {
    enabled: true,
    positions: rows.map((r) => {
      const at = new Date(r.recorded_at);
      return {
        technicianId: r.technician_id,
        displayName: r.display_name,
        color: r.color,
        lat: Number(r.latitude),
        lng: Number(r.longitude),
        accuracyMeters: r.accuracy_meters,
        recordedAt: at.toISOString(),
        reason: r.reason,
        visitId: r.visit_id,
        freshness: loc.freshness(at, now).state,
        lastSeen: loc.lastSeen(at, now),
      };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

/* ------------------------------------------------------------ the worker */

/**
 * Positions past each company's retention, and drive times past their
 * provider's expiry. Across every company in one statement each, through
 * definer functions, because the worker has no tenant.
 */
export async function purgePositions(db: Database): Promise<{ positions: number; travelTimes: number }> {
  const removed = await db.execute<{ organization_id: string; removed: string | number }>(
    sql`select organization_id, removed from app.purge_technician_positions(5000)`,
  );
  const [travel] = await db.execute<{ purge_travel_times: string | number }>(
    sql`select app.purge_travel_times(5000) as purge_travel_times`,
  );
  return {
    positions: removed.reduce((n, r) => n + Number(r.removed), 0),
    travelTimes: Number(travel?.purge_travel_times ?? 0),
  };
}

/* ----------------------------------------------------- the customer's link */

export interface LiveTracking {
  /** Whether the pin is showing: on the way to this visit, told, and not yet there. */
  tracking: boolean;
  status: "not_on_the_way" | "on_the_way" | "arrived" | "finished";
  etaMinutes: number | null;
  /** `road`, `estimate` (a straight line) or `technician` (what they said when they set off). */
  etaBasis: loc.EtaBasis | null;
  technician: { firstName: string; photoUrl: string | null } | null;
  position: { lat: number; lng: number; recordedAt: string; lastSeen: string } | null;
  destination: { lat: number; lng: number } | null;
  /** One sentence for the customer about what they are looking at. */
  explanation: string;
}

/**
 * The tracking link's live part, read by the page every half minute.
 *
 * What it will show, and the order the checks run in, is the privacy model:
 * the visit the customer is waiting on, on the way, with an On my way notice
 * sent, not arrived, the company sharing, and then only the newest fix taken
 * FOR THAT VISIT AFTER THE NOTICE WAS SENT. Not the drive to the job before,
 * not where the technician went at lunch, and nothing once they have
 * arrived: arriving ends the link's location for good, even if the visit is
 * later marked on the way again.
 */
export async function liveTracking(db: Database, input: { token: string; deps?: TravelDeps }): Promise<LiveTracking> {
  const grant = await peek(db, input.token);
  const jobId = requireScope(grant, "job");
  let portalCtx: ServiceContext | null = null;

  const loaded = await inGrant(db, grant, async (tx, ctx) => {
    portalCtx = ctx;
    const visits = await tx.select({
      visit: schema.visit,
      technicianId: schema.technician.id,
      technicianName: schema.technician.displayName,
      photoFileId: schema.technician.photoFileId,
    }).from(schema.visit)
      .leftJoin(schema.visitAssignment, and(
        eq(schema.visitAssignment.visitId, schema.visit.id),
        eq(schema.visitAssignment.isLead, true),
      ))
      .leftJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
      .where(eq(schema.visit.jobId, jobId))
      .orderBy(asc(schema.visit.windowStart));
    /** A job with no visit yet (a lead, an estimate) has nobody coming, which is an answer. */
    if (visits.length === 0) return null;

    const picked = pickVisit(visits.map((v) => ({
      id: v.visit.id, status: v.visit.status, windowStart: v.visit.windowStart,
      windowEnd: v.visit.windowEnd, technicianName: v.technicianName,
    })));
    const current = visits.find((v) => v.visit.id === picked?.id) ?? visits[0]!;

    const [job] = await tx.select({ propertyId: schema.job.propertyId }).from(schema.job)
      .where(eq(schema.job.id, jobId)).limit(1);
    const [property] = job ? await tx.select({
      latitude: schema.property.latitude, longitude: schema.property.longitude,
    }).from(schema.property).where(eq(schema.property.id, job.propertyId)).limit(1) : [];

    const [notice] = await tx.select({
      sentAt: schema.arrivalNotice.sentAt,
      etaMinutes: schema.arrivalNotice.etaMinutes,
      arrivedAt: schema.arrivalNotice.arrivedAt,
    }).from(schema.arrivalNotice)
      .where(and(eq(schema.arrivalNotice.visitId, current.visit.id), isNull(schema.arrivalNotice.failedReason)))
      .orderBy(desc(schema.arrivalNotice.sentAt)).limit(1);

    const settings = await settingsOf(tx, grant.organizationId);
    const arrived = current.visit.arrivedAt !== null || notice?.arrivedAt != null;
    const onTheWay = current.visit.status === "en_route" && !arrived;

    let position: { lat: number; lng: number; at: Date } | null = null;
    if (onTheWay && notice && settings.enabled && current.technicianId) {
      const [fix] = await tx.select({
        latitude: schema.technicianPosition.latitude,
        longitude: schema.technicianPosition.longitude,
        recordedAt: schema.technicianPosition.recordedAt,
      }).from(schema.technicianPosition)
        .where(and(
          eq(schema.technicianPosition.technicianId, current.technicianId),
          eq(schema.technicianPosition.visitId, current.visit.id),
          eq(schema.technicianPosition.reason, "on_the_way"),
          gte(schema.technicianPosition.recordedAt, notice.sentAt),
        ))
        .orderBy(desc(schema.technicianPosition.recordedAt)).limit(1);
      if (fix) position = { lat: fix.latitude, lng: fix.longitude, at: fix.recordedAt };
    }

    return {
      status: current.visit.status,
      arrived,
      onTheWay,
      notice: notice ?? null,
      technician: current.technicianName
        ? { firstName: firstNameOf(current.technicianName), hasPhoto: current.photoFileId !== null }
        : null,
      destination: geo.parseLatLng(property?.latitude ?? null, property?.longitude ?? null),
      position,
      assumptions: await assumptionsOf(tx, grant.organizationId),
    };
  });

  if (!loaded) {
    return {
      tracking: false, status: "not_on_the_way", etaMinutes: null, etaBasis: null, technician: null,
      position: null, destination: null, explanation: "Once your technician is on the way, you will see them here.",
    };
  }
  const now = new Date();
  const s = loaded.status;
  const status: LiveTracking["status"] = s === "completed" || s === "completed_after_cancellation" ? "finished"
    : loaded.arrived || s === "working" ? "arrived"
    : loaded.onTheWay ? "on_the_way"
    : "not_on_the_way";

  let fix: { at: Date; driveMinutes: number; source: "road" | "estimate" } | null = null;
  if (loaded.position && loaded.destination && portalCtx) {
    const matrix = await travelMatrix(portalCtx, new Map([
      ["van", { lat: loaded.position.lat, lng: loaded.position.lng }],
      ["door", loaded.destination],
    ]), { assumptions: loaded.assumptions, ...(input.deps ? { deps: input.deps } : {}) });
    fix = {
      at: loaded.position.at,
      driveMinutes: matrix.travel("van", "door"),
      source: matrix.source === "road" ? "road" : "estimate",
    };
  }
  const eta = status === "on_the_way"
    ? loc.arrivalEstimate({
      now, fix,
      notice: loaded.notice ? { sentAt: loaded.notice.sentAt, etaMinutes: loaded.notice.etaMinutes } : null,
    })
    : null;

  const tracking = status === "on_the_way" && loaded.position !== null;
  return {
    tracking,
    status,
    etaMinutes: eta?.minutes ?? null,
    etaBasis: eta?.basis ?? null,
    technician: loaded.technician
      ? {
        firstName: loaded.technician.firstName,
        photoUrl: loaded.technician.hasPhoto ? `${portalBase()}/j/${input.token}/technician-photo` : null,
      }
      : null,
    position: tracking && loaded.position
      ? {
        lat: loaded.position.lat, lng: loaded.position.lng,
        recordedAt: loaded.position.at.toISOString(), lastSeen: loc.lastSeen(loaded.position.at, now),
      }
      : null,
    destination: tracking ? loaded.destination : null,
    explanation: status === "arrived" ? "Your technician has arrived, so their location is no longer shown."
      : status === "finished" ? "This visit is finished."
      : status === "on_the_way"
        ? tracking
          ? "Your technician's location, updated as they drive. It stops showing when they arrive."
          : "Your technician is on the way."
        : "Once your technician is on the way, you will see them here.",
  };
}

/**
 * The technician's photograph, through the job link, for the tracking page.
 * Only the lead on the visit the customer is waiting on, and only a picture.
 */
export async function trackingPhoto(db: Database, token: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  let grant;
  try {
    grant = await peek(db, token);
  } catch (error) {
    if (error instanceof InvalidGrantError) return null;
    throw error;
  }
  if (grant.scope !== "job" || !grant.subjectId) return null;
  const jobId = grant.subjectId;
  return inGrant(db, grant, async (tx) => {
    const visits = await tx.select({
      id: schema.visit.id, status: schema.visit.status,
      windowStart: schema.visit.windowStart, windowEnd: schema.visit.windowEnd,
      technicianName: schema.technician.displayName, photoFileId: schema.technician.photoFileId,
    }).from(schema.visit)
      .leftJoin(schema.visitAssignment, and(
        eq(schema.visitAssignment.visitId, schema.visit.id), eq(schema.visitAssignment.isLead, true),
      ))
      .leftJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
      .where(eq(schema.visit.jobId, jobId));
    const picked = pickVisit(visits);
    const fileId = visits.find((v) => v.id === picked?.id)?.photoFileId ?? null;
    if (!fileId) return null;
    const [file] = await tx.select({ bytes: schema.storedFile.bytes, contentType: schema.storedFile.contentType })
      .from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).limit(1);
    if (!file || !file.contentType.startsWith("image/")) return null;
    return { bytes: file.bytes, contentType: file.contentType };
  });
}

async function assumptionsOf(tx: Database, organizationId: string): Promise<geo.DriveAssumptions> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const held = ((row?.settings ?? {}) as Record<string, unknown>)["dispatchTravel"] as Partial<geo.DriveAssumptions> | undefined;
  return {
    averageKmh: typeof held?.averageKmh === "number" ? held.averageKmh : geo.DEFAULT_DRIVE.averageKmh,
    roadFactor: typeof held?.roadFactor === "number" ? held.roadFactor : geo.DEFAULT_DRIVE.roadFactor,
  };
}

/** Enough for a customer to greet the person at the door, and no more. */
function firstNameOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}


export const handlers = {
  getLocationSharing: (ctx: ServiceContext) => sharing(ctx),
  setLocationSharing: (ctx: ServiceContext, input: {
    enabled?: boolean | undefined; retentionDays?: number | undefined; intervalSeconds?: number | undefined;
  }) => setSharing(ctx, input),
  getLivePositions: (ctx: ServiceContext) => latest(ctx),
  getPortalJobLive: (db: Database, input: { token: string }) => liveTracking(db, { token: input.token }),
} as const;
