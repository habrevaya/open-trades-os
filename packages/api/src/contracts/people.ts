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

/**
 * WHO WORKS HERE.
 *
 * There was no way to read it. A visit names its technicians by id, and an
 * integration putting work on the board, or a migration mapping a source
 * system's technicians onto this one's, had to have somebody copy every id
 * out of a screen by hand. Matching by email is the job this exists for.
 */
export const listPeople = defineRoute({
  method: "get",
  path: "/v1/people",
  summary: "List the people in this company",
  description:
    "Each membership, with the person's name and email and, for anybody who goes out on visits, the technician id a visit names. Offboarded people are left out unless asked for, because they still appear on every visit they worked.",
  module: "M01",
  permissions: ["user:read"],
  input: z.object({
    includeInactive: z.boolean().default(false),
    /** Exact, case insensitive. */
    email: z.string().max(320).optional(),
  }),
  output: z.object({
    data: z.array(z.object({
      membershipId: Uuid,
      userId: Uuid,
      name: z.string().nullable(),
      email: z.string(),
      /** The preset role, or the custom role's name where one decides. */
      role: z.string(),
      active: z.boolean(),
      /** What `technicianIds` on a visit refers to. Null for office staff. */
      technicianId: Uuid.nullable(),
      technicianName: z.string().nullable(),
      technicianActive: z.boolean().nullable(),
    })),
  }),
});

export const peopleRoutes = { setMembershipActive, listPeople } as const;
