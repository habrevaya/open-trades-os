import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { company, dispatchMap } from "@opentradesos/api/services";
import { can, geo } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { PinEditor } from "@/components/PinEditor";
import { tileSource } from "@/lib/map-tiles";
import { ActionForm } from "./ActionForm";
import { placeLocationPin, clearLocationPin } from "./actions";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";

/**
 * TECHNICIANS: WHAT THEY DO AND WHERE THEIR DAY STARTS
 *
 * Two things the dispatch map, the route optimiser and the qualification
 * check all read, and that nothing in the product could set: the skills on a
 * technician's own record, which had a column and no writer, and the place
 * their day starts and ends.
 *
 * A skill typed here counts against everybody else only once somebody is
 * recorded with it, and the screen says so beside the box, because recording
 * the first gas fitter is the moment everybody who is not one starts being
 * refused gas work.
 */
export default async function TechniciansPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "visit:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Technicians" />
        <Empty title="Not shown to your role">Technicians are part of the schedule, which your role does not read.</Empty>
      </div>
    );
  }

  const readsSettings = can(user.actor, "settings:read");
  const [{ technicians, companyStart }, travel, locations] = await Promise.all([
    dispatchMap.technicians(ctx),
    dispatchMap.travelSettings(ctx),
    readsSettings ? company.listLocations(ctx) : Promise.resolve([]),
  ]);
  const edits = can(user.actor, "user:write");
  const editsSettings = can(user.actor, "settings:write");
  const located = new Map(locations.map((l) => [l.id, {
    latitude: l.latitude, longitude: l.longitude, precision: l.locationPrecision, source: l.locationSource,
  }]));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Technicians" count={technicians.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        What each person is recorded as doing, which the board checks before sending them on their own, and
        where their day starts and ends, which the route optimiser measures from. A skill counts against
        somebody only once at least one person here is recorded with it.
      </p>

      <table aria-label="Technicians" className="mt-6 w-full text-left text-sm">
        <thead className="border-b border-steel-200 text-xs uppercase tracking-[0.08em] text-ink-500">
          <tr>
            <th className="py-2 pr-3 font-medium">Who</th>
            <th className="py-2 pr-3 font-medium">Skills and where the day starts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-steel-200">
          {technicians.map((t) => (
            <tr key={t.id} className="align-top">
              <td className="py-3 pr-3">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color ?? "#64748B" }} aria-hidden />
                  <span className="font-medium">{t.displayName}</span>
                </span>
                {!t.active && <span className="ml-2 text-xs text-ink-500">Not active</span>}
              </td>
              <td className="py-3 pr-3">
                {edits ? (
                  <ActionForm op="profile" label="Save" quiet hidden={{ id: t.id }}>
                    <label className="block">
                      <span className="block text-xs font-medium text-ink-700">Skills, comma separated</span>
                      <input name="skills" defaultValue={t.skills.join(", ")} placeholder="gas-fitting, hvac-service"
                             aria-label={`Skills for ${t.displayName}`} className={`${input} w-72`} />
                    </label>
                    <label className="block">
                      <span className="block text-xs font-medium text-ink-700">Day starts at</span>
                      <select name="homeLocationId" defaultValue={t.homeLocationId ?? ""}
                              aria-label={`Where ${t.displayName}'s day starts`} className={input}>
                        <option value="">{companyStart ? `The company's first location (${companyStart.name})` : "The company's first location"}</option>
                        {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-xs font-medium text-ink-700">Colour</span>
                      <input name="color" type="color" defaultValue={t.color ?? "#64748B"}
                             aria-label={`Colour for ${t.displayName}`} className="h-8 w-12 rounded border border-steel-300" />
                    </label>
                  </ActionForm>
                ) : (
                  <p className="text-ink-700">
                    {t.skills.length > 0 ? t.skills.join(", ") : "Nothing recorded"}
                    <span className="text-ink-500">
                      {" "}starts at {locations.find((l) => l.id === t.homeLocationId)?.name ?? "the company's first location"}
                    </span>
                  </p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="mt-10">
        <h2 className="text-base font-semibold">How drive time is estimated</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          A straight line between two addresses, stretched by the road factor, at the average speed. Wrong
          for any one drive and about right across a day. Two stops on the same route use the drive time
          declared on the route instead.
        </p>
        {editsSettings ? (
          <ActionForm op="travel" label="Save" className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-ink-700">Average speed, miles an hour</span>
              <input name="averageMph" inputMode="decimal" defaultValue={String(Math.round(travel.averageKmh / geo.KM_PER_MILE))}
                     className={`${input} w-24`} />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-700">Road factor</span>
              <input name="roadFactor" inputMode="decimal" defaultValue={String(travel.roadFactor)} className={`${input} w-24`} />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-700">The day starts at</span>
              <input name="dayStartsAt" type="time" defaultValue={travel.dayStartsAt} className={input} />
            </label>
          </ActionForm>
        ) : (
          <p className="mt-2 text-sm text-ink-700">
            About {Math.round(travel.averageKmh / geo.KM_PER_MILE)} miles an hour, a road factor of {travel.roadFactor},
            and the day starting at {travel.dayStartsAt}.
          </p>
        )}
      </section>

      {readsSettings && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Where days start</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            The company&apos;s locations, on the map. Somebody with no start of their own starts at the first one.
          </p>
          {locations.length === 0 && (
            <Empty title="No locations yet">
              Add the yard or the office under <a href="/settings/service-area" className="underline">Service area</a>,
              and it becomes where everybody&apos;s day starts.
            </Empty>
          )}
          <ul className="mt-4 space-y-8">
            {locations.filter((l) => l.active).map((l) => (
              <li key={l.id} aria-label={`Location ${l.name}`}>
                <h3 className="font-medium">{l.name}</h3>
                <p className="text-sm text-ink-500">{[l.addressLine1, l.city, l.state].filter(Boolean).join(", ") || "No address"}</p>
                <LocationPin id={l.id} name={l.name} edits={editsSettings} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );

  /** A location's pin, read through the same rows the optimiser reads. */
  function LocationPin({ id, name, edits: writes }: { id: string; name: string; edits: boolean }) {
    const row = located.get(id);
    return (
      <div className="mt-2">
        <PinEditor
          id={id}
          label={name}
          tiles={tileSource()}
          current={{
            latitude: row?.latitude ?? null, longitude: row?.longitude ?? null,
            precision: row?.precision ?? null, source: row?.source ?? null,
          }}
          place={writes ? placeLocationPin : null}
          clear={writes ? clearLocationPin : null}
        />
      </div>
    );
  }
}
