import { and, asc, eq, desc, lt, inArray, sql, gte, lte, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, time, marketing as mk, customerPortal as cp, membership, holidays as holidayRules, SYSTEM_USER_ID } from "@opentradesos/core";
import { randomBytes, createHash } from "node:crypto";
import type { z } from "zod";
import {
  audit, type RequestMeta,
  type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError, OrganizationSuspendedError, DemoReadOnlyError,
} from "./context";
import { emit } from "./events";
import { nextNumber } from "./jobs";
import * as marketingService from "./marketing";
import type {
  listBookableServices, getAvailability, createBookingRequest,
  listBookingRequests, confirmBookingRequest, declineBookingRequest,
  configureBookableService,
  createBookableService, setArrivalWindows, setBusinessHours,
} from "../contracts/booking";
import { portalBase } from "../lib/portal-base";
import { qualifyDays, workSkills } from "./qualification";
import { loadHolidays } from "./holidays";


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
    suspendedAt: schema.organization.suspendedAt,
    demoUserId: schema.organization.demoUserId,
  }).from(schema.organization).where(eq(schema.organization.slug, slug)).limit(1);
  if (!org) throw new NotFoundError("Company");
  /**
   * A suspended company takes no bookings. Every public read and the write
   * come through here, which is why the check is here once rather than in
   * each of them, and a booking request accepted for a company nobody can
   * sign in to read would be a customer waiting for a call that never comes.
   */
  if (org.suspendedAt) throw new OrganizationSuspendedError();
  return { id: org.id, name: org.name, timezone: org.timezone, demo: org.demoUserId != null };
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

  /**
   * From today where the company is, unless asked. The widget asked with the
   * SERVER's today, which from seven in the evening in Austin is tomorrow, so
   * an evening visitor was never offered what was left of today.
   */
  const from = input.from ?? time.dateIn(new Date(), org.timezone);
  return { slots: await openSlots(db, { organizationId: org.id, timezone: org.timezone, service, from, days: input.days }) };
}

export interface OpenSlot {
  date: string;
  arrivalWindowId: string;
  label: string;
  startsAt: string;
  endsAt: string;
  remaining: number;
}

/**
 * The windows a service can be booked into, from a day, for some days.
 *
 * The whole of what the public widget offers, on its own, so that a customer
 * asking to move a visit from their link is offered exactly the windows a
 * stranger booking the same work would be: the same notice, the same open
 * days, the same per window ceiling. Two calendars that disagree about one
 * Tuesday are a customer told two different things by one company.
 *
 * Takes a database handle rather than resolving a company, because one caller
 * has a slug and no tenant context and the other is already inside a grant's
 * tenant boundary. Every read is filtered by the organization explicitly, so
 * it is correct from either.
 *
 * `held` counts what a visit change request has already asked for in a window,
 * pending or approved, the same way a booking request counts: a slot one
 * customer has asked to move into is a slot the next one should not be
 * offered. `exceptRequestId` leaves one request out of that count, so
 * re-checking a request's own slot when it is approved does not find it full
 * of itself.
 */
export async function openSlots(db: Database, input: {
  organizationId: string;
  timezone: string;
  service: typeof schema.bookableService.$inferSelect;
  from: string;
  days: number;
  exceptRequestId?: string | undefined;
  /** The visit being moved, which must not count against its own new window. */
  exceptVisitId?: string | undefined;
  /** Only this technician's free time: a returning customer asking for somebody by name. */
  technicianId?: string | undefined;
  /**
   * Whether the person booking is a member whose plan promised priority, on
   * a day, and how much of each window their plan holds. A member is offered
   * their plan's share of what is held for members; anybody else, the public
   * widget included, none of it.
   */
  member?: MemberShare | undefined;
}): Promise<OpenSlot[]> {
  const { service } = input;
  const org = { id: input.organizationId, timezone: input.timezone };

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
  /**
   * The company's holiday list. On a date in it, its hours replace the
   * week's: a closed date offers nothing, and a short day offers only the
   * windows that fit inside its hours, so Christmas Eve until noon is not
   * offered an afternoon arrival.
   */
  const holidayList = await loadHolidays(db, org.id);

  // The service's own ceiling wins over whatever the caller asked for, so a
  // client cannot widen the calendar past what the company opened.
  const days = Math.min(input.days, service.maxAdvanceDays);
  const earliest = new Date(Date.now() + service.minNoticeHours * 3600_000);

  const from = new Date(`${input.from}T00:00:00Z`);
  const until = new Date(from.getTime() + days * 864e5);

  const counts = await takenCounts(db, {
    organizationId: org.id, serviceIds: [service.id], from: input.from, until: isoDate(until),
    exceptRequestId: input.exceptRequestId,
  });
  const taken = new Map([...counts].map(([key, n]) => [key.slice(service.id.length + 1), n]));
  const takenKey = (date: string, windowId: string) => `${date}|${windowId}`;

  /**
   * WHO COULD ACTUALLY GO, from the board's own facts: the technicians, their
   * time off, the visits already on their days and the work waiting for
   * somebody. Null when the company has no technicians recorded at all, and
   * then the per window limit is all there is to go on, as before.
   */
  const room = await capacityReader(db, {
    organizationId: org.id, timezone: org.timezone, service, from: input.from, until: isoDate(until),
    technicianId: input.technicianId, exceptRequestId: input.exceptRequestId, exceptVisitId: input.exceptVisitId,
    member: input.member,
  });
  if (input.technicianId && room === null) return [];

  const slots: OpenSlot[] = [];

  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 864e5);
    const date = isoDate(day);
    const dow = day.getUTCDay();

    const holiday = holidayRules.holidayOn(holidayList, date);
    if (holiday ? holiday.closed : !openDays.has(dow)) continue;

    for (const w of windows) {
      if (!w.daysOfWeek.includes(dow)) continue;
      if (holiday?.hours && !fitsInside(w, holiday.hours)) continue;

      /**
       * A window that has already started today is not bookable today, and
       * neither is one inside the notice period the company set.
       *
       * `${date}T${w.startsAt}Z` read the company's eight in the morning as
       * eight UTC, which in Austin is three. The notice check was five hours
       * out all summer and six all winter, which is the difference between
       * offering a customer a slot the company can staff and one it cannot.
       */
      const opensAt = windowStart(date, w.startsAt, org.timezone);
      if (opensAt < earliest) continue;

      const used = taken.get(takenKey(date, w.id)) ?? 0;
      /** The company's own limit is the ceiling; the technicians' free time is what is under it. */
      const fits = room ? room(date, w) : null;
      const remaining = Math.min(service.maxPerWindow - used, fits ?? Number.POSITIVE_INFINITY);
      if (remaining <= 0) continue;

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

  return slots;
}

/** Whether an arrival window starts and ends inside a short day's hours. */
function fitsInside(
  window: { startsAt: string; endsAt: string },
  hours: { openMinute: number; closeMinute: number },
): boolean {
  const start = holidayRules.minutesOf(window.startsAt);
  const end = holidayRules.minutesOf(window.endsAt);
  return start !== null && end !== null && start >= hours.openMinute && end <= hours.closeMinute;
}

