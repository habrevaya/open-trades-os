import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inspections } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { setOffered } from "./actions";
import { sourceLine } from "./words";

export const dynamic = "force-dynamic";

/**
 * INSPECTIONS → PROGRAMMES
 *
 * The checklists an inspection is done against: the company's own, the ones
 * its trade pack set up, and the ones it has stopped offering, which are
 * kept because the inspections done under them point at them. Below them,
 * every trade pack's programmes to start one from.
 *
 * Read with `compliance:read`, as `GET /v1/inspection-programs` is. Writing,
 * copying and offering need `compliance:write`, as the routes do.
 */
export default async function ProgrammesPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "compliance:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Inspection programmes" />
        <Empty title="Inspections are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };
  const [programmes, fromPacks] = await Promise.all([
    inspections.programs(ctx, { includeRetired: true }),
    inspections.packPrograms(ctx),
  ]);
  const writes = can(user.actor, "compliance:write");
  const offered = programmes.filter((p) => p.active);
  const kept = programmes.filter((p) => !p.active);
  const yours = fromPacks.filter((p) => p.yourTrade);
  const others = fromPacks.filter((p) => !p.yourTrade);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Inspection programmes"
        count={programmes.length}
        action={writes ? (
          <Link href="/inspections/programmes/new"
                className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700">
            Write a new programme
          </Link>
        ) : undefined}
      />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        A programme is the checklist an inspection is done against: the questions, the readings and the range each one
        must fall in, how serious a fail is, and what to quote for it. Changing one publishes a new version, and every
        inspection keeps the version it was done under.
      </p>

      {programmes.length === 0 ? (
        <Empty title="No programmes yet">
          Write one, or start from a trade pack&apos;s below and change what you need.
        </Empty>
      ) : (
        <>
          <ProgrammeList title="Offered to technicians" rows={offered} writes={writes} offered />
          {kept.length > 0 && <ProgrammeList title="Not offered" rows={kept} writes={writes} offered={false} />}
        </>
      )}

      <section aria-label="Start from a trade pack" className="mt-10">
        <h2 className="text-base font-semibold">Start from a trade pack&apos;s programme</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-700">
          Copy one, change what you need and save it as your own. Most need a range added to a reading before an
          inspection can be filed against them; the copy says which.
        </p>
        {[...(yours.length > 0 ? [{ title: "Your trades", rows: yours }] : []), { title: yours.length > 0 ? "Other trades" : "All trades", rows: others }]
          .filter((group) => group.rows.length > 0)
          .map((group) => (
            <div key={group.title} className="mt-4">
              <h3 className="text-sm font-medium text-ink-700">{group.title}</h3>
              <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
                {group.rows.map((p) => (
                  <li key={`${p.packId}:${p.code}`} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{p.name}</span>
                      <span className="block text-xs text-ink-500">
                        {p.packName}, {p.checkpoints.length} checks{p.frequencyMonths ? `, every ${p.frequencyMonths} months` : ""}
                        {p.problems.length > 0 ? `. ${p.problems.length === 1 ? "One thing" : `${p.problems.length} things`} to fix first` : ""}
                      </span>
                    </span>
                    {writes && (
                      <Link href={`/inspections/programmes/new?pack=${encodeURIComponent(p.packId)}&code=${encodeURIComponent(p.code)}`}
                            className="underline underline-offset-4">
                        Start from this
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </section>
    </div>
  );
}

function ProgrammeList({
  title, rows, writes, offered,
}: {
  title: string;
  rows: Awaited<ReturnType<typeof inspections.programs>>;
  writes: boolean;
  offered: boolean;
}) {
  return (
    <section aria-label={title} className="mt-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
        {rows.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
            <span className="min-w-0 flex-1">
              <Link href={`/inspections/programmes/${p.id}`} className="font-medium underline-offset-4 hover:underline">{p.name}</Link>
              <span className="block text-xs text-ink-500">
                Version {p.version}, {p.checkpointCount} checks{p.frequencyMonths ? `, every ${p.frequencyMonths} months` : ""}. {sourceLine(p)}
              </span>
            </span>
            {!p.ready && <Chip tone="warning">Cannot be filed yet</Chip>}
            {writes && (
              <ActionForm action={setOffered} submit={offered ? "Stop offering it" : "Offer it again"} tone="quiet"
                          hidden={{ programId: p.id, offered: offered ? "no" : "yes" }} className="flex flex-wrap items-center gap-2" />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
