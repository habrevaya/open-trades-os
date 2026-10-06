import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { safetyTalks } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { Empty, PageHeader } from "@/components/Table";
import { addTopic, setTopicRetired } from "../talk-actions";

export const dynamic = "force-dynamic";

/**
 * THE COMPANY'S OWN TALK TOPICS
 *
 * A title and the words to cover, written here by the company. The library
 * starts empty: this product ships no safety content, because what a crew is
 * told is the company's to decide. A talk held from a topic keeps a copy of
 * its words, so changing a topic later does not change a sheet already signed.
 */
export default async function TalkTopicsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "safety:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Talk topics" />
        <Empty title="Safety records are not part of your access">Somebody who runs safety can show you the library.</Empty>
      </div>
    );
  }
  const topics = await safetyTalks.listTopics(ctx, { includeRetired: true });
  const writes = can(user.actor, "safety:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/compliance/safety">Toolbox talks</Crumb>
      <PageHeader title="Talk topics" count={topics.filter((t) => !t.retired).length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Your own topics, in your own words. Nothing is put here for you: write what your crews need to hear,
        and hold a talk from it or put it on a schedule.
      </p>

      {topics.length === 0 ? (
        <Empty title="No topics yet">Add the first one below.</Empty>
      ) : (
        <ul className="mt-6 space-y-3">
          {topics.map((topic) => (
            <li key={topic.id} className="rounded-md border border-steel-200 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="font-medium">{topic.title}</h2>
                {topic.retired ? <Chip tone="neutral">Retired</Chip> : null}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{topic.body}</p>
              {writes ? (
                <ActionForm action={setTopicRetired} tone="quiet" className="mt-2"
                            submit={topic.retired ? "Put it back" : "Retire it"}
                            hidden={{ id: topic.id, retired: topic.retired ? "no" : "yes" }} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {writes ? (
        <section aria-label="Add a topic" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">Add a topic</h2>
          <ActionForm action={addTopic} submit="Add topic" className="mt-3 space-y-3">
            <TextField label="Title" name="title" required maxLength={200} />
            <TextArea label="What the talk covers" name="body" rows={6} required maxLength={20000} />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
