import { describe, it, expect } from "vitest";
import { counted, reasons, undoableUntil, withinWindow, UNDO_WINDOW_DAYS } from "../src/customer-merge/index.js";

const merged = new Date("2026-10-01T15:00:00Z");
const names = { kept: "Dana Reyes", duplicate: "Dana Reyes (2)" };

describe("how long a merge can be taken back", () => {
  it("for the window and not a moment after", () => {
    expect(undoableUntil(merged)).toEqual(new Date(merged.getTime() + UNDO_WINDOW_DAYS * 86_400_000));
    expect(withinWindow(merged, new Date(merged.getTime() + UNDO_WINDOW_DAYS * 86_400_000))).toBe(true);
    expect(withinWindow(merged, new Date(merged.getTime() + UNDO_WINDOW_DAYS * 86_400_000 + 1))).toBe(false);
  });
});

describe("what is in the way, in words", () => {
  it("counts in plain words, singular where it is one", () => {
    expect(counted([{ label: "invoices", n: 1 }])).toBe("1 invoice");
    expect(counted([{ label: "invoices", n: 1 }, { label: "payments", n: 2 }, { label: "ledger entries", n: 1 }]))
      .toBe("1 invoice, 2 payments and 1 ledger entry");
    expect(counted([{ label: "jobs", n: 0 }])).toBe("");
  });

  it("says one of a label whose plural is not at its end", () => {
    expect(counted([{ label: "statements sent", n: 1 }])).toBe("1 statement sent");
    expect(counted([{ label: "coverage claims they pay", n: 1 }, { label: "files they uploaded", n: 1 }]))
      .toBe("1 coverage claim they pay and 1 file they uploaded");
    expect(counted([{ label: "mail pieces", n: 1 }, { label: "portal sign ins", n: 1 }]))
      .toBe("1 mail piece and 1 portal sign in");
  });

  it("says nothing when nothing is in the way", () => {
    expect(reasons({ moneySince: [], movedAway: [{ label: "jobs", n: 0 }] }, names)).toEqual([]);
  });

  it("names money written since, and every other reason at once", () => {
    const said = reasons({
      moneySince: [{ label: "payments", n: 1 }],
      movedAway: [{ label: "jobs", n: 2 }],
      tooOld: "Sep 1, 2026",
    }, names);
    expect(said).toHaveLength(3);
    expect(said[0]).toMatch(/30 days/);
    expect(said[1]).toBe("Since the merge, 1 payment was written to Dana Reyes. Money cannot be split back between them by a guess, so the merge stands.");
    expect(said[2]).toBe("2 jobs the merge moved are no longer on Dana Reyes, so they cannot be moved back.");
  });
});
