import { describe, it, expect } from "vitest";
import { reporting as r, money as m } from "../src/index";

const usd = (v: string) => m.money(v, "USD");

describe("how two halves become a number", () => {
  it("is nothing, never nought, over an empty denominator", () => {
    expect(r.combine("percent", 0, 0)).toBeNull();
    expect(r.combine("money", 500, 0)).toBeNull();
    // Nought per cent is a real answer when there was something to measure.
    expect(r.combine("percent", 0, 12)).toBe("0.0");
  });

  it("keeps a percentage to a decimal place, money to four, and a ratio to two", () => {
    expect(r.combine("percent", 1, 3)).toBe("33.3");
    expect(r.combine("money", 1000, 3)).toBe("333.3333");
    expect(r.combine("number", 22, 3)).toBe("7.33");
    expect(r.combine("duration", 5, 4)).toBe("1.25");
  });

  it("keeps the sign of a loss", () => {
    expect(r.combine("percent", -50, 200)).toBe("-25.0");
  });
});

describe("the days a crew worked", () => {
  const zone = "America/Chicago";
  /** 15:00 UTC is mid morning in Chicago, so the day is the same date everywhere it is read. */
  const at = (day: string, hour = 15) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const stop = (id: string, crewId: string | null, day: string, status = "completed") =>
    ({ id, crewId, status, completedAt: status === "completed" ? at(day) : null });
  const punch = (visitId: string | null, day: string, kind = "on_site", hour = 14) =>
    ({ visitId, kind, startedAt: at(day, hour) });

  it("counts one day per crew however many people clocked in on it", () => {
    const days = r.crewDays({
      zone,
      visits: [stop("v1", "north", "2026-06-10")],
      punches: [punch("v1", "2026-06-10"), punch("v1", "2026-06-10"), punch("v1", "2026-06-10"), punch("v1", "2026-06-10")],
    });
    expect(days).toEqual([{ crewId: "north", day: "2026-06-10" }]);
  });

  it("counts a crew's days apart from another crew's on the same day", () => {
    const days = r.crewDays({
      zone,
      visits: [stop("v1", "north", "2026-06-10"), stop("v2", "south", "2026-06-10")],
      punches: [punch("v1", "2026-06-10"), punch("v2", "2026-06-10")],
    });
    expect(days.map((d) => d.crewId)).toEqual(["north", "south"]);
  });

  it("leaves out a rain day: the crew clocked in and completed no stop", () => {
    const days = r.crewDays({
      zone,
      visits: [stop("v1", "north", "2026-06-10", "scheduled")],
      punches: [punch("v1", "2026-06-10")],
    });
    expect(days).toEqual([]);
  });

  it("leaves out yard and shop time, leave and a punch on no crew's visit", () => {
    const days = r.crewDays({
      zone,
      visits: [stop("v1", "north", "2026-06-10"), stop("solo", null, "2026-06-10")],
      punches: [
        punch("v1", "2026-06-10", "shop"), punch("v1", "2026-06-10", "pto"), punch("v1", "2026-06-10", "training"),
        punch("v1", "2026-06-10", "unpaid_break"), punch("v1", "2026-06-10", "holiday"),
        punch("solo", "2026-06-10"), punch(null, "2026-06-10"),
      ],
    });
    expect(days).toEqual([]);
  });

  it("counts travel, on site and paid breaks and on call as the crew's day", () => {
    for (const kind of ["travel", "on_site", "paid_break", "on_call"]) {
      expect(r.crewDays({
        zone, visits: [stop("v1", "north", "2026-06-10")], punches: [punch("v1", "2026-06-10", kind)],
      })).toHaveLength(1);
    }
  });

  it("needs the stop and the clock on the SAME day", () => {
    const days = r.crewDays({
      zone,
      visits: [stop("v1", "north", "2026-06-11")],
      punches: [punch("v1", "2026-06-10")],
    });
    expect(days).toEqual([]);
  });

  it("reads the day where the company is, not in UTC", () => {
    // 02:00 UTC on the 11th is the evening of the 10th in Chicago, for the punch and for the stop.
    const days = r.crewDays({
      zone,
      visits: [{ id: "v1", crewId: "north", status: "completed", completedAt: at("2026-06-11", 2) }],
      punches: [punch("v1", "2026-06-11", "on_site", 1)],
    });
    expect(days).toEqual([{ crewId: "north", day: "2026-06-10" }]);
  });
});

describe("an install's margin", () => {
  const job = (over: Partial<r.InstallJob> = {}): r.InstallJob => ({
    revenue: usd("10000"), material: usd("3500"), labour: usd("2800"), burden: usd("400"),
    openPunches: 0, unpricedLabourHours: 0, undecidedLines: 0, uncostedLines: 0, labourRecorded: true,
    ...over,
  });

  it("is revenue less material, labour and burden, over revenue", () => {
    expect(m.toString(r.installEarned(job()))).toBe("3300.0000");
    const margin = r.installMargin([job(), job({ revenue: usd("5000"), material: usd("1000"), labour: usd("1000"), burden: usd("200") })]);
    expect(margin.jobs).toBe(2);
    expect(m.toString(margin.earned)).toBe("6100.0000");
    expect(m.toString(margin.revenue)).toBe("15000.0000");
    expect(margin.percent).toBe("40.7");
  });

  it("leaves out an install whose costs are not all in, from both halves", () => {
    const unfinished = [
      job({ labourRecorded: false }),
      job({ openPunches: 1 }),
      job({ unpricedLabourHours: 2.5 }),
      job({ undecidedLines: 1 }),
      job({ uncostedLines: 1 }),
    ];
    for (const one of unfinished) expect(r.costsAreIn(one)).toBe(false);
    const margin = r.installMargin([job(), ...unfinished]);
    expect(margin.jobs).toBe(1);
    expect(m.toString(margin.revenue)).toBe("10000.0000");
    expect(margin.percent).toBe("33.0");
  });

  it("is nothing when no install has its costs in, rather than a margin of nought", () => {
    expect(r.installMargin([job({ labourRecorded: false })]).percent).toBeNull();
    expect(r.installMargin([]).percent).toBeNull();
  });

  it("reads a loss as a negative percentage", () => {
    const margin = r.installMargin([job({ revenue: usd("2000"), material: usd("2500") })]);
    expect(margin.percent).toBe("-185.0");
  });

  it("charges a warranty install its cost with no revenue against it", () => {
    const margin = r.installMargin([job(), job({ revenue: usd("0"), material: usd("300"), labour: usd("0"), burden: usd("0") })]);
    expect(m.toString(margin.earned)).toBe("3000.0000");
    expect(margin.percent).toBe("30.0");
  });
});
