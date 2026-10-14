import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { Destination } from "./phone-menus";

/**
 * WAITING LINES, THE BROWSER PHONE AND THE PHONE ASSISTANT'S CALLS
 *
 * Three ways the company's number answers beyond ringing somebody: holding a
 * caller in a line with music until a person in a ring group is free, ringing
 * a person's browser instead of their phone (and letting them place calls
 * from it), and the phone assistant answering the call itself. The carrier's
 * side of each is at `/api/webhooks/voice/{token}` with the rest of a call,
 * and the assistant's conversation is held by the voice relay; these are the
 * settings, the browser's pass, and what the assistant did on a call.
 */

const QueueInput = {
  name: z.string().min(1).max(80),
  ringGroupId: Uuid,
  maxWaitSeconds: z.number().int().min(30).max(1800).optional(),
  announcePosition: z.boolean().optional(),
  holdMusicUrl: z.string().max(500).nullable().optional(),
  overflowTo: Destination,
  /** Offer a caller, by pressing 1, to be called back instead of waiting, keeping their place. Off unless set. */
  offerCallback: z.boolean().optional(),
  /** Tell a caller how long callers have lately waited, when enough were answered to say. Off unless set. */
  announceWait: z.boolean().optional(),
};

const Queue = z.object({
  id: Uuid,
  name: z.string(),
  ringGroupId: Uuid,
  ringGroupName: z.string().nullable(),
  maxWaitSeconds: z.number().int(),
  announcePosition: z.boolean(),
  /** Null plays the carrier's own hold music. */
  holdMusicUrl: z.string().nullable(),
  overflowTo: Destination,
  offerCallback: z.boolean(),
  announceWait: z.boolean(),
});

export const listCallQueues = defineRoute({
  method: "get",
  path: "/v1/call-queues",
  summary: "The company's waiting lines",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ queues: z.array(Queue) }),
});

export const createCallQueue = defineRoute({
  method: "post",
  path: "/v1/call-queues",
  summary: "Make a waiting line",
  description:
    "A caller sent to a waiting line hears hold music and, when announcePosition is on, their place in line each time the music comes round. The people in ringGroupId are rung (all at once, or one after another round by round, as the group says, and in the browser for anybody taking calls there) until one answers and is put through to the caller at the front. After maxWaitSeconds the caller goes to overflowTo, usually voicemail. The wait is checked each time the music finishes, so a long track lets a caller wait longer than the setting. Somebody the company knows to be on another call is left out of each round. With offerCallback, a caller may press 1 to be called back instead, keeping their place: the next person free is rung first, then the caller from the company's number; a caller not reached twice, or not called back within an hour, becomes a task for the office. With announceWait, a caller is told on joining how long callers have lately waited, from the last answered callers in the line, and nothing when fewer than five were answered in the last three hours.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object(QueueInput),
  output: Queue,
});

export const updateCallQueue = defineRoute({
  method: "put",
  path: "/v1/call-queues/{id}",
  summary: "Change a waiting line",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid, ...QueueInput }),
  output: Queue,
});

export const deleteCallQueue = defineRoute({
  method: "delete",
  path: "/v1/call-queues/{id}",
  summary: "Delete a waiting line",
  description: "Refused while a menu, a ring group or another line still sends callers to it, naming which.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, deleted: z.literal(true) }),
});

const SoftphoneStatus = z.object({
  ready: z.boolean(),
  /** Why it is not ready, in words, when it is not. */
  reason: z.string().nullable(),
  /** The company number calls from the browser show. */
  callerId: z.string().nullable(),
  takingCalls: z.boolean(),
});

export const getSoftphone = defineRoute({
  method: "get",
  path: "/v1/softphone",
  summary: "Whether you can use the browser phone",
  module: "M18",
  permissions: ["call:place"],
  input: z.object({}),
  output: SoftphoneStatus,
});

export const setUpSoftphone = defineRoute({
  method: "put",
  path: "/v1/softphone",
  summary: "Set up calling from the browser",
  description:
    "Takes an API key made in the Twilio console (its SID, and the NAME of the secret in this installation's secret store that holds its secret, never the secret) and the company number calls are shown from, which must be one answered here. Creates, or points again, the application on the company's own Twilio account that browser calls are placed through.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({
    apiKeySid: z.string().min(1).max(64),
    apiKeySecretRef: z.string().min(1).max(64),
    callerIdNumberId: Uuid,
  }),
  output: z.object({ ready: z.literal(true), applicationSid: z.string(), callerId: z.string() }),
});

export const mintSoftphoneToken = defineRoute({
  method: "post",
  path: "/v1/softphone/token",
  summary: "A pass for your browser to make and take calls, good for an hour",
  description:
    "For the person asking only. The carrier's browser library registers with it and places calls through the company's application; every call it places is checked again when it is made, so a person who has lost the permission since cannot use a pass they still hold.",
  module: "M18",
  permissions: ["call:place"],
  input: z.object({}),
  output: z.object({ token: z.string(), identity: z.string(), expiresAt: z.string() }),
});

export const setSoftphonePresence = defineRoute({
  method: "put",
  path: "/v1/softphone/presence",
  summary: "Take calls in this browser, or stop",
  description:
    "Sent once a minute by the office app while \"Take calls here\" is on. A ring group rings a person's browser instead of their phone while their last word was on and is under two and a half minutes old.",
  module: "M18",
  permissions: ["call:place"],
  input: z.object({ available: z.boolean() }),
  output: z.object({ takingCalls: z.boolean() }),
});

