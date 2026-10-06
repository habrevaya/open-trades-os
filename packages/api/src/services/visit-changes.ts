import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, time, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, InvalidGrantError, NotFoundError,
  type RequestMeta, type ServiceContext,
} from "./context";
import { announce, sideOf } from "./visit-notices";
import { consume, inGrant, peek, type ResolvedGrant } from "./portal";
import { memberTest, openSlots, windowStart, type OpenSlot } from "./booking";
import { refusingDuplicate } from "./duplicates";
import { sendTransactional } from "./comms-send";
import * as email from "./email";
import { emit } from "./events";

/**
 * A CUSTOMER ASKING TO MOVE OR CANCEL A VISIT, AND THE OFFICE ANSWERING
 *
 * "Rescheduling from the portal is not built: a customer who needs a different
 * day replies." That reply arrives as a text at nine at night with no visit
 * attached to it, somebody reads it in the morning, looks the customer up, finds
 * the job, opens the board, and texts back. This is the same conversation with
 * the lookups done.
 *
 * IT IS A REQUEST, NEVER A MOVE. A visit on the board has a technician, a route
 * and a morning built around it that the customer cannot see. A portal that
 * moved a dispatched visit on a tap would leave a van outside an empty house.
 * So the customer asks, the request lands in the office queue and on the job,
 * and a person approves or declines it. Approving is what moves the visit, and
 * the customer is told the answer through the same messaging as everything
 * else, with consent checked at the moment it is sent.
 *
 * THE WINDOWS OFFERED ARE ONLINE BOOKING'S. The customer chooses from exactly
 * the windows a stranger booking the same work would be offered, from the same
 * function: the company's notice period, its open days, its per window ceiling
 * and its service area. A request is checked against them when it is made and
 * again when it is approved, because a window free on Monday evening can be
 * gone by Tuesday morning.
 *
 * WHICH SERVICE'S RULES. The bookable service for the job's type. A job whose
 * type the company does not take online bookings for cannot be moved from the
 * link, because there are no rules saying when it may go; the customer can
 * still ask to cancel, and is told to reply about a new time.
 */

/** What a customer may still change. On the way, in progress or done is the office's to handle. */
const CHANGEABLE = ["unassigned", "scheduled", "dispatched"] as const;

const isChangeable = (visit: { status: string; windowStart: Date | null }, now: Date): boolean =>
  (CHANGEABLE as readonly string[]).includes(visit.status)
  && visit.windowStart !== null && visit.windowStart > now;

export interface ChangeOptions {
  organizationName: string;
  visit: {
    id: string;
    jobNumber: number;
    summary: string;
    windowStart: string;
    windowEnd: string | null;
    status: string;
  };
  /** The request already waiting on this visit, if there is one. Nothing new can be asked meanwhile. */
  pending: { id: string; kind: "reschedule" | "cancel"; requestedStart: string | null; requestedEnd: string | null; createdAt: string } | null;
  /** The last decision on this visit, so the page can say what happened. */
  decided: { kind: "reschedule" | "cancel"; status: string; response: string | null; decidedAt: string | null } | null;
  canChange: boolean;
  /** Why the visit cannot be changed from here, when it cannot. */
  changeBlockedBy: string | null;
  /** Why it cannot be moved from here even though it can be cancelled. */
  rescheduleBlockedBy: string | null;
  timezone: string;
  slots: OpenSlot[];
}

/** The visit a link reaches, checked against what the link is for. Another visit is not found. */
async function visitFor(tx: Database, grant: ResolvedGrant, visitId: string | undefined) {
  if (grant.scope !== "job" && grant.scope !== "customer") throw new InvalidGrantError();
  if (!grant.customerId) throw new InvalidGrantError();

  const rows = await tx.select({
    visit: schema.visit,
    job: schema.job,
    postalCode: schema.property.postalCode,
  })
    .from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
    .where(and(
      eq(schema.job.customerId, grant.customerId),
      grant.scope === "job" ? eq(schema.job.id, grant.subjectId ?? "") : undefined,
      visitId ? eq(schema.visit.id, visitId) : undefined,
    ))
    .orderBy(asc(schema.visit.windowStart));

  /**
   * A job link with no visit named reaches the next visit still to come, the
   * same one the tracking page shows: a four visit job must not offer to move
   * the one in March when the customer is asking about tomorrow.
   */
  const now = new Date();
  const row = visitId
    ? rows[0]
    : rows.find((r) => isChangeable(r.visit, now)) ?? rows[rows.length - 1];
  if (!row) throw new NotFoundError("Visit");
  return row;
}

