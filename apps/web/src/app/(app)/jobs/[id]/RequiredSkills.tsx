import { getDb } from "@/lib/db";
import { peopleRecords } from "@opentradesos/api/services";
import { can, type Actor } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { dropJobSkillAction, restoreJobSkillAction, setJobSkillsAction } from "./skills-actions";

/**
 * WHAT THIS JOB NEEDS OF WHOEVER IS SENT
 *
 * The job type's skills, which every job of the type needs, any this one job
 * asks for beyond them (a lift ticket for a rooftop unit, a confined space
 * entry for a crawlspace) and any of the type's it does not need, each with the
 * reason it was dropped. The extra ones are checked wherever the type's are,
 * on the board, at booking and in the suggestions; a dropped one is not asked
 * of anybody on this job, and the board says so when somebody is sent.
 *
 * Dropping one is the office manager's call, the same people who may send
 * somebody unqualified, because it has the same effect. Putting it back is
 * anybody who can edit the job.
 */
export async function RequiredSkills({ jobId, actor, writes }: { jobId: string; actor: Actor; writes: boolean }) {
  const skills = await peopleRecords.jobSkills({ actor, db: getDb() }, { id: jobId });
  if (!writes && skills.skills.length === 0 && skills.typeSkills.length === 0) return null;
  const droppedNames = new Set(skills.dropped.map((d) => d.skill));
  const droppable = skills.typeSkills.filter((s) => !droppedNames.has(s));
  const mayDrop = can(actor, "job:write") && can(actor, "visit:assign_unqualified");
  return (
    <section className="mt-6" aria-labelledby="required-skills">
      <h2 id="required-skills" className="text-sm font-medium text-ink-700">Skills this work needs</h2>
      <p className="mt-1 text-sm text-ink-700">
        {skills.typeSkills.length > 0 ? `From its job type: ${skills.typeSkills.join(", ")}. ` : "Its job type asks for none. "}
        {skills.skills.length > 0 ? `This job also: ${skills.skills.join(", ")}.` : ""}
      </p>
      {skills.dropped.length > 0 && (
        <ul className="mt-2 space-y-2 text-sm" aria-label="Skills this job does not need">
          {skills.dropped.map((d) => (
            <li key={d.skill} className="rounded-md border border-steel-200 bg-steel-100 p-3">
              <p>
                <span className="font-medium">Not needed on this job: {d.skill}.</span>{" "}
                {d.reason}
                <span className="text-ink-500"> {d.droppedBy ? `Dropped by ${d.droppedBy}` : "Dropped"} on {d.droppedAt.slice(0, 10)}.</span>
              </p>
              {writes && (
                <ActionForm action={restoreJobSkillAction} submit="Ask for it again" tone="quiet" className="mt-2"
                            hidden={{ jobId, skill: d.skill }} />
              )}
            </li>
          ))}
        </ul>
      )}
      {writes ? (
        <ActionForm action={setJobSkillsAction} submit="Save skills" tone="quiet" className="mt-2 flex flex-wrap items-end gap-3"
                    hidden={{ jobId }} done="Saved.">
          <TextField label="This job also needs" name="skills" className="w-80" defaultValue={skills.skills.join(", ")}
                     placeholder="aerial_lift, confined_space" />
        </ActionForm>
      ) : null}
      {mayDrop && droppable.length > 0 && (
        <div role="group" aria-label="This job does not need one of them" className="mt-4 max-w-xl">
          <h3 className="text-sm font-medium text-ink-700">This job does not need one of them</h3>
          <p className="mt-1 text-xs text-ink-500">
            Nobody will be asked for it on this job, on the board or when booking. Say why. The reason stays on the job.
          </p>
          <ActionForm action={dropJobSkillAction} submit="Drop it for this job" tone="quiet" className="mt-2 space-y-3"
                      hidden={{ jobId }} done="Dropped.">
            <label className="block">
              <span className="text-sm font-medium text-ink-700">Skill</span>
              <select name="skill" required defaultValue="" className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                <option value="" disabled>Choose a skill</option>
                {droppable.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <TextField label="Why this job does not need it" name="reason" required />
          </ActionForm>
        </div>
      )}
    </section>
  );
}
