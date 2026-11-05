import { describe, it, expect } from "vitest";
import { holidays, voice } from "../src/index.js";

/**
 * M18. A phone menu's own week is chosen apart from every other owner's, and
 * a callback number typed on a keypad is checked before it is ever rung.
 */

const row = (over: Partial<holidays.WeekRow> & { dayOfWeek: number }): holidays.WeekRow => ({
  businessUnitId: null, opensAt: "08:00", closesAt: "17:00", closed: false, ...over,
});
const days = (over: Partial<holidays.WeekRow>) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => row({ dayOfWeek, ...over }));

describe("a phone menu's own week", () => {
  const company = days({});
  const menuOwn = days({ phoneMenuId: "menu-1", opensAt: "09:00", closesAt: "12:00" });
  const rows = [...company, ...menuOwn];

  it("is never read as the company's or a branch's week", () => {
    const chosen = holidays.weekFor(rows, null);
    expect(chosen.source).toBe("company");
    expect(chosen.rows).toHaveLength(7);
    expect(chosen.rows.every((r) => (r.phoneMenuId ?? null) === null)).toBe(true);
    expect(holidays.weekFor(rows, "branch-1").source).toBe("company");
  });

  it("is the menu's own when it keeps its own, and none when nobody wrote it", () => {
    const own = holidays.weekForMenu(rows, { id: "menu-1", businessUnitId: null, hoursFrom: "own" });
    expect(own.source).toBe("menu");
    expect(own.week?.[1]).toEqual({ openMinute: 9 * 60, closeMinute: 12 * 60 });
    expect(own.seasons).toBeUndefined();
    expect(holidays.weekForMenu(rows, { id: "menu-2", businessUnitId: null, hoursFrom: "own" }).source).toBe("none");
  });

  it("follows the company's or a branch's week with their seasons", () => {
    const seasons = [{ id: "s1", businessUnitId: null, name: "Summer", startsOn: "2027-06-01", endsOn: "2027-08-31", repeatsYearly: false }];
    const withSeason = [...rows, ...days({ seasonId: "s1", opensAt: "07:00", closesAt: "15:00" })];
    const chosen = holidays.weekForMenu(withSeason, { id: "menu-1", businessUnitId: null, hoursFrom: "company" }, seasons);
    expect(chosen.source).toBe("company");
    expect(holidays.weekOn(chosen, "2027-07-01").season?.name).toBe("Summer");
    expect(holidays.weekOn(chosen, "2027-01-04").season).toBeNull();
    expect(holidays.weekForMenu(withSeason, { id: "menu-1", businessUnitId: "branch-1", hoursFrom: "branch" }, seasons).source).toBe("company");
  });
});

describe("checking a menu that keeps its own hours", () => {
  const directory = { ...voice.emptyDirectory(), menus: new Map([["m1", "Sales"]]) };
  const menu: voice.PhoneMenu = {
    id: "m1", name: "Sales", greeting: "Sales.", timeoutSeconds: 6,
    options: [{ key: "1", label: "Quotes", to: { kind: "voicemail", box: "main" } }],
    noInputTo: { kind: "voicemail", box: "main" }, afterHoursTo: null,
  };

  it("needs somewhere to send a closed call", () => {
    expect(voice.checkMenu({ ...menu, hoursFrom: "own" }, directory)).toMatchObject({ ok: false });
    expect(voice.checkMenu({ ...menu, hoursFrom: "number" }, directory)).toEqual({ ok: true });
    expect(voice.checkMenu({ ...menu, hoursFrom: "company", afterHoursTo: { kind: "voicemail", box: "main" } }, directory)).toEqual({ ok: true });
  });
});

describe("a callback number typed on the keypad", () => {
  it("takes ten digits, or eleven with the 1, and the pound that ends them", () => {
    expect(voice.typedCallbackNumber("5125550147")).toEqual({ ok: true, e164: "+15125550147" });
    expect(voice.typedCallbackNumber("15125550147#")).toEqual({ ok: true, e164: "+15125550147" });
  });

  it("refuses what is not a number it can ring, in words a caller hears", () => {
    expect(voice.typedCallbackNumber("")).toMatchObject({ ok: false, why: "Sorry, I did not get a number." });
    expect(voice.typedCallbackNumber("911")).toMatchObject({ ok: false });
    expect(voice.typedCallbackNumber("512555014")).toMatchObject({ ok: false });
    expect(voice.typedCallbackNumber("25125550147")).toMatchObject({ ok: false });
    expect(voice.typedCallbackNumber("5125*50147")).toMatchObject({ ok: false });
    expect(voice.typedCallbackNumber("0125550147")).toMatchObject({ ok: false });
    expect(voice.typedCallbackNumber("5121550147")).toMatchObject({ ok: false });
    expect(voice.typedCallbackNumber("4115550147")).toMatchObject({ ok: false });
    expect(voice.typedCallbackNumber("5129110147")).toMatchObject({ ok: false });
    expect(voice.typedCallbackNumber("9005550147")).toMatchObject({ ok: false, why: "Sorry, we cannot call that kind of number back." });
    expect(voice.typedCallbackNumber("5129760147")).toMatchObject({ ok: false, why: "Sorry, we cannot call that kind of number back." });
  });

  it("reads the number back a digit at a time", () => {
    expect(voice.typedNumberReadBack("+15125550147"))
      .toBe("You typed 5 1 2, 5 5 5, 0 1 4 7. To be called back on that number, press 1. To type it again, press 2.");
  });

  it("asks the carrier for up to eleven digits ended by pound", () => {
    expect(voice.twiml([{ verb: "gather", action: "https://x.test/a", numDigits: 11, finishOnKey: "#", timeoutSeconds: 8, say: "Type it." }]))
      .toContain('<Gather action="https://x.test/a" method="POST" numDigits="11" timeout="8" finishOnKey="#"><Say>Type it.</Say></Gather>');
  });
});
