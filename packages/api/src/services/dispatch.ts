import { and, eq, gte, lte, inArray, asc, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, NotFoundError, ConflictError,
} from "./context";
import { audit } from "./customers";
import type {
  getDispatchBoard, assignVisit, reorderRoute, sendArrivalNotice, getFieldSnapshot,
} from "../contracts/field";

const PORTAL_BASE = process.env.PORTAL_BASE_URL ?? "https://portal.example.com";

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
    const dayStart = new Date(`${input.date}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 864e5);
    const now = new Date();

    const technicians = await tx.select({
      id: schema.technician.id,
      displayName: schema.technician.displayName,
      color: schema.technician.color,
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
      addressLine1: schema.property.addressLine1,
      postalCode: schema.property.postalCode,
      technicianId: schema.visitAssignment.technicianId,
    })
      .from(schema.visit)
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
      .leftJoin(schema.visitAssignment, eq(schema.visitAssignment.visitId, schema.visit.id))
      .where(and(
        gte(schema.visit.windowStart, dayStart),
        lte(schema.visit.windowStart, dayEnd),
        input.businessUnitId ? eq(schema.job.businessUnitId, input.businessUnitId) : undefined,
        // Territory is a property of the job, not of the visit: every visit on
        // a job is at the same address.
        input.territoryId ? eq(schema.job.territoryId, input.territoryId) : undefined,
      ))
      .orderBy(asc(schema.visit.routeOrder), asc(schema.visit.windowStart));

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
    });

    const assigned = new Map<string, ReturnType<typeof shape>[]>();
    const unassigned: Array<ReturnType<typeof shape> & { postalCode: string }> = [];

    for (const r of rows) {
      if (r.technicianId) {
        assigned.set(r.technicianId, [...(assigned.get(r.technicianId) ?? []), shape(r)]);
      } else {
        unassigned.push({ ...shape(r), postalCode: r.postalCode });
      }
    }

    return {
      date: input.date,
      technicians: technicians.map((t) => ({
        id: t.id,
        displayName: t.displayName,
        color: t.color,
        timeOff: offToday.has(t.id),
        visits: assigned.get(t.id) ?? [],
      })),
      unassigned: unassigned.map(({ isLate: _late, ...rest }) => rest),
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
    const [visit] = await tx.select().from(schema.visit)
      .where(eq(schema.visit.id, input.id)).limit(1);
    if (!visit) throw new NotFoundError("Visit");

    if (["completed", "cancelled", "completed_after_cancellation"].includes(visit.status)) {
      throw new ConflictError(`This visit is ${visit.status} and cannot be reassigned.`);
    }

    const technicians = await tx.select({ id: schema.technician.id })
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

    await tx.update(schema.visit).set({
      status,
      dispatchedAt: visit.dispatchedAt ?? new Date(),
      ...(input.routeOrder !== undefined ? { routeOrder: input.routeOrder } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.visit.id, input.id));

    await audit(tx, ctx, "visit.assigned", "visit", input.id,
      { status: visit.status }, { status, technicianIds: input.technicianIds });

    return { ok: true as const, status };
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
    const dayStart = new Date(`${input.date}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 864e5);

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
      number: schema.job.number,
    }).from(schema.job).where(eq(schema.job.id, visit.jobId)).limit(1);
    if (!job) throw new NotFoundError("Job");

    // A retry from a van with one bar must not send a second message. The
    // customer reads both.
    const [already] = await tx.select({ id: schema.arrivalNotice.id })
      .from(schema.arrivalNotice)
      .where(and(
        eq(schema.arrivalNotice.visitId, input.id),
        isNull(schema.arrivalNotice.failedReason),
      )).limit(1);

    if (already) {
      const [existingGrant] = await tx.select({ id: schema.portalGrant.id })
        .from(schema.portalGrant)
        .where(and(
          eq(schema.portalGrant.scope, "job"),
          eq(schema.portalGrant.subjectId, visit.jobId),
          isNull(schema.portalGrant.revokedAt),
        )).limit(1);
      return { ok: true as const, trackingUrl: existingGrant ? null : null };
    }

    let trackingUrl: string | null = null;
    if (input.includeTracking) {
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
      trackingUrl = `${PORTAL_BASE}/j/${token}`;
    }

    await tx.insert(schema.arrivalNotice).values({
      organizationId: ctx.actor.organizationId,
      visitId: input.id,
      channel: input.channel,
      etaMinutes: input.etaMinutes ?? null,
      includesTracking: input.includeTracking,
    });

    await tx.insert(schema.portalEvent).values({
      organizationId: ctx.actor.organizationId,
      customerId: job.customerId,
      jobId: visit.jobId,
      kind: "on_the_way",
      headline: "Your technician is on the way",
      detail: input.etaMinutes ? `About ${input.etaMinutes} minutes away` : null,
    });

    return { ok: true as const, trackingUrl };
  });
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

    const from = new Date(`${input.from}T00:00:00Z`);
    const to = new Date(from.getTime() + input.days * 864e5);

    const rows = await tx.select({
      visit: schema.visit,
      jobId: schema.job.id,
      jobNumber: schema.job.number,
      summary: schema.job.summary,
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
    const revision = await computeRevision(tx, rows.map((r) => r.visit.id));

    if (input.sinceRevision !== undefined && input.sinceRevision === revision) {
      return { revision, unchanged: true, visits: [], priceBook: [], openTimeEntry: null };
    }

    const priceBook = await tx.select({
      id: schema.priceBookItem.id,
      versionId: schema.priceBookItemVersion.id,
      code: schema.priceBookItem.code,
      name: schema.priceBookItemVersion.name,
      unitPrice: schema.priceBookItemVersion.price,
      taxable: schema.priceBookItemVersion.taxable,
    })
      .from(schema.priceBookItemVersion)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
      .where(and(
        eq(schema.priceBookItemVersion.organizationId, ctx.actor.organizationId),
        isNull(schema.priceBookItemVersion.effectiveTo),
      ))
      .limit(2000);

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

    await tx.insert(schema.deviceSnapshot).values({
      organizationId: ctx.actor.organizationId,
      deviceId: device.id,
      fromDate: input.from,
      toDate: to.toISOString().slice(0, 10),
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
        customerComplaint: r.customerComplaint,
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
      })),
      priceBook,
      openTimeEntry: open
        ? { id: open.id, kind: open.kind, startedAt: open.startedAt.toISOString() }
        : null,
    };
  });
}

/**
 * A number that changes whenever the device's slice does.
 *
 * Derived from the visits' own update times rather than kept as a counter,
 * because a counter has to be bumped by every path that touches a visit and
 * the one that forgets is the one that leaves a technician driving to an
 * address the office moved an hour ago.
 */
async function computeRevision(tx: Database, visitIds: string[]): Promise<number> {
  if (visitIds.length === 0) return 0;
  const [row] = await tx.execute(sql`
    select coalesce(extract(epoch from max(updated_at))::bigint, 0) + count(*) as revision
    from public.visit where id in ${sql.raw(`('${visitIds.join("','")}')`)}
  `);
  return Number((row as { revision: number }).revision);
}
