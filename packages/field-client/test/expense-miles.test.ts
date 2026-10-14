import { describe, it, expect } from "vitest";
import {
  FieldQueue, MemoryStorage, SyncEngine, UploadQueue, checkExpenseDraft, expenseFigure, recordExpense, type UploadFiles,
} from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * A CLAIM IN MILES, ON THE PHONE
 *
 * The phone sends the miles and nothing else about the money: the server works them out at the
 * company's rate on the day of the drive, because the phone may not know the rate and must not
 * guess at it. Until the server has the claim the phone says the miles, not a made up amount.
 */
const today = "2026-10-05";
const draft = { amount: "", miles: "18.4", spentOn: "2026-10-04", description: " Drive to the supply house ", jobId: null };

describe("checking miles before they are kept", () => {
  it("keeps the miles to a tenth and no amount", () => {
    expect(checkExpenseDraft(draft, today)).toEqual({
      ok: true, miles: "18.4", spentOn: "2026-10-04", description: "Drive to the supply house", jobId: null,
    });
    expect(checkExpenseDraft({ ...draft, miles: "18" }, today)).toMatchObject({ ok: true, miles: "18.0" });
    expect(checkExpenseDraft({ ...draft, miles: " 0.5 " }, today)).toMatchObject({ ok: true, miles: "0.5" });
  });

  it("is one or the other: miles and an amount together are refused", () => {
    expect(checkExpenseDraft({ ...draft, amount: "9.00" }, today)).toEqual({
      ok: false, reason: "Fill in the miles you drove or what you paid, not both.",
    });
  });

  it("says what is wrong in words", () => {
    const refused = (over: object) => {
      const r = checkExpenseDraft({ ...draft, ...over }, today);
      return r.ok ? null : r.reason;
    };
    expect(refused({ miles: "about 20" })).toMatch(/to a tenth/);
    expect(refused({ miles: "18.45" })).toMatch(/to a tenth/);
    expect(refused({ miles: "-4" })).toMatch(/to a tenth/);
    expect(refused({ miles: "0" })).toMatch(/more than nothing/);
    expect(refused({ miles: "2000.1" })).toMatch(/more than 2000 miles/);
    expect(checkExpenseDraft({ ...draft, miles: "2000" }, today).ok).toBe(true);
    expect(refused({ spentOn: "2026-10-06" })).toMatch(/not happened/);
    expect(refused({ spentOn: "Tuesday" })).toBe("Say the day you drove.");
    expect(refused({ description: " " })).toMatch(/what it was for/);
  });

  it("leaves an amount claim as it was, and an empty miles box is not a claim in miles", () => {
    expect(checkExpenseDraft({ amount: "$42.50", miles: "", spentOn: "2026-10-04", description: "Capacitor", jobId: null }, today))
      .toEqual({ ok: true, amount: "42.50", spentOn: "2026-10-04", description: "Capacitor", jobId: null });
  });
});

describe("how a claim reads on the screen", () => {
  it("is the amount for money paid, the miles while the server has not worked it out, and both after", () => {
    expect(expenseFigure({ amount: "42.50" })).toBe("$42.50");
    expect(expenseFigure({ amount: "", miles: "18.4" })).toBe("18.4 miles");
    expect(expenseFigure({ amount: "13.3400", miles: "18.4", mileageRate: "0.725" })).toBe("$13.34 (18.4 miles at $0.725 a mile)");
    expect(expenseFigure({ amount: "13.34", miles: null, mileageRate: null })).toBe("$13.34");
  });
});

describe("kept with no signal and sent", () => {
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const files: UploadFiles = { async read() { return ""; }, async remove() {} };

  it("goes in the queue as miles, shows as miles while waiting, and arrives worked out", async () => {
    const storage = new MemoryStorage();
    const server = new FakeServer();
    server.addVisit("v1", { jobNumber: 1042, customer: { id: "c1", name: "Nina Patel", phone: null } });
    const now = new Date("2026-10-05T15:00:00Z");
    const queue = new FieldQueue({ storage, deviceId: "device-1", newId, now: () => now, random: () => 1 });
    const uploads = new UploadQueue({ storage, queue, files, now: () => now });
    const engine = new SyncEngine({
      queue, uploads, storage, transport: server.transport(), uploadTransport: server.uploads(),
      snapshot: (input) => server.snapshot(input), timezone: "America/Chicago", now: () => now,
    });
    await engine.run({ force: true });
    server.offline = true;

    const claim = checkExpenseDraft({ ...draft, spentOn: "2026-10-05" }, "2026-10-05");
    if (!claim.ok) throw new Error(claim.reason);
    const expenseId = newId();
    await recordExpense({ queue, uploads }, { expenseId, expense: claim });

    const [op] = await queue.pending();
    expect(op).toMatchObject({ kind: "expense.record", subjectId: expenseId });
    /** Miles and no amount: nothing the phone worked out is ever sent. */
    expect(op!.payload).toEqual({ miles: "18.4", spentOn: "2026-10-05", description: "Drive to the supply house" });

    const view = await engine.view();
    expect(view.day.expenses).toEqual([expect.objectContaining({ id: expenseId, amount: "", miles: "18.4", waiting: true })]);
    expect(expenseFigure(view.day.expenses[0]!)).toBe("18.4 miles");
  });
});
