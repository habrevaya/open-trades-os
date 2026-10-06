import { z } from "zod";
import { defineRoute } from "../lib/define";
import { PageRequest, Uuid, pageOf } from "./common";

/**
 * OUTBOUND WEBHOOKS
 *
 * The event log has been ordered and durable since the first migration and
 * the only way to read it was to be this codebase. These routes are the
 * other end of that: a company registers a URL, names the events it cares
 * about, and their own system hears about a job being completed without
 * anybody polling for it.
 *
 * A SECRET IS RETURNED ONCE, when it is made: by `registerWebhookEndpoint`
 * and by `rotateWebhookSecret`, and nowhere else. There is no route below that
 * reads one back, and that is deliberate rather than an omission: a secret a
 * list endpoint will hand over on request is a secret that leaks through every
 * screen, log and support transcript that ever shows an endpoint. An operator
 * who loses it rotates, which is the same thing they would do if it leaked.
 *
 * THE EVENT NAMES ARE NOT FREE TEXT. `listWebhookEvents` is the list, and
 * registering a name outside it is refused rather than stored. A
 * subscription that matches nothing is indistinguishable from a quiet week:
 * the receiver was built, tested by hand, deployed, and will never be
 * called, and nothing anywhere would have said so.
 */

export const WebhookEndpoint = z.object({
  id: Uuid,
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  /** Consecutive failures. A delivery that succeeds resets it to zero. */
  failureCount: z.number().int(),
  /**
   * The last time a delivery was ATTEMPTED, successful or not.
   *
   * Beside a failure count it is the difference between "failing right now"
   * and "has not been tried since Tuesday", which a success-only stamp
   * cannot tell you.
   */
  lastDeliveryAt: z.string().nullable(),
  /** When the current signing secret was made, by registration or by rotation. */
  secretRotatedAt: z.string().nullable(),
  /**
   * Until when the secret before the last rotation also signs, or null when
   * only the current one does. During that time the signature header carries
   * two signatures separated by a comma.
   */
  previousSecretExpiresAt: z.string().nullable(),
  createdAt: z.string(),
});

const Url = z.string().url().max(2000);
const EventNames = z.array(z.string().min(1).max(100)).min(1).max(100);

export const registerWebhookEndpoint = defineRoute({
  method: "post",
  path: "/v1/webhooks/endpoints",
  summary: "Send these events to this URL",
  description:
    "Returns the signing secret, once. Nothing reads it back afterwards, so store it when this call returns or register a replacement endpoint. Refused when an event name is one nothing in this product emits, because a subscription that matches nothing looks exactly like a quiet week.",
  module: "M26",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    url: Url,
    events: EventNames,
    /**
     * Defaults to on. An endpoint that arrives switched off is an
     * integration that silently does not start, and the receiver was built
     * before this row existed.
     */
    active: z.boolean().optional(),
  }),
  output: WebhookEndpoint.extend({
    /** Shown once. Every delivery to this endpoint is signed with it. */
    secret: z.string(),
  }),
});

export const listWebhookEndpoints = defineRoute({
  method: "get",
  path: "/v1/webhooks/endpoints",
  summary: "Every endpoint this company has registered",
  description:
    "Carries the failure count and the last attempt, so a dead endpoint and a new one do not look the same. Carries no secret.",
  module: "M26",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({ endpoints: z.array(WebhookEndpoint) }),
});

export const updateWebhookEndpoint = defineRoute({
  method: "patch",
  path: "/v1/webhooks/endpoints/{id}",
  summary: "Change the URL, the events, or whether it is on",
  description:
    "The signing secret is not changeable here: that is `POST /v1/webhooks/endpoints/{id}/secret`, with an overlap. Changing it here would break every receiver still holding the old one, and an operator fixing a typo in a URL should not find that out from their own error log.",
  module: "M26",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    url: Url.optional(),
    events: EventNames.optional(),
    active: z.boolean().optional(),
  }),
  output: WebhookEndpoint,
});

export const rotateWebhookSecret = defineRoute({
  method: "post",
  path: "/v1/webhooks/endpoints/{id}/secret",
  summary: "Give an endpoint a new signing secret",
  description:
    "Returns the new secret, once. For `overlapHours` (24 unless you say, 0 to 168) every delivery is signed with BOTH the new and the old secret, the `x-otos-signature` header carrying two signatures separated by a comma, newest first, so the receiver keeps accepting deliveries whichever secret it holds and can switch on its owner's own day. A receiver must accept a delivery when any one signature matches. Send 0 when the old secret leaked: it then stops signing at once. Rotating again during an overlap retires the oldest secret immediately, so at most two ever sign. A retry with the same idempotency key returns the same secret rather than rotating twice.",
  module: "M26",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    overlapHours: z.number().int().min(0).max(168).optional(),
  }),
  output: WebhookEndpoint.extend({
    /** Shown once. Deliveries are signed with it from now on. */
    secret: z.string(),
  }),
});

