import { describe, it, expect, beforeEach } from "vitest";
import {
  FieldApi, FieldQueue, MemoryStorage, SyncEngine, UploadQueue, projectDay, describeOperation,
  lineFromBook, typedLine, draftTotals, estimatePayload, estimateFromPayload, findInPriceBook, optionProblem,
  presentationOrder, optionTotal, approvalPayload, invoiceFromWork, invoiceFromEstimate, invoicePayload,
  paymentPayload, tipChoices, decidable, compareAmounts,
  type DraftOption, type PriceBookEntry, type QueuedOperation, type UploadFiles, type MemberTerms,
} from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * THE KITCHEN TABLE, WITH NO SIGNAL
 *
 * Good, better and best built from the price book the phone carries, the
 * customer's choice and signature, the invoice and a payment with a tip,
 * all into the queue in a basement, all still there after the app is
 * killed, all on the screen marked as waiting, and all landing in order when
 * the van finds a signal. The figures are core's: the customer signs for
 * what the phone shows, and a test in core holds the phone's sum to the
 * server's.
 */

const MEMBER: MemberTerms = { planName: "Comfort Club", rate: "0.1", waivesDiagnosticFee: true, waivesAfterHoursRate: false };

const BOOK: PriceBookEntry[] = [
  { id: "item-heater", versionId: "ver-heater", code: "WH-50", name: "Water heater, 50 gallon", unitPrice: "1800.0000", taxable: false, kind: "service", feeRole: null, description: "Installed and haul away", components: [] },
  { id: "item-tank", versionId: "ver-tank", code: "EXP-2", name: "Expansion tank", unitPrice: "180.0000", taxable: false, kind: "material", feeRole: null, description: null, components: [] },
  { id: "item-diag", versionId: "ver-diag", code: "DIAG", name: "Diagnostic visit", unitPrice: "89.0000", taxable: false, kind: "fee", feeRole: "diagnostic", description: null, components: [] },
  { id: "item-kit", versionId: "ver-kit", code: "TUNE", name: "Flush and tune kit", unitPrice: "250.0000", taxable: false, kind: "service", feeRole: null, description: null,
    components: [{ name: "Expansion tank", quantity: 1 }, { name: "Anode rod", quantity: 2 }] },
];

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const entry = (code: string) => BOOK.find((b) => b.code === code)!;

function options(): { good: DraftOption; best: DraftOption } {
  const good: DraftOption = {
    id: newId(), name: "Repair", description: "", isRecommended: false,
    lines: [lineFromBook(entry("DIAG"), "1", newId), lineFromBook(entry("EXP-2"), "1", newId)],
  };
  const tank = { ...lineFromBook(entry("EXP-2"), "1", newId), isOptional: true };
  const best: DraftOption = {
    id: newId(), name: "Replace", description: "New heater", isRecommended: true,
    lines: [lineFromBook(entry("DIAG"), "1", newId), lineFromBook(entry("WH-50"), "1", newId), tank],
  };
  return { good, best };
}

beforeEach(() => { ids = 0; });

describe("building good, better and best from the price book on the phone", () => {
  it("finds an item by code, name, description and what a kit contains", () => {
    expect(findInPriceBook(BOOK, "diag").map((e) => e.code)).toEqual(["DIAG"]);
    expect(findInPriceBook(BOOK, "tank").map((e) => e.code)).toEqual(["EXP-2", "TUNE"]);
    expect(findInPriceBook(BOOK, "anode").map((e) => e.code)).toEqual(["TUNE"]);
    expect(findInPriceBook(BOOK, "")).toEqual([]);
  });

  it("says what a kit covers, and keeps the version the price came from", () => {
    const line = lineFromBook(entry("TUNE"), "1", newId);
    expect(line.description).toBe("Includes Expansion tank, 2 x Anode rod.");
    expect(line).toMatchObject({ priceBookItemId: "item-kit", versionId: "ver-kit", unitPrice: "250.0000" });
  });

  it("shows the member's price: the diagnostic fee waived and ten per cent off the rest", () => {
    const { good, best } = options();
    expect(draftTotals(good, MEMBER).totals).toMatchObject({ total: "162.0000", memberSavings: "107.0000" });
    expect(draftTotals(good, null).totals.total).toBe("269.0000");
    // The optional tank is shown and not counted until it is ticked.
    expect(draftTotals(best, MEMBER).totals.total).toBe("1620.0000");
  });

  it("will not show an option with no name or nothing but extras", () => {
    const { good } = options();
    expect(optionProblem({ ...good, name: " " })).toMatch(/Give every option a name/);
    expect(optionProblem({ ...good, lines: good.lines.map((l) => ({ ...l, isOptional: true })) })).toMatch(/only optional extras/);
    expect(optionProblem(good)).toBeNull();
  });

  it("writes the payload the server takes, and reads it back as the estimate the customer sees", () => {
    const { good, best } = options();
    const payload = estimatePayload({ visitId: "v1", title: "No hot water", taxRate: "0", options: [good, best] });
    expect(payload).toMatchObject({ visitId: "v1", title: "No hot water" });
    const shown = estimateFromPayload("est-1", payload, MEMBER);
    expect(shown.options.map((o) => o.total)).toEqual(["162.0000", "1620.0000"]);
    expect(shown.options[0]!.lines[0]).toMatchObject({ memberDiscountAmount: "89.0000", discountAmount: "89.0000" });
    expect(JSON.stringify(shown)).not.toMatch(/cost|margin/i);
  });
});

