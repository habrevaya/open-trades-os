import { notFound, redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects, NotFoundError } from "@opentradesos/api/services";
import { customObjects as rules, PermissionError } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { ListSearch, searchWords } from "@/components/ListSearch";
import { setRecordLink } from "../../../actions";
import { choicesFor, HINT as hint, listedLink, PLURAL, type Choice } from "../choices";

export const dynamic = "force-dynamic";

/**
 * POINT A RECORD AT SOMETHING ELSE
 *
 * One link at a time (`?to=job`), found the way the search box finds things:
 * a job by its number or its words, a customer by name, an address by its
 * street, a unit by its serial or make, an invoice by its number. Each is
 * read through the list the writer is already narrowed on, so a technician is
 * offered the work they were sent to and a branch manager their branch's,
 * and pressing "Point at this one" is checked again by the service, which
 * refuses in words anything they could not open. A person is chosen from the
 * people they may see, and a record from the records of the kind this kind
 * points at.
 */
export default async function RecordLinkPage({
  params, searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<{ to?: string; q?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { type, id } = await params;
  const query = await searchParams;
  const record = await customObjects.getRecord(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof PermissionError) notFound();
    throw error;
  });
  if (record.type !== type) redirect(`/records/${record.type}/${id}`);
  const kind = record.kind;
  const to = kind.links.find((link) => link === query.to);
  if (!to || !record.canWrite) notFound();
  const label = rules.LINK_LABEL[to].toLowerCase();
  const q = searchWords(query.q);
  const back = `/records/${type}/${id}`;

  const listed = listedLink(to);
  const { choices, unreadable }: { choices: Choice[]; unreadable: boolean } = await choicesFor(ctx, kind, to, q, id);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href={back}>{`${kind.label} ${record.title}`}</Crumb>
      <div className="mt-2"><PageHeader title={`Choose the ${label}`} /></div>
      <p className="mt-1 text-sm text-ink-500">
        You can only choose a {label} you can open. The one it points at now is replaced.
      </p>
      <ListSearch action={`/records/${type}/${id}/link`} q={q} label={`Find the ${label}`} placeholder={hint[to]} keep={{ to }} />

      {unreadable ? (
        <Empty title={`Your access does not include ${PLURAL[to]}`}>
          Somebody who can change roles can turn this on for you.
        </Empty>
      ) : !listed && (!q || q.length < 2) ? (
        <p className="mt-6 text-sm text-ink-500">Type at least two letters or a number to find it.</p>
      ) : choices.length === 0 ? (
        <Empty title="Nothing found">Nothing you can open matches{q ? ` "${q}"` : ""}.</Empty>
      ) : (
        <ul aria-label="Choices" className="mt-4 divide-y divide-steel-200 rounded-md border border-steel-200 text-sm">
          {choices.map((choice) => (
            <li key={choice.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{choice.title}</span>
                {choice.detail ? <span className="ml-2 text-ink-500">{choice.detail}</span> : null}
              </span>
              <ActionForm action={setRecordLink} submit="Point at this one" tone="quiet" className=""
                          hidden={{ id, type, link: to, value: choice.id }} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
