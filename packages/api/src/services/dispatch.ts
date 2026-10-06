import { and, eq, gte, lte, inArray, asc, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, NotFoundError, ConflictError, timezoneOf, audit, scopeOf,
} from "./context";
import { jobVisibility, technicianScopeFilter } from "./scope";
import { dispatchPeople } from "./people-scope";
import { shopOfPeople } from "./visit-shop";
import { announce, sideOf } from "./visit-notices";
import { inForceAt } from "./pricebook";
import { renderWithin } from "./message-templates";
import { can, money as m, time } from "@opentradesos/core";
import { sendTransactional } from "./comms-send";
import type {
  getDispatchBoard, assignVisit, reorderRoute, sendArrivalNotice, getFieldSnapshot, VisitForField,
} from "../contracts/field";
import { templateFor } from "./field";
import { portalBase } from "../lib/portal-base";
import { gate as qualificationGate, requiredSkillsOf } from "./qualification";
import { priorityWithin } from "./agreements";
import * as location from "./location";
import * as fieldSales from "./field-sales";
import * as safetyTalks from "./safety-talks";


/**
 * THE BOARD
 *
 * One query for a whole day across every technician, because that is the
 * screen. A dispatcher is not looking at a visit, they are looking for the gap
 * and the thing that is late, and both of those are properties of the day
 * rather than of any row in it.
 */
