import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { staffDocuments } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { createDocumentAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * DOCUMENTS THE COMPANY ASKS ITS PEOPLE TO SIGN
 *
 * The handbook, the drug and alcohol policy, the vehicle use agreement: the
 * words written once here, then each person signs their own from My record,
 * by typing their name or drawing it. The words cannot be edited after, so a
 * signature always sits under the words that were shown; a new version is a
 * new document, and retiring the old one keeps its signatures.
 */
export default async function DocumentsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "user:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Documents to sign" />
        <Empty title="The staff list is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const documents = await staffDocuments.list(ctx);
  const writes = can(user.actor, "user:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Documents to sign" count={documents.length} />
      {documents.length === 0 ? (
        <Empty title="None yet">Write the first one below: the handbook is where most companies start.</Empty>
      ) : (
        <Table head={<><Th>Document</Th><Th>Written</Th><Th className="text-right">Signed</Th></>}>
          {documents.map((d) => (
            <tr key={d.id}>
              <Td>
                <a href={`/people/documents/${d.id}`} className="font-medium hover:underline">{d.title}</a>
                {d.retired ? <Chip tone="neutral" className="ml-2">Retired</Chip> : null}
              </Td>
              <Td className="text-ink-700">{formatIn(d.createdAt, user.organizationTimezone, { month: "short", day: "numeric", year: "numeric" })}</Td>
              <Td className="text-right tabular-nums">{d.signed} of {d.asked}</Td>
            </tr>
          ))}
        </Table>
      )}
      {writes ? (
        <section className="mt-10" aria-labelledby="write">
          <h2 id="write" className="text-base font-semibold">Write a document</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            Paste the words people are agreeing to. They cannot be changed afterwards; to change them, write the
            new version and retire this one.
          </p>
          <ActionForm action={createDocumentAction} submit="Save the document" className="mt-3 max-w-2xl space-y-3">
            <TextField label="Title" name="title" required maxLength={200} placeholder="Employee handbook" />
            <TextArea label="The words they sign" name="body" required rows={10} maxLength={100000} />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
