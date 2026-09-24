import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * PEOPLE, AND THE DOOR
 *
 * `membership.active` decides whether a sign in succeeds: the login path
 * looks for an active membership and refuses when there is none. Nothing in
 * this product could set it to false.
 *
 * An employee who left on Friday kept a working password, their existing
 * sessions, and every permission their role carried. The only way to stop
 * them was to delete the user row, which takes the audit trail of everything
 * they ever did with it, so in practice nobody did.
 */
export const setMembershipActive = defineRoute({
  method: "post",
  path: "/v1/memberships/{membershipId}/active",
  summary: "Offboard somebody, or bring them back",
  description:
    "Deactivated, not deleted: every job they ran and every timeclock entry they closed points at them, and 'who was on site' has to have an answer years later. Existing sessions are revoked in the same transaction, because flipping the flag alone leaves anybody already signed in signed in for days, and an offboarding that takes effect on Thursday is not an offboarding.",
  module: "M01",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({
    membershipId: Uuid,
    active: z.boolean(),
    reason: z.string().max(500).optional(),
  }),
  output: z.object({
    id: Uuid,
    active: z.boolean(),
    /** How many live sessions were ended. Zero on a reactivation. */
    sessionsRevoked: z.number().int(),
  }),
});

export const peopleRoutes = { setMembershipActive } as const;
