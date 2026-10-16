import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

const arrived = new Date("2026-06-10T14:00:00Z");
const finished = new Date("2026-06-10T15:30:00Z");
const call = (over: Partial<r.TroubleshootingCall> = {}): r.TroubleshootingCall => ({
  visit: { arrivedAt: arrived, completedAt: finished }, approvedAt: [], repairOnVisit: false, faultLocation: null, ...over,
});
const at = (minutes: number) => new Date(arrived.getTime() + minutes * 60_000);

describe("a troubleshooting call", () => {
  it("converts when the customer signs for the repair on the visit that found the fault", () => {
    expect(r.troubleshootingOf(call({ approvedAt: [at(45)] }))).toBe("converted");
    expect(r.troubleshootingOf(call({ approvedAt: [at(0)] }))).toBe("converted");
    expect(r.troubleshootingOf(call({ approvedAt: [finished] }))).toBe("converted");
  });

  it("does not convert on an approval before the visit or after it", () => {
    expect(r.troubleshootingOf(call({ approvedAt: [at(-10)] }))).toBe("not_converted");
    expect(r.troubleshootingOf(call({ approvedAt: [at(91)] }))).toBe("not_converted");
    expect(r.troubleshootingOf(call())).toBe("not_converted");
  });

  it("converts on repair work recorded on the visit itself", () => {
    expect(r.troubleshootingOf(call({ repairOnVisit: true }))).toBe("converted");
  });

  it("cannot place an approval in a visit nobody timed, so only work on it converts it", () => {
    const untimed = { arrivedAt: null, completedAt: finished };
    expect(r.troubleshootingOf(call({ visit: untimed, approvedAt: [at(45)] }))).toBe("not_converted");
    expect(r.troubleshootingOf(call({ visit: untimed, repairOnVisit: true }))).toBe("converted");
  });

  it("is left out when the fault was in equipment another trade owns, whatever else happened", () => {
    expect(r.troubleshootingOf(call({ faultLocation: r.FAULT_ELSEWHERE, approvedAt: [at(45)] }))).toBe("excluded");
    expect(r.troubleshootingOf(call({ faultLocation: "In our electrical work" }))).toBe("not_converted");
    expect(r.troubleshootingOf(call({ faultLocation: "No fault found" }))).toBe("not_converted");
  });
});