/**
 * The online booking service whose rules govern this job, and whether the
 * address is inside the area it is offered in.
 */
async function rulesFor(
  tx: Database,
  organizationId: string,
  job: typeof schema.job.$inferSelect,
  postalCode: string | null,
): Promise<{ service: typeof schema.bookableService.$inferSelect | null; blockedBy: string | null }> {
  if (!job.jobTypeId) {
    return { service: null, blockedBy: "This visit cannot be moved online. Reply to the message that brought you here and the office will find another time." };
  }
  const [service] = await tx.select().from(schema.bookableService)
    .where(and(
      eq(schema.bookableService.organizationId, organizationId),
      eq(schema.bookableService.jobTypeId, job.jobTypeId),
      eq(schema.bookableService.isActive, true),
    ))
    .orderBy(asc(schema.bookableService.createdAt))
    .limit(1);
  if (!service) {
    return { service: null, blockedBy: "This kind of visit cannot be moved online. Reply to the message that brought you here and the office will find another time." };
  }

  /**
   * THE SERVICE AREA. A territory with postal codes on it is where the
   * company takes this work online, and an address outside it is one the
   * office has to decide about by hand, as it would a new booking from there.
   */
  if (service.territoryId) {
    const [territory] = await tx.select({ postalCodes: schema.territory.postalCodes })
      .from(schema.territory).where(eq(schema.territory.id, service.territoryId)).limit(1);
    const codes = territory?.postalCodes ?? [];
    if (codes.length > 0 && !codes.includes((postalCode ?? "").trim())) {
      return { service, blockedBy: "Your address is outside the area this visit can be moved online for. Reply to the message that brought you here and the office will find another time." };
    }
  }
  return { service, blockedBy: null };
}

/**
 * What a customer can do about a visit, from their link.
 *
 * Peeked rather than consumed, like every portal read: looking costs nothing.
 */
export async function options(
  db: Database,
  input: { token: string; visitId?: string | undefined; from?: string | undefined; days?: number | undefined },
): Promise<ChangeOptions> {
  const grant = await peek(db, input.token);
  return inGrant(db, grant, async (tx) => {
    const { visit, job, postalCode } = await visitFor(tx, grant, input.visitId);
    const timezone = await timezoneOf(tx, grant.organizationId);
    const now = new Date();

    const [org] = await tx.select({ name: schema.organization.name })
      .from(schema.organization).where(eq(schema.organization.id, grant.organizationId)).limit(1);

    const requests = await tx.select().from(schema.visitChangeRequest)
      .where(eq(schema.visitChangeRequest.visitId, visit.id))
      .orderBy(desc(schema.visitChangeRequest.createdAt));
    const pending = requests.find((r) => r.status === "pending") ?? null;
    const decided = requests.find((r) => r.status === "approved" || r.status === "declined") ?? null;

    const changeable = isChangeable(visit, now);
    const rules = changeable && !pending
      ? await rulesFor(tx, grant.organizationId, job, postalCode)
      : { service: null, blockedBy: null };

    const slots = rules.service && !rules.blockedBy
      ? (await openSlots(tx, {
        organizationId: grant.organizationId,
        timezone,
        service: rules.service,
        from: input.from ?? time.dateIn(now, timezone),
        days: Math.min(input.days ?? 21, 60),
        /** The visit being moved does not stand in its own way. */
        exceptVisitId: visit.id,
        /** A member is offered the share of each window held for members, as when booking. */
        member: await memberTest(tx, grant.organizationId, job.customerId, job.propertyId),
      }))
      : [];

    return {
      organizationName: org?.name ?? "",
      visit: {
        id: visit.id,
        jobNumber: job.number,
        summary: job.summary,
        windowStart: visit.windowStart!.toISOString(),
        windowEnd: visit.windowEnd?.toISOString() ?? null,
        status: visit.status,
      },
      pending: pending
        ? {
          id: pending.id, kind: pending.kind,
          requestedStart: pending.requestedStart?.toISOString() ?? null,
          requestedEnd: pending.requestedEnd?.toISOString() ?? null,
          createdAt: pending.createdAt.toISOString(),
        }
        : null,
      decided: decided
        ? {
          kind: decided.kind, status: decided.status, response: decided.response,
          decidedAt: decided.decidedAt?.toISOString() ?? null,
        }
        : null,
      canChange: changeable && !pending,
      changeBlockedBy: !changeable
        ? "This visit is already under way or done, so it cannot be changed from here. Reply to the message that brought you here."
        : pending
          ? "You have already asked about this visit. The office will reply to you."
          : null,
      rescheduleBlockedBy: changeable && !pending
        ? (rules.blockedBy ?? (slots.length === 0 ? "There are no open times in the next few weeks to move it to. Reply to the message that brought you here and the office will find one." : null))
        : null,
      timezone,
      slots,
    };
  });
}

