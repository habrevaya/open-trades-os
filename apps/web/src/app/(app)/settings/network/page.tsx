import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { network, inTenant } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { Empty, PageHeader } from "@/components/Table";
import { todayIn } from "@/lib/dates";
import { Sharing, Roster, Rollup, labelFor } from "./NetworkView";
import { ActionForm } from "./ActionForm";

export const dynamic = "force-dynamic";

/**
 * THE GROUP THIS COMPANY IS IN, AND WHAT IT LETS THE GROUP SEE
 *
 * Two halves of one screen, because they are two sides of one relationship and a
 * company can be on either side. A franchisee sees the top half: four aggregates
 * and a switch on each. A franchisor sees both, because it is a company in its
 * own right and its own numbers are in its own roll up.
 *
 * THE MEMBER'S HALF IS THE IMPORTANT ONE. A consent nobody can see the state of
 * is not a consent, and until this screen existed the grants were rows an owner
 * could only read through the API. Somebody who cannot tell what their
 * franchisor can see will assume the worst, and they will be right to.
 */
export default async function NetworkPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Group" />
        <Empty title="Settings are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const view = await network.membership(ctx);

  if (view.networkId === null) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Group" />
        <Empty title="This company is not in a group">
          {/*
            Not an error. Most companies running this are one company, and a
            screen that treated that as a misconfiguration would be wrong about
            the common case.
          */}
          A franchise or holding group is several companies, each with its own customers, under one
          operator entitled to a roll up. Joining is done from the operator API, because the
          relationship has to exist before anybody is asked to consent to it.
        </Empty>
      </div>
    );
  }

  const writes = can(user.actor, "settings:write");

  /**
   * The operator half needs `report:read` as well as being the operator. One
   * without the other shows nothing: a member of the group cannot read the
   * roster however many report permissions they hold, and that is enforced in
   * the definer function rather than here.
   */
  const operates = view.isOperator && can(user.actor, "report:read");

  const [org] = await inTenant(ctx, (tx) =>
    tx.select({ timezone: schema.organization.timezone })
      .from(schema.organization)
      .where(eq(schema.organization.id, user.actor.organizationId)).limit(1));
  const zone = org?.timezone ?? "UTC";

  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const today = todayIn(zone);
  const from = one("from") ?? `${today.slice(0, 4)}-01-01`;
  const to = one("to") ?? today;
  const aggregate = one("aggregate") ?? "job_counts";

  const roster = operates ? await network.members(ctx) : null;
  const rows = operates && to >= from
    ? await network.rollup(ctx, { aggregate, from, to }).then((r) => r.data, () => null)
    : null;
  const names = new Map((roster?.data ?? []).map((member) => [member.organizationId, member.name]));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title={view.networkName ?? "Group"} />
      <p className="mt-2 text-sm text-ink-700">
        {view.networkKind ? `${title(view.networkKind)}. ` : ""}
        {view.isOperator
          ? "This company operates the group."
          : `A member of this group${view.memberCode ? `, ${view.memberCode}` : ""}.`}
      </p>

      <h2 className="mt-8 text-sm font-medium text-ink-700">What the operator may see</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Your choice, per measure, and stopping takes effect on the next read rather than at the end
        of a period. None of these can reach a customer, an address, a job description or an
        invoice number: every one of them is a total.
      </p>
      <Sharing
        view={view}
        control={writes ? (agg, sharing) => (
          sharing
            ? <ActionForm op="stop" label="Stop sharing" aggregate={agg} />
            : <ActionForm op="share" label="Share" aggregate={agg} />
        ) : undefined}
      />
      {writes ? null : (
        <p className="mt-2 text-sm text-ink-500">
          Changing what is shared needs the permission that writes settings, not the one that reads
          them.
        </p>
      )}

      {operates && roster ? (
        <>
          <h2 className="mt-10 text-sm font-medium text-ink-700">Members</h2>
          <Roster members={roster.data} />

          <h2 className="mt-10 text-sm font-medium text-ink-700">The roll up</h2>
          <form method="get" className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-ink-700">Measure</span>
              <select name="aggregate" defaultValue={aggregate}
                      className="h-8 rounded border border-steel-300 px-2">
                {network.AGGREGATES.map((option) => (
                  <option key={option} value={option}>{labelFor(option)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-ink-700">From</span>
              <input type="date" name="from" defaultValue={from}
                     className="h-8 rounded border border-steel-300 px-2" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-ink-700">To</span>
              <input type="date" name="to" defaultValue={to}
                     className="h-8 rounded border border-steel-300 px-2" />
            </label>
            <button type="submit"
                    className="h-8 rounded bg-ink-900 px-3 font-medium text-white hover:bg-ink-700">
              Show
            </button>
          </form>
          {rows === null ? (
            <Empty title="That window or measure was refused">
              The end of the window has to be on or after its start, and the measure has to be one
              of the four above.
            </Empty>
          ) : (
            <Rollup rows={rows} names={names} />
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * Shared with `NetworkView` deliberately NOT by importing it: the two use it for
 * different things (a network kind here, an aggregate there) and a single map
 * covering both would have to hold "franchise" beside "gl_summary". The naive
 * prettifier is correct for a network kind, which is one word.
 */
const title = (value: string) =>
  value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
