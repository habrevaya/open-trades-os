import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  projectDay, readingValue, outOfRange, visitOf, describeOperation,
  parseAmount, formatAmount, isOwing, sha256Hex, toBase64, FieldApi,
  type QueuedOperation, type FieldSnapshot,
} from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * The work a technician records on a visit beyond moving it along: the
 * checklist, the readings, the parts and the money. Each is an operation in
 * the queue like everything else, and the day is drawn with them laid over
 * the server's last word, so a reading typed in a basement is on the screen
 * after the app is killed, marked as waiting, until the server has it.
 */

let seq = 0;
const op = (over: Partial<QueuedOperation>): QueuedOperation => ({
  clientId: `op-${++seq}`, sequence: seq, kind: "visit.note", occurredAt: "2026-10-02T15:00:00.000Z",
  payload: {}, status: "pending", attempts: 0, ...over,
});

function day(): FieldSnapshot {
  const server = new FakeServer();
  server.addVisit("v1", {
    customer: { id: "c1", name: "Nina Patel", phone: null },
    checklist: [
      { id: "i1", label: "Check the filter", required: true, doneAt: null },
      { id: "i2", label: "Test the thermostat", required: false, doneAt: "2026-10-02T14:30:00.000Z" },
    ],
    amountDue: "180.0000",
    report: {
      id: null, submitted: false,
      fields: [
        { key: "suction", label: "Suction pressure", kind: "numeric", unit: "psi", options: [], required: true, min: 50, max: 150, value: null },
        { key: "filter", label: "Filter changed", kind: "boolean", unit: null, options: [], required: false, min: null, max: null, value: "no" },
      ],
    },
    parts: [{ id: "line-1", name: "Capacitor", quantity: "1.0000" }],
  });
  return { revision: 1, unchanged: false, openTimeEntry: null, priceBook: [], visits: [...server.visits.values()] };
}

describe("the work recorded on a visit", () => {
  it("ticks and unticks the checklist from the queue, marked waiting", () => {
    const view = projectDay({
      snapshot: day(),
      operations: [
        op({ kind: "visit.checklist_item", subjectId: "v1", payload: { itemId: "i1", done: true } }),
        op({ kind: "visit.checklist_item", subjectId: "v1", payload: { itemId: "i2", done: false } }),
      ],
    });
    const [first, second] = view.visits[0]!.checklist;
    expect(first).toMatchObject({ id: "i1", doneAt: "2026-10-02T15:00:00.000Z", waiting: true });
    expect(second).toMatchObject({ id: "i2", doneAt: null, waiting: true });
  });

  it("lays readings over the template, takes the report id the phone made, and keeps an extra one", () => {
    const view = projectDay({
      snapshot: day(),
      operations: [
        op({ kind: "service_report.set_field", subjectId: "r-new", payload: { visitId: "v1", field: "suction", value: 118 } }),
        op({ kind: "service_report.set_field", subjectId: "r-new", payload: { visitId: "v1", field: "filter", value: true } }),
        op({ kind: "service_report.set_field", subjectId: "r-new", payload: { visitId: "v1", field: "note", label: "Note", kind: "text", value: "Coil dirty" } }),
      ],
    });
    const report = view.visits[0]!.report;
    expect(report.id).toBe("r-new");
    expect(report.fields.find((f) => f.key === "suction")).toMatchObject({ value: "118", waiting: true });
    expect(report.fields.find((f) => f.key === "filter")).toMatchObject({ value: "yes" });
    expect(report.fields.find((f) => f.key === "note")).toMatchObject({ label: "Note", value: "Coil dirty" });
    expect(view.visits[0]!.waiting).toBe(3);
  });

  it("shows a report sent from the phone as submitted, waiting until it lands", () => {
    const view = projectDay({
      snapshot: day(),
      operations: [op({ kind: "service_report.submit", subjectId: "r-new", payload: { visitId: "v1" } })],
    });
    expect(view.visits[0]!.report).toMatchObject({ id: "r-new", submitted: true, submitWaiting: true });
  });

  it("adds parts used to what the server already had", () => {
    const view = projectDay({
      snapshot: day(),
      operations: [op({ kind: "visit.add_line", subjectId: "v1", payload: { name: "Contactor", quantity: "2" } })],
    });
    expect(view.visits[0]!.parts).toEqual([
      { id: "line-1", name: "Capacitor", quantity: "1.0000", waiting: false },
      expect.objectContaining({ name: "Contactor", quantity: "2", waiting: true }),
    ]);
  });

  it("shows cash and checks taken on this phone, and what was owed", () => {
    const applied = op({ kind: "payment.collect", subjectId: "v1", payload: { method: "cash", amount: "100.00" } });
    const view = projectDay({
      snapshot: day(),
      applied: [applied],
      operations: [op({ kind: "payment.collect", subjectId: "v1", payload: { method: "check", amount: "80.00", checkNumber: "1042" } })],
    });
    const visit = view.visits[0]!;
    expect(visit.amountDue).toBe("180.0000");
    expect(visit.payments).toEqual([
      expect.objectContaining({ method: "cash", amount: "100.00", waiting: false }),
      expect.objectContaining({ method: "check", amount: "80.00", checkNumber: "1042", waiting: true }),
    ]);
  });

  it("reads a day from a server that sends none of the new fields", () => {
    const old = day();
    const visit = old.visits[0]! as unknown as Record<string, unknown>;
    delete visit["report"];
    delete visit["parts"];
    delete visit["amountDue"];
    const view = projectDay({ snapshot: old, operations: [] });
    expect(view.visits[0]).toMatchObject({ amountDue: null, parts: [], report: { id: null, fields: [] } });
  });

  it("finds the visit a report operation is about from its payload", () => {
    expect(visitOf({ kind: "service_report.set_field", subjectId: "r1", payload: { visitId: "v9" } })).toBe("v9");
    expect(visitOf({ kind: "visit.add_line", subjectId: "v2", payload: {} })).toBe("v2");
  });

  it("names the customer when a payment or a reading is refused", () => {
    const names = (id: string) => (id === "v1" ? "Nina Patel" : undefined);
    const payment = describeOperation(op({
      kind: "payment.collect", subjectId: "v1", status: "rejected", lastError: "That period is closed",
    }), names);
    expect(payment?.detail).toBe("A payment taken at Nina Patel's job was not accepted. That period is closed.");
    const reading = describeOperation(op({
      kind: "service_report.set_field", subjectId: "r1", payload: { visitId: "v1" }, status: "rejected", lastError: "No",
    }), names);
    expect(reading?.detail).toContain("Nina Patel's job");
  });
});

