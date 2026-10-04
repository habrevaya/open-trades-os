import { z } from "zod";
import { defineRoute } from "../lib/define";
import { LivePositions } from "./dispatch-map";

/**
 * LIVE TECHNICIAN LOCATION
 *
 * The company's switch, where people are now for whoever dispatches, and the
 * customer's tracking link. Positions come in through `POST /v1/field/sync`;
 * nothing here takes one. The rules are in `packages/core/src/location` and
 * the privacy choices in `docs/modules/m11-mobile-field-app.md`.
 */

const Sharing = z.object({
  /** Off until somebody turns it on. Turning it off deletes every position already kept. */
  enabled: z.boolean(),
  /** Days a position is kept, one to thirty. */
  retentionDays: z.number().int(),
  /** How often a phone takes a position while sharing, in seconds. */
  intervalSeconds: z.number().int(),
});

export const getLocationSharing = defineRoute({
  method: "get",
  path: "/v1/dispatch/location-sharing",
  summary: "Whether the company shares technicians' locations, and for how long it keeps them",
  description:
    "Readable by anybody who reads the schedule, technicians included, because the people being located should be able to see the rule.",
  module: "M09",
  permissions: ["visit:read"],
  input: z.object({}),
  output: Sharing,
});

export const setLocationSharing = defineRoute({
  method: "put",
  path: "/v1/dispatch/location-sharing",
  summary: "Turn location sharing on or off, and set how long positions are kept",
  description:
    "Phones share only while their person is clocked in, on the way to a visit or working one, and only when this is on and their own setting is. Turning it off deletes every position already kept; shortening the retention deletes what is now past it.",
  module: "M09",
  permissions: ["settings:write"],
  input: z.object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(30).optional(),
    intervalSeconds: z.number().int().min(15).max(600).optional(),
  }),
  output: Sharing,
});

export const getLivePositions = defineRoute({
  method: "get",
  path: "/v1/dispatch/positions",
  summary: "Where each technician is now",
  description:
    "The latest position of each technician today, with how long ago it was taken, for people who dispatch. Empty when the company does not share locations. The dispatch map asks for this every half minute.",
  module: "M09",
  permissions: ["visit:dispatch"],
  input: z.object({}),
  output: LivePositions,
});

export const getPortalJobLive = defineRoute({
  method: "get",
  path: "/v1/portal/job/live",
  summary: "The live part of a tracking link: an ETA and where the technician is",
  description:
    "Only while the technician is on the way to the visit the customer is waiting on, after they were texted, and only positions taken for that visit since then. Once the technician arrives the link shows no location at all. The ETA is by road when the company has a routing service, otherwise a straight line estimate, otherwise what the technician said, counted down; `etaBasis` says which.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: z.string().min(20).max(200) }),
  output: z.object({
    tracking: z.boolean(),
    status: z.enum(["not_on_the_way", "on_the_way", "arrived", "finished"]),
    etaMinutes: z.number().int().nullable(),
    etaBasis: z.enum(["road", "estimate", "technician"]).nullable(),
    /** First name and photo only. Never a phone number or a last name. */
    technician: z.object({ firstName: z.string(), photoUrl: z.string().url().nullable() }).nullable(),
    position: z.object({
      lat: z.number(), lng: z.number(), recordedAt: z.string().datetime(), lastSeen: z.string(),
    }).nullable(),
    /** The house, only while the pin is showing. */
    destination: z.object({ lat: z.number(), lng: z.number() }).nullable(),
    explanation: z.string(),
  }),
});

export const locationRoutes = {
  getLocationSharing, setLocationSharing, getLivePositions, getPortalJobLive,
} as const;

