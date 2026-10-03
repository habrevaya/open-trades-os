"use server";

import { revalidatePath } from "next/cache";
import { attempt, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs } from "@opentradesos/api/services";

/**
 * Move one job to another branch, or out of every branch.
 *
 * Through `jobs.update`, which asks `branches.assertPlaceable`: only somebody
 * who sees the whole company may move work out of their own branch, and a
 * retired branch takes nothing new. Its refusals are the sentence shown.
 */
export async function setJobBranch(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = String(form.get("jobId") ?? "");
  const chosen = String(form.get("businessUnitId") ?? "");
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const result = await attempt(form, () => jobs.update(ctx, { id: jobId, businessUnitId: chosen === "" ? null : chosen }));
  revalidatePath(`/jobs/${jobId}`);
  return result;
}