/**
 * HOW MANY OF A WINDOW'S ONLINE PLACES ARE ALREADY SPOKEN FOR, by service,
 * day and window: booking requests waiting or confirmed, customers' asks to
 * move a visit into it (waiting or agreed), and times the office offered a
 * customer instead (waiting or taken). Keyed `service|date|window`.
 *
 * The one count behind the per window ceiling, read by online booking
 * (`openSlots`) and by the multi day rebalance (`onlineCeilings`), so the
 * two cannot disagree about whether Thursday morning is full.
 * `exceptRequestId` leaves one visit change request out.
 */
export async function takenCounts(db: Database, input: {
  organizationId: string;
  serviceIds: string[];
  from: string;
  until: string;
  exceptRequestId?: string | undefined;
}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (input.serviceIds.length === 0) return out;
  const org = { id: input.organizationId };

  const booked = await db.select({
    serviceId: schema.bookingRequest.bookableServiceId,
    date: schema.bookingRequest.requestedDate,
    windowId: schema.bookingRequest.arrivalWindowId,
    n: sql<number>`count(*)::int`,
  }).from(schema.bookingRequest)
    .where(and(
      eq(schema.bookingRequest.organizationId, org.id),
      inArray(schema.bookingRequest.bookableServiceId, input.serviceIds),
      inArray(schema.bookingRequest.status, ["pending", "confirmed"]),
      gte(schema.bookingRequest.requestedDate, input.from),
      lte(schema.bookingRequest.requestedDate, input.until),
    ))
    .groupBy(schema.bookingRequest.bookableServiceId, schema.bookingRequest.requestedDate, schema.bookingRequest.arrivalWindowId);

  const held = await db.select({
    serviceId: schema.visitChangeRequest.bookableServiceId,
    date: schema.visitChangeRequest.requestedDate,
    windowId: schema.visitChangeRequest.arrivalWindowId,
    n: sql<number>`count(*)::int`,
  }).from(schema.visitChangeRequest)
    .where(and(
      eq(schema.visitChangeRequest.organizationId, org.id),
      inArray(schema.visitChangeRequest.bookableServiceId, input.serviceIds),
      eq(schema.visitChangeRequest.kind, "reschedule"),
      inArray(schema.visitChangeRequest.status, ["pending", "approved"]),
      gte(schema.visitChangeRequest.requestedDate, input.from),
      lte(schema.visitChangeRequest.requestedDate, input.until),
      input.exceptRequestId ? sql`${schema.visitChangeRequest.id} <> ${input.exceptRequestId}` : undefined,
    ))
    .groupBy(schema.visitChangeRequest.bookableServiceId, schema.visitChangeRequest.requestedDate, schema.visitChangeRequest.arrivalWindowId);

  /**
   * A time the office offered a customer instead, waiting for their answer
   * or taken: held like a time a customer asked for, so the window cannot
   * be sold to somebody else while they decide.
   */
  const offered = await db.select({
    serviceId: schema.visitChangeRequest.bookableServiceId,
    date: schema.visitChangeRequest.proposedDate,
    windowId: schema.visitChangeRequest.proposedArrivalWindowId,
    n: sql<number>`count(*)::int`,
  }).from(schema.visitChangeRequest)
    .where(and(
      eq(schema.visitChangeRequest.organizationId, org.id),
      inArray(schema.visitChangeRequest.bookableServiceId, input.serviceIds),
      inArray(schema.visitChangeRequest.status, ["proposed", "accepted"]),
      gte(schema.visitChangeRequest.proposedDate, input.from),
      lte(schema.visitChangeRequest.proposedDate, input.until),
      input.exceptRequestId ? sql`${schema.visitChangeRequest.id} <> ${input.exceptRequestId}` : undefined,
    ))
    .groupBy(schema.visitChangeRequest.bookableServiceId, schema.visitChangeRequest.proposedDate, schema.visitChangeRequest.proposedArrivalWindowId);

  for (const b of [...booked, ...held, ...offered]) {
    const key = `${b.serviceId ?? ""}|${b.date ?? ""}|${b.windowId ?? ""}`;
    out.set(key, (out.get(key) ?? 0) + b.n);
  }
  return out;
}

/**
 * ONLINE BOOKING'S CEILING, FOR A VISIT MOVED BY THE OFFICE'S REBALANCE.
 *
 * Answers, for a visit of some kind of work arriving at some instant, which
 * of the company's online windows that is and how many more places it has
 * under the per window limit: the limit less `takenCounts`. Null when the
 * work is not booked online, or the time is in no window the company
 * offers on that day, because then there is no ceiling to keep. The first
 * active service for a job type is its rules, as when a customer moves a
 * visit from their link.
 */
export async function onlineCeilings(db: Database, input: {
  organizationId: string; timezone: string; from: string; until: string;
}): Promise<(jobTypeId: string | null, start: Date) => { key: string; remaining: number } | null> {
  const services = await db.select().from(schema.bookableService)
    .where(and(eq(schema.bookableService.organizationId, input.organizationId), eq(schema.bookableService.isActive, true)))
    .orderBy(asc(schema.bookableService.createdAt));
  const byType = new Map<string, typeof services[number]>();
  for (const service of services) if (!byType.has(service.jobTypeId)) byType.set(service.jobTypeId, service);
  if (byType.size === 0) return () => null;
  const windows = await db.select().from(schema.arrivalWindow)
    .where(and(eq(schema.arrivalWindow.organizationId, input.organizationId), eq(schema.arrivalWindow.isActive, true)))
    .orderBy(schema.arrivalWindow.sortOrder);
  const taken = await takenCounts(db, {
    organizationId: input.organizationId, serviceIds: [...byType.values()].map((s) => s.id),
    from: input.from, until: input.until,
  });
  return (jobTypeId, start) => {
    const service = jobTypeId ? byType.get(jobTypeId) : undefined;
    if (!service) return null;
    const date = time.dateIn(start, input.timezone);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const clock = time.minutesInDay(start, input.timezone);
    const window = windows.find((w) => w.daysOfWeek.includes(dow)
      && minutesInto(w.startsAt) <= clock && clock < minutesInto(w.endsAt));
    if (!window) return null;
    const key = `${service.id}|${date}|${window.id}`;
    return { key, remaining: Math.max(service.maxPerWindow - (taken.get(key) ?? 0), 0) };
  };
}

/**
 * Somebody can still go: checked inside the transaction that writes a
 * request, against the technicians' days as they are now, because the
 * window free when the page drew can be full by the time the form posts.
 */
export async function assertRoom(db: Database, input: {
  organizationId: string;
  timezone: string;
  service: typeof schema.bookableService.$inferSelect;
  date: string;
  arrivalWindowId: string;
  technicianId?: string | undefined;
  member?: MemberShare | undefined;
}): Promise<void> {
  const [window] = await db.select().from(schema.arrivalWindow)
    .where(and(eq(schema.arrivalWindow.id, input.arrivalWindowId), eq(schema.arrivalWindow.organizationId, input.organizationId)))
    .limit(1);
  if (!window) throw new NotFoundError("Arrival window");
  const room = await capacityReader(db, {
    organizationId: input.organizationId, timezone: input.timezone, service: input.service,
    from: input.date, until: input.date, technicianId: input.technicianId, member: input.member,
  });
  if (input.technicianId && room === null) throw new ConflictError("That technician is not taking bookings. Choose anybody, or another time.");
  if (room && room(input.date, window) <= 0) {
    throw new ConflictError(input.technicianId
      ? "That technician has just been booked for that time. Please choose another."
      : "That time has just been taken. Please choose another.");
  }
}