describe("what a reading box holds", () => {
  const numeric = { kind: "numeric", options: [] };
  it("turns a number into a number and refuses a letter", () => {
    expect(readingValue(numeric, " 118.5 ")).toBe(118.5);
    expect(readingValue(numeric, "1,200")).toBe(1200);
    expect(readingValue(numeric, "12a")).toBeNull();
    expect(readingValue(numeric, "")).toBeNull();
  });

  it("reads yes and no, and only the options a select offers", () => {
    expect(readingValue({ kind: "boolean", options: [] }, "Yes")).toBe(true);
    expect(readingValue({ kind: "boolean", options: [] }, "n")).toBe(false);
    expect(readingValue({ kind: "boolean", options: [] }, "maybe")).toBeNull();
    expect(readingValue({ kind: "select", options: ["Clean", "Dirty"] }, "Dirty")).toBe("Dirty");
    expect(readingValue({ kind: "select", options: ["Clean", "Dirty"] }, "Muddy")).toBeNull();
    expect(readingValue({ kind: "text", options: [] }, "  words ")).toBe("words");
  });

  it("says when a reading is outside the template's range", () => {
    expect(outOfRange({ min: 50, max: 150 }, 160)).toBe(true);
    expect(outOfRange({ min: 50, max: 150 }, 100)).toBe(false);
    expect(outOfRange({ min: null, max: null }, 1e6)).toBe(false);
    expect(outOfRange({ min: 50, max: 150 }, "high")).toBe(false);
  });
});

describe("money as typed and shown", () => {
  it("reads what a thumb types into two places, and refuses anything ambiguous", () => {
    expect(parseAmount("120")).toBe("120.00");
    expect(parseAmount("$1,250.5")).toBe("1250.50");
    expect(parseAmount("0.99")).toBe("0.99");
    expect(parseAmount("007.10")).toBe("7.10");
    expect(parseAmount("1.999")).toBeNull();
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("1.2.3")).toBeNull();
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });

  it("shows a balance as a person writes it, rounded on the digits", () => {
    expect(formatAmount("180.0000")).toBe("$180.00");
    expect(formatAmount("1234567.5")).toBe("$1,234,567.50");
    expect(formatAmount("0.0050")).toBe("$0.01");
    expect(formatAmount("9.9950")).toBe("$10.00");
    expect(formatAmount("-12.3400")).toBe("-$12.34");
  });

  it("knows owing from nothing owed", () => {
    expect(isOwing("0.0000")).toBe(false);
    expect(isOwing("0.0100")).toBe(true);
    expect(isOwing(null)).toBe(false);
    expect(isOwing("-5.00")).toBe(false);
  });
});

describe("the hash a page sends with a photograph", () => {
  it("matches Node's own SHA-256 at every length around a block boundary", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 31 + length) % 256);
      expect(sha256Hex(bytes), `length ${length}`).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("base64s large bytes without running out of stack", () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("the calls the phone makes for codes and payments", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("asks for a code and signs in with it without a token, and a wrong code is an answer, not a sign out", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/code")
        ? json(200, { ok: true, message: "If that email belongs to a technician, a code is on its way." })
        : json(401, { error: "That code is not right, or it has expired. Ask for a new one." });
    }) as unknown as typeof fetch;
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_x", fetch: fetcher });

    await expect(api.requestCode({ email: "a@b.co", channel: "sms" })).resolves.toMatchObject({ ok: true });
    await expect(api.signInWithCode({ email: "a@b.co", code: "123456" }))
      .rejects.toThrow("That code is not right, or it has expired. Ask for a new one.");
    expect(calls.map((c) => c.url)).toEqual([
      "https://ops.example.com/api/v1/field/sign-in/code",
      "https://ops.example.com/api/v1/field/sign-in/verify",
    ]);
    for (const call of calls) expect(new Headers(call.init.headers).get("authorization")).toBeNull();
  });

  it("asks for a payment link with an idempotency key, and sends a push token on registering", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(200, url.includes("payment-link")
        ? { url: "https://ops.example.com/p/x", invoiceId: "i", invoiceNumber: 7, amountDue: "10.0000", texted: true, reason: null }
        : { deviceId: "d", lastSequence: 0 });
    }) as unknown as typeof fetch;
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_x", fetch: fetcher });

    await api.paymentLink("v1", true, "key-1");
    await api.register({ installationId: "install-1", pushToken: "ExponentPushToken[abcdefghij]" });
    expect(calls[0]!.url).toBe("https://ops.example.com/api/v1/visits/v1/payment-link");
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBe("key-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: true });
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ pushToken: "ExponentPushToken[abcdefghij]" });
  });
});
