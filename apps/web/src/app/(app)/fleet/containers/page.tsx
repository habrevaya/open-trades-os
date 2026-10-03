import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rentals, rentalBilling, properties, inTenant } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { Empty, PageHeader } from "@/components/Table";
import { todayIn } from "@/lib/dates";
import { Numbers, Register, Hires, Overage } from "./ContainerView";
import { ActionForm } from "./ActionForm";
import { ActionForm as SaidForm, Select, TextField } from "@/components/ActionForm";
import { Money } from "@opentradesos/ui";
import { invoiceHireAction, recordChargeAction, removeChargeAction, scheduleCollectionsAction } from "./billing-actions";

const CHARGE_KINDS = [
  { value: "prohibited_item", label: "Prohibited item" },
  { value: "contamination", label: "Contaminated load" },
  { value: "overweight", label: "Overweight" },
  { value: "overfill", label: "Overfilled" },
  { value: "other", label: "Something else" },
];

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";
const KINDS = ["roll_off_container", "portable_toilet", "storage_container"] as const;
const KIND_LABEL: Record<string, string> = {
  roll_off_container: "Roll off container",
  portable_toilet: "Portable toilet",
  storage_container: "Storage container",
};

/**
 * THE CONTAINER FLEET
 *
 * The other half of M22, and a different question from the van register next
 * door. A chipper is checked out to a person; a container is hired to an address,
 * bills on two meters, and has a utilisation rate. That is why they are two
 * tables and why this is a separate screen rather than a kind filter on one.
 *
 * The dumpster rental trade pack shipped before any of this was built: two
 * hundred and seventy eight lines, six job types whose capacity model is
 * `asset_rental`, thirty eight price book items about container days and scale
 * tickets, and nothing that could record a container. Then the module arrived
 * with no screen, which for a dispatcher is the same as not existing.
 *
 * THE NUMBERS ARE AT THE TOP because this is the one trade where the daily
 * question is a ratio rather than a list: a roll off company with sixty cans and
 * forty per cent utilisation is losing money on twenty steel boxes, and nothing
 * on a board of hires says so.
 */
