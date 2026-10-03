import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, stockUnits } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField, TextArea, Select } from "@/components/ActionForm";
import { receiveStockAction, transferStockAction, useOnJobAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * WHAT IS ON THE SHELF, AND ON EACH VAN
 *
 * Three questions, in the order a person asks them: what have we got, what
 * is spoken for, and what should we buy.
 *
 * A row per item PER LOCATION rather than per item. "Is it in stock" has no
 * single answer once a van is a location, and the flattened version of this
 * screen is what produces the technician who was told yes and drove to a
 * property without the part.
 */
export default async function InventoryPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "inventory:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Inventory" />
        <Empty title="Inventory is not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const [levels, reserved, buy, items, places] = await Promise.all([
    inventory.levels(ctx),
    inventory.commitments(ctx),
    inventory.toOrder(ctx),
    stockUnits.stockItems(ctx),
    stockUnits.stockLocations(ctx),
  ]);
  const moves = can(user.actor, "inventory:adjust") && items.length > 0 && places.length > 0;
  /**
   * The item list says how each part is tracked, because the one thing a
   * person receiving a compressor has to know before they press the button
   * is that it wants its serial numbers.
   */
  const itemOptions = items.map((item) => ({
    value: item.id,
    label: `${item.name} (${item.code})${item.tracking === "serial" ? ", by serial" : item.tracking === "lot" ? ", by lot" : ""}`,
  }));
  const placeOptions = places.map((p) => ({ value: p.id, label: p.isWarehouse ? `${p.name} (warehouse)` : p.name }));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Inventory" />
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Every number here is folded from the movement history. Nothing on this
        screen is a stored total, which is why a count is recorded as the
        correction rather than as the answer.
      </p>

      {/*
        What to buy is FIRST when there is anything, because it is the only
        part of this screen somebody has to act on today. A stock list is
        reference; a shortfall is a phone call.
      */}
      {buy.length > 0 && (
        <>
          <h2 className="mt-8 text-base font-semibold">Worth ordering</h2>
          <p className="mt-1 text-sm text-ink-500">
            Counted against available plus what is already on order, so
            something on its way is not ordered twice.
          </p>
          <Table head={<><Th>Item</Th><Th>Where</Th><Th className="text-right">Available</Th><Th className="text-right">On order</Th><Th className="text-right">Point</Th><Th className="text-right">Order</Th></>}>
            {buy.map((row) => (
              <tr key={`${row.itemId}-${row.locationId}`}>
                <Td className="text-ink-700">{row.itemName}</Td>
                <Td className="text-ink-700">{row.locationName}</Td>
                <Td className="text-right font-mono tabular-nums">{row.availableNow}</Td>
                <Td className="text-right font-mono tabular-nums text-ink-500">{row.onOrder}</Td>
                <Td className="text-right font-mono tabular-nums text-ink-500">{row.reorderPoint}</Td>
                <Td className="text-right font-mono tabular-nums font-medium">{row.suggested}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      <h2 className="mt-8 text-base font-semibold">On hand</h2>
      {levels.length === 0 ? (
        <Empty title="Nothing has moved yet">
          A level appears here the first time something is received, which is
          the only movement that establishes what stock cost.
        </Empty>
      ) : (
        <Table head={<><Th>Item</Th><Th>Where</Th><Th className="text-right">On hand</Th><Th className="text-right">Reserved</Th><Th className="text-right">Available</Th></>}>
          {levels.map((row) => (
            <tr key={`${row.itemId}-${row.locationId}`}>
              <Td>
                <span className="text-ink-700">{row.itemName}</span>
                <span className="ml-2 font-mono text-xs text-ink-500">{row.itemCode}</span>
              </Td>
              <Td className="text-ink-700">{row.locationName}</Td>
              <Td className="text-right font-mono tabular-nums">{row.onHand}</Td>
              <Td className="text-right font-mono tabular-nums text-ink-500">{row.committed}</Td>
              {/*
                Available is the number a dispatcher acts on, so it is the one
                in full ink. It is computed on every render from the other
                two and is stored nowhere.
              */}
              <Td className={`text-right font-mono tabular-nums ${
                Number(row.available) <= 0 ? "text-red-600" : "font-medium"
              }`}>
                {row.available}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {moves && (
        <section className="mt-10" aria-labelledby="move-stock">
          <h2 id="move-stock" className="text-base font-semibold">Move stock</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            A part tracked by serial or lot needs its numbers: one per line, or separated by commas, as
            they are read off the label or scanned. Leave the quantity empty and it is the number of serials.
            Serials, the trucks and what each should carry are under{" "}
            <a href="/inventory/serials" className="underline underline-offset-4">Serials and lots</a> and{" "}
            <a href="/inventory/trucks" className="underline underline-offset-4">Truck stock</a>.
          </p>
          <div className="mt-4 grid gap-6 lg:grid-cols-3">
            <div className="rounded-md border border-steel-200 bg-canvas p-4">
              <h3 className="font-medium">Receive</h3>
              <p className="mt-1 text-xs text-ink-500">Stock arriving without a purchase order. An order is received on its own page.</p>
              <ActionForm action={receiveStockAction} submit="Receive" className="mt-3 space-y-3">
                <Select label="Part" name="itemId" options={itemOptions} />
                <Select label="Into" name="locationId" options={placeOptions} />
                <TextField label="Quantity" name="quantity" inputMode="decimal" />
                <TextField label="What it all cost" name="totalCost" inputMode="decimal" required />
                <TextArea label="Serial or lot numbers" name="units" rows={3} />
              </ActionForm>
            </div>
            <div className="rounded-md border border-steel-200 bg-canvas p-4">
              <h3 className="font-medium">Move between places</h3>
              <p className="mt-1 text-xs text-ink-500">From the warehouse onto a truck, or truck to truck.</p>
              <ActionForm action={transferStockAction} submit="Move" className="mt-3 space-y-3">
                <Select label="Part" name="itemId" options={itemOptions} />
                <Select label="From" name="fromLocationId" options={placeOptions} />
                <Select label="To" name="toLocationId" options={placeOptions} />
                <TextField label="Quantity" name="quantity" inputMode="decimal" />
                <TextArea label="Serial or lot numbers" name="units" rows={3} />
              </ActionForm>
            </div>
            <div className="rounded-md border border-steel-200 bg-canvas p-4">
              <h3 className="font-medium">Use on a job</h3>
              <p className="mt-1 text-xs text-ink-500">
                A serialised unit installed at the job&apos;s address can be recorded as the customer&apos;s
                equipment in the same go: give it a kind, like Condenser.
              </p>
              <ActionForm action={useOnJobAction} submit="Use on the job" className="mt-3 space-y-3">
                <Select label="Part" name="itemId" options={itemOptions} />
                <Select label="Taken from" name="locationId" options={placeOptions} />
                <TextField label="Job number" name="jobNumber" inputMode="numeric" required />
                <TextField label="Quantity" name="quantity" inputMode="decimal" />
                <TextArea label="Serial or lot numbers" name="units" rows={2} />
                <TextField label="Record as customer equipment, of the kind" name="installCategory" placeholder="Condenser" />
                <div className="grid grid-cols-2 gap-2">
                  <TextField label="Make" name="installManufacturer" />
                  <TextField label="Model" name="installModel" />
                </div>
              </ActionForm>
            </div>
          </div>
        </section>
      )}

      <h2 className="mt-8 text-base font-semibold">Spoken for</h2>
      {reserved.length === 0 ? (
        <Empty title="Nothing is reserved">
          A reservation belongs to a job, so this is the list of parts that
          are on a shelf and already have somebody&rsquo;s name on them.
        </Empty>
      ) : (
        <Table head={<><Th>Item</Th><Th>Where</Th><Th>For</Th><Th className="text-right">Held</Th></>}>
          {reserved.map((row) => (
            <tr key={`${row.itemId}-${row.locationId}-${row.jobId}`}>
              <Td className="text-ink-700">{row.itemName}</Td>
              <Td className="text-ink-700">{row.locationName}</Td>
              <Td>
                <a href={`/jobs/${row.jobId}`} className="text-ink-700 hover:underline">
                  <span className="font-mono tabular-nums text-ink-500">{row.jobNumber}</span>{" "}
                  {row.jobSummary ?? "Untitled"}
                </a>
              </Td>
              <Td className="text-right font-mono tabular-nums">{row.quantity}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
