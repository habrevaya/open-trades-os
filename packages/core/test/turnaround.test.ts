import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

const at = (iso: string) => new Date(iso);

describe("a container's turnaround", () => {
  it("is the hours from emptied at the facility to placed on the next site", () => {
    expect(r.turnaroundOf({
      tippedAt: at("2026-06-08T19:10:00Z"), placedAt: at("2026-06-09T14:40:00Z"), placedTimeKnown: true, holds: [],
    })).toEqual({ counted: true, hours: 19.5 });
  });

  it("is not known for a placement recorded as a day, a haul with no tip, or times that run backwards", () => {
    const placedAt = at("2026-06-09T12:00:00Z");
    expect(r.turnaroundOf({ tippedAt: at("2026-06-08T19:10:00Z"), placedAt, placedTimeKnown: false, holds: [] }))
      .toEqual({ counted: false, why: "placed_day_only" });
    expect(r.turnaroundOf({ tippedAt: null, placedAt, placedTimeKnown: true, holds: [] }))
      .toEqual({ counted: false, why: "no_tip" });
    expect(r.turnaroundOf({ tippedAt: at("2026-06-09T13:00:00Z"), placedAt, placedTimeKnown: true, holds: [] }))
      .toEqual({ counted: false, why: "times_disagree" });
  });

  it("leaves out a can out for repair or held for a customer at any moment in between, and not one outside it", () => {
    const base = { tippedAt: at("2026-06-08T10:00:00Z"), placedAt: at("2026-06-10T10:00:00Z"), placedTimeKnown: true };
    expect(r.turnaroundOf({ ...base, holds: [{ kind: "repair", startsAt: at("2026-06-08T08:00:00Z"), endsAt: at("2026-06-09T08:00:00Z") }] }))
      .toEqual({ counted: false, why: "repair" });
    /** A repair already running when the history began started before anything measured. */
    expect(r.turnaroundOf({ ...base, holds: [{ kind: "repair", startsAt: null, endsAt: at("2026-06-08T11:00:00Z") }] }))
      .toEqual({ counted: false, why: "repair" });
    expect(r.turnaroundOf({ ...base, holds: [{ kind: "customer", startsAt: at("2026-06-09T00:00:00Z"), endsAt: null }] }))
      .toEqual({ counted: false, why: "customer_hold" });
    /** Ended by the tip, or begun at the placement: outside it. */
    expect(r.turnaroundOf({ ...base, holds: [
      { kind: "repair", startsAt: null, endsAt: at("2026-06-08T10:00:00Z") },
      { kind: "customer", startsAt: at("2026-06-10T10:00:00Z"), endsAt: null },
    ] })).toEqual({ counted: true, hours: 48 });
  });
});

describe("a container that came back empty", () => {
  it("is measured from the collection, with no tip expected", () => {
    const placedAt = at("2026-06-09T14:40:00Z");
    expect(r.turnaroundOf({
      tippedAt: null, cameBackEmptyAt: at("2026-06-09T08:40:00Z"), placedAt, placedTimeKnown: true, holds: [],
    })).toEqual({ counted: true, hours: 6 });
    // A tip recorded on the haul wins: then it was not empty.
    expect(r.turnaroundOf({
      tippedAt: at("2026-06-09T10:40:00Z"), cameBackEmptyAt: at("2026-06-09T08:40:00Z"), placedAt, placedTimeKnown: true, holds: [],
    })).toEqual({ counted: true, hours: 4 });
    // Still not known for a placement recorded as a day, and still backwards is not a turnaround.
    expect(r.turnaroundOf({ tippedAt: null, cameBackEmptyAt: at("2026-06-09T08:40:00Z"), placedAt, placedTimeKnown: false, holds: [] }))
      .toEqual({ counted: false, why: "placed_day_only" });
    expect(r.turnaroundOf({ tippedAt: null, cameBackEmptyAt: at("2026-06-09T15:00:00Z"), placedAt, placedTimeKnown: true, holds: [] }))
      .toEqual({ counted: false, why: "times_disagree" });
    // The exclusions are the same: a repair in between leaves it out.
    expect(r.turnaroundOf({
      tippedAt: null, cameBackEmptyAt: at("2026-06-09T08:40:00Z"), placedAt, placedTimeKnown: true,
      holds: [{ kind: "repair", startsAt: at("2026-06-09T09:00:00Z"), endsAt: at("2026-06-09T10:00:00Z") }],
    })).toEqual({ counted: false, why: "repair" });
  });
});