/**
 * HOW MUCH MORE OF THIS SERVICE EACH WINDOW HOLDS, FROM THE BOARD
 *
 * Loads once what the dispatch board knows for the days asked about, and
 * answers per day and window with `customerPortal.windowCapacity` (core
 * says the model in words). The facts:
 *
 *  - the active technicians, or the one a returning customer asked for;
 *  - whether each is qualified for the service's job type, asked of the
 *    same `qualify` the board's drop and the assignment API ask, for each
 *    day shown (`qualifyDays`), so a licence lapsing mid fortnight stops
 *    offering that person from the day after it expires;
 *  - their approved time off;
 *  - the visits on their days, each taking its estimated length from when
 *    it is due to arrive: their own, their crew's (every member is on a
 *    crew's visit), and a route's stops laid end to end in route order;
 *  - the work waiting for somebody in the same window: unassigned visits,
 *    booking requests not yet booked onto the board, and customers' asks to
 *    move into it.
 *
 * Every read names the organization, because the public widget reaches
 * this with no tenant context. Null when the company has no technicians
 * recorded at all: there is no board to read, and the per window limit is
 * all there is to go on.
 */
export async function capacityReader(db: Database, input: {
  organizationId: string;
  timezone: string;
  /** The kind of work asked about: a bookable service, or a visit's own job type and length. */
  service: { jobTypeId: string | null };
  /** The work's own length, when it is a visit rather than a service's usual length. */
  durationMinutes?: number | undefined;
  from: string;
  until: string;
  technicianId?: string | undefined;
  exceptRequestId?: string | undefined;
  exceptVisitId?: string | undefined;
  /** A job whose own booking request is not to be counted against it: the office giving that job its visit. */
  exceptJobId?: string | undefined;
  /** Whether the person booking is a member whose plan promised priority, on a day. */
  member?: MemberShare | undefined;
}): Promise<((date: string, window: { id: string; startsAt: string; endsAt: string }) => number) | null> {
  const org = input.organizationId;
  const [type] = input.service.jobTypeId ? await db.select({
    skills: schema.jobType.requiredSkills, minutes: schema.jobType.defaultDurationMinutes,
  }).from(schema.jobType)
    .where(and(eq(schema.jobType.id, input.service.jobTypeId), eq(schema.jobType.organizationId, org))).limit(1) : [];
  const duration = input.durationMinutes ?? type?.minutes ?? 60;
  /**
   * When the question is about one job's own booking, that job's skills count:
   * what it asks for beyond its type and what it dropped from it, so room is
   * counted for the people who may actually be sent.
   */
  const [own] = input.exceptJobId ? await db.select({
    skills: schema.job.requiredSkills, dropped: schema.job.droppedSkills,
  }).from(schema.job)
    .where(and(eq(schema.job.id, input.exceptJobId), eq(schema.job.organizationId, org))).limit(1) : [];

  const people = await db.select({ id: schema.technician.id }).from(schema.technician)
    .where(and(
      eq(schema.technician.organizationId, org),
      eq(schema.technician.active, true),
      input.technicianId ? eq(schema.technician.id, input.technicianId) : undefined,
    ));
  if (people.length === 0) return null;
  /** Asked for each day shown, because a certification can lapse in the middle of the calendar. */
  const verdictsOn = await qualifyDays(db, org, {
    technicianIds: people.map((p) => p.id), skills: workSkills(type?.skills, own?.skills, own?.dropped),
    from: input.from, until: input.until,
  });

  /** A day either side, because a company's day is not a UTC day. */
  const lower = new Date(time.startOfDayIn(input.from, input.timezone).getTime() - 864e5);
  const upper = new Date(time.startOfDayIn(input.until, input.timezone).getTime() + 2 * 864e5);
  const live = sql`${schema.visit.status} not in ('cancelled', 'no_show')`;

  const rows = await db.select({
    id: schema.visit.id,
    start: schema.visit.windowStart,
    minutes: schema.visit.estimatedDurationMinutes,
    technicianId: schema.visitAssignment.technicianId,
    crewId: schema.visit.crewId,
    routeId: schema.visit.routeId,
    routeOrder: schema.visit.routeOrder,
    customerId: schema.job.customerId,
    propertyId: schema.job.propertyId,
  })
    .from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .leftJoin(schema.visitAssignment, eq(schema.visitAssignment.visitId, schema.visit.id))
    .where(and(
      eq(schema.visit.organizationId, org),
      gte(schema.visit.windowStart, lower),
      lte(schema.visit.windowStart, upper),
      live,
      input.exceptVisitId ? sql`${schema.visit.id} <> ${input.exceptVisitId}` : undefined,
    ));

  /**
   * WORK THAT IS NOT ONE PERSON'S, COUNTED AGAINST THE PEOPLE WHO DO IT.
   *
   * A crew's visit has no assignment rows: it is `visit.crew_id`, and every
   * member of the crew is on it. Read only the assignments and a crew's
   * whole Tuesday looked like four free technicians.
   *
   * A route's stops are each written with the whole working day as their
   * window, because a route sells a day and a place in the order, not an
   * arrival time. Counted from that window's start each, forty stops would
   * all pile into the first hour; laid end to end in route order (with the
   * route's declared drive between stops, none when it declares none) they
   * take the morning they really take. A route run by a crew is on every
   * member's day like any crew work.
   *
   * A rental's leg (a drop or a collection) is done by whoever is assigned
   * to drive it, so it counts against them through their assignment, and
   * one nobody drives yet is work waiting for somebody, like any other.
   */
  const crewIds = [...new Set(rows.map((r) => r.crewId).filter((id): id is string => id !== null))];
  const members = crewIds.length === 0 ? [] : await db.select({
    crewId: schema.crewMember.crewId, technicianId: schema.crewMember.technicianId,
  }).from(schema.crewMember)
    .where(and(eq(schema.crewMember.organizationId, org), inArray(schema.crewMember.crewId, crewIds)));
  const routeIds = [...new Set(rows.map((r) => r.routeId).filter((id): id is string => id !== null))];
  const drives = routeIds.length === 0 ? [] : await db.select({ id: schema.route.id, minutes: schema.route.travelMinutesBetweenStops })
    .from(schema.route).where(and(eq(schema.route.organizationId, org), inArray(schema.route.id, routeIds)));
  const driveOf = new Map(drives.map((d) => [d.id, d.minutes ?? 0]));
  const laidOut = cp.layRouteStops(
    [...new Map(rows.filter((r) => r.routeId !== null && r.start !== null).map((r) => [r.id, r])).values()]
      .map((r) => ({
        id: r.id, routeId: r.routeId!, day: time.dateIn(r.start!, input.timezone),
        order: r.routeOrder, start: r.start!, minutes: r.minutes,
      })),
    (routeId) => driveOf.get(routeId) ?? 0,
  );
  const visits = rows.flatMap((r) => {
    const laid = laidOut.get(r.id);
    const start = laid?.start ?? r.start;
    const minutes = laid?.minutes ?? r.minutes;
    if (r.crewId === null) return [{ ...r, start, minutes, waiting: r.technicianId === null }];
    /** One row per member, once per visit however many assignment rows the join produced. */
    if (rows.find((x) => x.id === r.id) !== r) return [];
    return members.filter((m) => m.crewId === r.crewId)
      .map((m) => ({ ...r, start, minutes, technicianId: m.technicianId as string | null, waiting: false }));
  });

  const off = await db.select({
    startsAt: schema.timeOff.startsAt, endsAt: schema.timeOff.endsAt, technicianId: schema.timeOff.technicianId,
  }).from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, org),
      eq(schema.timeOff.approved, true),
      lte(schema.timeOff.startsAt, upper),
      gte(schema.timeOff.endsAt, lower),
    ));

  /**
   * Requests not yet on the board: waiting for the office, or confirmed into
   * a job that has no visit yet. Each needs somebody for its service's
   * usual length. A request naming a technician waits for them alone.
   */
  const requests = await db.select({
    date: schema.bookingRequest.requestedDate,
    windowId: schema.bookingRequest.arrivalWindowId,
    minutes: schema.jobType.defaultDurationMinutes,
    technicianId: schema.bookingRequest.preferredTechnicianId,
    customerId: schema.bookingRequest.customerId,
    propertyId: schema.bookingRequest.propertyId,
    jobId: schema.bookingRequest.jobId,
  })
    .from(schema.bookingRequest)
    .innerJoin(schema.bookableService, eq(schema.bookableService.id, schema.bookingRequest.bookableServiceId))
    .innerJoin(schema.jobType, eq(schema.jobType.id, schema.bookableService.jobTypeId))
    .where(and(
      eq(schema.bookingRequest.organizationId, org),
      gte(schema.bookingRequest.requestedDate, input.from),
      lte(schema.bookingRequest.requestedDate, input.until),
      sql`(${schema.bookingRequest.status} = 'pending' or (${schema.bookingRequest.status} = 'confirmed'
        and not exists (select 1 from public.visit v where v.job_id = ${schema.bookingRequest.jobId})))`,
    ));

  const holds = await db.select({
    date: schema.visitChangeRequest.requestedDate,
    windowId: schema.visitChangeRequest.arrivalWindowId,
    minutes: schema.visit.estimatedDurationMinutes,
  })
    .from(schema.visitChangeRequest)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitChangeRequest.visitId))
    .where(and(
      eq(schema.visitChangeRequest.organizationId, org),
      eq(schema.visitChangeRequest.kind, "reschedule"),
      eq(schema.visitChangeRequest.status, "pending"),
      gte(schema.visitChangeRequest.requestedDate, input.from),
      lte(schema.visitChangeRequest.requestedDate, input.until),
      input.exceptRequestId ? sql`${schema.visitChangeRequest.id} <> ${input.exceptRequestId}` : undefined,
    ));
  /** A time the office offered, while the customer decides: it will need somebody if they say yes. */
  const offers = await db.select({
    date: schema.visitChangeRequest.proposedDate,
    windowId: schema.visitChangeRequest.proposedArrivalWindowId,
    minutes: schema.visit.estimatedDurationMinutes,
  })
    .from(schema.visitChangeRequest)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitChangeRequest.visitId))
    .where(and(
      eq(schema.visitChangeRequest.organizationId, org),
      eq(schema.visitChangeRequest.status, "proposed"),
      gte(schema.visitChangeRequest.proposedDate, input.from),
      lte(schema.visitChangeRequest.proposedDate, input.until),
      input.exceptRequestId ? sql`${schema.visitChangeRequest.id} <> ${input.exceptRequestId}` : undefined,
    ));
  holds.push(...offers);

  /**
   * THE SHARE HELD FOR MEMBERS, when the company holds one and has a plan
   * that promises priority. Who is a member is core's cover rule, the one
   * the discount and the board use: active on the day, at this address or
   * sold with none. Members' own work in a window uses the hold up first.
   */
  const hold = await holdFor(db, org);
  const memberOn = hold
    ? await membersAmong(db, org, [...visits.map((v) => v.customerId), ...requests.map((r) => r.customerId)]
      .filter((id): id is string => id !== null))
    : null;
  const now = new Date();

  return (date, window) => {
    const span = {
      start: windowStart(date, window.startsAt, input.timezone),
      end: windowStart(date, window.endsAt, input.timezone),
    };
    const inWindow = (at: Date | null) => at !== null && at >= span.start && at < span.end;
    let waiting = 0;
    for (const v of visits) {
      if (v.waiting && !input.technicianId && inWindow(v.start)) waiting += v.minutes;
    }
    for (const r of requests) {
      if (r.date !== date || r.windowId !== window.id) continue;
      if (input.exceptJobId && r.jobId === input.exceptJobId) continue;
      if (input.technicianId ? r.technicianId === input.technicianId : true) waiting += r.minutes;
    }
    if (!input.technicianId) {
      for (const h of holds) if (h.date === date && h.windowId === window.id) waiting += h.minutes;
    }
    const capacity = cp.windowCapacity({
      window: span,
      durationMinutes: duration,
      waitingMinutes: waiting,
      technicians: people.map((person) => ({
        id: person.id,
        qualified: verdictsOn(date).get(person.id)?.qualified ?? true,
        away: off.some((o) => o.technicianId === person.id && o.startsAt < span.end && o.endsAt > span.start),
        busy: visits
          .filter((v) => v.technicianId === person.id && v.start !== null)
          .map((v) => ({ start: v.start!, minutes: v.minutes })),
      })),
    });
    if (!hold || !memberOn) return capacity.jobs;
    /** The share the booker's own plan holds; a plan holding the most lets its members into all of it. */
    const own = input.member?.(date) ?? null;
    if (own !== null && own >= hold.share) return capacity.jobs;

    /** Members' work already in this window, each visit and request once, in jobs of this length. */
    const counted = new Set<string>();
    let memberMinutes = 0;
    for (const v of visits) {
      if (counted.has(v.id) || !inWindow(v.start) || memberOn(v.customerId, v.propertyId, date) === null) continue;
      if (input.technicianId && v.technicianId !== input.technicianId) continue;
      counted.add(v.id);
      memberMinutes += v.minutes;
    }
    for (const r of requests) {
      if (r.date !== date || r.windowId !== window.id || !r.customerId) continue;
      if (input.technicianId && r.technicianId !== input.technicianId) continue;
      if (input.exceptJobId && r.jobId === input.exceptJobId) continue;
      if (memberOn(r.customerId, r.propertyId, date) !== null) memberMinutes += r.minutes;
    }
    const length = Math.max((span.end.getTime() - span.start.getTime()) / 60_000, 1);
    const size = Math.max(Math.min(duration, length), 1);
    const held = cp.heldForMembers({
      hold, whole: capacity.whole, memberJobs: Math.ceil(memberMinutes / size - 1e-9), opensAt: span.start, now,
      ownShare: own ?? 0,
    });
    return Math.max(capacity.jobs - held, 0);
  };
}

