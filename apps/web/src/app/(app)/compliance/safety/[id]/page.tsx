import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { safety } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { act } from "../actions";
import { HoldPanel } from "@/components/HoldPanel";

export const dynamic = "force-dynamic";

/**
 * ONE TALK AND ITS SIGN IN SHEET
 *
 * Who was on it, who signed and how: on their own phone, or marked from the
 * paper sheet in the office, which says so on the line. Closing the sheet is
 * what makes it a record of who was in the room; after that nobody is added
 * and nobody signs.
 */
export default async function SafetyTalkPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "safety:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Toolbox talk" />
        <Empty title="Safety records are not part of your access">You sign your own line from My day.</Empty>
      </div>
    );
  }

  const meeting = await safety.getMeeting(ctx, { id }).catch((error: Error) => {
    if (error.name === "NotFoundError") notFound();
    throw error;
  });
  const writes = can(user.actor, "safety:write");
  const open = meeting.closedAt === null;
  const people = writes && open ? await safety.people(ctx) : [];
  const onList = new Set(meeting.attendees.map((a) => a.technicianId).filter(Boolean));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/compliance/safety">Toolbox talks</Crumb>
      <PageHeader title={meeting.topic} />
      <Facts>
        <Fact label="When">{formatIn(meeting.heldAt, zone)}</Fact>
        <Fact label="Where">{meeting.location ?? "Not said"}</Fact>
        <Fact label="Led by">{meeting.ledBy ?? "Not said"}</Fact>
        <Fact label="Sheet">{open ? "Open for signatures" : `Closed ${formatIn(meeting.closedAt!, zone)}`}</Fact>
      </Facts>
      {meeting.notes ? <p className="mt-4 whitespace-pre-wrap text-sm text-ink-700">{meeting.notes}</p> : null}

      <h2 className="mt-8 text-base font-semibold">Sign in sheet: {meeting.signed} of {meeting.attendees.length} signed</h2>
      {meeting.attendees.length === 0 ? (
        <Empty title="Nobody on the sheet">Add the people who were there.</Empty>
      ) : (
        <Table label="Sign in sheet" head={<><Th>Name</Th><Th>Signed</Th><Th>{""}</Th></>}>
          {meeting.attendees.map((attendee) => (
            <tr key={attendee.id}>
              <Td>{attendee.name}</Td>
              <Td>
                {attendee.signedAt ? (
                  <>
                    <Chip tone="success">{attendee.signedVia === "field" ? "Signed on their phone" : "Marked from the paper sheet"}</Chip>
                    <span className="ml-2 text-xs text-ink-500">{formatIn(attendee.signedAt, zone)}</span>
                  </>
                ) : <Chip tone="warning">Not signed</Chip>}
              </Td>
              <Td>
                {writes && open && !attendee.signedAt ? (
                  <ActionForm action={act} className="" tone="quiet" submit="Signed on paper"
                              hidden={{ op: "signed", id: meeting.id, attendeeId: attendee.id }} />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-8 text-base font-semibold">Photographs</h2>
      {meeting.photos.length === 0 ? (
        <p className="mt-1 text-sm text-ink-500">None. A photograph of the paper sheet is the evidence for anybody marked from it.</p>
      ) : (
        <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {meeting.photos.map((photo) => (
            <li key={photo.id}>
              <a href={`/files/${photo.storageKey}`} className="text-sm text-blue-600 underline underline-offset-4">
                {photo.fileName ?? "Photograph"}
              </a>
            </li>
          ))}
        </ul>
      )}

      {writes && open ? (
        <section className="mt-10 space-y-8">
          <div>
            <h2 className="text-base font-semibold">Add a photograph</h2>
            <ActionForm action={act} submit="Keep it with the talk" hidden={{ op: "photo", id: meeting.id }}>
              <input type="file" name="file" accept="image/*" required aria-label="Photograph" className="block text-sm" />
            </ActionForm>
          </div>
          <div>
            <h2 className="text-base font-semibold">Add people</h2>
            <ActionForm action={act} submit="Add to the sheet" hidden={{ op: "add", id: meeting.id }}>
              <div className="grid gap-1.5 sm:grid-cols-3">
                {people.filter((p) => !onList.has(p.value)).map((person) => (
                  <label key={person.value} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="technicianIds" value={person.value} />
                    {person.label}
                  </label>
                ))}
              </div>
              <TextField label="Anybody else, separated by commas" name="visitors" />
            </ActionForm>
          </div>
          <div>
            <h2 className="text-base font-semibold">Close the sheet</h2>
            <p className="mt-1 text-sm text-ink-500">Once everybody who was there has signed. Nobody can sign or be added after.</p>
            <ActionForm action={act} submit="Close the sheet" tone="quiet" hidden={{ op: "close", id: meeting.id }} />
          </div>
        </section>
      ) : null}
      <HoldPanel ctx={ctx} entityType="safety_meeting" entityId={meeting.id} path={`/compliance/safety/${meeting.id}`}
                 label="this talk and its signatures" timezone={zone} />
    </div>
  );
}
