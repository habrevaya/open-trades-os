import { notFound, redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects, NotFoundError } from "@opentradesos/api/services";
import { customObjects as rules, PermissionError } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { PageHeader } from "@/components/Table";
import { setRecordLinks } from "../../../actions";
import { choicesFor, HINT, listedLink, PLURAL } from "../choices";

export const dynamic = "force-dynamic";

const box = "h-9 rounded border border-steel-300 px-2 text-sm";

/**
 * CHANGE SEVERAL OF A RECORD'S LINKS AT ONCE
 *
 * The page that changes one link finds the new one by words and saves it on
 * its own; this one does every link the kind offers in one go. Type words in
 * as many boxes as needed and press "Find", then pick one for each link (or
 * "Keep it as it is", or "Take it off") and press "Save these changes": the
 * service gets one change with all of them, checks each as it does when a
 * record is made, and refuses the whole change in words when any one is
 * wrong, so a record is never left half moved. What is typed travels in the
 * address, so finding again keeps the other boxes.
 */
export default async function RecordLinksPage({
  params, searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { type, id } = await params;
  const query = await searchParams;
  const record = await customObjects.getRecord(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof PermissionError) notFound();
    throw error;
  });
  if (record.type !== type) redirect(`/records/${record.type}/${id}/links`);
  if (!record.canWrite) notFound();
  const kind = record.kind;
  const back = `/records/${type}/${id}`;
  const words = (link: rules.Link) => {
    const value = query[`q_${link}`];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const current: Record<rules.Link, { id: string; name: string } | null> = {
    customer: record.customer, property: record.property, job: record.job, equipment: record.equipment,
    invoice: record.invoice, membership: record.membership, record: record.record,
  };
  const found = await Promise.all(kind.links.map(async (link) => ({
    link, q: words(link), ...(await choicesFor(ctx, kind, link, words(link), id)),
  })));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href={back}>{`${kind.label} ${record.title}`}</Crumb>
      <div className="mt-2"><PageHeader title="Change what it points at" /></div>
      <p className="mt-1 text-sm text-ink-500">
        Change as many as you need, then save once. Nothing changes until you save, and if one of them is wrong nothing
        changes at all. You can only choose things you can open.
      </p>

      <form method="get" action={`/records/${type}/${id}/links`} className="mt-4 space-y-2" aria-label="Find what to point at">
        {kind.links.filter((link) => link !== "membership" && link !== "record").map((link) => (
          <label key={link} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-24 text-ink-700">{rules.LINK_LABEL[link]}</span>
            <input name={`q_${link}`} defaultValue={words(link) ?? ""} placeholder={HINT[link]}
                   aria-label={`Find the ${rules.LINK_LABEL[link].toLowerCase()}`} className={`${box} min-w-0 flex-1`} />
          </label>
        ))}
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
          Find
        </button>
      </form>

      <ActionForm action={setRecordLinks} submit="Save these changes" hidden={{ id, type }} className="mt-6 space-y-5">
        {found.map(({ link, q, choices, unreadable }) => {
          const label = rules.LINK_LABEL[link];
          const now = current[link];
          return (
            <fieldset key={link} className="rounded-md border border-steel-200 p-3">
              <legend className="px-1 text-sm font-semibold">{label}</legend>
              <p className="text-sm text-ink-500">Now: {now ? (now.name || "One you cannot open") : "Nothing"}</p>
              <div className="mt-2 space-y-1 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name={`link_${link}`} value="" defaultChecked /> Keep it as it is
                </label>
                {now ? (
                  <label className="flex items-center gap-2">
                    <input type="radio" name={`link_${link}`} value="none" /> Take it off
                  </label>
                ) : null}
                {unreadable ? (
                  <p className="text-ink-500">Your access does not include {PLURAL[link]}.</p>
                ) : !listedLink(link) && (!q || q.length < 2) ? (
                  <p className="text-ink-500">Type at least two letters or a number above and press Find to choose another.</p>
                ) : choices.length === 0 ? (
                  <p className="text-ink-500">Nothing you can open matches{q ? ` "${q}"` : ""}.</p>
                ) : choices.filter((c) => c.id !== now?.id).map((choice) => (
                  <label key={choice.id} className="flex items-center gap-2">
                    <input type="radio" name={`link_${link}`} value={choice.id} aria-label={`${label}: ${choice.title}`} />
                    <span className="font-medium">{choice.title}</span>
                    {choice.detail ? <span className="text-ink-500">{choice.detail}</span> : null}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </ActionForm>
    </div>
  );
}