export async function board(ctx: ServiceContext, input: z.infer<typeof getDispatchBoard.input>) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    /**
     * Bounded in the COMPANY's zone. `new Date(`${date}T00:00:00Z`)` reads as
     * midnight on that day and means midnight in London: for a shop in Austin
     * that window ran from seven the previous evening to seven that evening,
     * so an emergency booked for nine at night was not on today's board and
     * the evening before was, all day. It shipped, and it is visible in the
     * marketing screenshot as an unassigned column the caption describes and
     * the picture does not contain.
     */
    const { start: dayStart, end: dayEnd } =
      time.dayBoundsIn(input.date, await timezoneOf(tx, ctx.actor.organizationId));
    const now = new Date();

    /**
     * SCOPED LIKE EVERY OTHER READ OF WORK. A branch manager's board is their
     * branch's: its jobs' visits, its people's columns, and anybody else only
     * where they are on one of those visits. A scope this cannot satisfy shows
     * an empty board rather than the company's (`services/scope.ts`).
     */
    const scope = scopeOf(ctx, "visit");
    const people = technicianScopeFilter(scope, ctx.actor);
    const technicians = await tx.select({
      id: schema.technician.id,
      displayName: schema.technician.displayName,
      color: schema.technician.color,
      inScope: people ? sql<boolean>`${people}` : sql<boolean>`true`,
    }).from(schema.technician)
      .where(and(
        eq(schema.technician.organizationId, ctx.actor.organizationId),
        eq(schema.technician.active, true),
      ))
      .orderBy(asc(schema.technician.displayName));

    const rows = await tx.select({
      visit: schema.visit,
      jobNumber: schema.job.number,
      summary: schema.job.summary,
      customerName: schema.customer.name,
      customerId: schema.job.customerId,
      propertyId: schema.job.propertyId,
      addressLine1: schema.property.addressLine1,
      postalCode: schema.property.postalCode,
      technicianId: schema.visitAssignment.technicianId,
      routeName: schema.route.name,
    })
      .from(schema.visit)
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
      .leftJoin(schema.visitAssignment, eq(schema.visitAssignment.visitId, schema.visit.id))
      .leftJoin(schema.route, eq(schema.route.id, schema.visit.routeId))
      .where(and(
        gte(schema.visit.windowStart, dayStart),
        lte(schema.visit.windowStart, dayEnd),
        input.businessUnitId ? eq(schema.job.businessUnitId, input.businessUnitId) : undefined,
        // Territory is a property of the job, not of the visit: every visit on
        // a job is at the same address.
        input.territoryId ? eq(schema.job.territoryId, input.territoryId) : undefined,
        jobVisibility(scope, ctx.actor, sql`${schema.job.id}`),
      ))
      .orderBy(asc(schema.visit.routeOrder), asc(schema.visit.windowStart));

    /** The people on the board: those in scope, and anybody on a visit this person can see. */
    const onVisibleWork = new Set(rows.map((r) => r.technicianId).filter((id): id is string => id !== null));
    const shown = technicians.filter((t) => t.inScope || onVisibleWork.has(t.id));
    const shownIds = new Set(shown.map((t) => t.id));

    /**
     * Approved time off, so an empty column says why it is empty. A board that
     * shows a blank day for somebody on holiday invites a dispatcher to fill
     * it, and they will.
     */
    const off = await tx.select({ technicianId: schema.timeOff.technicianId })
      .from(schema.timeOff)
      .where(and(
        eq(schema.timeOff.organizationId, ctx.actor.organizationId),
        eq(schema.timeOff.approved, true),
        lte(schema.timeOff.startsAt, dayEnd),
        gte(schema.timeOff.endsAt, dayStart),
      ));
    const offToday = new Set(off.map((o) => o.technicianId));

    /**
     * Late is computed once here rather than by every client that renders a
     * board. Two clients computing it differently is how a dispatcher and a
     * manager end up arguing about which jobs are behind.
     */
    const isLate = (v: typeof schema.visit.$inferSelect) =>
      Boolean(
        v.windowEnd &&
        v.windowEnd < now &&
        !["completed", "cancelled", "no_show", "completed_after_cancellation"].includes(v.status),
      );

    const shape = (r: (typeof rows)[number]) => ({
      id: r.visit.id,
      jobNumber: r.jobNumber,
      summary: r.summary,
      status: r.visit.status,
      windowStart: r.visit.windowStart?.toISOString() ?? null,
      windowEnd: r.visit.windowEnd?.toISOString() ?? null,
      routeOrder: r.visit.routeOrder,
      estimatedDurationMinutes: r.visit.estimatedDurationMinutes,
      customerName: r.customerName,
      addressLine1: r.addressLine1,
      isLate: isLate(r.visit),
      routeName: r.routeName ?? null,
      locked: r.visit.dispatchLocked,
    });

    const assigned = new Map<string, ReturnType<typeof shape>[]>();
    const unassigned: Array<ReturnType<typeof shape> & { postalCode: string }> = [];
    /**
     * CREW WORK IS NOT UNASSIGNED. A visit sent to a crew is on
     * `visit.crew_id` with nobody in `visit_assignment`, and the board used to
     * file it in the unassigned pile, where a dispatcher would give it to
     * somebody else. It has its own lane now.
     */
    const byCrew = new Map<string, ReturnType<typeof shape>[]>();

    for (const r of rows) {
      if (r.technicianId) {
        assigned.set(r.technicianId, [...(assigned.get(r.technicianId) ?? []), shape(r)]);
      } else if (r.visit.crewId) {
        byCrew.set(r.visit.crewId, [...(byCrew.get(r.visit.crewId) ?? []), shape(r)]);
      } else {
        unassigned.push({ ...shape(r), postalCode: r.postalCode });
      }
    }

    /**
     * MEMBERS WHOSE PLAN PROMISED PRIORITY GO TO THE TOP OF THE PILE.
     *
     * `priority_dispatch` sat on the plan from the first migration, sold to
     * customers as "members are seen first", and the board never read it, so
     * the promise was kept only when a dispatcher happened to remember who
     * was on which plan. Sorting the unassigned pile is the whole of it: the
     * pile is what a dispatcher works down, and the first card is the one
     * that gets the next free technician. Nothing is moved, booked or
     * reassigned for them, and the order within each half is the order it
     * already had.
     *
     * Whether the plan covers this job is the same rule the member discount
     * uses (active on the day, at this address or sold with none), in core.
     */
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const byVisit = new Map(rows.map((r) => [r.visit.id, r]));
    const priority = await priorityWithin(tx, unassigned.map((v) => {
      const row = byVisit.get(v.id)!;
      return {
        key: v.id,
        customerId: row.customerId,
        propertyId: row.propertyId,
        on: row.visit.windowStart ? time.dateIn(row.visit.windowStart, zone) : input.date,
      };
    }));
    const ranked = unassigned
      .map((v, index) => ({ v, index, plan: priority.get(v.id) ?? null }))
      .sort((a, b) => Number(b.plan !== null) - Number(a.plan !== null) || a.index - b.index);

    /** The crews with work today, their people, and who leads. */
    const crewIds = [...byCrew.keys()];
    const crewRows = crewIds.length === 0 ? [] : await tx.select({
      id: schema.crew.id, name: schema.crew.name, color: schema.crew.color,
    }).from(schema.crew).where(inArray(schema.crew.id, crewIds)).orderBy(asc(schema.crew.name));
    const crewPeople = crewIds.length === 0 ? [] : await tx.select({
      crewId: schema.crewMember.crewId, isLead: schema.crewMember.isLead, name: schema.technician.displayName,
    }).from(schema.crewMember)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
      .where(inArray(schema.crewMember.crewId, crewIds));

    /**
     * The route businesses' days: every route with stops today, how many,
     * and whose they are, so a pool company watching the board sees its
     * Tuesday routes rather than forty unrelated cards.
     */
    const routeStops = new Map<string, { name: string; stops: number; done: number }>();
    for (const r of rows) {
      if (!r.visit.routeId || !r.routeName) continue;
      const entry = routeStops.get(r.visit.routeId) ?? { name: r.routeName, stops: 0, done: 0 };
      entry.stops += 1;
      if (["completed", "completed_after_cancellation"].includes(r.visit.status)) entry.done += 1;
      routeStops.set(r.visit.routeId, entry);
    }
    const routeOwners = routeStops.size === 0 ? [] : await tx.select({
      id: schema.route.id, technicianName: schema.technician.displayName, crewName: schema.crew.name,
    }).from(schema.route)
      .leftJoin(schema.technician, eq(schema.technician.id, schema.route.technicianId))
      .leftJoin(schema.crew, eq(schema.crew.id, schema.route.crewId))
      .where(inArray(schema.route.id, [...routeStops.keys()]));

    /**
     * The rota for the day: every on call shift that overlaps it, so the
     * board says who has the phone tonight, and says so in words when
     * nobody does.
     */
    const rota = await tx.select({
      technicianId: schema.onCallRotation.technicianId,
      technicianName: schema.technician.displayName,
      startsAt: schema.onCallRotation.startsAt,
      endsAt: schema.onCallRotation.endsAt,
    }).from(schema.onCallRotation)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.onCallRotation.technicianId))
      .where(and(
        eq(schema.onCallRotation.organizationId, ctx.actor.organizationId),
        lte(schema.onCallRotation.startsAt, dayEnd),
        gte(schema.onCallRotation.endsAt, dayStart),
      ))
      .orderBy(asc(schema.onCallRotation.startsAt));

    return {
      date: input.date,
      crews: crewRows.map((c) => {
        const people = crewPeople.filter((p) => p.crewId === c.id);
        return {
          id: c.id,
          name: c.name,
          color: c.color,
          leadName: people.find((p) => p.isLead)?.name ?? null,
          memberNames: people.map((p) => p.name).sort(),
          visits: byCrew.get(c.id) ?? [],
        };
      }),
      routes: [...routeStops.entries()].map(([id, r]) => {
        const owner = routeOwners.find((o) => o.id === id);
        return { id, name: r.name, stops: r.stops, done: r.done, runBy: owner?.technicianName ?? owner?.crewName ?? null };
      }).sort((a, b) => a.name.localeCompare(b.name)),
      onCall: rota.filter((r) => shownIds.has(r.technicianId)).map((r) => ({
        technicianName: r.technicianName, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(),
      })),
      technicians: shown.map((t) => ({
        id: t.id,
        displayName: t.displayName,
        color: t.color,
        timeOff: offToday.has(t.id),
        inScope: Boolean(t.inScope),
        visits: assigned.get(t.id) ?? [],
      })),
      unassigned: ranked.map(({ v: { isLate: _late, ...rest }, plan }) => ({ ...rest, priorityPlan: plan })),
    };
  });
}

