import { describe, it, expect } from "vitest";
import { location, geo } from "../src/index";

/**
 * LIVE LOCATION, THE RULES
 *
 * Whether a phone shares at all, whether the server keeps a fix it was sent,
 * how long it keeps it, and what the customer is told about how far away the
 * van is. Every case here is a promise made in the module doc.
 */

const at = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);

describe("whether the phone shares", () => {
  const base = { companyEnabled: true, personEnabled: true, clockedIn: false, visit: null };

  it("shares nothing until the company turns it on, and nothing for a person it is off for", () => {
    expect(location.sharingNow({ ...base, companyEnabled: false, clockedIn: true })).toEqual({ sharing: false, reason: "company_off" });
    expect(location.sharingNow({ ...base, personEnabled: false, clockedIn: true })).toEqual({ sharing: false, reason: "person_off" });
  });

  it("shares nothing off the clock and off a visit", () => {
    expect(location.sharingNow(base)).toEqual({ sharing: false, reason: "off_the_clock" });
  });

  it("names the visit while on the way or working, before the clock", () => {
    expect(location.sharingNow({ ...base, clockedIn: true, visit: { id: "v1", stage: "en_route" } }))
      .toEqual({ sharing: true, reason: "on_the_way", visitId: "v1" });
    expect(location.sharingNow({ ...base, visit: { id: "v1", stage: "working" } }))
      .toEqual({ sharing: true, reason: "working", visitId: "v1" });
    expect(location.sharingNow({ ...base, clockedIn: true }))
      .toEqual({ sharing: true, reason: "on_the_clock", visitId: null });
  });

  it("says so in words the technician reads, including who can see them", () => {
    const onTheWay = location.sharingNow({ ...base, visit: { id: "v1", stage: "en_route" } });
    expect(location.describeSharing(onTheWay, "Nina Patel")).toContain("Nina Patel can see you");
    expect(location.describeSharing({ sharing: false, reason: "off_the_clock" })).toContain("off the clock");
  });

  it("reads settings defensively, off by default", () => {
    expect(location.sharingSettings(undefined)).toEqual(location.SHARING_DEFAULTS);
    expect(location.SHARING_DEFAULTS.enabled).toBe(false);
    expect(location.sharingSettings({ enabled: true, retentionDays: 400, intervalSeconds: 30 }))
      .toEqual({ enabled: true, retentionDays: 3, intervalSeconds: 30 });
  });
});

describe("whether the server keeps a fix", () => {
  const now = at("17:00");

  it("keeps a fix inside an open punch and drops one before it", () => {
    const facts = { now, clock: [{ startedAt: at("08:00"), endedAt: null }], visits: [] };
    expect(location.coveringReason(at("09:00"), facts)).toEqual({ reason: "on_the_clock", visitId: null });
    expect(location.coveringReason(at("07:59"), facts)).toBeNull();
  });

  it("drops a fix after the punch closed, which is the evening at home", () => {
    const facts = { now, clock: [{ startedAt: at("08:00"), endedAt: at("16:00") }], visits: [] };
    expect(location.coveringReason(at("16:30"), facts)).toBeNull();
  });

  it("gives a fix on the way to the visit, and a fix after arrival to the work", () => {
    const facts = {
      now, clock: [],
      visits: [{ visitId: "v1", enRouteAt: at("10:00"), arrivedAt: at("10:20"), completedAt: at("11:00") }],
    };
    expect(location.coveringReason(at("10:10"), facts)).toEqual({ reason: "on_the_way", visitId: "v1" });
    expect(location.coveringReason(at("10:30"), facts)).toEqual({ reason: "working", visitId: "v1" });
    expect(location.coveringReason(at("11:05"), facts)).toBeNull();
  });

  it("never covers a time still to come, whatever the phone's clock says", () => {
    const facts = { now, clock: [{ startedAt: at("08:00"), endedAt: null }], visits: [] };
    expect(location.coveringReason(at("17:30"), facts)).toBeNull();
  });

  it("refuses nonsense before asking anything else", () => {
    const ok = { latitude: 30.27, longitude: -97.74, recordedAt: at("16:59"), accuracyMeters: 12 };
    const input = { now, retentionDays: 3 };
    expect(location.refuseFix(ok, input)).toBeNull();
    expect(location.refuseFix({ ...ok, latitude: 0, longitude: 0 }, input)).toBe("not_a_place");
    expect(location.refuseFix({ ...ok, recordedAt: at("17:10") }, input)).toBe("in_the_future");
    expect(location.refuseFix({ ...ok, recordedAt: new Date(now.getTime() - 4 * 864e5) }, input)).toBe("too_old");
    expect(location.refuseFix({ ...ok, accuracyMeters: 5000 }, input)).toBe("too_imprecise");
  });

  it("puts the retention cut off whole days back", () => {
    expect(location.retentionCutoff(now, 3).toISOString()).toBe("2026-10-03T17:00:00.000Z");
  });
});

