"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { profitability } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * "These are two different costs": takes the possible double count warning
 * off one journal line and job line. Changes no figure. The service checks
 * the pair is flagged and that the person posts journals.
 */
export async function markNotTheSame(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const result = await attempt(form, async () => {
    await profitability.markNotTheSame(await ctx(), {
      jobId,
      jobLineId: field(form, "jobLineId") ?? "",
      ledgerEntryId: field(form, "ledgerEntryId") ?? "",
      note: field(form, "note"),
    });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/** Take a mark back: the warning shows again. */
export async function unmarkNotTheSame(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const result = await attempt(form, async () => {
    await profitability.unmarkNotTheSame(await ctx(), { jobId, markId: field(form, "markId") ?? "" });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}