describe("showing the customer and taking their choice", () => {
  it("puts the recommended option first, then the dearest", () => {
    expect(presentationOrder([
      { name: "a", total: "100.00", isRecommended: false },
      { name: "b", total: "900.00", isRecommended: false },
      { name: "c", total: "400.00", isRecommended: true },
    ]).map((o) => o.name)).toEqual(["c", "b", "a"]);
    expect(compareAmounts("10.5", "10.50")).toBe(0);
    expect(compareAmounts("9.99", "10")).toBe(-1);
  });

  it("adds the extras they tick to the figure they sign for", () => {
    const { best } = options();
    const shown = estimateFromPayload("est-1", estimatePayload({ visitId: "v1", title: "", taxRate: "0", options: [best] }), MEMBER);
    const option = shown.options[0]!;
    const tank = option.lines[2]!.id;
    expect(optionTotal(option, [])).toBe("1620.0000");
    expect(optionTotal(option, [tank])).toBe("1782.0000");
    expect(approvalPayload({ visitId: "v1", option, ticked: [tank], signerName: " Nina Patel ", signatureUploadId: "sig-1" }))
      .toEqual({ visitId: "v1", optionId: option.id, selectedLineIds: [tank], signerName: "Nina Patel", signatureUploadId: "sig-1", shownTotal: "1782.0000" });
    expect(decidable(shown)).toBe(true);
    expect(decidable({ status: "converted" })).toBe(false);
  });
});

describe("the invoice and the money", () => {
  it("prices the work recorded the way the server will, with the member's discount", () => {
    const work = invoiceFromWork([
      { id: "l1", name: "Expansion tank", quantity: "2", unitPrice: "180.0000", taxable: true, itemKind: "material", feeRole: null },
      { id: "l2", name: "Diagnostic visit", quantity: "1", unitPrice: "89.0000", taxable: false, itemKind: "fee", feeRole: "diagnostic" },
    ], MEMBER);
    expect(work.totals.total).toBe("324.0000");
    expect(work.lines.map((l) => l.memberDiscount)).toEqual(["36.0000", "89.0000"]);
  });

  it("bills the option signed for as signed, and nothing until one is", () => {
    const { best } = options();
    const shown = estimateFromPayload("est-1", estimatePayload({ visitId: "v1", title: "", taxRate: "0", options: [best] }), MEMBER);
    expect(invoiceFromEstimate(shown)).toBeNull();
    const approved = { ...shown, status: "approved", selectedOptionId: shown.options[0]!.id };
    expect(invoiceFromEstimate(approved)).toMatchObject({ total: "1620.0000" });
    expect(invoiceFromEstimate(approved)!.lines).toHaveLength(2);
  });

  it("suggests the tips the portal would, and leaves a tip of nothing off the payment", () => {
    expect(tipChoices("162.00", [15, 20, 25])).toEqual([
      { percent: 15, amount: "24.3000" }, { percent: 20, amount: "32.4000" }, { percent: 25, amount: "40.5000" },
    ]);
    expect(paymentPayload({ method: "cash", amount: "162.00", tip: "0.00", checkNumber: null, invoiceId: "inv-1" }))
      .toEqual({ method: "cash", amount: "162.00", invoiceId: "inv-1" });
    expect(paymentPayload({ method: "check", amount: "162.00", tip: "24.30", checkNumber: " 1042 ", invoiceId: null }))
      .toEqual({ method: "check", amount: "162.00", tipAmount: "24.30", checkNumber: "1042" });
    expect(invoicePayload({ visitId: "v1", source: "work", jobLineIds: ["l1"], shownTotal: "324.00", signerName: " ", signatureUploadId: null }))
      .toEqual({ visitId: "v1", source: "work", jobLineIds: ["l1"], shownTotal: "324.00" });
  });
});

