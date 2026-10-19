"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { staffNotices } from "@opentradesos/api/services";
import { attempt, field, refused, type FormState } from "@/lib/actions";

/**
 * Add one person to those who keep the renewals list, or take everybody off
 * with "Nobody else". Through the service `PUT /v1/certification-renewals/keepers`
 * calls, so `compliance:write`, the check that each can read the list, and the
 * audit entry are the same.
 */
export async function setKeeper(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const chosen = field(form, "userId") ?? "";
  if (chosen === "") return refused(form, "Choose someone to tell, or choose Nobody else.");
  const result = await attempt(form, async () => {
    const now = (await staffNotices.renewalsKeepers(ctx)).keepers.map((k) => k.userId);
    const saved = await staffNotices.setRenewalsKeepers(ctx, { userIds: chosen === "none" ? [] : [...new Set([...now, chosen])] });
    if (chosen === "none") return { message: "Saved. Only the holder and their manager are told." };
    const added = saved.keepers.find((k) => k.userId === chosen);
    return { message: `Saved. ${added?.name ?? "They"} will be told when a licence or skill is about to run out.` };
  });
  if (!result?.error) revalidatePath("/certifications");
  return result;
}

/** Stop telling one person, leaving the others. */
export async function removeKeeper(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const result = await attempt(form, async () => {
    const leaving = field(form, "userId") ?? "";
    const now = (await staffNotices.renewalsKeepers(ctx)).keepers.map((k) => k.userId);
    await staffNotices.setRenewalsKeepers(ctx, { userIds: now.filter((id) => id !== leaving) });
    return { message: "Saved." };
  });
  if (!result?.error) revalidatePath("/certifications");
  return result;
}
