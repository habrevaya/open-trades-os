import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { crews, onCall, people, inTenant } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { Crews, OnCall } from "./CrewView";
import { ActionForm } from "./ActionForm";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";

/**
 * How far ahead the rota is shown. The service's own default, named here so the
 * screen can say it: an empty list with no window stated is ambiguous between
 * nobody being scheduled and nothing falling in the next month.
 */
const ROTA_DAYS = 30;

/**
 * CREWS AND THE ON CALL ROTA
 *
 * Two things that were in the API with no screen, on one page because they answer
 * the same question from two ends: who is working. A crew is the dispatch unit for
 * work one person cannot do; the rota is who has the phone when the office is
 * shut.
 *
 * Reading needs `visit:read` and changing needs `visit:dispatch`, which is the
 * services' own split. Setting a rate multiplier on a shift needs
 * `payroll:configure` as well, and the service enforces that rather than this
 * screen, so a dispatcher with no payroll rights can build the whole rota and is
 * refused only the money on it.
 */
export default async function CrewsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "visit:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Crews and on call" />
        <Empty title="Not shown to your role">
          Crews and the rota need the permission that reads the schedule.
        </Empty>
      </div>
    );
  }

  const [org] = await inTenant(ctx, (tx) =>
    tx.select({ timezone: schema.organization.timezone })
      .from(schema.organization)
      .where(eq(schema.organization.id, user.actor.organizationId)).limit(1));
  const zone = org?.timezone ?? "UTC";

  const [all, now, shifts] = await Promise.all([
    crews.list(ctx),
    onCall.whoIsOnCall(ctx, {}),
    onCall.list(ctx, {}),
  ]);

  const dispatches = can(user.actor, "visit:dispatch");
  const crew = can(user.actor, "user:read")
    ? (await people.handlers.listPeople(ctx, {})).people
        .filter((person) => person.technicianId && person.active)
    : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Crews and on call" count={all.length} />

      <h2 className="mt-6 text-base font-semibold">Crews</h2>
      <Crews
        crews={all}
        controls={dispatches ? (row) => (
          <div className="flex flex-wrap gap-2">
            {crew.length > 0 && (
              /*
                The whole membership, replaced. A multi-select plus one lead,
                rather than add and remove buttons, because the service replaces
                the list and a form that looked additive would disagree with it.
              */
              <ActionForm op="members" label="Set who is on it" quiet hidden={{ id: row.id }}>
                <select name="member" multiple size={3} className="rounded border border-steel-300 px-2 py-1 text-sm"
                        aria-label="Who is on the crew"
                        defaultValue={row.members.map((member) => member.technicianId)}>
                  {crew.map((person) => (
                    <option key={person.technicianId!} value={person.technicianId!}>
                      {person.displayName ?? person.name ?? person.email}
                    </option>
                  ))}
                </select>
                <select name="lead" className={input} aria-label="Who leads it"
                        defaultValue={row.members.find((member) => member.isLead)?.technicianId ?? ""}>
                  <option value="">No lead</option>
                  {crew.map((person) => (
                    <option key={person.technicianId!} value={person.technicianId!}>
                      {person.displayName ?? person.name ?? person.email}
                    </option>
                  ))}
                </select>
              </ActionForm>
            )}
            {row.active
              ? <ActionForm op="retire" label="Retire" quiet hidden={{ id: row.id }} />
              : <ActionForm op="restore" label="Bring back" quiet hidden={{ id: row.id }} />}
          </div>
        ) : undefined}
      />

      {dispatches && (
        <section className="mt-6">
          <h3 className="text-sm font-medium text-ink-700">Add a crew</h3>
          <ActionForm op="crew" label="Add" className="mt-2 flex flex-wrap items-end gap-2">
            <input name="name" required placeholder="Tree crew" className={input} />
            {/*
              Both halves of the capacity or neither. The service refuses one
              without the other, because "eight hundred a day" is eight hundred
              square feet or linear feet or cubic yards and the three are
              different jobs.
            */}
            <input name="productionRatePerDay" inputMode="decimal" placeholder="Rate a day"
                   aria-label="Production rate a day" className={`${input} w-28`} />
            <input name="productionUnit" placeholder="square feet"
                   aria-label="Unit the rate is in" className={`${input} w-32`} />
            <input name="skill" placeholder="A skill" aria-label="A skill this crew holds"
                   className={`${input} w-32`} />
          </ActionForm>
        </section>
      )}

      <h2 className="mt-10 text-base font-semibold">On call</h2>
      <OnCall
        now={now.onCall}
        shifts={shifts.map((shift) => ({
          id: shift.id,
          technicianId: shift.technicianId,
          technicianName: shift.technicianName,
          startsAt: new Date(shift.startsAt).toISOString(),
          endsAt: new Date(shift.endsAt).toISOString(),
          rateMultiplier: shift.rateMultiplier,
        }))}
        zone={zone}
        formatAt={formatIn}
        windowDays={ROTA_DAYS}
      />

      {dispatches && crew.length > 0 && (
        <section className="mt-6 space-y-4">
          <div>
            <h3 className="text-sm font-medium text-ink-700">Put somebody on call</h3>
            <ActionForm op="oncall" label="Schedule" className="mt-2 flex flex-wrap items-end gap-2">
              <select name="technicianId" className={input} aria-label="Who is on call">
                {crew.map((person) => (
                  <option key={person.technicianId!} value={person.technicianId!}>
                    {person.displayName ?? person.name ?? person.email}
                  </option>
                ))}
              </select>
              <input name="startsAt" type="datetime-local" required className={input} aria-label="From" />
              <input name="endsAt" type="datetime-local" required className={input} aria-label="Until" />
              <input name="rateMultiplier" inputMode="decimal" placeholder="1.5"
                     aria-label="Rate multiplier" className={`${input} w-20`} />
            </ActionForm>
            <p className="mt-1 text-xs text-ink-500">
              A multiplier is a statement about what somebody is owed, so setting one needs the
              permission that configures payroll. A shift without one needs no payroll rights.
            </p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-ink-700">Hand over now</h3>
            <ActionForm op="handover" label="Hand over" className="mt-2 flex flex-wrap items-end gap-2">
              <select name="toTechnicianId" className={input} aria-label="Hand over to">
                {crew.map((person) => (
                  <option key={person.technicianId!} value={person.technicianId!}>
                    {person.displayName ?? person.name ?? person.email}
                  </option>
                ))}
              </select>
            </ActionForm>
            <p className="mt-1 text-xs text-ink-500">
              Ends the current shift at this instant and starts the next, so the handover belongs to
              exactly one person. Refused when nobody is on call, because there is nothing to hand
              over.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