/**
 * Putting a visit on somebody's day.
 *
 * Replaces the whole assignment rather than adding to it, because the board's
 * gesture is "these people, on this job" and an add-only endpoint makes
 * removing somebody a second call that is easy to forget.
 */
export async function assign(ctx: ServiceContext, input: z.infer<typeof assignVisit.input>) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    /**
     * Only a visit this person can see on their board. Another branch's
     * visit reads as not found, for the reason the job page gives: "you may
     * not" confirms there is something there.
     */
    const [visit] = await tx.select().from(schema.visit)
      .where(and(
        eq(schema.visit.id, input.id),
        jobVisibility(scopeOf(ctx, "visit"), ctx.actor, sql`${schema.visit.jobId}`),
      )).limit(1);
    if (!visit) throw new NotFoundError("Visit");

    if (["completed", "cancelled", "completed_after_cancellation"].includes(visit.status)) {
      throw new ConflictError(`This visit is ${visit.status} and cannot be reassigned.`);
    }

    /** Who was on it before, so the people added and the people taken off each hear about it. */
    const before = (await sideOf(tx, input.id))!;

    const people = dispatchPeople(ctx);
    const technicians = await tx.select({
      id: schema.technician.id,
      inScope: people ? sql<boolean>`${people}` : sql<boolean>`true`,
    })
      .from(schema.technician)
      .where(and(
        eq(schema.technician.organizationId, ctx.actor.organizationId),
        inArray(schema.technician.id, input.technicianIds),
        eq(schema.technician.active, true),
      ));

    if (technicians.length !== input.technicianIds.length) {
      throw new ConflictError(
        "One of those technicians is not active in this company.",
      );
    }

    /**
     * ONLY THIS PERSON'S OWN PEOPLE, plus whoever is already on the visit.
     * A branch manager whose board shows Sam from Austin on one Houston job
     * may move that job's time or add Ray beside him, and may not put Sam on
     * a second one: filling an Austin person's day is Austin's call. Refused
     * in the same words as an id that is not there, so the answer does not
     * say who exists in another branch.
     */
    const already = new Set(before.technicianIds);
    if (technicians.some((t) => !t.inScope && !already.has(t.id))) {
      throw new ConflictError("One of those technicians is not active in this company.");
    }

    /**
     * QUALIFIED FOR THE WORK, ONE PERSON AT A TIME.
     *
     * The job type's required skills were checked for a crew and never for
     * a technician, so the commonest way work goes out had no check at all.
     * Refused here with a sentence naming the person and the skill, and the
     * board shows that sentence where the card was dropped. Overriding needs
     * its own permission and a reason, and the audit entry below keeps both
     * beside what was refused.
     */
    const work = await requiredSkillsOf(tx, input.id);
    const qualified = await qualificationGate(ctx, tx, {
      technicianIds: input.technicianIds,
      skills: work.skills,
      windowStart: work.windowStart,
      windowEnd: work.windowEnd,
      override: input.overrideQualification,
    });

    await tx.delete(schema.visitAssignment)
      .where(eq(schema.visitAssignment.visitId, input.id));

    await tx.insert(schema.visitAssignment).values(
      input.technicianIds.map((technicianId) => ({
        organizationId: ctx.actor.organizationId,
        visitId: input.id,
        technicianId,
        isLead: technicianId === (input.leadTechnicianId ?? input.technicianIds[0]),
      })),
    );

    /**
     * Assigning moves an unassigned visit to dispatched. It does not touch a
     * visit that is already moving: a technician who is en route stays en
     * route when the office adds a second person to the job.
     */
    const status = ["unassigned", "scheduled"].includes(visit.status)
      ? "dispatched" as const
      : visit.status;

    /**
     * PEOPLE TAKE OVER FROM A CREW. A crew card dropped on a person on the
     * board hands the visit to that person: it comes off the crew's lane
     * and onto their day, and the crew's members hear it is no longer
     * theirs. A visit carries a crew or people, never both, so leaving the
     * crew on it would send two vans.
     */
    await tx.update(schema.visit).set({
      status,
      crewId: null,
      /** The shop of whoever now has it (`visit-shop.ts`). */
      locationId: await shopOfPeople(tx, input.technicianIds, input.leadTechnicianId),
      dispatchedAt: visit.dispatchedAt ?? new Date(),
      ...(input.routeOrder !== undefined ? { routeOrder: input.routeOrder } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.visit.id, input.id));

    await audit(tx, ctx, "visit.assigned", "visit", input.id,
      { status: visit.status, crewId: visit.crewId }, { status, technicianIds: input.technicianIds });
    await announce(tx, ctx, input.id, before);

    if (qualified.overridden) {
      await audit(tx, ctx, "visit.assigned_unqualified", "visit", input.id,
        { refusals: qualified.refusals },
        { technicianIds: input.technicianIds, reason: input.overrideQualification!.reason });
    }

    return { ok: true as const, status, overridden: qualified.overridden, unknownSkills: qualified.unknown };
  });
}

/**
 * The order of somebody's day, set in one call.
 *
 * A board reorders by drag, which moves one card and renumbers everything
 * after it. Sent as a list rather than a sequence of moves so the server never
 * holds a half-renumbered day, which is what produces two stops numbered four
 * and a technician driving the wrong way across a county.
 */
