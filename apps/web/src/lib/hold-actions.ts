"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { retention } from "@opentradesos/api/services";

/**
 * A HOLD PLACED OR LIFTED FROM THE RECORD'S OWN PAGE
 *
 * The same service calls the retention screen makes, so the permission
 * (`compliance:write`) and the refusals are the service's. The page to
 * refresh comes from the form, and only an internal path is taken.
 */
const refresh = (form: FormData) => {
  const path = field(form, "path") ?? "";
  if (path.startsWith("/") && !path.startsWith("//")) revalidatePath(path);
  revalidatePath("/compliance/retention");
};

export async function holdHere(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const state = await attempt(form, async () => {
    await retention.placeHold(ctx, {
      entityType: field(form, "entityType") ?? "",
      entityId: field(form, "entityId") ?? "",
      reason: field(form, "reason") ?? "",
    });
    return { message: "Held. It is kept whatever its age until the hold is lifted." };
  });
  refresh(form);
  return state;
}

export async function liftHold(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const state = await attempt(form, async () => {
    await retention.releaseHold(ctx, { id: field(form, "id") ?? "", ...(field(form, "note") ? { note: field(form, "note")! } : {}) });
    return { message: "Lifted. The retention rules apply to it again." };
  });
  refresh(form);
  return state;
}
