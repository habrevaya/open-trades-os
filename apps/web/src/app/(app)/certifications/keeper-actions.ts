"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { staffNotices } from "@opentradesos/api/services";
import { attempt, field, type FormState } from "@/lib/actions";

/**
 * Name who keeps the renewals list, or nobody. Through the service
 * `PUT /v1/certification-renewals/keeper` calls, so `compliance:write`, the
 * check that they can read the list, and the audit entry are the same.
 */
export async function setKeeper(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const result = await attempt(form, async () => {
    const saved = await staffNotices.setRenewalsKeeper(ctx, { userId: field(form, "userId") ?? null });
    return {
      message: saved.userId
        ? `Saved. ${saved.name ?? "They"} will be told when a licence or skill is about to run out.`
        : "Saved. Only the holder and their manager are told.",
    };
  });
  if (!result?.error) revalidatePath("/certifications");
  return result;
}