/* ------------------------------------------------ capacity held for members */

/**
 * What a company holds back for members: a share of each arrival window, let
 * go to anybody a number of hours before it opens. Kept in
 * `organization.settings.memberHold`, beside the dispatch settings, because
 * it is one company wide choice.
 */
export interface MemberHoldSettings {
  /** Per cent of each window held for members, 0 to 90. Zero holds nothing. */
  reservePercent: number;
  /** Hours before a window opens when what is still held is let go to anybody. */
  releaseHours: number;
}

const DEFAULT_HOLD: MemberHoldSettings = { reservePercent: 0, releaseHours: 48 };

async function holdSettingsOf(db: Database, organizationId: string): Promise<MemberHoldSettings> {
  const [row] = await db.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const held = ((row?.settings ?? {}) as Record<string, unknown>)["memberHold"] as Partial<MemberHoldSettings> | undefined;
  const num = (v: unknown, d: number, max: number) =>
    (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : d);
  return {
    reservePercent: num(held?.reservePercent, DEFAULT_HOLD.reservePercent, 90),
    releaseHours: num(held?.releaseHours, DEFAULT_HOLD.releaseHours, 336),
  };
}

/** The company's live plans that promise priority dispatch, which is who a hold is for, with each one's own share. */
async function priorityPlanShares(db: Database, organizationId: string) {
  return db.select({
    id: schema.agreementPlan.id, name: schema.agreementPlan.name, holdPercent: schema.agreementPlan.memberHoldPercent,
  }).from(schema.agreementPlan)
    .where(and(
      eq(schema.agreementPlan.organizationId, organizationId),
      eq(schema.agreementPlan.active, true),
      eq(schema.agreementPlan.priorityDispatch, true),
    ));
}

