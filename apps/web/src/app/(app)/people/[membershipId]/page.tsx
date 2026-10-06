import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customFields, peopleRecords, people as peopleService, staffDocuments, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { CustomFieldsPanel } from "@/components/CustomFieldsPanel";
import { RecordsPanel } from "@/components/RecordsPanel";
import { Chip } from "@opentradesos/ui";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import {
  addContactAction, askToSignAction, endSkillAction, logCeAction, recordSkillAction, removeContactAction, setSkillExpiryAction,
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
  const askedFor = new Set(person.documents.map((d) => d.documentId));
  const askable = writes
    ? (await staffDocuments.list(ctx)).filter((d) => !d.retired && !askedFor.has(d.id))
    : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/people">People</Crumb>
      <h1 className="mt-1 text-xl font-semibold">{person.name ?? person.email}</h1>
      <Facts>
        <Fact label="Role">{person.roleLabel}</Fact>
        <Fact label="Email">{person.email}</Fact>
        <Fact label="Started">{person.employment?.startedOn ?? null}</Fact>
        {/*
          Said even when nobody is recorded, unlike the other facts: late work is sent
          up this line, so "nobody" is something the office needs to see, not a blank.
        */}
        <div data-testid="reports-to">
          <dt className="text-xs uppercase tracking-wide text-ink-500">Reports to</dt>
          <dd className="mt-0.5 text-sm">
            {person.reportsTo ? (
              <>
                <a href={`/people/${person.reportsTo.membershipId}`} className="hover:underline">
                  {person.reportsTo.name ?? person.reportsTo.email}
                </a>
                {person.reportsTo.active ? null : <span className="ml-2 text-amber-700">no longer works here</span>}
              </>
            ) : (
              <span className="text-ink-500">Nobody recorded</span>
            )}
            {writes ? (
              <a href="/tasks/escalation" className="ml-3 text-xs text-ink-500 underline underline-offset-4">Change</a>
            ) : null}
          </dd>
        </div>
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

      <section className="mt-8" aria-labelledby="documents">
        <h2 id="documents" className="text-base font-semibold">Documents to sign</h2>
        {person.documents.length === 0 ? (
          <p className="mt-1 text-sm text-ink-500">Nothing asked of them yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {person.documents.map((d) => (
              <li key={d.requestId} className="flex flex-wrap items-center gap-2">
                {d.signedAt ? <Chip tone="success">Signed</Chip> : <Chip tone="warning">Not yet</Chip>}
                <a href={`/people/documents/${d.documentId}`} className="hover:underline">{d.title}</a>
                {d.signedAt ? (
                  <span className="text-ink-500">
                    {formatIn(d.signedAt, user.organizationTimezone)}, {d.signedVia === "drawn" ? "drawn" : "typed"}
                    {" "}
                    <a href={`/people/documents/${d.documentId}/signed/${d.requestId}/pdf`}
                       className="text-blue-600 underline underline-offset-4"
                       aria-label={`Print ${d.title} as a PDF`}>Print as PDF</a>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {askable.length > 0 ? (
          <ActionForm action={askToSignAction} submit="Ask them to sign" tone="quiet" hidden={hidden}
                      className="mt-3 flex flex-wrap items-end gap-3">
            <Select label="Document" name="id" className="w-72" options={askable.map((d) => ({ value: d.id, label: d.title }))} />
          </ActionForm>
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
                      {s.record.expiry.state === "expired" ? <Chip tone="danger">Ran out {s.record.expiresOn}</Chip> : null}
                      {s.record.expiry.state === "expiring" ? <Chip tone="warning">Runs out {s.record.expiresOn}</Chip> : null}
                      {s.record.expiry.state === "current" ? <span className="text-ink-500">good until {s.record.expiresOn}</span> : null}
                      {writes ? (
                        <ActionForm action={setSkillExpiryAction} submit="Set last day" tone="quiet" className="flex items-center gap-2" hidden={{ ...hidden, id: s.record.id }}>
                          <input name="expiresOn" type="date" aria-label={`Last day ${s.skill} stands`} defaultValue={s.record.expiresOn ?? ""}
                                 className="h-8 rounded border border-steel-300 px-2 text-sm" />
                        </ActionForm>
                      ) : null}
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
              <TextField label="Last day it stands, if it runs out" name="expiresOn" type="date" />
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
                <li key={e.id}>
                  {e.completedOn}: {e.course}, {e.hours} hours{e.provider ? `, ${e.provider}` : ""}
                  {e.status === "pending" ? <> <Chip tone="warning">Waiting for the office</Chip></> : null}
                  {e.status === "declined" ? <> <Chip tone="danger">Declined</Chip> {e.declineReason}</> : null}
                  {e.certificates > 0 ? <> <a href={`/certifications/continuing-education/${e.id}/certificate`} target="_blank" rel="noreferrer" className="text-blue-600 underline underline-offset-4">Certificate</a></> : null}
                </li>
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
      {/* A technician's own fields: somebody who is not a technician has none to fill in. */}
      {person.technicianId ? (
        <CustomFieldsPanel
          entityType="technician" id={person.technicianId}
          definitions={await customFields.formFields(ctx, "technician")}
          values={await customFields.valuesFor(ctx, { entityType: "technician", id: person.technicianId })}
          canWrite={can(user.actor, "user:write")}
          back={`/people/${membershipId}`}
        />
      ) : null}
      <RecordsPanel ctx={ctx} link="membership" id={membershipId} back={`/people/${membershipId}`} />
    </div>
  );
}
