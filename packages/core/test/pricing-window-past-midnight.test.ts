import { describe, it, expect } from "vitest";
import * as m from "../src/money/index.js";
import { plugins } from "../src/index";

/**
 * A PRICING WINDOW THAT RUNS PAST MIDNIGHT
 *
 * "From 6pm to 6am" is one rule. Its days are the days the window STARTS on:
 * Monday and Tuesday mean Monday evening to Tuesday morning and Tuesday
 * evening to Wednesday morning, so work at three on Tuesday morning is inside
 * it (the window that holds it started on Monday) and work at three on Monday
 * morning is not, unless Sunday is listed. 2026-11-02 is a Monday.
 */
const types = { jobTypeIds: [] as string[] };
const window = (days: number[], from: string, to: string): plugins.TimeWindow => ({ days, from, to });
const at = (hh: number, mm = 0) => hh * 60 + mm;
const MON = 1, TUE = 2, WED = 3, SAT = 6, SUN = 0;

describe("a window that ends the next day is accepted", () => {
  const check = (w: unknown) => plugins.checkPricingRule({ kind: "time_window", window: w, percent: "25" }, types);

  it("takes from 18:00 to 06:00 as one rule, days sorted", () => {
    expect(check({ days: [2, 1], from: "18:00", to: "06:00" }))
      .toEqual({ ok: true, value: { kind: "time_window", window: { days: [1, 2], from: "18:00", to: "06:00" }, percent: "25" } });
  });

  it("takes an evening to midnight written either way, and still takes a window inside one day", () => {
    expect(check({ days: [1], from: "18:00", to: "24:00" }).ok).toBe(true);
    expect(check({ days: [1], from: "18:00", to: "00:00" }).ok).toBe(true);
    expect(check({ days: [1], from: "08:00", to: "17:00" }).ok).toBe(true);
    expect(check({ days: [1], from: "00:00", to: "06:00" }).ok).toBe(true);
  });

  it("refuses a window that starts and ends at the same minute, and one that starts at 24:00, in words", () => {
    const refusal = (w: unknown) => { const c = check(w); return c.ok ? [] : c.problems; };
    expect(refusal({ days: [1], from: "06:00", to: "06:00" }))
      .toEqual(["A window has to start and end at different times. One that runs past midnight is fine: from 18:00 to 06:00 is the evening and the night after it."]);
    expect(refusal({ days: [1], from: "24:00", to: "06:00" }))
      .toEqual(["A window cannot start at 24:00. Start it at 00:00, the first minute of the day."]);
  });

  it("still refuses bad days and bad times, as it always did", () => {
    expect(check({ days: [], from: "18:00", to: "06:00" }).ok).toBe(false);
    expect(check({ days: [1, 1], from: "18:00", to: "06:00" }).ok).toBe(false);
    expect(check({ days: [1], from: "6pm", to: "06:00" }).ok).toBe(false);
    expect(check({ days: [1], from: "18:00", to: "25:00" }).ok).toBe(false);
  });
});

