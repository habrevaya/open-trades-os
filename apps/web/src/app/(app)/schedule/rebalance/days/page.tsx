import { randomUUID } from "node:crypto";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayIn } from "@/lib/dates";
import { dispatchDays } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { ApplyDays } from "./ApplyDays";

export const dynamic = "force-dynamic";

/**
 * SEVERAL DAYS, REBALANCED, BEFORE ANYTHING MOVES
 *
 * The single day screen cannot take a visit off an overfull Tuesday. This
 * one proposes the next few days together and may move a visit to another
 * of them, but only one whose customer agreed: a range of days set on the
 * visit, the window of the agreement visit it delivers, or the days of the
 * week the customer said suit them. Shown day by day as it is and as it
 * would be; the button at the bottom applies it, and each customer whose
 * visit moves day is told.
 */
export default async function RebalanceDaysPage({ searchParams }: {
  searchParams: Promise<{ from?: string; days?: string; moved?: string; told?: string }>;
}) {
  const user = await requireSetupUser();
  const params = await searchParams;
  const zone = user.organizationTimezone;
  const from = params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from) ? params.from : todayIn(zone);
  const days = params.days && /^[2-7]$/.test(params.days) ? Number(params.days) : 5;
  /** What the last apply did, carried in the address; see ApplyDays. */
  const moved = params.moved && /^\d{1,4}$/.test(params.moved) ? Number(params.moved) : null;
  const told = params.told && /^\d{1,4}$/.test(params.told) ? Number(params.told) : 0;

  if (!can(user.actor, "visit:read")) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
        <PageHeader title="Rebalance several days" />
        <Empty title="Not shown to your role">The schedule is not something your role reads.</Empty>
      </div>
    );
  }

  const proposal = await dispatchDays.rebalanceDays({ actor: user.actor, db: getDb() }, { from, days });
  const time = (iso: string | null) => iso
    ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone })
    : null;
  const dayName = (date: string, long = false) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: long ? "long" : "short", month: long ? "long" : "short", day: "numeric", timeZone: "UTC",
  });
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
  const movingDay = new Map(proposal.dayMoves.map((m) => [m.visitId, m]));
  const applies = can(user.actor, "visit:dispatch") && can(user.actor, "visit:reschedule");
  const saved = proposal.driveBeforeMinutes - proposal.driveAfterMinutes;
  const last = proposal.perDay.at(-1)?.date ?? from;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Rebalance several days" />
      <p className="mt-1 text-sm text-ink-700">
        {dayName(from, true)} to {dayName(last, true)}.{" "}
        <a href={`/schedule?date=${from}`} className="underline">Back to the board</a>
      </p>
      <form method="get" className="mt-3 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="font-medium text-ink-700">From</span>
          <input type="date" name="from" defaultValue={from} className="h-9 rounded border border-steel-300 px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium text-ink-700">How many days</span>
          <select name="days" defaultValue={String(days)} className="h-9 rounded border border-steel-300 px-2">
            {[2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="submit" className="h-9 rounded border border-steel-300 px-3 font-medium">Show</button>
      </form>

      {moved !== null && (
        <p role="status" className="mt-3 text-sm text-green-700">
          Done. {moved} {moved === 1 ? "visit is" : "visits are"} on a new day
          {moved > 0 ? `, and ${told} ${told === 1 ? "customer was" : "customers were"} sent word` : ""}.
          Each changed day is in its new order.
        </p>
      )}

      <section aria-label="What would change" className="mt-5 rounded-md border border-steel-200 bg-canvas p-4">
        {!proposal.changed ? (
          <p className="text-sm">These days are already as balanced as the rebalance can make them. Nothing would move.</p>
        ) : (
          <>
            <p className="text-base font-medium">
              {proposal.dayMoves.length} {proposal.dayMoves.length === 1 ? "visit would move" : "visits would move"} to another day.
              Driving: {hours(proposal.driveBeforeMinutes)} as it is, {hours(proposal.driveAfterMinutes)} proposed
              {saved > 0 ? `, ${hours(saved)} less.` : saved < 0 ? `, ${hours(saved)} more.` : ", the same."}
            </p>
            {proposal.overtimeAfterMinutes !== proposal.overtimeBeforeMinutes && (
              <p className="mt-1 text-sm text-ink-700">
                Overtime: {hours(proposal.overtimeBeforeMinutes)} as it is, {hours(proposal.overtimeAfterMinutes)} proposed.
              </p>
            )}
          </>
        )}
        <p className="mt-2 text-xs text-ink-500">
          A visit moves to another day only when its customer agreed: a range of days set on the visit, the window of the
          agreement visit it delivers, or the days of the week set on the customer. Never onto or off today, never onto a day
          you are closed, never past how many you take online in that window, and only when it keeps a promise or the overtime
          limit, places work no day could take, cuts overtime, or saves at least fifteen minutes of driving. Crews are planned
          like people, and crew work only goes to a crew that has the kit and the people for it that day. {proposal.movable.length === 0
            ? "No visit in these days may move to another day."
            : `${proposal.movable.length} ${proposal.movable.length === 1 ? "visit in these days may" : "visits in these days may"} move to another day.`}{" "}
          {proposal.driveNote}
        </p>
      </section>

      {proposal.dayMoves.length > 0 && (
        <section className="mt-6">
          <h2 className="text-base font-semibold">Moved to another day</h2>
          <table aria-label="Moved to another day" className="mt-2 w-full text-left text-sm">
            <thead className="border-b border-steel-200 text-xs uppercase tracking-[0.08em] text-ink-500">
              <tr>
                <th className="py-2 pr-3 font-medium">Visit</th>
                <th className="py-2 pr-3 font-medium">From</th>
                <th className="py-2 pr-3 font-medium">To</th>
                <th className="py-2 pr-3 font-medium">With</th>
                <th className="py-2 pr-3 font-medium">Agreed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-200">
              {proposal.dayMoves.map((m) => (
                <tr key={m.visitId}>
                  <td className="py-2 pr-3">{m.customerName}</td>
                  <td className="py-2 pr-3 text-ink-700">{dayName(m.fromDate)}{m.fromName ? `, ${m.fromName}` : ""}</td>
                  <td className="py-2 pr-3 font-medium">{dayName(m.toDate)}, {time(m.windowStart)}{m.windowEnd ? ` to ${time(m.windowEnd)}` : ""}</td>
                  <td className="py-2 pr-3">{m.toName}</td>
                  <td className="py-2 pr-3 text-ink-700">{m.because === "range" ? "A range of days" : "Their days of the week"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {proposal.moves.length > 0 && (
        <section className="mt-6">
          <h2 className="text-base font-semibold">Who would take what, on the same day</h2>
          <table aria-label="Moves on the same day" className="mt-2 w-full text-left text-sm">
            <thead className="border-b border-steel-200 text-xs uppercase tracking-[0.08em] text-ink-500">
              <tr><th className="py-2 pr-3 font-medium">Visit</th><th className="py-2 pr-3 font-medium">Day</th><th className="py-2 pr-3 font-medium">From</th><th className="py-2 pr-3 font-medium">To</th></tr>
            </thead>
            <tbody className="divide-y divide-steel-200">
              {proposal.moves.map((m) => (
                <tr key={m.visitId}>
                  <td className="py-2 pr-3">{m.customerName}</td>
                  <td className="py-2 pr-3 text-ink-700">{dayName(m.date)}</td>
                  <td className="py-2 pr-3 text-ink-700">{m.fromName ?? "Nobody"}</td>
                  <td className="py-2 pr-3 font-medium">{m.toName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {proposal.perDay.map((day) => (
        <section key={day.date} aria-label={dayName(day.date, true)} className="mt-8">
          <h2 className="text-base font-semibold">{dayName(day.date, true)}</h2>
          <p className="mt-1 text-sm text-ink-700 tabular-nums">
            As it is: {day.visitsBefore} {day.visitsBefore === 1 ? "visit" : "visits"}, {hours(day.driveBeforeMinutes)} driving
            {day.overtimeBeforeMinutes > 0 ? `, ${hours(day.overtimeBeforeMinutes)} overtime` : ""}.
            Proposed: {day.visitsAfter} {day.visitsAfter === 1 ? "visit" : "visits"}, {hours(day.driveAfterMinutes)} driving
            {day.overtimeAfterMinutes > 0 ? `, ${hours(day.overtimeAfterMinutes)} overtime` : ""}.
          </p>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            {[
              ...day.technicians.map((t) => ({ key: t.technicianId, name: t.displayName, color: t.color, timeOff: t.timeOff, crew: false, before: t.before, after: t.after })),
              ...day.crews.map((c) => ({ key: c.crewId, name: c.name, color: c.color, timeOff: false, crew: true, before: c.before, after: c.after })),
            ].map((t) => (
              <article key={t.key} aria-label={`${t.crew ? "Crew " : ""}${t.name} on ${dayName(day.date, true)}`}
                       className="rounded-md border border-steel-200 bg-canvas p-4">
                <h3 className="flex items-center gap-2 font-medium">
                  <span className={`h-2.5 w-2.5 ${t.crew ? "rounded-sm" : "rounded-full"}`} style={{ background: t.color ?? (t.crew ? "#7C3AED" : "#64748B") }} aria-hidden />
                  {t.name}
                  {t.crew && <span className="text-xs font-normal text-ink-500">Crew</span>}
                  {t.timeOff && <span className="text-xs font-normal text-red-600">Off</span>}
                </h3>
                <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                  {([["As it is", t.before], ["Proposed", t.after]] as const).map(([label, d]) => (
                    <div key={label}>
                      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">{label}</p>
                      <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                        {d.order.map((id) => {
                          const arriving = label === "Proposed" && movingDay.get(id)?.toDate === day.date;
                          const leaving = label === "As it is" && movingDay.get(id)?.fromDate === day.date;
                          return (
                            <li key={id}>
                              {visits.get(id)?.customerName ?? "A visit"}
                              <span className="text-xs text-ink-500">
                                {arriving ? `, moved here from ${dayName(movingDay.get(id)!.fromDate)}` : windowOf(id)}
                                {leaving ? `, moves to ${dayName(movingDay.get(id)!.toDate)}` : ""}
                                {visits.get(id)?.locked ? ", locked" : ""}
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                      {d.order.length === 0 && <p className="text-ink-500">Nothing planned</p>}
                      <p className="mt-1 text-xs text-ink-700">
                        {hours(d.driveMinutes)} driving, back by {time(d.finishAt)}
                        {d.overtimeMinutes > 0 ? `, ${hours(d.overtimeMinutes)} overtime` : ""}
                        {d.overLimitMinutes > 0 ? `, ${hours(d.overLimitMinutes)} past the overtime allowed` : ""}
                      </p>
                      {d.late.length > 0 && (
                        <p className="text-xs text-red-600">{d.late.length} {d.late.length === 1 ? "visit" : "visits"} late</p>
                      )}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
          {(day.unplaced.length > 0 || day.leftOut.length > 0 || day.crewsLeftOut.length > 0) && (
            <ul className="mt-3 space-y-1 text-sm">
              {day.crewsLeftOut.map((c) => (
                <li key={c.crewId}><span className="font-medium">{c.name}</span> is left out. {c.reason}</li>
              ))}
              {day.unplaced.map((u) => (
                <li key={u.visitId}><span className="font-medium">{u.customerName}</span>: {u.reason}</li>
              ))}
              {day.leftOut.map((l) => (
                <li key={l.technicianId}><span className="font-medium">{l.displayName}</span> is left out. {l.reason}</li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {proposal.changed && (
        <section className="mt-8">
          {applies ? (
            <ApplyDays
              customersTold={proposal.dayMoves.length}
              payload={{ from, days, basis: proposal.basis, key: randomUUID(), ...proposal.apply }}
            />
          ) : (
            <p className="text-sm text-ink-500">Applying it needs somebody who dispatches and reorders the board.</p>
          )}
        </section>
      )}
    </div>
  );
}
