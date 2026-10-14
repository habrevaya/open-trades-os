import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assets, rentalBilling, trucks } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { addKindAction, changeKindAction, retireKindAction, truckKindAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * EACH TRUCK ITS OWN KIND
 *
 * A hook lift that carries two small cans and a roll off truck that carries one
 * big one are not the same truck. A kind says how many containers a truck
 * carries (of each size, when that differs: two 10 yard or one 30 yard),
 * which sizes it lifts and how long the yard takes it, and a vehicle
 * given one is what a driver's day is planned on when that vehicle is checked
 * out to them. A truck with no kind is planned on the company's figures.
 */
export default async function TrucksPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "asset:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Trucks" />
        <Empty title="Not shown to your role">The trucks need the view company assets permission.</Empty>
      </div>
    );
  }
  const writes = can(user.actor, "asset:write");
  const [{ kinds }, register, company] = await Promise.all([
    trucks.listKinds(ctx),
    assets.listAssets(ctx, { kind: "vehicle" }),
    rentalBilling.rentalDispatch(ctx),
  ]);
  const kindOf = new Map(kinds.flatMap((k) => k.trucks.map((t) => [t.id, k] as const)));
  const sizesText = (sizes: number[]) => (sizes.length === 0 ? "any size" : `${sizes.join(", ")} yard`);
  const count = ["none", "one", "two", "three", "four"];
  /** "two 10 yard or one 30 yard", or the one figure. */
  const carries = (kind: (typeof kinds)[number]) => kind.capacityBySize.length > 0
    ? kind.capacityBySize.map((p) => `${count[p.carried] ?? p.carried} ${p.size} yard`).join(" or ")
    : kind.containersCarried === 1 ? "one container" : `${kind.containersCarried} containers`;
  const perSizeText = (kind: (typeof kinds)[number]) => kind.capacityBySize.map((p) => `${p.carried} of ${p.size}`).join(", ");
  const options = [
    { value: "", label: "None, the company's figures" },
    ...kinds.map((k) => ({ value: k.id, label: k.name })),
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/fleet/containers">Containers</Crumb>
      <PageHeader title="Trucks" count={register.assets.length} />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        Optimise route plans a driver&apos;s day on the truck checked out to them that day. A truck with no kind is
        planned on the company&apos;s figures: {company.containersPerTruck === 1 ? "one container" : `${company.containersPerTruck} containers`} a
        truck, {company.yardMinutes} minutes at the yard.
      </p>

      <h2 className="mt-8 text-base font-semibold">Kinds of truck</h2>
      {kinds.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No kinds yet. Add the first below.</p>
      ) : (
        <ul className="mt-3 space-y-4">
          {kinds.map((kind) => (
            <li key={kind.id} className="rounded border border-steel-300 p-3">
              <p className="font-medium">{kind.name}</p>
              <p className="text-sm text-ink-700">
                Carries {carries(kind)}, lifts {sizesText(kind.containerSizes)},{" "}
                {kind.yardMinutes} minutes at the yard.{" "}
                {kind.trucks.length === 0 ? "No truck has this kind." : `Trucks: ${kind.trucks.map((t) => t.label).join(", ")}.`}
              </p>
              {writes ? (
                <>
                  <ActionForm action={changeKindAction} submit="Save" tone="quiet" className="mt-2 flex flex-wrap items-end gap-3"
                              hidden={{ id: kind.id }}>
                    <TextField label="Containers carried" name="containersCarried" type="number" min={1} max={4}
                               defaultValue={kind.containersCarried} className="w-40" />
                    <TextField label="Sizes lifted, in yards" name="containerSizes" placeholder="10, 20, 30"
                               defaultValue={kind.containerSizes.join(", ")} className="w-48" />
                    <TextField label="How many of each size" name="capacityBySize" placeholder="2 of 10, 1 of 30"
                               defaultValue={perSizeText(kind)} className="w-56" />
                    <TextField label="Minutes at the yard" name="yardMinutes" type="number" min={0} max={120}
                               defaultValue={kind.yardMinutes} className="w-40" />
                  </ActionForm>
                  <ActionForm action={retireKindAction} submit="Remove" tone="quiet" className="mt-2 inline-flex" hidden={{ id: kind.id }} />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {writes ? (
        <section className="mt-6" aria-labelledby="add-kind">
          <h2 id="add-kind" className="text-base font-semibold">Add a kind of truck</h2>
          <ActionForm action={addKindAction} submit="Add kind" className="mt-2 grid gap-3 sm:grid-cols-4">
            <TextField label="Name" name="name" required placeholder="Roll off" />
            <TextField label="Containers carried" name="containersCarried" type="number" min={1} max={4} defaultValue={1} />
            <TextField label="Sizes lifted, in yards" name="containerSizes" placeholder="Empty means any" />
            <TextField label="Minutes at the yard" name="yardMinutes" type="number" min={0} max={120} defaultValue={company.yardMinutes} />
            <TextField label="How many of each size" name="capacityBySize" placeholder="2 of 10, 1 of 30" className="sm:col-span-2" />
          </ActionForm>
          <p className="mt-2 max-w-prose text-xs text-ink-500">
            Leave how many of each size empty when the truck carries the same number of any size. Filled in, each can takes
            its share of the truck: with 2 of 10 and 1 of 30, two 10 yard cans fit, and a 10 beside a 30 does not. A can of
            a size not listed, or of no known size, counts against the containers carried.
          </p>
        </section>
      ) : null}

      <h2 className="mt-8 text-base font-semibold">Vehicles</h2>
      {register.assets.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No vehicles on the register. Add a truck on Vans and tools first.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {register.assets.map((vehicle) => (
            <li key={vehicle.id} className="flex flex-wrap items-end gap-3">
              <span className="w-48 text-sm font-medium">
                {vehicle.label}
                <span className="block text-xs font-normal text-ink-500">
                  {kindOf.get(vehicle.id)?.name ?? "Company figures"}
                </span>
              </span>
              {writes ? (
                <ActionForm action={truckKindAction} submit="Set kind" tone="quiet" className="flex flex-wrap items-end gap-2"
                            hidden={{ assetId: vehicle.id }}>
                  <Select label={`Kind of ${vehicle.label}`} name="truckKindId" options={options}
                          defaultValue={kindOf.get(vehicle.id)?.id ?? ""} className="w-64" />
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