async function priorityPlans(db: Database, organizationId: string): Promise<number> {
  return (await priorityPlanShares(db, organizationId)).length;
}

/**
 * The hold in force, or null when it holds nothing: no live plan that
 * promises priority, or none of them holding any share.
 *
 * EACH PLAN HOLDS ITS OWN SHARE, the company's figure being the share of a
 * plan that set none. A window keeps back the largest of them, and a member
 * is let into as much of it as their own plan holds (`heldForMembers`).
 */
async function holdFor(db: Database, organizationId: string): Promise<cp.MemberHold | null> {
  const settings = await holdSettingsOf(db, organizationId);
  const plans = await priorityPlanShares(db, organizationId);
  if (plans.length === 0) return null;
  const company = settings.reservePercent / 100;
  const share = Math.max(...plans.map((p) => membership.shareOf(p.holdPercent === null ? null : p.holdPercent / 100, company)));
  if (share === 0) return null;
  return { share, releaseHours: settings.releaseHours };
}

/**
 * Which of these customers' work a priority plan covers, on a day at an
 * address: core's `priorityFor`, the board's and the discount's rule. Read
 * with the organization named, because the public widget reaches this with
 * no tenant context.
 */
async function membersAmong(db: Database, organizationId: string, customerIds: string[]) {
  const ids = [...new Set(customerIds)];
  const company = (await holdSettingsOf(db, organizationId)).reservePercent / 100;
  const rows = ids.length === 0 ? [] : await db.select({
    agreementId: schema.agreement.id,
    customerId: schema.agreement.customerId,
    planName: schema.agreementPlan.name,
    discountRate: schema.agreement.discountRate,
    status: schema.agreement.status,
    startedOn: schema.agreement.startedOn,
    endsOn: schema.agreement.endsOn,
    propertyId: schema.agreement.propertyId,
    priorityDispatch: schema.agreementPlan.priorityDispatch,
    holdPercent: schema.agreementPlan.memberHoldPercent,
  })
    .from(schema.agreement)
    .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
    .where(and(
      eq(schema.agreement.organizationId, organizationId),
      inArray(schema.agreement.customerId, ids),
      eq(schema.agreement.status, "active"),
      eq(schema.agreementPlan.priorityDispatch, true),
    ));
  const candidates = rows.map(({ holdPercent, ...row }) => ({ ...row, holdShare: holdPercent === null ? null : holdPercent / 100 }));
  /** The share their plan holds, or null when no plan covering this work promises priority. */
  return (customerId: string, propertyId: string | null, on: string): number | null =>
    membership.priorityShareFor(candidates.filter((r) => r.customerId === customerId), { on, propertyId }, company);
}

/**
 * Whether the person booking is a member on a day, as the share of each held
 * window their plan lets them into, or null for somebody who is not one.
 */
export type MemberShare = (date: string) => number | null;

/**
 * Whether one customer booking is a member on a day: at the address when
 * the booking names one, at any of theirs when it does not yet. For the
 * customer's own account and their link, which know who is asking.
 */
export async function memberTest(
  db: Database, organizationId: string, customerId: string, propertyId: string | null,
): Promise<MemberShare> {
  const covered = await membersAmong(db, organizationId, [customerId]);
  return (date) => covered(customerId, propertyId, date);
}

/**
 * The same, for several customers at once, any of whom may be the person
 * asking: a caller's number or an email that matches more than one record.
 * The largest share any of them holds, because the windows offered are a
 * question about the household, not about which record it is filed under.
 */
export async function memberTestAmong(
  db: Database, organizationId: string, customerIds: readonly string[],
): Promise<MemberShare | null> {
  if (customerIds.length === 0) return null;
  const covered = await membersAmong(db, organizationId, [...customerIds]);
  const any = (date: string) => {
    const shares = customerIds.map((id) => covered(id, null, date)).filter((x): x is number => x !== null);
    return shares.length === 0 ? null : Math.max(...shares);
  };
  return any;
}

/**
 * WORK BOOKED BY HAND INTO TIME HELD FOR MEMBERS
 *
 * Online booking never offers the held share to somebody who is not a
 * member, and the office booking a job by hand was not held to it at all,
 * so a stranger rung through at nine in the morning could take Tuesday's
 * last held slot from the member who rings at ten. This is the question the
 * office's booking asks first: is this visit going into an arrival window
 * whose remaining room is held back from this customer.
 *
 * Asked of every active arrival window the visit's arrival time falls in on
 * its day, with the visit's own job type and length, as the booking page
 * would. Only when the hold is what makes the difference: a window already
 * full for everybody is a full window, which the office has always been
 * free to overbook. Null when nothing is held from them there.
 */