export async function reorder(ctx: ServiceContext, input: z.infer<typeof reorderRoute.input>) {
  return guardedWrite(ctx, "visit:reschedule", async (tx) => {
    /**
     * The same local day the board drew. Bounding it in UTC here was worse
     * than on the board: a visit the dispatcher could see and drag fell
     * outside the window, so the reorder came back refusing a visit as
     * somebody else's.
     */
    const { start: dayStart, end: dayEnd } =
      time.dayBoundsIn(input.date, await timezoneOf(tx, ctx.actor.organizationId));

    /**
     * Somebody this person dispatches. Another branch's person on one of
     * this branch's visits keeps the order their own branch gave their day.
     */
    const [own] = await tx.select({ id: schema.technician.id }).from(schema.technician)
      .where(and(
        eq(schema.technician.id, input.technicianId),
        eq(schema.technician.organizationId, ctx.actor.organizationId),
        dispatchPeople(ctx),
      )).limit(1);
    if (!own) throw new NotFoundError("Technician");

    const theirs = await tx.select({ visitId: schema.visitAssignment.visitId })
      .from(schema.visitAssignment)
      .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
      .where(and(
        eq(schema.visitAssignment.organizationId, ctx.actor.organizationId),
        eq(schema.visitAssignment.technicianId, input.technicianId),
        gte(schema.visit.windowStart, dayStart),
        lte(schema.visit.windowStart, dayEnd),
      ));

    const theirIds = new Set(theirs.map((t) => t.visitId));
    const foreign = input.visitIds.filter((id) => !theirIds.has(id));

    if (foreign.length > 0) {
      // Reordering somebody else's day through this endpoint would silently
      // renumber a route nobody was looking at.
      throw new ConflictError(
        `${foreign.length} of those visits are not on this technician's day.`,
      );
    }

    for (const [index, visitId] of input.visitIds.entries()) {
      await tx.update(schema.visit)
        .set({ routeOrder: index + 1, updatedAt: new Date() })
        .where(eq(schema.visit.id, visitId));
    }

    await audit(tx, ctx, "dispatch.reordered", "technician", input.technicianId, null,
      { date: input.date, count: input.visitIds.length });

    return { ok: true as const, ordered: input.visitIds.length };
  });
}

/**
 * On my way.
 *
 * Recorded as its own row rather than a flag, because a company that sends two
 * has a problem worth seeing, and because the question worth asking later is
 * how long before arrival it actually went out. A boolean answers neither.
 *
 * THE BUG THIS FIXES. The first version of this function wrote the notice row,
 * wrote a portal event, minted a tracking grant, and returned ok. It did not
 * send anything. The button in the van reads "Text the customer I am on my
 * way", and nothing was ever texted: the row recorded a message that had never
 * existed, and the `failed_reason` column beside it was written by nothing, so
 * the retry guard that skips notices with a reason could never skip one. A
 * dispatcher reading the notice stops phoning the customer. That is the worst
 * shape a defect can take here, because the record actively argues against
 * anybody noticing it.
 *
 * It now goes through `sendTransactional`, which is the same consent gate the
 * inbox uses. A technician tapping this is not an exemption from a STOP.
 */
export async function onMyWay(ctx: ServiceContext, input: z.infer<typeof sendArrivalNotice.input>) {
  return guardedWrite(ctx, "message:send", async (tx) => {
    const [visit] = await tx.select({
      id: schema.visit.id,
      jobId: schema.visit.jobId,
      status: schema.visit.status,
    }).from(schema.visit).where(eq(schema.visit.id, input.id)).limit(1);
    if (!visit) throw new NotFoundError("Visit");

    const [job] = await tx.select({
      customerId: schema.job.customerId,
      propertyId: schema.job.propertyId,
      number: schema.job.number,
    }).from(schema.job).where(eq(schema.job.id, visit.jobId)).limit(1);
    if (!job) throw new NotFoundError("Job");

    // A retry from a van with one bar must not send a second message. The
    // customer reads both. A notice that failed is not a send, so it does not
    // block one: that is what the `failed_reason` test means.
    const [already] = await tx.select({ id: schema.arrivalNotice.id })
      .from(schema.arrivalNotice)
      .where(and(
        eq(schema.arrivalNotice.visitId, input.id),
        isNull(schema.arrivalNotice.failedReason),
      )).limit(1);

    if (already) {
      /**
       * No tracking link on a repeat, and that is not an oversight.
       *
       * The token is stored hashed, which is the whole point of storing it
       * that way, so the link handed out the first time cannot be recovered
       * and handed out again. Minting a second grant for the same job would
       * leave two live links to one property, and the first version of this
       * branch pretended to choose between them with a ternary whose two
       * arms were both null.
       */
      return {
        ok: true as const, sent: false, alreadySent: true,
        trackingUrl: null, reason: "They have already been told you are on the way.",
      };
    }

    const address = await notifiableAddress(tx, job.customerId, job.propertyId);

    let trackingUrl: string | null = null;
    if (input.includeTracking && address) {
      const token = randomBytes(32).toString("base64url");
      await tx.insert(schema.portalGrant).values({
        organizationId: ctx.actor.organizationId,
        customerId: job.customerId,
        scope: "job",
        subjectId: visit.jobId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        // Long enough to cover the visit and a few days of looking back at the
        // service report, short enough that a forwarded link does not live on.
        expiresAt: new Date(Date.now() + 30 * 864e5),
      });
      trackingUrl = `${portalBase()}/j/${token}`;
    }

    const outcome = address
      ? await sendTransactional(tx, {
          organizationId: ctx.actor.organizationId,
          address,
          customerId: job.customerId,
          sentByUserId: ctx.actor.userId,
          body: await arrivalBody(tx, ctx.actor.organizationId, {
            company: await companyName(tx, ctx.actor.organizationId),
            technician: await technicianFirstName(tx, ctx, input.id),
            etaMinutes: input.etaMinutes ?? null,
            trackingUrl,
          }),
        })
      : {
          sent: false as const, reason: "no_address",
          explanation: "No phone number on this customer or property.",
        };

    await tx.insert(schema.arrivalNotice).values({
      organizationId: ctx.actor.organizationId,
      visitId: input.id,
      channel: input.channel,
      etaMinutes: input.etaMinutes ?? null,
      includesTracking: input.includeTracking && outcome.sent,
      messageId: outcome.sent ? outcome.messageId : null,
      failedReason: outcome.sent ? null : outcome.reason,
    });

    /**
     * The portal event regardless.
     *
     * Somebody who cannot be texted may still have the portal open, and the
     * timeline there is a record of what happened on the job rather than a
     * record of what we managed to deliver.
     */
    await tx.insert(schema.portalEvent).values({
      organizationId: ctx.actor.organizationId,
      customerId: job.customerId,
      jobId: visit.jobId,
      kind: "on_the_way",
      headline: "Your technician is on the way",
      detail: input.etaMinutes ? `About ${input.etaMinutes} minutes away` : null,
    });

    return {
      ok: true as const,
      sent: outcome.sent,
      alreadySent: false,
      trackingUrl: outcome.sent ? trackingUrl : null,
      reason: outcome.sent ? null : outcome.explanation,
    };
  });
}

