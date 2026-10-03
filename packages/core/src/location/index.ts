/**
 * WHERE A TECHNICIAN IS, AND WHEN THAT IS ANYBODY'S BUSINESS
 *
 * The rules behind live location, kept here without a database so the phone,
 * the server and the tests read the same ones.
 *
 * THE ONE RULE EVERYTHING ELSE SERVES: NOTHING IS TRACKED OFF THE CLOCK. A
 * position is taken only while the person is clocked in, or on the way to a
 * visit, or working one, and only when the company has turned sharing on and
 * has not turned it off for that person. The phone decides with
 * `sharingNow` before it asks the operating system for a fix, and the server
 * decides again with `coveringReason` for every fix it is sent, against its
 * own record of the clock and the visits, so a phone that is wrong (an old
 * app, a clock that drifted, a bug) cannot put an evening at home on the map.
 * A fix the server cannot place inside working time is dropped, not stored
 * and flagged.
 *
 * KEPT BRIEFLY. A dispatcher needs to know where somebody is now and where
 * they were this morning; nobody needs where they were last month, and a
 * history of a person's movements is a record a company should not hold
 * without a reason. Three days by default, between one and thirty, and the
 * worker deletes the rest.
 */

/**
 * IMPORTS NOTHING, ON PURPOSE. The phone app bundles this file on its own
 * (`@opentradesos/core/location`), because the field client decides with
 * these same rules offline, and the bundler that builds the phone app does
 * not follow the rest of core's imports. So the two small pieces of geometry
 * it needs are written out here rather than taken from `geo`, and a test
 * holds them to `geo`'s answers.
 */
interface LatLng { lat: number; lng: number }

/** The same refusal `geo.parseLatLng` makes: not a place on Earth, or 0, 0. */
export function isPlace(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

/** Great circle distance in kilometres, as `geo.haversineKm` works it out. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface SharingSettings {
  /** Whether this company shares technician locations at all. Off until somebody turns it on. */
  enabled: boolean;
  /** How long a position is kept, in days. */
  retentionDays: number;
  /** How often the phone takes a fix while sharing, in seconds. */
  intervalSeconds: number;
}

export const SHARING_DEFAULTS: SharingSettings = { enabled: false, retentionDays: 3, intervalSeconds: 60 };
export const RETENTION_DAYS = { min: 1, max: 30 } as const;
export const INTERVAL_SECONDS = { min: 15, max: 600 } as const;