/** The actor the portal writes as. Holds nothing; the grant is the authority. */
const portalSystem = (organizationId: string): Actor => ({
  userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "portal",
});

const sentenceWindow = (start: Date, end: Date | null, timezone: string): string => {
  const day = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timezone });
  const at = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  return end ? `${day}, between ${at(start)} and ${at(end)}` : `${day} at ${at(start)}`;
};

/**
 * Ask to move or cancel a visit.
 *
 * CONSUMED, because it acts. A link capped at some number of uses is spent by
 * asking, the same as approving an estimate is.
 *
 * A RETRY IS THE SAME REQUEST. A customer on one bar who taps twice gets the
 * request the first tap made back, rather than a refusal saying they already
 * asked. A different request while one is waiting is refused in words, by the
 * unique index rather than a check, because two taps race.
 */
export async function request(
  db: Database,
  input: {
    token: string;
    visitId?: string | undefined;
    kind: "reschedule" | "cancel";
    requestedDate?: string | undefined;
    arrivalWindowId?: string | undefined;
    reason?: string | undefined;
  },
  meta?: RequestMeta,
) {
  const grant = await consume(db, input.token, meta?.ip);
  return inGrant(db, grant, async (tx, portalCtx) => {
    const { visit, job, postalCode } = await visitFor(tx, grant, input.visitId);
    const now = new Date();
    const timezone = await timezoneOf(tx, grant.organizationId);
    const reason = input.reason?.trim() || null;

    const [already] = await tx.select().from(schema.visitChangeRequest)
      .where(and(
        eq(schema.visitChangeRequest.visitId, visit.id),
        eq(schema.visitChangeRequest.status, "pending"),
      )).limit(1);
    if (already && already.kind === input.kind
        && (already.requestedDate ?? null) === (input.requestedDate ?? null)
        && (already.arrivalWindowId ?? null) === (input.arrivalWindowId ?? null)) {
      return shape(already);
    }

    if (!isChangeable(visit, now)) {
      throw new ConflictError(
        "This visit is already under way or done, so it cannot be changed from here. Reply to the message that brought you here.",
      );
    }

    let target: {
      bookableServiceId: string; requestedDate: string; arrivalWindowId: string;
      requestedStart: Date; requestedEnd: Date;
    } | null = null;

    if (input.kind === "cancel") {
      if (!reason) {
        /**
         * A cancellation with no reason is the one the office cannot learn
         * anything from, and the one most likely to be a mistaken tap.
         */
        throw new ConflictError("Tell us why you need to cancel, so the office knows whether to offer another time.");
      }
    } else {
      if (!input.requestedDate || !input.arrivalWindowId) {
        throw new ConflictError("Choose the time you would like instead.");
      }
      const rules = await rulesFor(tx, grant.organizationId, job, postalCode);
      if (!rules.service || rules.blockedBy) throw new ConflictError(rules.blockedBy ?? "This visit cannot be moved online.");
      const slot = (await openSlots(tx, {
        organizationId: grant.organizationId, timezone, service: rules.service,
        from: input.requestedDate, days: 1, exceptVisitId: visit.id,
        member: await memberTest(tx, grant.organizationId, job.customerId, job.propertyId),
      })).find((s) => s.arrivalWindowId === input.arrivalWindowId && s.date === input.requestedDate);
      if (!slot) throw new ConflictError("That time is not open any more. Please choose another.");

      target = {
        bookableServiceId: rules.service.id,
        requestedDate: slot.date,
        arrivalWindowId: slot.arrivalWindowId,
        requestedStart: windowStart(slot.date, slot.startsAt, timezone),
        requestedEnd: windowStart(slot.date, slot.endsAt, timezone),
      };
    }

    const [created] = await refusingDuplicate(
      "visit_change_request_pending_idx",
      "You have already asked about this visit. The office will reply to you, and you can ask again once they have.",
      () => tx.insert(schema.visitChangeRequest).values({
        organizationId: grant.organizationId,
        visitId: visit.id,
        jobId: job.id,
        customerId: job.customerId,
        kind: input.kind,
        reason,
        bookableServiceId: target?.bookableServiceId ?? null,
        requestedDate: target?.requestedDate ?? null,
        arrivalWindowId: target?.arrivalWindowId ?? null,
        requestedStart: target?.requestedStart ?? null,
        requestedEnd: target?.requestedEnd ?? null,
        previousStart: visit.windowStart,
        previousEnd: visit.windowEnd,
      }).returning(),
    );

    const [customer] = await tx.select({ name: schema.customer.name })
      .from(schema.customer).where(eq(schema.customer.id, job.customerId)).limit(1);
    const was = sentenceWindow(visit.windowStart!, visit.windowEnd, timezone);

    /**
     * THE OFFICE QUEUE'S COPY. Raised high, because a customer asking to
     * move tomorrow's visit tonight needs an answer before the van leaves,
     * and due before the visit starts for the same reason.
     */
    const [task] = await tx.insert(schema.task).values({
      organizationId: grant.organizationId,
      title: input.kind === "cancel"
        ? `${customer?.name ?? "A customer"} asks to cancel their visit on ${was}`
        : `${customer?.name ?? "A customer"} asks to move their visit on ${was} to ${sentenceWindow(target!.requestedStart, target!.requestedEnd, timezone)}`,
      body: reason ? `In their words: ${reason}` : null,
      priority: "high",
      entityType: "visit_change_request",
      entityId: created!.id,
      queue: "office",
      dueAt: visit.windowStart,
    }).returning({ id: schema.task.id });

    await tx.update(schema.visitChangeRequest).set({ taskId: task!.id })
      .where(eq(schema.visitChangeRequest.id, created!.id));

    const ctx: ServiceContext = { actor: portalSystem(grant.organizationId), db: tx };
    await emit(tx, ctx, {
      name: "visit.change_requested",
      entityType: "visit_change_request",
      entityId: created!.id,
      payload: {
        request: { id: created!.id, kind: input.kind, visitId: visit.id, jobId: job.id, reason },
        job: { id: job.id, customerId: job.customerId, number: job.number },
        customer: { id: job.customerId },
      },
    });

    /** Named as the holder of the link, which is the whole record of who asked. */
    await audit(tx, portalCtx, "visit_change.requested", "visit_change_request", created!.id, null, {
      kind: input.kind, visitId: visit.id, requestedDate: target?.requestedDate ?? null, ip: meta?.ip ?? null,
    });

    return shape({ ...created!, taskId: task!.id });
  });
}

