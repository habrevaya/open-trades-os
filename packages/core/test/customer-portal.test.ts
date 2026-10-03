import { describe, it, expect } from "vitest";
import {
  signInAddress, newCode, normaliseCode, codeMessage, checkTipSettings, readTipSettings, tipChoices,
  checkTip, splitTip, settleTip, photoShown, readPortalSettings, DEFAULT_TIP_SETTINGS, CODE_LENGTH,
} from "../src/customer-portal/index.js";
import * as labor from "../src/labor/index.js";
import { postTipPayout, postPayment, ACCOUNTS } from "../src/ledger/index.js";
import { money, toString as m, sum, zero } from "../src/money/index.js";
import { instantOfLocal } from "../src/time/index.js";

/**
 * THE CUSTOMER SIGNED IN
 *
 * A code is the only thing between a stranger and somebody's saved card, a
 * tip is somebody else's money the company is holding, and a photograph of a
 * house is private until somebody decides otherwise. Each rule below is one
 * of those three, stated as a test.
 */

const usd = (v: string) => money(v, "USD");

describe("the address a code goes to", () => {
  it("is an email when it has an at sign, lower cased", () => {
    expect(signInAddress("  Dana.Kim@Example.COM ")).toEqual({ channel: "email", address: "dana.kim@example.com" });
  });

  it("is a text when it is a phone number however it was typed", () => {
    expect(signInAddress("(512) 555-0192")).toEqual({ channel: "sms", address: "+15125550192" });
    expect(signInAddress("+1 512 555 0192")).toEqual({ channel: "sms", address: "+15125550192" });
  });

  it("is nothing at all when it is neither", () => {
    expect(signInAddress("")).toBeNull();
    expect(signInAddress("dana@")).toBeNull();
    expect(signInAddress("555-01")).toBeNull();
    expect(signInAddress("call me maybe")).toBeNull();
  });
});

describe("a sign in code", () => {
  it("is six digits from the randomness it is given", () => {
    const digits = [4, 8, 2, 9, 1, 3];
    let i = 0;
    expect(newCode(() => digits[i++]!)).toBe("482913");
    expect(newCode(() => 0)).toHaveLength(CODE_LENGTH);
  });

  it("is matched however it was copied off a phone", () => {
    expect(normaliseCode("482 913")).toBe("482913");
    expect(normaliseCode("482-913")).toBe("482913");
    expect(normaliseCode("48291")).toBeNull();
    expect(normaliseCode("48291a")).toBeNull();
  });

  it("goes out in a text short enough to be one text", () => {
    const message = codeMessage("Cedar Ridge Heating and Air", "482913");
    expect(message.text.length).toBeLessThanOrEqual(160);
    expect(message.text).toContain("482913");
    expect(message.subject).toContain("Cedar Ridge");
  });
});

describe("tip settings", () => {
  it("are off unless somebody turns them on", () => {
    expect(readTipSettings(undefined)).toEqual(DEFAULT_TIP_SETTINGS);
    expect(readTipSettings({ enabled: "yes" }).enabled).toBe(false);
    expect(DEFAULT_TIP_SETTINGS.enabled).toBe(false);
  });

  it("offer one to four whole percentages, in order", () => {
    expect(checkTipSettings({ enabled: true, presets: [20, "10", 15] }))
      .toEqual({ ok: true, settings: { enabled: true, presets: [10, 15, 20] } });
    expect(checkTipSettings({ enabled: true, presets: [] }).ok).toBe(false);
    expect(checkTipSettings({ enabled: true, presets: [5, 10, 15, 20, 25] }).ok).toBe(false);
    expect(checkTipSettings({ enabled: true, presets: [12.5] }).ok).toBe(false);
    expect(checkTipSettings({ enabled: true, presets: [150] }).ok).toBe(false);
    expect(checkTipSettings({ enabled: true, presets: [10, 10] }).ok).toBe(false);
  });

  it("read a malformed blob as tipping off rather than as an error", () => {
    expect(readTipSettings({ enabled: true, presets: "lots" }).enabled).toBe(false);
  });

  it("come to whole cents on the amount being paid", () => {
    expect(tipChoices(usd("259.11"), [10, 15, 20]).map((c) => m(c.amount)))
      .toEqual(["25.9100", "38.8700", "51.8200"]);
  });
});

