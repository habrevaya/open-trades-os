import { describe, it, expect } from "vitest";
import {
  occurrencesBetween, nextOccurrence, agreementVisitDates,
  addDays, addMonths, type RecurrenceSpec,
} from "../src/recurrence/index.js";

const dates = (spec: RecurrenceSpec, from: string, to: string) =>
  occurrencesBetween(spec, from, to).map((o) => o.date);

describe("date arithmetic", () => {
  it("does not roll a month over", () => {
    // Adding a month to 31 January is 28 February, not 3 March. A plan visit
    // due at month end is due at month end.
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 3)).toBe("2026-04-30");
  });

  it("handles a leap year", () => {
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("crosses a year boundary", () => {
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("rejects anything that is not an ISO date", () => {
    expect(() => addDays("15/01/2026", 1)).toThrow();
    expect(() => addDays("2026-13-01", 1)).toThrow();
  });
});

describe("interval rule", () => {
  const weekly: RecurrenceSpec = { model: "rule", startsOn: "2026-01-05", intervalDays: 7 };

  it("generates every interval", () => {
    expect(dates(weekly, "2026-01-01", "2026-02-02")).toEqual([
      "2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02",
    ]);
  });

  it("never generates before the start", () => {
    expect(dates(weekly, "2025-01-01", "2026-01-06")).toEqual(["2026-01-05"]);
  });

  it("stops at the end date", () => {
    expect(dates({ ...weekly, endsOn: "2026-01-19" }, "2026-01-01", "2026-03-01"))
      .toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
  });

  it("fast forwards rather than stepping from the start", () => {
    // A weekly schedule opened five years later must not walk 260 iterations.
    const found = dates(weekly, "2031-01-01", "2031-01-31");
    expect(found.length).toBeGreaterThan(3);
    expect(found[0]! >= "2031-01-01").toBe(true);
  });
});

describe("seasonal anchoring", () => {
  /**
   * The case that is most often built wrong. A two visit plan sold in January
   * must still put the heating tune up in autumn, not six months forward in
   * July.
   */
  const plan: RecurrenceSpec = {
    model: "rule", startsOn: "2026-01-10",
    anchorMonths: [4, 10], anchorDay: 15,
  };

  it("pins visits to their season regardless of when it was sold", () => {
    expect(dates(plan, "2026-01-01", "2026-12-31")).toEqual(["2026-04-15", "2026-10-15"]);
  });

  it("puts a plan sold in August into the same seasons", () => {
    const august: RecurrenceSpec = { ...plan, startsOn: "2026-08-20" };
    expect(dates(august, "2026-01-01", "2027-12-31")).toEqual([
      "2026-10-15", "2027-04-15", "2027-10-15",
    ]);
  });

  it("clamps an anchor day to the length of the month", () => {
    const feb: RecurrenceSpec = { model: "rule", startsOn: "2026-01-01", anchorMonths: [2], anchorDay: 31 };
    expect(dates(feb, "2026-01-01", "2026-12-31")).toEqual(["2026-02-28"]);
  });
});

describe("anchored to completion", () => {
  /**
   * The model that keeps a pool, pest, lawn or bin route honest. Weekly means
   * seven days from when the technician was ACTUALLY there.
   */
  const route: RecurrenceSpec = {
    model: "anchored_to_completion", startsOn: "2026-01-01", intervalDays: 7,
  };

  it("counts from the last actual completion, not the calendar", () => {
    const onTime = dates({ ...route, lastOccurredOn: "2026-03-02" }, "2026-03-01", "2026-04-01");
    expect(onTime).toEqual(["2026-03-09"]);

    // Rained off, serviced two days late. The next one moves with it rather
    // than snapping back to the original calendar slot.
    const late = dates({ ...route, lastOccurredOn: "2026-03-04" }, "2026-03-01", "2026-04-01");
    expect(late).toEqual(["2026-03-11"]);
  });

  it("only ever knows ONE future occurrence", () => {
    // The one after next depends on when next actually completes. Inventing a
    // date for it is the lie that makes a route drift.
    const found = dates({ ...route, lastOccurredOn: "2026-03-02" }, "2026-03-01", "2026-12-31");
    expect(found).toHaveLength(1);
  });

  it("starts from the start date when nothing has happened yet", () => {
    expect(dates(route, "2026-01-01", "2026-01-31")).toEqual(["2026-01-01"]);
  });
});

describe("materialized and manual series", () => {
  it("returns the dates as they are, without recomputing", () => {
    // These have been edited by hand. Regenerating from a rule discards every
    // one of those edits, which is the Jobber migration trap.
    const spec: RecurrenceSpec = {
      model: "materialized", startsOn: "2026-01-01",
      dates: ["2026-01-06", "2026-01-14", "2026-01-20"],
    };
    expect(dates(spec, "2026-01-01", "2026-01-31")).toEqual(["2026-01-06", "2026-01-14", "2026-01-20"]);
  });
});

describe("exceptions", () => {
  const weekly: RecurrenceSpec = { model: "rule", startsOn: "2026-01-05", intervalDays: 7 };

  it("removes a skipped occurrence", () => {
    const spec = { ...weekly, exceptions: [{ date: "2026-01-12", action: "skipped" as const }] };
    expect(dates(spec, "2026-01-01", "2026-01-26"))
      .toEqual(["2026-01-05", "2026-01-19", "2026-01-26"]);
  });

  it("moves an occurrence and keeps it in order", () => {
    const spec = {
      ...weekly,
      exceptions: [{ date: "2026-01-12", action: "moved" as const, movedTo: "2026-01-15" }],
    };
    expect(dates(spec, "2026-01-01", "2026-01-26"))
      .toEqual(["2026-01-05", "2026-01-15", "2026-01-19", "2026-01-26"]);
  });

  it("keeps the sequence number of a moved occurrence", () => {
    // "Visit two of four" has to stay true on the invoice after a reschedule.
    const spec = {
      ...weekly,
      exceptions: [{ date: "2026-01-12", action: "moved" as const, movedTo: "2026-01-15" }],
    };
    const moved = occurrencesBetween(spec, "2026-01-01", "2026-01-26").find((o) => o.moved);
    expect(moved?.sequence).toBe(2);
  });

  it("drops a cancelled occurrence entirely", () => {
    const spec = { ...weekly, exceptions: [{ date: "2026-01-05", action: "cancelled" as const }] };
    expect(dates(spec, "2026-01-01", "2026-01-12")).toEqual(["2026-01-12"]);
  });
});

describe("the horizon", () => {
  it("never generates beyond it", () => {
    const spec: RecurrenceSpec = {
      model: "rule", startsOn: "2026-01-05", intervalDays: 7, horizonMonths: 1,
    };
    const found = dates(spec, "2026-01-01", "2030-01-01");
    expect(found.every((d) => d <= "2026-02-01")).toBe(true);
  });
});

describe("nextOccurrence", () => {
  it("finds the next one strictly after a date", () => {
    const weekly: RecurrenceSpec = { model: "rule", startsOn: "2026-01-05", intervalDays: 7 };
    expect(nextOccurrence(weekly, "2026-01-05")).toBe("2026-01-12");
    expect(nextOccurrence(weekly, "2026-01-06")).toBe("2026-01-12");
  });

  it("returns null when the series has ended", () => {
    const ended: RecurrenceSpec = {
      model: "rule", startsOn: "2026-01-05", intervalDays: 7, endsOn: "2026-01-19",
    };
    expect(nextOccurrence(ended, "2026-01-19")).toBeNull();
  });
});

describe("agreement visit schedules", () => {
  it("puts a two visit seasonal plan in the right two seasons", () => {
    expect(agreementVisitDates({
      startsOn: "2026-01-10", termMonths: 12, includedVisits: 2, anchorMonths: [4, 10],
    })).toEqual(["2026-04-15", "2026-10-15"]);
  });

  it("spreads an unanchored plan evenly and not on the signing day", () => {
    // A tune up on the day somebody signs is both unlikely and a wasted
    // included visit.
    const found = agreementVisitDates({ startsOn: "2026-01-15", termMonths: 12, includedVisits: 4 });
    expect(found).toEqual(["2026-04-15", "2026-07-15", "2026-10-15", "2027-01-15"]);
    expect(found).not.toContain("2026-01-15");
  });

  it("returns nothing for a plan that includes no visits", () => {
    expect(agreementVisitDates({ startsOn: "2026-01-15", termMonths: 12, includedVisits: 0 })).toEqual([]);
  });

  it("never schedules past the end of the term", () => {
    const found = agreementVisitDates({ startsOn: "2026-01-15", termMonths: 6, includedVisits: 2 });
    expect(found.every((d) => d <= "2026-07-15")).toBe(true);
  });
});
