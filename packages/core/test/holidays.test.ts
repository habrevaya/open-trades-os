import { describe, it, expect } from "vitest";
import {
  checkHoliday, holidayOn, holidaysBetween, nextDate, closedOn, forPhones, describeDay, bookedAt, type CompanyHoliday,
} from "../src/holidays/index.js";
import { respondBy, DEFAULT_RESPONSE_BANDS, type ResponsePolicy } from "../src/reviews/index.js";
import { businessHoursFrom, routeCall } from "../src/voice/index.js";

const closed = (name: string, date: string, repeatsYearly = false): CompanyHoliday =>
  ({ name, date, repeatsYearly, closed: true, openMinute: null, closeMinute: null });

const CHRISTMAS = closed("Christmas Day", "2020-12-25", true);
const EVE: CompanyHoliday = {
  name: "Christmas Eve", date: "2026-12-24", repeatsYearly: false, closed: false, openMinute: 8 * 60, closeMinute: 12 * 60,
};

describe("what the list says about a date", () => {
  it("repeats a yearly date every year, whatever year it was entered in", () => {
    expect(holidayOn([CHRISTMAS], "2026-12-25")).toMatchObject({ name: "Christmas Day", closed: true, hours: null });
    expect(holidayOn([CHRISTMAS], "2031-12-25")).not.toBeNull();
    expect(holidayOn([CHRISTMAS], "2026-12-26")).toBeNull();
  });

  it("keeps a one off date to its own year", () => {
    expect(holidayOn([EVE], "2026-12-24")).toMatchObject({ closed: false, hours: { openMinute: 480, closeMinute: 720 } });
    expect(holidayOn([EVE], "2027-12-24")).toBeNull();
  });

  it("lets a date entered for this year beat the yearly one on the same day", () => {
    const openThisYear: CompanyHoliday = { ...EVE, name: "Open Christmas morning", date: "2026-12-25" };
    expect(holidayOn([CHRISTMAS, openThisYear], "2026-12-25")).toMatchObject({ name: "Open Christmas morning", closed: false });
    expect(holidayOn([CHRISTMAS, openThisYear], "2027-12-25")).toMatchObject({ name: "Christmas Day", closed: true });
  });

  it("says a short day is not a closed one", () => {
    expect(closedOn([EVE], "2026-12-24")).toBe(false);
    expect(closedOn([CHRISTMAS], "2026-12-25")).toBe(true);
    expect(describeDay(holidayOn([EVE], "2026-12-24")!)).toBe("Open 08:00 to 12:00");
  });

  it("lists the dates in a range in order, and nothing for an empty list", () => {
    expect(holidaysBetween([CHRISTMAS, EVE], "2026-12-01", "2027-01-31").map((d) => d.date))
      .toEqual(["2026-12-24", "2026-12-25"]);
    expect(holidaysBetween([], "2026-01-01", "2026-12-31")).toEqual([]);
  });

  it("finds the next time a holiday comes round", () => {
    expect(nextDate(CHRISTMAS, "2026-10-05")).toBe("2026-12-25");
    expect(nextDate(CHRISTMAS, "2026-12-26")).toBe("2027-12-25");
    expect(nextDate(EVE, "2027-01-01")).toBeNull();
  });
});

describe("what a holiday may say", () => {
  it("needs a name and a real date", () => {
    expect(checkHoliday({ ...CHRISTMAS, name: " " })).toMatchObject({ ok: false, field: "name" });
    expect(checkHoliday({ ...CHRISTMAS, date: "2026-02-30" })).toMatchObject({ ok: false, field: "date" });
  });

  it("refuses a yearly 29th of February rather than moving it", () => {
    expect(checkHoliday(closed("Leap day", "2028-02-29", true))).toMatchObject({ ok: false, field: "date" });
    expect(checkHoliday(closed("Leap day", "2028-02-29", false))).toEqual({ ok: true });
  });

  it("needs hours on a day that is open, and hours that close after they open", () => {
    expect(checkHoliday({ ...EVE, openMinute: null })).toMatchObject({ ok: false, field: "hours" });
    expect(checkHoliday({ ...EVE, openMinute: 720, closeMinute: 480 })).toMatchObject({ ok: false, field: "hours" });
    expect(checkHoliday(EVE)).toEqual({ ok: true });
  });
});

