import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { safety } from "@opentradesos/api/services";
import { can, safety as rules } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { HoldPanel } from "@/components/HoldPanel";
import { formatIn } from "@/lib/dates";
import { act } from "../actions";

export const dynamic = "force-dynamic";

/**
 * ONE INCIDENT REPORT
 *
 * What happened in the reporter's words, never rewritten, who was there and
 * how, the photographs, and the follow up: each action a task in the office
 * queue, so it is chased by the same queue as everything else. It closes with
 * a sentence about what was learned, and not while a follow up is open.
 */
export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "safety:read") && !can(user.actor, "safety:report")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="Incident report" />
        <Empty title="Safety records are not part of your access">Somebody who can change roles can turn this on.</Empty>
      </div>
    );
  }

  const incident = await safety.getIncident(ctx, { id }).catch((error: Error) => {
    if (error.name === "NotFoundError") notFound();
    throw error;
  });
  const writes = can(user.actor, "safety:write");
  const open = incident.status === "open";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/compliance/incidents">Incidents</Crumb>
      <PageHeader title={rules.INCIDENT_KIND_WORDS[incident.kind].split(":")[0]!} />
      <p className="mt-1">{open ? <Chip tone="warning">Open</Chip> : <Chip tone="neutral">Closed</Chip>}</p>
      <Facts>
        <Fact label="When">{formatIn(incident.occurredAt, zone)}</Fact>
        <Fact label="Where">{incident.location ?? "Not said"}</Fact>
        <Fact label="Reported">{formatIn(incident.createdAt, zone)}</Fact>
      </Facts>

      <h2 className="mt-6 text-base font-semibold">What happened</h2>
      <p className="mt-1 whitespace-pre-wrap text-sm text-ink-900">{incident.description}</p>
      {incident.immediateAction ? (
        <>
          <h2 className="mt-4 text-base font-semibold">What was done straight away</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink-900">{incident.immediateAction}</p>
        </>
      ) : null}

      <h2 className="mt-6 text-base font-semibold">Who was there</h2>
      {incident.people.length === 0 ? <p className="mt-1 text-sm text-ink-500">Nobody named.</p> : (
        <ul className="mt-1 space-y-1 text-sm">
          {incident.people.map((person) => (
            <li key={person.id}>
              {person.name}: {rules.PERSON_ROLE_WORDS[person.role]}
              {person.injury ? <span className="text-ink-700"> ({person.injury})</span> : null}
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-6 text-base font-semibold">Photographs</h2>
      {incident.photos.length === 0 ? <p className="mt-1 text-sm text-ink-500">None.</p> : (
        <ul className="mt-1 space-y-1 text-sm">
          {incident.photos.map((photo) => (
            <li key={photo.id}>
              <a href={`/files/${photo.storageKey}`} className="text-blue-600 underline underline-offset-4">{photo.fileName ?? "Photograph"}</a>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <ActionForm action={act} submit="Add a photograph" tone="quiet" hidden={{ op: "photo", id: incident.id }}>
          <input type="file" name="file" accept="image/*" required aria-label="Photograph" className="block text-sm" />
        </ActionForm>
      ) : null}

      <h2 className="mt-8 text-base font-semibold">Follow up</h2>
      {incident.followUps.length === 0 ? <p className="mt-1 text-sm text-ink-500">Nothing yet.</p> : (
        <ul className="mt-1 space-y-1 text-sm">
          {incident.followUps.map((task) => (
            <li key={task.id}>
              <a href={`/tasks/${task.id}`} className="text-blue-600 underline underline-offset-4">{task.title}</a>
              <span className="ml-2 text-ink-500">{task.status.replace("_", " ")}</span>
            </li>
          ))}
        </ul>
      )}

      {writes && open ? (
        <section className="mt-6 space-y-8">
          <ActionForm action={act} submit="Add to the task queue" hidden={{ op: "follow-up", id: incident.id }}>
            <TextField label="Something to do because of it" name="title" required maxLength={300}
                       placeholder="Put edge guards in every van" />
            <TextField label="By when (optional)" name="dueAt" type="datetime-local" />
          </ActionForm>
          <ActionForm action={act} submit="Close the report" tone="quiet" hidden={{ op: "close", id: incident.id }}>
            <TextArea label="What was learned or changed" name="closingNote" rows={3} required />
          </ActionForm>
        </section>
      ) : null}
      {!open && incident.closingNote ? (
        <>
          <h2 className="mt-6 text-base font-semibold">What was learned</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{incident.closingNote}</p>
        </>
      ) : null}
      <HoldPanel ctx={ctx} entityType="incident_report" entityId={incident.id} path={`/compliance/incidents/${incident.id}`}
                 label="this report" timezone={zone} />
    </div>
  );
}