/**
 * Who to text, and in what order.
 *
 * The contact on the PROPERTY first. On a rental the customer is the landlord
 * and the person who opens the door is the tenant, and texting the landlord
 * that somebody is fifteen minutes away helps nobody standing outside a house.
 * Then the customer's own primary contact, then the number on the customer
 * record, which is what a one person household has.
 */
async function notifiableAddress(
  tx: Database, customerId: string, propertyId: string,
): Promise<string | null> {
  const contacts = await tx.select({
    phone: schema.contact.phone,
    propertyId: schema.contact.propertyId,
    isPrimary: schema.contact.isPrimary,
    preferredChannel: schema.contact.preferredChannel,
  }).from(schema.contact)
    .where(and(
      isNull(schema.contact.deletedAt),
      or(
        eq(schema.contact.propertyId, propertyId),
        eq(schema.contact.customerId, customerId),
      ),
    ));

  const reachable = contacts.filter((c) => (c.phone ?? "").trim() !== "");

  /**
   * Ranked rather than filtered.
   *
   * A contact who prefers email is still worth texting when they are the only
   * person attached to the property: the alternative is a technician arriving
   * at a door nobody knew about. Preference decides the order, not whether
   * somebody hears from us at all.
   */
  const rank = (c: typeof reachable[number]): number =>
    (c.propertyId === propertyId ? 0 : 4)
    + (c.isPrimary ? 0 : 2)
    + (c.preferredChannel === "sms" ? 0 : 1);

  const best = reachable.slice().sort((a, b) => rank(a) - rank(b))[0];
  if (best?.phone) return best.phone.trim();

  const [customer] = await tx.select({ phone: schema.customer.phone })
    .from(schema.customer).where(eq(schema.customer.id, customerId)).limit(1);
  const fallback = (customer?.phone ?? "").trim();
  return fallback === "" ? null : fallback;
}

/**
 * The first name the customer is told to expect at the door: the lead on the
 * visit, or failing that whoever is sending it, if they are a technician here.
 * A first name only, the same rule the tracking page keeps, because a last
 * name is not the customer's to have.
 */
async function technicianFirstName(tx: Database, ctx: ServiceContext, visitId: string): Promise<string | null> {
  const [lead] = await tx.select({ name: schema.technician.displayName })
    .from(schema.visitAssignment)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(eq(schema.visitAssignment.visitId, visitId))
    .orderBy(sql`${schema.visitAssignment.isLead} desc`).limit(1);
  let name = lead?.name ?? null;
  if (!name) {
    const [own] = await tx.select({ name: schema.technician.displayName })
      .from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(and(
        eq(schema.technician.organizationId, ctx.actor.organizationId),
        eq(schema.membership.userId, ctx.actor.userId),
      )).limit(1);
    name = own?.name ?? null;
  }
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return first === "" ? null : first;
}

/** The name the text signs off with. */
async function companyName(tx: Database, organizationId: string): Promise<string> {
  const [org] = await tx.select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId)).limit(1);
  return org?.name ?? "Your technician";
}

/**
 * What the customer reads.
 *
 * No em dash, no "Hi {first_name}," with nothing behind it, and the tracking
 * link last because that is where a thumb goes. The ETA is omitted rather than
 * guessed when the phone did not supply one: "about null minutes" has shipped
 * in this industry more than once.
 */
/**
 * THE COMPANY'S OWN WORDING IF THEY HAVE WRITTEN ONE, otherwise ours.
 *
 * `noticeBody` below is the wording this product ships with, and it was the
 * only wording there was: a string literal in a service, which meant a
 * company that calls their people engineers rather than technicians, or whose
 * notice runs a line too long for a lock screen, needed a pull request to
 * change the one message their customers read most often.
 *
 * The fallback is not a convenience, it is the reason this is safe to add.
 * Every company already using this has no template, gets exactly the sentence
 * they got yesterday, and nothing about their Tuesday changes.
 *
 * A template that renders with gaps STILL SENDS. The person waiting on this
 * is a technician in a driveway, and refusing to tell a customer the van is
 * coming because a template references something this particular job has
 * nothing for is a worse outcome than a sentence with a gap in it.
 */
async function arrivalBody(
  tx: Database,
  organizationId: string,
  input: { company: string; technician: string | null; etaMinutes: number | null; trackingUrl: string | null },
): Promise<string> {
  const rendered = await renderWithin(tx, organizationId, "arrival_notice", {
    company: input.company,
    technician: input.technician,
    eta: input.etaMinutes === null ? "on the way" : `about ${input.etaMinutes} minutes away`,
    etaMinutes: input.etaMinutes,
    trackingUrl: input.trackingUrl,
  });
  return rendered?.body.trim() ? rendered.body : noticeBody(input);
}

function noticeBody(input: {
  company: string; technician: string | null; etaMinutes: number | null; trackingUrl: string | null;
}): string {
  const eta = input.etaMinutes
    ? `about ${input.etaMinutes} minutes away`
    : "on the way";
  const who = input.technician ? `your technician, ${input.technician},` : "your technician";
  const line = `${input.company}: ${who} is ${eta}.`;
  return input.trackingUrl ? `${line} See where they are: ${input.trackingUrl}` : line;
}

