import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inspections, priceBook } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { ProgramEditor, type Checkpoint } from "../ProgramEditor";
import { kindOf } from "../kinds";
import { discardDraft, setOffered } from "../actions";
import { AUDIENCE, PART, SEVERITY, packName, sourceLine } from "../words";

export const dynamic = "force-dynamic";

/**
 * ONE PROGRAMME: THE VERSION IN FORCE, AND EVERY ONE BEFORE IT
 *
 * Somebody who may write compliance records changes it here, and saving
 * publishes the next version; everybody else who may read inspections sees it
 * as it stands. `?version=2` shows version 2 as it was published, which is
 * what an inspection done under it was asked.
 *
 * A DRAFT opens in the editor to be saved again or published, with a button
 * to throw it away; it has no versions and is offered to nobody.
 *
 * `GET /v1/inspection-programs/{id}` and `POST /v1/inspection-programs/{id}/versions`;
 * for a draft, `PUT .../draft`, `POST .../publish` and `DELETE .../draft`.
 */
export default async function ProgrammePage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string; published?: string; draft?: string }>;
}) {
  const { id } = await params;
  const { version, published, draft: draftSaved } = await searchParams;
  const user = await requireSetupUser();
  if (!can(user.actor, "compliance:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Inspection programme" />
        <Empty title="Inspections are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };
  const detail = await inspections.program(ctx, { id }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "NotFoundError") return null;
    throw error;
  });
  if (!detail) notFound();
  const p = detail.program;
  const writes = can(user.actor, "compliance:write");
  const asked = version ? Number(version) : null;
  const past = !p.draft && asked !== null && Number.isInteger(asked) && asked !== p.version
    ? await inspections.programVersion(ctx, { id, version: asked }).catch(() => null)
    : null;
  /**
   * What a draft would take the place of when it is published: a programme
   * technicians are offered under the same name, which would otherwise refuse
   * the publish, ticked; or the one it was copied from, not ticked.
   */
  let replaceable: { id: string; name: string; ticked: boolean } | null = null;
  if (p.draft && writes) {
    const offered = await inspections.programs(ctx);
    const same = offered.find((o) => o.name.trim().toLowerCase() === p.name.trim().toLowerCase());
    const from = p.copiedFrom;
    const source = from?.kind === "program" ? offered.find((o) => o.id === from.programId) : undefined;
    if (same) replaceable = { id: same.id, name: same.name, ticked: true };
    else if (source) replaceable = { id: source.id, name: source.name, ticked: false };
  }

  const [appliesTo, items, missing] = writes && !past
    ? await Promise.all([
        inspections.appliesToChoices(ctx),
        can(user.actor, "pricebook:read") ? priceBook.list(ctx, { limit: 200, includeInactive: false }).then((r) => r.data) : [],
        inspections.missingRepairCodes(ctx, { id }),
      ])
    : [[], [], await inspections.missingRepairCodes(ctx, { id })];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <p className="text-sm"><Link href="/inspections/programmes" className="text-ink-500 hover:underline">Inspection programmes</Link></p>
      <PageHeader title={p.name} />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {p.draft ? <Chip tone="neutral">Draft</Chip> : <Chip tone="neutral">Version {p.version}</Chip>}
        {p.draft
          ? <Chip tone="neutral">Nobody can use it until it is published</Chip>
          : p.active ? <Chip tone="success">Offered to technicians</Chip> : <Chip tone="neutral">Not offered</Chip>}
        {!p.ready && <Chip tone="warning">{p.draft ? "Not ready to publish" : "Cannot be filed yet"}</Chip>}
        <span className="text-ink-700">{sourceLine(p)}</span>
      </div>
      <p className="mt-1 text-xs text-ink-500">
        {detail.inspections === 0 ? "No inspections done under it yet." : detail.inspections === 1 ? "One inspection done under it." : `${detail.inspections} inspections done under it.`}
      </p>

      {draftSaved && p.draft && (
        <p role="status" className="mt-4 rounded-md border border-steel-200 bg-steel-100 p-3 text-sm text-ink-900">
          Saved as a draft. Technicians are not offered it until you publish it.
        </p>
      )}
      {published && (
        <p role="status" className="mt-4 rounded-md border border-steel-200 bg-steel-100 p-3 text-sm text-ink-900">
          {published === "1" && p.version === 1 ? "Saved as version 1." : `Version ${published} published. Inspections already done keep the version they were done under.`}
        </p>
      )}
      {p.tradePackId && writes && !past && (
        <p className="mt-4 max-w-prose text-sm text-ink-700">
          The {packName(p.tradePackId)} trade pack set this up. Change it here and later versions of the pack leave it
          as you have it; or <Link href={`/inspections/programmes/new?from=${p.id}`} className="underline underline-offset-4">make
          a copy</Link> to keep the pack&apos;s own beside yours.
        </p>
      )}
      {missing.length > 0 && (
        <p className="mt-4 rounded-md border border-amber-700/30 bg-amber-tint p-3 text-sm text-ink-900">
          The repairs name {missing.join(", ")}, which {missing.length === 1 ? "is" : "are"} not in your price book.
          Quoting a finding that needs {missing.length === 1 ? "it" : "them"} is refused until you add {missing.length === 1 ? "it" : "them"} or change the code here.
        </p>
      )}

      {past ? (
        <section aria-label={`Version ${past.version}`} className="mt-6">
          <p className="rounded-md border border-steel-200 bg-steel-100 p-3 text-sm text-ink-900">
            Version {past.version}, as it was published. Inspections done under it were asked these.{" "}
            <Link href={`/inspections/programmes/${p.id}`} className="underline underline-offset-4">Back to version {p.version}</Link>
          </p>
          <Reading programme={past} />
        </section>
      ) : writes && p.draft ? (
        <ProgramEditor
          mode="draft"
          programId={p.id}
          programme={p}
          replaceable={replaceable}
          appliesTo={appliesTo}
          priceBook={items.map((i) => ({ code: i.code ?? "", name: i.name })).filter((i) => i.code !== "")}
          problems={p.problems}
        />
      ) : writes ? (
        <ProgramEditor
          key={p.version}
          mode="revise"
          programId={p.id}
          baseVersion={p.version}
          programme={p}
          appliesTo={appliesTo}
          priceBook={items.map((i) => ({ code: i.code ?? "", name: i.name })).filter((i) => i.code !== "")}
          problems={p.problems}
        />
      ) : (
        <Reading programme={p} />
      )}

      {writes && p.draft && (
        <div className="mt-8">
          <ActionForm action={discardDraft} submit="Throw the draft away" tone="quiet"
                      hidden={{ programId: p.id }} className="space-y-2" />
        </div>
      )}

      {writes && !past && !p.draft && (
        <div className="mt-8 flex flex-wrap items-start gap-4">
          <ActionForm action={setOffered} submit={p.active ? "Stop offering it to technicians" : "Offer it to technicians again"}
                      tone="quiet" hidden={{ programId: p.id, offered: p.active ? "no" : "yes" }} className="space-y-2" />
          <Link href={`/inspections/programmes/new?from=${p.id}`}
                className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
            Make a copy
          </Link>
        </div>
      )}

      <section aria-label="Versions" className="mt-10">
        <h2 className="text-base font-semibold">Versions</h2>
        {detail.versions.length === 0 && (
          <p className="mt-2 text-sm text-ink-700">None yet. Publishing the draft makes version 1.</p>
        )}
        <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {detail.versions.map((v) => (
            <li key={v.version} className="bg-canvas p-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">Version {v.version}</span>
                {v.version === p.version
                  ? <span className="text-xs text-ink-500">in force</span>
                  : <Link href={`/inspections/programmes/${p.id}?version=${v.version}`} className="underline underline-offset-4">See it</Link>}
                <span className="text-xs text-ink-500">
                  {new Date(v.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                  {v.publishedBy ? `, by ${v.publishedBy}` : v.tradePackId ? `, by the ${packName(v.tradePackId)} trade pack` : ""}
                </span>
              </div>
              {v.changed.length > 0 && (
                <p className="mt-0.5 text-xs text-ink-700">Changed {v.changed.map((c) => PART[c] ?? c).join(", ")}.</p>
              )}
              {v.note && <p className="mt-0.5 text-ink-900">{v.note}</p>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** A version as words, for somebody who may read it and not change it, and for a version that is no longer in force. */
function Reading({ programme }: {
  programme: {
    standard: string | null; reportAudience: string; authorityName: string | null; frequencyMonths: number | null;
    checkpoints: Checkpoint[]; problems: string[];
  };
}) {
  return (
    <div className="mt-6 space-y-4">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-ink-500">Standard</dt><dd>{programme.standard ?? "None given"}</dd>
        <dt className="text-ink-500">Report goes to</dt>
        <dd>{AUDIENCE[programme.reportAudience] ?? programme.reportAudience}{programme.authorityName ? `: ${programme.authorityName}` : ""}</dd>
        <dt className="text-ink-500">How often</dt><dd>{programme.frequencyMonths ? `Every ${programme.frequencyMonths} months` : "No set interval"}</dd>
      </dl>
      {programme.problems.length > 0 && (
        <div className="rounded-md border border-amber-700/30 bg-amber-tint p-3 text-sm text-ink-900">
          <p className="font-medium">An inspection cannot be filed against this as it stands:</p>
          <ul className="mt-1 list-disc pl-5">{programme.problems.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      <ol className="divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
        {programme.checkpoints.map((c, i) => {
          const kind = kindOf(c);
          const heading = c.section?.trim() && c.section.trim() !== (programme.checkpoints[i - 1]?.section?.trim() ?? "")
            ? c.section.trim() : null;
          return (
          <li key={c.key} className="bg-canvas p-3 text-sm">
            {heading && <p className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-ink-700">{heading}</p>}
            <p className="font-medium">{i + 1}. {c.label}{c.optional ? " (optional)" : ""}</p>
            <p className="text-xs text-ink-700">
              {kind === "reading"
                ? `A reading in ${c.unit ?? "no unit"}, passing ${rangeWords(c.range)}`
                : kind === "count"
                  ? `A count, passing at ${c.expectedAtLeast ?? "no number set"} or more`
                  : kind === "photo" ? "A photo" : kind === "note" ? "A note" : "Pass or fail"}
              {c.assetCategory ? `. About: ${c.assetCategory}` : ""}
              {kind === "photo" || kind === "note"
                ? ". Never a finding"
                : c.severityOnFail ? `. A fail: ${SEVERITY[c.severityOnFail] ?? c.severityOnFail}` : ". A fail does not say how serious it is"}
            </p>
            {c.codeReference && <p className="text-xs text-ink-500">Code: {c.codeReference}</p>}
            {(c.remedies ?? []).length > 0 && (
              <p className="text-xs text-ink-500">
                Quote: {(c.remedies ?? []).map((r) => `${r.quantity} x ${r.label} (${r.priceBookItemKey})`).join(", ")}
              </p>
            )}
          </li>
          );
        })}
      </ol>
    </div>
  );
}

function rangeWords(range: Checkpoint["range"]): string {
  if (!range || (range.min === null && range.max === null)) return "with no range set";
  if (range.min !== null && range.max !== null) return `from ${range.min} to ${range.max}`;
  if (range.min !== null) return `at ${range.min} or more`;
  return `at ${range.max} or less`;
}