export async function heldAgainst(db: Database, input: {
  organizationId: string;
  timezone: string;
  customerId: string;
  propertyId: string | null;
  jobTypeId: string | null;
  durationMinutes: number;
  windowStart: Date;
  exceptJobId?: string | undefined;
  exceptVisitId?: string | undefined;
}): Promise<{ date: string; windowName: string } | null> {
  const hold = await holdFor(db, input.organizationId);
  if (!hold) return null;
  const date = time.dateIn(input.windowStart, input.timezone);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const windows = await db.select().from(schema.arrivalWindow)
    .where(and(eq(schema.arrivalWindow.organizationId, input.organizationId), eq(schema.arrivalWindow.isActive, true)));
  const inside = windows.filter((w) => w.daysOfWeek.includes(dow)
    && windowStart(date, w.startsAt, input.timezone) <= input.windowStart
    && input.windowStart < windowStart(date, w.endsAt, input.timezone));
  if (inside.length === 0) return null;

  const theirs = await memberTest(db, input.organizationId, input.customerId, input.propertyId);
  const asked = {
    organizationId: input.organizationId, timezone: input.timezone,
    service: { jobTypeId: input.jobTypeId }, durationMinutes: input.durationMinutes,
    from: date, until: date, exceptJobId: input.exceptJobId, exceptVisitId: input.exceptVisitId,
  };
  const forThem = await capacityReader(db, { ...asked, member: theirs });
  const forAMember = await capacityReader(db, { ...asked, member: () => 1 });
  if (!forThem || !forAMember) return null;
  for (const w of inside) {
    if (forThem(date, w) <= 0 && forAMember(date, w) > 0) return { date, windowName: w.name };
  }
  return null;
}

/**
 * Whether any share of any window is held for members at all, for the
 * office's booking form to offer "book anyway" only where it can matter.
 * `job:read`, because whoever books a job by hand needs to know and may not
 * hold the booking settings.
 */
/**
 * How much room outside the hold each of several visits would find in the
 * window it would move into, for the rebalance that moves work between days.
 *
 * Only for a visit whose customer no plan lets into the hold, and only where
 * the hold is holding something there (a member would find more room than
 * they do); everything else is left out of the answer, and moves freely as
 * it always has. Keyed by `ref`; `key` names the day and window, so the
 * planner can count every visit it moves into the same one.
 */
export async function roomOutsideHold(db: Database, input: {
  organizationId: string;
  timezone: string;
  asks: readonly {
    ref: string; customerId: string; propertyId: string | null; jobTypeId: string | null;
    durationMinutes: number; windowStart: Date;
  }[];
}): Promise<Map<string, { key: string; room: number }>> {
  const out = new Map<string, { key: string; room: number }>();
  if (input.asks.length === 0 || !(await holdFor(db, input.organizationId))) return out;
  const windows = await db.select().from(schema.arrivalWindow)
    .where(and(eq(schema.arrivalWindow.organizationId, input.organizationId), eq(schema.arrivalWindow.isActive, true)));
  const members = await membersAmong(db, input.organizationId, input.asks.map((a) => a.customerId));
  const dates = input.asks.map((a) => time.dateIn(a.windowStart, input.timezone)).sort();
  const readers = new Map<string, { stranger: Awaited<ReturnType<typeof capacityReader>>; member: Awaited<ReturnType<typeof capacityReader>> }>();
  for (const ask of input.asks) {
    const date = time.dateIn(ask.windowStart, input.timezone);
    if (members(ask.customerId, ask.propertyId, date) !== null) continue;
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const w = windows.find((x) => x.daysOfWeek.includes(dow)
      && windowStart(date, x.startsAt, input.timezone) <= ask.windowStart
      && ask.windowStart < windowStart(date, x.endsAt, input.timezone));
    if (!w) continue;
    const kind = `${ask.jobTypeId ?? ""}|${ask.durationMinutes}`;
    if (!readers.has(kind)) {
      const asked = {
        organizationId: input.organizationId, timezone: input.timezone,
        service: { jobTypeId: ask.jobTypeId }, durationMinutes: ask.durationMinutes,
        from: dates[0]!, until: dates.at(-1)!,
      };
      readers.set(kind, {
        stranger: await capacityReader(db, asked),
        member: await capacityReader(db, { ...asked, member: () => 1 }),
      });
    }
    const { stranger, member } = readers.get(kind)!;
    if (!stranger || !member) continue;
    const room = stranger(date, w);
    if (member(date, w) > room) out.set(ask.ref, { key: `${date}|${w.id}`, room: Math.max(room, 0) });
  }
  return out;
}

export async function memberHoldInForce(ctx: ServiceContext): Promise<boolean> {
  return guardedRead(ctx, "job:read", async (tx) => (await holdFor(tx, ctx.actor.organizationId)) !== null);
}

export async function memberHold(ctx: ServiceContext) {
  return guardedRead(ctx, "booking:read", async (tx) => ({
    ...await holdSettingsOf(tx, ctx.actor.organizationId),
    plansWithPriority: await priorityPlans(tx, ctx.actor.organizationId),
    plans: await priorityPlanShares(tx, ctx.actor.organizationId),
  }));
}

export async function setMemberHold(ctx: ServiceContext, input: { reservePercent: number; releaseHours: number }) {
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    if (!Number.isInteger(input.reservePercent) || input.reservePercent < 0 || input.reservePercent > 90) {
      throw new ConflictError("Hold between none and ninety per cent of each window for members.");
    }
    if (!Number.isInteger(input.releaseHours) || input.releaseHours < 0 || input.releaseHours > 336) {
      throw new ConflictError("The hold is let go between 0 and 336 hours (two weeks) before a window opens.");
    }
    const before = await holdSettingsOf(tx, ctx.actor.organizationId);
    const after: MemberHoldSettings = { reservePercent: input.reservePercent, releaseHours: input.releaseHours };
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ memberHold: after })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "booking.member_hold_set", "organization", ctx.actor.organizationId, before, after);
    return {
      ...after,
      plansWithPriority: await priorityPlans(tx, ctx.actor.organizationId),
      plans: await priorityPlanShares(tx, ctx.actor.organizationId),
    };
  });
}

