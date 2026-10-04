import { describe, it, expect, beforeEach } from "vitest";
import {
  FieldQueue, MemoryStorage, UploadQueue, projectDay, draftTotals,
  type FieldSnapshot, type PriceBookEntry, type UploadFiles,
} from "@opentradesos/field-client";
import {
  MAX_OPTIONS, addBookLine, addOption, addTypedLine, builderPayload, builderProblem, newBuilder, recommend,
  recordApproval, recordCashTip, recordDecline, recordEstimate, recordInvoice, recordPayment, removeLine,
  removeOption, renameOption, setOptional, type Builder,
} from "../src/lib/sell";

/**
 * THE SALE ON THE PHONE, WITHOUT THE PHONE
 *
 * The estimate builder's rules, and every step of the sale going into the
 * queue the app keeps in SQLite (a map here): in the order the server needs
 * them, signature before the approval that names it, all still there when
 * the app is opened again, and drawn on the day marked as waiting.
 */

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

const BOOK: PriceBookEntry[] = [
  { id: "item-heater", versionId: "ver-heater", code: "WH-50", name: "Water heater, 50 gallon", unitPrice: "1800.0000", taxable: false, kind: "service", feeRole: null, components: [] },
  { id: "item-diag", versionId: "ver-diag", code: "DIAG", name: "Diagnostic visit", unitPrice: "89.0000", taxable: false, kind: "fee", feeRole: "diagnostic", components: [] },
];
const MEMBER = { planName: "Comfort Club", rate: "0.1", waivesDiagnosticFee: true, waivesAfterHoursRate: false };

function must(result: { ok: true; builder: Builder } | { ok: false; problem: string }): Builder {
  if (!result.ok) throw new Error(result.problem);
  return result.builder;
}

beforeEach(() => { ids = 0; });

describe("the estimate builder", () => {
  it("starts with Good, adds Better and Best, and stops at three", () => {
    let b = newBuilder(newId, "No hot water");
    b = addOption(addOption(b, newId), newId);
    expect(b.options.map((o) => o.name)).toEqual(["Good", "Better", "Best"]);
    expect(addOption(b, newId).options).toHaveLength(MAX_OPTIONS);
    expect(b.active).toBe(2);
    b = removeOption(b, 1);
    expect(b.options.map((o) => o.name)).toEqual(["Good", "Best"]);
    expect(addOption(b, newId).options.map((o) => o.name)).toEqual(["Good", "Best", "Better"]);
  });

  it("recommends one option at most", () => {
    let b = addOption(newBuilder(newId), newId);
    b = recommend(b, 0);
    b = recommend(b, 1);
    expect(b.options.map((o) => o.isRecommended)).toEqual([false, true]);
    expect(recommend(b, 1).options.map((o) => o.isRecommended)).toEqual([false, false]);
  });

  it("adds from the price book to the option being built, refuses a bad quantity or price, and prices it for a member", () => {
    let b = newBuilder(newId);
    expect(addBookLine(b, BOOK[0]!, "two", newId)).toEqual({ ok: false, problem: "Enter how many, like 1 or 2.5." });
    b = must(addBookLine(b, BOOK[1]!, "1", newId));
    b = must(addBookLine(b, BOOK[0]!, "1", newId));
    expect(addTypedLine(b, "Fitting", "cheap", "1", newId)).toEqual({ ok: false, problem: "Enter its price, like 45 or 45.50." });
    b = must(addTypedLine(b, "Fitting", "$12.50", "2", newId));
    expect(b.options[0]!.lines.map((l) => [l.name, l.unitPrice])).toEqual([
      ["Diagnostic visit", "89.0000"], ["Water heater, 50 gallon", "1800.0000"], ["Fitting", "12.50"],
    ]);
    // The diagnostic fee waived, ten per cent off the heater and the fittings.
    expect(draftTotals(b.options[0]!, MEMBER).totals.total).toBe("1642.5000");
    const fitting = b.options[0]!.lines[2]!.id;
    expect(draftTotals(setOptional(b, fitting, true).options[0]!, MEMBER).totals.total).toBe("1620.0000");
    expect(removeLine(b, fitting).options[0]!.lines).toHaveLength(2);
  });

  it("will not show the customer an option with nothing on it, or a tax that is not a percentage", () => {
    let b = addOption(newBuilder(newId), newId);
    b = must(addBookLine(b, BOOK[0]!, "1", newId));
    expect(builderProblem(b)).toBe("Good has nothing on it yet.");
    b = must(addBookLine({ ...b, active: 0 }, BOOK[1]!, "1", newId));
    expect(builderProblem(b)).toBeNull();
    expect(builderProblem({ ...b, taxPercent: "eight" })).toMatch(/sales tax as a percentage/);
    expect(builderProblem(renameOption(b, 0, " "))).toMatch(/Give every option a name/);
    expect(builderPayload({ ...b, taxPercent: "8.25" }, "v1")).toMatchObject({ visitId: "v1", taxRate: "0.0825" });
  });
});

/* ------------------------------------------------------------ the queue */

const files: UploadFiles = { async read() { return "c2lnbmF0dXJl"; }, async remove() {} };

function phone(storage: MemoryStorage) {
  const queue = new FieldQueue({ storage, deviceId: "device-1", newId });
  const uploads = new UploadQueue({ storage, queue, files });
  return { queue, uploads };
}

