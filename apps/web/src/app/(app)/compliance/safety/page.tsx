import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { safety } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField, TextArea } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";

import { act } from "./actions";

export const dynamic = "force-dynamic";

/**
 * TOOLBOX TALKS
 *
 * Every safety meeting the company has held, who was on the sheet and who has
 * signed. A talk is recorded here with the people who were there, and each of
 * the company's own people signs it on their phone from My day; a visitor is
 * marked signed from the paper sheet, which is photographed onto the talk.
 */
export default async function SafetyTalksPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "safety:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Toolbox talks" />
        <Empty title="Safety records are not part of your access">
          You sign the talks you were at from My day. Somebody who runs safety can show you the rest.
        </Empty>
      </div>
    );
  }

  const meetings = await safety.listMeetings(ctx);
  const writes = can(user.actor, "safety:write");
  const people = writes ? await safety.people(ctx) : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Toolbox talks" count={meetings.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        What the crew was told, when, and who signed to say they heard it. This says a talk happened; it
        does not say whether it was the talk the job needed.
      </p>

      {meetings.length === 0 ? (
        <Empty title="No talks recorded yet">Record the next one below and your people sign it from their phones.</Empty>
      ) : (
        <Table label="Toolbox talks" head={<><Th>When</Th><Th>Topic</Th><Th>Signed</Th><Th>Sheet</Th></>}>
          {meetings.map((meeting) => (
            <tr key={meeting.id}>
              <Td className="whitespace-nowrap">{formatIn(meeting.heldAt, zone)}</Td>
              <Td>
                <a href={`/compliance/safety/${meeting.id}`} className="font-medium text-blue-600 underline underline-offset-4">
                  {meeting.topic}
                </a>
                {meeting.location ? <span className="block text-xs text-ink-500">{meeting.location}</span> : null}
              </Td>
              <Td>{meeting.signed} of {meeting.attendees.length}</Td>
              <Td>{meeting.closedAt ? <Chip tone="neutral">Closed</Chip> : <Chip tone="info">Open for signatures</Chip>}</Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Record a talk</h2>
          <ActionForm action={act} submit="Record the talk" hidden={{ op: "create" }}>
            <TextField label="Topic" name="topic" required maxLength={300} placeholder="Ladder safety" />
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField label="When" name="heldAt" type="datetime-local" required />
              <TextField label="Where" name="location" maxLength={300} placeholder="The shop" />
              <TextField label="Led by" name="ledBy" maxLength={200} />
            </div>
            <TextArea label="What was covered" name="notes" rows={3} />
            <fieldset>
              <legend className="text-sm font-medium text-ink-700">Who was there</legend>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
                {people.map((person) => (
                  <label key={person.value} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="technicianIds" value={person.value} />
                    {person.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <TextField label="Anybody else, separated by commas" name="visitors" placeholder="A supplier's rep, a subcontractor" />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
