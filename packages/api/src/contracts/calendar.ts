import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE TECHNICIAN'S DAY, IN THE CALENDAR THEY ALREADY HAVE
 *
 * `calendar` has been a capability in this product's enum since the first
 * migration with no provider behind it. These four routes are the whole
 * management surface for the first one: mint a feed, see what has been
 * minted, turn one off, replace one.
 *
 * THE FEED ITSELF IS NOT HERE, and that is deliberate. It is served from
 * `/api/calendar/{token}` as `text/calendar`, alongside the lead and carrier
 * webhooks, because its caller is a calendar client holding a secret in a
 * URL rather than a user holding a session, and a route in this registry
 * means an authenticated JSON endpoint. Putting it here would have meant
 * either a lie about the authorization or a `public` route returning a
 * content type nothing else in the API uses.
 *
 * WHAT A FEED SHOWS. When the visit is, where it is, who it is for and what
 * the work is. NOT the customer's phone number, and nothing about money. The
 * reasoning is at the top of `services/calendar.ts`: a subscription is
 * collected by a phone that may be signed into a personal account, so the
 * feed carries what somebody needs in order to ARRIVE and not what they need
 * in order to contact, which the field app does with the consent rules
 * applied.
 */

export const CalendarFeed = z.object({
  id: Uuid,
  scope: z.enum(["technician", "company"]),
  technicianId: Uuid.nullable(),
  label: z.string(),
  /** The last characters of the token, so two feeds can be told apart. Never the token. */
  hint: z.string(),
  revokedAt: z.date().nullable(),
  revokedReason: z.string().nullable(),
  /** When a calendar client last collected it. Null means nobody ever has. */
  lastFetchedAt: z.date().nullable(),
  /** What collected it, trimmed. A second client appearing here is worth a look. */
  lastFetchedBy: z.string().nullable(),
  createdAt: z.date(),
});

export const createCalendarFeed = defineRoute({
  method: "post",
  path: "/v1/calendar-feeds",
  summary: "Mint a calendar feed and get its URL",
  description:
    "Returns the path exactly once. No read path gives it back, because the URL is the whole credential: anybody holding it sees the visits until it is revoked. Losing it means rotating, which is the same thing you would do if it leaked. A feed over your own day needs only the permission to read visits; one over somebody else's needs the permission to dispatch them; a company wide feed is every customer address the company serves behind one URL, so it needs the permission to connect integrations.",
  module: "M09",
  permissions: ["visit:read"],
  idempotent: true,
  input: z.object({
    scope: z.enum(["technician", "company"]),
    /** Omit for your own day. Naming somebody else needs visit:dispatch. */
    technicianId: Uuid.optional(),
    label: z.string().min(1).max(120).optional(),
  }),
  output: CalendarFeed.extend({
    /** Append to this deployment's own public address to get the URL to subscribe to. */
    feedPath: z.string(),
  }),
});

export const listCalendarFeeds = defineRoute({
  method: "get",
  path: "/v1/calendar-feeds",
  summary: "Every calendar feed you can see, and when each was last collected",
  description:
    "Your own feeds, or everybody's if you hold the integration permission. The last collected time is the only evidence a feed is in use at all, which is what makes revoking the ones nobody fetches a decision rather than a guess.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({}),
  output: z.object({ feeds: z.array(CalendarFeed) }),
});

export const revokeCalendarFeed = defineRoute({
  method: "post",
  path: "/v1/calendar-feeds/{id}/revoke",
  summary: "Stop a feed working",
  description:
    "Takes effect on the next fetch. The row is kept rather than deleted, because after a phone goes missing the question is which URL used to reach the schedule and when it was switched off, and a deleted row answers that with silence.",
  module: "M09",
  permissions: ["visit:read"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().max(200).optional() }),
  output: CalendarFeed.extend({ alreadyRevoked: z.boolean() }),
});

export const rotateCalendarFeed = defineRoute({
  method: "post",
  path: "/v1/calendar-feeds/{id}/rotate",
  summary: "New URL for the same day, old one dead",
  description:
    "One call rather than two, because somebody rotating is responding to a worry and a two step rotation is one that gets left half done. The old feed is revoked in the same transaction, so there is no moment when both URLs work.",
  module: "M09",
  permissions: ["visit:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: CalendarFeed.extend({
    feedPath: z.string(),
    /** The feed this one replaced, now revoked. */
    replaced: Uuid,
  }),
});

export const calendarRoutes = {
  createCalendarFeed, listCalendarFeeds, revokeCalendarFeed, rotateCalendarFeed,
} as const;
