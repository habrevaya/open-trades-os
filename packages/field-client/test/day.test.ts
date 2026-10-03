import { describe, it, expect } from "vitest";
import { field } from "@opentradesos/core";
import {
  projectDay, stageOf, nextStep, statusAfter, statusLabel, arrivalWindow, todayIn, mapsUrl, addressOf,
  describeOperation, describeUpload,
  type QueuedOperation, type FieldSnapshot, type UploadRecord,
} from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * What the day screen shows, worked out from what is on the phone.
 *
 * The screen itself is a list of these values. Everything that decides what
 * a technician sees, which button is offered, what a problem says, which
 * visit is first, is here and tested without a phone.
 */

let seq = 0;
const op = (over: Partial<QueuedOperation>): QueuedOperation => ({
  clientId: `op-${++seq}`, sequence: seq, kind: "visit.note", occurredAt: "2026-10-02T15:00:00.000Z",
  payload: {}, status: "pending", attempts: 0, ...over,
});

function snapshot(): FieldSnapshot {
  const server = new FakeServer();
  server.addVisit("v1", { routeOrder: 2, customer: { id: "c1", name: "Nina Patel", phone: null } });
  server.addVisit("v2", { routeOrder: 1, customer: { id: "c2", name: "Sam Ortiz", phone: null } });
  server.addVisit("v3", { routeOrder: null, windowStart: "2026-10-02T13:00:00Z" });
  return {
    revision: 1, unchanged: false, openTimeEntry: null, priceBook: [],
    visits: [...server.visits.values()],
  };
}

describe("where a visit is", () => {
  it("calls on the way with an arrival recorded 'arrived'", () => {
    expect(stageOf("en_route", null)).toBe("en_route");
    expect(stageOf("en_route", "2026-10-02T15:00:00Z")).toBe("arrived");
    expect(stageOf("dispatched", null)).toBe("upcoming");
    expect(stageOf("cancelled", null)).toBe("closed");
    expect(statusLabel("no_show", "closed")).toBe("No show");
  });

  it("offers on my way, arrived, start and finish, in that order, and nothing after", () => {
    expect(nextStep("upcoming")?.kind).toBe("visit.en_route");
    expect(nextStep("en_route")?.kind).toBe("visit.arrive");
    expect(nextStep("arrived")?.kind).toBe("visit.start");
    expect(nextStep("working")).toMatchObject({ kind: "visit.complete", confirm: expect.any(String) });
    expect(nextStep("completed")).toBeNull();
    expect(nextStep("closed")).toBeNull();
  });

  it("offers each step only from a state core accepts it from", () => {
    /**
     * Every step is a `fact`, so the server never refuses one, but offering a
     * step from a state core does not list would raise a conflict on every
     * tap. Held against core's own table so the two cannot drift.
     */
    const from: Record<string, string> = {
      upcoming: "dispatched", en_route: "en_route", arrived: "en_route", working: "working",
    };
    for (const [stage, status] of Object.entries(from)) {
      const step = nextStep(stage as Parameters<typeof nextStep>[0])!;
      expect(field.VISIT_TRANSITIONS[step.kind], `${step.kind} from ${status}`).toContain(status);
    }
  });

  it("moves a visit exactly as core does, for every operation and every state", () => {
    for (const kind of field.OPERATION_KINDS) {
      for (const state of field.VISIT_STATES) {
        expect(statusAfter(kind, state), `${kind} from ${state}`).toBe(field.stateAfter(kind, state));
      }
    }
  });
});

describe("the day on the phone", () => {
  it("puts the visits in route order, unplaced ones last", () => {
    const day = projectDay({ snapshot: snapshot(), operations: [] });
    expect(day.visits.map((v) => v.id)).toEqual(["v2", "v1", "v3"]);
  });

  it("shows what the technician did before it has been sent", () => {
    const day = projectDay({
      snapshot: snapshot(),
      operations: [
        op({ kind: "visit.en_route", subjectId: "v1" }),
        op({ kind: "visit.arrive", subjectId: "v1", occurredAt: "2026-10-02T15:10:00.000Z" }),
        op({ kind: "visit.note", subjectId: "v1", payload: { text: "Dog is friendly" } }),
      ],
    });
    const v1 = day.visits.find((v) => v.id === "v1")!;
    expect(v1.stage).toBe("arrived");
    expect(v1.arrivedAt).toBe("2026-10-02T15:10:00.000Z");
    expect(v1.newNotes).toEqual([{ text: "Dog is friendly", waiting: true }]);
    expect(v1.waiting).toBe(3);
  });

  it("does not pretend a refused operation happened", () => {
    const day = projectDay({
      snapshot: snapshot(),
      operations: [op({ kind: "visit.start", subjectId: "v1", status: "rejected" })],
    });
    expect(day.visits.find((v) => v.id === "v1")!.stage).toBe("upcoming");
  });

  it("keeps something the server applied on screen until the next fetch, without calling it waiting", () => {
    const day = projectDay({
      snapshot: snapshot(),
      operations: [],
      applied: [op({ kind: "visit.start", subjectId: "v2" })],
    });
    const v2 = day.visits.find((v) => v.id === "v2")!;
    expect(v2.stage).toBe("working");
    expect(v2.waiting).toBe(0);
  });

  it("runs the clock from the punches on the phone", () => {
    let day = projectDay({ snapshot: snapshot(), operations: [op({ kind: "timeclock.punch_in" })] });
    expect(day.clock).toEqual({ open: true, since: "2026-10-02T15:00:00.000Z", waiting: true });

    day = projectDay({
      snapshot: { ...snapshot(), openTimeEntry: { id: "t", kind: "on_site", startedAt: "2026-10-02T12:00:00Z" } },
      operations: [op({ kind: "timeclock.punch_out" })],
    });
    expect(day.clock.open).toBe(false);
  });

  it("counts photos and notices a signature", () => {
    const upload = (over: Partial<UploadRecord>): UploadRecord => ({
      uploadId: `u${++seq}`, visitId: "v1", kind: "photo", contentType: "image/jpeg", byteSize: 1,
      contentHash: "x", localUri: "file:///x", createdAt: "2026-10-02T15:00:00Z", queued: true,
      status: "waiting", attempts: 0, ...over,
    });
    const day = projectDay({
      snapshot: snapshot(),
      operations: [],
      uploads: [upload({}), upload({ status: "sent" }), upload({ kind: "signature" })],
    });
    const v1 = day.visits.find((v) => v.id === "v1")!;
    expect(v1.photos).toEqual({ waiting: 1, sent: 1, failed: 0 });
    expect(v1.signed).toBe(true);
  });

  it("opens with nothing at all on a phone that has never synced", () => {
    expect(projectDay({ snapshot: null, operations: [] }).visits).toEqual([]);
  });
});

