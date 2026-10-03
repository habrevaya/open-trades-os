import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { stockUnits } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { setTrackingAction, writeOffAction } from "../actions";

export const dynamic = "force-dynamic";

const STATE: Record<string, { label: string; tone: "success" | "info" | "neutral" }> = {
  in_stock: { label: "In stock", tone: "success" },
  used: { label: "Used on a job", tone: "info" },
  gone: { label: "Written off", tone: "neutral" },
};

/**
 * SERIALS AND LOTS
 *
 * Which parts are tracked by number, and every number: where it is, or which
 * job it went to. A number matches anywhere in it, because a label read off a
 * unit in a dark basement is often half a number, and each one opens its
 * trace from the order it arrived on to the customer's equipment it became.
 */
export default async function SerialsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "inventory:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Serials and lots" />
        <Empty title="Inventory is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const params = await searchParams;
  const number = typeof params["number"] === "string" ? params["number"] : undefined;
  const [units, tracked, items, places] = await Promise.all([
    stockUnits.units(ctx, { ...(number ? { number } : {}), limit: 300 }),
    stockUnits.trackedItems(ctx),
    stockUnits.stockItems(ctx),
    stockUnits.stockLocations(ctx),
  ]);
  const adjusts = can(user.actor, "inventory:adjust");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Serials and lots" count={units.length} />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">Find a number</span>
          <input name="number" defaultValue={number ?? ""} placeholder="Part of the serial"
                 className="h-9 w-64 rounded border border-steel-300 px-2 font-mono text-sm" />
        </label>
        <button type="submit" className="h-9 rounded bg-ink-900 px-3 font-medium text-white hover:bg-ink-700">Find</button>
      </form>

      {units.length === 0 ? (
        <Empty title={number ? `Nothing numbered like ${number}` : "No numbers yet"}>
          A serial or lot appears here the first time a tracked part is received with its number.
        </Empty>
      ) : (
        <Table label="Numbers" head={<><Th>Number</Th><Th>Part</Th><Th>Where</Th><Th /></>}>
          {units.map((unit) => (
            <tr key={unit.id}>
              <Td><a href={`/inventory/serials/${unit.id}`} className="font-mono font-medium hover:underline">{unit.number}</a></Td>
              <Td className="text-ink-700">{unit.itemName} <span className="font-mono text-xs text-ink-500">{unit.itemCode}</span></Td>
              <Td>
                <Chip tone={STATE[unit.state]?.tone ?? "neutral"}>{STATE[unit.state]?.label ?? unit.state}</Chip>
                {unit.where.length > 0 ? (
                  <span className="ml-2 text-ink-700">
                    {unit.where.map((w) => unit.mode === "lot" ? `${w.locationName} (${w.quantity})` : w.locationName).join(", ")}
                  </span>
                ) : null}
                {unit.jobNumber ? <a href={`/jobs/${unit.jobId}`} className="ml-2 hover:underline">job {unit.jobNumber}</a> : null}
              </Td>
              <Td className="text-right"><a href={`/inventory/serials/${unit.id}`} className="text-sm underline underline-offset-4">Trace</a></Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-10 text-base font-semibold">Parts tracked by number</h2>
      {tracked.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">Nothing yet. Every other part is counted only.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {tracked.map((t) => (
            <li key={t.itemId}>{t.itemName} <span className="font-mono text-xs text-ink-500">{t.itemCode}</span>: {t.mode === "serial" ? "by serial number" : "by lot"}</li>
          ))}
        </ul>
      )}
      {adjusts && items.length > 0 && (
        <ActionForm action={setTrackingAction} submit="Save" className="mt-4 flex flex-wrap items-end gap-3" done="Saved.">
          <Select label="Part" name="itemId" className="w-72" options={items.map((i) => ({ value: i.id, label: `${i.name} (${i.code})` }))} />
          <Select label="Track it" name="mode" className="w-48" options={[
            { value: "serial", label: "By serial number" }, { value: "lot", label: "By lot" }, { value: "", label: "Count only" },
          ]} />
        </ActionForm>
      )}
      <p className="mt-2 max-w-prose text-xs text-ink-500">
        Start tracking a part when its shelf is empty or before its next delivery: units already on hand have no
        numbers, and every move of a tracked part has to say which ones.
      </p>

      {adjusts && tracked.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Write off by number</h2>
          <p className="mt-1 text-sm text-ink-500">Damaged, lost or gone from a truck. A tracked part is never counted down by number alone.</p>
          <ActionForm action={writeOffAction} submit="Write off" className="mt-3 grid gap-3 sm:grid-cols-2" tone="danger">
            <Select label="Part" name="itemId" options={tracked.map((t) => ({ value: t.itemId, label: t.itemName }))} />
            <Select label="Where it was" name="locationId" options={places.map((p) => ({ value: p.id, label: p.name }))} />
            <TextArea label="Serial or lot numbers" name="units" rows={2} />
            <TextField label="Why" name="reason" required />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
