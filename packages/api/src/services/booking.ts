import { and, eq, desc, lt, inArray, sql, gte, lte, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, time } from "@opentradesos/core";
import { randomBytes, createHash } from "node:crypto";
import type { z } from "zod";
import {
  type RequestMeta,
  type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError,
} from "./context";
import { audit } from "./customers";
import { nextNumber } from "./jobs";
import type {
  listBookableServices, getAvailability, createBookingRequest,
  listBookingRequests, confirmBookingRequest, declineBookingRequest,
  configureBookableService,
} from "../contracts/booking";

const PORTAL_BASE = process.env.PORTAL_BASE_URL ?? "https://portal.example.com";

/**
 * How long a resubmission counts as the same submission.
 *
 * Long enough to cover a phone that lost signal mid-request and a person who
 * gave up and refilled the form, short enough that the same household booking
 * the same service for the same window a season later is the second booking it
 * actually is. Swallowing that one would be worse than the duplicate: nobody
 * would ever find out the work had been requested.
 */
const REPLAY_WINDOW_MS = 30 * 60 * 1000;
const usd = (v: string) => m.money(v, "USD");

/**
 * PUBLIC READS
 *
 * The two endpoints below are reached by a stranger on a website, so they
 * resolve the organization from its slug rather than from any session, and
 * they return nothing about anyone. Neither is behind row level security,
 * because there is no tenant context to set: both scope explicitly by the
 * organization they resolved, and that is the only place in the codebase where
 * an explicit organization filter is the mechanism rather than a backstop.
 */

async function resolveOrg(db: Database, slug: string) {
  const [org] = await db.select({
    id: schema.organization.id,
    name: schema.organization.name,
    // Carried because every date on this screen is a calendar day, and a
    // calendar day is only a pair of instants once you know the zone.
    timezone: schema.organization.timezone,
  }).from(schema.organization).where(eq(schema.organization.slug, slug)).limit(1);
  if (!org) throw new NotFoundError("Company");
  return org;
}

export async function listServices(db: Database, input: z.infer<typeof listBookableServices.input>) {
  const org = await resolveOrg(db, input.organizationSlug);

  const rows = await db.select().from(schema.bookableService)
    .where(and(
      eq(schema.bookableService.organizationId, org.id),
      eq(schema.bookableService.isActive, true),
    ))
    .orderBy(schema.bookableService.publicName);

  return {
    organizationName: org.name,
    services: rows.map((r) => ({
      id: r.id,
      publicName: r.publicName,
      publicDescription: r.publicDescription,
      displayPrice: r.displayPrice,
      currency: r.currency,
      depositAmount: r.depositAmount,
      depositPercent: r.depositPercent,
      minNoticeHours: r.minNoticeHours,
      maxAdvanceDays: r.maxAdvanceDays,
      intakeFields: r.intakeFields,
    })),
  };
}

/**
 * Real openings.
 *
 * Derived from four things, every one of which can remove a slot and none of
 * which can add one: the arrival windows the company publishes, the days it is
 * open, time off already booked, and how many of that window are already sold.
 *
 * A widget that offers a time the company cannot serve costs a reschedule call
 * and the trust that came with it, so the bias here is always toward showing
 * less. When in doubt the slot is not offered.
 */
