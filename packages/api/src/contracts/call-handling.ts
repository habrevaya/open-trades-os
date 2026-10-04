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
    "A caller sent to a waiting line hears hold music and, when announcePosition is on, their place in line each time the music comes round. The people in ringGroupId are rung (all at once, or one after another round by round, as the group says, and in the browser for anybody taking calls there) until one answers and is put through to the caller at the front. After maxWaitSeconds the caller goes to overflowTo, usually voicemail. The wait is checked each time the music finishes, so a long track lets a caller wait longer than the setting.",
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
  getCallAssistant,
} as const;
