import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { serviceRoutes as routes, crews, people, properties, inTenant } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { Empty, PageHeader } from "@/components/Table";
import { todayIn } from "@/lib/dates";
import { Routes, Stops, Fit } from "./RouteView";
import { ActionForm } from "./ActionForm";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * SERVICE ROUTES
 *
 * The template a route business runs on: a weekday, one servicer, and a list of
 * stops in the order they are driven. In the API with no screen until now, which
 * for a pool or lawn operator means the one thing their week is built from was
 * invisible.
 *
 * DENSITY IS ON THE SCREEN, not in a report. The revenue of a route is stops times
 * price per stop and the cost is the driver's day, so an operator adding a
 * fifteenth stop is making the only decision that matters in their business.
 * Today they make it by feel and find out on Friday at time and a half.
 *
 * `job:read` to look and `job:write` to change, which is the service's own split.
 */
export default async function RoutesPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "job:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Routes" />
        <Empty title="Not shown to your role">Routes need the permission that reads jobs.</Empty>
      </div>
    );
  }

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
  const opened = one("route");

  const all = await routes.list(ctx);
  const writes = can(user.actor, "job:write");

  /**
   * The stops and the density of one route, when asked for. Both run queries per
   * route, so doing them for every row would be a list screen that takes a second
   * per route to draw.
   */
  const route = opened ? all.find((row) => row.id === opened) ?? null : null;
  const [stops, density] = route
    ? await Promise.all([
        routes.stops(ctx, { id: route.id }),
        routes.density(ctx, { id: route.id }),
      ])
    : [null, null];

  const crewList = await crews.list(ctx).catch(() => []);
  const technicians = can(user.actor, "user:read")
    ? (await people.handlers.listPeople(ctx, {})).people
        .filter((person) => person.technicianId && person.active)
    : [];
  const addresses = writes && can(user.actor, "property:read")
    ? (await properties.list(ctx, { limit: 200 })).data
    : [];

  const crewName = new Map(crewList.map((crew) => [crew.id, crew.name]));
  const techName = new Map(technicians.map((person) => [person.technicianId!, person.displayName ?? person.name ?? person.email]));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Routes" count={all.length} />

      <Routes
        routes={all}
        /*
          Exactly one servicer by construction, so this reports which it is rather
          than leaving a blank. A route with neither is one the service refuses,
          and saying "nobody" out loud is how it would be noticed if one existed.
        */
        servicerName={(row) =>
          row.crewId
            ? crewName.get(row.crewId) ?? "a crew"
            : row.technicianId
              ? techName.get(row.technicianId) ?? "a technician"
              : "nobody"}
        controls={(row) => (
          <div className="flex flex-wrap gap-2">
            <a href={`/schedule/routes?route=${row.id}`}
               className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100">
              Stops and fit
            </a>
            {writes && row.active && (
              <ActionForm op="materialise" label="Make a day" quiet hidden={{ id: row.id }}>
                <input name="date" type="date" required defaultValue={todayIn(zone)}
                       className={input} aria-label="Which day" />
              </ActionForm>
            )}
          </div>
        )}
      />

      {writes && (
        <section className="mt-6">
          <h3 className="text-sm font-medium text-ink-700">Add a route</h3>
          <ActionForm op="route" label="Add" className="mt-2 flex flex-wrap items-end gap-2">
            <input name="name" required placeholder="Tuesday north" className={input} />
            <select name="dayOfWeek" className={input} aria-label="Which weekday" defaultValue="2">
              {DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select>
            {/*
              ONE SELECT, NOT TWO. A technician and a crew in separate boxes is a
              form that can send both, and a route with two servicers has two
              answers to every question after it: density, overtime, whose day
              this is. The value carries which kind it is.
            */}
            <select name="servicer" required className={input} aria-label="Who drives it">
              {technicians.map((person) => (
                <option key={`t:${person.technicianId!}`} value={`technician:${person.technicianId!}`}>
                  {person.displayName ?? person.name ?? person.email}
                </option>
              ))}
              {crewList.map((crew) => (
                <option key={`c:${crew.id}`} value={`crew:${crew.id}`}>{crew.name} (crew)</option>
              ))}
            </select>
            <input name="startsAt" placeholder="07:30" aria-label="Start time"
                   className={`${input} w-20`} />
            <input name="targetStopCount" inputMode="numeric" placeholder="Target stops"
                   aria-label="Target stop count" className={`${input} w-28`} />
            <input name="travelMinutesBetweenStops" inputMode="numeric" placeholder="Drive mins"
                   aria-label="Minutes driving between stops" className={`${input} w-24`} />
          </ActionForm>
          <p className="mt-1 text-xs text-ink-500">
            Declaring the drive between stops is what lets the fit answer be yes or no rather than
            &quot;cannot tell&quot;. Undeclared, the day&apos;s total is reported as a floor.
          </p>
        </section>
      )}

      {route && stops && density ? (
        <section className="mt-10">
          <h2 className="text-base font-semibold">{route.name}</h2>
          <Fit density={density} />
          <Stops
            stops={stops}
            controls={writes ? (stop) => (
              stop.active
                ? <ActionForm op="skip" label="Skip" quiet hidden={{ stopId: stop.id }} />
                : <ActionForm op="unskip" label="Put back" quiet hidden={{ stopId: stop.id }} />
            ) : undefined}
          />

          {writes && addresses.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-ink-700">Add a stop</h3>
              <ActionForm op="stop" label="Add" className="mt-2 flex flex-wrap items-end gap-2"
                          hidden={{ id: route.id }}>
                <select name="propertyId" className={input} aria-label="Address">
                  {addresses.map((property) => (
                    <option key={property.id} value={property.id}>
                      {[property.address.line1, property.address.city].filter((p) => p).join(", ")}
                    </option>
                  ))}
                </select>
                <input name="estimatedMinutes" inputMode="numeric" placeholder="Minutes"
                       aria-label="Minutes on site" className={`${input} w-24`} />
                <input name="intervalDays" inputMode="numeric" placeholder="Every n days"
                       aria-label="Days between visits" className={`${input} w-28`} />
                <input name="pricePerStop" inputMode="decimal" placeholder="Price"
                       aria-label="Price per stop" className={`${input} w-24`} />
                <input name="firstDueOn" type="date" className={input} aria-label="First due" />
              </ActionForm>
              <p className="mt-1 text-xs text-ink-500">
                One stop per property per route. The same address twice is a double booking written
                into the template, and every materialisation forever would produce the pair.
              </p>
            </div>
          )}
        </section>
      ) : opened ? (
        <Empty title="That route is not here">It may have been removed.</Empty>
      ) : null}
    </div>
  );
}
