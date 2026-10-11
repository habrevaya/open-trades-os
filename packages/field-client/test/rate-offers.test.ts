import { describe, it, expect } from "vitest";
import {
  addRate, carries, draftTotals, invoiceFromWork, invoicePayload, newBuilder, offersInBook, projectDay, rateAsBillable,
  type PriceBookEntry, type QueuedOperation, type RateOffer, type MemberTerms,
} from "../src/index";

/**
 * THE AFTER HOURS RATE, ON THE PHONE
 *
 * Offered with the day, with why, and put on an estimate or an invoice only
 * when the technician presses the button. Priced from the book the phone
 * carries, so the customer sees the figure the server will write.
 */
const NIGHT: PriceBookEntry = {
  id: "item-night", versionId: "ver-night", code: "AH", name: "After hours call out", unitPrice: "150.0000", taxable: false,
  kind: "fee", feeRole: "after_hours", description: null, components: [],
};
const OTHER: PriceBookEntry = {
  id: "item-cap", versionId: "ver-cap", code: "CAP", name: "Run capacitor", unitPrice: "40.0000", taxable: false,
  kind: "material", feeRole: null, description: null, components: [],
};
const OFFER: RateOffer = {
  kind: "after_hours", itemId: "item-night", name: "After hours call out", quantity: 1,
  because: ["2026-10-06 at 19:00, after the 17:00 close"],
};
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

describe("an offer the phone can act on", () => {
  it("is the offer with the item from the phone's own book, and nothing for an item the book lacks", () => {
    const missing: RateOffer = { ...OFFER, itemId: "item-gone" };
    expect(offersInBook([OFFER, missing], [NIGHT, OTHER])).toEqual([{ offer: OFFER, entry: NIGHT }]);
    expect(offersInBook([], [NIGHT])).toEqual([]);
  });
});

describe("on an estimate being built", () => {
  const picked = { offer: { ...OFFER, quantity: 2 }, entry: NIGHT };

  it("goes on every option at the book's price for as many visits as it is for, and only once", () => {
    let builder = newBuilder(newId, "No heat");
    builder = { ...builder, options: [...builder.options, { ...builder.options[0]!, id: newId(), name: "Better" }] };
    expect(carries(builder, "item-night")).toBe(false);
    const added = addRate(builder, picked, newId);
    expect(added.options.map((o) => o.lines.map((l) => [l.priceBookItemId, l.quantity, l.unitPrice, l.versionId, l.feeRole]))).toEqual([
      [["item-night", "2", "150.0000", "ver-night", "after_hours"]],
      [["item-night", "2", "150.0000", "ver-night", "after_hours"]],
    ]);
    expect(carries(added, "item-night")).toBe(true);
    expect(addRate(added, picked, newId)).toBe(added);
  });

  it("is waived for a member whose plan waives the after hours rate, and shown that way", () => {
    const member: MemberTerms = { planName: "Club", rate: "0", waivesDiagnosticFee: false, waivesAfterHoursRate: true };
    const builder = addRate(newBuilder(newId, ""), { offer: OFFER, entry: NIGHT }, newId);
    expect(draftTotals(builder.options[0]!, member).totals).toMatchObject({ total: "0.0000", memberSavings: "150.0000" });
    expect(draftTotals(builder.options[0]!, null).totals.total).toBe("150.0000");
  });
});

