import type { FieldQueue } from "./queue";
import type { UploadQueue } from "./uploads";
import type { KeptSignature } from "./sale";

/**
 * SIGNING A TOOLBOX TALK ON THE PHONE
 *
 * The same two halves as a customer's signature on an estimate: the drawn
 * signature is kept on the phone and recorded first, as an upload for the
 * talk, then the operation that signs names it. Both go through the queue,
 * so a talk signed in a basement with no signal is signed when the phone
 * next has one, in order. The server finds the line from the phone's own
 * technician and refuses, in words, a sheet closed meanwhile or a talk not
 * held yet; a refused signature is attached to nothing.
 */
export async function recordTalkSignature(
  phone: { queue: FieldQueue; uploads: UploadQueue },
  input: { meetingId: string; topic: string; signature: KeptSignature; at?: Date | undefined },
) {
  const at = input.at ?? new Date();
  await phone.uploads.add({
    uploadId: input.signature.uploadId, visitId: input.meetingId, subject: "safety_meeting", kind: "signature",
    contentType: "image/png", localUri: input.signature.localUri, byteSize: input.signature.byteSize,
    contentHash: input.signature.contentHash, caption: `Signed for ${input.topic.trim()}`.slice(0, 200), occurredAt: at,
  });
  return phone.queue.enqueue({
    kind: "safety.sign", subjectId: input.meetingId, occurredAt: at,
    payload: { signatureUploadId: input.signature.uploadId },
  });
}
