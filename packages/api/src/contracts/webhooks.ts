import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * OUTBOUND WEBHOOKS
 *
 * The event log has been ordered and durable since the first migration and
 * the only way to read it was to be this codebase. These routes are the
 * other end of that: a company registers a URL, names the events it cares
 * about, and their own system hears about a job being completed without
 * anybody polling for it.
 *
 * THE SECRET IS RETURNED ONCE, by `registerWebhookEndpoint` and nowhere
 * else. There is no route below that reads it back, and that is deliberate
 * rather than an omission: a secret a list endpoint will hand over on
 * request is a secret that leaks through every screen, log and support
 * transcript that ever shows an endpoint. An operator who loses it registers
 * a new endpoint, which is the same thing they would do if it leaked.
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
    "The signing secret is not changeable here. Rotating it breaks every receiver still holding the old one, and an operator fixing a typo in a URL should not find that out from their own error log.",
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

export const webhookRoutes = {
  registerWebhookEndpoint, listWebhookEndpoints, updateWebhookEndpoint,
  deleteWebhookEndpoint, getWebhookPosition, listWebhookEvents,
} as const;
