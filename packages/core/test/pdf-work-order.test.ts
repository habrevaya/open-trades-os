import { describe, it, expect } from "vitest";
import { pdf } from "../src/index";

/**
 * A JOB AS A WORK ORDER (M10, M01)
 *
 * Read back through `inspectPdf`, so "the technician's copy has no prices"
 * means no price was drawn anywhere on the page, not that a column was hidden.
 */
const AT = new Date("2026-10-06T14:00:00Z");

const order = (over: Partial<pdf.WorkOrderPdfInput> = {}): pdf.WorkOrderPdfInput => ({
  company: { name: "Lone Star Air", color: "#1F6FEB", contact: ["12 Elm St, Austin, TX 78701"] },
  number: 1042, numberPrefix: "RR", status: "scheduled",
  branch: { name: "Round Rock", code: "RR" }, jobType: "Repair",
  summary: "No cooling upstairs", description: "Check the condenser and the capacitor.",
  customerComplaint: "It blows warm air after noon.",
  customerName: "Dana Ruiz", customerPhone: "(512) 555-0100",
  propertyAddress: "4 Pecan Hollow, Round Rock, TX 78664",
  accessNotes: "Side gate, dog in the yard.", hazardNotes: null,
  visits: [{
    when: "Tue, Oct 6, 9:00 AM to 11:00 AM CDT", status: "dispatched", technicians: ["Ray Ortiz", "Sam Lee"],
    arrived: null, completed: null,
    checklist: [
      { label: "Check refrigerant pressure", required: true, done: true },
      { label: "Replace filter", required: false, done: false },
    ],
  }],
  parts: [
    { name: "Capacitor 45/5", description: "Dual run", kind: "part", quantity: "1.0000", unitPrice: "89.0000", lineTotal: "89.0000", noCharge: null },
    { name: "Diagnosis", description: null, kind: "labor", quantity: "1.5000", unitPrice: "0.0000", lineTotal: "0.0000", noCharge: "Warranty" },
  ],
  prices: true, currency: "USD", copy: "Office copy", generatedAt: AT,
  ...over,
});

describe("the work order", () => {
  it("prints the job with its branch code, the customer, the visits with who, the work, the parts and a signature line", () => {
    const read = pdf.inspectPdf(pdf.workOrderPdf(order()));
    expect(read.problems).toEqual([]);
    expect(read.title).toBe("Lone Star Air work order RR-1042");
    for (const said of [
      "Work order RR-1042", "Round Rock (RR)", "Dana Ruiz", "(512) 555-0100", "4 Pecan Hollow, Round Rock, TX 78664",
      "Side gate, dog in the yard.", "Visit 1: Tue, Oct 6, 9:00 AM to 11:00 AM CDT", "Ray Ortiz, Sam Lee", "Sent out",
      "The customer says: It blows warm air after noon.", "Check the condenser and the capacitor.",
      "Check refrigerant pressure (must be done)", "Replace filter", "Done",
      "Capacitor 45/5", "Labour", "No charge: Warranty", "$89.00",
      "Customer sign off", "Signature", "Date", "Name in capitals",
    ]) expect(read.text).toContain(said);
  });

  it("prints no money on the technician's copy", () => {
    const read = pdf.inspectPdf(pdf.workOrderPdf(order({
      prices: false, copy: "Printed for the technician",
      parts: order().parts.map((p) => ({ ...p, unitPrice: null, lineTotal: null })),
    })));
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("Printed for the technician");
    expect(read.text).toContain("Capacitor 45/5");
    expect(read.text).not.toContain("$");
    expect(read.text).not.toContain("Price");
    expect(read.text).not.toContain("Amount");
  });

  it("leaves room to write what was used, and says when nobody is booked", () => {
    const read = pdf.inspectPdf(pdf.workOrderPdf(order({ parts: [], visits: [], branch: null, numberPrefix: null })));
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("Work order 1042");
    expect(read.text).toContain("No visit is booked yet.");
    expect(read.text).toContain("Write down what you use");
    expect(read.text).not.toContain("Branch");
  });
});