export async function availability(db: Database, input: z.infer<typeof getAvailability.input>) {
  const org = await resolveOrg(db, input.organizationSlug);

  const [service] = await db.select().from(schema.bookableService)
    .where(and(
      eq(schema.bookableService.id, input.bookableServiceId),
      eq(schema.bookableService.organizationId, org.id),
      eq(schema.bookableService.isActive, true),
    )).limit(1);
  if (!service) throw new NotFoundError("Service");

  const windows = await db.select().from(schema.arrivalWindow)
    .where(and(
      eq(schema.arrivalWindow.organizationId, org.id),
      eq(schema.arrivalWindow.isActive, true),
    ))
    .orderBy(schema.arrivalWindow.sortOrder);

  const hours = await db.select().from(schema.businessHours)
    .where(eq(schema.businessHours.organizationId, org.id));
  const openDays = new Set(
    hours.filter((h) => h.opensAt !== null && h.closesAt !== null).map((h) => h.dayOfWeek),
  );

  // The service's own ceiling wins over whatever the caller asked for, so a
  // client cannot widen the calendar past what the company opened.
  const days = Math.min(input.days, service.maxAdvanceDays);
  const earliest = new Date(Date.now() + service.minNoticeHours * 3600_000);

  const from = new Date(`${input.from}T00:00:00Z`);
  const until = new Date(from.getTime() + days * 864e5);

  const booked = await db.select({
    date: schema.bookingRequest.requestedDate,
    windowId: schema.bookingRequest.arrivalWindowId,
    n: sql<number>`count(*)::int`,
  }).from(schema.bookingRequest)
    .where(and(
      eq(schema.bookingRequest.organizationId, org.id),
      eq(schema.bookingRequest.bookableServiceId, service.id),
      inArray(schema.bookingRequest.status, ["pending", "confirmed"]),
      gte(schema.bookingRequest.requestedDate, input.from),
      lte(schema.bookingRequest.requestedDate, isoDate(until)),
    ))
    .groupBy(schema.bookingRequest.requestedDate, schema.bookingRequest.arrivalWindowId);

  const takenKey = (date: string, windowId: string) => `${date}|${windowId}`;
  const taken = new Map(booked.map((b) => [takenKey(b.date, b.windowId ?? ""), b.n]));

  /**
   * Time off is per technician, so one person being away is not a reason to
   * stop taking work. A day on which EVERY technician is off is, and that is
   * the case worth catching, because it is the company holiday.
   *
   * Per-technician availability, and therefore a real answer to "can anyone
   * qualified actually be there", arrives with the dispatch board in Phase 3.
   * Until then the per-window ceiling is the binding constraint.
   */
  const [{ headcount } = { headcount: 0 }] = await db
    .select({ headcount: sql<number>`count(*)::int` })
    .from(schema.technician)
    .where(and(
      eq(schema.technician.organizationId, org.id),
      eq(schema.technician.active, true),
    ));

  const off = await db.select({
    startsAt: schema.timeOff.startsAt,
    endsAt: schema.timeOff.endsAt,
    technicianId: schema.timeOff.technicianId,
  }).from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, org.id),
      eq(schema.timeOff.approved, true),
    ));

  const slots: Array<{
    date: string; arrivalWindowId: string; label: string;
    startsAt: string; endsAt: string; remaining: number;
  }> = [];

  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 864e5);
    const date = isoDate(day);
    const dow = day.getUTCDay();

    if (!openDays.has(dow)) continue;

    for (const w of windows) {
      if (!w.daysOfWeek.includes(dow)) continue;

      /**
       * A window that has already started today is not bookable today, and
       * neither is one inside the notice period the company set.
       *
       * `${date}T${w.startsAt}Z` read the company's eight in the morning as
       * eight UTC, which in Austin is three. The notice check was five hours
       * out all summer and six all winter, which is the difference between
       * offering a customer a slot the company can staff and one it cannot.
       */
      const opensAt = new Date(
        time.startOfDayIn(date, org.timezone).getTime() + minutesInto(w.startsAt) * 60_000,
      );
      if (opensAt < earliest) continue;

      const used = taken.get(takenKey(date, w.id)) ?? 0;
      const remaining = service.maxPerWindow - used;
      if (remaining <= 0) continue;

      if (headcount > 0 && awayCount(off, day, org.timezone) >= headcount) continue;

      slots.push({
        date,
        arrivalWindowId: w.id,
        label: `${weekday(dow)} ${w.name}`,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        remaining,
      });
    }
  }

  return { slots };
}

/**
 * Booking from the website.
 *
 * The slot is re-checked inside the same transaction that writes the request.
 * A slot free when the page rendered and taken by the time the form posts has
 * to fail here, as a message the requester can act on, rather than become an
 * overbooking somebody finds on the dispatch board on the morning.
 */
