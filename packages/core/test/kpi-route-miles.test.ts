import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

/** A moment on 10 June 2026 in Austin (UTC-5 in summer), from a wall clock time. */
const at = (clock: string) => new Date(`2026-06-10T${clock}:00-05:00`);
/** Due north along one meridian: a hundredth of a degree of latitude is 1.112 km, 0.691 miles. */
const fix = (clock: string, lat: number): r.RouteFix => ({ at: at(clock), lat, lng: -97.7 });
const stop = (arrived: string, completed: string): r.RouteStop => ({ arrivedAt: at(arrived), completedAt: at(completed) });

const ZONE = "America/Chicago";
const GAP = r.routeGapSeconds(60);

describe("how long two positions may be apart on a drive", () => {
  it("is three of the company's intervals, and never under fifteen minutes", () => {
    expect(r.routeGapSeconds(60)).toBe(900);
    expect(r.routeGapSeconds(600)).toBe(1800);
  });
});

describe("the miles a route day drove between stops", () => {
  it("measures the drives between stops and never the way out or the way home", () => {
    /**
     * Worked by hand. The yard is at 29.90; the stops at 30.00, 30.02 and
     * 30.03; home is at 30.10.
     *
     *   07:30 to 08:00  yard to the first stop   0.10 degrees, the way out: left out
     *   08:30 to 08:40  first stop to second     0.02 degrees
     *   09:00 to 09:05  second stop to third     0.01 degrees
     *   09:30 to 09:50  third stop home          0.07 degrees, the way home: left out
     *
     * Between stops 0.03 degrees of latitude, 3.336 km, 2.073 miles.
     */
    const day = r.routeDay({
      zone: ZONE, gapSeconds: GAP,
      stops: [stop("08:00", "08:30"), stop("08:40", "09:00"), stop("09:05", "09:30")],
      fixes: [
        fix("07:30", 29.9), fix("07:45", 29.95), fix("08:00", 30.0),
        fix("08:15", 30.0), fix("08:30", 30.0), fix("08:35", 30.01), fix("08:40", 30.02),
        fix("08:50", 30.02), fix("09:00", 30.02), fix("09:05", 30.03),
        fix("09:20", 30.03), fix("09:30", 30.03), fix("09:40", 30.06), fix("09:50", 30.1),
      ],
    });
    expect(day).toEqual({ stops: 3, drives: 2, miles: 2.073, fixes: 14, status: "counted", note: null });
  });

  it("does not count a day whose positions have a gap on a drive between stops", () => {
    /**
     * Thirty five minutes with no position between two stops: a straight line
     * across it would be shorter than the road, and the day would read as a
     * tighter route than it was.
     */
    const day = r.routeDay({
      zone: ZONE, gapSeconds: GAP,
      stops: [stop("08:00", "08:30"), stop("09:10", "09:30")],
      fixes: [fix("08:25", 30.0), fix("08:30", 30.0), fix("09:05", 30.2), fix("09:10", 30.2)],
    });
    expect(day).toEqual(expect.objectContaining({ status: "gap", miles: 0, stops: 2 }));
    expect(day!.note).toBe("No position between 08:30 and 09:05 on a drive between stops.");
  });

  it("does not count a day with no position near the start of a drive", () => {
    const day = r.routeDay({
      zone: ZONE, gapSeconds: GAP,
      stops: [stop("08:00", "08:30"), stop("08:40", "09:00")],
      fixes: [fix("07:00", 30.0), fix("08:35", 30.01), fix("08:40", 30.02)],
    });
    expect(day!.status).toBe("gap");
    expect(day!.note).toBe("No position near the start of the drive that set off at 08:30.");
  });

  it("is no route at all with fewer than two stops", () => {
    expect(r.routeDay({ zone: ZONE, gapSeconds: GAP, stops: [stop("08:00", "08:30")], fixes: [fix("08:00", 30)] })).toBeNull();
    expect(r.routeDay({ zone: ZONE, gapSeconds: GAP, stops: [], fixes: [] })).toBeNull();
  });

  it("does not count a day where a stop was begun before the one before it was closed", () => {
    /** Nobody is at two places at once: one of the times is wrong, and the drive cannot be placed. */
    const day = r.routeDay({
      zone: ZONE, gapSeconds: GAP,
      stops: [stop("08:00", "08:45"), stop("08:40", "09:00")],
      fixes: [fix("08:00", 30.0), fix("09:00", 30.0)],
    });
    expect(day).toEqual(expect.objectContaining({ status: "gap", miles: 0 }));
    expect(day!.note).toMatch(/begun at 08:40 was begun before the one before it was closed/);
  });

  it("counts two stops one after the other at the same place as two stops and no miles", () => {
    /** Two visits at one address, the second begun as the first closed: density, not a gap. */
    const day = r.routeDay({
      zone: ZONE, gapSeconds: GAP,
      stops: [stop("08:00", "08:30"), stop("08:30", "09:00")],
      fixes: [fix("08:20", 30.0), fix("08:30", 30.0), fix("08:40", 30.0)],
    });
    expect(day).toEqual({ stops: 2, drives: 1, miles: 0, fixes: 3, status: "counted", note: null });
  });
});