/* -------------------------------------------------------------- offline */

const files: UploadFiles = {
  async read() { return Buffer.from("a signature").toString("base64"); },
  async remove() {},
};

function phone(storage: MemoryStorage, server: FakeServer, clock: () => Date) {
  const queue = new FieldQueue({ storage, deviceId: "device-1", newId, now: clock, random: () => 1 });
  const uploads = new UploadQueue({ storage, queue, files, now: clock });
  const engine = new SyncEngine({
    queue, uploads, storage, transport: server.transport(), uploadTransport: server.uploads(),
    snapshot: (input) => server.snapshot(input), timezone: "America/Chicago", now: clock,
  });
  return { queue, uploads, engine };
}

describe("the whole sale in a basement, sent from the van", () => {
  it("keeps the estimate, the signature, the invoice and the payment with a tip through a restart, and sends them in order", async () => {
    const storage = new MemoryStorage();
    const server = new FakeServer();
    server.addVisit("v1", { customer: { id: "c1", name: "Nina Patel", phone: null }, member: MEMBER, estimates: [], billable: [], invoices: [] });
    let now = new Date("2026-10-02T15:00:00Z");
    const clock = () => now;

    const first = phone(storage, server, clock);
    await first.engine.run({ force: true });
    server.offline = true;

    const { good, best } = options();
    const estimateId = newId();
    await first.queue.enqueue({
      kind: "estimate.create", subjectId: estimateId,
      payload: estimatePayload({ visitId: "v1", title: "No hot water", taxRate: "0", options: [good, best] }),
    });
    let view = await first.engine.view();
    const built = view.day.visits[0]!.estimates.find((e) => e.id === estimateId)!;
    expect(built).toMatchObject({ status: "draft", waiting: true });
    const option = built.options.find((o) => o.name === "Replace")!;

    const signatureId = newId();
    await first.uploads.add({ uploadId: signatureId, visitId: "v1", kind: "signature", contentType: "image/png", localUri: "file://sig.png", byteSize: 11, contentHash: "x" });
    await first.queue.enqueue({
      kind: "estimate.approve", subjectId: estimateId,
      payload: approvalPayload({ visitId: "v1", option, ticked: [], signerName: "Nina Patel", signatureUploadId: signatureId }),
    });
    const invoice = invoiceFromEstimate({ ...built, status: "approved", selectedOptionId: option.id })!;
    const invoiceId = newId();
    await first.queue.enqueue({
      kind: "invoice.raise", subjectId: invoiceId,
      payload: invoicePayload({ visitId: "v1", source: "estimate", estimateId, shownTotal: invoice.total, signerName: "Nina Patel", signatureUploadId: signatureId }),
    });
    await first.queue.enqueue({
      kind: "payment.collect", subjectId: "v1",
      payload: paymentPayload({ method: "cash", amount: invoice.total, tip: "40.00", checkNumber: null, invoiceId }),
    });
    await first.queue.enqueue({ kind: "tip.record", subjectId: "v1", payload: { amount: "20.00" } });

    // The app is killed. A new one opens on the same storage, still with no signal.
    const second = phone(storage, server, clock);
    expect((await second.engine.run({ force: true })).offline).toBe(true);
    view = await second.engine.view();
    const visit = view.day.visits[0]!;
    expect(visit.estimates.find((e) => e.id === estimateId)).toMatchObject({
      status: "converted", selectedOptionId: option.id, signerName: "Nina Patel", waiting: true,
    });
    expect(visit.invoices).toEqual([{ id: invoiceId, number: 0, status: "open", total: "1620.0000", balance: "1620.0000", waiting: true }]);
    expect(visit.amountDue).toBe("1620.0000");
    expect(visit.payments).toEqual([expect.objectContaining({ method: "cash", amount: "1620.0000", tip: "40.00", waiting: true })]);
    expect(visit.cashTips).toEqual([expect.objectContaining({ amount: "20.00", waiting: true })]);
    expect(visit.signed).toBe(true);
    // Five, and the record of the signature the upload queue put in the operation queue itself.
    expect(view.waiting).toBe(6);

    // The van finds a signal.
    server.offline = false;
    now = new Date("2026-10-02T15:30:00Z");
    const report = await second.engine.run({ force: true });
    expect(report.applied).toBe(6);
    const kinds = [...server.applied.entries()].map(([, v]) => v.status);
    expect(kinds.every((s) => s === "applied")).toBe(true);
    view = await second.engine.view();
    expect(view.waiting).toBe(0);
    const landed = view.day.visits[0]!;
    expect(landed.estimates.find((e) => e.id === estimateId)).toMatchObject({ number: 2001, status: "approved", waiting: false });
    expect(landed.invoices.map((i) => [i.number, i.waiting])).toEqual([[3001, false]]);
  });

  it("says what the office did with an invoice kept as a draft, in the office's words", () => {
    const op: QueuedOperation = {
      clientId: "op-1", sequence: 1, kind: "invoice.raise", subjectId: "inv-1", occurredAt: "2026-10-02T15:00:00Z",
      payload: { visitId: "v1" }, status: "conflicted", attempts: 1,
      conflict: "The customer was shown $150.00 and the office's prices make it $162.00, so the invoice was kept as a draft for the office to check before it is sent.",
    };
    const problem = describeOperation(op, () => "Nina Patel")!;
    expect(problem.title).toBe("Recorded, and the office has been told");
    expect(problem.detail).toBe(
      "The invoice you raised for Nina Patel's job is with the office. The customer was shown $150.00 and the office's prices make it $162.00, so the invoice was kept as a draft for the office to check before it is sent. Nothing for you to do.",
    );
  });

  it("says a refused signature was not recorded, in the server's sentence", () => {
    const problem = describeOperation({
      clientId: "op-2", sequence: 2, kind: "estimate.approve", subjectId: "est-1", occurredAt: "2026-10-02T15:00:00Z",
      payload: { visitId: "v1" }, status: "rejected", attempts: 1,
      lastError: "The customer was shown $1,500.00, and this option with what they ticked comes to $1,620.00, so it was not recorded as approved. Show it to them again and have them sign again.",
    }, () => "Nina Patel")!;
    expect(problem).toMatchObject({ title: "Not recorded", action: "retry_or_discard" });
    expect(problem.detail).toMatch(/^The customer's signature on the estimate for Nina Patel's job was not accepted\. The customer was shown/);
  });
});

