import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { staffDocuments, team, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Empty, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { askToSignAction, retireDocumentAction } from "../../actions";

export const dynamic = "force-dynamic";

/**
 * ONE DOCUMENT: THE WORDS, WHO WAS ASKED, AND WHO SIGNED
 *
 * Each signature says how it was given, typed or drawn, and under what name.
 * The hash beside the title is what every one of those signatures carries,
 * so "which words did Ray sign" has an answer that does not depend on this
 * page.
 */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "user:read")) notFound();
  const doc = await staffDocuments.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError || (error as Error).name === "NotFoundError") notFound();
    throw error;
  });
  const writes = can(user.actor, "user:write");
  const asked = new Set(doc.requests.map((r) => r.membershipId));
  const people = writes && !doc.retiredAt
    ? (await team.roster(ctx)).filter((p) => p.active && !asked.has(p.membershipId))
    : [];
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/people/documents">Documents to sign</Crumb>
      <h1 className="mt-1 text-xl font-semibold">
        {doc.title}
        {doc.retiredAt ? <Chip tone="neutral" className="ml-2 align-middle">Retired</Chip> : null}
      </h1>
      <p className="mt-1 break-all font-mono text-xs text-ink-500">Fingerprint of the words: {doc.bodyHash}</p>
      <div className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap rounded border border-steel-200 bg-steel-100 p-4 text-sm text-ink-700">
        {doc.body}
      </div>

      <section className="mt-8" aria-labelledby="signatures">
        <h2 id="signatures" className="text-base font-semibold">Who was asked</h2>
        {doc.requests.length === 0 ? (
          <Empty title="Nobody yet">Ask people below, or put it on a role&apos;s onboarding checklist.</Empty>
        ) : (
          <Table head={<><Th>Person</Th><Th>Asked</Th><Th>Signed</Th></>}>
            {doc.requests.map((r) => (
              <tr key={r.id}>
                <Td><a href={`/people/${r.membershipId}`} className="font-medium hover:underline">{r.name}</a></Td>
                <Td className="text-ink-700">{formatIn(r.askedAt, zone)}</Td>
                <Td>
                  {r.signedAt ? (
                    <span>
                      <Chip tone="success">Signed</Chip>{" "}
                      <span className="text-ink-700">
                        {formatIn(r.signedAt, zone)}, {r.signedVia === "drawn" ? "drawn" : `typed as ${r.signerName ?? ""}`}
                      </span>{" "}
                      <a href={`/people/documents/${doc.id}/signed/${r.id}/pdf`}
                         className="text-blue-600 underline underline-offset-4"
                         aria-label={`Print ${r.name}'s signed copy as a PDF`}>Print as PDF</a>
                    </span>
                  ) : <Chip tone="warning">Not yet</Chip>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {writes && !doc.retiredAt ? (
        <>
          {people.length > 0 ? (
            <section className="mt-8" aria-labelledby="ask">
              <h2 id="ask" className="text-base font-semibold">Ask people to sign it</h2>
              <ActionForm action={askToSignAction} submit="Ask them" hidden={{ id: doc.id }} className="mt-3 space-y-3">
                <fieldset className="grid gap-2 sm:grid-cols-2">
                  <legend className="sr-only">Who to ask</legend>
                  {people.map((p) => (
                    <label key={p.membershipId} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="membershipId" value={p.membershipId} className="h-4 w-4" />
                      {p.name ?? p.email}
                    </label>
                  ))}
                </fieldset>
              </ActionForm>
            </section>
          ) : null}
          <section className="mt-8">
            <ActionForm action={retireDocumentAction} submit="Retire this document" tone="danger" hidden={{ id: doc.id }}
                        className="flex flex-col items-start gap-2" />
            <p className="mt-1 text-sm text-ink-500">Nobody new is asked to sign it. Everybody who signed stays signed.</p>
          </section>
        </>
      ) : null}
    </div>
  );
}
