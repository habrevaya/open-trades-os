import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { time, SYSTEM_USER_ID } from "@opentradesos/core";
import { audit, ConflictError, NotFoundError, type RequestMeta } from "./context";
import { assertRoom, memberTest, openSlots, type OpenSlot } from "./booking";
import { emit } from "./events";
import { inGrant } from "./portal";
import { sessionFor } from "./portal-sign-in";

/**
 * A RETURNING CUSTOMER BOOKING FROM THEIR OWN ACCOUNT
 *
 * The public widget asks a stranger for their name, address and phone and
 * offers whatever windows somebody could cover. A customer signed in to
 * their own account needs none of the first and gets one more choice: the
 * technician who came last time, by name. The windows offered for a
 * technician are that person's own free time, from the same board facts the
 * public windows come from (`booking.capacityReader`), and the company's
 * per window limit is still the ceiling.
 *
 * Only the people who have already been to this customer are offered, by
 * first name: a list of every technician the company has would be a staff
 * directory handed to anybody with an account, and "the one who came in
 * March" is the choice a returning customer is actually making.
 *
 * What it writes is a booking request, like the widget's, already carrying
 * the customer and the property: the office still books it, and booking it
 * with its visit puts the named technician on it when they are still free
 * and qualified that day (`agentIntake.bookRequest`).
 *
 * From a sign in only. An account link can be forwarded, and the person it
 * was forwarded to should not be able to put work in the company's diary
 * at somebody else's house.
 */

export interface BookingOptions {
  services: { id: string; name: string; description: string | null; price: string | null; currency: string }[];
  properties: { id: string; label: string }[];
  technicians: { id: string; name: string }[];
}

/** First names, with an initial only where two would otherwise read the same. */
function namesFor(people: { id: string; displayName: string }[]): { id: string; name: string }[] {
  const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
  return people.map((p) => {
    const twin = people.some((o) => o.id !== p.id && first(o.displayName) === first(p.displayName));
    const parts = p.displayName.trim().split(/\s+/);
    return { id: p.id, name: twin && parts.length > 1 ? `${parts[0]} ${parts.at(-1)!.charAt(0)}.` : first(p.displayName) };
  });
}

/** The active technicians who have been on one of this customer's visits. */
async function theirTechnicians(tx: Database, customerId: string) {
  const rows = await tx.selectDistinct({ id: schema.technician.id, displayName: schema.technician.displayName })
    .from(schema.visitAssignment)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(and(eq(schema.job.customerId, customerId), eq(schema.technician.active, true)))
    .orderBy(asc(schema.technician.displayName));
  return rows;
}

export async function options(db: Database, input: { token: string }): Promise<BookingOptions> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx) => {
    const services = await tx.select().from(schema.bookableService)
      .where(eq(schema.bookableService.isActive, true))
      .orderBy(asc(schema.bookableService.publicName));
    const properties = await tx.select({
      id: schema.property.id, line1: schema.property.addressLine1, city: schema.property.city,
    })
      .from(schema.customerProperty)
      .innerJoin(schema.property, eq(schema.property.id, schema.customerProperty.propertyId))
      .where(and(eq(schema.customerProperty.customerId, session.customerId), isNull(schema.customerProperty.endedOn)))
      .orderBy(asc(schema.property.addressLine1));
    return {
      services: services.map((s) => ({
        id: s.id, name: s.publicName, description: s.publicDescription, price: s.displayPrice, currency: s.currency,
      })),
      properties: properties.map((p) => ({ id: p.id, label: [p.line1, p.city].filter(Boolean).join(", ") })),
      technicians: namesFor(await theirTechnicians(tx, session.customerId)),
    };
  });
}

async function serviceAndZone(tx: Database, organizationId: string, serviceId: string) {
  const [service] = await tx.select().from(schema.bookableService)
    .where(and(eq(schema.bookableService.id, serviceId), eq(schema.bookableService.isActive, true))).limit(1);
  if (!service) throw new NotFoundError("Service");
  const [org] = await tx.select({ timezone: schema.organization.timezone })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return { service, timezone: org?.timezone ?? "America/Chicago" };
}

