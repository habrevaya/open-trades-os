import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { disposalFacilities } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import {
  addFacilityAction, changeFacilityAction, closeFacilityAction, defaultFacilityAction, pinFacilityAction,
} from "./actions";

export const dynamic = "force-dynamic";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first, the way a week is read in a yard. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const BASIS = [
  { value: "", label: "No rate recorded" },
  { value: "per_ton", label: "By the ton" },
  { value: "per_load", label: "By the load" },
];

type Facility = Awaited<ReturnType<typeof disposalFacilities.listFacilities>>["facilities"][number];

/** The seven pairs of boxes. A day left empty is a day the facility is closed. */
function HoursBoxes({ hours }: { hours?: Facility["hours"] }) {
  return (
    <fieldset className="sm:col-span-4">
      <legend className="text-sm font-medium text-ink-700">When it takes loads</legend>
      <p className="text-xs text-ink-500">Leave a day empty if it is closed. Leave all seven empty if you do not know.</p>
      <div className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {WEEK.map((day) => {
          const held = hours?.find((h) => h.day === day);
          return (
            <div key={day} className="flex items-center gap-2 text-sm">
              <span className="w-24">{DAYS[day]}</span>
              <input type="time" name={`opens${day}`} defaultValue={held?.opens ?? ""} aria-label={`${DAYS[day]} opens`}
                     className="h-9 rounded border border-steel-300 bg-canvas px-2" />
              <span>to</span>
              <input type="time" name={`closes${day}`} defaultValue={held?.closes ?? ""} aria-label={`${DAYS[day]} closes`}
                     className="h-9 rounded border border-steel-300 bg-canvas px-2" />
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Holidays as two boxes of lines: one off days with a year, and days that repeat every year. */
function HolidayBoxes({ holidays }: { holidays?: Facility["holidays"] }) {
  const once = (holidays ?? []).filter((h) => !h.yearly).map((h) => `${h.date}${h.name ? ` ${h.name}` : ""}`).join("\n");
  const yearly = (holidays ?? []).filter((h) => h.yearly).map((h) => `${h.date.slice(5)}${h.name ? ` ${h.name}` : ""}`).join("\n");
  return (
    <fieldset className="sm:col-span-4">
      <legend className="text-sm font-medium text-ink-700">Days it is closed</legend>
      <p className="text-xs text-ink-500">
        A day listed here is closed whatever its hours say, and a day plan never sends a truck there.
        One line for each day.
      </p>
      <div className="mt-1 grid gap-3 sm:grid-cols-2">
        <TextArea label="Closed on these dates (like 2026-11-26 Thanksgiving)" name="holidaysOnce" rows={3} defaultValue={once} />
        <TextArea label="Closed every year on (like 12-25 Christmas)" name="holidaysYearly" rows={3} defaultValue={yearly} />
      </div>
    </fieldset>
  );
}

function RateBoxes({ facility }: { facility?: Facility }) {
  return (
    <>
      <Select label="Charges" name="feeBasis" options={BASIS} defaultValue={facility?.feeBasis ?? ""} />
      <TextField label="How much" name="feeAmount" inputMode="decimal" placeholder="62.50"
                 defaultValue={facility?.feeAmount ? Number(facility.feeAmount).toFixed(2) : ""} />
      <TextField label="At least, for any load" name="minimumFee" inputMode="decimal" placeholder="Leave empty if none"
                 defaultValue={facility?.minimumFee ? Number(facility.minimumFee).toFixed(2) : ""} />
      <TextField label="Minutes at the facility" name="tipMinutes" type="number" min={0} max={180}
                 defaultValue={facility?.tipMinutes ?? 20} />
    </>
  );
}

/**
 * DISPOSAL FACILITIES
 *
 * The landfills and transfer stations a full container is tipped at. Each has an
 * address (put on the map for you, or pinned by hand), the days and hours it takes
 * loads, the days it is closed, and what it charges. Optimise route sends each
 * full container to the nearest one that is open when the truck gets there: yard to
 * customer to facility to the next stop, and says which one and why.
 */
export default async function FacilitiesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "asset:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Disposal facilities" />
        <Empty title="Not shown to your role">The facilities need the view company assets permission.</Empty>
      </div>
    );
  }
  const writes = can(user.actor, "asset:write");
  const { facilities } = await disposalFacilities.listFacilities(ctx);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/fleet/containers">Containers</Crumb>
      <PageHeader title="Disposal facilities" count={facilities.length} />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        Where a full container is tipped. Optimise route sends each full container to the nearest facility that is
        open when the truck gets there, counts the time at its gate, and says which one it chose and why. A facility
        closed that day, by its hours or a day you list as closed, is skipped. Public holidays are not known: add the
        days each facility is closed. The default one wins a tie.
      </p>

      {facilities.length === 0 ? (
        <p className="mt-6 text-sm text-ink-500">No facilities yet. Add the first below.</p>
      ) : (
        <ul className="mt-6 space-y-6">
          {facilities.map((facility) => (
            <li key={facility.id} className="rounded border border-steel-300 p-4" aria-label={facility.name}>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h2 className="text-base font-semibold">{facility.name}</h2>
                {facility.isDefault ? <span className="text-sm font-medium text-green-700">Default</span> : null}
              </div>
              <p className="text-sm text-ink-700">{facility.address || "No address yet"}</p>
              <p className="text-sm text-ink-700">{facility.hoursText}. {facility.feeText}. {facility.tipMinutes} minutes there.</p>
              {facility.holidays.length > 0 ? (
                <p className="text-sm text-ink-700">
                  Closed on {[...facility.holidays.filter((h) => !h.yearly), ...facility.holidays.filter((h) => h.yearly)]
                    .map((h) => `${h.yearly ? `every ${h.date.slice(5)}` : h.date}${h.name ? ` (${h.name})` : ""}`).join(", ")}.
                </p>
              ) : null}
              <p className={`text-sm ${facility.onTheMap ? "text-ink-700" : "text-amber-700"}`}>
                {facility.onTheMap
                  ? `On the map${facility.locationSource === "manual" ? ", pinned by hand" : ""}.`
                  : "Not on the map yet, so a day cannot be planned through it. Add the address, or place the pin."}
              </p>
              {writes ? (
                <div className="mt-3 space-y-3">
                  <ActionForm action={changeFacilityAction} submit="Save changes" tone="quiet"
                              className="grid gap-3 sm:grid-cols-4" hidden={{ id: facility.id }}>
                    <TextField label="Street" name="addressLine1" defaultValue={facility.addressLine1 ?? ""} className="sm:col-span-2" />
                    <TextField label="City" name="city" defaultValue={facility.city ?? ""} />
                    <TextField label="State" name="state" defaultValue={facility.state ?? ""} />
                    <TextField label="ZIP" name="postalCode" defaultValue={facility.postalCode ?? ""} />
                    <RateBoxes facility={facility} />
                    <HoursBoxes hours={facility.hours} />
                    <HolidayBoxes holidays={facility.holidays} />
                  </ActionForm>
                  <div className="flex flex-wrap items-end gap-3">
                    {!facility.isDefault ? (
                      <ActionForm action={defaultFacilityAction} submit="Make the default" tone="quiet" className="inline-flex"
                                  hidden={{ id: facility.id }} />
                    ) : null}
                    <ActionForm action={pinFacilityAction} submit="Place pin" tone="quiet" className="flex flex-wrap items-end gap-2"
                                hidden={{ id: facility.id }}>
                      <TextField label="Latitude" name="latitude" inputMode="decimal" placeholder="30.2672" className="w-32" />
                      <TextField label="Longitude" name="longitude" inputMode="decimal" placeholder="-97.7431" className="w-32" />
                    </ActionForm>
                    {facility.locationSource === "manual" ? (
                      <ActionForm action={pinFacilityAction} submit="Take the pin off" tone="quiet" className="inline-flex"
                                  hidden={{ id: facility.id, clear: "yes" }} />
                    ) : null}
                    <ActionForm action={closeFacilityAction} submit="Stop using" tone="quiet" className="inline-flex"
                                hidden={{ id: facility.id }} />
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {writes ? (
        <section className="mt-8" aria-labelledby="add-facility">
          <h2 id="add-facility" className="text-base font-semibold">Add a facility</h2>
          <ActionForm action={addFacilityAction} submit="Add facility" className="mt-2 grid gap-3 sm:grid-cols-4">
            <TextField label="Name" name="name" required placeholder="Austin Transfer Station" className="sm:col-span-2" />
            <TextField label="Street" name="addressLine1" className="sm:col-span-2" />
            <TextField label="City" name="city" />
            <TextField label="State" name="state" />
            <TextField label="ZIP" name="postalCode" />
            <span />
            <RateBoxes />
            <HoursBoxes />
            <HolidayBoxes />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
