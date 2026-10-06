import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customFields, equipment, inTenant, properties as propertyService, stockUnits, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { ActionForm, TextField, Select } from "@/components/ActionForm";
import { Empty, Table, Th, Td } from "@/components/Table";
import { formatDay, formatIn } from "@/lib/dates";
import { JOB_STATUS, JOB_TONE, label, tone, enumText } from "@/lib/labels";
import { followUp } from "../../customers/warranties/actions";
import { editUnit, moveUnit } from "./actions";
import { CustomFieldsPanel } from "@/components/CustomFieldsPanel";
import { RecordsPanel } from "@/components/RecordsPanel";

export const dynamic = "force-dynamic";

const reading = (r: { valueNumeric: string | null; valueText: string | null; valueBoolean: boolean | null; unit: string | null }) => {
  if (r.valueNumeric !== null) return `${Number(r.valueNumeric)}${r.unit ? ` ${r.unit}` : ""}`;
  if (r.valueBoolean !== null) return r.valueBoolean ? "Yes" : "No";
  return r.valueText ?? "";
};

/**
 * ONE UNIT, WITH EVERYTHING KNOWN ABOUT IT
 *
 * The four questions every call about a furnace starts with: what is it, how
 * old is it, is it covered, and what did we do to it last time. Each was on a
 * different screen or on none, and a unit's links used to open the address
 * it was at and leave somebody scrolling a register for it.
 *
 * Its service history is the jobs that named it and the visits that worked
 * it; its readings are the ones service reports took on it, newest first, so a
 * number drifting is visible; its inspections are the ones whose checkpoints
 * named it; its photographs are the ones taken of it rather than of the
 * visit. Warranty is worked out from the dates today, parts and labour apart.
 */
