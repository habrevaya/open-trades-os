import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * CALL TRACKING, WHICH IS HOW ANYTHING PHYSICAL GETS MEASURED
 *
 * A yard sign, a van, a mailer, a door hanger and a radio spot carry no
 * query string and set no referrer. The number on them IS the tag, so a
 * tracked call is the only evidence that half a trades company's marketing
 * budget does anything at all.
 *
 * These four routes are the setup surface: connect it, read what is
 * connected, prove the key works, and fetch back the calls a failed delivery
 * lost. The calls themselves arrive at
 * `/api/webhooks/call-tracking/{token}`, beside the lead and carrier
 * webhooks, because the caller is a vendor holding a secret in a URL rather
 * than a user holding a session.
 *
 * ON THE CREDENTIAL, SAID HERE BECAUSE IT SHAPES THE SETUP. CallRail issues
 * ONE long-lived API key with no OAuth and no refresh token. There is no
 * expiry to drive a rotation and nothing on either side that will prompt
 * one: rotating is a person deciding to, minting a new key in CallRail,
 * putting it in the secret store and removing the old one. The catalogue
 * says so in its limitation, and it is the main reason this connector asks
 * for a key reference rather than a key.
 */

export const CallTrackingConnection = z.object({
  id: Uuid,
  provider: z.string(),
  status: z.string(),
  accountLabel: z.string().nullable(),
  accountId: z.string().nullable(),
  companyId: z.string().nullable(),
  /** Append to this deployment's own public address and give it to CallRail. */
  webhookPath: z.string().nullable(),
  /** The name the API key is expected under in your secret store. Never the key. */
  apiKeyRef: z.string().nullable(),
  /** The name the webhook signing key is expected under. Never the key. */
  signingSecretRef: z.string().nullable(),
  lastCheckedAt: z.date().nullable(),
  lastError: z.string().nullable(),
});

export const connectCallTracking = defineRoute({
  method: "post",
  path: "/v1/call-tracking/connect",
  summary: "Point this company's call tracking at itself",
  description:
    "Returns the webhook URL to paste into CallRail and the two names your secret store has to hold: the API key, and the signing key from CallRail's own Webhooks page. Neither value is ever stored here. Reconnecting keeps the existing webhook URL rather than minting a new one, because replacing it silently would leave CallRail posting at a dead address and the first evidence would be missing calls, which they do not resend.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    /** The identifier in the URL of your CallRail dashboard. */
    accountId: z.string().min(4).max(64),
    /** Only needed if the account holds several companies. */
    companyId: z.string().min(1).max(64).optional(),
    accountLabel: z.string().min(1).max(200).optional(),
  }),
  output: CallTrackingConnection,
});

export const getCallTrackingConnection = defineRoute({
  method: "get",
  path: "/v1/call-tracking",
  summary: "What is connected, and what it last said",
  module: "M19",
  permissions: ["integration:read"],
  input: z.object({}),
  output: CallTrackingConnection,
});

export const checkCallTracking = defineRoute({
  method: "post",
  path: "/v1/call-tracking/check",
  summary: "Prove the API key works, and name the account it reaches",
  description:
    "Guarded by the write permission rather than the read one, because it spends something: CallRail allows a thousand requests an hour against your own account, shared with everything else you have pointed at it, so a check anybody holding read could trigger is a check a dashboard can refresh in a loop.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({}),
  output: z.union([
    z.object({ ok: z.literal(true), accountId: z.string(), accountName: z.string() }),
    z.object({
      ok: z.literal(false), code: z.string(), message: z.string(), retryable: z.boolean(),
    }),
  ]),
});

export const backfillCallTracking = defineRoute({
  method: "post",
  path: "/v1/call-tracking/backfill",
  summary: "Fetch the calls a failed delivery lost",
  description:
    "CallRail does not resend a webhook that failed, so an hour of downtime is an hour of calls that will never arrive on their own. This fetches a window and puts every call through exactly the same path a webhook takes, so running it over a window that mostly landed is mostly no-ops rather than a second copy of the week. It stops at a page ceiling and says so, because the far end is metered.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    since: z.string().datetime(),
    until: z.string().datetime(),
    maxPages: z.number().int().min(1).max(50).optional(),
  }),
  output: z.object({
    imported: z.number().int(),
    /** Calls that were already here. The ordinary case when re-running a window. */
    duplicates: z.number().int(),
    pages: z.number().int(),
    /** Null when the window was walked to the end. A sentence when it was not. */
    stoppedBecause: z.string().nullable(),
  }),
});

export const callTrackingRoutes = {
  connectCallTracking, getCallTrackingConnection, checkCallTracking, backfillCallTracking,
} as const;