describe("whether work is inside it", () => {
  const night = window([MON, TUE], "18:00", "06:00");

  it("holds the evening of a listed day and the morning after it", () => {
    expect(plugins.inWindow(night, MON, at(18))).toBe(true);
    expect(plugins.inWindow(night, MON, at(23, 59))).toBe(true);
    expect(plugins.inWindow(night, TUE, at(0))).toBe(true);
    expect(plugins.inWindow(night, TUE, at(3))).toBe(true);
    expect(plugins.inWindow(night, TUE, at(5, 59))).toBe(true);
    // The Tuesday evening starts the Tuesday window, which runs into Wednesday morning.
    expect(plugins.inWindow(night, TUE, at(20))).toBe(true);
    expect(plugins.inWindow(night, WED, at(2))).toBe(true);
  });

  it("does not hold the morning of the first day, the end minute, the daytime or the day after the last window", () => {
    // Monday at 3am belongs to a window that started on Sunday, which is not listed.
    expect(plugins.inWindow(night, MON, at(3))).toBe(false);
    expect(plugins.inWindow(night, TUE, at(6))).toBe(false);
    expect(plugins.inWindow(night, MON, at(12))).toBe(false);
    expect(plugins.inWindow(night, MON, at(17, 59))).toBe(false);
    expect(plugins.inWindow(night, WED, at(6))).toBe(false);
    expect(plugins.inWindow(night, WED, at(20))).toBe(false);
  });

  it("carries a Saturday night into Sunday morning, and a Sunday night into Monday morning", () => {
    expect(plugins.inWindow(window([SAT], "18:00", "06:00"), SUN, at(2))).toBe(true);
    expect(plugins.inWindow(window([SAT], "18:00", "06:00"), SAT, at(2))).toBe(false);
    expect(plugins.inWindow(window([SUN], "22:00", "05:00"), MON, at(4))).toBe(true);
    expect(plugins.inWindow(window([SUN], "22:00", "05:00"), MON, at(5))).toBe(false);
  });

  it("is an evening to midnight when it ends at midnight either way, and the same as ever inside one day", () => {
    for (const to of ["24:00", "00:00"]) {
      const evening = window([MON], "18:00", to);
      expect(plugins.inWindow(evening, MON, at(23, 59))).toBe(true);
      expect(plugins.inWindow(evening, TUE, at(0))).toBe(false);
      expect(plugins.inWindow(evening, MON, at(17))).toBe(false);
    }
    const day = window([MON, TUE], "08:00", "17:00");
    expect(plugins.inWindow(day, MON, at(8))).toBe(true);
    expect(plugins.inWindow(day, MON, at(17))).toBe(false);
    expect(plugins.inWindow(day, WED, at(9))).toBe(false);
  });

  it("holds every hour of a week-long window, since every night starts one", () => {
    const all = window([0, 1, 2, 3, 4, 5, 6], "18:00", "06:00");
    for (let d = 0; d < 7; d += 1) {
      expect(plugins.inWindow(all, d, at(2))).toBe(true);
      expect(plugins.inWindow(all, d, at(12))).toBe(false);
      expect(plugins.inWindow(all, d, at(22))).toBe(true);
    }
  });
});

describe("a rule with such a window prices the work it holds", () => {
  const usd = (v: string) => m.money(v, "USD");
  const line: plugins.RuleLine = { quantity: "1", unitPrice: usd("200"), discountAmount: usd("0"), touchable: true, counts: true };
  const rule = (w: plugins.TimeWindow): plugins.ActiveRule => ({
    id: "night", name: "Night call", appName: "Acme", version: 1,
    rule: { kind: "time_window", window: w, percent: "50" },
  });
  const factsAt = (dayOfWeek: number, minute: number): plugins.RuleFacts =>
    ({ customerTags: [], jobTypeId: null, work: { dayOfWeek, minute, outsideHours: false } });
  const priced = (w: plugins.TimeWindow, dayOfWeek: number, minute: number) =>
    m.toString(plugins.applyPricingRules([line], [rule(w)], factsAt(dayOfWeek, minute))[0]!.unitPrice);

  it("adds fifty percent to a visit at three on Tuesday morning and not to one at three in the afternoon", () => {
    const night = window([MON], "18:00", "06:00");
    expect(priced(night, TUE, at(3))).toBe("300.0000");
    expect(priced(night, MON, at(19))).toBe("300.0000");
    expect(priced(night, TUE, at(15))).toBe("200.0000");
    expect(priced(night, MON, at(3))).toBe("200.0000");
  });
});

describe("the rule in one sentence", () => {
  it("names the day it starts and says it ends the next one", () => {
    expect(plugins.describeRule({ kind: "time_window", window: window([1, 2], "18:00", "06:00"), percent: "50" }))
      .toBe("50% added for work from 18:00 on Mon, Tue until 06:00 the next day");
    expect(plugins.describeRule({ kind: "time_window", window: window([0, 6], "20:00", "02:30"), amount: "-25.00" }))
      .toBe("$25.00 off for work from 20:00 on Sun, Sat until 02:30 the next day");
  });

  it("reads a window inside one day as it always did", () => {
    expect(plugins.describeRule({ kind: "time_window", window: window([1, 2], "08:00", "17:00"), percent: "20" }))
      .toBe("20% added for work on Mon, Tue from 08:00 to 17:00");
    expect(plugins.describeRule({ kind: "time_window", window: window([6], "18:00", "24:00"), percent: "10" }))
      .toBe("10% added for work on Sat from 18:00 to 24:00");
  });

  it("knows which windows run past midnight", () => {
    expect(plugins.windowWraps(window([1], "18:00", "06:00"))).toBe(true);
    expect(plugins.windowWraps(window([1], "18:00", "00:00"))).toBe(true);
    expect(plugins.windowWraps(window([1], "08:00", "17:00"))).toBe(false);
    expect(plugins.windowWraps(window([1], "18:00", "24:00"))).toBe(false);
  });
});