/**
 * Everything the phone needs to work without a network.
 *
 * A whole slice in one response rather than a set of endpoints the client
 * stitches together. A phone that makes six calls to show a job will show it
 * six times slower on the connection this exists for, and will show half of
 * one when the third call fails.
 */
export async function snapshot(ctx: ServiceContext, input: z.infer<typeof getFieldSnapshot.input>) {
  return guardedRead(ctx, "field:sync", async (tx) => {
    const [device] = await tx.select().from(schema.device)
      .where(eq(schema.device.id, input.deviceId)).limit(1);
    if (!device) throw new NotFoundError("Device");

    // Whole local days, for the same reason the board is. A phone syncing
    // "today and tomorrow" at eight in the evening was being handed a window
    // that had already ended.
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const { start: from, end: to } = time.daysFrom(input.from, input.days, zone);

    const rows = await tx.select({
      visit: schema.visit,
      jobId: schema.job.id,
      jobNumber: schema.job.number,
      jobTypeId: schema.job.jobTypeId,
      summary: schema.job.summary,
      description: schema.job.description,
      customerComplaint: schema.job.customerComplaint,
      customerId: schema.customer.id,
      customerName: schema.customer.name,
      customerPhone: schema.customer.phone,
      property: schema.property,
    })
      .from(schema.visit)
      .innerJoin(schema.visitAssignment, eq(schema.visitAssignment.visitId, schema.visit.id))
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
      .where(and(
        eq(schema.visitAssignment.technicianId, device.technicianId),
        gte(schema.visit.windowStart, from),
        lte(schema.visit.windowStart, to),
      ))
      .orderBy(asc(schema.visit.routeOrder), asc(schema.visit.windowStart));

    /**
     * The revision is what makes a poll cheap. A phone on a bad connection
     * asks "is there anything new" far more often than it asks for the data,
     * and comparing one integer beats diffing a day of visits.
     */
    const revision = (await computeRevision(
      tx, rows.map((r) => r.visit.id), rows.map((r) => r.jobId), rows.map((r) => r.customerId),
    )) + await fieldSales.expensesRevision(tx, device.technicianId);

    if (input.sinceRevision !== undefined && input.sinceRevision === revision) {
      return {
        revision, unchanged: true, visits: [], priceBook: [], openTimeEntry: null, inspectionPrograms: [],
        locationSharing: await location.forDevice(tx, ctx.actor.organizationId, device.technicianId),
        tasks: [], talks: [], abilities: await fieldSales.abilitiesFor(tx, ctx), expenses: [],
      };
    }

    const book = await tx.select({
      id: schema.priceBookItem.id,
      versionId: schema.priceBookItemVersion.id,
      code: schema.priceBookItem.code,
      name: schema.priceBookItemVersion.name,
      unitPrice: schema.priceBookItemVersion.price,
      taxable: schema.priceBookItemVersion.taxable,
      description: schema.priceBookItemVersion.description,
      kind: schema.priceBookItem.kind,
      feeRole: schema.priceBookItem.feeRole,
      components: schema.priceBookItemVersion.components,
    })
      .from(schema.priceBookItemVersion)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
      .where(and(
        eq(schema.priceBookItemVersion.organizationId, ctx.actor.organizationId),
        /**
           * The version IN FORCE, not the open ended one. `isNull(effectiveTo)`
           * picks a revision dated ahead, so a price increase scheduled for
           * next month applied today and the price actually in force became
           * invisible. The reasoning is on `inForceAt`.
           */
          inForceAt(),
        /** Only what can still be sold: a retired item is history, not a choice. */
        eq(schema.priceBookItem.active, true),
      ))
      .limit(2000);
    /**
     * A kit is one line at its own price, and the technician says what it
     * covers, so each one carries its parts by name.
     */
    const bookNames = new Map(book.map((item) => [item.id, item.name]));
    const priceBook = book.map(({ components, ...item }) => ({
      ...item,
      components: components.map((c) => ({ name: bookNames.get(c.itemId) ?? "A part", quantity: c.quantity })),
    }));

    // Somebody always forgets to clock out, and the phone needs to know it is
    // still on the clock before it offers to punch in again.
    const [open] = await tx.select({
      id: schema.timeclockEntry.id,
      kind: schema.timeclockEntry.kind,
      startedAt: schema.timeclockEntry.startedAt,
    }).from(schema.timeclockEntry)
      .where(and(
        eq(schema.timeclockEntry.technicianId, device.technicianId),
        isNull(schema.timeclockEntry.endedAt),
      ))
      .orderBy(asc(schema.timeclockEntry.startedAt)).limit(1);

    const extras = await visitExtras(tx, ctx, rows.map((r) => ({
      visitId: r.visit.id, jobId: r.jobId, jobTypeId: r.jobTypeId,
    })));
    const sales = await fieldSales.salesFor(tx, ctx, rows.map((r) => ({
      visitId: r.visit.id, jobId: r.jobId, customerId: r.customerId, propertyId: r.property.id,
    })), new Date());

    await tx.insert(schema.deviceSnapshot).values({
      organizationId: ctx.actor.organizationId,
      deviceId: device.id,
      fromDate: input.from,
      /** The company's date of the window's end. Read as UTC, a zone east of Greenwich got the day before. */
      toDate: time.dateIn(to, zone),
      revision,
      visitCount: rows.length,
    });

    return {
      revision,
      unchanged: false,
      visits: rows.map((r) => ({
        id: r.visit.id,
        jobId: r.jobId,
        jobNumber: r.jobNumber,
        sequence: r.visit.sequence,
        status: r.visit.status,
        summary: r.summary,
        description: r.description,
        customerComplaint: r.customerComplaint,
        technicianNotes: r.visit.technicianNotes,
        arrivedAt: r.visit.arrivedAt?.toISOString() ?? null,
        windowStart: r.visit.windowStart?.toISOString() ?? null,
        windowEnd: r.visit.windowEnd?.toISOString() ?? null,
        routeOrder: r.visit.routeOrder,
        estimatedDurationMinutes: r.visit.estimatedDurationMinutes,
        customer: { id: r.customerId, name: r.customerName, phone: r.customerPhone },
        property: {
          id: r.property.id,
          addressLine1: r.property.addressLine1,
          city: r.property.city,
          state: r.property.state,
          postalCode: r.property.postalCode,
          // A technician must see these before they get out of the truck, so
          // they ship with the schedule rather than being fetched on arrival
          // at the exact moment there is no signal.
          gateCode: r.property.gateCode,
          accessNotes: r.property.accessNotes,
          hazardNotes: r.property.hazardNotes,
          hasDog: r.property.hasDog,
        },
        checklist: r.visit.checklist,
        ...extras.get(r.visit.id)!,
        ...sales.get(r.visit.id)!,
      })),
      priceBook,
      openTimeEntry: open
        ? { id: open.id, kind: open.kind, startedAt: open.startedAt.toISOString() }
        : null,
      inspectionPrograms: await programsForField(tx, ctx),
      locationSharing: await location.forDevice(tx, ctx.actor.organizationId, device.technicianId),
      tasks: await fieldSales.tasksFor(tx, ctx),
      talks: await safetyTalks.talksForField(tx, ctx, device.technicianId),
      abilities: await fieldSales.abilitiesFor(tx, ctx),
      expenses: await fieldSales.expensesFor(tx, device.technicianId),
    };
  });
}

