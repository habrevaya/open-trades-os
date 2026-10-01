import { describe, it, expect } from "vitest";
import { punchNotice, type QueuedPunch } from "../src/lib/punch-notice";

const punch = (over: Partial<QueuedPunch>): QueuedPunch => ({
  kind: "timeclock.punch_in", sequence: 7, status: "pending", attempts: 0, ...over,
});

describe("what the clock says when a punch did not take", () => {
  it("says nothing once the punch has landed and left the queue", () => {
    expect(punchNotice([], 7, null)).toBeNull();
  });

  it("gives the server's reason for a punch it rejected", () => {
    expect(punchNotice([punch({ status: "rejected", lastError: "This device is not registered to a technician." })], 7, null))
      .toBe("Not clocked in: This device is not registered to a technician.");
  });

  it("gives the reason straight away when the server refused the whole send, not after five tries", () => {
    expect(punchNotice([punch({ kind: "timeclock.punch_out", attempts: 1 })], 7, "This device has been revoked."))
      .toBe("Not clocked out yet: This device has been revoked.");
  });

  it("says nothing while it is only waiting for signal", () => {
    expect(punchNotice([punch({ attempts: 2, lastError: "Failed to fetch" })], 7, null)).toBeNull();
  });

  it("speaks only for the punch pressed on this screen", () => {
    expect(punchNotice([punch({ sequence: 3, status: "rejected", lastError: "old" })], 7, null)).toBeNull();
    expect(punchNotice([punch({ status: "rejected", lastError: "old" })], null, null)).toBeNull();
  });
});