export async function createRequest(
  db: Database,
  input: z.infer<typeof createBookingRequest.input>,
  meta?: RequestMeta,
) {
  const org = await resolveOrg(db, input.organizationSlug);

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [service] = await tx.select().from(schema.bookableService)
      .where(and(
        eq(schema.bookableService.id, input.bookableServiceId),
        eq(schema.bookableService.organizationId, org.id),
        eq(schema.bookableService.isActive, true),
      )).limit(1);
    if (!service) throw new NotFoundError("Service");

    /**
     * A DOUBLE TAP IS ONE BOOKING.
     *
     * A homeowner on a phone with one bar taps Book, sees nothing happen, and
     * taps again. This inserted twice: two requests with the same name at the
     * same address for the same window, both counting against
     * `maxPerWindow`, so one person took the last two slots of a Tuesday
     * morning and the next real customer was told the time had gone.
     *
     * The route has declared `idempotent: true` all along. Nothing read it:
     * the dispatcher took the header inside the session branch only, and this
     * route has no session. That is fixed, and this is what uses it.
     *
     * DEDUPED ON A FINGERPRINT OF THE SUBMISSION, not on the key alone, and
     * that is a security decision rather than a convenience. A caller with no
     * account chooses their own key, so a lookup keyed on it would let
     * somebody who guessed a common value read back a stranger's booking,
     * which carries their name, address and phone number. A fingerprint can
     * only be reproduced by somebody who already has those details.
     *
     * A key, when one is sent, narrows the fingerprint further so a client
     * that deliberately means two identical bookings can say so.
     */
    const fingerprint = createHash("sha256").update(JSON.stringify([
      org.id, service.id, input.requestedDate, input.arrivalWindowId,
      input.contactName.trim().toLowerCase(),
      (input.contactEmail ?? input.contactPhone ?? "").trim().toLowerCase(),
      input.addressLine1.trim().toLowerCase(), input.postalCode.trim(),
      meta?.idempotencyKey ?? "",
    ])).digest("hex");

    const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
      .from(schema.integrationEvent)
      .where(and(
        /**
         * Scoped to the organization explicitly, and this filter CANNOT
         * currently be the one that holds. Said plainly rather than left as a
         * claim, because deleting it changes no test and somebody will
         * eventually notice that and wonder.
         *
         * Every other reader of this table runs inside `inTenant`, where row
         * level security scopes it. A public route has no session and so no
         * tenant context, which is why the filter is written out. It is
         * unreachable as a decision because `org.id` is already the first
         * element of the fingerprint, so two companies cannot collide in the
         * first place. It stays because a future fingerprint that dropped the
         * organization would otherwise return one company's booking, carrying
         * a customer's name and address, to another company's widget, and the
         * second lock costs nothing.
         */
        eq(schema.integrationEvent.organizationId, org.id),
        eq(schema.integrationEvent.entityType, "booking_request"),
        eq(schema.integrationEvent.idempotencyKey, fingerprint),
        /**
         * Recent only. The same household booking the same service for the
         * same window a season later is a real second booking, not a retry,
         * and treating it as one would silently swallow work.
         */
        gte(schema.integrationEvent.createdAt, new Date(Date.now() - REPLAY_WINDOW_MS)),
      )).limit(1);

    if (seen?.entityId) {
      const [prior] = await tx.select().from(schema.bookingRequest)
        .where(and(
          eq(schema.bookingRequest.id, seen.entityId),
          eq(schema.bookingRequest.organizationId, org.id),
        )).limit(1);
      if (prior) {
        const priorDeposit = depositDue(service, service.displayPrice);
        return {
          request: shapeRequest(prior),
          /**
           * The ORIGINAL tracking link, reissued rather than minted again.
           * A second grant would be a second live link to one booking, and
           * the first is the one already on the customer's screen.
           */
          trackingUrl: await issueTrackingUrl(tx, org.id, prior.id),
          depositDue: priorDeposit,
          paymentUrl: priorDeposit ? `${PORTAL_BASE}/pay/booking/${prior.id}` : null,
        };
      }
    }

    /**
     * CAPACITY IS CHECKED AFTER THE REPLAY, and the order is the fix.
     *
     * It was the other way round, so a retry was refused for capacity before
     * anybody asked whether it was a retry: the second tap counted the
     * booking the first tap had just made and was told the time had gone.
     * The slot a retry would take is the one it already holds.
     */
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` })
      .from(schema.bookingRequest)
      .where(and(
        eq(schema.bookingRequest.organizationId, org.id),
        eq(schema.bookingRequest.bookableServiceId, service.id),
        eq(schema.bookingRequest.requestedDate, input.requestedDate),
        eq(schema.bookingRequest.arrivalWindowId, input.arrivalWindowId),
        inArray(schema.bookingRequest.status, ["pending", "confirmed"]),
      ));

    if (n >= service.maxPerWindow) {
      throw new ConflictError(
        "That time has just been taken. Please choose another.",
      );
    }

    const [row] = await tx.insert(schema.bookingRequest).values({
      organizationId: org.id,
      bookableServiceId: service.id,
      status: "pending",
      contactName: input.contactName,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 ?? null,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      requestedDate: input.requestedDate,
      arrivalWindowId: input.arrivalWindowId,
      notes: input.notes ?? null,
      intakeAnswers: input.intakeAnswers,
      sourceUrl: input.sourceUrl ?? null,
      referrer: input.referrer ?? null,
      utm: input.utm,
      /**
       * Taken from the credential on the request, never from the body. A
       * source a caller can name is a source a caller can claim, and
       * attribution that anybody can write is attribution nobody can use.
       */
      connectedAppId: meta?.connectedAppId ?? null,
    }).returning();

    await tx.insert(schema.integrationEvent).values({
      organizationId: org.id,
      direction: "inbound", provider: "booking", eventType: "booking.request",
      idempotencyKey: fingerprint, status: "succeeded",
      entityType: "booking_request", entityId: row!.id,
    });

    const deposit = depositDue(service, service.displayPrice);

    return {
      request: shapeRequest(row!),
      // Tracking without an account. Issued now rather than on confirmation,
      // because the gap between booking and a human confirming it is exactly
      // when a customer most wants to see that something happened.
      trackingUrl: await issueTrackingUrl(tx, org.id, row!.id),
      depositDue: deposit,
      paymentUrl: deposit ? `${PORTAL_BASE}/pay/booking/${row!.id}` : null,
    };
  });
}

export async function listRequests(ctx: ServiceContext, input: z.infer<typeof listBookingRequests.input>) {
  return guardedRead(ctx, "booking:read", async (tx) => {
    const after = decodeCursor(input.cursor);
    const rows = await tx.select({
      request: schema.bookingRequest,
      serviceName: schema.bookableService.publicName,
    })
      .from(schema.bookingRequest)
      .innerJoin(
        schema.bookableService,
        eq(schema.bookableService.id, schema.bookingRequest.bookableServiceId),
      )
      .where(and(
        input.status ? inArray(schema.bookingRequest.status, input.status) : undefined,
        input.from ? gte(schema.bookingRequest.requestedDate, input.from) : undefined,
        input.to ? lte(schema.bookingRequest.requestedDate, input.to) : undefined,
        after ? lt(schema.bookingRequest.id, after) : undefined,
      ))
      .orderBy(desc(schema.bookingRequest.id))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.request.id);
    return {
      ...page,
      data: page.data.map((r) =>
        clean(ctx, "bookingRequest", { ...shapeRequest(r.request), serviceName: r.serviceName })),
    };
  });
}

/**
 * Confirming.
 *
 * Turns the request into a customer, a property and a job in one transaction.
 * An existing customer is matched on the address rather than on the name,
 * because the same house books under three different names over ten years and
 * every one of them is the same account.
 */
export async function confirm(ctx: ServiceContext, input: z.infer<typeof confirmBookingRequest.input>) {
  return guardedWrite(ctx, "booking:decide", async (tx) => {
    const [request] = await tx.select().from(schema.bookingRequest)
      .where(eq(schema.bookingRequest.id, input.id)).limit(1);
    if (!request) throw new NotFoundError("Booking request");

    // A retry is a no-op. Confirming twice must not create a second job.
    if (request.status === "confirmed" && request.jobId) {
      return {
        request: shapeRequest(request),
        customerId: request.customerId!,
        propertyId: request.propertyId!,
        jobId: request.jobId,
      };
    }

    if (request.status !== "pending") {
      throw new ConflictError(`This request is ${request.status} and cannot be confirmed.`);
    }

    const [service] = await tx.select().from(schema.bookableService)
      .where(eq(schema.bookableService.id, request.bookableServiceId)).limit(1);

    const { propertyId, customerId } = await matchOrCreateProperty(tx, ctx, request, input.customerId);

    const number = await nextNumber(tx, ctx.actor.organizationId, "job");
    const [job] = await tx.insert(schema.job).values({
      organizationId: ctx.actor.organizationId,
      number,
      customerId,
      propertyId,
      jobTypeId: input.jobTypeId ?? service?.jobTypeId ?? null,
      businessUnitId: service?.businessUnitId ?? null,
      territoryId: service?.territoryId ?? null,
      status: "scheduled",
      summary: service?.publicName ?? "Booked online",
      // The customer's own words, kept verbatim. Rewriting them into a job
      // summary loses the only unfiltered account of the problem anyone gets.
      customerComplaint: request.notes ?? null,
      leadSource: "online_booking",
    }).returning({ id: schema.job.id });

    await tx.update(schema.bookingRequest).set({
      status: "confirmed",
      customerId,
      propertyId,
      jobId: job!.id,
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.bookingRequest.id, input.id));

    // The tracking link the requester already has now points at a real job and
    // a real customer, so it keeps working rather than dead-ending the moment
    // somebody in the office confirms.
    await tx.update(schema.portalGrant).set({ customerId, scope: "job", subjectId: job!.id })
      .where(and(
        eq(schema.portalGrant.scope, "booking"),
        eq(schema.portalGrant.subjectId, input.id),
        isNull(schema.portalGrant.revokedAt),
      ));

    await tx.insert(schema.portalEvent).values({
      organizationId: ctx.actor.organizationId,
      customerId,
      jobId: job!.id,
      kind: "confirmed",
      headline: "Your appointment is confirmed",
      detail: `${request.requestedDate}`,
    });

    await audit(tx, ctx, "booking.confirmed", "booking_request", input.id,
      { status: "pending" }, { status: "confirmed", jobId: job!.id });

    const [updated] = await tx.select().from(schema.bookingRequest)
      .where(eq(schema.bookingRequest.id, input.id)).limit(1);

    return {
      request: shapeRequest(updated!),
      customerId,
      propertyId,
      jobId: job!.id,
    };
  });
}

/**
 * Declining.
 *
 * The reason is an enum rather than free text because the point of recording
 * it is to count it. "Outside service area" appearing forty times is a map
 * problem, "no capacity" appearing forty times is a hiring problem, and free
 * text turns both into something nobody reads.
 */
export async function decline(ctx: ServiceContext, input: z.infer<typeof declineBookingRequest.input>) {
  return guardedWrite(ctx, "booking:decide", async (tx) => {
    const [request] = await tx.select().from(schema.bookingRequest)
      .where(eq(schema.bookingRequest.id, input.id)).limit(1);
    if (!request) throw new NotFoundError("Booking request");

    if (request.status === "declined") return shapeRequest(request);
    if (request.status !== "pending") {
      throw new ConflictError(`This request is ${request.status} and cannot be declined.`);
    }

    await tx.update(schema.bookingRequest).set({
      status: "declined",
      declineReason: input.reason,
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.bookingRequest.id, input.id));

    await audit(tx, ctx, "booking.declined", "booking_request", input.id,
      { status: "pending" }, { status: "declined", reason: input.reason });

    const [updated] = await tx.select().from(schema.bookingRequest)
      .where(eq(schema.bookingRequest.id, input.id)).limit(1);
    return shapeRequest(updated!);
  });
}

export async function configureService(
  ctx: ServiceContext, input: z.infer<typeof configureBookableService.input>,
) {
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const [row] = await tx.update(schema.bookableService).set({
      publicName: input.publicName,
      publicDescription: input.publicDescription ?? null,
      displayPrice: input.displayPrice ?? null,
      depositAmount: input.depositAmount ?? null,
      depositPercent: input.depositPercent ?? null,
      minNoticeHours: input.minNoticeHours,
      maxAdvanceDays: input.maxAdvanceDays,
      maxPerWindow: input.maxPerWindow,
      isActive: input.isActive,
      updatedAt: new Date(),
    }).where(eq(schema.bookableService.id, input.id)).returning();
    if (!row) throw new NotFoundError("Service");

    await audit(tx, ctx, "booking.service.configured", "bookable_service", input.id, null, input);

    return {
      id: row.id,
      publicName: row.publicName,
      publicDescription: row.publicDescription,
      displayPrice: row.displayPrice,
      currency: row.currency,
      depositAmount: row.depositAmount,
      depositPercent: row.depositPercent,
      minNoticeHours: row.minNoticeHours,
      maxAdvanceDays: row.maxAdvanceDays,
      intakeFields: row.intakeFields,
    };
  });
}

/**
 * Matching an existing property before creating one.
 *
 * On the address, never on the name. The same house books under three
 * different names across ten years, and every one of them is the same account
 * and the same equipment history. Matching on the name instead produces a
 * duplicate customer and a service history split across two records, which is
 * the single most common data problem in every system this one replaces.
 */
async function matchOrCreateProperty(
  tx: Database,
  ctx: ServiceContext,
  request: typeof schema.bookingRequest.$inferSelect,
  explicitCustomerId?: string | undefined,
): Promise<{ propertyId: string; customerId: string }> {
  const line1 = (request.addressLine1 ?? "").trim().toLowerCase();
  const postal = (request.postalCode ?? "").trim();

  if (line1 && postal) {
    const [existing] = await tx.select({
      propertyId: schema.property.id,
      customerId: schema.customerProperty.customerId,
    })
      .from(schema.property)
      .leftJoin(schema.customerProperty, and(
        eq(schema.customerProperty.propertyId, schema.property.id),
        eq(schema.customerProperty.isPrimary, true),
        isNull(schema.customerProperty.endedOn),
      ))
      .where(and(
        eq(schema.property.organizationId, ctx.actor.organizationId),
        eq(sql`lower(trim(${schema.property.addressLine1}))`, line1),
        eq(schema.property.postalCode, postal),
        isNull(schema.property.deletedAt),
      )).limit(1);

    if (existing) {
      /**
       * The house is known. Whose it is may not be: an owner moves out, the
       * link is ended, and the next booking is a new customer at the same
       * address with the same equipment history. That is the case the
       * many-to-many exists for, so a missing current link means link the new
       * customer rather than treat the property as unknown.
       */
      if (existing.customerId && !explicitCustomerId) {
        return { propertyId: existing.propertyId, customerId: existing.customerId };
      }
      const customerId = explicitCustomerId ?? await createCustomerFrom(tx, ctx, request);
      await linkCustomerToProperty(tx, ctx, customerId, existing.propertyId);
      return { propertyId: existing.propertyId, customerId };
    }
  }

  const customerId = explicitCustomerId ?? await createCustomerFrom(tx, ctx, request);

  const [property] = await tx.insert(schema.property).values({
    organizationId: ctx.actor.organizationId,
    addressLine1: request.addressLine1 ?? "",
    addressLine2: request.addressLine2 ?? null,
    city: request.city ?? "",
    state: request.state ?? "",
    postalCode: request.postalCode ?? "",
  }).returning({ id: schema.property.id });

  await linkCustomerToProperty(tx, ctx, customerId, property!.id);
  return { propertyId: property!.id, customerId };
}

/**
 * A property is not owned by a column.
 *
 * The link carries a role and a validity window, which is what lets ten years
 * of service history stay with the house while the people in it change. A
 * booking says nothing about tenure, so the role is `owner` and the window is
 * open; correcting that later is an edit, and it does not lose the history.
 */
async function linkCustomerToProperty(
  tx: Database, ctx: ServiceContext, customerId: string, propertyId: string,
) {
  const [existing] = await tx.select({ id: schema.customerProperty.id })
    .from(schema.customerProperty)
    .where(and(
      eq(schema.customerProperty.customerId, customerId),
      eq(schema.customerProperty.propertyId, propertyId),
    )).limit(1);
  if (existing) return;

  await tx.insert(schema.customerProperty).values({
    organizationId: ctx.actor.organizationId,
    customerId,
    propertyId,
    role: "owner",
    isPrimary: true,
  });
}

async function createCustomerFrom(
  tx: Database, ctx: ServiceContext, request: typeof schema.bookingRequest.$inferSelect,
): Promise<string> {
  const [customer] = await tx.insert(schema.customer).values({
    organizationId: ctx.actor.organizationId,
    name: request.contactName,
    email: request.contactEmail ?? null,
    phone: request.contactPhone ?? null,
    leadSource: "online_booking",
  }).returning({ id: schema.customer.id });
  return customer!.id;
}

/** Null when the company asks for nothing up front, which is the common case. */
function depositDue(
  service: typeof schema.bookableService.$inferSelect,
  displayPrice: string | null,
): string | null {
  if (service.depositAmount) return service.depositAmount;
  if (service.depositPercent && displayPrice) {
    return m.toString(m.round(m.multiply(usd(displayPrice), service.depositPercent), 2));
  }
  return null;
}

/**
 * A tracking link for someone who is not yet a customer.
 *
 * The grant is scoped to the booking request itself and carries no customer,
 * because at this moment there is not one: nobody has confirmed the request
 * and creating a customer record for every website form would fill the CRM
 * with people who never became anything. Confirmation attaches the customer.
 */
async function issueTrackingUrl(tx: Database, organizationId: string, requestId: string) {
  const token = randomBytes(32).toString("base64url");
  await tx.insert(schema.portalGrant).values({
    organizationId,
    customerId: null,
    scope: "booking",
    subjectId: requestId,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 90 * 864e5),
  });
  return `${PORTAL_BASE}/b/${token}`;
}

function shapeRequest(r: typeof schema.bookingRequest.$inferSelect) {
  return {
    id: r.id,
    status: r.status,
    bookableServiceId: r.bookableServiceId,
    customerId: r.customerId,
    propertyId: r.propertyId,
    jobId: r.jobId,
    contactName: r.contactName,
    contactEmail: r.contactEmail,
    contactPhone: r.contactPhone,
    addressLine1: r.addressLine1,
    city: r.city,
    state: r.state,
    postalCode: r.postalCode,
    requestedDate: r.requestedDate,
    arrivalWindowId: r.arrivalWindowId,
    notes: r.notes,
    intakeAnswers: r.intakeAnswers,
    sourceUrl: r.sourceUrl,
    referrer: r.referrer,
    utm: r.utm,
    declineReason: r.declineReason,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Distinct technicians whose approved time off covers this calendar day. */
function awayCount(
  off: Array<{ startsAt: Date; endsAt: Date; technicianId: string }>,
  day: Date,
  timeZone: string,
): number {
  // Local bounds, like everywhere else a calendar day is turned into two
  // instants. Time off recorded as a local working day overlapped the wrong
  // UTC window by the offset, which at five hours is most of an afternoon.
  const { start: dayStart, end: dayEnd } = time.dayBoundsIn(time.dateIn(day, timeZone), timeZone);
  const away = new Set(
    off.filter((o) => o.startsAt < dayEnd && o.endsAt > dayStart).map((o) => o.technicianId),
  );
  return away.size;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * `HH:MM` or `HH:MM:SS` as minutes past midnight.
 *
 * An arrival window is a wall clock time rather than an instant: "eight in
 * the morning" stays eight in the morning on the day the clocks change, so it
 * is added to that day's local start rather than stored as an offset.
 */
function minutesInto(clock: string): number {
  const [hours, minutes] = clock.split(":");
  return Number(hours ?? 0) * 60 + Number(minutes ?? 0);
}
const weekday = (dow: number) =>
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dow] ?? "";
