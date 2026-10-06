import type { QueuedOperation } from "./queue";
import { visitOf } from "./day";
import type { UploadRecord } from "./uploads";

/**
 * WHAT WENT WRONG, IN WORDS FOR THE PERSON IN THE DRIVEWAY
 *
 * The server's conflict text is written for the office ("Recorded
 * visit.arrive, but the visit was cancelled by the time it reached us"), and
 * an operation kind is not something a technician should ever read. This
 * turns each problem into a sentence about what they did, what happened, and
 * what, if anything, they should do about it.
 *
 * The three outcomes ask different things of them, so they say different
 * things:
 *
 *   Recorded with a conflict   Nothing to do. It happened, it is on the
 *                              record, and the office has been told. "Got it".
 *   Refused                    It is NOT on the record. Try again, or let it go.
 *   Could not be sent          Nothing has judged it. Try again.
 */

export type ProblemAction = "acknowledge" | "retry_or_discard" | "retry";

export interface Problem {
  /** The operation's client id, or the upload's id for a file. */
  id: string;
  source: "operation" | "upload";
  title: string;
  detail: string;
  action: ProblemAction;
  visitId?: string | undefined;
}

const DID: Record<string, string> = {
  "visit.en_route": "You set off for",
  "visit.arrive": "You arrived at",
  "visit.start": "You started work at",
  "visit.pause": "You paused work at",
  "visit.complete": "You finished",
  "visit.note": "Your note on",
  "visit.checklist_item": "A checklist tick on",
  "visit.add_line": "A part or charge on",
  "attachment.attach": "A photo for",
  "signature.capture": "A signature for",
  "service_report.set_field": "A reading on the report for",
  "service_report.submit": "Sending the report for",
  "equipment.record": "Equipment recorded at",
  "timeclock.punch_in": "Clocking in",
  "timeclock.punch_out": "Clocking out",
  "payment.collect": "A payment taken at",
  "inspection.record": "An inspection at",
  "estimate.create": "The estimate you built for",
  "estimate.approve": "The customer's signature on the estimate for",
  "estimate.decline": "The customer saying no to the estimate for",
  "invoice.raise": "The invoice you raised for",
  "task.claim": "Taking a task",
  "task.close": "Finishing a task",
  "tip.record": "A cash tip at",
  "safety.sign": "Signing a toolbox talk",
};

/**
 * The state words the server's conflict sentence names, said the way a
 * technician would hear them.
 */
const STATE: Record<string, string> = {
  cancelled: "had cancelled it",
  completed: "had already marked it done",
  no_show: "had marked it a no show",
  completed_after_cancellation: "had cancelled it",
  unassigned: "had taken it off your day",
  scheduled: "had moved it back to scheduled",
  working: "already had it marked as being worked on",
  en_route: "already had it marked as on the way",
  dispatched: "had changed it",
  draft: "had not received it yet",
  submitted: "had already received it",
  published: "had already sent it to the customer",
};

/** "You arrived at Nina Patel's" or "Clocking in", depending on the kind. */
function whatYouDid(op: QueuedOperation, name: string | undefined): string {
  if (op.kind === "signature.capture" && op.payload["for"] === "safety_meeting") return "Your signature on a toolbox talk";
  const lead = DID[op.kind] ?? "Something you recorded";
  if (op.kind === "timeclock.punch_in" || op.kind === "timeclock.punch_out"
    || op.kind === "task.claim" || op.kind === "task.close" || op.kind === "safety.sign") return lead;
  return `${lead} ${name ? `${name}'s job` : "a job"}`;
}

export function describeOperation(
  op: QueuedOperation,
  nameOf: (visitId: string) => string | undefined = () => undefined,
  maxAttempts = 5,
): Problem | null {
  const visitId = visitOf(op);
  const name = visitId ? nameOf(visitId) : undefined;
  const did = whatYouDid(op, name);
  const base = { id: op.clientId, source: "operation" as const, visitId };

  if (op.status === "conflicted") {
    /**
     * The office's own sentence when it is already one for the person on
     * site: an invoice kept as a draft says what the customer was shown and
     * what the prices make it.
     */
    if (op.kind === "invoice.raise" && op.conflict) {
      return {
        ...base,
        title: "Recorded, and the office has been told",
        detail: `${did} is with the office. ${op.conflict} Nothing for you to do.`,
        action: "acknowledge",
      };
    }
    /**
     * A unit whose serial is on file somewhere else is not added: it may be
     * the same unit, moved here, and only a person can say. Not "on the
     * record", because it is not on the register until the office answers.
     */
    if (op.kind === "equipment.record") {
      return {
        ...base,
        title: "Held for the office",
        detail: `${did} was not added yet: that serial is already on file at another address, or was taken off a register. `
          + "The office will decide whether it is the same unit, moved here. Nothing for you to do.",
        action: "acknowledge",
      };
    }
    const state = /was (\w+) by the time/.exec(op.conflict ?? "")?.[1];
    const why = state && STATE[state]
      ? `the office ${STATE[state]} before it reached them`
      : "the office had changed the job before it reached them";
    return {
      ...base,
      title: "Recorded, and the office has been told",
      detail: `${did} is on the record, but ${why}. Nothing for you to do: somebody in the office will sort it out.`,
      action: "acknowledge",
    };
  }

  if (op.status === "rejected") {
    return {
      ...base,
      title: "Not recorded",
      detail: `${did} was not accepted. ${refusal(op.lastError)}`,
      action: "retry_or_discard",
    };
  }

  if (op.attempts >= maxAttempts) {
    return {
      ...base,
      title: "Could not send",
      detail: `${did} has not reached the office after several tries${op.lastError ? `: ${op.lastError}` : "."} It is still on this phone.`,
      action: "retry",
    };
  }

  return null;
}

/**
 * The server's refusal, kept when it is already a sentence and translated
 * when it is the state machine talking.
 */
function refusal(text: string | undefined): string {
  if (!text) return "The office's system did not say why. Ask the office.";
  const transition = /^Cannot (\S+) from (\w+)$/.exec(text);
  if (transition) {
    const state = STATE[transition[2]!];
    return state ? `The office ${state}.` : "The job had moved on before it arrived.";
  }
  return text.endsWith(".") ? text : `${text}.`;
}

export function describeUpload(
  upload: UploadRecord,
  nameOf: (visitId: string) => string | undefined = () => undefined,
): Problem | null {
  if (upload.status !== "failed") return null;
  const name = nameOf(upload.visitId);
  const what = upload.kind === "signature" ? "A signature" : "A photo";
  return {
    id: upload.uploadId,
    source: "upload",
    visitId: upload.visitId,
    title: upload.kind === "signature" ? "Signature not sent" : "Photo not sent",
    detail: `${what} for ${name ? `${name}'s job` : "a job"} could not be sent. ${upload.lastError ?? ""}`.trim(),
    action: "acknowledge",
  };
}