export default async function ContainersPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "asset:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Containers" />
        <Empty title="Not shown to your role">
          The container fleet needs the view company assets permission.
        </Empty>
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
  const today = todayIn(zone);
  const from = one("from") ?? `${today.slice(0, 7)}-01`;
  const to = one("to") ?? today;
  /** A hire whose overage somebody asked to see, by id in the query string. */
  const priced = one("overage");

  const [fleet, hires] = await Promise.all([
    rentals.listAssets(ctx, { limit: 500 }),
    rentals.listRentals(ctx, { limit: 200 }),
  ]);

  /**
   * The report is a separate call and a separate failure. A backwards window is
   * a refusal, and a refused window should empty the four figures rather than
   * the whole screen: the register and the board are still the answer to
   * everything else.
   */
  const report = await rentals.fleetReport(ctx, { from, to }).catch(() => null);

  /**
   * The overage, only when asked for, because it refuses while the can is still
   * on site and that refusal is the right answer rather than an error: an open
   * hire's overage changes every midnight and a number that does that beside an
   * invoice is one somebody puts on the invoice.
   */
  const overage = priced
    ? await rentals.overage(ctx, { id: priced }).then(
        (result) => ({ ok: true as const, ...result }),
        (error: unknown) => ({
          ok: false as const,
          why: error instanceof Error ? error.message : "That hire cannot be priced yet.",
        }),
      )
    : null;

  const writes = can(user.actor, "asset:write");
  const addresses = writes && can(user.actor, "property:read")
    ? (await properties.list(ctx, { limit: 200 })).data
    : [];
  const inTheYard = fleet.data.filter((row) => row.status === "available");
  const open = hires.data.filter((row) => row.open);
  const invoices = can(user.actor, "invoice:write");
  const schedules = writes && can(user.actor, "job:write");
  const [charges, fees] = await Promise.all([
    rentalBilling.charges(ctx, {}),
    writes ? rentalBilling.chargeFees(ctx) : Promise.resolve([]),
  ]);
  const hireLabel = new Map(hires.data.map((h) => [h.id, `${h.assetIdentifier ?? "A can"} at ${h.propertyAddress ?? "a site"}`]));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Containers" count={fleet.data.length} />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">From</span>
          <input type="date" name="from" defaultValue={from} className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">To</span>
          <input type="date" name="to" defaultValue={to} className={input} />
        </label>
        <button type="submit"
                className="h-8 rounded bg-ink-900 px-3 font-medium text-white hover:bg-ink-700">
          Show
        </button>
      </form>

      {report === null ? (
        <Empty title="That window was refused">
          The end of a window has to be after its start.
        </Empty>
      ) : (
        <Numbers report={report} />
      )}

      {overage ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold">What this hire is owed</h2>
          {overage.ok
            ? <Overage days={overage.days} lines={overage.lines} total={overage.total} />
            : <p className="mt-2 text-sm text-amber-700">{overage.why}</p>}
        </section>
      ) : null}

      <div className="mt-8 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Out on hire</h2>
        {writes ? (
          <a href="/fleet/containers/tickets" className="text-sm underline underline-offset-4">Import a facility&apos;s scale tickets</a>
        ) : null}
      </div>
      <Hires
        hires={hires.data}
        controls={(hire) => (
          <div className="flex flex-wrap gap-2">
            {hire.open && writes && (
              <ActionForm op="pickup" label="Collect" quiet hidden={{ id: hire.id }}>
                <input name="pickedUpAt" type="date" className={input} aria-label="Collected on" />
                {/*
                  Labelled for the action rather than the column, because a
                  collect form and a swap form sit on the same row and both ask
                  for a tonnage and a ticket. "Net tons" twice is two fields a
                  screen reader cannot tell apart, and a browser test found it
                  first by being unable to either.
                */}
                <input name="tons" inputMode="decimal" placeholder="Net tons"
                       aria-label="Net tons collected" className={`${input} w-24`} />
                <input name="ticketNumber" placeholder="Ticket"
                       aria-label="Ticket for the collection" className={`${input} w-24`} />
                {/*
                  Checked by default, because a can almost always goes back into
                  the yard. The unchecked case is the one that matters: a unit
                  tagged out straight off a customer site, which is the last line
                  of the pickup checklist and the only thing that changes the
                  utilisation denominator.
                */}
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="backInService" defaultChecked /> Back in service
                </label>
              </ActionForm>
            )}
            {hire.open && writes && inTheYard.length > 0 && (
              <ActionForm op="swap" label="Swap" quiet hidden={{ id: hire.id }}>
                <select name="replacementAssetId" className={input} aria-label="Empty can">
                  {inTheYard.map((asset) => (
                    <option key={asset.id} value={asset.id}>{asset.identifier}</option>
                  ))}
                </select>
                <input name="at" type="date" className={input} aria-label="Swapped on" />
                <input name="tons" inputMode="decimal" placeholder="Net tons"
                       aria-label="Net tons on the full can" className={`${input} w-24`} />
                <input name="ticketNumber" placeholder="Ticket"
                       aria-label="Ticket for the swap" className={`${input} w-24`} />
              </ActionForm>
            )}
            {!hire.open && (
              <a href={`/fleet/containers?overage=${hire.id}`}
                 className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100">
                What it is owed
              </a>
            )}
            {/*
              Raised once per hire, from the collected period, both meters and
              every charge on the haul, as a draft for the office to check.
              Once it is on an invoice the row says so rather than offering a
              second one.
            */}
            {!hire.open && invoices && !hire.invoiceId && (
              <SaidForm action={invoiceHireAction} submit="Raise invoice" tone="quiet" className="flex flex-wrap items-center gap-2"
                        hidden={{ id: hire.id }} />
            )}
            {hire.invoiceId ? <span className="self-center text-sm text-ink-500">Invoiced</span> : null}
            {hire.open && hire.collectionVisitId ? <span className="self-center text-sm text-ink-500">Collection booked</span> : null}
          </div>
        )}
      />
      {open.length > 0 && (
        <p className="mt-2 text-sm text-ink-500">
          {open.length} {open.length === 1 ? "container is" : "containers are"} out. Days so far on an
          open hire is counted to today and moves at midnight, which is why it is not a figure to
          bill from until the can is collected.
        </p>
      )}

      {schedules && (
        <section className="mt-6" aria-labelledby="collections">
          <h2 id="collections" className="text-base font-semibold">Collections</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            Every hire due back by the day you choose goes on the board as a collection on the day it is due, or today
            when it is already late, marked as the pickup so the driver arrives empty. A hire that already has one is
            left alone, so pressing this twice books nothing twice.
          </p>
          <SaidForm action={scheduleCollectionsAction} submit="Put collections on the board" className="mt-2 flex flex-wrap items-end gap-3">
            <TextField label="Due back by" name="through" type="date" className="w-44" />
          </SaidForm>
        </section>
      )}

      <section className="mt-8" aria-labelledby="charges">
        <h2 id="charges" className="text-base font-semibold">Charges found on hauls</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-500">
          A mattress, a tire, a load the facility had to sort. Recorded against the haul when it is found, and invoiced
          with the hire.
        </p>
        {charges.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm">
            {charges.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span>{hireLabel.get(c.rentalId) ?? "A hire"}:</span>
                <span className="font-medium">{c.description}</span>
                <span className="text-ink-700">{c.quantity} at <Money value={c.unitPrice} /></span>
                {c.invoiceId ? <span className="text-ink-500">invoiced</span> : writes ? (
                  <SaidForm action={removeChargeAction} submit="Remove" tone="quiet" className="inline-flex" hidden={{ id: c.id }} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {writes && hires.data.some((h) => !h.invoiceId) ? (
          <SaidForm action={recordChargeAction} submit="Record charge" className="mt-3 grid gap-3 sm:grid-cols-3">
            <Select label="Hire" name="rentalId" options={hires.data.filter((h) => !h.invoiceId)
              .map((h) => ({ value: h.id, label: `${hireLabel.get(h.id)}${h.open ? "" : ", collected"}` }))} />
            <Select label="What" name="kind" options={CHARGE_KINDS} />
            <Select label="Priced from" name="priceBookItemId" options={[
              { value: "", label: "A price I give" },
              ...fees.map((f) => ({ value: f.id, label: `${f.name} (${Number(f.price).toFixed(2)})` })),
            ]} />
            <TextField label="Description" name="description" placeholder="Left empty, the fee's name" />
            <TextField label="How many" name="quantity" inputMode="decimal" placeholder="1" />
            <TextField label="Price each" name="unitPrice" inputMode="decimal" placeholder="Left empty, the fee's price" />
            <TextField label="Where and what was seen" name="note" className="sm:col-span-3" />
          </SaidForm>
        ) : null}
      </section>

      <h2 className="mt-10 text-base font-semibold">The register</h2>
      <Register
        containers={fleet.data}
        controls={writes ? (container) => (
          <div className="flex flex-wrap gap-2">
            {container.status === "available" && addresses.length > 0 && (
              <ActionForm op="deliver" label="Deliver" quiet hidden={{ id: container.id }}>
                <select name="propertyId" className={input} aria-label="Site">
                  {addresses.map((property) => (
                    <option key={property.id} value={property.id}>
                      {[property.address.line1, property.address.city].filter((p) => p).join(", ")}
                    </option>
                  ))}
                </select>
                <input name="deliveredAt" type="date" className={input} aria-label="Delivered on" />
                <input name="includedDays" inputMode="numeric" placeholder="Days incl." className={`${input} w-24`} />
                <input name="dailyRate" inputMode="decimal" placeholder="Day rate" className={`${input} w-24`} />
                <input name="overageRate" inputMode="decimal" placeholder="Over/day" className={`${input} w-24`} />
                <input name="includedTons" inputMode="decimal" placeholder="Tons incl." className={`${input} w-24`} />
                <input name="perTonRate" inputMode="decimal" placeholder="Per ton" className={`${input} w-24`} />
              </ActionForm>
            )}
            {container.status === "out_of_service"
              ? <ActionForm op="in" label="Back in service" quiet hidden={{ id: container.id }} />
              : (
                <ActionForm op="out" label="Tag out" quiet hidden={{ id: container.id }}>
                  <input name="reason" required placeholder="Why" className={`${input} w-40`} />
                </ActionForm>
              )}
            {container.status !== "on_site" && (
              <ActionForm op="retire" label="Retire" quiet hidden={{ id: container.id }} />
            )}
          </div>
        ) : undefined}
      />

      {writes && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Add a container</h2>
          <ActionForm op="add" label="Add" className="mt-2 flex flex-wrap items-end gap-2">
            <select name="assetType" className={input} aria-label="Kind">
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            {/*
              The number painted on the side, required. It is what the driver
              reads off the unit and the only thing tying a scale ticket to a can,
              which is why the service refuses a container without one rather than
              generating a label.
            */}
            <input name="identifier" required placeholder="4012" className={input} />
            <input name="size" placeholder="20 yard" className={input} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