describe("the office's tasks on the phone", () => {
  it("takes one and finishes it, marked waiting until the office has it", () => {
    const op = (over: Partial<QueuedOperation>): QueuedOperation => ({
      clientId: newId(), sequence: ++ids, kind: "task.claim", occurredAt: "2026-10-02T15:00:00Z",
      payload: {}, status: "pending", attempts: 0, ...over,
    });
    const snapshot = {
      revision: 1, unchanged: false, visits: [], priceBook: [], openTimeEntry: null,
      tasks: [
        { id: "t1", title: "Call Nina back", body: null, priority: "normal", status: "open", mine: false, dueAt: null, overdue: false, checklistTotal: 0, checklistDone: 0 },
        { id: "t2", title: "Van check", body: null, priority: "high", status: "open", mine: true, dueAt: null, overdue: true, checklistTotal: 3, checklistDone: 1 },
      ],
    };
    const day = projectDay({
      snapshot,
      operations: [op({ kind: "task.claim", subjectId: "t1" }), op({ kind: "task.close", subjectId: "t2", payload: { outcome: "Done" } })],
    });
    expect(day.tasks.find((t) => t.id === "t1")).toMatchObject({ mine: true, status: "in_progress", waiting: true, done: false });
    expect(day.tasks.find((t) => t.id === "t2")).toMatchObject({ done: true, waiting: true });
  });

  it("is said in words when somebody else took it first", () => {
    const problem = describeOperation({
      clientId: "op-3", sequence: 3, kind: "task.claim", subjectId: "t1", occurredAt: "2026-10-02T15:00:00Z",
      payload: {}, status: "rejected", attempts: 1, lastError: "Somebody else has that one",
    });
    expect(problem!.detail).toBe("Taking a task was not accepted. Somebody else has that one.");
  });

  it("typed lines are priced as typed", () => {
    expect(typedLine("  Fitting ", "12.00", "2", newId)).toMatchObject({ name: "Fitting", priceBookItemId: null, unitPrice: "12.00" });
  });
});

describe("the two things that need a signal", () => {
  it("asks for the lender's link and the field assistant with an idempotency key each", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url.includes("financing")
        ? { url: "https://lender.example/apply", invoiceId: "i", invoiceNumber: 7, amount: "3780.0000", lender: "Wisetack", texted: false, reason: null }
        : { answered: true, text: "Drain it until it runs clear.", sources: [{ kind: "procedure", title: "Flushing" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_x", fetch: fetcher });

    expect((await api.financingLink("v1", false, "key-1")).lender).toBe("Wisetack");
    expect((await api.askAssistant("How do we flush it?", "v1", "key-2")).answered).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://ops.example.com/api/v1/visits/v1/financing-link",
      "https://ops.example.com/api/v1/ai/field-assistant",
    ]);
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBe("key-1");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ question: "How do we flush it?", visitId: "v1" });
  });
});