/** A window's clock time on a day, as an instant, in the company's zone. */
export function windowStart(date: string, clock: string, timezone: string): Date {
  return new Date(time.startOfDayIn(date, timezone).getTime() + minutesInto(clock) * 60_000);
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
  /**
   * Never from the request body. Set by the assistants when the number or
   * email they were reached from belongs to a member, so the request may go
   * into the share held for members that they were offered.
   */
  options: { member?: MemberShare | null | undefined } = {},
) {
  const org = await resolveOrg(db, input.organizationSlug);
  // The demo company's booking page shows its services and its free windows,
  // and books nothing: a request there would be a stranger's name and phone
  // number in a company every visitor can read.
  if (org.demo) throw new DemoReadOnlyError();

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
          paymentUrl: null,
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
    /**
     * A date the company has since put on its holiday list, or a window
     * outside a short day's hours, is refused the way a full window is: the
     * page offered it before the list changed, and a request for Christmas
     * Day is a customer waiting for somebody who is not coming.
     */
    const holiday = holidayRules.holidayOn(await loadHolidays(tx, org.id), input.requestedDate);
    if (holiday) {
      const [window] = await tx.select().from(schema.arrivalWindow)
        .where(and(eq(schema.arrivalWindow.id, input.arrivalWindowId), eq(schema.arrivalWindow.organizationId, org.id)))
        .limit(1);
      if (holiday.closed || !window || !holiday.hours || !fitsInside(window, holiday.hours)) {
        throw new ConflictError(`We are ${holiday.closed ? "closed" : "only open part of the day"} on ${input.requestedDate} (${holiday.name}). Please choose another time.`);
      }
    }
    await assertRoom(tx, {
      organizationId: org.id, timezone: org.timezone, service, date: input.requestedDate,
      arrivalWindowId: input.arrivalWindowId, member: options.member ?? undefined,
    });

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
      landingQuery: input.landingQuery ?? null,
      visitorId: input.visitorId ?? null,
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

    /**
     * A DOMAIN EVENT AS WELL AS THE INTEGRATION ROW ABOVE.
     *
     * The two are not the same thing and both are needed. The integration
     * event is a receipt for idempotency; the domain event is what a
     * workflow subscribes to. The builder offered "when somebody books
     * online" and this path emitted nothing, so the first automation most
     * companies would ever write was one that never ran.
     *
     * Under the system actor, because a booking request has no signed in
     * user by definition: the point of it is that a stranger made it.
     */
    await emit(tx, {
      actor: {
        userId: SYSTEM_USER_ID, organizationId: org.id, roles: [], grants: [],
        agentId: "booking",
      },
      db: tx,
    }, {
      name: "booking.requested", entityType: "booking_request", entityId: row!.id,
      payload: {
        bookingRequestId: row!.id,
        contactName: row!.contactName,
        requestedDate: row!.requestedDate,
        serviceId: service.id,
      },
    });

    /**
     * THE TOUCH IS KEPT, NOT REDUCED TO A WORD.
     *
     * This used to be one call to `parseTouch` whose result was thrown away
     * except for `.source`, written onto the job as a string. That single
     * line is why nothing else in the marketing module could work:
     * attribution is a property of a sequence of touches and the product was
     * keeping one word per lead, so every model in core had no possible
     * caller.
     *
     * Written in the same transaction as the request. A touch that outlived
     * a rolled back booking would be a lead in the report that nobody can
     * find, and a report with more leads than the CRM is a report nobody
     * trusts twice.
     */
    await marketingService.recordTouch(tx, org.id, {
      at: row!.createdAt,
      /**
       * The browser's own id when the widget sent one, and otherwise the
       * request itself as the thread, so confirming it can always find this
       * touch. Without a thread, a booking from a page with no visitor script
       * left its touch belonging to nobody, the job was credited to nothing,
       * and the only record of where it came from was a word on the job.
       */
      visitorId: input.visitorId ?? requestThread(row!.id),
      callerE164: mk.callerKey(input.contactPhone),
      /**
       * The raw query when the widget sent one, falling back to the utm bag
       * rebuilt as a query string. The fallback loses the click id, because
       * `gclid` is not a utm_ key, and that is precisely the loss the
       * `landingQuery` column exists to stop.
       */
      query: input.landingQuery ?? utmAsQuery(input.utm),
      referrer: input.referrer ?? null,
      landingPath: pathOf(input.sourceUrl),
      ownHosts: [new URL(portalBase()).host],
    });

    const deposit = depositDue(service, service.displayPrice);

    return {
      request: shapeRequest(row!),
      // Tracking without an account. Issued now rather than on confirmation,
      // because the gap between booking and a human confirming it is exactly
      // when a customer most wants to see that something happened.
      trackingUrl: await issueTrackingUrl(tx, org.id, row!.id),
      depositDue: deposit,
      /**
       * No link, rather than a link to nothing. This used to be
       * `/pay/booking/{request id}`, which had no page behind it and was an
       * id rather than a capability. A booking request has no customer yet,
       * so there is nobody for a deposit to be held for: the deposit is
       * requested once the office confirms the booking into a customer, and
       * a `deposit` link issued for it (`POST /v1/portal/grants`) opens
       * `/pay/{token}`.
       */
      paymentUrl: null,
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
    }).returning({ id: schema.job.id });

    await tx.update(schema.bookingRequest).set({
      status: "confirmed",
      customerId,
      propertyId,
      jobId: job!.id,
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.bookingRequest.id, input.id));

    /**
     * THE MOMENT AN ANONYMOUS HISTORY BECOMES SOMEBODY'S, and the work is
     * credited to it.
     *
     * This was written out here, and only here, which is why a job booked
     * online was credited and a job a CSR typed in after a call on a tracking
     * number was not. It is `marketing.creditWork` now, shared by every path
     * that creates work: the visitor's earlier touches join the customer, the
     * customer's untagged touches are tagged with this job, and the job's
     * lead source, channel and campaign are filled from the company's chosen
     * model and marked `derived`.
     */
    await marketingService.creditWork(tx, ctx.actor.organizationId, {
      jobId: job!.id,
      visitorId: request.visitorId ?? requestThread(request.id),
    });

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

    return shapeService(row);
  });
}

/**
 * One shape for a service, used by creating and by configuring.
 *
 * Written out twice, it drifts: the second copy loses a field, and the
 * difference only shows up as a client that works after an edit and not after
 * a create.
 */
