import { getDb } from "@/lib/db";
import { peopleRecords } from "@opentradesos/api/services";
import type { Actor } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { setJobSkillsAction } from "./skills-actions";

/**
 * WHAT THIS JOB NEEDS OF WHOEVER IS SENT
 *
 * The job type's skills, which every job of the type needs, and any this one
 * job asks for beyond them: a lift ticket for a rooftop unit, a confined
 * space entry for a crawlspace. The extra ones are checked wherever the
 * type's are, on the board, at booking and in the suggestions, so a skill
 * written here is a check rather than a note.
 */
export async function RequiredSkills({ jobId, actor, writes }: { jobId: string; actor: Actor; writes: boolean }) {
  const skills = await peopleRecords.jobSkills({ actor, db: getDb() }, { id: jobId });
  if (!writes && skills.skills.length === 0 && skills.typeSkills.length === 0) return null;
  return (
    <section className="mt-6" aria-labelledby="required-skills">
      <h2 id="required-skills" className="text-sm font-medium text-ink-700">Skills this work needs</h2>
      <p className="mt-1 text-sm text-ink-700">
        {skills.typeSkills.length > 0 ? `From its job type: ${skills.typeSkills.join(", ")}. ` : "Its job type asks for none. "}
        {skills.skills.length > 0 ? `This job also: ${skills.skills.join(", ")}.` : ""}
      </p>
      {writes ? (
        <ActionForm action={setJobSkillsAction} submit="Save skills" tone="quiet" className="mt-2 flex flex-wrap items-end gap-3"
                    hidden={{ jobId }} done="Saved.">
          <TextField label="This job also needs" name="skills" className="w-80" defaultValue={skills.skills.join(", ")}
                     placeholder="aerial_lift, confined_space" />
        </ActionForm>
      ) : null}
    </section>
  );
}
