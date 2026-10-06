import { describe, it, expect, beforeEach } from "vitest";
import {
  FieldQueue, MemoryStorage, SyncEngine, UploadQueue, checkExpenseDraft, describeOperation, recordExpense,
  type QueuedOperation, type UploadFiles,
} from "../src/index";
import { FakeServer, sha256Base64 } from "./fake-server";

/**
 * WHAT THE TECHNICIAN PAID FOR THE COMPANY, FROM A BASEMENT
 *
 * The expense and its receipt go into the queue with no signal, are still there
 * after the app is killed, show on the day as waiting, land in order when the
 * van finds a signal, and the office's answer comes back with the day.
 */

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
beforeEach(() => { ids = 0; });

const files: UploadFiles = {
  async read() { return Buffer.from("a receipt").toString("base64"); },
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

describe("checking what was typed before it is kept", () => {
  const today = "2026-10-05";
  const draft = { amount: "$42.50", spentOn: "2026-10-04", description: " Capacitor from the supply house ", jobId: null };

  it("keeps the figures the queue stores", () => {
    expect(checkExpenseDraft(draft, today)).toEqual({
      ok: true, amount: "42.50", spentOn: "2026-10-04", description: "Capacitor from the supply house", jobId: null,
    });
  });

  it("says what is wrong in words", () => {
    expect(checkExpenseDraft({ ...draft, amount: "forty" }, today)).toMatchObject({ ok: false, reason: expect.stringMatching(/dollars and cents/) });
    expect(checkExpenseDraft({ ...draft, amount: "0" }, today)).toMatchObject({ ok: false });
    expect(checkExpenseDraft({ ...draft, amount: "10000.01" }, today)).toMatchObject({ ok: false, reason: expect.stringMatching(/Ask the office/) });
    expect(checkExpenseDraft({ ...draft, spentOn: "2026-10-06" }, today)).toMatchObject({ ok: false, reason: expect.stringMatching(/not happened/) });
    expect(checkExpenseDraft({ ...draft, description: " " }, today)).toMatchObject({ ok: false, reason: expect.stringMatching(/what it was for/) });
  });
});

describe("an expense and its receipt, recorded with no signal", () => {
  it("keeps both through a restart, shows them as waiting, sends them in order and brings back the office's answer", async () => {
    const storage = new MemoryStorage();
    const server = new FakeServer();
    server.addVisit("v1", { jobNumber: 1042, customer: { id: "c1", name: "Nina Patel", phone: null } });
    let now = new Date("2026-10-05T15:00:00Z");
    const clock = () => now;

    const first = phone(storage, server, clock);
    await first.engine.run({ force: true });
    server.offline = true;

    const expense = checkExpenseDraft({ amount: "42.50", spentOn: "2026-10-05", description: "Capacitor", jobId: "job-v1" }, "2026-10-05");
    if (!expense.ok) throw new Error(expense.reason);
    const expenseId = newId();
    await recordExpense(first, {
      expenseId, expense, jobNumber: 1042,
      receipt: { uploadId: newId(), localUri: "file://receipt.jpg", contentType: "image/jpeg", byteSize: 9, contentHash: sha256Base64(Buffer.from("a receipt").toString("base64")) },
    });

    // The app is killed. A new one opens on the same storage, still with no signal.
    const second = phone(storage, server, clock);
    expect((await second.engine.run({ force: true })).offline).toBe(true);
    let view = await second.engine.view();
    expect(view.day.expenses).toEqual([expect.objectContaining({
      id: expenseId, amount: "42.50", description: "Capacitor", jobNumber: 1042, status: "pending", receipts: 1, waiting: true,
    })]);
    // The expense, and the receipt's record the upload queue put in the operation queue.
    expect(view.waiting).toBe(2);
    // The receipt belongs to the expense and not to the visit: no visit counts it as a photo.
    expect(view.day.visits[0]!.photos).toEqual({ waiting: 0, sent: 0, failed: 0 });

    // The van finds a signal.
    server.offline = false;
    now = new Date("2026-10-05T16:00:00Z");
    const report = await second.engine.run({ force: true });
    expect(report.applied).toBe(2);
    expect(report.uploadsSent).toBe(1);
    view = await second.engine.view();
    expect(view.waiting).toBe(0);
    expect(view.day.expenses).toEqual([expect.objectContaining({ id: expenseId, status: "pending", receipts: 1, waiting: false })]);

    // The office refuses it, and the reason arrives with the next day.
    server.decide(expenseId, "refused", "That is a personal purchase.");
    await second.engine.run({ force: true });
    view = await second.engine.view();
    expect(view.day.expenses[0]).toMatchObject({ status: "refused", decisionReason: "That is a personal purchase." });
  });

  it("names the receipt's operation as the expense's and not a visit's, when it cannot be sent", () => {
    const op: QueuedOperation = {
      clientId: "op-1", sequence: 2, kind: "attachment.attach", subjectId: "x1", occurredAt: "2026-10-05T15:00:00Z",
      payload: { entityType: "expense", uploadId: "u1" }, status: "rejected", attempts: 1, lastError: "That receipt is for an expense that is not yours.",
    };
    const problem = describeOperation(op, () => "Nina Patel");
    expect(problem?.detail).toMatch(/^A receipt photo was not accepted/);
    expect(problem?.detail).not.toMatch(/Nina Patel/);
  });
});
