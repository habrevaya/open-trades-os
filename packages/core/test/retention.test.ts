import { describe, it, expect } from "vitest";
import { retention } from "../src/index";

/**
 * When a record's time is up. The bias under test throughout: when the clock
 * cannot be worked out, the record is kept.
 */
const d = (iso: string) => new Date(iso);

describe("when the clock starts", () => {
  it("runs from the end of the year in the latest time zone there is", () => {
    const start = retention.clockStartsAt("calendar_year_end", {
      createdAt: d("2026-03-01T00:00:00Z"), recordDate: d("2025-12-31T23:00:00-10:00"),
    });
    // 31 December in Honolulu is already 1 January in UTC, and still belongs to 2025.
    expect(start).toEqual(d("2026-01-01T12:00:00Z"));
  });

  it("has not started when the event it waits for has not happened", () => {
    expect(retention.clockStartsAt("work_completed", { createdAt: d("2020-01-01T00:00:00Z"), workCompletedAt: null })).toBeNull();
    expect(retention.clockStartsAt("equipment_removed", { createdAt: d("2020-01-01T00:00:00Z") })).toBeNull();
  });
});

describe("adding months", () => {
  it("clamps to the end of a shorter month rather than rolling over", () => {
    expect(retention.purgeableFrom(d("2026-01-31T10:00:00Z"), 1)).toEqual(d("2026-02-28T10:00:00Z"));
    expect(retention.purgeableFrom(d("2024-02-29T00:00:00Z"), 12)).toEqual(d("2025-02-28T00:00:00Z"));
    expect(retention.purgeableFrom(d("2026-01-31T00:00:00Z"), 36)).toEqual(d("2029-01-31T00:00:00Z"));
  });
});

describe("judging one record", () => {
  const policy = { clockStart: "record_created" as const, retainMonths: 12 };
  const facts = { createdAt: d("2024-06-01T00:00:00Z") };

  it("is due once the months have passed", () => {
    expect(retention.judge(policy, facts, d("2025-06-02T00:00:00Z"), false).state).toBe("due");
  });

  it("is not yet before then, and says until when", () => {
    const verdict = retention.judge(policy, facts, d("2025-05-01T00:00:00Z"), false);
    expect(verdict).toMatchObject({ state: "not_yet", why: "Kept until 2025-06-01." });
  });

  it("is held when somebody put a hold on it", () => {
    expect(retention.judge(policy, facts, d("2026-01-01T00:00:00Z"), true).state).toBe("held");
  });

  it("is kept when its clock cannot start", () => {
    const verdict = retention.judge({ clockStart: "contract_ended", retainMonths: 1 }, facts, d("2030-01-01T00:00:00Z"), false);
    expect(verdict.state).toBe("no_clock");
    expect(verdict.why).toMatch(/^Kept/);
  });

  it("reads a rule back as a sentence", () => {
    expect(retention.describePolicy({ clockStart: "report_prepared", retainMonths: 60 }))
      .toBe("Kept 5 years from when the report was finished.");
    expect(retention.describePolicy({ clockStart: "record_created", retainMonths: 18 }))
      .toBe("Kept 18 months from when the record was made.");
  });
});
