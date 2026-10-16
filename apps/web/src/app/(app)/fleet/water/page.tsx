import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assets, truckWater } from "@opentradesos/api/services";
import { can, time } from "@opentradesos/core";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { recordWaterAction, removeWaterAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * FRESH WATER, BY TRUCK
 *
 * What each truck's tank says it used on a day, beside the stops completed
 * that day by whoever had it checked out, and the gallons a stop. Drivers read
 * it on the phone at the end of the day; the office types or corrects it here.
 * A truck that starts using more water a stop than it did is a nozzle or a
 * burner going, and the trade scorecard's fresh water per stop is made from
 * these days, per truck. A day with stops and no reading is said to be not
 * read, never shown as no water.
 */
export default async function TruckWaterPage({
  searchParams,
}: {
  searchParams: Promise<{ truck?: string; from?: string; to?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;

  if (!can(user.actor, "asset:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Fresh water by truck" />
        <Empty title="Not shown to your role">The fleet needs the view company assets permission.</Empty>
      </div>
    );
  }

  const today = time.dateIn(new Date(), user.organizationTimezone);
  const isDay = (value: string | undefined) => value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const to = isDay(params.to) ? params.to! : today;
  const from = isDay(params.from) ? params.from! : time.addDays(to, -13);
  const [{ days }, register] = await Promise.all([
    truckWater.days(ctx, { from, to }),
    assets.handlers.listAssets(ctx, {}),
  ]);
  const vehicles = register.assets.filter((a) => a.kind === "vehicle");
  const shown = params.truck ? days.filter((d) => d.assetId === params.truck) : days;
  const trucks = [...new Map(shown.map((d) => [d.assetId, d.label])).entries()];
  const writes = can(user.actor, "asset:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Fresh water by truck" />
      <p className="mt-2 text-sm text-ink-700">
        What each truck used, read off the tank by its driver, beside the stops done that day by whoever had it.
        {" "}{from} to {to}.{params.truck ? <> <a href={`/fleet/water?from=${from}&to=${to}`} className="text-blue-600 underline underline-offset-4">Show every truck</a></> : null}
      </p>

      {writes && vehicles.length > 0 ? (
        <section aria-label="Record a reading" className="mt-6">
          <h2 className="text-base font-semibold">Record a reading</h2>
          <ActionForm action={recordWaterAction} submit="Save the reading" className="mt-2 flex flex-wrap items-end gap-3">
            <Select label="Truck" name="assetId" defaultValue={params.truck ?? vehicles[0]!.id}
                    options={vehicles.map((v) => ({ value: v.id, label: v.label }))} className="min-w-48" />
            <TextField label="Day" name="onDay" type="date" defaultValue={today} max={today} className="w-44" />
            <TextField label="Gallons used" name="gallons" inputMode="decimal" placeholder="410" className="w-36" />
            <TextField label="Note" name="note" placeholder="Read from the fill meter" className="min-w-48 flex-1" />
          </ActionForm>
          <p className="mt-1 text-xs text-ink-500">Saving a day that already has a reading replaces it.</p>
        </section>
      ) : null}

      {trucks.length === 0 ? (
        <Empty title="No truck days in these two weeks">
          A truck shows here once it is checked out to somebody who completes stops, or once its water is read.
        </Empty>
      ) : trucks.map(([assetId, label]) => {
        const rows = shown.filter((d) => d.assetId === assetId);
        const counted = rows.filter((d) => d.gallons !== null && d.stops > 0);
        const gallons = counted.reduce((sum, d) => sum + Number(d.gallons), 0);
        const stops = counted.reduce((sum, d) => sum + d.stops, 0);
        return (
          <section key={assetId} aria-label={label} className="mt-8">
            <h2 className="text-base font-semibold">{label}</h2>
            <p className="text-sm text-ink-700">
              {stops > 0 ? `${gallons} gallons over ${stops} stops on the days read: ${(gallons / stops).toFixed(1)} a stop.` : "No day with both stops and a reading yet."}
            </p>
            <Table label={`Water by day, ${label}`} head={<><Th>Day</Th><Th>Stops</Th><Th>Gallons</Th><Th>A stop</Th><Th>Read on</Th>{writes ? <Th /> : null}</>}>
              {rows.map((d) => (
                <tr key={d.onDay}>
                  <Td>{d.onDay}</Td>
                  <Td>{d.stops}</Td>
                  <Td>{d.gallons === null ? (d.stops > 0 ? "Not read" : "") : Number(d.gallons)}</Td>
                  <Td>{d.perStop ?? ""}</Td>
                  <Td>{d.source === "phone" ? "The driver's phone" : d.source === "office" ? "The office" : ""}</Td>
                  {writes ? (
                    <Td>
                      {d.gallons !== null ? (
                        <ActionForm action={removeWaterAction} submit="Take off" tone="quiet" hidden={{ assetId: d.assetId, onDay: d.onDay }} className="" />
                      ) : null}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </Table>
          </section>
        );
      })}
    </div>
  );
}