describe("a tip somebody typed", () => {
  const on = { enabled: true, presets: [10, 15, 20] };

  it("can be nothing, whether or not the company takes tips", () => {
    expect(checkTip("", usd("100"), DEFAULT_TIP_SETTINGS)).toEqual({ ok: true, tip: zero("USD") });
    expect(checkTip("0.00", usd("100"), DEFAULT_TIP_SETTINGS)).toEqual({ ok: true, tip: zero("USD") });
  });

  it("is refused when the company does not take tips", () => {
    expect(checkTip("5", usd("100"), DEFAULT_TIP_SETTINGS).ok).toBe(false);
  });

  it("is refused below zero, below a cent and above the bill", () => {
    expect(checkTip("-5", usd("100"), on).ok).toBe(false);
    expect(checkTip("5.001", usd("100"), on).ok).toBe(false);
    expect(checkTip("abc", usd("100"), on).ok).toBe(false);
    const stray = checkTip("1000", usd("100"), on);
    expect(stray.ok).toBe(false);
    if (!stray.ok) expect(stray.reason).toContain("$100.00");
  });

  it("is taken as typed when it fits", () => {
    const tip = checkTip("12.50", usd("100"), on);
    expect(tip.ok && m(tip.tip)).toBe("12.5000");
  });
});

describe("a tip split between the technicians", () => {
  it("adds back to the tip to the cent, the odd cent always to the same person", () => {
    const shares = splitTip(usd("10.00"), ["tech-c", "tech-a", "tech-b", "tech-a"]);
    expect(shares.map((s) => s.technicianId)).toEqual(["tech-a", "tech-b", "tech-c"]);
    expect(shares.map((s) => m(s.amount))).toEqual(["3.3400", "3.3300", "3.3300"]);
    expect(m(sum(shares.map((s) => s.amount), "USD"))).toBe("10.0000");
  });

  it("is nothing when there is nobody or no tip", () => {
    expect(splitTip(usd("10"), [])).toEqual([]);
    expect(splitTip(zero("USD"), ["tech-a"])).toEqual([]);
  });
});

describe("what arrived, between the bill and the tip", () => {
  it("is the bill and the tip when everything asked for arrived", () => {
    const out = settleTip({ reported: usd("115"), invoicePart: usd("100"), tip: usd("15") });
    expect([m(out.applied), m(out.tip)]).toEqual(["100.0000", "15.0000"]);
  });

  it("pays the bill first when less arrived than was asked", () => {
    const short = settleTip({ reported: usd("108"), invoicePart: usd("100"), tip: usd("15") });
    expect([m(short.applied), m(short.tip)]).toEqual(["100.0000", "8.0000"]);
    const shorter = settleTip({ reported: usd("90"), invoicePart: usd("100"), tip: usd("15") });
    expect([m(shorter.applied), m(shorter.tip)]).toEqual(["90.0000", "0.0000"]);
  });

  it("never makes a tip out of money nobody tipped", () => {
    const out = settleTip({ reported: usd("130"), invoicePart: usd("100"), tip: usd("15") });
    expect([m(out.applied), m(out.tip)]).toEqual(["115.0000", "15.0000"]);
    const none = settleTip({ reported: usd("130"), invoicePart: usd("100"), tip: zero("USD") });
    expect(m(none.tip)).toBe("0.0000");
  });
});

describe("on the books", () => {
  it("holds a tip as owed to the technician when it arrives, and never as revenue", () => {
    const posting = postPayment({
      paymentId: "p1", occurredAt: new Date(), appliedAmount: usd("100"), tipAmount: usd("15"),
    });
    const tips = posting.entries.filter((e) => e.accountCode === ACCOUNTS.TIPS_PAYABLE);
    expect(tips.map((e) => [e.direction, m(e.amount)])).toEqual([["credit", "15.0000"]]);
    expect(posting.entries.some((e) => e.accountCode === ACCOUNTS.REVENUE)).toBe(false);
  });

  it("discharges that liability against cash when the tips are paid out, and touches nothing else", () => {
    const posting = postTipPayout({ payrollRunId: "pp", occurredAt: new Date(), amount: usd("42.50") });
    expect(posting.entries.map((e) => [e.accountCode, e.direction, m(e.amount)])).toEqual([
      [ACCOUNTS.TIPS_PAYABLE, "debit", "42.5000"],
      [ACCOUNTS.CASH, "credit", "42.5000"],
    ]);
    expect(() => postTipPayout({ payrollRunId: "pp", occurredAt: new Date(), amount: usd("-1") })).toThrow();
  });
});

