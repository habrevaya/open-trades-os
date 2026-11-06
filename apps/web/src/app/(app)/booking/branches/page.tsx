import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { can, effectiveScope } from "@opentradesos/core";
import { businessHours } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader } from "@/components/Table";
import { Hours, Season } from "../Forms";
import { followCompanyHours, removeSeason } from "../actions";

export const dynamic = "force-dynamic";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The week in one line: "Mon to Fri 07:00 to 18:00, Sat 07:00 to 12:00, Sun closed". */
function weekWords(days: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[]): string {
  if (days.length === 0) return "No hours set";
  return [...days].sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((d) => `${DAYS[d.dayOfWeek]} ${d.closed || !d.opensAt || !d.closesAt ? "closed" : `${d.opensAt} to ${d.closesAt}`}`)
    .join(", ");
}

/**
 * ONLINE BOOKING, EACH BRANCH'S HOURS
 *
 * A branch keeps the company's week until it is given one of its own: the
 * second shop that opens Saturday mornings, or the one that shuts on Mondays.
 * Its week is what online booking offers for its work, what the after hours
 * rate is offered against, what the crew check, task escalation, the
 * rebalance, a route's fit and its phone numbers read. Set with
 * `booking:configure`, the permission the company's week is set with;
 * somebody who sees one branch sees and sets only that branch's.
 *
 * SEASONS. The company and each branch can keep dated weeks over the normal
 * one (summer hours from June 1 to August 31), listed and added here. A
 * branch on the company's week keeps the company's seasons too; one with its
 * own week keeps only its own.
 */

type SeasonView = Awaited<ReturnType<typeof businessHours.listSeasons>>["seasons"][number];
type DayRow = { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean };

/** One owner's seasons: each with its week, changed or taken off here by somebody who may. */
function Seasons({ seasons, owner, businessUnitId, start, writes, note }: {
  seasons: SeasonView[];
  owner: string;
  businessUnitId?: string;
  start: DayRow[];
  writes: boolean;
  note?: string;
}) {
  return (
    <div className="mt-3" aria-label={`Seasons for ${owner}`} role="group">
      <h3 className="text-sm font-semibold text-ink-900">Seasons</h3>
      {note ? <p className="mt-1 text-sm text-ink-500">{note}</p> : null}
      {seasons.length === 0 ? (
        <p className="mt-1 text-sm text-ink-500">No seasons. The hours above apply all year.</p>
      ) : (
        <ul className="mt-1 space-y-3">
          {seasons.map((season) => (
            <li key={season.id} className="rounded border border-steel-200 p-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
                {season.name}
                <span className="font-normal text-ink-700">{season.when}</span>
                {season.inForceToday ? <Chip tone="info">In force today</Chip> : null}
              </p>
              <p className="mt-1 text-sm text-ink-700">
                {weekWords(season.days)}.{season.onlySomeDays ? " Every other day keeps the normal hours." : ""}
              </p>
              {writes ? (
                <>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm font-medium text-ink-700">Change {season.name}</summary>
                    <Season season={season} owner={owner} start={start} />
                  </details>
                  <ActionForm action={removeSeason} tone="quiet" className="mt-2"
                              submit={`Take off ${season.name}`} hidden={{ seasonId: season.id }} />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {writes ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-medium text-ink-700">Add a season for {owner}</summary>
          <p className="mt-2 max-w-2xl text-sm text-ink-500">
            Its days replace the normal week from the first day to the last. A holiday in it still wins.
            Two seasons for {owner} cannot share a day.
          </p>
          <Season owner={owner} start={start} {...(businessUnitId ? { businessUnitId } : {})} />
        </details>
      ) : null}
    </div>
  );
}
export default async function BranchHoursPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Branch hours" />
        <Empty title="Settings are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const [view, { seasons }] = await Promise.all([businessHours.list(ctx), businessHours.listSeasons(ctx)]);
  const writes = can(user.actor, "booking:configure");
  /** Only somebody who sees the whole company keeps the company's seasons, as with its week. */
  const companyWrites = writes && effectiveScope(user.actor, "job") === "all";
  const companySeasons = seasons.filter((s) => s.businessUnitId === null);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Branch hours" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Each branch keeps the company&apos;s hours unless you give it its own. A branch with its own hours is
        booked online, charged the after hours rate, and has its phones answered by its own week. Its holidays
        are on <a href="/settings/holidays" className="underline underline-offset-4">Settings, Holidays</a>.
      </p>
      <p className="mt-2 text-sm text-ink-700">
        The company&apos;s hours: {weekWords(view.company)}.{" "}
        <a href="/booking" className="underline underline-offset-4">Change them on Online booking</a>.
      </p>
      <Seasons seasons={companySeasons} owner="the company" start={view.company} writes={companyWrites}
               note="Summer hours and the like, for the company. Every branch on the company's hours keeps them too." />

      {view.branches.length === 0 ? (
        <div className="mt-6">
          <Empty title="No branches">
            A company with one shop keeps one set of hours. Branches are added on{" "}
            <a href="/settings/branches" className="underline underline-offset-4">Settings, Branches</a>.
          </Empty>
        </div>
      ) : view.branches.map((branch) => (
        <section key={branch.businessUnitId} className="mt-8" aria-labelledby={`branch-${branch.businessUnitId}`}>
          <h2 id={`branch-${branch.businessUnitId}`} className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {branch.name}
            <Chip tone={branch.source === "branch" ? "info" : "neutral"}>
              {branch.source === "branch" ? "Its own hours" : "The company's hours"}
            </Chip>
          </h2>
          <p className="mt-1 text-sm text-ink-700">{weekWords(branch.days)}.</p>
          <Seasons
            seasons={seasons.filter((s) => s.businessUnitId === branch.businessUnitId)}
            owner={branch.name} businessUnitId={branch.businessUnitId} start={branch.days} writes={writes}
            note={branch.source === "branch"
              ? `${branch.name} keeps its own hours, so only its own seasons apply to it, not the company's.`
              : `${branch.name} keeps the company's seasons, and its own come first.`}
          />
          {writes ? (
            <>
              <details className="mt-2" open={branch.source === "branch"}>
                <summary className="cursor-pointer text-sm font-medium text-ink-700">
                  {branch.source === "branch" ? `Change ${branch.name}'s hours` : `Give ${branch.name} its own hours`}
                </summary>
                <Hours current={branch.days} businessUnitId={branch.businessUnitId} name={branch.name}
                       submit={`Save ${branch.name}'s hours`} />
              </details>
              {branch.source === "branch" ? (
                <ActionForm action={followCompanyHours} tone="quiet" className="mt-3"
                            submit={`Use the company's hours for ${branch.name}`}
                            hidden={{ businessUnitId: branch.businessUnitId }} />
              ) : null}
            </>
          ) : null}
        </section>
      ))}
    </div>
  );
}