describe("the phones on a holiday", () => {
  const weekday = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt: "08:00:00", closesAt: "17:00:00", closed: false }));
  const number = { forwardsToE164: "+15125550100", routeByHours: true, afterHoursForwardsToE164: "+15125550199" };

  it("sends a call on a closed holiday where an after hours call goes", () => {
    // Friday 2026-12-25 at 10:00 in Chicago.
    const now = new Date("2026-12-25T16:00:00Z");
    const hours = businessHoursFrom(weekday, "America/Chicago", forPhones([CHRISTMAS], "2026-12-24", "2026-12-26"));
    const routed = routeCall({ number, dialled: "+15125550000", hours, knownCustomer: false, now });
    expect(routed.destination).toEqual({ kind: "forward", e164: "+15125550199" });
  });

  it("keeps a short day's own hours", () => {
    const hours = businessHoursFrom(weekday, "America/Chicago", forPhones([EVE], "2026-12-23", "2026-12-25"));
    const morning = routeCall({ number, dialled: "+15125550000", hours, knownCustomer: false, now: new Date("2026-12-24T16:00:00Z") });
    const afternoon = routeCall({ number, dialled: "+15125550000", hours, knownCustomer: false, now: new Date("2026-12-24T20:00:00Z") });
    expect(morning.destination).toEqual({ kind: "forward", e164: "+15125550100" });
    expect(afternoon.destination).toEqual({ kind: "forward", e164: "+15125550199" });
  });
});

describe("the reviews clock on a holiday", () => {
  const policy: ResponsePolicy = {
    timeZone: "America/Chicago", businessDays: [1, 2, 3, 4, 5], openHour: 8, closeHour: 17, bands: DEFAULT_RESPONSE_BANDS,
  };
  const oneStar = DEFAULT_RESPONSE_BANDS[0]!;

  it("does not run on a closed holiday", () => {
    // Posted Wednesday 2026-12-23 at 16:00 Chicago: one open hour that day, then Thursday's short day, then Christmas.
    const posted = new Date("2026-12-23T22:00:00Z");
    const plain = respondBy(posted, oneStar, policy);
    const withHolidays = respondBy(posted, oneStar, { ...policy, holidays: [CHRISTMAS, EVE] });
    // Without the list: one hour Wednesday, three Thursday morning, due Thursday at 11:00.
    expect(plain.toISOString()).toBe("2026-12-24T17:00:00.000Z");
    // With it: Thursday runs 08:00 to 12:00, so still 11:00; push it past noon to see Christmas skipped.
    expect(withHolidays.toISOString()).toBe("2026-12-24T17:00:00.000Z");
    const later = respondBy(new Date("2026-12-24T17:30:00Z"), oneStar, { ...policy, holidays: [CHRISTMAS, EVE] });
    // 11:30 Thursday: half an hour left that day, Christmas closed, Saturday and Sunday shut, so Monday at 11:30.
    expect(later.toISOString()).toBe("2026-12-28T17:30:00.000Z");
  });
});

describe("whether a booked time was after hours or on a holiday", () => {
  const nineToFive = { openMinute: 9 * 60, closeMinute: 17 * 60 };
  // Sunday and Saturday closed.
  const week = [null, nineToFive, nineToFive, nineToFive, nineToFive, nineToFive, null];

  it("is neither inside the week's hours", () => {
    // Tuesday 2026-10-06 at 10:00.
    expect(bookedAt({ week, holidays: [], date: "2026-10-06", minute: 600 }))
      .toMatchObject({ holiday: null, outsideHours: false });
  });

  it("is after hours after the close, before the opening and on a closed weekday", () => {
    expect(bookedAt({ week, holidays: [], date: "2026-10-06", minute: 19 * 60 }))
      .toMatchObject({ outsideHours: true, why: "2026-10-06 at 19:00, after the 17:00 close" });
    expect(bookedAt({ week, holidays: [], date: "2026-10-06", minute: 7 * 60 }).why).toBe("2026-10-06 at 07:00, before the 09:00 opening");
    expect(bookedAt({ week, holidays: [], date: "2026-10-10", minute: 600 }))
      .toMatchObject({ outsideHours: true, why: "2026-10-10 at 10:00, on a day you are closed" });
  });

  it("is a holiday on a date in the list, and after hours too when the day is closed or the time is past its short hours", () => {
    const closedDay = bookedAt({ week, holidays: [CHRISTMAS], date: "2026-12-25", minute: 600 });
    expect(closedDay).toMatchObject({ outsideHours: true, why: "2026-12-25 at 10:00, on Christmas Day, when you are closed" });
    expect(closedDay.holiday?.name).toBe("Christmas Day");
    expect(bookedAt({ week, holidays: [EVE], date: "2026-12-24", minute: 10 * 60 }))
      .toMatchObject({ outsideHours: false, why: "2026-12-24 at 10:00, on Christmas Eve" });
    expect(bookedAt({ week, holidays: [EVE], date: "2026-12-24", minute: 13 * 60 }))
      .toMatchObject({ outsideHours: true, why: "2026-12-24 at 13:00, after the 12:00 close on Christmas Eve" });
  });

  it("never calls a time after hours when no weekly hours are declared, and still knows a holiday", () => {
    expect(bookedAt({ week: null, holidays: [], date: "2026-10-06", minute: 23 * 60 }).outsideHours).toBe(false);
    expect(bookedAt({ week: null, holidays: [CHRISTMAS], date: "2026-12-25", minute: 600 }).holiday).not.toBeNull();
  });
});