function shape(row: typeof schema.visitChangeRequest.$inferSelect) {
  return {
    id: row.id,
    visitId: row.visitId,
    jobId: row.jobId,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    requestedDate: row.requestedDate,
    requestedStart: row.requestedStart?.toISOString() ?? null,
    requestedEnd: row.requestedEnd?.toISOString() ?? null,
    previousStart: row.previousStart?.toISOString() ?? null,
    previousEnd: row.previousEnd?.toISOString() ?? null,
    response: row.response,
    notified: row.notified,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------- the office */

export interface ChangeRequestView extends ReturnType<typeof shape> {
  customerId: string;
  customerName: string;
  jobNumber: number;
  jobSummary: string;
  visitStatus: string;
  taskId: string | null;
}

async function viewsWhere(tx: Database, where: ReturnType<typeof and>): Promise<ChangeRequestView[]> {
  const rows = await tx.select({
    request: schema.visitChangeRequest,
    customerName: schema.customer.name,
    jobNumber: schema.job.number,
    jobSummary: schema.job.summary,
    visitStatus: schema.visit.status,
  })
    .from(schema.visitChangeRequest)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.visitChangeRequest.customerId))
    .innerJoin(schema.job, eq(schema.job.id, schema.visitChangeRequest.jobId))
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitChangeRequest.visitId))
    .where(where)
    .orderBy(desc(schema.visitChangeRequest.createdAt))
    .limit(200);
  return rows.map((r) => ({
    ...shape(r.request),
    customerId: r.request.customerId,
    customerName: r.customerName,
    jobNumber: r.jobNumber,
    jobSummary: r.jobSummary,
    visitStatus: r.visitStatus,
    taskId: r.request.taskId,
  }));
}

