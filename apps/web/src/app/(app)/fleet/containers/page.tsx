import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rentals, rentalBilling, properties, inTenant, disposalFacilities, haulTimes } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { Empty, PageHeader } from "@/components/Table";
import { todayIn } from "@/lib/dates";
import { Numbers, Register, Hires, Overage, moment } from "./ContainerView";
import { ActionForm } from "./ActionForm";
import { ActionForm as SaidForm, Select, TextField } from "@/components/ActionForm";
import { Money } from "@opentradesos/ui";
import {
  billingTermsAction, collectionTimeAction, invoiceHireAction, recordChargeAction, removeChargeAction, rentalDispatchAction, scheduleCollectionsAction,
} from "./billing-actions";

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

  const [fleet, hires, holds] = await Promise.all([
    rentals.listAssets(ctx, { limit: 500 }),
    rentals.listRentals(ctx, { limit: 200 }),
    haulTimes.listHolds(ctx, { limit: 30 }),
  ]);
  /** The company's day an instant falls on, for a drop time set on the day the delivery was recorded. */
  const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: zone });

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
  const dispatching = await rentalBilling.rentalDispatch(ctx);
  const tipping = (await disposalFacilities.listFacilities(ctx)).facilities;
  /** Where the load went, offered when the company has recorded any facility. */
  const facilityPick = (label: string) => tipping.length > 0 ? (
    <select name="facilityId" className={input} aria-label={label} defaultValue={tipping.find((f) => f.isDefault)?.id ?? ""}>
      <option value="">Facility not recorded</option>
      {tipping.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  ) : null;
  /**
   * The materials the company's facilities list, offered as the words for what
   * is in a can: a facility is matched by the name, so the same name on both
   * sides is what sends a can where it is taken.
   */
  const materialNames = [...new Set(tipping.flatMap((f) => f.materials.map((entry) => entry.material)))].sort();
  const materialList = materialNames.length > 0 ? (
    <datalist id="materials">
      {materialNames.map((name) => <option key={name} value={name} />)}
    </datalist>
  ) : null;
  const settingsWrite = can(user.actor, "settings:write");
  const agreedText = (start: string | null, end: string | null) => {
    if (!start) return null;
    const day = new Date(start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone });
    const at = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
    return `${day}, ${at(start)}${end && end !== start ? ` to ${at(end)}` : ""}`;
  };
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
          <span className="flex flex-wrap gap-4">
            <a href="/fleet/containers/trucks" className="text-sm underline underline-offset-4">Trucks</a>
            <a href="/fleet/containers/facilities" className="text-sm underline underline-offset-4">Disposal facilities</a>
            <a href="/fleet/containers/tickets" className="text-sm underline underline-offset-4">Import a facility&apos;s scale tickets</a>
          </span>
        ) : null}
      </div>
      {materialList}
      <Hires
        hires={hires.data}
        zone={zone}
        controls={(hire) => (
          <div className="flex flex-wrap gap-2">
            {/*
              A delivery recorded as a day has no hour, and the turnaround
              counts it beside its figure until somebody says when the can was
              put down. Only the time is asked: the day is what the hire bills.
            */}
            {writes && hire.deliveredAt && !hire.deliveredTimeKnown && (
              <ActionForm op="drop-time" label="Save drop time" quiet hidden={{ id: hire.id, day: localDay(hire.deliveredAt) }}>
                <input name="time" type="time" required className={input} aria-label={`Time dropped on ${localDay(hire.deliveredAt)}`} />
              </ActionForm>
            )}
            {/*
              When the load was emptied at the facility: the driver taps it on
              the phone, or the office types it when the ticket arrives. Not the
              collection, which includes the drive and the queue at the gate.
            */}
            {writes && !hire.open && !hire.tippedAt && !hire.cameBackEmptyAt && (
              <ActionForm op="tip" label="Save time emptied" quiet hidden={{ id: hire.id }}>
                <input name="tippedAt" type="datetime-local" required className={input} aria-label="Emptied at the facility" />
              </ActionForm>
            )}
            {/*
              A can the customer never filled has nothing to tip, and no tip
              time will ever come. Saying so, with the time it was collected,
              lets the turnaround measure its next placement from then. Only a
              time is asked: the day is the collection's.
            */}
            {writes && !hire.open && hire.pickedUpAt && !hire.tippedAt && !hire.cameBackEmptyAt && !hire.disposalTicketNumber && (
              <ActionForm op="empty" label="Came back empty" quiet hidden={{ id: hire.id, day: localDay(hire.pickedUpAt) }}>
                <input name="time" type="time" required className={input} aria-label={`Collected empty at, on ${localDay(hire.pickedUpAt)}`} />
              </ActionForm>
            )}
            {writes && hire.cameBackEmptyAt && (
              <ActionForm op="not-empty" label="It was not empty" quiet hidden={{ id: hire.id }} />
            )}
            {/*
              What the customer is putting in it, so Optimise route sends the
              full can only to a facility that takes it and prices the tip at
              that material's rate.
            */}
            {writes && hire.open && (
              <ActionForm op="material" label="Save what is in it" quiet hidden={{ id: hire.id }}>
                <input name="materialType" list="materials" defaultValue={hire.materialType ?? ""} placeholder="What is in it"
                       aria-label={`What is in ${hire.assetIdentifier ?? "the can"}`} className={`${input} w-36`} />
              </ActionForm>
            )}
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
                {facilityPick("Facility the load went to")}
                <input name="tippedAt" type="datetime-local" className={input} aria-label="Load emptied at" />
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
                <input name="atTime" type="time" className={input} aria-label="Time swapped" />
                <input name="tons" inputMode="decimal" placeholder="Net tons"
                       aria-label="Net tons on the full can" className={`${input} w-24`} />
                <input name="ticketNumber" placeholder="Ticket"
                       aria-label="Ticket for the swap" className={`${input} w-24`} />
                {facilityPick("Facility the full can went to")}
                <input name="tippedAt" type="datetime-local" className={input} aria-label="Full can emptied at" />
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
            {!hire.open && invoices && !hire.invoiceId && !hire.disposalFeeOffer && (
              <SaidForm action={invoiceHireAction} submit={hire.invoiceAs === "chain" ? "Raise invoice for the chain" : "Raise invoice"} tone="quiet"
                        className="flex flex-wrap items-center gap-2" hidden={{ id: hire.id }} />
            )}
            {/*
              The terms pass the facility's disposal fee on, so it is OFFERED here and
              added only by pressing the button that says so. Both ways are a button:
              neither is a default, and the hire records which was pressed.
            */}
            {!hire.open && invoices && !hire.invoiceId && hire.disposalFeeOffer ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-700">
                  {hire.disposalFeeOffer.amount
                    ? `Disposal fee to pass on: ${Number(hire.disposalFeeOffer.amount).toFixed(2)}${hire.disposalFeeOffer.facility ? ` at ${hire.disposalFeeOffer.facility}` : ""} (${hire.disposalFeeOffer.why}).`
                    : `Disposal fee cannot be worked out: ${hire.disposalFeeOffer.why}`}
                </span>
                {hire.disposalFeeOffer.amount ? (
                  <SaidForm action={invoiceHireAction} submit="Raise invoice with the disposal fee" tone="quiet" className="inline-flex"
                            hidden={{ id: hire.id, disposalFee: "pass_on" }} />
                ) : null}
                <SaidForm action={invoiceHireAction} submit="Raise invoice without the disposal fee" tone="quiet" className="inline-flex"
                          hidden={{ id: hire.id, disposalFee: "leave_off" }} />
              </div>
            ) : null}
            {hire.disposalFeePassedOn !== null && hire.disposalFeePassedOn !== undefined ? (
              <span className="self-center text-sm text-ink-500">
                Disposal fee {hire.disposalFeePassedOn ? "passed on" : "left off"}
                {hire.disposalFeeAmount ? `: ${Number(hire.disposalFeeAmount).toFixed(2)}` : ""}
              </span>
            ) : null}
            {/*
              How the hire is billed, for the whole swap chain: an invoice for each
              haul, or one for the chain. And whether the terms pass disposal on.
            */}
            {writes && !hire.invoiceId && hire.invoiceAs ? (
              <SaidForm action={billingTermsAction} submit="Save billing" tone="quiet" className="flex flex-wrap items-end gap-2" hidden={{ id: hire.id }}>
                <select name="invoiceAs" defaultValue={hire.invoiceAs} className={input} aria-label="How this hire is invoiced">
                  <option value="per_haul">One invoice for each haul</option>
                  <option value="chain">One invoice for the whole chain</option>
                </select>
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="disposalPassThrough" defaultChecked={hire.disposalPassThrough} /> Pass the disposal fee on
                </label>
              </SaidForm>
            ) : null}
            {hire.invoiceId ? <span className="self-center text-sm text-ink-500">Invoiced</span> : null}
            {hire.open && hire.collectionVisitId ? <span className="self-center text-sm text-ink-500">Collection booked</span> : null}
            {/*
              The time the customer agreed for the collection beats the end of
              the price, early or late. Shown when there is one, with a way to
              clear it; set with a day and a window in the company's clock.
            */}
            {hire.open && hire.collectionAgreedStart ? (
              <span className="self-center text-sm text-ink-700">
                Collection agreed: {agreedText(hire.collectionAgreedStart, hire.collectionAgreedEnd ?? null)}
              </span>
            ) : null}
            {hire.open && writes && (
              <SaidForm action={collectionTimeAction} submit={hire.collectionAgreedStart ? "Change agreed pickup time" : "Agree a pickup time"}
                        tone="quiet" className="flex flex-wrap items-end gap-2" hidden={{ id: hire.id }}>
                <input name="day" type="date" className={input} aria-label="Collection day agreed" />
                <input name="from" type="time" defaultValue="08:00" className={input} aria-label="Collection from" />
                <input name="to" type="time" defaultValue="12:00" className={input} aria-label="Collection to" />
              </SaidForm>
            )}
            {hire.open && writes && hire.collectionAgreedStart ? (
              <SaidForm action={collectionTimeAction} submit="Clear agreed time" tone="quiet" className="inline-flex"
                        hidden={{ id: hire.id, clear: "yes" }} />
            ) : null}
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
            {dispatching.automaticCollections
              ? `Collections are booked on their own, ${dispatching.collectionLeadDays === 0 ? "on the day each hire is due" : dispatching.collectionLeadDays === 1 ? "the day before each hire is due" : `${dispatching.collectionLeadDays} days before each hire is due`}: at the time agreed with the customer when there is one, otherwise in the working day the hire runs out, or today when that has passed. `
              : "Collections are not booked on their own: press the button below. "}
            Each is marked as the pickup so the driver arrives empty. A hire that already has one is left alone, so
            nothing is booked twice.
          </p>
          <SaidForm action={scheduleCollectionsAction} submit="Put collections on the board" className="mt-2 flex flex-wrap items-end gap-3">
            <TextField label="Due back by" name="through" type="date" className="w-44" />
          </SaidForm>
        </section>
      )}

      <section className="mt-6" aria-labelledby="truck">
        <h2 id="truck" className="text-base font-semibold">Collections and the truck</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-500">
          A driver&apos;s day is ordered by what is on the truck: a drop needs an empty on board, a collection needs room,
          and Optimise route on the board counts the runs to the yard between. The yard is where the driver&apos;s day starts.
          Now: {dispatching.containersPerTruck === 1 ? "one container" : `${dispatching.containersPerTruck} containers`} a truck,{" "}
          {dispatching.yardMinutes} minutes at the yard. These are the figures for a driver whose truck has no kind;
          a hook lift and a roll off truck can each have their own on{" "}
          <a href="/fleet/containers/trucks" className="underline underline-offset-4">Trucks</a>.
        </p>
        <p className="mt-1 max-w-prose text-sm text-ink-500">
          {dispatching.truckHourCost
            ? `An hour of a truck and driver costs ${Number(dispatching.truckHourCost).toFixed(2)}, so a facility that charges less can win over a nearer one when the saving is worth the drive.`
            : "Say what an hour of a truck and driver costs, and a facility that charges less can win over a nearer one when the saving is worth the drive. Until then the nearest open facility is used."}
        </p>
        {settingsWrite ? (
          <SaidForm action={rentalDispatchAction} submit="Save" className="mt-2 flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="automaticCollections" defaultChecked={dispatching.automaticCollections} />
              Book collections on their own
            </label>
            <TextField label="Days ahead" name="collectionLeadDays" type="number" min={0} max={7}
                       defaultValue={dispatching.collectionLeadDays} className="w-28" />
            <TextField label="Containers a truck carries" name="containersPerTruck" type="number" min={1} max={4}
                       defaultValue={dispatching.containersPerTruck} className="w-48" />
            <TextField label="Minutes at the yard" name="yardMinutes" type="number" min={0} max={120}
                       defaultValue={dispatching.yardMinutes} className="w-40" />
            <TextField label="An hour of a truck and driver costs" name="truckHourCost" inputMode="decimal" placeholder="Leave empty if not known"
                       defaultValue={dispatching.truckHourCost ? Number(dispatching.truckHourCost).toFixed(2) : ""} className="w-60" />
          </SaidForm>
        ) : null}
      </section>

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
        zone={zone}
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
                {/*
                  The time the can was put down. Left empty with a day, the hire
                  keeps the day only: it bills the same, and the turnaround
                  counts it beside the figure rather than guess an hour.
                */}
                <input name="deliveredTime" type="time" className={input} aria-label="Time dropped" />
                <input name="materialType" list="materials" placeholder="What goes in it" aria-label="What goes in it"
                       className={`${input} w-32`} />
                <input name="includedDays" inputMode="numeric" placeholder="Days incl." className={`${input} w-24`} />
                <input name="dailyRate" inputMode="decimal" placeholder="Day rate" className={`${input} w-24`} />
                <input name="overageRate" inputMode="decimal" placeholder="Over/day" className={`${input} w-24`} />
                <input name="includedTons" inputMode="decimal" placeholder="Tons incl." className={`${input} w-24`} />
                <input name="perTonRate" inputMode="decimal" placeholder="Per ton" className={`${input} w-24`} />
                <select name="invoiceAs" className={input} aria-label="Invoice this hire as">
                  <option value="per_haul">One invoice for each haul</option>
                  <option value="chain">One invoice for the whole chain</option>
                </select>
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="disposalPassThrough" /> Pass the disposal fee on
                </label>
              </ActionForm>
            )}
            {container.status === "out_of_service"
              ? (
                <ActionForm op="in" label="Back in service" quiet hidden={{ id: container.id }}>
                  <input name="back" type="datetime-local" className={input} aria-label={`Back in service at, ${container.identifier}`} />
                </ActionForm>
              )
              : (
                <ActionForm op="out" label="Tag out" quiet hidden={{ id: container.id }}>
                  <input name="reason" required placeholder="Why" className={`${input} w-40`} />
                  <input name="since" type="datetime-local" className={input} aria-label={`Out for repair since, ${container.identifier}`} />
                </ActionForm>
              )}
            {/*
              Held for a customer who asked for this can. The time it starts
              and ends is kept, because the turnaround leaves out a can held
              between its tip and its next drop, and a hold nobody ended would
              leave it out for ever.
            */}
            {container.status === "available" && !(container.holds ?? []).some((h) => h.kind === "customer") && (
              <ActionForm op="hold" label="Hold for a customer" quiet hidden={{ id: container.id }}>
                <input name="reason" required placeholder="Who asked, and why" className={`${input} w-48`}
                       aria-label={`Who asked for ${container.identifier} to be held`} />
                <input name="since" type="datetime-local" className={input} aria-label={`Held since, ${container.identifier}`} />
              </ActionForm>
            )}
            {(container.holds ?? []).filter((h) => h.kind === "customer").map((h) => (
              <ActionForm key={h.id} op="end-hold" label="End the hold" quiet hidden={{ id: h.id }} />
            ))}
            {container.status !== "on_site" && (
              <ActionForm op="retire" label="Retire" quiet hidden={{ id: container.id }} />
            )}
          </div>
        ) : undefined}
      />

      <section className="mt-8" aria-labelledby="holds">
        <h2 id="holds" className="text-base font-semibold">Repairs and holds</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-500">
          When each can was out for repair or held because a customer asked, from when to when. The turnaround between
          pickup and redelivery on the trade scorecard leaves out a can that spent any of its turnaround in one.
        </p>
        {holds.data.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None recorded yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {holds.data.map((h) => (
              <li key={h.id}>
                <span className="font-mono font-medium">{h.assetIdentifier}</span>
                <span className="ml-2">{h.kind === "repair" ? "Out for repair" : `Held for ${h.customerName ?? "a customer"}`}:</span>
                <span className="ml-1 text-ink-700">{h.reason}.</span>
                <span className="ml-1 text-ink-500">
                  {h.startsAt ? `From ${moment(h.startsAt, zone)}` : "From before repairs were recorded"}
                  {h.endsAt ? ` to ${moment(h.endsAt, zone)}` : ", still running"}.
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

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