describe("tips on a pay statement", () => {
  const TZ = "America/Chicago";
  const at = (date: string, hhmm: string) => {
    const [h = "0", min = "0"] = hhmm.split(":");
    return instantOfLocal(date, Number(h) * 60 + Number(min), TZ);
  };
  const policy: labor.OvertimePolicy = {
    label: "Declared policy", timeZone: TZ, weekStartsOn: 0, dayAttribution: "shift_start",
    weeklyThresholdMinutes: 40 * 60, weeklyDoubleTimeThresholdMinutes: null,
    dailyThresholdMinutes: null, dailyDoubleTimeThresholdMinutes: null,
    overtimeMultiplier: "1.5", doubleTimeMultiplier: "2",
    onCallTreatment: "separate_rate_not_hours_worked", note: "Test policy.",
  };
  const period = { id: "pp", label: "Week", startDate: "2026-06-14", weeks: 1 };

  it("are their own lines, inside the period only, and add to the gross", () => {
    const result = labor.buildStatement({
      personId: "tech-1", period, policy,
      basis: { kind: "hourly", baseRate: usd("30") },
      entries: [{ id: "e1", personId: "tech-1", kind: "on_site", startedAt: at("2026-06-15", "08:00"), endedAt: at("2026-06-15", "12:00") }],
      tips: [
        { tipId: "t1", personId: "tech-1", amount: usd("7.50"), label: "Tip, invoice 1042", occurredAt: at("2026-06-16", "10:00") },
        { tipId: "t2", personId: "tech-2", amount: usd("7.50"), label: "Tip, invoice 1042", occurredAt: at("2026-06-16", "10:00") },
        { tipId: "t3", personId: "tech-1", amount: usd("9.00"), label: "Tip, invoice 1001", occurredAt: at("2026-06-01", "10:00") },
      ],
      now: at("2026-12-31", "12:00"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tips = result.statement.lines.filter((l) => l.kind === "tip");
    expect(tips.map((l) => [l.label, m(l.amount)])).toEqual([["Tip, invoice 1042", "7.5000"]]);
    expect(m(result.statement.gross)).toBe("127.5000");
    expect(m(sum(result.statement.lines.map((l) => l.amount), "USD"))).toBe(m(result.statement.gross));
  });

  it("are never what a commission reversal is taken out of", () => {
    const result = labor.buildStatement({
      personId: "tech-1", period, policy,
      basis: { kind: "hourly", baseRate: usd("30") },
      entries: [],
      clawbacks: [{
        creditId: "cn1",
        line: { personId: "tech-1", amount: usd("-50"), explanation: "Invoice credited." },
        occurredAt: at("2026-06-16", "09:00"),
        earnedAt: at("2026-06-01", "09:00"),
      }],
      tips: [{ tipId: "t1", personId: "tech-1", amount: usd("20"), label: "Tip, invoice 1042", occurredAt: at("2026-06-16", "10:00") }],
      now: at("2026-12-31", "12:00"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole reversal is carried, and the tip is paid whole.
    expect(m(result.statement.carriedForward)).toBe("-50.0000");
    expect(m(result.statement.gross)).toBe("20.0000");
  });
});

describe("a job photograph on the portal", () => {
  it("is shown only when somebody chose it, or the company shows them all", () => {
    expect(photoShown("chosen", { kind: "photo", sharedAt: null })).toBe(false);
    expect(photoShown("chosen", { kind: "photo", sharedAt: new Date() })).toBe(true);
    expect(photoShown("all", { kind: "photo", sharedAt: null })).toBe(true);
  });

  it("is never a signature, whatever the setting", () => {
    expect(photoShown("all", { kind: "signature", sharedAt: new Date() })).toBe(false);
  });

  it("is chosen one by one unless the company said otherwise", () => {
    expect(readPortalSettings(undefined).jobPhotos).toBe("chosen");
    expect(readPortalSettings({ jobPhotos: "everything" }).jobPhotos).toBe("chosen");
    expect(readPortalSettings({ jobPhotos: "all" }).jobPhotos).toBe("all");
  });
});