/** Requests waiting for an answer, oldest visit first is not the order: newest asked first. */
export async function list(
  ctx: ServiceContext,
  input: { status?: "pending" | "approved" | "declined" | "superseded" | undefined; jobId?: string | undefined; ids?: string[] | undefined } = {},
) {
  return guardedRead(ctx, "visit:read", (tx) => viewsWhere(tx, and(
    input.status ? eq(schema.visitChangeRequest.status, input.status) : undefined,
    input.jobId ? eq(schema.visitChangeRequest.jobId, input.jobId) : undefined,
    input.ids ? (input.ids.length ? inArray(schema.visitChangeRequest.id, input.ids) : sql`false`) : undefined,
  )));
}

/**
 * The transport's own permission, added to the decider's, for the reason
 * `invoice-delivery.transportContext` gives: the authority for this act is
 * deciding about the visit, and somebody who may reschedule visits and may not
 * otherwise text customers must still be able to tell this customer the
 * answer to their own question. A revocation of `message:send` still wins.
 */
const transport = (ctx: ServiceContext, tx: Database): ServiceContext => ({
  ...ctx,
  db: tx,
  actor: { ...ctx.actor, grants: [...(ctx.actor.grants ?? []), "message:send"] },
});

/**
 * Tell the customer, by text if they can be texted and by email otherwise,
 * and say which happened. Never throws for a refusal: the decision stands
 * whether or not the customer could be reached, and the screen says which.
 */
async function tell(
  tx: Database, ctx: ServiceContext,
  input: { customerId: string; subject: string; body: string },
): Promise<string> {
  const [customer] = await tx.select({ phone: schema.customer.phone, email: schema.customer.email })
    .from(schema.customer).where(eq(schema.customer.id, input.customerId)).limit(1);
  let outcome = "Not told: no phone number or email address on the customer.";
  if (customer?.phone) {
    const text = await sendTransactional(tx, {
      organizationId: ctx.actor.organizationId, address: customer.phone, body: input.body,
      customerId: input.customerId, sentByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    });
    if (text.sent) return "queued";
    outcome = `Not texted: ${text.explanation}`;
  }
  if (customer?.email) {
    const mail = await email.queue(transport(ctx, tx), {
      to: customer.email, subject: input.subject, text: input.body, customerId: input.customerId,
    });
    if (mail.queued) return "queued";
    outcome = `${customer.phone ? `${outcome} ` : ""}Not emailed: ${mail.explanation}`;
  }
  return outcome;
}

