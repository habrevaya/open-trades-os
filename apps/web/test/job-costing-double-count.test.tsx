import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Costing, type CostingData } from "../src/app/(app)/jobs/[id]/Costing";

/** M15: a cost that may be counted twice, said above the figures on the job page. */
const data = (over: Partial<CostingData> = {}): CostingData => ({
  revenue: "1200.0000", materialCost: "960.0000", labourCost: "0.0000", processingFees: "0.0000",
  grossMargin: "240.0000", grossMarginPercent: 20,
  scheduledHours: "0", actualHours: "0", hoursOverPlan: "0",
  settled: true, provisional: [],
  caveats: { overhead: "", overtime: "", cost: "", fees: "" },
  lines: [], labour: [], journalLines: [],
  ...over,
});

const pair = (notTheSame: NonNullable<CostingData["doubleCounts"]>[number]["notTheSame"] = null) => ({
  ledgerEntryId: "le1", journalNumber: 7, journalOn: "2026-10-01", journalMemo: "Duct bill",
  jobLineId: "jl1", lineName: "Duct crew", lineOn: "2026-09-28", amount: "480.0000",
  reason: "Same amount, 3 days apart.", notTheSame,
});
const actions = { mark: async () => null, unmark: async () => null };

describe("a cost that may be counted twice", () => {
  it("says nothing when no pair is flagged", () => {
    expect(renderToStaticMarkup(<Costing data={data({ doubleCounts: [] })} jobId="j1" />)).not.toContain("counted twice");
  });

  it("names the journal, the line, the amount and why, and offers the mark to whoever posts journals", () => {
    const html = renderToStaticMarkup(<Costing data={data({ doubleCounts: [pair()] })} jobId="j1" notTheSame={actions} />);
    for (const text of ["This cost may be counted twice.", "Journal 7", "Duct crew", "Same amount, 3 days apart.", "Not the same cost"]) {
      expect(html).toContain(text);
    }
    expect(html.indexOf("counted twice")).toBeLessThan(html.indexOf("Revenue"));
  });

  it("tells somebody who cannot mark it who can", () => {
    const html = renderToStaticMarkup(<Costing data={data({ doubleCounts: [pair()] })} jobId="j1" />);
    expect(html).toContain("Whoever posts journals can mark these as different costs.");
    expect(html).not.toContain("Why (optional)");
  });

  it("shows a checked pair as checked, by whom, with a way to take it back", () => {
    const html = renderToStaticMarkup(<Costing data={data({
      doubleCounts: [pair({ id: "m1", note: "Two bills", markedAt: "2026-10-02T12:00:00Z", markedBy: "Ana Ruiz" })],
    })} jobId="j1" notTheSame={actions} />);
    expect(html).toContain("Checked: these look alike but are different costs.");
    expect(html).toContain("Marked by Ana Ruiz.");
    expect(html).toContain("Two bills");
    expect(html).toContain("Take back");
  });
});
