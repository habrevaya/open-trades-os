import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * RECORDS: THE COMPANY'S OWN KINDS
 *
 * Every kind of record the company defined that this person may see, each a
 * door to its own list. Nothing here is a kind the product ships: those have
 * their own places in the rail.
 */
export default async function RecordsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "record:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Records" />
        <Empty title="Records are not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const kinds = await customObjects.listKinds(ctx);
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Records" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The lists your company keeps of its own: permits, registrations, inspections.
        {can(user.actor, "customfield:write") ? <> Define a new kind on <a href="/settings/records" className="underline underline-offset-4">Settings, Kinds of record</a>.</> : null}
      </p>
      {kinds.length === 0 ? (
        <Empty title="No kinds of record yet">An owner defines them under Settings, Kinds of record.</Empty>
      ) : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {kinds.map((kind) => (
            <li key={kind.key} className="rounded-md border border-steel-200 p-4">
              <a href={`/records/${kind.key}`} className="font-medium underline underline-offset-4">{kind.pluralLabel}</a>
              {kind.description ? <p className="mt-1 text-sm text-ink-700">{kind.description}</p> : null}
              <p className="mt-1 text-xs text-ink-500">
                {kind.fields.length === 1 ? "1 field" : `${kind.fields.length} fields`}
                {kind.canWrite ? "" : ". You can read these and not change them"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
