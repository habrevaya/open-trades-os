"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { peopleRecords } from "@opentradesos/api/services";
import { setJobSkills } from "@opentradesos/api/contracts";
import { attempt, parsed, type FormState } from "@/lib/actions";

/** The skills this job needs beyond its type, typed as a comma separated list. */
export async function setJobSkillsAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("jobId") ?? "");
  const state = await attempt(form, async () => {
    const skills = String(form.get("skills") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    await peopleRecords.setJobSkills({ actor: (await requireSetupUser()).actor, db: getDb() }, parsed(setJobSkills.input, { id, skills }));
  });
  if (state?.done) revalidatePath(`/jobs/${id}`);
  return state;
}
