import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { equipment, inTenant } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { formatDay } from "@/lib/dates";
import { followUp } from "./actions";

export const dynamic = "force-dynamic";

/**
 * WARRANTIES RUNNING OUT, AND ONES THAT JUST HAVE
 *
 * `GET /v1/equipment-warranties` was the list worth a daily look and had no
 * screen, so it was read by nobody. This is it, by customer and address,
 * with the two follow ups the list exists for: a task to ring them, and an
 * estimate for the replacement.
 *
 * "Recently ended" is its own view rather than the bottom of the others,
 * because a warranty that lapsed last month is the call most worth making
 * and the one a forward looking list stops mentioning the day it lapses.
 */
const VIEWS = [
  { key: "30", label: "Ending in 30 days", days: 30, past: false },
  { key: "60", label: "60 days", days: 60, past: false },
  { key: "90", label: "90 days", days: 90, past: false },
  { key: "ended", label: "Ended in the last 90 days", days: 90, past: true },
] as const;

type Unit = Awaited<ReturnType<typeof equipment.warrantyWatch>>[number];

const unitName = (u: Unit) =>
  [u.tag, u.manufacturer, u.model].filter(Boolean).join(" ") || u.category;

export default async function WarrantiesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const user = await requireSetupUser();
  const { view: asked } = await searchParams;
  const view = VIEWS.find((v) => v.key === asked) ?? VIEWS[0];
  const tz = user.organizationTimezone;

  if (!can(user.actor, "equipment:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <Crumb href="/customers">Customers</Crumb>
        <div className="mt-1"><PageHeader title="Warranties" /></div>
        <p className="mt-4 text-sm text-ink-700">
          Reading the equipment register needs <code>equipment:read</code>, which your role does not hold.
        </p>
      </div>
    );
  }

  const ctx = { actor: user.actor, db: getDb() };
  const units = (await equipment.warrantyWatch(ctx, { withinDays: view.days }))
    .filter((u) => u.warranty.daysUntilSoonest !== null
      && (view.past ? u.warranty.daysUntilSoonest < 0 : u.warranty.daysUntilSoonest >= 0));

  /** Units somebody has already raised an open follow up about, so a second press is not offered. */
  const followed = new Set(
    units.length === 0 || !can(user.actor, "task:read") ? [] : (await inTenant(ctx, (tx) =>
      tx.select({ id: schema.task.entityId }).from(schema.task).where(and(
        eq(schema.task.entityType, "equipment"),
        inArray(schema.task.entityId, units.map((u) => u.id)),
        sql`${schema.task.status} in ('open', 'in_progress')`,
      )))).map((row) => row.id),
  );

  /** By customer, then by address, in the order the soonest unit in each comes. */
  const groups = new Map<string, { customer: Unit["customer"]; addresses: Map<string, { address: string; units: Unit[] }> }>();
  for (const unit of units) {
    const key = unit.customer?.id ?? `none:${unit.propertyId}`;
    const group = groups.get(key) ?? { customer: unit.customer, addresses: new Map() };
    const at = group.addresses.get(unit.propertyId) ?? { address: unit.address, units: [] };
    at.units.push(unit);
    group.addresses.set(unit.propertyId, at);
    groups.set(key, group);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/customers">Customers</Crumb>
      <div className="mt-1"><PageHeader title="Warranties" count={units.length} /></div>

      <nav aria-label="Window" className="mt-4 flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <a key={v.key} href={`/customers/warranties?view=${v.key}`} aria-current={v.key === view.key ? "page" : undefined}
             className={`inline-flex h-8 items-center rounded px-3 text-sm ${v.key === view.key
               ? "bg-ink-900 font-medium text-white"
               : "border border-steel-300 text-ink-700 hover:bg-steel-100"}`}>
            {v.label}
          </a>
        ))}
      </nav>

      {units.length === 0 ? (
        <Empty title={view.past ? "No warranty ended in the last 90 days" : `No warranty ends in the next ${view.days} days`}>
          Units appear here when their parts or labour cover is recorded on the address&rsquo;s register.
        </Empty>
      ) : (
        <div className="mt-6 space-y-6">
          {[...groups.entries()].map(([key, group]) => (
            <section key={key} aria-label={group.customer?.name ?? "No customer linked"}
                     className="rounded-md border border-steel-200 bg-canvas p-4">
              <h2 className="text-base font-semibold">
                {group.customer
                  ? <a href={`/customers/${group.customer.id}`} className="hover:underline">{group.customer.name}</a>
                  : "No customer linked to this address"}
              </h2>
              {[...group.addresses.entries()].map(([propertyId, at]) => (
                <div key={propertyId} className="mt-3">
                  <a href={`/properties/${propertyId}`} className="text-sm text-ink-700 hover:underline">{at.address}</a>
                  <ul className="mt-2 divide-y divide-steel-200">
                    {at.units.map((u) => {
                      const days = u.warranty.daysUntilSoonest ?? 0;
                      return (
                        <li key={u.id} className="py-3">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <a href={`/properties/${propertyId}`} className="font-medium hover:underline">{unitName(u)}</a>
                            {u.serialNumber ? <span className="font-mono text-xs text-ink-500">{u.serialNumber}</span> : null}
                            <Chip tone={days < 0 ? "danger" : days <= 30 ? "warning" : "neutral"}>
                              {days < 0 ? `Ended ${-days} days ago` : days === 0 ? "Ends today" : `Ends in ${days} days`}
                            </Chip>
                          </div>
                          <p className="mt-1 text-sm text-ink-700">
                            Parts {u.warranty.partsExpiresOn ? `${u.warranty.partsCovered ? "until" : "ended"} ${formatDay(u.warranty.partsExpiresOn, tz)}` : "not recorded"}.
                            {" "}Labour {u.warranty.labourExpiresOn ? `${u.warranty.labourCovered ? "until" : "ended"} ${formatDay(u.warranty.labourExpiresOn, tz)}` : "not recorded"}.
                            {u.ageYears !== null ? ` ${u.ageYears} years old.` : ""}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            {followed.has(u.id) ? (
                              <span className="text-sm text-ink-500">A follow up is already in the task queue.</span>
                            ) : can(user.actor, "task:write") ? (
                              <ActionForm action={followUp} submit="Raise a follow up task" tone="quiet"
                                          hidden={{
                                            equipmentId: u.id,
                                            title: `Warranty: ${unitName(u)} at ${at.address}`.slice(0, 300),
                                            body: `${days < 0 ? "Cover ended" : "Cover ends"} ${formatDay(u.warranty.soonestExpiry ?? "", tz)}. ${group.customer ? `Ring ${group.customer.name} about` : "Find out who to ring about"} a service plan or a replacement.`,
                                          }}
                                          className="flex flex-wrap items-center gap-2" />
                            ) : null}
                            {group.customer && can(user.actor, "estimate:write") ? (
                              <a href={`/estimates/new?customer=${group.customer.id}&property=${propertyId}`}
                                 className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
                                Estimate a replacement
                              </a>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
