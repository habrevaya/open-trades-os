import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompleteVisit, JobLifecycle, UsedOnJob } from "../src/app/(app)/jobs/[id]/Work";

const action = async () => null;

/** FINISHING WORK FROM THE OFFICE, ON THE JOB'S PAGE */
describe("the job's work", () => {
  it("completes a visit with what was done and what was used, picked from the price book", () => {
    const html = renderToStaticMarkup(
      <CompleteVisit action={action} jobId="j1" visit={{ id: "v1", sequence: 2 }}
                     items={[{ id: "i1", name: "Dual run capacitor", price: "43.3700" }]} />,
    );
    expect(html).toContain("Complete visit 2");
    expect(html).toContain("What was done on visit 2");
    expect(html).toContain("Dual run capacitor ($43.37)");
    expect(html).toContain('name="visitId" value="v1"');
    expect(html).toContain('name="partQuantity2"');
  });

  it("offers to reopen a finished job, to finish one with nothing open, and nothing otherwise", () => {
    expect(renderToStaticMarkup(<JobLifecycle action={action} jobId="j" status="completed" openVisits={0} />))
      .toContain("Reopen job");
    expect(renderToStaticMarkup(<JobLifecycle action={action} jobId="j" status="scheduled" openVisits={0} />))
      .toContain("Mark job complete");
    expect(renderToStaticMarkup(<JobLifecycle action={action} jobId="j" status="scheduled" openVisits={1} />)).toBe("");
    expect(renderToStaticMarkup(<JobLifecycle action={action} jobId="j" status="paid" openVisits={0} />)).toBe("");
  });

  it("lists what was used with whether it is billed yet", () => {
    const html = renderToStaticMarkup(<UsedOnJob lines={[
      { id: "a", name: "Capacitor", quantity: "3.0000", unitPrice: "43.3700", invoiceLineId: null, nonBillableReason: null },
      { id: "b", name: "Contactor", quantity: "1.0000", unitPrice: "60.0000", invoiceLineId: "il", nonBillableReason: null },
      { id: "c", name: "Refrigerant", quantity: "2.0000", unitPrice: "0.0000", invoiceLineId: null, nonBillableReason: "warranty" },
    ]} />);
    expect(html).toContain("Not yet");
    expect(html).toContain("On an invoice");
    expect(html).toContain("Not billed: warranty");
    expect(renderToStaticMarkup(<UsedOnJob lines={[]} />)).toBe("");
  });
});