async function assertTheirs(tx: Database, customerId: string, technicianId: string | undefined) {
  if (!technicianId) return;
  const theirs = await theirTechnicians(tx, customerId);
  if (!theirs.some((t) => t.id === technicianId)) throw new NotFoundError("Technician");
}

/**
 * The windows this service can be booked into, from anybody or from the one
 * technician asked for. A member whose plan promises priority is offered the
 * share of each window the company holds for members: at the address asked
 * about when there is one, at any of theirs when not yet.
 */
export async function availability(
  db: Database,
  input: {
    token: string; bookableServiceId: string; from?: string | undefined; days?: number | undefined;
    technicianId?: string | undefined; propertyId?: string | undefined;
  },
): Promise<{ slots: OpenSlot[] }> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx) => {
    await assertTheirs(tx, session.customerId, input.technicianId);
    const { service, timezone } = await serviceAndZone(tx, session.grant.organizationId, input.bookableServiceId);
    const slots = await openSlots(tx, {
      organizationId: session.grant.organizationId, timezone, service,
      from: input.from ?? time.dateIn(new Date(), timezone),
      days: Math.min(input.days ?? 14, 60),
      technicianId: input.technicianId,
      member: await memberTest(tx, session.grant.organizationId, session.customerId, input.propertyId ?? null),
    });
    return { slots };
  });
}

export interface AccountBookingInput {
  token: string;
  bookableServiceId: string;
  propertyId: string;
  requestedDate: string;
  arrivalWindowId: string;
  technicianId?: string | undefined;
  notes?: string | undefined;
}

/**
 * Ask for a visit, from the account.
 *
 * The slot is checked again here, inside the transaction that writes the
 * request, against the technician's day as it is now. A double tap is one
 * request: the same press arriving twice finds the one it already made.
 */
export async function request(
  db: Database, input: AccountBookingInput, meta?: RequestMeta,
): Promise<{ requestId: string; requestedDate: string; arrivalWindowId: string }> {
  const session = await sessionFor(db, input.token);
  return inGrant(db, session.grant, async (tx, ctx) => {
    const organizationId = session.grant.organizationId;
    const key = meta?.idempotencyKey ? `portal-booking:${session.customerId}:${meta.idempotencyKey.slice(0, 160)}` : null;
    if (key) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId }).from(schema.integrationEvent)
        .where(and(eq(schema.integrationEvent.idempotencyKey, key), eq(schema.integrationEvent.entityType, "booking_request")))
        .limit(1);
      if (seen?.entityId) {
        const [prior] = await tx.select().from(schema.bookingRequest).where(eq(schema.bookingRequest.id, seen.entityId)).limit(1);
        if (prior) return { requestId: prior.id, requestedDate: prior.requestedDate, arrivalWindowId: prior.arrivalWindowId ?? "" };
      }
    }

    await assertTheirs(tx, session.customerId, input.technicianId);
    const { service, timezone } = await serviceAndZone(tx, organizationId, input.bookableServiceId);
    const [property] = await tx.select().from(schema.property)
      .innerJoin(schema.customerProperty, eq(schema.customerProperty.propertyId, schema.property.id))
      .where(and(
        eq(schema.property.id, input.propertyId),
        eq(schema.customerProperty.customerId, session.customerId),
        isNull(schema.customerProperty.endedOn),
      )).limit(1);
    if (!property) throw new NotFoundError("Property");

    /**
     * Offered, by the same function that drew the page: notice, open days,
     * limit, somebody free, and the share held for members, which this
     * customer may book into only when their plan covers this address.
     */
    const member = await memberTest(tx, organizationId, session.customerId, property.property.id);
    const offered = (await openSlots(tx, {
      organizationId, timezone, service, from: input.requestedDate, days: 1, technicianId: input.technicianId, member,
    })).some((slot) => slot.date === input.requestedDate && slot.arrivalWindowId === input.arrivalWindowId);
    if (!offered) throw new ConflictError("That time is not open any more. Please choose another.");
    await assertRoom(tx, {
      organizationId, timezone, service, date: input.requestedDate, arrivalWindowId: input.arrivalWindowId,
      technicianId: input.technicianId, member,
    });

    const [customer] = await tx.select({ name: schema.customer.name, email: schema.customer.email, phone: schema.customer.phone })
      .from(schema.customer).where(eq(schema.customer.id, session.customerId)).limit(1);
    const [row] = await tx.insert(schema.bookingRequest).values({
      organizationId,
      bookableServiceId: service.id,
      customerId: session.customerId,
      propertyId: property.property.id,
      status: "pending",
      contactName: session.contact?.name ?? customer?.name ?? session.customerName,
      contactEmail: customer?.email ?? null,
      contactPhone: customer?.phone ?? null,
      addressLine1: property.property.addressLine1,
      addressLine2: property.property.addressLine2,
      city: property.property.city,
      state: property.property.state,
      postalCode: property.property.postalCode,
      requestedDate: input.requestedDate,
      arrivalWindowId: input.arrivalWindowId,
      preferredTechnicianId: input.technicianId ?? null,
      notes: input.notes?.trim() || null,
    }).returning();

    if (key) {
      await tx.insert(schema.integrationEvent).values({
        organizationId, direction: "inbound", provider: "portal", eventType: "booking.request",
        idempotencyKey: key, status: "succeeded", entityType: "booking_request", entityId: row!.id,
      });
    }
    await emit(tx, {
      actor: { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "booking" }, db: tx,
    }, {
      name: "booking.requested", entityType: "booking_request", entityId: row!.id,
      payload: {
        bookingRequestId: row!.id, contactName: row!.contactName, requestedDate: row!.requestedDate, serviceId: service.id,
      },
    });
    await audit(tx, ctx, "booking.requested_from_account", "booking_request", row!.id, null, {
      customerId: session.customerId, technicianId: input.technicianId ?? null,
    });
    return { requestId: row!.id, requestedDate: row!.requestedDate, arrivalWindowId: input.arrivalWindowId };
  });
}