/**
 * The programmes this person can run on the phone. Only for somebody who
 * may file an inspection: offering a programme the server would refuse to
 * file is offering a technician twenty minutes of work that goes nowhere.
 */
async function programsForField(tx: Database, ctx: ServiceContext) {
  if (!can(ctx.actor, "compliance:write")) return [];
  const rows = await tx.select().from(schema.inspectionProgram)
    .where(and(
      eq(schema.inspectionProgram.organizationId, ctx.actor.organizationId),
      eq(schema.inspectionProgram.active, true),
    ))
    .orderBy(asc(schema.inspectionProgram.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    standard: row.standard,
    version: row.version,
    checkpoints: row.checkpoints.map((c) => ({
      key: c.key,
      label: c.label,
      requiresReading: c.requiresReading === true,
      unit: c.unit ?? null,
      min: c.range?.min ?? null,
      max: c.range?.max ?? null,
    })),
  }));
}

/**
 * A number that changes whenever the device's slice does.
 *
 * Derived from the update times of what the phone shows rather than kept as a
 * counter, because a counter has to be bumped by every path that touches a
 * visit and the one that forgets is the one that leaves a technician driving
 * to an address the office moved an hour ago.
 *
 * The visits, and since the phone shows them, the job's invoices (so a card
 * paid through the link shows as paid), the visit's service report and its
 * fields, and the parts on it. A part the office added, or a reading taken on
 * another phone, would otherwise be invisible until something about the visit
 * itself changed.
 */
async function computeRevision(tx: Database, visitIds: string[], jobIds: string[], customerIds: string[]): Promise<number> {
  if (visitIds.length === 0) {
    /**
     * A day with no visits still carries the office queue, so a task raised
     * for somebody with nothing booked reaches their phone.
     */
    const [row] = await tx.execute(sql`
      select coalesce(extract(epoch from greatest(
          (select max(updated_at) from public.task),
          (select max(updated_at) from public.safety_meeting),
          (select max(coalesce(signed_at, created_at)) from public.safety_meeting_attendee)
        ))::bigint, 0)
        + (select count(*) from public.task where status in ('open', 'in_progress'))
        + (select count(*) from public.safety_meeting_attendee where signed_at is null) as revision`);
    return Number((row as { revision: number }).revision);
  }
  const visits = sql.raw(`('${visitIds.join("','")}')`);
  const jobs = sql.raw(`('${[...new Set(jobIds)].join("','")}')`);
  const customers = sql.raw(`('${[...new Set(customerIds)].join("','")}')`);
  const [row] = await tx.execute(sql`
    select coalesce(extract(epoch from greatest(
      (select max(updated_at) from public.visit where id in ${visits}),
      (select max(updated_at) from public.invoice where job_id in ${jobs}),
      (select max(updated_at) from public.estimate where job_id in ${jobs} or customer_id in ${customers}),
      (select max(updated_at) from public.job_line where job_id in ${jobs}),
      (select max(updated_at) from public.task),
      (select max(updated_at) from public.service_report where visit_id in ${visits}),
      (select max(f.updated_at) from public.service_report_field f
         join public.service_report r on r.id = f.report_id where r.visit_id in ${visits}),
      (select max(updated_at) from public.job_line where visit_id in ${visits}),
      (select max(updated_at) from public.inspection where visit_id in ${visits}),
      (select max(updated_at) from public.inspection_program),
      (select max(updated_at) from public.safety_meeting),
      (select max(coalesce(signed_at, created_at)) from public.safety_meeting_attendee)
    ))::bigint, 0)
    + (select count(*) from public.safety_meeting_attendee where signed_at is null)
    + (select count(*) from public.inspection where visit_id in ${visits})
    + (select count(*) from public.estimate where job_id in ${jobs} or customer_id in ${customers})
    + (select count(*) from public.job_line where job_id in ${jobs})
    + (select count(*) from public.task where status in ('open', 'in_progress'))
    + (select count(*) from public.visit where id in ${visits})
    + (select count(*) from public.job_line where visit_id in ${visits})
    + (select count(*) from public.service_report_field f
         join public.service_report r on r.id = f.report_id where r.visit_id in ${visits}) as revision
  `);
  return Number((row as { revision: number }).revision);
}

type VisitExtras = Pick<z.infer<typeof VisitForField>, "amountDue" | "report" | "parts" | "inspections">;

/**
 * What the phone needs on each visit beyond the visit itself: what is owed,
 * the service report as it stands, and the parts already on it. One query
 * each for the whole day rather than one per visit, because the day is the
 * request and a phone on one bar waits for the slowest part of it.
 */