describe("on an invoice for recorded work", () => {
  const work = [{ id: "line-1", name: "Run capacitor", quantity: "1", unitPrice: "40.0000", taxable: false, itemKind: "material", feeRole: null, itemId: "item-cap" }];

  it("is a line priced from the book, and the total moves only when it is added", () => {
    const rate = rateAsBillable({ offer: OFFER, entry: NIGHT });
    expect(rate).toMatchObject({ id: "rate:item-night", unitPrice: "150.0000", feeRole: "after_hours", itemId: "item-night" });
    expect(invoiceFromWork(work, null).totals.total).toBe("40.0000");
    expect(invoiceFromWork([...work, rate], null).totals.total).toBe("190.0000");
  });

  it("is taxed at the visit's rate when the item is taxable", () => {
    const taxable = rateAsBillable({ offer: OFFER, entry: { ...NIGHT, taxable: true } });
    expect(invoiceFromWork([taxable], null, "0.1").totals).toMatchObject({ taxTotal: "15.0000", total: "165.0000" });
  });

  it("is named in the payload by item and quantity, and not at all when none was added", () => {
    const base = { visitId: "v1", shownTotal: "190.00", signerName: null, signatureUploadId: null, source: "work" as const, jobLineIds: ["line-1"] };
    expect(invoicePayload({ ...base, rates: [{ itemId: "item-night", quantity: 1 }] })["rateItems"])
      .toEqual([{ priceBookItemId: "item-night", quantity: "1" }]);
    expect("rateItems" in invoicePayload({ ...base, rates: [] })).toBe(false);
    expect("rateItems" in invoicePayload(base)).toBe(false);
  });
});

describe("on the phone's day", () => {
  const snapshot = {
    revision: 1, unchanged: false, priceBook: [NIGHT, OTHER], openTimeEntry: null,
    visits: [{
      id: "v1", jobId: "j1", jobNumber: 1, sequence: 1, status: "scheduled", summary: "No heat", description: null,
      customerComplaint: null, technicianNotes: null, arrivedAt: null, windowStart: null, windowEnd: null, routeOrder: 1,
      estimatedDurationMinutes: 60, customer: { id: "c1", name: "Pat Cold", phone: null },
      property: { id: "p1", addressLine1: "1 Frost Ln", city: "Austin", state: "TX", postalCode: "78701", gateCode: null, accessNotes: null, hazardNotes: null, hasDog: false },
      checklist: [], amountDue: null, report: { id: null, submitted: false, fields: [] }, parts: [],
      billable: [{ id: "line-1", name: "Run capacitor", quantity: "1", unitPrice: "40.0000", taxable: false, itemKind: "material", feeRole: null, itemId: "item-cap" }],
      rateOffers: { forEstimate: [OFFER], forInvoice: [OFFER] },
    }],
  };
  const op = (over: Partial<QueuedOperation>): QueuedOperation => ({
    clientId: newId(), sequence: ++ids, kind: "estimate.create", occurredAt: "2026-10-06T19:00:00Z",
    payload: {}, status: "pending", attempts: 0, ...over,
  });

  it("keeps the offer, and an older server's day has none", () => {
    expect(projectDay({ snapshot, operations: [] }).visits[0]!.rateOffers).toEqual({ forEstimate: [OFFER], forInvoice: [OFFER] });
    const old = { ...snapshot, visits: [{ ...snapshot.visits[0]!, rateOffers: undefined }] };
    expect(projectDay({ snapshot: old, operations: [] }).visits[0]!.rateOffers).toEqual({ forEstimate: [], forInvoice: [] });
  });

  it("stops offering it for an estimate once one on this phone carries it, and for an invoice once one names it", () => {
    const withEstimate = projectDay({
      snapshot, operations: [op({
        subjectId: "est-1",
        payload: { visitId: "v1", taxRate: "0", options: [{ id: "o1", name: "Repair", lines: [{ id: "l1", priceBookItemId: "item-night", name: "After hours call out", quantity: "1", unitPrice: "150.0000", taxable: false }] }] },
      })],
    });
    expect(withEstimate.visits[0]!.rateOffers).toEqual({ forEstimate: [], forInvoice: [OFFER] });

    const withInvoice = projectDay({
      snapshot, operations: [op({
        kind: "invoice.raise", subjectId: "inv-1",
        payload: { visitId: "v1", source: "work", jobLineIds: ["line-1"], shownTotal: "190.00", rateItems: [{ priceBookItemId: "item-night", quantity: "1" }] },
      })],
    });
    expect(withInvoice.visits[0]!.rateOffers).toEqual({ forEstimate: [OFFER], forInvoice: [] });
    expect(withInvoice.visits[0]!.billable).toEqual([]);
  });
});
