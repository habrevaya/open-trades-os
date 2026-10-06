import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * M01. THE COMPANY'S OWN ROLES
 *
 * The routes Settings, Roles works through. A role is a named set of
 * permissions and, for each record a scope narrows, what its holders see.
 * Nobody makes, changes or hands out a role bigger than themselves: one
 * carrying a permission the caller does not hold, or seeing further than
 * they do, is refused with a 403 that says which (`reason`, and the
 * `permissions` or `resources` it was about).
 */

const Scopes = z.record(z.string(), z.string());

const Role = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  basedOn: z.string().nullable(),
  permissions: z.array(z.string()),
  /** For each record a scope narrows, what its holders see. A record the role does not name is their own only. */
  scopes: Scopes,
  /**
   * The role names no scope at all, so its holders see their own work only.
   * That is how the roles screen saved "the whole company" before it wrote
   * the choice out; `POST /v1/roles/{id}/whole-company` fixes one when its
   * owner says that is what it was.
   */
  namesNoScope: z.boolean(),
});

const RoleInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(300).optional(),
  /** The preset it started from, as a note. */
  basedOn: z.string().max(40).optional(),
  permissions: z.array(z.string()).max(400),
  scopes: Scopes.optional(),
});

export const listRoles = defineRoute({
  method: "get",
  path: "/v1/roles",
  summary: "The company's own roles",
  module: "M01",
  permissions: ["role:write"],
  input: z.object({}),
  output: z.object({ roles: z.array(Role) }),
});

export const createRole = defineRoute({
  method: "post",
  path: "/v1/roles",
  summary: "Make a role",
  description:
    "Refused with a 403 when it carries a permission the caller does not hold or sees further than they do, and with a 409 when a role already has the name. Name every scoped record in `scopes`: a record left out is the holder's own work only.",
  module: "M01",
  permissions: ["role:write"],
  idempotent: true,
  input: RoleInput,
  output: Role,
});

export const updateRole = defineRoute({
  method: "patch",
  path: "/v1/roles/{id}",
  summary: "Change a role",
  description:
    "Checked against the role as it would be after the change, so editing a role into one the caller could not make is refused with a 403 like making it.",
  module: "M01",
  permissions: ["role:write"],
  idempotent: true,
  input: RoleInput.partial().extend({ id: Uuid }),
  output: Role,
});

export const removeRole = defineRoute({
  method: "post",
  path: "/v1/roles/{id}/remove",
  summary: "Remove a role",
  description: "Its holders go back to the preset their membership names, so nobody is locked out by it.",
  module: "M01",
  permissions: ["role:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const giveRoleWholeCompany = defineRoute({
  method: "post",
  path: "/v1/roles/{id}/whole-company",
  summary: "Give a role that names no scope the whole company",
  description:
    "For a role made on the roles screen before \"the whole company\" was saved as a scope: it names none, so its holders have been seeing their own work only. Sets every scoped record to the whole company. Refused for a role that already names a scope, and with a 403 for somebody who does not see the whole company themselves. Its holders' access changes at once.",
  module: "M01",
  permissions: ["role:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Role,
});

export const assignCustomRole = defineRoute({
  method: "post",
  path: "/v1/memberships/{membershipId}/custom-role",
  summary: "Give somebody one of the company's own roles",
  description:
    "Checked both ways, as a preset change is: the caller must hold what the role carries and what the person holds now, refused with a 403 that says which. A role limited to a branch or a shop is refused for somebody with none. Nobody changes their own role. A preset is given with `POST /v1/memberships/{membershipId}/role`, which takes the custom role away.",
  module: "M01",
  permissions: ["user:write", "membership:write"],
  idempotent: true,
  input: z.object({ membershipId: Uuid, roleId: Uuid }),
  output: z.object({ membershipId: Uuid, role: z.string(), customRoleId: Uuid.nullable() }),
});

export const roleRoutes = {
  listRoles, createRole, updateRole, removeRole, giveRoleWholeCompany, assignCustomRole,
} as const;
