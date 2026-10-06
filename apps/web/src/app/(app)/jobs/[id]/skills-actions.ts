"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { peopleRecords } from "@opentradesos/api/services";
import { dropJobSkill, restoreJobSkill, setJobSkills } from "@opentradesos/api/contracts";
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

/** Drop one of the job type's skills for this job, with the reason that is kept and shown on the job. */
export async function dropJobSkillAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("jobId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.dropSkill(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(dropJobSkill.input, { id, skill: String(form.get("skill") ?? ""), reason: String(form.get("reason") ?? "") }),
    );
  });
  if (state?.done) revalidatePath(`/jobs/${id}`);
  return state;
}

/** Ask for a dropped skill on this job again. */
export async function restoreJobSkillAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("jobId") ?? "");
  const state = await attempt(form, async () => {
    await peopleRecords.restoreSkill(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(restoreJobSkill.input, { id, skill: String(form.get("skill") ?? "") }),
    );
  });
  if (state?.done) revalidatePath(`/jobs/${id}`);
  return state;
}