function shapeService(row: typeof schema.bookableService.$inferSelect) {
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
  /**
   * A request a customer made from their own account already says who and
   * where. Matching it by address again could only find somebody else.
   */
  if (request.customerId && request.propertyId && !explicitCustomerId) {
    return { propertyId: request.propertyId, customerId: request.customerId };
  }
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
    /**
     * Left blank here and filled by `creditWork` from the touch the request
     * recorded, marked `derived`, rather than written as a bare word: the word
     * was all this path used to keep.
     */
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
  return `${portalBase()}/b/${token}`;
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
    preferredTechnicianId: r.preferredTechnicianId,
    declineReason: r.declineReason,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
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

/**
 * OFFERING A JOB TYPE TO THE PUBLIC, which nothing could do.
 *
 * `configureService` above updates a row. No code path in this product ever
 * inserted one: not the API, not the app, not the seed. So `/book/[slug]`
 * listed nothing for every company that has ever existed, permanently, and
 * the only endpoint touching the table updated rows that could not be there.
 *
 * The module is marked as shipped. A whole customer-facing surface was
 * unreachable and the only symptom was an empty list, which reads as "this
 * company offers nothing online" rather than as a missing feature.
 */
export async function createService(
  ctx: ServiceContext, input: z.infer<typeof createBookableService.input>,
) {
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const [jobType] = await tx.select({ id: schema.jobType.id })
      .from(schema.jobType)
      .where(and(
        eq(schema.jobType.id, input.jobTypeId),
        eq(schema.jobType.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!jobType) throw new NotFoundError("Job type");

    /**
     * One offering per job type. Two would put the same work on the booking
     * page twice under different names and different prices, and the customer
     * would pick whichever they saw first.
     */
    const [existing] = await tx.select({ id: schema.bookableService.id })
      .from(schema.bookableService)
      .where(and(
        eq(schema.bookableService.jobTypeId, input.jobTypeId),
        isNull(schema.bookableService.deletedAt),
      )).limit(1);
    if (existing) {
      throw new ConflictError(
        "That job type is already offered online. Edit the existing one rather than adding a second.",
      );
    }

    /**
     * A deposit is an amount OR a percent, never both.
     *
     * Both set means two answers to "what do they owe now", and the one that
     * gets charged is whichever the code reads first. `depositDue` reads the
     * amount, so a company that set 10 percent and later typed a flat fifty
     * would silently start charging fifty.
     */
    if (input.depositAmount && input.depositPercent) {
      throw new ConflictError(
        "A deposit is either an amount or a percent. Two would be two answers to what the customer owes.",
      );
    }

    const [row] = await tx.insert(schema.bookableService).values({
      organizationId: ctx.actor.organizationId,
      jobTypeId: input.jobTypeId,
      publicName: input.publicName,
      publicDescription: input.publicDescription ?? null,
      displayPrice: input.displayPrice ?? null,
      depositAmount: input.depositAmount ?? null,
      depositPercent: input.depositPercent ?? null,
      minNoticeHours: input.minNoticeHours,
      maxAdvanceDays: input.maxAdvanceDays,
      maxPerWindow: input.maxPerWindow,
      /**
       * Live immediately. A service created and left switched off is the
       * same empty booking page the company just tried to fix, and the
       * switch already exists on `configureService` for turning it back off.
       */
      isActive: true,
    }).returning();

    await audit(tx, ctx, "booking.service.created", "bookable_service", row!.id, null, row!);
    return shapeService(row!);
  });
}

/**
 * The windows a customer may choose, replaced as a whole set.
 *
 * `arrival_window` was written by nothing, which is the other half of why the
 * booking page was empty: with no windows, even a service produces a calendar
 * with no slots on it.
 *
 * Sent as the entire list rather than one at a time, so there is no moment
 * where a company has half a set of windows published. The alternative,
 * add-one-then-remove-one, is visible to customers between the two calls.
 */
export async function setWindows(
  ctx: ServiceContext, input: z.infer<typeof setArrivalWindows.input>,
) {
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    for (const window of input.windows) {
      /**
       * A window that ends before it starts would publish a slot nobody can
       * arrive in, and `availability` would compute a negative span rather
       * than refusing. Equal is refused too: a zero length window is a slot
       * a customer can book and a technician cannot attend.
       */
      if (window.endsAt <= window.startsAt) {
        throw new ConflictError(
          `"${window.name}" ends at ${window.endsAt} and starts at ${window.startsAt}.`,
        );
      }
    }

    await tx.delete(schema.arrivalWindow)
      .where(eq(schema.arrivalWindow.organizationId, ctx.actor.organizationId));

    if (input.windows.length > 0) {
      await tx.insert(schema.arrivalWindow).values(
        input.windows.map((window, index) => ({
          organizationId: ctx.actor.organizationId,
          name: window.name,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          daysOfWeek: window.daysOfWeek,
          /**
           * Position in the submitted list, so the booking page offers them
           * in the order the company arranged rather than by name. "8am to
           * 12pm" sorts after "12pm to 4pm" alphabetically.
           */
          sortOrder: index,
          isActive: true,
        })),
      );
    }

    await audit(tx, ctx, "booking.windows.set", "organization",
      ctx.actor.organizationId, null, { count: input.windows.length });

    return { windows: input.windows.length };
  });
}

/**
 * Which days the company is open.
 *
 * All seven every time, because a partial week is ambiguous: a missing
 * Saturday row could mean closed or could mean nobody has said yet, and
 * `availability` treats an absent row as closed. Requiring the full set
 * makes the company's answer explicit for every day.
 */
export async function setHours(
  ctx: ServiceContext, input: z.infer<typeof setBusinessHours.input>,
) {
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const days = new Set(input.days.map((d) => d.dayOfWeek));
    if (days.size !== 7) {
      throw new ConflictError("Send all seven days. A day left out is a day nobody has answered for.");
    }

    for (const day of input.days) {
      if (day.closed) continue;
      if (!day.opensAt || !day.closesAt) {
        throw new ConflictError(
          `Day ${day.dayOfWeek} is open and has no hours. Say when, or mark it closed.`,
        );
      }
      if (day.closesAt <= day.opensAt) {
        throw new ConflictError(
          `Day ${day.dayOfWeek} closes at ${day.closesAt} and opens at ${day.opensAt}.`,
        );
      }
    }

    await tx.delete(schema.businessHours)
      .where(eq(schema.businessHours.organizationId, ctx.actor.organizationId));

    await tx.insert(schema.businessHours).values(
      input.days.map((day) => ({
        organizationId: ctx.actor.organizationId,
        dayOfWeek: day.dayOfWeek,
        opensAt: day.closed ? null : day.opensAt,
        closesAt: day.closed ? null : day.closesAt,
        closed: day.closed,
      })),
    );

    await audit(tx, ctx, "booking.hours.set", "organization",
      ctx.actor.organizationId, null, { open: input.days.filter((d) => !d.closed).length });

    return { days: input.days.length };
  });
}

/**
 * WHERE THIS BOOKING ACTUALLY CAME FROM.
 *
 * Both write sites used to say `"online_booking"`, which is not a lead
 * source at all: it is a CHANNEL. `marketing.LEAD_SOURCES` is a catalogue of
 * twenty one real sources and `online_booking` is not among them, so every
 * job and customer this path created carried a value no report could group,
 * no attribution model could credit, and `leadSourceLabel` rendered by
 * replacing an underscore with a space.
 *
 * The distinction costs money. Somebody who searched, clicked a Google ad
 * and then booked on the website came from Google Ads, and the ad account
 * paid for them. Recording the booking widget instead credits the website
 * for every paid click a company buys, and the ads look free.
 *
 * `marketing.parseTouch` does the whole job and was called by nothing. I
 * wrote a hand rolled version of it first, reading `utm_source` and falling
 * back to the referrer, and it was wrong in two ways that `parseTouch`
 * already has right:
 *
 *   It missed CLICK IDS entirely. A `gclid` on the landing page is proof of
 *   a paid click and settles a bare `utm_source=google` that has no medium,
 *   which is the single most common tagging shape in this trade.
 *
 *   It fell back to the referrer when a UTM was present and did not resolve.
 *   `parseTouch` answers `unknown` there, deliberately, because that is the
 *   difference between "we have a gap in our alias list" and "they came
 *   straight to us", and collapsing the two makes a data problem look like
 *   brand strength.
 *
 * The lesson is the one this codebase keeps relearning: the function was
 * already written, tested, and unused, and reimplementing it produced
 * something worse that looked the same from outside.
 */
/**
 * The utm bag as a query string.
 *
 * A fallback for requests that arrived before `landing_query` existed, and
 * for a widget that has not been updated to send it. It loses the click id
 * by construction, because `gclid`, `msclkid` and `fbclid` are not utm_
 * keys: that loss is the reason the column was added, and naming it here is
 * how the next person finds out why two paths exist.
 */
function utmAsQuery(utm: Record<string, string | undefined>): string {
  return Object.entries(utm)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value!)}`)
    .join("&");
}

/** The path a visitor landed on, without the host or the query. */
function pathOf(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).pathname;
  } catch {
    /**
     * A landing page URL is whatever an email client, a scanner or a QR code
     * put in the address bar. Refusing to record the touch because the URL
     * will not parse would throw away the lead to keep a field tidy.
     */
    return null;
  }
}

/** The anonymous thread a booking request's touch carries when the page sent no visitor id. */
const requestThread = (requestId: string) => `booking_request:${requestId}`;
