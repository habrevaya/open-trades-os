import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { equipment, inTenant, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { ActionForm } from "@/components/ActionForm";
import { Empty, Table, Th, Td } from "@/components/Table";
import { formatDay, formatIn } from "@/lib/dates";
import { JOB_STATUS, JOB_TONE, label, tone, enumText } from "@/lib/labels";
import { followUp } from "../../customers/warranties/actions";

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
export default async function EquipmentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const tz = user.organizationTimezone;

  if (!can(user.actor, "equipment:read")) notFound();
  const unit = await equipment.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const history = await equipment.history(ctx, { id });

  /** A follow up already in the queue, so a second press is not offered. */
  const followed = can(user.actor, "task:read")
    ? (await inTenant(ctx, (tx) => tx.select({ id: schema.task.id }).from(schema.task).where(and(
        eq(schema.task.entityType, "equipment"),
        eq(schema.task.entityId, id),
        sql`${schema.task.status} in ('open', 'in_progress')`,
      )).limit(1))).length > 0
    : false;

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
    </div>
  );
}
