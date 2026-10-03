"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { roles, ConflictError } from "@opentradesos/api/services";
import { ROLE_PRESETS, SCOPED_RESOURCES, isScope, type RoleId } from "@opentradesos/core";

const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/**
 * `RoleEscalationError` in words. The roles service throws it when a role
 * carries a permission, or sees further, than its author; the screen says
 * which, because "ask somebody who holds payroll" is the thing to do next.
 */
function readable(error: unknown): never {
  if (error instanceof roles.RoleEscalationError) {
    throw new ConflictError(
      error.detail.reason === "missing_permission"
        ? `That role would carry permissions you do not hold yourself: ${error.detail.permissions.join(", ")}. Start from a smaller preset, or ask somebody who holds them.`
        : "That role would see more of the company than you do. Somebody who sees the whole company has to make it.",
    );
  }
  throw error;
}

/**
 * A role made from a preset and one choice about what its holders see.
 *
 * The scope is applied to every resource a scope narrows (jobs and
 * everything read through them, visits, timesheets, service reports and
 * conversations), because a branch manager who sees only Houston's jobs and
 * every branch's conversations is not a branch manager.
 */
export async function createRole(_previous: FormState, form: FormData): Promise<FormState> {
  const basedOn = (field(form, "basedOn") ?? "office_manager") as RoleId;
  const sees = field(form, "sees") ?? "all";
  const result = await attempt(form, async () => {
    if (!ROLE_PRESETS[basedOn]) throw new ConflictError("Choose which role to start from.");
    if (!isScope(sees)) throw new ConflictError("Choose what people with this role see.");
    try {
      await roles.create(await ctx(), {
        name: field(form, "name") ?? "",
        description: field(form, "description"),
        basedOn,
        permissions: [...ROLE_PRESETS[basedOn].permissions],
        scopes: sees === "all" ? {} : Object.fromEntries(SCOPED_RESOURCES.map((resource) => [resource, sees])),
      });
    } catch (error) {
      readable(error);
    }
    return { message: "Role made. Give it to people on Team." };
  });
  revalidatePath("/settings/roles");
  revalidatePath("/settings/team");
  return result;
}

export async function removeRole(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => roles.remove(await ctx(), { id: String(form.get("id") ?? "") }));
  revalidatePath("/settings/roles");
  revalidatePath("/settings/team");
  return result;
}