async function pendingFor(tx: Database, id: string) {
  const [row] = await tx.select({ request: schema.visitChangeRequest, visit: schema.visit })
    .from(schema.visitChangeRequest)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitChangeRequest.visitId))
    .where(eq(schema.visitChangeRequest.id, id)).limit(1);
  if (!row) throw new NotFoundError("Request");
  return row;
}

/** Refuses an answer to a request that already has one, in words. */
function assertPending(row: { request: typeof schema.visitChangeRequest.$inferSelect }) {
  if (row.request.status !== "pending") {
    throw new ConflictError(`That request was already ${row.request.status === "superseded" ? "overtaken by a change to the visit" : row.request.status}.`);
  }
}

async function closeTask(tx: Database, ctx: ServiceContext, taskId: string | null, outcome: string) {
  if (!taskId) return;
  await tx.update(schema.task).set({
    status: "done", outcome, completedAt: new Date(),
    completedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    updatedAt: new Date(),
  }).where(and(eq(schema.task.id, taskId), sql`${schema.task.completedAt} is null`));
}

/**
 * Say yes: move the visit, or cancel it, and tell the customer.
 *
 * A MOVED VISIT COMES OFF THE TECHNICIAN'S DAY. Whoever was assigned was
 * assigned to that morning, not to whichever morning the customer picks, and
 * keeping the assignment would put a stop on somebody's route on a day nobody
 * planned it for. It goes back to the board, scheduled at its new time, for
 * the dispatcher to assign. The screen says so before the button is pressed.
 *
 * THE WINDOW IS CHECKED AGAIN, leaving this request out of the count, because
 * another booking may have taken the last place in it since the customer
 * asked. Full means a refusal the office can act on by declining with a
 * suggestion, not a silent overbooking.
 */
