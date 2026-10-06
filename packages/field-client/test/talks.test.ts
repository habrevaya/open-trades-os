import { describe, it, expect } from "vitest";
import {
  FieldQueue, MemoryStorage, UploadQueue, projectDay, describeOperation, recordTalkSignature,
  type FieldSnapshot, type UploadFiles,
} from "../src/index";

/**
 * A toolbox talk signed on the phone: the signature kept first, as an upload
 * for the talk and not for any visit, then the signing naming it, both in the
 * queue in that order; and the day showing it signed while it waits.
 */

const files: UploadFiles = { async read() { return ""; }, async remove() { /* nothing kept here */ } };
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

const talk = {
  meetingId: "11111111-1111-4111-8111-111111111111", topic: "Ladder safety", notes: "Three points of contact.",
  heldAt: "2026-10-05T12:00:00.000Z", location: "The yard", ledBy: "Ray", signedAt: null, cannotSign: null,
};
const snapshot: FieldSnapshot = {
  revision: 1, unchanged: false, openTimeEntry: null, priceBook: [], visits: [], talks: [talk],
};

describe("signing a toolbox talk on the phone", () => {
  it("queues the signature for the talk, then the signing that names it", async () => {
    const storage = new MemoryStorage();
    const queue = new FieldQueue({ storage, deviceId: "device-1", newId });
    const uploads = new UploadQueue({ storage, queue, files });
    const signature = { uploadId: newId(), localUri: "file://sig.png", byteSize: 120, contentHash: "ab".repeat(32) };

    await recordTalkSignature({ queue, uploads }, { meetingId: talk.meetingId, topic: talk.topic, signature });

    const ops = await queue.pending();
    expect(ops.map((o) => o.kind)).toEqual(["signature.capture", "safety.sign"]);
    expect(ops[0]).toMatchObject({ subjectId: talk.meetingId, payload: { uploadId: signature.uploadId, for: "safety_meeting" } });
    expect(ops[1]).toMatchObject({ subjectId: talk.meetingId, payload: { signatureUploadId: signature.uploadId } });
    expect((await uploads.list())[0]).toMatchObject({ subject: "safety_meeting", kind: "signature" });

    const day = projectDay({ snapshot, operations: ops, uploads: await uploads.list() });
    expect(day.talks[0]).toMatchObject({ meetingId: talk.meetingId, signedHere: true, waiting: true });
    expect(day.visits).toEqual([]);
  });

  it("says what was refused in plain words, not as a job", () => {
    const problem = describeOperation({
      clientId: "x", sequence: 2, kind: "safety.sign", subjectId: talk.meetingId, occurredAt: talk.heldAt,
      payload: {}, status: "rejected", attempts: 1, lastError: "This sign in sheet has been closed, so nobody else can sign it.",
    });
    expect(problem?.title ?? "").not.toMatch(/job/);
    expect(problem?.detail).toMatch(/Signing a toolbox talk/);
  });
});
