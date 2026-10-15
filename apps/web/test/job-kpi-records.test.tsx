import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsedOnJob } from "../src/app/(app)/jobs/[id]/Work";
import { JobHoldPanel, PlannedVisits } from "../src/app/(app)/jobs/[id]/Hold";
import { CrewBudget } from "../src/app/(app)/jobs/[id]/Budget";

const action = async () => null;

/**
 * WHAT A JOB SAYS FOR THE SCORECARD: why it waited, whether it was always
 * going to take two visits, the crew hours it was budgeted, and which supplies
 * were billed back at cost.
 */
describe("the job's records the scorecard reads", () => {
  it("offers a hold with its reasons, and shows the open one with its order", () => {
    const form = renderToStaticMarkup(
      <JobHoldPanel jobId="j" status="scheduled" holds={[]} mayNameOrder timezone="America/Chicago"
                    orders={[{ id: "po", number: 12, vendorName: "Supply House", status: "submitted" }]}
                    place={action} release={action} />,
    );
    expect(form).toContain("Waiting on a part");
    expect(form).toContain("Order 12, Supply House (sent)");
    const held = renderToStaticMarkup(
      <JobHoldPanel jobId="j" status="on_hold" mayNameOrder timezone="America/Chicago" orders={[]}
                    holds={[{
                      id: "h", reason: "part", reasonLabel: "Waiting on a part", purchaseOrderId: "po",
                      purchaseOrderNumber: 12, purchaseOrderStatus: "submitted", note: "Gas valve",
                      placedAt: "2026-06-10T15:00:00Z", placedByName: "Dana", releasedAt: null,
                    }]}
                    place={action} release={action} />,
    );
    expect(held).toContain("On hold:");
    expect(held).toContain("purchase order 12");
    expect(held).toContain("Take off hold");
    /** A finished job cannot go on hold, so nothing is offered. */
    expect(renderToStaticMarkup(
      <JobHoldPanel jobId="j" status="completed" holds={[]} mayNameOrder timezone="UTC" orders={[]} place={action} release={action} />,
    )).toBe("");
  });

  it("asks about a plan for several visits only before anybody has gone out", () => {
    expect(renderToStaticMarkup(<PlannedVisits jobId="j" plannedAt={null} started={false} writes timezone="UTC" action={action} />))
      .toContain("Planned for more than one visit");
    expect(renderToStaticMarkup(<PlannedVisits jobId="j" plannedAt={null} started writes timezone="UTC" action={action} />))
      .toBe("");
  });

  it("shows the crew hours against the budget, and fixes the budget once hours are punched", () => {
    const open = renderToStaticMarkup(<CrewBudget jobId="j" writes action={action} budget={{
      budgetedHours: "32.0000", crewHours: "18.50", approvedChangeHours: "6.00", punchStillRunning: false, locked: false,
    }} />);
    expect(open).toContain("Budgeted 32 crew hours. Punched so far: 18.50 crew hours.");
    expect(open).toContain("Change orders the customer approved add 6 crew hours.");
    expect(open).toContain("Save the budget");
    const fixed = renderToStaticMarkup(<CrewBudget jobId="j" writes action={action} budget={{
      budgetedHours: "32.0000", crewHours: "1.00", approvedChangeHours: "0.00", punchStillRunning: true, locked: true,
    }} />);
    expect(fixed).not.toContain("Save the budget");
    expect(fixed).toContain("put the hours on a change order");
  });

  it("says which supplies are billed back at cost, and offers the switch to somebody who may change the job", () => {
    const lines = [
      { id: "a", kind: "part", billedBackAt: "2026-06-10T15:00:00Z", name: "Paper", quantity: "1.0000", unitPrice: "150.0000", invoiceLineId: "il", nonBillableReason: null },
      { id: "b", kind: "labor", billedBackAt: null, name: "Labour", quantity: "1.0000", unitPrice: "60.0000", invoiceLineId: null, nonBillableReason: null },
    ];
    const html = renderToStaticMarkup(<UsedOnJob lines={lines} jobId="j" markBilledBack={action} />);
    expect(html).toContain("Billed back at cost");
    expect(html).toContain("Yes, a pass through");
    expect(html).toContain("Not billed back");
    expect(renderToStaticMarkup(<UsedOnJob lines={lines} />)).not.toContain("Not billed back");
  });
});