/** Read from wherever the settings were kept, with anything missing or nonsense put back to the default. */
export function sharingSettings(held: unknown): SharingSettings {
  const h = (held ?? {}) as Partial<Record<keyof SharingSettings, unknown>>;
  const within = (value: unknown, range: { min: number; max: number }, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max ? value : fallback;
  return {
    enabled: h.enabled === true,
    retentionDays: within(h.retentionDays, RETENTION_DAYS, SHARING_DEFAULTS.retentionDays),
    intervalSeconds: within(h.intervalSeconds, INTERVAL_SECONDS, SHARING_DEFAULTS.intervalSeconds),
  };
}

export type SharingReason = "on_the_way" | "working" | "on_the_clock";
export type NotSharingReason = "company_off" | "person_off" | "off_the_clock";

export type Sharing =
  | { sharing: true; reason: SharingReason; visitId: string | null }
  | { sharing: false; reason: NotSharingReason };

/**
 * Whether the phone should be taking fixes right now, and why.
 *
 * On the way comes before working, and both before the clock, because the
 * reason decides which visit a position belongs to: a fix taken on the way to
 * Nina Patel's is the one her tracking link may show, and the same fix taken
 * merely on the clock is not hers to see.
 */
export function sharingNow(input: {
  companyEnabled: boolean;
  personEnabled: boolean;
  clockedIn: boolean;
  /** The visit the person is on the way to or working, if any. */
  visit: { id: string; stage: "en_route" | "working" } | null;
}): Sharing {
  if (!input.companyEnabled) return { sharing: false, reason: "company_off" };
  if (!input.personEnabled) return { sharing: false, reason: "person_off" };
  if (input.visit?.stage === "en_route") return { sharing: true, reason: "on_the_way", visitId: input.visit.id };
  if (input.visit?.stage === "working") return { sharing: true, reason: "working", visitId: input.visit.id };
  if (input.clockedIn) return { sharing: true, reason: "on_the_clock", visitId: null };
  return { sharing: false, reason: "off_the_clock" };
}

/**
 * The sentence the technician reads about it, on the screen they are using,
 * every time it is on. Location sharing a person cannot see is surveillance,
 * and the indicator is what keeps it from being that.
 */
export function describeSharing(state: Sharing, customerName?: string | null): string {
  if (state.sharing) {
    const name = customerName?.trim();
    switch (state.reason) {
      case "on_the_way":
        return name
          ? `Sharing your location while you are on the way to ${name}. ${name} can see you on their tracking link until you arrive.`
          : "Sharing your location while you are on the way to a visit.";
      case "working":
        return name
          ? `Sharing your location with the office while you work at ${name}'s.`
          : "Sharing your location with the office while you work on a visit.";
      case "on_the_clock":
        return "Sharing your location with the office while you are clocked in.";
    }
  }
  switch (state.reason) {
    case "company_off": return "Your company does not share technicians' locations.";
    case "person_off": return "Location sharing is turned off for you, so your location is never sent.";
    case "off_the_clock": return "Not sharing your location: you are off the clock and not on a visit.";
  }
}

/* --------------------------------------------- deciding on the server */

export interface ClockInterval {
  startedAt: Date;
  /** Null while the punch is still open. */
  endedAt: Date | null;
}

export interface VisitInterval {
  visitId: string;
  enRouteAt: Date | null;
  arrivedAt: Date | null;
  /** When the work finished. Null while it has not. */
  completedAt: Date | null;
}

/**
 * Whether a fix taken at this instant falls inside working time, by the
 * server's own record, and which visit it belongs to.
 *
 * On the way to a visit runs from `en_route_at` to arrival, working from
 * arrival to completion. A visit marked on the way and never finished counts
 * only up to `now`, never into the future, so a phone with a clock set
 * forward cannot open a window that has not happened.
 */
export function coveringReason(at: Date, facts: {
  now: Date;
  clock: readonly ClockInterval[];
  visits: readonly VisitInterval[];
}): { reason: SharingReason; visitId: string | null } | null {
  const t = at.getTime();
  if (t > facts.now.getTime()) return null;
  const until = (d: Date | null) => (d ?? facts.now).getTime();

  /**
   * Newest first, so two visits overlapping by a minute give the later one.
   * A visit somebody arrived at without ever saying they were on the way
   * counts from the arrival.
   */
  const begun = (v: VisitInterval) => v.enRouteAt ?? v.arrivedAt;
  const visits = facts.visits
    .filter((v) => begun(v) !== null)
    .sort((a, b) => begun(b)!.getTime() - begun(a)!.getTime() || a.visitId.localeCompare(b.visitId));
  for (const v of visits) {
    const from = begun(v)!.getTime();
    const arrived = v.arrivedAt?.getTime() ?? null;
    const end = until(v.completedAt);
    if (t < from || t > end) continue;
    if (arrived === null || t < arrived) return { reason: "on_the_way", visitId: v.visitId };
    return { reason: "working", visitId: v.visitId };
  }
  for (const c of facts.clock) {
    if (t >= c.startedAt.getTime() && t <= until(c.endedAt)) return { reason: "on_the_clock", visitId: null };
  }
  return null;
}

export interface Fix {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null | undefined;
  recordedAt: Date;
}

/** A fix worse than this tells a dispatcher which part of town, not which street. */
export const MAX_ACCURACY_METERS = 1_000;
/** A phone's clock is allowed to run this far ahead of the server's. */
export const FUTURE_TOLERANCE_MS = 2 * 60_000;

/**
 * Why a fix is refused before anything else is asked of it, or null when it
 * is usable. A refused fix is dropped and counted, never stored.
 */
export function refuseFix(fix: Fix, input: { now: Date; retentionDays: number }): string | null {
  if (!isPlace(fix.latitude, fix.longitude)) return "not_a_place";
  if (Number.isNaN(fix.recordedAt.getTime())) return "no_time";
  if (fix.recordedAt.getTime() > input.now.getTime() + FUTURE_TOLERANCE_MS) return "in_the_future";
  if (fix.recordedAt.getTime() < retentionCutoff(input.now, input.retentionDays).getTime()) return "too_old";
  if (fix.accuracyMeters != null && fix.accuracyMeters > MAX_ACCURACY_METERS) return "too_imprecise";
  return null;
}

/** Positions recorded before this are past keeping. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

/* ------------------------------------------------------- on the map */

export type Freshness = "live" | "recent" | "stale";

/**
 * How much a pin can be trusted. Live is within five minutes: a van in
 * traffic is still about there. Recent is within half an hour, worth showing
 * with its age. Older is where they were, said as such, never drawn as where
 * they are.
 */
export function freshness(recordedAt: Date, now: Date): { state: Freshness; minutesAgo: number } {
  const minutesAgo = Math.max(0, Math.floor((now.getTime() - recordedAt.getTime()) / 60_000));
  return { state: minutesAgo <= 5 ? "live" : minutesAgo <= 30 ? "recent" : "stale", minutesAgo };
}

/** "2 minutes ago", for a pin's caption. */
export function lastSeen(recordedAt: Date, now: Date): string {
  const { minutesAgo } = freshness(recordedAt, now);
  if (minutesAgo < 1) return "just now";
  if (minutesAgo < 60) return `${minutesAgo} ${minutesAgo === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutesAgo / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

/* ------------------------------------------------------------ the ETA */

export type EtaBasis = "road" | "estimate" | "technician";

/** A fix older than this says where somebody was, not how far they have left. */
export const ETA_FIX_MAX_AGE_MINUTES = 10;

/**
 * How long until the technician arrives, or null when nothing honest can be
 * said.
 *
 * From the latest position when there is a fresh one: the drive from there,
 * less the minutes since it was taken, because the van has been moving since.
 * Never under a minute while they are still on the way, because "0 minutes"
 * reads as "here" to somebody watching the door. Otherwise from what the
 * technician said when they tapped On my way, counted down, and nothing once
 * that has run out: a countdown that has reached zero is a guess, and the
 * customer stops watching the door.
 */
export function arrivalEstimate(input: {
  now: Date;
  fix: { at: Date; driveMinutes: number; source: "road" | "estimate" } | null;
  notice: { sentAt: Date; etaMinutes: number | null } | null;
}): { minutes: number; basis: EtaBasis } | null {
  if (input.fix) {
    const age = (input.now.getTime() - input.fix.at.getTime()) / 60_000;
    if (age <= ETA_FIX_MAX_AGE_MINUTES && age >= -FUTURE_TOLERANCE_MS / 60_000) {
      return { minutes: Math.max(1, Math.round(input.fix.driveMinutes - Math.max(0, age))), basis: input.fix.source };
    }
  }
  if (input.notice && input.notice.etaMinutes !== null) {
    const elapsed = Math.floor((input.now.getTime() - input.notice.sentAt.getTime()) / 60_000);
    const remaining = input.notice.etaMinutes - elapsed;
    if (remaining > 0) return { minutes: remaining, basis: "technician" };
  }
  return null;
}

/* ------------------------------------------------------- on the phone */

/**
 * Fewer fixes, the same picture.
 *
 * A phone asked for a fix a minute sends one a minute even sat in a driveway
 * for an hour. Kept: the first, any fix at least `minSeconds` after the last
 * kept one, and any that moved at least `minMeters` from it, so a van that is
 * driving is drawn moving and one that is parked costs one row a few minutes.
 */
export function thin<T extends Fix>(fixes: readonly T[], options: { minSeconds: number; minMeters: number }): T[] {
  const sorted = [...fixes].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const kept: T[] = [];
  for (const fix of sorted) {
    const last = kept[kept.length - 1];
    if (!last) {
      kept.push(fix);
      continue;
    }
    const seconds = (fix.recordedAt.getTime() - last.recordedAt.getTime()) / 1000;
    const a: LatLng = { lat: last.latitude, lng: last.longitude };
    const b: LatLng = { lat: fix.latitude, lng: fix.longitude };
    const meters = distanceKm(a, b) * 1000;
    if (seconds >= options.minSeconds || meters >= options.minMeters) kept.push(fix);
  }
  return kept;
}
