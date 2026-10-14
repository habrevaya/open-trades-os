import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { can } from "@opentradesos/core";
import { businessHours } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader } from "@/components/Table";
import { Hours } from "../Forms";
import { followCompanyHours } from "../actions";

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
 */
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

  const view = await businessHours.list(ctx);
  const writes = can(user.actor, "booking:configure");

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
