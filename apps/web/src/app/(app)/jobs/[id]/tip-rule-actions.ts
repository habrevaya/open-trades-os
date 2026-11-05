"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tipRules } from "@opentradesos/api/services";

/**
 * Set, change or take off this job's own tip rule, from the job's page.
 *
 * Through `tipRules.set` and `tipRules.remove`, the same calls Pay rules
 * makes: `payroll:configure`, audited, and a tip already shared keeps the
 * rule it was shared by. Their refusals are the sentence shown.
 */
export async function setJobTipRule(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = String(form.get("jobId") ?? "");
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const result = await attempt(form, async () => {
    await tipRules.set(ctx, { jobId, rule: field(form, "rule") ?? "", note: field(form, "note") });
    return { message: "Set. Tips on this job are shared this way from the next one. Tips already shared keep theirs." };
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

export async function removeJobTipRule(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = String(form.get("jobId") ?? "");
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const result = await attempt(form, async () => {
    await tipRules.remove(ctx, { id: field(form, "id") ?? "" });
    return { message: "Taken off. The next tip on this job is shared by the next rule in line." };
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}
