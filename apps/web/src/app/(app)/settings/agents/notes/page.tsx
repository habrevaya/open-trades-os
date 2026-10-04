import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { knowledge } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { PageHeader, Empty } from "@/components/Table";
import { ActionForm, TextField, TextArea } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { changeNote, removeNote, writeNote } from "./actions";

export const dynamic = "force-dynamic";

/**
 * SETTINGS → AI AGENTS → HOW-TO NOTES
 *
 * How this company does a job, written down: what the field assistant
 * answers a technician's "how do we do this here" from, and from nothing
 * else. A procedure it has not been given, it says it has not been given.
 * Read by anybody who reads jobs; written by whoever may write them
 * (`knowledge:write`, the service manager by default).
 */
export default async function NotesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "job:read")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="How-to notes" />
        <Empty title="Not shown to your role">Reading the how-to notes needs the View jobs permission.</Empty>
      </div>
    );
  }

  const writes = can(user.actor, "knowledge:write");
  const { notes } = await knowledge.list(ctx);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <PageHeader title="How-to notes" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        How your company does a job, in your own words. When a technician asks the field assistant how to do
        something, it answers from these notes and nothing else, and says so when there is no note for it.
        Keep each one to one job, with its steps in order.
      </p>
      <p className="mt-2 text-sm"><a href="/settings/agents" className="text-blue-600 underline underline-offset-4">Back to the AI agents</a></p>

      {writes ? (
        <section aria-label="Write a note" className="mt-6 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">Write a note</h2>
          <ActionForm action={writeNote} submit="Save note" className="mt-3 space-y-3">
            <TextField label="What it is about" name="title" required maxLength={200} placeholder="Flushing a tankless water heater" />
            <TextArea label="How it is done" name="body" rows={6} required maxLength={10000}
                      placeholder={"1. Turn off the power and the gas.\n2. Close the isolation valves..."} />
            <TextField label="Other words somebody might ask with, separated by commas" name="tags"
                       placeholder="Rinnai, descale, scale" />
          </ActionForm>
        </section>
      ) : null}

      {notes.length === 0 ? (
        <div className="mt-6">
          <Empty title="No notes yet">Until there are, the assistant answers how-to questions with &ldquo;there is no note for that&rdquo;.</Empty>
        </div>
      ) : notes.map((note) => (
        <section key={note.id} aria-label={note.title} className="mt-6 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">{note.title}</h2>
          <p className="mt-1 text-xs text-ink-500">
            Changed {formatIn(note.updatedAt, user.organizationTimezone)}{note.updatedByName ? ` by ${note.updatedByName}` : ""}
            {note.tags.length > 0 ? `. Also asked as: ${note.tags.join(", ")}` : ""}
          </p>
          {writes ? (
            <>
              <ActionForm action={changeNote} submit="Save changes" hidden={{ id: note.id }} className="mt-3 space-y-3">
                <TextField label="What it is about" name="title" required maxLength={200} defaultValue={note.title} />
                <TextArea label="How it is done" name="body" rows={6} required maxLength={10000} defaultValue={note.body} />
                <TextField label="Other words somebody might ask with" name="tags" defaultValue={note.tags.join(", ")} />
              </ActionForm>
              <ActionForm action={removeNote} submit="Stop answering from this note" tone="danger" hidden={{ id: note.id }} className="mt-3" />
            </>
          ) : (
            <p className="mt-3 whitespace-pre-line text-sm text-ink-900">{note.body}</p>
          )}
        </section>
      ))}
    </div>
  );
}
