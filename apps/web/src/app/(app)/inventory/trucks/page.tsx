import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { stockUnits, truckFills } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { checkTruckFillsAction, clearTruckMinimumAction, confirmTruckFillAction, dismissTruckFillAction, restockAction, setTruckMinimumAction } from "../actions";
import { formatDay } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * WHAT EACH TRUCK SHOULD CARRY, AND FILLING IT
 *
 * A truck is filled from the warehouse rather than bought for, so a truck
 * under its minimum suggests a move from the shelf holding the most, up to
 * its fill level. When the warehouse cannot cover it, the suggestion says how
 * short it is, and buying is the warehouse reorder point's decision on
 * Purchasing.
 *
 * Each night the worker writes the same suggestion down as a draft for each
 * truck, and the drafts are listed first. Nothing moves until somebody
 * presses the button on one.
 */
export default async function TrucksPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "inventory:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Truck stock" />
        <Empty title="Inventory is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const [minimums, suggestions, items, places, drafts] = await Promise.all([
    stockUnits.truckMinimums(ctx),
    stockUnits.restockSuggestions(ctx),
    stockUnits.stockItems(ctx),
    stockUnits.stockLocations(ctx),
    truckFills.list(ctx),
  ]);
  const adjusts = can(user.actor, "inventory:adjust");
  const trucks = places.filter((p) => !p.isWarehouse);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Truck stock" />

      <section className="mt-6" aria-labelledby="overnight">
        <h2 id="overnight" className="text-base font-semibold">Drafted overnight</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-500">
          Each night the trucks under their minimums are looked at and a move is written down for each. Nothing
          has moved until you press the button.
        </p>
        {drafts.length === 0 ? (
          <p className="mt-2 text-sm text-ink-700">No truck is waiting to be filled.</p>
        ) : drafts.map((draft) => (
          <div key={draft.id} className="mt-4 rounded border border-steel-300 p-4">
            <h3 className="font-medium">{draft.truckName}</h3>
            <p className="text-sm text-ink-500">Written down {formatDay(draft.proposedOn, user.organizationTimezone)}</p>
            <Table label={`Fill for ${draft.truckName}`} head={<><Th>Part</Th><Th className="text-right">On the truck</Th><Th className="text-right">Move</Th><Th>From</Th></>}>
              {draft.lines.map((line) => (
                <tr key={line.id}>
                  <Td>{line.itemName}</Td>
                  <Td className="text-right tabular-nums">{line.onTruck}</Td>
                  <Td className="text-right tabular-nums">{line.quantity}</Td>
                  <Td>{line.fromLocationName}</Td>
                </tr>
              ))}
            </Table>
            {adjusts ? (
              <>
                <ActionForm action={confirmTruckFillAction} submit={`Move these onto ${draft.truckName}`} className="mt-3 space-y-3"
                            hidden={{ id: draft.id }}>
                  {draft.lines.filter((line) => line.tracking).map((line) => (
                    <TextArea key={line.id} label={`Serial or lot numbers for ${line.itemName}`} name={`units:${line.itemId}`} rows={2} />
                  ))}
                </ActionForm>
                <ActionForm action={dismissTruckFillAction} submit={`Not now, ${draft.truckName}`} tone="quiet" className="mt-2"
                            hidden={{ id: draft.id }} />
              </>
            ) : null}
          </div>
        ))}
        {adjusts ? (
          <ActionForm action={checkTruckFillsAction} submit="Check the trucks now" tone="quiet" className="mt-4" />
        ) : null}
      </section>

      <h2 className="mt-10 text-base font-semibold">Trucks to fill</h2>
      {suggestions.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">
          {minimums.length === 0 ? "No truck has a minimum yet. Set one below." : "Every truck is above its minimums."}
        </p>
      ) : (
        <Table label="Trucks to fill" head={<><Th>Truck</Th><Th>Part</Th><Th className="text-right">On the truck</Th><Th>Why</Th><Th /></>}>
          {suggestions.map((s) => (
            <tr key={`${s.truckId}:${s.itemId}`}>
              <Td>{s.truckName}</Td>
              <Td>{s.itemName}</Td>
              <Td className="text-right tabular-nums">{s.onTruck} of {s.target}</Td>
              <Td className="text-sm text-ink-700">{s.why}</Td>
              <Td>
                {adjusts && s.fromLocationId && s.take !== "0" ? (
                  <ActionForm action={restockAction} submit={`Move ${s.take} from ${s.fromLocationName}`} tone="quiet"
                              className="flex flex-wrap items-end gap-2"
                              hidden={{ itemId: s.itemId, truckId: s.truckId, fromLocationId: s.fromLocationId, quantity: s.take }}>
                    {s.tracking ? <TextArea label="Serial or lot numbers" name="units" rows={2} /> : null}
                  </ActionForm>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-10 text-base font-semibold">Minimums</h2>
      {minimums.length > 0 && (
        <Table label="Minimums" head={<><Th>Truck</Th><Th>Part</Th><Th className="text-right">Minimum</Th><Th className="text-right">Fill to</Th><Th /></>}>
          {minimums.map((row) => (
            <tr key={row.id}>
              <Td>{row.locationName}</Td>
              <Td>{row.itemName}</Td>
              <Td className="text-right tabular-nums">{row.minimum}</Td>
              <Td className="text-right tabular-nums">{row.target}</Td>
              <Td>{adjusts ? <ActionForm action={clearTruckMinimumAction} submit="Stop keeping" tone="quiet" className="" hidden={{ id: row.id }} /> : null}</Td>
            </tr>
          ))}
        </Table>
      )}
      {adjusts && trucks.length > 0 && items.length > 0 ? (
        <ActionForm action={setTruckMinimumAction} submit="Set" className="mt-4 flex flex-wrap items-end gap-3">
          <Select label="Truck" name="locationId" className="w-48" options={trucks.map((t) => ({ value: t.id, label: t.name }))} />
          <Select label="Part" name="itemId" className="w-72" options={items.map((i) => ({ value: i.id, label: `${i.name} (${i.code})` }))} />
          <TextField label="Minimum" name="minimum" inputMode="decimal" className="w-28" required />
          <TextField label="Fill to" name="target" inputMode="decimal" className="w-28" required />
        </ActionForm>
      ) : trucks.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">There are no trucks: a truck is any location that is not a warehouse, added on Settings.</p>
      ) : null}
    </div>
  );
}