export async function approve(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "visit:reschedule", async (tx) => {
    const found = await pendingFor(tx, input.id);
    /**
     * A replayed approval is the approval that already happened, read back,
     * rather than a refusal: the office's tap went through and the response
     * was lost on the way back.
     */
    if (found.request.status === "approved") return { ...shape(found.request), assignmentsRemoved: 0 };
    assertPending(found);
    const { request: req, visit } = found;
    const timezone = await timezoneOf(tx, ctx.actor.organizationId);
    const now = new Date();

    if (!isChangeable(visit, now)) {
      throw new ConflictError(
        `This visit is ${visit.status.replace(/_/g, " ")} now, so it cannot be ${req.kind === "cancel" ? "cancelled" : "moved"} from a request. Decline it and tell the customer why.`,
      );
    }

    let body: string;
    let subject: string;
    let assignmentsRemoved = 0;
    /** Who was on it and when, so the technicians it moves or cancels are told. */
    const before = await sideOf(tx, visit.id);

    if (req.kind === "reschedule") {
      const [service] = req.bookableServiceId
        ? await tx.select().from(schema.bookableService).where(eq(schema.bookableService.id, req.bookableServiceId)).limit(1)
        : [];
      if (!service || !req.requestedDate || !req.arrivalWindowId || !req.requestedStart || !req.requestedEnd) {
        throw new ConflictError("This request no longer names a time that can be booked. Decline it and offer another.");
      }
      const [owner] = await tx.select({ customerId: schema.job.customerId, propertyId: schema.job.propertyId })
        .from(schema.job).where(eq(schema.job.id, visit.jobId)).limit(1);
      const still = (await openSlots(tx, {
        organizationId: ctx.actor.organizationId, timezone, service,
        from: req.requestedDate, days: 1, exceptRequestId: req.id, exceptVisitId: visit.id,
        ...(owner ? { member: await memberTest(tx, ctx.actor.organizationId, owner.customerId, owner.propertyId) } : {}),
      })).some((s) => s.arrivalWindowId === req.arrivalWindowId && s.date === req.requestedDate);
      if (!still) {
        throw new ConflictError("That time has filled up since the customer asked. Decline it and offer them another.");
      }

      const removed = await tx.delete(schema.visitAssignment)
        .where(eq(schema.visitAssignment.visitId, visit.id))
        .returning({ id: schema.visitAssignment.id });
      assignmentsRemoved = removed.length;

      await tx.update(schema.visit).set({
        windowStart: req.requestedStart,
        windowEnd: req.requestedEnd,
        status: "unassigned",
        routeOrder: null,
        updatedAt: now,
      }).where(eq(schema.visit.id, visit.id));

      const when = sentenceWindow(req.requestedStart, req.requestedEnd, timezone);
      await tx.insert(schema.portalEvent).values({
        organizationId: ctx.actor.organizationId,
        customerId: req.customerId,
        jobId: req.jobId,
        kind: "rescheduled",
        headline: "Visit moved, as you asked",
        detail: when,
      });
      subject = "Your visit has been moved";
      body = `Your visit has been moved to ${when}, as you asked. Reply to this message if anything changes.`;
    } else {
      await tx.update(schema.visit).set({ status: "cancelled", routeOrder: null, updatedAt: now })
        .where(eq(schema.visit.id, visit.id));
      const was = sentenceWindow(visit.windowStart!, visit.windowEnd, timezone);
      await tx.insert(schema.portalEvent).values({
        organizationId: ctx.actor.organizationId,
        customerId: req.customerId,
        jobId: req.jobId,
        kind: "cancelled",
        headline: "Visit cancelled, as you asked",
        detail: was,
      });
      subject = "Your visit has been cancelled";
      body = `Your visit on ${was} has been cancelled, as you asked. Reply to this message whenever you would like to book another time.`;
    }

    const notified = await tell(tx, ctx, { customerId: req.customerId, subject, body });

    const [after] = await tx.update(schema.visitChangeRequest).set({
      status: "approved", decidedAt: now, decidedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      notified, updatedAt: now,
    }).where(and(eq(schema.visitChangeRequest.id, req.id), eq(schema.visitChangeRequest.status, "pending")))
      .returning();
    if (!after) throw new ConflictError("Somebody else has just answered this request.");

    if (before) await announce(tx, ctx, visit.id, before);
    await closeTask(tx, ctx, req.taskId, req.kind === "cancel" ? "Cancelled the visit" : "Moved the visit");
    await audit(tx, ctx, req.kind === "cancel" ? "visit.cancelled_on_request" : "visit.moved_on_request",
      "visit", visit.id,
      { windowStart: visit.windowStart, windowEnd: visit.windowEnd, status: visit.status },
      { request: req.id, assignmentsRemoved, notified });

    return { ...shape(after), assignmentsRemoved };
  });
}

/**
 * THE OFFICE MOVED A VISIT TO ANOTHER DAY: THE CUSTOMER IS TOLD.
 *
 * The same telling a customer's own request gets when it is approved: a
 * line on their timeline and a text when they can be texted, an email when
 * they cannot, through the same consent gate, and what became of it kept.
 * Only for a move inside what the customer agreed (a range of days, or the
 * days of the week that suit them), which the caller has checked; the
 * message says so and asks them to reply when it does not suit after all.
 *
 * A request of theirs still waiting on this visit is overtaken by the move,
 * and its task in the office queue is closed with that said, so nobody
 * later approves a move to a day the visit is no longer on.
 *
 * Inside the caller's transaction, after the visit has been written: the
 * window it reads is the new one.
 */
