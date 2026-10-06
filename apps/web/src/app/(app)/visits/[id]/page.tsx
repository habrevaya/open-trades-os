import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customFields, visits, files, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { CustomFieldsPanel } from "@/components/CustomFieldsPanel";
import { Chip, Money } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";
import { formatIn, formatDay } from "@/lib/dates";
import { ActionForm, TextField } from "@/components/ActionForm";
import { movableAction } from "./actions";
import { VISIT_STATUS, VISIT_TONE, label, tone, enumText } from "@/lib/labels";

export const dynamic = "force-dynamic";

const minutes = (value: number | null) => {
  if (value === null) return "Still on the clock";
  const h = Math.floor(value / 60);
  const m = value % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
};

/**
 * ONE VISIT
 *
 * A trip to a property: when it was promised, when the van left and arrived,
 * who was on it, what they wrote, what they used, which units they worked and
 * what the customer asked to change. Every link that used to send somebody to
 * the job and leave them to work out which visit was meant comes here, and
 * the job is one click up.
 */
export default async function VisitPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const tz = user.organizationTimezone;

  const visit = await visits.get(ctx, { id }).catch((error: unknown) => {
    // Out of scope reads as missing, as the job page does.
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const photos = can(user.actor, "document:read")
    ? await files.attachmentsFor(ctx, { entityType: "visit", entityId: id })
    : [];

  const window = visit.windowStart
    ? `${formatIn(visit.windowStart, tz)}${visit.windowEnd ? ` to ${formatIn(visit.windowEnd, tz, { hour: "numeric", minute: "2-digit" })}` : ""}`
    : "Not scheduled";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={`/jobs/${visit.job.id}`}>Job {visit.job.number}</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          Visit {visit.sequence} of <span className="font-mono tabular-nums">{visit.job.number}</span>{" "}
          {visit.job.summary}
        </h1>
        <Chip tone={tone(VISIT_TONE, visit.status)}>{label(VISIT_STATUS, visit.status)}</Chip>
      </div>

      <Facts>
        <Fact label="Window">{window}</Fact>
        <Fact label="Customer">
          {visit.customer ? <a href={`/customers/${visit.customer.id}`} className="hover:underline">{visit.customer.name}</a> : null}
        </Fact>
        <Fact label="Address">
          {visit.property ? <a href={`/properties/${visit.property.id}`} className="hover:underline">{visit.property.address}</a> : null}
        </Fact>
        <Fact label="Getting in">{visit.property?.accessNotes}</Fact>
        <Fact label="Who">
          {visit.team.length > 0
            ? visit.team.map((t) => `${t.name}${t.isLead && visit.team.length > 1 ? " (lead)" : ""}`).join(", ")
            : visit.crew ?? "Nobody yet"}
        </Fact>
        <Fact label="Goes out from">{visit.shop}</Fact>
        <Fact label="Rental">{visit.rentalEvent ? enumText(visit.rentalEvent) : null}</Fact>
        <Fact label="May move">
          {visit.movableFrom || visit.movableUntil
            ? `Any day ${visit.movableFrom ? `from ${formatDay(visit.movableFrom, tz)}` : ""}${visit.movableFrom && visit.movableUntil ? " " : ""}${visit.movableUntil ? `to ${formatDay(visit.movableUntil, tz)}` : ""}, as the customer agreed`
            : null}
        </Fact>
      </Facts>

      {/*
        The days the customer agreed this visit may happen on: "any day the
        week of the fifth". Rebalancing several days reads it, and moves the
        visit inside it only when that helps, telling the customer.
      */}
      {can(user.actor, "visit:reschedule") && ["unassigned", "scheduled", "dispatched"].includes(visit.status) && (
        <section aria-label="Days it may move to" className="mt-6 rounded-md border border-steel-200 bg-canvas p-4">
          <h2 className="text-sm font-semibold">Days the customer agreed it may happen on</h2>
          <ActionForm action={movableAction} submit="Save" className="mt-2 flex flex-wrap items-end gap-3" hidden={{ id: visit.id }}>
            <TextField label="From" name="from" type="date" defaultValue={visit.movableFrom ?? ""} className="w-44" />
            <TextField label="To" name="until" type="date" defaultValue={visit.movableUntil ?? ""} className="w-44" />
          </ActionForm>
          {(visit.movableFrom || visit.movableUntil) && (
            <ActionForm action={movableAction} submit="Clear" tone="quiet" className="mt-2" hidden={{ id: visit.id, clear: "yes" }} />
          )}
        </section>
      )}

      {/*
        The times as they happened, in the company's zone. A gap between "on
        the way" and "arrived" is the drive; a visit marked done with no
        arrival was finished from the office.
      */}
      <section aria-label="What happened" className="mt-8">
        <h2 className="text-base font-semibold">What happened</h2>
        <ol className="mt-2 space-y-1 text-sm text-ink-700">
          <li>Sent: {visit.dispatchedAt ? formatIn(visit.dispatchedAt, tz) : "not yet"}</li>
          <li>On the way: {visit.enRouteAt ? formatIn(visit.enRouteAt, tz) : "not recorded"}</li>
          <li>Arrived: {visit.arrivedAt ? formatIn(visit.arrivedAt, tz) : "not recorded"}</li>
          <li>Finished: {visit.completedAt ? formatIn(visit.completedAt, tz) : "not yet"}</li>
          {visit.signed ? <li>The customer signed for the work.</li> : null}
        </ol>
        {visit.technicianNotes ? (
          <p className="mt-3 whitespace-pre-line rounded-md border border-steel-200 bg-canvas p-3 text-sm">{visit.technicianNotes}</p>
        ) : null}
      </section>

      {visit.checklist.length > 0 && (
        <section aria-label="Checklist" className="mt-8">
          <h2 className="text-base font-semibold">Checklist</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {visit.checklist.map((item) => (
              <li key={item.id} className={item.doneAt ? "text-ink-500 line-through" : "text-ink-900"}>
                {item.label}{item.required && !item.doneAt ? <span className="ml-2 text-xs text-red-600">required</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {visit.units.length > 0 && (
        <section aria-label="Units worked" className="mt-8">
          <h2 className="text-base font-semibold">Units worked</h2>
          <ul className="mt-2 divide-y divide-steel-200 rounded-md border border-steel-200 text-sm">
            {visit.units.map((u) => (
              <li key={u.equipmentId} className="flex flex-wrap items-baseline gap-2 bg-canvas px-4 py-2">
                <a href={`/equipment/${u.equipmentId}`} className="font-medium hover:underline">
                  {[u.tag, u.category].filter(Boolean).join(" ")}
                </a>
                {u.serialNumber ? <span className="font-mono text-xs text-ink-500">{u.serialNumber}</span> : null}
                {u.outcome ? <Chip tone="neutral">{enumText(u.outcome)}</Chip> : null}
                {u.notes ? <span className="text-ink-700">{u.notes}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {visit.used.length > 0 && (
        <section aria-label="Used on this visit" className="mt-8">
          <h2 className="text-base font-semibold">Used on this visit</h2>
          <Table head={<><Th>What</Th><Th className="text-right">Quantity</Th><Th className="text-right">Price</Th><Th>Billed</Th></>}>
            {visit.used.map((line) => (
              <tr key={line.id}>
                <Td>{line.name}<span className="ml-2 text-xs text-ink-500">{enumText(line.kind)}</span></Td>
                <Td className="text-right font-mono tabular-nums">{Number(line.quantity)}</Td>
                <Td className="text-right"><Money value={line.unitPrice} /></Td>
                <Td className="text-ink-700">{line.billed ? "Yes" : line.nonBillableReason ?? "Not yet"}</Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {visit.time !== null && visit.time.length > 0 && (
        <section aria-label="Time on the clock" className="mt-8">
          <h2 className="text-base font-semibold">Time on the clock</h2>
          <Table head={<><Th>Who</Th><Th>What</Th><Th>From</Th><Th className="text-right">How long</Th></>}>
            {visit.time.map((entry) => (
              <tr key={entry.id}>
                <Td>{entry.technician}</Td>
                <Td>{enumText(entry.kind)}</Td>
                <Td className="text-ink-700">{formatIn(entry.startedAt, tz)}</Td>
                <Td className="text-right">{minutes(entry.minutes)}</Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {(visit.reports.length > 0 || visit.inspections.length > 0) && (
        <section aria-label="Reports" className="mt-8">
          <h2 className="text-base font-semibold">Reports</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {visit.reports.map((r) => (
              <li key={r.id}>
                Service report: {r.skipped ? `skipped${r.skipReason ? `, ${r.skipReason}` : ""}` : r.publishedAt ? "shown to the customer" : r.submittedAt ? "submitted, not yet shown to the customer" : "started"}
                {r.summary ? <span className="block text-ink-700">{r.summary}</span> : null}
              </li>
            ))}
            {visit.inspections.map((i) => (
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

      {visit.changes.length > 0 && (
        <section aria-label="What the customer asked" className="mt-8">
          <h2 className="text-base font-semibold">What the customer asked</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {visit.changes.map((c) => (
              <li key={c.id}>
                {c.kind === "cancel" ? "To cancel" : "To move it"}{c.requestedStart ? ` to ${formatIn(c.requestedStart, tz)}` : ""},
                {" "}asked {formatIn(c.createdAt, tz)}: {enumText(c.status)}
                {c.reason ? <span className="block text-ink-700">&ldquo;{c.reason}&rdquo;</span> : null}
                {c.response ? <span className="block text-ink-500">We said: {c.response}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {photos.length > 0 && (
        <section aria-label="Photos" className="mt-8">
          <h2 className="text-base font-semibold">Photos</h2>
          <ul className="mt-3 flex flex-wrap gap-3">
            {photos.map((photo) => (
              <li key={photo.id}>
                <a href={`/files/${photo.storageKey}`} className="block">
                  {photo.contentType?.startsWith("image/") ? (
                    // A plain img: the optimiser would fetch without the session and get a 404.
                    <img src={`/files/${photo.storageKey}`} alt={photo.fileName ?? "Visit photo"}
                         className="h-32 w-32 rounded border border-steel-200 object-cover" />
                  ) : (
                    <span className="flex h-32 w-32 items-center justify-center rounded border border-steel-200 text-sm text-ink-700">
                      {photo.fileName ?? "File"}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {visit.siblings.length > 1 && (
        <nav aria-label="Other visits on this job" className="mt-8">
          <h2 className="text-base font-semibold">Other visits on this job</h2>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {visit.siblings.map((s) => (
              <li key={s.id}>
                {s.id === visit.id ? (
                  <span className="inline-flex h-8 items-center rounded bg-ink-900 px-3 font-medium text-white">Visit {s.sequence}</span>
                ) : (
                  <a href={`/visits/${s.id}`}
                     className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-ink-700 hover:bg-steel-100">
                    Visit {s.sequence}{s.windowStart ? `, ${formatIn(s.windowStart, tz, { month: "short", day: "numeric" })}` : ""}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>
      )}
      <CustomFieldsPanel
        entityType="visit" id={id}
        definitions={await customFields.formFields(ctx, "visit")}
        values={await customFields.valuesFor(ctx, { entityType: "visit", id })}
        canWrite={can(user.actor, "visit:write")}
        back={`/visits/${id}`}
      />
    </div>
  );
}