function snapshot(): FieldSnapshot {
  return {
    revision: 1, unchanged: false, priceBook: BOOK, openTimeEntry: null,
    visits: [{
      id: "v1", jobId: "job-1", jobNumber: 1042, sequence: 1, status: "working", summary: "No hot water",
      description: null, customerComplaint: null, technicianNotes: null, arrivedAt: "2026-10-02T14:00:00Z",
      windowStart: "2026-10-02T14:00:00Z", windowEnd: "2026-10-02T16:00:00Z", routeOrder: 1, estimatedDurationMinutes: 60,
      customer: { id: "c1", name: "Nina Patel", phone: null },
      property: { id: "p1", addressLine1: "12 Elm St", city: "Austin", state: "TX", postalCode: "78704", gateCode: null, accessNotes: null, hazardNotes: null, hasDog: false },
      checklist: [], amountDue: null, report: { id: null, submitted: false, fields: [] }, parts: [],
      member: MEMBER, estimates: [], billable: [], invoices: [],
    }],
  };
}

describe("the sale, into the queue with no signal", () => {
  it("keeps the estimate, the signature before the approval, the invoice, the payment and a tip, in that order, through a restart", async () => {
    const storage = new MemoryStorage();
    const first = phone(storage);
    let builder = addOption(newBuilder(newId, "No hot water"), newId);
    builder = must(addBookLine({ ...builder, active: 0 }, BOOK[1]!, "1", newId));
    builder = must(addBookLine({ ...builder, active: 1 }, BOOK[1]!, "1", newId));
    builder = must(addBookLine(builder, BOOK[0]!, "1", newId));
    const estimateId = newId();
    await recordEstimate(first, { visitId: "v1", estimateId, builder });

    const day = () => projectDay({ snapshot: snapshot(), operations: [], applied: [] });
    let view = projectDay({ snapshot: snapshot(), operations: await first.queue.pending() });
    const shown = view.visits[0]!.estimates[0]!;
    expect(shown).toMatchObject({ id: estimateId, status: "draft", waiting: true });
    expect(shown.options.map((o) => o.total)).toEqual(["0.0000", "1620.0000"]);
    expect(day().visits[0]!.estimates).toEqual([]);

    const option = shown.options[1]!;
    const signature = { uploadId: newId(), localUri: "file:///sig.png", byteSize: 2048, contentHash: "ab".repeat(32) };
    await recordApproval(first, { visitId: "v1", estimateId, option, ticked: [], signerName: "Nina Patel", signature });
    const invoiceId = newId();
    await recordInvoice(first, {
      visitId: "v1", invoiceId, shownTotal: option.total, signerName: "Nina Patel",
      signature: { ...signature, uploadId: newId() }, source: "estimate", estimateId,
    });
    await recordPayment(first, { visitId: "v1", method: "cash", amount: "1620.00", tip: "40.00", checkNumber: null, invoiceId });
    await recordCashTip(first, { visitId: "v1", amount: "20.00", tipId: newId() });

    // Opened again on the same storage: everything is still there, in order.
    const second = phone(storage);
    const pending = await second.queue.pending();
    expect(pending.map((op) => op.kind)).toEqual([
      "estimate.create", "signature.capture", "estimate.approve", "signature.capture", "invoice.raise", "payment.collect", "tip.record",
    ]);
    expect(pending.map((op) => op.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const approval = pending[2]!;
    expect(approval.payload).toMatchObject({ signatureUploadId: signature.uploadId, shownTotal: "1620.0000", signerName: "Nina Patel" });
    expect(pending[1]!.payload).toMatchObject({ uploadId: signature.uploadId, contentHash: signature.contentHash });
    expect(pending[5]!.payload).toEqual({ method: "cash", amount: "1620.00", tipAmount: "40.00", invoiceId });

    view = projectDay({ snapshot: snapshot(), operations: pending, uploads: await second.uploads.list() });
    const visit = view.visits[0]!;
    expect(visit.estimates[0]).toMatchObject({ status: "converted", signerName: "Nina Patel", waiting: true });
    expect(visit.invoices[0]).toMatchObject({ id: invoiceId, total: "1620.0000", waiting: true });
    expect(visit.amountDue).toBe("1620.0000");
    expect(visit.signed).toBe(true);
    expect(visit.cashTips).toEqual([expect.objectContaining({ amount: "20.00", waiting: true })]);
    expect((await second.uploads.list()).filter((u) => u.kind === "signature")).toHaveLength(2);
  });

  it("records a no with the customer's reason, and an invoice for parts recorded here", async () => {
    const storage = new MemoryStorage();
    const p = phone(storage);
    await recordDecline(p, { visitId: "v1", estimateId: "est-1", reason: "  Getting another quote " });
    await p.queue.enqueue({ kind: "visit.add_line", subjectId: "v1", payload: {
      lineId: "line-1", kind: "part", name: "Expansion tank", quantity: "1", unitPrice: "180.0000", itemKind: "material",
    } });
    await recordInvoice(p, {
      visitId: "v1", invoiceId: "inv-1", shownTotal: "162.0000", signerName: null, signature: null,
      source: "work", jobLineIds: ["line-1"],
    });
    const pending = await p.queue.pending();
    expect(pending[0]!.payload).toEqual({ visitId: "v1", reason: "Getting another quote" });
    expect(pending[2]!.payload).toEqual({ visitId: "v1", source: "work", jobLineIds: ["line-1"], shownTotal: "162.0000" });
    const visit = projectDay({ snapshot: snapshot(), operations: pending }).visits[0]!;
    // Billed on this phone, so no longer waiting to be billed.
    expect(visit.billable).toEqual([]);
    expect(visit.invoices[0]).toMatchObject({ id: "inv-1", total: "162.0000", waiting: true });
  });
});
