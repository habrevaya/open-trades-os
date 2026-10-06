import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Costing, type CostingData } from "../src/app/(app)/jobs/[id]/Costing";

/**
 * M15 ON THE JOB PAGE
 *
 * Cost against revenue for one job, rendered from the statement's shape.
 */
const data = (over: Partial<CostingData> = {}): CostingData => ({
  revenue: "1200.0000", materialCost: "300.0000", labourCost: "450.0000", processingFees: "35.0000",
  grossMargin: "415.0000", grossMarginPercent: 34.58,
  scheduledHours: "4", actualHours: "6", hoursOverPlan: "2",
  settled: true, provisional: [],
  caveats: { overhead: "No overhead is allocated.", overtime: "Overtime premium excluded.", cost: "", fees: "" },
  lines: [
    { id: "l1", name: "Capacitor", quantity: "2", unitCost: "20.0000", extendedCost: "40.0000", billed: true, nonBillableReason: null },
    { id: "l2", name: "Warranty part", quantity: "1", unitCost: null, extendedCost: null, billed: false, nonBillableReason: "warranty" },
  ],
  labour: [{ technicianId: "t1", technicianName: "Sam Ortiz", hours: "6", cost: "450.0000", unpricedHours: "0" }],
  journalLines: [],
  ...over,
});

describe("the job's cost and margin", () => {
  it("shows revenue, both costs, fees and the margin with its percentage", () => {
    const html = renderToStaticMarkup(<Costing data={data()} />);
    for (const text of ["Revenue", "Materials", "Labour", "Card fees", "Gross margin", "34.6%", "Final"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("2 over");
    expect(html).toContain("No cost recorded");
    expect(html).toContain("not billed: warranty");
    expect(html).toContain("Sam Ortiz, 6 h");
    expect(html).toContain('href="/reports/built-in/job-costing"');
  });

  it("says why a margin is not final before showing it", () => {
    const html = renderToStaticMarkup(<Costing data={data({
      settled: false, provisional: ["A punch is still running."],
    })} />);
    expect(html).toContain("Still moving");
    expect(html).toContain("A punch is still running.");
    expect(html.indexOf("A punch is still running.")).toBeLessThan(html.indexOf("Revenue"));
  });

  it("marks a loss", () => {
    const html = renderToStaticMarkup(<Costing data={data({ grossMargin: "-80.0000", grossMarginPercent: -6.7 })} />);
    expect(html).toMatch(/text-red-600[^>]*>.*-?\$?80/);
  });

  it("says nothing about journals when none names the job", () => {
    expect(renderToStaticMarkup(<Costing data={data()} />)).not.toContain("by journal");
  });

  it("lists the journal lines on the job and says which are counted and which are not", () => {
    const html = renderToStaticMarkup(<Costing data={data({
      journalLines: [
        { transactionId: "t1", journalNumber: 14, accountCode: "5000", direction: "debit", amount: "300.0000", memo: "Duct work", countedIn: "material" },
        { transactionId: "t2", journalNumber: 15, accountCode: "5200", direction: "debit", amount: "800.0000", memo: "Payroll", countedIn: null },
      ],
    })} />);
    expect(html).toContain("Booked to this job by journal");
    expect(html).toContain("Journal 14");
    expect(html).toContain("counted in materials");
    expect(html).toContain("Journal 15");
    expect(html).toContain("not counted here");
    expect(html).toContain("Labour is counted from the hours on the clock");
  });
});
