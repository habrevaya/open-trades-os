import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inTenant } from "@opentradesos/api/services";
import { schema } from "@opentradesos/db";
import { can } from "@opentradesos/core";
import { asc, eq, isNull } from "drizzle-orm";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { OfferService, Windows, Hours } from "./Forms";

export const dynamic = "force-dynamic";

/**
 * TURNING THE BOOKING PAGE ON
 *
 * The public booking page reads three tables, and until now nothing in this
 * product could write any of them. `bookable_service` had an endpoint that
 * UPDATED a row and no path that created one; `arrival_window` and
 * `business_hours` had neither. So /book/[slug] listed nothing for every
 * company that has ever existed, and the only symptom was an empty page that
 * reads as "this company offers nothing online" rather than as a feature
 * nobody could reach.
 *
 * Three things in the order a person sets them up: what may be booked, when
 * somebody can arrive, and which days you are open. All three have to be
 * answered before a single slot appears, which is why they are on one screen
 * rather than three.
 */
export default async function BookingPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "booking:configure")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Online booking" />
        <Empty title="Booking setup is not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const data = await inTenant(ctx, async (tx) => ({
    services: await tx.select({
      id: schema.bookableService.id,
      publicName: schema.bookableService.publicName,
      displayPrice: schema.bookableService.displayPrice,
      isActive: schema.bookableService.isActive,
      jobTypeId: schema.bookableService.jobTypeId,
      jobTypeName: schema.jobType.name,
    }).from(schema.bookableService)
      .innerJoin(schema.jobType, eq(schema.jobType.id, schema.bookableService.jobTypeId))
      .where(isNull(schema.bookableService.deletedAt)),
    jobTypes: await tx.select({ id: schema.jobType.id, name: schema.jobType.name })
      .from(schema.jobType)
      .where(isNull(schema.jobType.deletedAt)),
    windows: await tx.select().from(schema.arrivalWindow)
      .orderBy(asc(schema.arrivalWindow.sortOrder)),
    hours: await tx.select().from(schema.businessHours)
      .orderBy(asc(schema.businessHours.dayOfWeek)),
  }));

  const offered = new Set(data.services.map((s) => s.jobTypeId));
  const available = data.jobTypes.filter((t) => !offered.has(t.id));

  /**
   * Said plainly at the top, because the failure mode is a company that
   * configures one of the three and wonders why their page is still blank.
   */
  const missing = [
    data.services.length === 0 ? "a service" : null,
    data.windows.length === 0 ? "an arrival window" : null,
    data.hours.length === 0 ? "your opening hours" : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Online booking" />

      {missing.length > 0 ? (
        <p className="mt-2 max-w-prose rounded border border-amber-700/20 bg-amber-tint px-3 py-2 text-sm text-amber-700">
          Your booking page shows nothing yet. It needs {missing.join(", ")}.
          All three have to be set before a single slot appears.
        </p>
      ) : (
        <p className="mt-2 max-w-prose text-sm text-ink-500">
          Your booking page is live. Customers see the services below, in the
          windows you set, on the days you are open.
        </p>
      )}

      <h2 className="mt-8 font-medium text-ink-900">What the public may book</h2>
      {data.services.length > 0 && (
        <Table head={<><Th>Shown as</Th><Th>Job type</Th><Th className="text-right">Price</Th><Th>Live</Th></>}>
          {data.services.map((service) => (
            <tr key={service.id}>
              <Td>{service.publicName}</Td>
              <Td className="text-ink-500">{service.jobTypeName}</Td>
              <Td className="text-right tabular-nums">
                {service.displayPrice
                  ? `$${Number(service.displayPrice).toFixed(2)}`
                  : <span className="text-ink-500">Quoted on site</span>}
              </Td>
              <Td>{service.isActive ? "Yes" : "No"}</Td>
            </tr>
          ))}
        </Table>
      )}
      <OfferService jobTypes={available} />

      <h2 className="mt-10 font-medium text-ink-900">When somebody can arrive</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Wall clock times in your company&apos;s zone, which you set under
        Settings. These are what a customer picks between.
      </p>
      <Windows current={data.windows.map((w) => ({
        name: w.name, startsAt: w.startsAt, endsAt: w.endsAt,
      }))} />

      <h2 className="mt-10 font-medium text-ink-900">Which days you are open</h2>
      <Hours current={data.hours.map((h) => ({
        dayOfWeek: h.dayOfWeek, opensAt: h.opensAt, closesAt: h.closesAt, closed: h.closed,
      }))} />
    </div>
  );
}
