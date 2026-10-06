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
  if (error instanceof roles.RoleEscalationError) throw new ConflictError(error.sentence);
  throw error;
}

/**
 * A role made from a preset and one choice about what its holders see.
 *
 * The scope is applied to every resource a scope narrows (jobs and
 * everything read through them, visits, timesheets, service reports and
 * conversations), because a branch manager who sees only Houston's jobs and
 * every branch's conversations is not a branch manager. "The whole company"
 * is written out too, for the reason below.
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
        /**
         * Every resource named, "the whole company" included. A role that names
         * no scope sees its holder's own work, the narrowest default, so saving
         * "all" as nothing gave a whole company role an empty screen.
         */
        scopes: Object.fromEntries(SCOPED_RESOURCES.map((resource) => [resource, sees])),
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

/**
 * THE FIX FOR A ROLE SAVED BEFORE "THE WHOLE COMPANY" WAS WRITTEN OUT. It
 * changes what everybody holding the role sees, at once, so it is done only
 * when somebody ticks that this is what the role was for and presses the
 * button; nothing is changed for them.
 */
export async function giveWholeCompany(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    if (form.get("confirm") !== "yes") {
      throw new ConflictError("Tick the box to say people with this role should see the whole company.");
    }
    try {
      const role = await roles.giveWholeCompany(await ctx(), { id: String(form.get("id") ?? "") });
      return { message: `${role.name} now sees the whole company.` };
    } catch (error) {
      readable(error);
    }
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