export const deleteWebhookEndpoint = defineRoute({
  method: "delete",
  path: "/v1/webhooks/endpoints/{id}",
  summary: "Stop delivering to this endpoint",
  description:
    "The row is kept and stops being delivered to, so the audit trail for every delivery that ever went to it still names something. Its position in the event log is dropped, because a position is not a record.",
  module: "M26",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

export const getWebhookPosition = defineRoute({
  method: "get",
  path: "/v1/webhooks/endpoints/{id}/position",
  summary: "How far behind this endpoint is",
  description:
    "The one number that answers whether a receiver has had everything, and it lives in a table nobody looking at webhooks would think to open.",
  module: "M26",
  permissions: ["integration:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    /** The highest event sequence this endpoint has been delivered through. */
    deliveredThrough: z.number().int(),
    /** Subscribed events after that point, waiting. */
    pending: z.number().int(),
  }),
});

export const listWebhookEvents = defineRoute({
  method: "get",
  path: "/v1/webhooks/events",
  summary: "The event names an endpoint may subscribe to",
  description:
    "The catalogue, plus any name this company's own log already holds, which an older build or a migration may have written. A name with no summary is one of those.",
  module: "M26",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({
    events: z.array(z.object({
      name: z.string(),
      summary: z.string().nullable(),
    })),
  }),
});

/**
 * One attempt to deliver one event to one endpoint, and what came back.
 *
 * `status` is derived from the other fields and is what the history filters
 * by: delivered (a 2xx), refused (any other answer) or unreachable (no
 * answer at all: a timeout, a refused connection, DNS).
 */
export const WebhookDelivery = z.object({
  id: Uuid,
  endpointId: Uuid,
  eventId: Uuid,
  eventSequence: z.number().int(),
  eventName: z.string(),
  /** 1 for the first try of this event at this endpoint, counting replays. */
  attempt: z.number().int(),
  /** Set when the attempt was a replay somebody asked for. */
  replayId: Uuid.nullable(),
  requestedAt: z.string(),
  durationMs: z.number().int(),
  responseStatus: z.number().int().nullable(),
  /** The first two thousand characters of what the receiver answered. */
  responseExcerpt: z.string().nullable(),
  error: z.string().nullable(),
  status: z.enum(["delivered", "refused", "unreachable"]),
});

export const WebhookReplay = z.object({
  id: Uuid,
  endpointId: Uuid,
  eventId: Uuid.nullable(),
  fromSequence: z.number().int(),
  /** Fixed when it was asked for, so a replay finishes. */
  throughSequence: z.number().int(),
  /** The last sequence sent and answered. */
  position: z.number().int(),
  status: z.enum(["pending", "done", "failed"]),
  failureCount: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const listWebhookDeliveries = defineRoute({
  method: "get",
  path: "/v1/webhooks/endpoints/{id}/deliveries",
  summary: "What was sent to this endpoint and what it answered",
  description:
    "Every attempt, newest first, with the status the receiver answered, the first two thousand characters of its body, how long it took and any error. Kept for thirty days and at most a thousand attempts per endpoint, whichever is shorter. Filter by status or by one event.",
  module: "M26",
  permissions: ["integration:read"],
  input: PageRequest.extend({
    id: Uuid,
    status: z.enum(["delivered", "refused", "unreachable"]).optional(),
    eventId: Uuid.optional(),
  }),
  output: pageOf(WebhookDelivery),
});

export const listWebhookEventDeliveries = defineRoute({
  method: "get",
  path: "/v1/webhooks/deliveries",
  summary: "Every attempt to deliver one event, to every endpoint",
  description:
    "The question asked from the receiving end: this happened and our system never heard about it, so what did you send and what did we say. Removed endpoints are included.",
  module: "M26",
  permissions: ["integration:read"],
  input: z.object({ eventId: Uuid }),
  output: z.object({
    event: z.object({ id: Uuid, name: z.string(), sequence: z.number().int(), occurredAt: z.string() }),
    deliveries: z.array(WebhookDelivery.extend({ endpointUrl: z.string() })),
  }),
});

export const replayWebhookDeliveries = defineRoute({
  method: "post",
  path: "/v1/webhooks/endpoints/{id}/replays",
  summary: "Send an event, or everything from a point in the log, again",
  description:
    "Name one of `eventId`, `deliveryId` or `fromSequence` (with `throughSequence` to stop early). Queued and sent by the worker in order, after the endpoint's live deliveries, signed afresh and carrying the same `x-otos-delivery` header as the original, so a receiver that deduplicates on it is never made to process an event twice. A range covers only events the endpoint subscribes to, ends at the newest event when it is asked for, and is at most five thousand events. Asking again for a replay that is still waiting returns it rather than queuing a second.",
  module: "M26",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    eventId: Uuid.optional(),
    deliveryId: Uuid.optional(),
    fromSequence: z.number().int().min(1).optional(),
    throughSequence: z.number().int().min(1).optional(),
  }),
  output: WebhookReplay,
});

export const listWebhookReplays = defineRoute({
  method: "get",
  path: "/v1/webhooks/endpoints/{id}/replays",
  summary: "The replays asked for on this endpoint",
  description: "Newest first, with how far each has got and why one stopped.",
  module: "M26",
  permissions: ["integration:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ replays: z.array(WebhookReplay) }),
});

export const webhookRoutes = {
  registerWebhookEndpoint, listWebhookEndpoints, updateWebhookEndpoint, rotateWebhookSecret,
  deleteWebhookEndpoint, getWebhookPosition, listWebhookEvents,
  listWebhookDeliveries, listWebhookEventDeliveries, replayWebhookDeliveries, listWebhookReplays,
} as const;