describe("how far away the van is", () => {
  const now = at("10:10");

  it("counts down the drive from a fresh fix, never to zero", () => {
    expect(location.arrivalEstimate({
      now, fix: { at: at("10:08"), driveMinutes: 14, source: "road" }, notice: null,
    })).toEqual({ minutes: 12, basis: "road" });
    expect(location.arrivalEstimate({
      now, fix: { at: at("10:08"), driveMinutes: 1, source: "estimate" }, notice: null,
    })).toEqual({ minutes: 1, basis: "estimate" });
  });

  it("falls back to what the technician said when the fix is old, and to nothing when that ran out", () => {
    const old = { at: at("09:30"), driveMinutes: 14, source: "road" as const };
    expect(location.arrivalEstimate({ now, fix: old, notice: { sentAt: at("10:00"), etaMinutes: 20 } }))
      .toEqual({ minutes: 10, basis: "technician" });
    expect(location.arrivalEstimate({ now, fix: old, notice: { sentAt: at("09:00"), etaMinutes: 20 } })).toBeNull();
    expect(location.arrivalEstimate({ now, fix: null, notice: { sentAt: at("10:00"), etaMinutes: null } })).toBeNull();
  });

  it("says how fresh a pin is", () => {
    expect(location.freshness(at("10:07"), now)).toEqual({ state: "live", minutesAgo: 3 });
    expect(location.freshness(at("09:50"), now).state).toBe("recent");
    expect(location.freshness(at("08:00"), now).state).toBe("stale");
    expect(location.lastSeen(at("10:09"), now)).toBe("1 minute ago");
    expect(location.lastSeen(at("08:05"), now)).toBe("2 hours ago");
  });
});

describe("fewer fixes from a parked van", () => {
  it("keeps the first, the ones far enough apart in time, and the ones that moved", () => {
    const fix = (hhmm: string, lat: number) => ({ latitude: lat, longitude: -97.74, recordedAt: at(hhmm) });
    const kept = location.thin([
      fix("10:00", 30.27), fix("10:01", 30.27), fix("10:02", 30.2701),
      fix("10:03", 30.28), fix("10:06", 30.28),
    ], { minSeconds: 180, minMeters: 100 });
    expect(kept.map((f) => f.recordedAt.toISOString().slice(11, 16))).toEqual(["10:00", "10:03", "10:06"]);
  });
});

describe("the geometry the phone bundles on its own", () => {
  it("agrees with geo about what is a place and how far apart two places are", () => {
    const a = { lat: 30.27, lng: -97.74 };
    const b = { lat: 30.31, lng: -97.69 };
    expect(location.distanceKm(a, b)).toBeCloseTo(geo.haversineKm(a, b), 9);
    for (const [lat, lng] of [[0, 0], [91, 0], [30, 181], [30.27, -97.74], [Number.NaN, 1]] as const) {
      expect(location.isPlace(lat, lng)).toBe(geo.parseLatLng(lat, lng) !== null);
    }
  });
});

describe("the key a drive time is cached under", () => {
  it("rounds to about eleven metres and treats minus zero as zero", () => {
    expect(geo.coordinateKey({ lat: 30.267153, lng: -97.743061 })).toBe("30.2672,-97.7431");
    expect(geo.coordinateKey({ lat: -0.00001, lng: 12 })).toBe("0.0000,12.0000");
  });
});
