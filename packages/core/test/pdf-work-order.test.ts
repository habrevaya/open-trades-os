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

/**
 * WHAT WAS TAKEN ON THE PHONE
 *
 * The photographs under the visit they were taken at and the signature already drawn, at a
 * printable size. The pictures are handed in already chosen for this copy and this reader.
 */
describe("the work order with what the phone took", () => {
  /** A picture the page can draw: only its size and how it is filtered matter to the layout. */
  const picture = (width: number, height: number): pdf.PdfImage =>
    ({ width, height, colorSpace: "DeviceRGB", filter: "DCTDecode", extra: "", data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) });
  const withPictures = (over: Partial<pdf.WorkOrderPdfInput["visits"][number]> = {}, rest: Partial<pdf.WorkOrderPdfInput> = {}) => {
    const base = order();
    return order({
      visits: [{
        ...base.visits[0]!,
        photos: [
          { image: picture(4000, 3000), caption: "Before, Oct 6, 9:14 AM CDT" },
          { image: picture(3000, 4000), caption: "After, Oct 6, 10:40 AM CDT" },
        ],
        signature: { image: picture(600, 200), caption: "Dana Ruiz signed Oct 6, 10:52 AM CDT" },
        ...over,
      }],
      ...rest,
    });
  };

  it("draws each photograph and the signature under its visit, with its words", () => {
    const read = pdf.inspectPdf(pdf.workOrderPdf(withPictures()));
    expect(read.problems).toEqual([]);
    expect(read.images).toHaveLength(3);
    for (const said of [
      "Signed on the phone", "Dana Ruiz signed Oct 6, 10:52 AM CDT",
      "Photographs from visit 1", "Before, Oct 6, 9:14 AM CDT", "After, Oct 6, 10:40 AM CDT",
      // The paper lines are still there for anything not signed on the phone.
      "Customer sign off", "Name in capitals",
    ]) expect(read.text).toContain(said);
    expect(read.text.indexOf("Photographs from visit 1")).toBeLessThan(read.text.indexOf("Customer sign off"));
    expect(read.text.indexOf("Visit 1:")).toBeLessThan(read.text.indexOf("Photographs from visit 1"));
  });

  it("prints them at a size a person can use on paper, and no taller than the limit", () => {
    // A tall photograph on a letter page is scaled to the limit, not the page.
    const tall = picture(3000, 4000);
    const size = pdf.fitWithin(tall, 500, pdf.WORK_ORDER_PHOTO_HEIGHT);
    expect(size.height).toBeLessThanOrEqual(pdf.WORK_ORDER_PHOTO_HEIGHT);
    expect(size.height).toBeGreaterThan(150);
    const read = pdf.inspectPdf(pdf.workOrderPdf(withPictures({ signature: null })));
    expect(read.images).toHaveLength(2);
  });

  it("says in a line when a picture is a kind the file cannot print, and keeps going", () => {
    const read = pdf.inspectPdf(pdf.workOrderPdf(withPictures({
      photos: [{ image: null, caption: "Before, Oct 6, 9:14 AM CDT" }, { image: picture(400, 300), caption: "After" }],
      signature: null,
    })));
    expect(read.problems).toEqual([]);
    expect(read.images).toHaveLength(1);
    expect(read.text).toContain("Before, Oct 6, 9:14 AM CDT: this picture is on the job's page and is not a kind this file can print.");
  });

  it("starts a new page for a picture that does not fit rather than cutting it", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ image: picture(4000, 3000), caption: `Photo ${i + 1}` }));
    const read = pdf.inspectPdf(pdf.workOrderPdf(withPictures({ photos: many, signature: null })));
    expect(read.problems).toEqual([]);
    expect(read.images).toHaveLength(6);
    expect(read.pages.length).toBeGreaterThan(2);
  });

  it("prints the job's own photographs and the note about what was left off", () => {
    const read = pdf.inspectPdf(pdf.workOrderPdf(withPictures({ photos: [], signature: null }, {
      jobPhotos: [{ image: picture(800, 600), caption: "Outside unit" }],
      photoNote: "Only photographs the customer may see are printed on the office copy.",
    })));
    expect(read.images).toHaveLength(1);
    expect(read.text).toContain("Photographs on the job");
    expect(read.text).toContain("Outside unit");
    expect(read.text).toContain("Only photographs the customer may see are printed on the office copy.");
  });

  it("keeps the technician's copy free of money with pictures on it", () => {
    const base = withPictures();
    const read = pdf.inspectPdf(pdf.workOrderPdf({
      ...base, prices: false, copy: "Printed for the technician",
      parts: base.parts.map((p) => ({ ...p, unitPrice: null, lineTotal: null })),
    }));
    expect(read.images).toHaveLength(3);
    expect(read.text).not.toContain("$");
  });

  it("prints exactly what it did before when nothing was taken", () => {
    const read = pdf.inspectPdf(pdf.workOrderPdf(order()));
    expect(read.images).toEqual([]);
    expect(read.text).not.toContain("Signed on the phone");
    expect(read.text).not.toContain("Photographs");
  });
});
