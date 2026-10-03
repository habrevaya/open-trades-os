import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { forms } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField } from "@/components/ActionForm";
import { startForm } from "./actions";

export const dynamic = "force-dynamic";

/**
 * LEAD FORMS
 *
 * Every form the company collects leads with, its hosted page, and what each
 * one is losing: a submission refused for a field is kept, and the count of
 * refusals is where somebody learns the phone box rejects a leading 1.
 */
export default async function FormsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const list = await forms.list(ctx);
  const writes = can(user.actor, "adspend:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Lead forms" count={list.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Each form has its own page to link to from an ad, a flyer or your website, which works with or
        without the website snippet. A submission makes or matches the customer, keeps the consent they
        ticked in the words they saw, and puts a call back in the office queue.
      </p>
      {list.length === 0 ? (
        <Empty title="No forms yet">Start one below. It begins with the fields every lead form needs.</Empty>
      ) : (
        <Table label="Lead forms" head={<><Th>Form</Th><Th>Fields</Th><Th>Page</Th></>}>
          {list.map((f) => (
            <tr key={f.id}>
              <Td><a href={`/marketing/forms/${encodeURIComponent(f.slug)}`} className="font-medium underline underline-offset-4">{f.title}</a></Td>
              <Td className="text-ink-700">{f.fields}</Td>
              <Td>{f.publicKey ? <a href={`/f/${f.publicKey}`} className="font-mono text-xs underline underline-offset-4">/f/{f.publicKey}</a> : null}</Td>
            </tr>
          ))}
        </Table>
      )}
      {writes && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Start a form</h2>
          <ActionForm action={startForm} submit="Start form" className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="Title" name="title" required placeholder="Free AC check" />
            <TextField label="Short name" name="slug" required pattern="[a-z0-9-]+" placeholder="ac-check" />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
