import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

const pass = (jobId: string, inspectedOn: string): r.PermitVisit => ({ jobId, inspectedOn, result: "passed", failureScope: null });
const fail = (jobId: string, inspectedOn: string, scope: "our_work" | "outside_our_work"): r.PermitVisit =>
  ({ jobId, inspectedOn, result: "failed", failureScope: scope });

describe("where a permitted job lands in the first time pass rate", () => {
  it("passes a job whose every inspection passed", () => {
    expect(r.permitVerdict([pass("a", "2026-06-02"), pass("a", "2026-06-20")])).toBe("passed");
  });

  it("fails a job the inspector failed for our work at any stage, not only the first", () => {
    /** A rough in that passed and a final that failed for our work was not signed off first time. */
    expect(r.permitVerdict([pass("a", "2026-06-02"), fail("a", "2026-06-20", "our_work")])).toBe("failed");
  });

  it("leaves out a job failed only for somebody else's work", () => {
    expect(r.permitVerdict([fail("a", "2026-06-02", "outside_our_work"), pass("a", "2026-06-05")])).toBe("excluded");
  });

  it("counts a job failed for both as failed, because the crew's miss is in it", () => {
    expect(r.permitVerdict([fail("a", "2026-06-02", "outside_our_work"), fail("a", "2026-06-09", "our_work")])).toBe("failed");
  });

  it("says nothing about a job with no inspection", () => {
    expect(r.permitVerdict([])).toBeNull();
  });
});

describe("which jobs a window counts", () => {
  it("dates each job by its first inspection and judges it on every inspection recorded since", () => {
    const window = { from: "2026-06-01", to: "2026-06-30" };
    const counted = r.inspectionPass([
      pass("first-time", "2026-06-03"),
      fail("ours", "2026-06-04", "our_work"), pass("ours", "2026-06-11"),
      fail("theirs", "2026-06-05", "outside_our_work"), pass("theirs", "2026-06-12"),
      /** First inspected in June, failed in July: June's figure carries the failure. */
      pass("later", "2026-06-28"), fail("later", "2026-07-03", "our_work"),
      /** First inspected in May: May's job, whatever happened in June. */
      fail("may", "2026-05-30", "our_work"), pass("may", "2026-06-02"),
    ], window);
    expect(counted).toEqual({ passed: ["first-time"], failed: ["later", "ours"], excluded: ["theirs"] });
  });
});
