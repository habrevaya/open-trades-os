import { randomUUID } from "node:crypto";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayIn } from "@/lib/dates";
import { dispatchMap } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { ApplyRebalance } from "./ApplyRebalance";

export const dynamic = "force-dynamic";

/**
 * THE WHOLE DAY, REBALANCED, BEFORE ANYTHING MOVES
 *
 * Who takes what and in what order, proposed across every technician at
 * once, shown day by day as it is and as it would be, with the driving saved
 * and anything that could not be placed said in a sentence. Reading this
 * moves nothing; the button at the bottom applies it through the same
 * assignment and reorder a drag uses.
 */
export default async function RebalancePage({ searchParams }: { searchParams: Promise<{ date?: string; applied?: string }> }) {
  const user = await requireSetupUser();
  const params = await searchParams;
  /** How many visits the last apply moved, carried in the address; see ApplyRebalance. */
  const applied = params.applied && /^\d{1,4}$/.test(params.applied) ? Number(params.applied) : null;
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : todayIn(user.organizationTimezone);

  if (!can(user.actor, "visit:read")) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
        <PageHeader title="Rebalance the day" />
        <Empty title="Not shown to your role">The schedule is not something your role reads.</Empty>
      </div>
    );
  }

  const proposal = await dispatchMap.rebalance({ actor: user.actor, db: getDb() }, { date });
  const zone = user.organizationTimezone;
  const time = (iso: string | null) => iso
    ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone })
    : null;
  const hours = (minutes: number) => {
    const m = Math.abs(minutes);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
  };
  const visits = new Map(proposal.visits.map((v) => [v.visitId, v]));
  const windowOf = (id: string) => {
    const v = visits.get(id);
    return v?.windowStart ? ` (${time(v.windowStart)}${v.windowEnd ? ` to ${time(v.windowEnd)}` : ""})` : "";
  };
  const applies = can(user.actor, "visit:dispatch") && can(user.actor, "visit:reschedule");
  const saved = proposal.driveSavedMinutes;
  const heading = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Rebalance the day" />
      <p className="mt-1 text-sm text-ink-700">
        {heading}. <a href={`/schedule?date=${date}`} className="underline">Back to the board</a>
        {" "}or <a href={`/schedule/rebalance/days?from=${date}`} className="underline">rebalance several days</a>,
        which can move a visit to another day its customer agreed to.
      </p>
      {applied !== null && (
        <p role="status" className="mt-3 text-sm text-green-700">
          Done. {applied} {applied === 1 ? "visit has" : "visits have"} a new technician, and each changed day is in its new order.
        </p>
      )}

      <section aria-label="What would change" className="mt-5 rounded-md border border-steel-200 bg-canvas p-4">
        {!proposal.changed ? (
          <p className="text-sm">This day is already as balanced as the rebalance can make it. Nothing would move.</p>
        ) : (
          <>
            <p className="text-base font-medium">
              Driving: {hours(proposal.driveBeforeMinutes)} as it is, {hours(proposal.driveAfterMinutes)} proposed
              {saved > 0 ? `, ${hours(saved)} less.` : saved < 0 ? `, ${hours(saved)} more.` : ", the same."}
            </p>
            {proposal.newlyAssigned > 0 && (
              <p className="mt-1 text-sm text-ink-700">
                {proposal.newlyAssigned} {proposal.newlyAssigned === 1 ? "visit that had nobody would have somebody" : "visits that had nobody would have somebody"}
                {saved < 0 ? ", which is where the extra driving comes from." : "."}
              </p>
            )}
            {proposal.overtimeAfterMinutes !== proposal.overtimeBeforeMinutes && (
              <p className="mt-1 text-sm text-ink-700">
                Overtime: {hours(proposal.overtimeBeforeMinutes)} as it is, {hours(proposal.overtimeAfterMinutes)} proposed.
              </p>
            )}
          </>
        )}
        <p className="mt-2 text-xs text-ink-500">
          {proposal.driveNote} The day ends at {proposal.workday.dayEndsAt}
          {proposal.workday.lunchMinutes > 0
            ? `, with a ${proposal.workday.lunchMinutes} minute break starting between ${proposal.workday.lunchEarliest} and ${proposal.workday.lunchLatest}`
            : ""}, and up to {proposal.workday.maxOvertimeMinutes} minutes of overtime may be planned.
          Locked visits, crew work, visits with several people and drivers' days with containers stay where they are.
        </p>
      </section>

      {proposal.moves.length > 0 && (
        <section className="mt-6">
          <h2 className="text-base font-semibold">Who would take what</h2>
          <table aria-label="Moves" className="mt-2 w-full text-left text-sm">
            <thead className="border-b border-steel-200 text-xs uppercase tracking-[0.08em] text-ink-500">
              <tr><th className="py-2 pr-3 font-medium">Visit</th><th className="py-2 pr-3 font-medium">From</th><th className="py-2 pr-3 font-medium">To</th></tr>
            </thead>
            <tbody className="divide-y divide-steel-200">
              {proposal.moves.map((m) => (
                <tr key={m.visitId}>
                  <td className="py-2 pr-3">{m.customerName}</td>
                  <td className="py-2 pr-3 text-ink-700">{m.fromName ?? "Nobody"}</td>
                  <td className="py-2 pr-3 font-medium">{m.toName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-label="Each day before and after" className="mt-6 grid gap-4 md:grid-cols-2">
        {proposal.technicians.map((t) => (
          <article key={t.technicianId} aria-label={`${t.displayName}'s day`} className="rounded-md border border-steel-200 bg-canvas p-4">
            <h3 className="flex items-center gap-2 font-medium">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color ?? "#64748B" }} aria-hidden />
              {t.displayName}
              {t.timeOff && <span className="text-xs font-normal text-red-600">Off today</span>}
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
              {([["As it is", t.before], ["Proposed", t.after]] as const).map(([label, d]) => (
                <div key={label}>
                  <p className="text-xs uppercase tracking-[0.08em] text-ink-500">{label}</p>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                    {d.order.map((id) => (
                      <li key={id}>
                        {visits.get(id)?.customerName ?? "A visit"}
                        <span className="text-xs text-ink-500">{windowOf(id)}{visits.get(id)?.locked ? ", locked" : ""}</span>
                      </li>
                    ))}
                  </ol>
                  {d.order.length === 0 && <p className="text-ink-500">Nothing planned</p>}
                  <p className="mt-1 text-xs text-ink-700">
                    {hours(d.driveMinutes)} driving, back by {time(d.finishAt)}
                    {d.lunchAt ? `, break at ${time(d.lunchAt)}` : ""}
                    {d.overtimeMinutes > 0 ? `, ${hours(d.overtimeMinutes)} overtime` : ""}
                  </p>
                  {d.late.length > 0 && (
                    <p className="text-xs text-red-600">{d.late.length} {d.late.length === 1 ? "visit" : "visits"} late</p>
                  )}
                  {d.refused.length > 0 && (
                    <p className="text-xs text-red-600">{d.refused.length} they may not do</p>
                  )}
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>

      {(proposal.unplaced.length > 0 || proposal.leftOut.length > 0) && (
        <section className="mt-6">
          <h2 className="text-base font-semibold">What it could not place</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {proposal.unplaced.map((u) => (
              <li key={u.visitId}><span className="font-medium">{u.customerName}</span>: {u.reason}</li>
            ))}
            {proposal.leftOut.map((l) => (
              <li key={l.technicianId}><span className="font-medium">{l.displayName}</span> is left out. {l.reason}
                {/not on the map/.test(l.reason) ? <>{" "}<a href="/schedule/technicians" className="underline">Set where days start</a></> : null}</li>
            ))}
          </ul>
        </section>
      )}

      {proposal.changed && (
        <section className="mt-8">
          {applies ? (
            <ApplyRebalance payload={{
              date, basis: proposal.basis, key: randomUUID(),
              moves: proposal.moveAssignments, orders: proposal.apply,
            }} />
          ) : (
            <p className="text-sm text-ink-500">Applying it needs somebody who dispatches and reorders the board.</p>
          )}
        </section>
      )}
    </div>
  );
}
