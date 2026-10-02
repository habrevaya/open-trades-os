import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectView, type ProjectViewData, type BudgetData } from "../src/app/(app)/projects/ProjectView";
import { NAV } from "../src/lib/nav";

/** M12 ON A SCREEN: PHASES, THE BILLING SCHEDULE, AND BUDGET AGAINST ACTUAL */
const project: ProjectViewData = {
  name: "Kitchen remodel", status: "active", description: "Gut and rebuild",
  startsOn: "2026-10-05", targetCompletionOn: "2026-12-18",
  contractValue: "48000.0000", unscheduledValue: "18000.0000",
  phaseList: [
    { id: "p1", sequence: 1, name: "Demolition", status: "complete", dependsOnPhaseId: null,
      billingValue: "6000.0000", startsOn: null, endsOn: null, jobIds: ["j1"] },
    { id: "p2", sequence: 2, name: "Rough-in", status: "in_progress", dependsOnPhaseId: "p1",
      billingValue: "20000.0000", startsOn: null, endsOn: null, jobIds: [] },
  ],
  draws: [
    { id: "d1", sequence: 1, label: "Deposit", projectPhaseId: null, percent: null, amount: "10000.0000", invoiceId: "inv1", raisedAt: "2026-10-01T00:00:00Z" },
    { id: "d2", sequence: 2, label: "Rough-in", projectPhaseId: "p2", percent: "0.5", amount: "10000.0000", invoiceId: null, raisedAt: null },
  ],
};
const budget: BudgetData = {
  contractValue: "48000.0000", budgetCost: "30000.0000", revenue: "10000.0000",
  materialCost: "21000.0000", labourCost: "11000.0000", grossMargin: "-22000.0000",
  costVariance: "-2000.0000", billedToDate: "10000.0000", leftToBill: "10000.0000",
  scheduledHours: "120", actualHours: "150", provisional: ["A phase is still running."],
};

describe("a project", () => {
  it("lists phases in order with what each waits for, and the draws with their invoices", () => {
    const html = renderToStaticMarkup(<ProjectView project={project} budget={null}
      drawControls={(d) => <button>raise {d.label}</button>} />);
    expect(html.indexOf("Demolition")).toBeLessThan(html.indexOf("Rough-in"));
    expect(html).toContain("Waits for Demolition");
    expect(html).toContain("No job yet.");
    expect(html).toContain('href="/jobs/j1"');
    expect(html).toContain('href="/invoices/inv1"');
    expect(html).toContain("raise Rough-in");
    expect(html).toContain("50%");
    expect(html).not.toContain("Budget against actual");
  });

  it("shows an overrun as one, for whoever may see cost", () => {
    const html = renderToStaticMarkup(<ProjectView project={project} budget={budget} />);
    expect(html).toContain("Budget against actual");
    expect(html).toContain("Over budget by");
    expect(html).toContain("32,000.00");
    expect(html).toContain("A phase is still running.");
  });

  it("is in the navigation under Work", () => {
    const group = NAV.find((g) => g.items.some((i) => i.href === "/projects"));
    expect(group?.label).toBe("Work");
  });
});