/* ----------------------------------------- hold and passing a call on */

const CurrentCall = z.object({
  id: Uuid,
  /** The caller's number. */
  from: z.string(),
  customerId: Uuid.nullable(),
  customerName: z.string().nullable(),
  state: z.enum(["talking", "holding", "consulting", "handing_over"]),
  /** The open hold or pass, when there is one. */
  transferId: Uuid.nullable(),
  /** The colleague being talked to first on a warm pass, by name. */
  consultWith: z.string().nullable(),
  consultAnswered: z.boolean(),
});

export const getSoftphoneCall = defineRoute({
  method: "get",
  path: "/v1/softphone/call",
  summary: "The call you have now",
  description:
    "A call that came in and that you picked up, or that was passed to you, while it lasts: whether you are talking, have the caller on hold, or are talking to a colleague first. Null when you have none.",
  module: "M18",
  permissions: ["call:place"],
  input: z.object({}),
  output: z.object({ call: CurrentCall.nullable() }),
});

export const listTransferTargets = defineRoute({
  method: "get",
  path: "/v1/softphone/transfer-targets",
  summary: "Who and where a caller can be passed to",
  description:
    "Colleagues who can be rung (a number to ring them on, or taking calls in the browser), and the ring groups and waiting lines, by name only.",
  module: "M18",
  permissions: ["call:place"],
  input: z.object({}),
  output: z.object({
    people: z.array(z.object({ userId: Uuid, name: z.string(), takingCalls: z.boolean() })),
    ringGroups: z.array(z.object({ id: Uuid, name: z.string() })),
    queues: z.array(z.object({ id: Uuid, name: z.string() })),
  }),
});

export const holdCall = defineRoute({
  method: "post",
  path: "/v1/calls/{id}/hold",
  summary: "Put the caller on hold",
  description:
    "Only for the person who has the caller now, on a call that came in. The caller's leg is moved to a queue of its own with music, which ends the browser's call to them; ringing hold:{id} from the browser phone takes them back. Asking again while they are on hold answers with the same hold. A caller left on hold fifteen minutes goes to voicemail and the office gets a task to call them.",
  module: "M18",
  permissions: ["call:place"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, state: z.literal("holding") }),
});

export const transferCall = defineRoute({
  method: "post",
  path: "/v1/calls/{id}/transfer",
  summary: "Pass the caller to a colleague, a ring group or a waiting line",
  description:
    "Only for the person who has the caller now. Cold (warm false): the caller is moved where a menu option would send them, at once; a colleague is rung in the browser when they are taking calls there, and on their phone otherwise, and a caller nobody picks up goes to voicemail. Warm, to a colleague only: the caller is put on hold and consult names the address the browser phone rings to talk to the colleague first (transfer:{id}); complete hands the caller over, cancel keeps them on hold.",
  module: "M18",
  permissions: ["call:place"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    to: z.union([
      z.object({ kind: z.literal("person"), userId: Uuid }),
      z.object({ kind: z.literal("ring_group"), id: Uuid }),
      z.object({ kind: z.literal("queue"), id: Uuid }),
    ]),
    warm: z.boolean().optional(),
  }),
  output: z.object({ id: Uuid, state: z.enum(["sent", "consulting"]), consult: z.string().nullable() }),
});

export const completeCallTransfer = defineRoute({
  method: "post",
  path: "/v1/call-transfers/{id}/complete",
  summary: "Hand the caller over to the colleague you are talking to",
  description:
    "For a warm pass, once the colleague has picked up: their call is joined to the caller on hold, which ends yours. Refused until they have picked up. Asking again answers with the same hand over.",
  module: "M18",
  permissions: ["call:place"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, state: z.literal("handing_over") }),
});

export const cancelCallTransfer = defineRoute({
  method: "post",
  path: "/v1/call-transfers/{id}/cancel",
  summary: "Do not pass the caller on after all",
  description: "Ends the call to the colleague, and keeps the caller on hold for you to take back.",
  module: "M18",
  permissions: ["call:place"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, state: z.literal("holding") }),
});

const Turn = z.object({ from: z.enum(["caller", "assistant"]), text: z.string(), at: z.string() });

export const getCallAssistant = defineRoute({
  method: "get",
  path: "/v1/calls/{id}/assistant",
  summary: "What the phone assistant heard, said and did on a call",
  description:
    "Everything said, in order, with card numbers and security codes the caller read out already removed, and one sentence for each thing it did: a booking request taken, a message taken, the caller put through and why. Not found for a call the assistant did not answer.",
  module: "M27",
  permissions: ["message:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    status: z.enum(["waiting", "talking", "transferred", "ended", "dropped"]),
    turns: z.array(Turn),
    actions: z.array(z.object({ action: z.string(), detail: z.string(), at: z.string() })),
    transferReason: z.string().nullable(),
    bookingRequestId: Uuid.nullable(),
    messageTaken: z.boolean(),
    redactions: z.record(z.number()),
    connectedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  }),
});

export const callHandlingRoutes = {
  listCallQueues, createCallQueue, updateCallQueue, deleteCallQueue,
  getSoftphone, setUpSoftphone, mintSoftphoneToken, setSoftphonePresence,
  getSoftphoneCall, listTransferTargets, holdCall, transferCall, completeCallTransfer, cancelCallTransfer,
  getCallAssistant,
} as const;
