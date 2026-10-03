import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { peopleRecords, people as peopleService, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import {
  addContactAction, endSkillAction, logCeAction, recordSkillAction, removeContactAction,
  setEmploymentAction, setOnboardingLineAction, startOnboardingAction,
} from "../actions";

export const dynamic = "force-dynamic";

const EMPLOYMENT = [
  { value: "full_time", label: "Full time" }, { value: "part_time", label: "Part time" },
  { value: "seasonal", label: "Seasonal" }, { value: "temporary", label: "Temporary" },
  { value: "contractor", label: "Contractor" },
];
const PAY = [
  { value: "hourly", label: "Hourly" }, { value: "salary", label: "Salary" },
  { value: "piece_rate", label: "Piece rate" }, { value: "commission_only", label: "Commission only" },
];

/**
 * ONE PERSON, AS THE OFFICE KEEPS THEM
 *
 * Their onboarding against the checklist for their role, who to ring, the
 * facts of their employment (never their pay, which is payroll's), and for a
 * technician the skills the board checks with since when and what showed it,
 * and the continuing education behind their licence renewals for whoever may
 * see the compliance records.
 */
export default async function PersonPage({ params }: { params: Promise<{ membershipId: string }> }) {
  const user = await requireSetupUser();
  const { membershipId } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const person = await peopleRecords.person(ctx, { membershipId }).catch((error: unknown) => {
    if (error instanceof NotFoundError || (error as Error).name === "NotFoundError") notFound();
    throw error;
  });
  const writes = can(user.actor, "user:write");
  const compliance = person.technicianId !== null && can(user.actor, "compliance:read");
  const [ce, types] = compliance && person.technicianId
    ? await Promise.all([
        peopleRecords.continuingEducation(ctx, { technicianId: person.technicianId }),
        peopleService.listCertificationTypes(ctx),
      ])
    : [null, []];
  const hidden = { membershipId };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/people">People</Crumb>
      <h1 className="mt-1 text-xl font-semibold">{person.name ?? person.email}</h1>
      <Facts>
        <Fact label="Role">{person.roleLabel}</Fact>
        <Fact label="Email">{person.email}</Fact>
        <Fact label="Started">{person.employment?.startedOn ?? null}</Fact>
      </Facts>

      <section className="mt-8" aria-labelledby="onboarding">
        <h2 id="onboarding" className="text-base font-semibold">Onboarding</h2>
        <p className="mt-1 text-sm text-ink-700">{person.onboarding.progress.sentence}</p>
        {person.onboarding.lines.length > 0 ? (
          <ul className="mt-2 space-y-2 text-sm">
            {person.onboarding.lines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-center gap-2">
                {line.doneAt ? <Chip tone="success">Done</Chip> : <Chip tone={line.required ? "warning" : "neutral"}>{line.required ? "To do" : "Optional"}</Chip>}
                <span>{line.label}</span>
                {line.doneAt ? (
                  <span className="text-ink-500">
                    {formatIn(line.doneAt, user.organizationTimezone)}{line.doneBy ? ` by ${line.doneBy}` : ""}{line.note ? `: ${line.note}` : ""}
                  </span>
                ) : null}
                {writes ? (
                  <ActionForm action={setOnboardingLineAction} submit={line.doneAt ? "Untick" : "Done"} tone="quiet"
                              className="flex flex-wrap items-center gap-2"
                              hidden={{ ...hidden, id: line.id, done: line.doneAt ? "false" : "true" }}>
                    {line.doneAt ? null : (
                      <input name="note" aria-label={`Note for ${line.label}`} placeholder="What was seen or handed over"
                             className="h-8 w-56 rounded border border-steel-300 px-2 text-sm" />
                    )}
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {writes ? (
          <ActionForm action={startOnboardingAction} submit={person.onboarding.lines.length === 0 ? "Start onboarding" : "Add new checklist lines"}
                      tone="quiet" className="mt-3 flex flex-wrap items-center gap-3" hidden={hidden} />
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="contacts">
        <h2 id="contacts" className="text-base font-semibold">Who to ring in an emergency</h2>
        {person.emergencyContacts.length === 0 ? (
          <p className="mt-1 text-sm text-amber-700">Nobody is on file.</p>
        ) : (
          <ol className="mt-2 space-y-1 text-sm">
            {person.emergencyContacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                {c.relationship ? <span className="text-ink-500">{c.relationship}</span> : null}
                <a href={`tel:${c.phone}`} className="font-mono">{c.phone}</a>
                {c.alternatePhone ? <span className="font-mono text-ink-500">{c.alternatePhone}</span> : null}
                {c.note ? <span className="text-ink-500">{c.note}</span> : null}
                {writes ? <ActionForm action={removeContactAction} submit="Remove" tone="quiet" className="inline-flex" hidden={{ ...hidden, id: c.id }} /> : null}
              </li>
            ))}
          </ol>
        )}
        {writes ? (
          <ActionForm action={addContactAction} submit="Add contact" className="mt-3 grid gap-3 sm:grid-cols-4" hidden={hidden}>
            <TextField label="Name" name="name" required />
            <TextField label="Relationship" name="relationship" />
            <TextField label="Phone" name="phone" type="tel" required />
            <TextField label="Other phone" name="alternatePhone" type="tel" />
          </ActionForm>
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="employment">
        <h2 id="employment" className="text-base font-semibold">Employment</h2>
        <p className="mt-1 text-sm text-ink-500">How they are paid and the id payroll knows them by. What they are paid is on Payroll.</p>
        {writes ? (
          <ActionForm action={setEmploymentAction} submit="Save" className="mt-3 grid gap-3 sm:grid-cols-3" hidden={hidden} done="Saved.">
            <TextField label="Job title" name="jobTitle" defaultValue={person.employment?.jobTitle ?? ""} />
            <TextField label="Started on" name="startedOn" type="date" required defaultValue={person.employment?.startedOn ?? ""} />
            <TextField label="Left on" name="endedOn" type="date" defaultValue={person.employment?.endedOn ?? ""} />
            <Select label="Employment" name="employmentType" options={EMPLOYMENT} defaultValue={person.employment?.employmentType ?? "full_time"} />
            <Select label="Paid" name="payType" options={PAY} defaultValue={person.employment?.payType ?? "hourly"} />
            <TextField label="Payroll id" name="payrollReference" defaultValue={person.employment?.payrollReference ?? ""} />
          </ActionForm>
        ) : person.employment ? (
          <Facts>
            <Fact label="Title">{person.employment.jobTitle}</Fact>
            <Fact label="Employment">{EMPLOYMENT.find((e) => e.value === person.employment!.employmentType)?.label ?? null}</Fact>
            <Fact label="Paid">{PAY.find((p) => p.value === person.employment!.payType)?.label ?? null}</Fact>
          </Facts>
        ) : <p className="mt-1 text-sm text-ink-500">Nothing recorded.</p>}
      </section>

      {person.skills && person.technicianId ? (
        <section className="mt-8" aria-labelledby="skills">
          <h2 id="skills" className="text-base font-semibold">Skills the board checks</h2>
          {person.skills.current.length === 0 ? <p className="mt-1 text-sm text-ink-500">None recorded.</p> : (
            <ul className="mt-2 space-y-1 text-sm">
              {person.skills.current.map((s) => (
                <li key={s.skill} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{s.skill}</span>
                  {s.record ? (
                    <>
                      <span className="text-ink-700">since {s.record.since}: {s.record.evidence}</span>
                      {writes ? (
                        <ActionForm action={endSkillAction} submit="End" tone="quiet" className="flex items-center gap-2" hidden={{ ...hidden, id: s.record.id }}>
                          <input name="reason" aria-label={`Why ${s.skill} ends`} placeholder="Why it no longer stands" required
                                 className="h-8 w-48 rounded border border-steel-300 px-2 text-sm" />
                        </ActionForm>
                      ) : null}
                    </>
                  ) : <span className="text-amber-700">no date or evidence recorded</span>}
                </li>
              ))}
            </ul>
          )}
          {person.skills.orphaned.length > 0 ? (
            <p className="mt-2 text-sm text-amber-700">
              Taken off the list without being ended here: {person.skills.orphaned.map((s) => s.skill).join(", ")}.
            </p>
          ) : null}
          {writes ? (
            <ActionForm action={recordSkillAction} submit="Record skill" className="mt-3 grid gap-3 sm:grid-cols-3"
                        hidden={{ ...hidden, technicianId: person.technicianId }}>
              <TextField label="Skill" name="skill" required placeholder="brazing" />
              <TextField label="Since" name="since" type="date" required />
              <TextField label="What showed it" name="evidence" required placeholder="Signed off by Dana after three joints" />
            </ActionForm>
          ) : null}
          {person.skills.ended.length > 0 ? (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-ink-700">Ended skills</summary>
              <ul className="mt-1 space-y-1">
                {person.skills.ended.map((s) => (
                  <li key={s.id}><span className="font-mono">{s.skill}</span> {s.since} to {s.endedOn}: {s.endedReason}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {ce && person.technicianId ? (
        <section className="mt-8" aria-labelledby="ce">
          <h2 id="ce" className="text-base font-semibold">Continuing education</h2>
          {ce.progress.length === 0 ? <p className="mt-1 text-sm text-ink-500">No hours logged, and nothing held asks for any.</p> : (
            <ul className="mt-2 space-y-1 text-sm">
              {ce.progress.map((p) => (
                <li key={p.certificationTypeId}>
                  <span className="font-medium">{p.name}</span>: {p.progress.sentence}
                </li>
              ))}
            </ul>
          )}
          {ce.entries.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-ink-700">
              {ce.entries.map((e) => (
                <li key={e.id}>{e.completedOn}: {e.course}, {e.hours} hours{e.provider ? `, ${e.provider}` : ""}</li>
              ))}
            </ul>
          ) : null}
          {can(user.actor, "compliance:write") && types.length > 0 ? (
            <ActionForm action={logCeAction} submit="Log hours" className="mt-3 grid gap-3 sm:grid-cols-3"
                        hidden={{ ...hidden, technicianId: person.technicianId }}>
              <Select label="Toward" name="certificationTypeId" options={types.filter((t) => t.active).map((t) => ({ value: t.id, label: t.name }))} />
              <TextField label="Course" name="course" required />
              <TextField label="Hours" name="hours" inputMode="decimal" required />
              <TextField label="Finished on" name="completedOn" type="date" required />
              <TextField label="Provider" name="provider" />
              <TextField label="Certificate number" name="evidence" />
            </ActionForm>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