export default async function EquipmentPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ to?: string }>;
}) {
  const user = await requireSetupUser();
  const { id } = await params;
  const { to: findAddress } = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };
  const tz = user.organizationTimezone;

  if (!can(user.actor, "equipment:read")) notFound();
  const unit = await equipment.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const history = await equipment.history(ctx, { id });
  /**
   * Where it came from, when it came off our shelf: the serial issued to a
   * job as this unit, with the order and vendor it arrived on and every move
   * before the job. Only for whoever may read inventory.
   */
  const fromStock = can(user.actor, "inventory:read") ? await stockUnits.traceForEquipment(ctx, { equipmentId: id }) : [];

  /** A follow up already in the queue, so a second press is not offered. */
  const followed = can(user.actor, "task:read")
    ? (await inTenant(ctx, (tx) => tx.select({ id: schema.task.id }).from(schema.task).where(and(
        eq(schema.task.entityType, "equipment"),
        eq(schema.task.entityId, id),
        sql`${schema.task.status} in ('open', 'in_progress')`,
      )).limit(1))).length > 0
    : false;

  /**
   * WHERE IT COULD GO. The customer's other addresses first, because a landlord
   * moving a water heater between two rentals is the usual move, and then
   * whatever the typed search finds in the whole book. Only for somebody who may
   * read addresses; the move itself is checked by the service whatever this
   * shows.
   */
  const canEdit = can(user.actor, "equipment:write") && !unit.retired;
  const addressOf = (p: { addressLine1: string; city: string; state: string; postalCode: string }) =>
    `${p.addressLine1}, ${p.city}, ${p.state} ${p.postalCode}`;
  const destinations = new Map<string, string>();
  if (canEdit && can(user.actor, "property:read")) {
    if (unit.customer) {
      for (const p of (await propertyService.list(ctx, { limit: 50, customerId: unit.customer.id.toString() })).data) {
        destinations.set(p.id, addressOf(p));
      }
    }
    if (findAddress?.trim()) {
      for (const p of (await propertyService.list(ctx, { limit: 20, q: findAddress.trim() })).data) {
        destinations.set(p.id, addressOf(p));
      }
    }
    destinations.delete(unit.propertyId);
  }

  const name = [unit.tag, unit.manufacturer, unit.model].filter(Boolean).join(" ") || unit.category;
  const days = unit.warranty.daysUntilSoonest;
  const attributes = Object.entries(unit.attributes ?? {}).filter(([, v]) => v !== null && v !== "");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={`/properties/${unit.propertyId}`}>{unit.address || "The address"}</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">{name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {unit.retired ? <Chip tone="neutral">Off the register</Chip> : null}
          {/*
            Two chips, never one: parts and labour expire on different days, and
            a single "under warranty" is how somebody quotes a free repair whose
            labour ran out four years ago.
          */}
          <Chip tone={unit.warranty.partsCovered ? "success" : "neutral"}>Parts {unit.warranty.partsCovered ? "covered" : "out"}</Chip>
          <Chip tone={unit.warranty.labourCovered ? "success" : "neutral"}>Labour {unit.warranty.labourCovered ? "covered" : "out"}</Chip>
        </div>
      </div>

      <Facts>
        <Fact label="What it is">{unit.category}</Fact>
        <Fact label="Serial">{unit.serialNumber ? <span className="font-mono">{unit.serialNumber}</span> : null}</Fact>
        <Fact label="Customer">
          {unit.customer ? <a href={`/customers/${unit.customer.id}`} className="hover:underline">{unit.customer.name}</a> : null}
        </Fact>
        <Fact label="Where">{[unit.address, unit.location].filter(Boolean).join(", ")}</Fact>
        <Fact label="Installed">
          {unit.installedOn
            ? `${formatDay(unit.installedOn, tz)}${unit.ageYears !== null ? `, ${unit.ageYears} years ago` : ""}${unit.installedByUs ? ", by us" : ""}`
            : null}
        </Fact>
        <Fact label="Part of">
          {unit.parent ? <a href={`/equipment/${unit.parent.id}`} className="hover:underline">{unit.parent.tag ?? unit.parent.category}</a> : null}
        </Fact>
        <Fact label="Inside it">
          {unit.children.length > 0 ? unit.children.map((child, i) => (
            <span key={child.id}>
              {i > 0 ? ", " : ""}
              <a href={`/equipment/${child.id}`} className="hover:underline">{child.tag ?? child.category}</a>
            </span>
          )) : null}
        </Fact>
        {attributes.map(([key, value]) => (
          <Fact key={key} label={enumText(key)}>{String(value)}</Fact>
        ))}
      </Facts>


      {canEdit ? (
        <section aria-label="Change this unit" className="mt-8 space-y-3">
          <details className="rounded-md border border-steel-200 bg-canvas p-4">
            <summary className="cursor-pointer text-sm font-medium">Correct its details</summary>
            <ActionForm action={editUnit} submit="Save details" tone="quiet" hidden={{ id: unit.id }}
                        className="mt-3 grid gap-3 sm:grid-cols-2">
              <TextField label="What it is" name="category" required maxLength={60} defaultValue={unit.category} />
              <TextField label="Tag" name="tag" maxLength={60} defaultValue={unit.tag ?? ""} />
              <TextField label="Make" name="manufacturer" maxLength={120} defaultValue={unit.manufacturer ?? ""} />
              <TextField label="Model" name="model" maxLength={120} defaultValue={unit.model ?? ""} />
              <TextField label="Serial number" name="serialNumber" maxLength={120} defaultValue={unit.serialNumber ?? ""} />
              <TextField label="Where in the building" name="location" maxLength={200} defaultValue={unit.location ?? ""} />
              <TextField label="Installed on" name="installedOn" type="date" defaultValue={unit.installedOn ?? ""} />
              <TextField label="Parts cover ends" name="warrantyPartsExpiresOn" type="date"
                         defaultValue={unit.warranty.partsExpiresOn ?? ""} />
              <TextField label="Labour cover ends" name="warrantyLaborExpiresOn" type="date"
                         defaultValue={unit.warranty.labourExpiresOn ?? ""} />
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name="installedByUs" defaultChecked={unit.installedByUs} />
                We installed it
              </label>
              <p className="text-xs text-ink-500 sm:col-span-2">
                A box left empty takes that detail off. To put it at another address, use &ldquo;Move it
                to another address&rdquo; below, so the old work still says where it happened.
              </p>
            </ActionForm>
          </details>

          <details className="rounded-md border border-steel-200 bg-canvas p-4" open={Boolean(findAddress)}>
            <summary className="cursor-pointer text-sm font-medium">Move it to another address</summary>
            <p className="mt-2 max-w-prose text-sm text-ink-700">
              The unit keeps its history. Anything nested inside it goes with it, and the move is
              written down under &ldquo;Where it has been&rdquo;.
            </p>
            <form method="get" className="mt-3 flex flex-wrap items-end gap-2" aria-label="Find an address">
              <TextField label="Find an address" name="to" defaultValue={findAddress ?? ""}
                         placeholder="Street, city or postal code" className="block min-w-64" />
              <button type="submit"
                      className="inline-flex h-10 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
                Search
              </button>
            </form>
            {destinations.size === 0 ? (
              <p className="mt-3 text-sm text-ink-500">
                {findAddress
                  ? "No other address matches that."
                  : unit.customer
                    ? "This customer has no other address. Search for one above."
                    : "Search for the address it is going to."}
              </p>
            ) : (
              <ActionForm action={moveUnit} submit="Move it" tone="quiet" hidden={{ id: unit.id }}
                          className="mt-3 space-y-3">
                <fieldset>
                  <legend className="text-sm font-medium text-ink-700">Where it is going</legend>
                  <div className="mt-1 space-y-1">
                    {[...destinations].map(([propertyId, label]) => (
                      <label key={propertyId} className="flex items-center gap-2 text-sm">
                        <input type="radio" name="toPropertyId" value={propertyId} required />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Select label="Why" name="reason" options={[
                    { value: "relocated", label: "Moved to another address" },
                    { value: "swapped_under_warranty", label: "Swapped under warranty" },
                    { value: "returned", label: "Returned" },
                  ]} />
                  <TextField label="Moved on" name="movedOn" type="date" />
                </div>
                <TextField label="Note, if any" name="notes" maxLength={2000} />
              </ActionForm>
            )}
          </details>
        </section>
      ) : null}

      <section aria-label="Warranty" className="mt-8">
        <h2 className="text-base font-semibold">Warranty</h2>
        <p className="mt-2 text-sm text-ink-700">
          Parts {unit.warranty.partsExpiresOn ? `${unit.warranty.partsCovered ? "covered until" : "ended"} ${formatDay(unit.warranty.partsExpiresOn, tz)}` : "not recorded"}.
          {" "}Labour {unit.warranty.labourExpiresOn ? `${unit.warranty.labourCovered ? "covered until" : "ended"} ${formatDay(unit.warranty.labourExpiresOn, tz)}` : "not recorded"}.
          {days !== null && days >= 0 && days <= 90 ? ` The next cover ends in ${days} ${days === 1 ? "day" : "days"}.` : ""}
        </p>
        {!unit.retired && unit.warranty.soonestExpiry && (
          followed ? (
            <p className="mt-2 text-sm text-ink-500">A follow up is already in the task queue.</p>
          ) : can(user.actor, "task:write") ? (
            <ActionForm action={followUp} submit="Raise a follow up task" tone="quiet"
                        hidden={{
                          equipmentId: unit.id,
                          title: `Warranty: ${name}${unit.address ? ` at ${unit.address}` : ""}`.slice(0, 300),
                          body: `${(days ?? 0) < 0 ? "Cover ended" : "Cover ends"} ${formatDay(unit.warranty.soonestExpiry, tz)}. ${unit.customer ? `Ring ${unit.customer.name} about` : "Find out who to ring about"} a service plan or a replacement.`,
                        }}
                        className="mt-2 flex flex-wrap items-center gap-2" />
          ) : null
        )}
      </section>

      {fromStock.length > 0 ? (
        <section aria-label="From our stock" className="mt-8">
          <h2 className="text-base font-semibold">From our stock</h2>
          {fromStock.map((trace) => (
            <div key={trace.unit.id} className="mt-2">
              <p className="text-sm">
                Serial <a href={`/inventory/serials/${trace.unit.id}`} className="font-mono underline underline-offset-4">{trace.unit.number}</a>
                {" "}of {trace.unit.itemName}
              </p>
              <Table label={`Trace of ${trace.unit.number}`} head={<><Th>When</Th><Th>What</Th><Th>Where</Th><Th>For</Th></>}>
                {trace.steps.map((step, i) => (
                  <tr key={i}>
                    <Td className="tabular-nums">{formatIn(step.at, tz)}</Td>
                    <Td>{step.label}</Td>
                    <Td className="text-ink-700">{step.locationName}</Td>
                    <Td>
                      {step.purchaseOrderId ? (
                        <a href={`/purchasing/${step.purchaseOrderId}`} className="hover:underline">
                          Order {step.purchaseOrderNumber}{step.vendorName ? ` from ${step.vendorName}` : ""}
                        </a>
                      ) : null}
                      {step.jobId ? <a href={`/jobs/${step.jobId}`} className="hover:underline">Job {step.jobNumber}</a> : null}
                    </Td>
                  </tr>
                ))}
              </Table>
            </div>
          ))}
        </section>
      ) : null}

      <section aria-label="Service history" className="mt-8">
        <h2 className="text-base font-semibold">Service history</h2>
        {history.jobs.length === 0 && history.inspected.length === 0 ? (
          <Empty title="No work recorded on it yet">
            Jobs booked about this unit, and visits that record an outcome against it, appear here.
          </Empty>
        ) : (
          <ul className="mt-2 divide-y divide-steel-200 rounded-md border border-steel-200 text-sm">
            {history.jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-baseline gap-2 bg-canvas px-4 py-2">
                <a href={`/jobs/${job.id}`} className="hover:underline">
                  <span className="font-mono tabular-nums text-ink-500">{job.number}</span> {job.summary}
                </a>
                <Chip tone={tone(JOB_TONE, job.status)}>{label(JOB_STATUS, job.status)}</Chip>
                <span className="ml-auto text-ink-500">{formatIn(job.completedAt ?? job.createdAt, tz, { month: "short", day: "numeric", year: "numeric" })}</span>
              </li>
            ))}
            {history.inspected.map((v) => (
              <li key={v.visitId} className="flex flex-wrap items-baseline gap-2 bg-canvas px-4 py-2">
                <a href={`/visits/${v.visitId}`} className="hover:underline">Checked on a visit</a>
                {v.outcome ? <Chip tone="neutral">{enumText(v.outcome)}</Chip> : null}
                {v.notes ? <span className="text-ink-700">{v.notes}</span> : null}
                {v.completedAt ? <span className="ml-auto text-ink-500">{formatIn(v.completedAt, tz, { month: "short", day: "numeric", year: "numeric" })}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {history.inspections.length > 0 && (
        <section aria-label="Inspections" className="mt-8">
          <h2 className="text-base font-semibold">Inspections</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {history.inspections.map((i) => (
              <li key={i.id}>
                <a href={`/inspections/${i.id}/report`} className="hover:underline">
                  {i.programme ?? "Inspection"}{i.performedOn ? `, ${formatDay(i.performedOn, tz)}` : ""}
                </a>
                {i.result ? <span className="ml-2 text-ink-700">{enumText(i.result)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.deficiencies.length > 0 && (
        <section aria-label="Faults found" className="mt-8">
          <h2 className="text-base font-semibold">Faults found</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {history.deficiencies.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline gap-2">
                <Chip tone={d.severity === "critical" ? "danger" : d.severity === "major" ? "warning" : "neutral"}>{enumText(d.severity)}</Chip>
                <span>{enumText(d.status)}</span>
                {d.code ? <span className="font-mono text-xs text-ink-500">{d.code}</span> : null}
                <span className="text-ink-500">{formatIn(d.createdAt, tz, { month: "short", day: "numeric", year: "numeric" })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.readings.length > 0 && (
        <section aria-label="Readings" className="mt-8">
          <h2 className="text-base font-semibold">Readings</h2>
          <Table head={<><Th>When</Th><Th>What</Th><Th className="text-right">Reading</Th></>}>
            {history.readings.map((r) => (
              <tr key={r.id}>
                <Td className="text-ink-700">
                  <a href={`/visits/${r.visitId}`} className="hover:underline">{formatIn(r.recordedAt, tz, { month: "short", day: "numeric", year: "numeric" })}</a>
                </Td>
                <Td>{r.label}</Td>
                <Td className={`text-right font-mono tabular-nums ${r.outOfRange ? "text-red-600" : ""}`}>
                  {reading(r)}{r.outOfRange ? " (out of range)" : ""}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {history.photos.length > 0 && (
        <section aria-label="Photos" className="mt-8">
          <h2 className="text-base font-semibold">Photos</h2>
          <ul className="mt-3 flex flex-wrap gap-3">
            {history.photos.map((photo) => (
              <li key={photo.storageKey}>
                <a href={`/files/${photo.storageKey}`} className="block">
                  {photo.contentType?.startsWith("image/") ? (
                    // A plain img: the optimiser would fetch without the session and get a 404.
                    <img src={`/files/${photo.storageKey}`} alt={`${name}, ${formatIn(photo.at, tz, { month: "short", day: "numeric" })}`}
                         className="h-32 w-32 rounded border border-steel-200 object-cover" />
                  ) : (
                    <span className="flex h-32 w-32 items-center justify-center rounded border border-steel-200 text-sm text-ink-700">File</span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unit.moves.length > 0 && (
        <section aria-label="Moves" className="mt-8">
          <h2 className="text-base font-semibold">Where it has been</h2>
          <ul className="mt-2 space-y-1 text-sm text-ink-700">
            {unit.moves.map((move) => (
              <li key={move.id}>
                {formatDay(move.movedOn, tz)}: {enumText(move.reason)}
                {move.toPropertyId ? <> to <a href={`/properties/${move.toPropertyId}`} className="hover:underline">another address</a></> : null}
                {move.notes ? <span className="block text-ink-500">{move.notes}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      <CustomFieldsPanel
        entityType="equipment" id={id}
        definitions={await customFields.formFields(ctx, "equipment")}
        values={await customFields.valuesFor(ctx, { entityType: "equipment", id })}
        canWrite={can(user.actor, "equipment:write")}
        back={`/equipment/${id}`}
      />
      <RecordsPanel ctx={ctx} link="equipment" id={id} back={`/equipment/${id}`} />
    </div>
  );
}