export async function officeMoved(tx: Database, ctx: ServiceContext, input: {
  visitId: string;
  was: { start: Date; end: Date | null };
}): Promise<string> {
  const [row] = await tx.select({ visit: schema.visit, job: schema.job })
    .from(schema.visit).innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .where(eq(schema.visit.id, input.visitId)).limit(1);
  if (!row || !row.visit.windowStart) throw new NotFoundError("Visit");
  const timezone = await timezoneOf(tx, ctx.actor.organizationId);
  const when = sentenceWindow(row.visit.windowStart, row.visit.windowEnd, timezone);
  const was = sentenceWindow(input.was.start, input.was.end, timezone);
  const now = new Date();

  const overtaken = await tx.update(schema.visitChangeRequest).set({
    status: "superseded", decidedAt: now, updatedAt: now,
    decidedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
  }).where(and(eq(schema.visitChangeRequest.visitId, input.visitId), eq(schema.visitChangeRequest.status, "pending")))
    .returning({ id: schema.visitChangeRequest.id, taskId: schema.visitChangeRequest.taskId });
  for (const request of overtaken) await closeTask(tx, ctx, request.taskId, "Overtaken: the office moved the visit");

  await tx.insert(schema.portalEvent).values({
    organizationId: ctx.actor.organizationId,
    customerId: row.job.customerId,
    jobId: row.job.id,
    kind: "rescheduled",
    headline: "Visit moved",
    detail: when,
  });
  const notified = await tell(tx, ctx, {
    customerId: row.job.customerId,
    subject: "Your visit has been moved",
    body: `We have moved your visit from ${was} to ${when}, a day you told us suits you. Reply to this message if it does not.`,
  });
  await audit(tx, ctx, "visit.moved_by_office", "visit", input.visitId,
    { windowStart: input.was.start, windowEnd: input.was.end },
    { windowStart: row.visit.windowStart, windowEnd: row.visit.windowEnd, notified, overtaken: overtaken.map((r) => r.id) });
  return notified;
}

/**
 * Say no, with words the customer will read.
 *
 * The visit stays where it was. The reply is sent as written, so the screen
 * asks for something a customer can act on: "we are full that week, could you
 * do the Monday" rather than a reason code.
 */
export async function decline(ctx: ServiceContext, input: { id: string; response?: string | undefined }) {
  return guardedWrite(ctx, "visit:reschedule", async (tx) => {
    const found = await pendingFor(tx, input.id);
    if (found.request.status === "declined") return shape(found.request);
    assertPending(found);
    const { request: req, visit } = found;
    const timezone = await timezoneOf(tx, ctx.actor.organizationId);
    const response = input.response?.trim() || null;
    const now = new Date();
    const was = visit.windowStart ? sentenceWindow(visit.windowStart, visit.windowEnd, timezone) : "the day we agreed";

    const body = req.kind === "cancel"
      ? `We have not cancelled your visit on ${was}${response ? `: ${response}` : "."} Reply to this message to talk it through.`
      : `We could not move your visit, so it stays on ${was}${response ? `. ${response}` : "."} Reply to this message to find another time.`;

    const notified = await tell(tx, ctx, {
      customerId: req.customerId,
      subject: req.kind === "cancel" ? "About cancelling your visit" : "About moving your visit",
      body,
    });

    const [after] = await tx.update(schema.visitChangeRequest).set({
      status: "declined", decidedAt: now, decidedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      response, notified, updatedAt: now,
    }).where(and(eq(schema.visitChangeRequest.id, req.id), eq(schema.visitChangeRequest.status, "pending")))
      .returning();
    if (!after) throw new ConflictError("Somebody else has just answered this request.");

    await closeTask(tx, ctx, req.taskId, "Declined the request");
    await audit(tx, ctx, "visit_change.declined", "visit_change_request", req.id, req, after);
    return shape(after);
  });
}

export const handlers = {
  getPortalVisitChange: (db: Database, input: { token: string; visitId?: string | undefined; from?: string | undefined; days?: number | undefined }) =>
    options(db, input),
  requestPortalVisitChange: (
    db: Database,
    input: {
      token: string; visitId?: string | undefined; kind: "reschedule" | "cancel";
      requestedDate?: string | undefined; arrivalWindowId?: string | undefined; reason?: string | undefined;
    },
    meta?: RequestMeta,
  ) => request(db, input, meta),
  listVisitChangeRequests: async (ctx: ServiceContext, input: {
    status?: "pending" | "approved" | "declined" | "superseded" | undefined; jobId?: string | undefined;
  }) => ({ requests: await list(ctx, input) }),
  approveVisitChangeRequest: (ctx: ServiceContext, input: { id: string }) => approve(ctx, input),
  declineVisitChangeRequest: (ctx: ServiceContext, input: { id: string; response?: string | undefined }) =>
    decline(ctx, input),
} as const;