/** The visits this customer has asked for and the office has not booked yet, for their account page. */
export async function pendingFor(tx: Database, customerId: string) {
  const rows = await tx.select({
    id: schema.bookingRequest.id,
    serviceName: schema.bookableService.publicName,
    requestedDate: schema.bookingRequest.requestedDate,
    windowName: schema.arrivalWindow.name,
    technicianName: schema.technician.displayName,
  })
    .from(schema.bookingRequest)
    .innerJoin(schema.bookableService, eq(schema.bookableService.id, schema.bookingRequest.bookableServiceId))
    .leftJoin(schema.arrivalWindow, eq(schema.arrivalWindow.id, schema.bookingRequest.arrivalWindowId))
    .leftJoin(schema.technician, eq(schema.technician.id, schema.bookingRequest.preferredTechnicianId))
    .where(and(
      eq(schema.bookingRequest.customerId, customerId),
      inArray(schema.bookingRequest.status, ["pending"]),
      gte(schema.bookingRequest.requestedDate, sql`current_date - 1`),
    ))
    .orderBy(asc(schema.bookingRequest.requestedDate))
    .limit(10);
  return rows.map((r) => ({
    id: r.id,
    serviceName: r.serviceName,
    requestedDate: r.requestedDate,
    windowName: r.windowName,
    technicianName: r.technicianName ? (r.technicianName.trim().split(/\s+/)[0] ?? null) : null,
  }));
}

export const handlers = {
  getPortalBookingOptions: (db: Database, input: { token: string }) => options(db, input),
  getPortalBookingAvailability: (
    db: Database,
    input: {
      token: string; bookableServiceId: string; from?: string | undefined; days?: number | undefined;
      technicianId?: string | undefined; propertyId?: string | undefined;
    },
  ) => availability(db, input),
  requestPortalBooking: (db: Database, input: AccountBookingInput, meta?: RequestMeta) => request(db, input, meta),
} as const;