describe("times and places", () => {
  it("shows the window in the company's zone, not the phone's", () => {
    expect(arrivalWindow("2026-10-02T14:00:00Z", "2026-10-02T16:00:00Z", "America/Chicago"))
      .toBe("9:00 AM to 11:00 AM");
    expect(arrivalWindow("2026-10-02T14:00:00Z", null, "America/Denver")).toBe("8:00 AM");
    expect(arrivalWindow(null, null, "America/Chicago")).toBeNull();
  });

  it("knows what today is in the company's zone", () => {
    // Half past midnight in UTC is still the evening before in Austin.
    expect(todayIn("America/Chicago", new Date("2026-10-03T00:30:00Z"))).toBe("2026-10-02");
  });

  it("opens directions in the phone's own maps app", () => {
    const address = addressOf(snapshot().visits[0]!);
    expect(address).toBe("88 Ridge Rd, Austin, TX 78704");
    expect(mapsUrl(address, "ios")).toBe("http://maps.apple.com/?daddr=88%20Ridge%20Rd%2C%20Austin%2C%20TX%2078704");
    expect(mapsUrl(address, "android")).toBe("geo:0,0?q=88%20Ridge%20Rd%2C%20Austin%2C%20TX%2078704");
  });
});

describe("problems, in plain words", () => {
  const names = (id: string) => (id === "v1" ? "Nina Patel" : undefined);

  it("tells a technician a conflict is on the record and nothing is needed of them", () => {
    const problem = describeOperation(op({
      kind: "visit.arrive", subjectId: "v1", status: "conflicted",
      conflict: "Recorded visit.arrive, but the visit was cancelled by the time it reached us. Somebody needs to look at this.",
    }), names)!;
    expect(problem.action).toBe("acknowledge");
    expect(problem.detail).toBe(
      "You arrived at Nina Patel's job is on the record, but the office had cancelled it before it reached them. Nothing for you to do: somebody in the office will sort it out.",
    );
    expect(problem.detail).not.toMatch(/visit\.arrive/);
  });

  it("says a refusal was not recorded, and translates the state machine", () => {
    const problem = describeOperation(op({
      kind: "service_report.submit", subjectId: "v1", status: "rejected",
      lastError: "Cannot service_report.submit from submitted",
    }), names)!;
    expect(problem.title).toBe("Not recorded");
    expect(problem.detail).toMatch(/The office had already received it\.$/);
    expect(problem.action).toBe("retry_or_discard");
  });

  it("keeps the server's own sentence when it already is one", () => {
    const problem = describeOperation(op({
      kind: "timeclock.punch_in", status: "rejected",
      lastError: "This device is not registered to a technician, so there is nobody to clock in or out.",
    }))!;
    expect(problem.detail).toBe(
      "Clocking in was not accepted. This device is not registered to a technician, so there is nobody to clock in or out.",
    );
  });

  it("says when something has stopped trying, and that it is still on the phone", () => {
    const problem = describeOperation(op({ attempts: 5, lastError: "Internal error", subjectId: "v1" }), names)!;
    expect(problem.title).toBe("Could not send");
    expect(problem.detail).toMatch(/still on this phone/);
  });

  it("says nothing about an operation that is just waiting", () => {
    expect(describeOperation(op({ attempts: 2 }))).toBeNull();
  });

  it("names a photo that could not be sent", () => {
    const problem = describeUpload({
      uploadId: "u1", visitId: "v1", kind: "photo", contentType: "image/jpeg", byteSize: 1,
      contentHash: "x", localUri: "file:///x", createdAt: "", queued: true, status: "failed",
      attempts: 1, lastError: "The file is no longer on the phone, so it cannot be sent.",
    }, names)!;
    expect(problem.detail).toBe(
      "A photo for Nina Patel's job could not be sent. The file is no longer on the phone, so it cannot be sent.",
    );
  });
});