async function visitExtras(
  tx: Database,
  ctx: ServiceContext,
  visits: Array<{ visitId: string; jobId: string; jobTypeId: string | null }>,
): Promise<Map<string, VisitExtras>> {
  const out = new Map<string, VisitExtras>();
  if (visits.length === 0) return out;
  const visitIds = visits.map((v) => v.visitId);
  const jobIds = [...new Set(visits.map((v) => v.jobId))];

  /**
   * What is owed, only for a caller who may read invoices. A company can
   * take `invoice:read` away from a role, and the phone must not become the
   * way round that.
   */
  const owed = new Map<string, m.Money>();
  if (can(ctx.actor, "invoice:read")) {
    const invoices = await tx.select({ jobId: schema.invoice.jobId, balance: schema.invoice.balance })
      .from(schema.invoice)
      .where(and(
        inArray(schema.invoice.jobId, jobIds),
        inArray(schema.invoice.status, ["open", "partially_paid", "paid"]),
      ));
    for (const invoice of invoices) {
      if (!invoice.jobId) continue;
      owed.set(invoice.jobId, m.add(owed.get(invoice.jobId) ?? m.zero(), m.money(invoice.balance)));
    }
  }

  const reports = await tx.select({
    id: schema.serviceReport.id,
    visitId: schema.serviceReport.visitId,
    submittedAt: schema.serviceReport.submittedAt,
  }).from(schema.serviceReport)
    .where(inArray(schema.serviceReport.visitId, visitIds))
    .orderBy(asc(schema.serviceReport.createdAt));
  const reportOf = new Map(reports.map((r) => [r.visitId, r]));

  const values = reports.length === 0 ? [] : await tx.select({
    reportId: schema.serviceReportField.reportId,
    key: schema.serviceReportField.key,
    label: schema.serviceReportField.label,
    kind: schema.serviceReportField.kind,
    unit: schema.serviceReportField.unit,
    valueNumeric: schema.serviceReportField.valueNumeric,
    valueText: schema.serviceReportField.valueText,
    valueBoolean: schema.serviceReportField.valueBoolean,
    productName: schema.serviceReportField.productName,
    recordedAt: schema.serviceReportField.recordedAt,
  }).from(schema.serviceReportField)
    .where(inArray(schema.serviceReportField.reportId, reports.map((r) => r.id)))
    .orderBy(asc(schema.serviceReportField.recordedAt));

  const templates = new Map<string, Awaited<ReturnType<typeof templateFor>>>();
  for (const jobTypeId of new Set(visits.map((v) => v.jobTypeId).filter((id): id is string => id !== null))) {
    templates.set(jobTypeId, await templateFor(tx, jobTypeId));
  }

  const parts = await tx.select({
    id: schema.jobLine.id,
    visitId: schema.jobLine.visitId,
    name: schema.jobLine.name,
    quantity: schema.jobLine.quantity,
  }).from(schema.jobLine)
    .where(and(inArray(schema.jobLine.visitId, visitIds), eq(schema.jobLine.kind, "part")))
    .orderBy(asc(schema.jobLine.occurredAt));

  const filed = can(ctx.actor, "compliance:read") ? await tx.select({
    id: schema.inspection.id,
    visitId: schema.inspection.visitId,
    programId: schema.inspection.programId,
    programName: schema.inspectionProgram.name,
    result: schema.inspection.result,
    performedOn: schema.inspection.performedOn,
  }).from(schema.inspection)
    .leftJoin(schema.inspectionProgram, eq(schema.inspectionProgram.id, schema.inspection.programId))
    .where(inArray(schema.inspection.visitId, visitIds))
    .orderBy(asc(schema.inspection.createdAt)) : [];

  for (const visit of visits) {
    const report = reportOf.get(visit.visitId);
    const template = visit.jobTypeId ? templates.get(visit.jobTypeId) ?? null : null;

    /** The newest value per key: the rows are oldest first, so the last one written wins. */
    const latest = new Map<string, (typeof values)[number]>();
    for (const value of values) if (report && value.reportId === report.id) latest.set(value.key, value);

    /**
     * Only what a phone can fill in with a keyboard. A photo or a signature
     * on a template is taken with the camera and the signature pad, which
     * the visit already has.
     */
    const fillable = (template?.fields ?? []).filter((f) => f.kind !== "photo" && f.kind !== "signature");
    const fields = fillable.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      unit: f.unit ?? null,
      options: f.options ?? [],
      required: f.required ?? false,
      min: f.min ?? null,
      max: f.max ?? null,
      value: valueText(latest.get(f.key)),
    }));
    /** And anything recorded that the template does not name, so nothing written is hidden. */
    for (const [key, value] of latest) {
      if (fields.some((f) => f.key === key)) continue;
      fields.push({
        key, label: value.label, kind: value.kind, unit: value.unit, options: [], required: false,
        min: null, max: null, value: valueText(value),
      });
    }

    const due = owed.get(visit.jobId);
    out.set(visit.visitId, {
      amountDue: due ? m.toString(due) : null,
      report: { id: report?.id ?? null, submitted: report?.submittedAt != null, fields },
      parts: parts.filter((p) => p.visitId === visit.visitId).map((p) => ({
        id: p.id, name: p.name, quantity: p.quantity,
      })),
      inspections: filed.filter((i) => i.visitId === visit.visitId).map((i) => ({
        id: i.id, programId: i.programId, programName: i.programName ?? "Inspection",
        result: i.result, performedOn: i.performedOn,
      })),
    });
  }
  return out;
}

function valueText(row: {
  valueNumeric: string | null; valueText: string | null; valueBoolean: boolean | null; productName: string | null;
} | undefined): string | null {
  if (!row) return null;
  if (row.valueNumeric !== null) return String(Number(row.valueNumeric));
  if (row.valueBoolean !== null) return row.valueBoolean ? "yes" : "no";
  return row.valueText ?? row.productName ?? null;
}
