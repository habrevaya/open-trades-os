import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { isSystem, project as plan, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { loadProjectIn } from "./project-position";

/**
 * M12. THE SCHEDULE: PHASES ON A TIMELINE.
 *
 * The phases with their dates, what each waits for, which of them decide the
 * finish date, and who is booked on each. The critical path and what a drag
 * does are core's (`analyseSchedule`, `movePhase`); this file reads the
 * phases and the people and writes the moves.
 *
 * WHO IS BOOKED ON A PHASE IS READ, NOT KEPT. The technicians and crews on
 * the visits of the phase's jobs are the booking, made on the dispatch board
 * the way every other visit is. A second list of "people on this phase" kept
 * here would be a second schedule, and the two would disagree the first time
 * a dispatcher moved somebody.
 *
 * `job:read` to look and `job:write` to move, because the schedule is the
 * structure of the work, exactly as the phases themselves are.
 *
 * TWO THINGS HERE ARE PROPOSALS A PERSON ACTS ON, never decisions made for
 * them. A change order's days are proposed (`proposeChangeOrderDays`) and a
 * person applies exactly what they were shown (`applyChangeOrderDays`). And a
 * person or crew booked on two phases that run at once is flagged on the
 * schedule (`clashes`) and nobody is moved: whether Ray can do both mornings
 * is not something the schedule knows.
 */

export interface ScheduledPhase {
  id: string;
  sequence: number;
  name: string;
  status: plan.PhaseStatus;
  dependsOnPhaseId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  durationDays: number | null;
  floatDays: number | null;
  critical: boolean;
  overlapsPredecessor: boolean;
  /** The people and crews on the visits of this phase's jobs. */
  booked: {
    technicians: { id: string; name: string; visits: number }[];
    crews: { id: string; name: string; visits: number }[];
    /** Visits on this phase's jobs with nobody on them yet. */
    unassignedVisits: number;
  };
  /** Somebody booked on this phase and another that runs on the same days. Flags only. */
  clashes: plan.PhaseClash[];
}

export interface ProjectSchedule {
  projectId: string;
  name: string;
  start: string | null;
  finish: string | null;
  targetCompletionOn: string | null;
  criticalPath: string[];
  statement: string;
  phases: ScheduledPhase[];
  /** Everyone booked on two phases that run at once, with who and when. Nobody is moved. */
  clashes: plan.PhaseClash[];
}

async function phasesOf(tx: Database, projectId: string) {
  return tx.select().from(schema.projectPhase)
    .where(eq(schema.projectPhase.projectId, projectId))
    .orderBy(asc(schema.projectPhase.sequence));
}

const planned = (rows: Awaited<ReturnType<typeof phasesOf>>): plan.PlannedPhase[] =>
  rows.map((row) => ({
    id: row.id, name: row.name, sequence: row.sequence, dependsOnPhaseId: row.dependsOnPhaseId,
    startsOn: row.startsOn, endsOn: row.endsOn, status: row.status,
  }));

export async function schedule(ctx: ServiceContext, input: { projectId: string }): Promise<ProjectSchedule> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const project = await loadProjectIn(tx, ctx.actor.organizationId, input.projectId);
    const rows = await phasesOf(tx, project.id);
    const analysis = plan.analyseSchedule(planned(rows));
    const standing = new Map(analysis.phases.map((p) => [p.id, p]));
    const { booked, dated } = await bookings(tx, project.id, await timezoneOf(tx, ctx.actor.organizationId));
    const clashes = plan.findPhaseClashes(planned(rows), dated);

    return {
      projectId: project.id,
      name: project.name,
      start: analysis.start,
      finish: analysis.finish,
      targetCompletionOn: project.targetCompletionOn,
      criticalPath: analysis.criticalPath,
      statement: analysis.statement,
      clashes,
      phases: rows.map((row) => {
        const s = standing.get(row.id)!;
        return {
          id: row.id,
          sequence: row.sequence,
          name: row.name,
          status: row.status,
          dependsOnPhaseId: row.dependsOnPhaseId,
          startsOn: row.startsOn,
          endsOn: row.endsOn,
          durationDays: s.durationDays,
          floatDays: s.floatDays,
          critical: s.critical,
          overlapsPredecessor: s.overlapsPredecessor,
          booked: booked.get(row.id) ?? { technicians: [], crews: [], unassignedVisits: 0 },
          clashes: clashes.filter((c) => c.phaseIds.includes(row.id)),
        };
      }),
    };
  });
}

/**
 * The people on each phase, in three queries for the whole project rather
 * than three per phase: the visits of the phase's jobs, the technicians
 * assigned to them, and the crews they carry.
 *
 * Also the same bookings as dated rows, for the clash check: only visits that
 * still lie ahead (not finished, cancelled or missed) and that have a day, on
 * the company's calendar. A visit with no day is not "at once" with anything.
 */
async function bookings(
  tx: Database, projectId: string, zone: string,
): Promise<{ booked: Map<string, ScheduledPhase["booked"]>; dated: plan.PhaseBooking[] }> {
  const visits = await tx.select({
    visitId: schema.visit.id,
    crewId: schema.visit.crewId,
    status: schema.visit.status,
    windowStart: schema.visit.windowStart,
    phaseId: schema.projectJob.projectPhaseId,
  }).from(schema.projectJob)
    .innerJoin(schema.visit, eq(schema.visit.jobId, schema.projectJob.jobId))
    .where(eq(schema.projectJob.projectId, projectId));
  const live = visits.filter((v) => v.phaseId !== null && v.status !== "cancelled");
  if (live.length === 0) return { booked: new Map(), dated: [] };

  const assignments = await tx.select({
    visitId: schema.visitAssignment.visitId,
    technicianId: schema.technician.id,
    name: schema.technician.displayName,
  }).from(schema.visitAssignment)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(inArray(schema.visitAssignment.visitId, live.map((v) => v.visitId)));
  const crewIds = [...new Set(live.map((v) => v.crewId).filter((x): x is string => x !== null))];
  const crews = crewIds.length === 0 ? [] : await tx.select({ id: schema.crew.id, name: schema.crew.name })
    .from(schema.crew).where(inArray(schema.crew.id, crewIds));
  const crewName = new Map(crews.map((c) => [c.id, c.name]));

  const out = new Map<string, ScheduledPhase["booked"]>();
  const dated: plan.PhaseBooking[] = [];
  for (const visit of live) {
    const entry = out.get(visit.phaseId!) ?? { technicians: [], crews: [], unassignedVisits: 0 };
    const people = assignments.filter((a) => a.visitId === visit.visitId);
    for (const person of people) {
      const known = entry.technicians.find((t) => t.id === person.technicianId);
      if (known) known.visits += 1;
      else entry.technicians.push({ id: person.technicianId, name: person.name, visits: 1 });
    }
    if (visit.crewId) {
      const known = entry.crews.find((c) => c.id === visit.crewId);
      if (known) known.visits += 1;
      else entry.crews.push({ id: visit.crewId, name: crewName.get(visit.crewId) ?? "Crew", visits: 1 });
    }
    if (people.length === 0 && !visit.crewId) entry.unassignedVisits += 1;
    out.set(visit.phaseId!, entry);

    if (visit.windowStart && !AHEAD_OVER.has(visit.status)) {
      const date = time.dateIn(visit.windowStart, zone);
      for (const person of people) {
        dated.push({ kind: "technician", id: person.technicianId, name: person.name, phaseId: visit.phaseId!, date });
      }
      if (visit.crewId) {
        dated.push({ kind: "crew", id: visit.crewId, name: crewName.get(visit.crewId) ?? "Crew", phaseId: visit.phaseId!, date });
      }
    }
  }
  return { booked: out, dated };
}

/** A visit in one of these has happened, or will not: it does not hold anybody's day. */
const AHEAD_OVER = new Set(["completed", "cancelled", "no_show", "completed_after_cancellation"]);

async function loadPhase(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.projectPhase)
    .where(and(eq(schema.projectPhase.id, id), eq(schema.projectPhase.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Phase");
  return row;
}

/**
 * DRAG A PHASE TO A NEW START. Everything that waits for it moves by the
 * same days; core decides what moves and refuses what cannot, and every move
 * is written in this one transaction, so a schedule is never half dragged.
 */
export async function move(
  ctx: ServiceContext, input: { id: string; startsOn: string },
): Promise<{ shiftDays: number; moves: plan.PhaseMove[] }> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const phase = await loadPhase(tx, ctx.actor.organizationId, input.id);
    const rows = await phasesOf(tx, phase.projectId);
    const decision = plan.movePhase(planned(rows), phase.id, input.startsOn);
    if (!decision.ok) throw new ConflictError(decision.reason);
    for (const moved of decision.moves) {
      await tx.update(schema.projectPhase).set({
        startsOn: moved.startsOn, endsOn: moved.endsOn, updatedAt: new Date(),
      }).where(eq(schema.projectPhase.id, moved.id));
    }
    if (decision.moves.length > 0) {
      await audit(tx, ctx, "project_phase.moved", "project_phase", phase.id,
        { startsOn: phase.startsOn, endsOn: phase.endsOn },
        { shiftDays: decision.shiftDays, moves: decision.moves });
    }
    return { shiftDays: decision.shiftDays, moves: decision.moves };
  });
}

/**
 * Give a phase its own dates, or change how long it takes. Only this phase:
 * changing a length is a decision about one piece of work, and the schedule
 * then says plainly if a follower now starts before it ends, rather than
 * shuffling the followers on the strength of a typo.
 *
 * A start on or before the day the phase it waits for ends is refused, for
 * the reason the drag refuses it.
 */
export async function setDates(
  ctx: ServiceContext, input: { id: string; startsOn: string | null; endsOn: string | null },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const phase = await loadPhase(tx, ctx.actor.organizationId, input.id);
    if ((input.startsOn === null) !== (input.endsOn === null)) {
      throw new ConflictError("A phase on the schedule needs a start and an end, or neither.");
    }
    if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
      throw new ConflictError("That phase would end before it starts.");
    }
    if (phase.status === "complete" && (input.startsOn !== phase.startsOn || input.endsOn !== phase.endsOn)) {
      throw new ConflictError(`${phase.name} is complete, so its dates are what happened.`);
    }
    if (input.startsOn && phase.dependsOnPhaseId) {
      const [predecessor] = await tx.select().from(schema.projectPhase)
        .where(eq(schema.projectPhase.id, phase.dependsOnPhaseId)).limit(1);
      if (predecessor?.endsOn && input.startsOn <= predecessor.endsOn) {
        throw new ConflictError(
          `${phase.name} waits for ${predecessor.name}, which finishes on ${predecessor.endsOn}. `
          + `The earliest it can start is ${plan.shiftDate(predecessor.endsOn, 1)}.`,
        );
      }
    }
    const [row] = await tx.update(schema.projectPhase).set({
      startsOn: input.startsOn, endsOn: input.endsOn, updatedAt: new Date(),
    }).where(eq(schema.projectPhase.id, phase.id)).returning();
    await audit(tx, ctx, "project_phase.dated", "project_phase", phase.id,
      { startsOn: phase.startsOn, endsOn: phase.endsOn }, { startsOn: row!.startsOn, endsOn: row!.endsOn });
    return { id: row!.id, startsOn: row!.startsOn, endsOn: row!.endsOn };
  });
}

/* ------------------------------------------- the days a change order adds */

export interface ChangeOrderDaysProposal {
  changeOrderId: string;
  number: number;
  title: string;
  /** The days on the change order. Null when it names none. */
  days: number | null;
  /** The phase the days would land on: the one asked for, or the change order's own. */
  phaseId: string | null;
  phaseName: string | null;
  /** Already applied: never applied twice. */
  applied: { at: Date; phaseId: string; days: number; changes: plan.DayChange[] } | null;
  /** Whether applying is possible now, and when it is not, why in a sentence. */
  canApply: boolean;
  reason: string | null;
  /** What would move. Null when nothing can. */
  proposal: {
    changes: plan.DayChange[];
    finishBefore: string | null;
    finishAfter: string | null;
    statement: string;
    /** What the person was shown. Applying hands it back, and a schedule that changed since is refused. */
    key: string;
  } | null;
}

/** A short fingerprint of exactly which dates a proposal would write. */
const keyOf = (changes: readonly plan.DayChange[]) =>
  createHash("sha256")
    .update(changes.map((c) => `${c.id}:${c.wasStartsOn}:${c.wasEndsOn}:${c.startsOn}:${c.endsOn}`).join("|"))
    .digest("hex").slice(0, 32);

async function loadChangeOrder(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.projectChangeOrder)
    .where(and(eq(schema.projectChangeOrder.id, id), eq(schema.projectChangeOrder.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Change order");
  return row;
}

/**
 * Work out what applying a change order's days would do. Shared by the
 * proposal (which only reports it) and the apply (which writes it), so the
 * two can never disagree about what "these days" means.
 */
async function proposeIn(
  tx: Database, organizationId: string,
  order: Awaited<ReturnType<typeof loadChangeOrder>>, phaseId: string | undefined,
): Promise<ChangeOrderDaysProposal> {
  const rows = await phasesOf(tx, order.projectId);
  const target = phaseId ?? order.projectPhaseId ?? null;
  const base = {
    changeOrderId: order.id, number: order.number, title: order.title, days: order.scheduleDays,
    phaseId: target, phaseName: rows.find((r) => r.id === target)?.name ?? null,
  };
  const refused = (reason: string): ChangeOrderDaysProposal =>
    ({ ...base, applied: null, canApply: false, reason, proposal: null });

  if (order.scheduleApplied && order.scheduleAppliedAt) {
    const done = order.scheduleApplied;
    return {
      ...base, phaseId: done.phaseId, phaseName: rows.find((r) => r.id === done.phaseId)?.name ?? base.phaseName,
      applied: {
        at: order.scheduleAppliedAt, phaseId: done.phaseId, days: done.days,
        changes: done.moves.map((mv) => ({
          id: mv.id, name: rows.find((r) => r.id === mv.id)?.name ?? "Phase",
          startsOn: mv.startsOn, endsOn: mv.endsOn, wasStartsOn: mv.wasStartsOn, wasEndsOn: mv.wasEndsOn,
        })),
      },
      canApply: false, reason: "These days are already on the schedule.", proposal: null,
    };
  }
  /**
   * Only a change order the customer agreed. A priced or sent one may still be
   * declined, and a schedule pushed out for work nobody agreed to is a
   * schedule the crews and the customer were told is wrong.
   */
  if (order.status !== "approved") {
    return refused("Only a change order the customer has agreed can move the schedule.");
  }
  if (!order.scheduleDays) return refused("This change order has no days to add to the schedule.");
  if (!target) return refused("Choose the phase these days land on. The change order does not name one.");
  const decision = plan.proposeChangeOrderDays(planned(rows), target, order.scheduleDays);
  if (!decision.ok) return refused(decision.reason);
  return {
    ...base, applied: null, canApply: true, reason: null,
    proposal: {
      changes: decision.changes, finishBefore: decision.finishBefore, finishAfter: decision.finishAfter,
      statement: decision.statement, key: keyOf(decision.changes),
    },
  };
}

/**
 * WHAT THE DAYS ON A CHANGE ORDER WOULD DO TO THE SCHEDULE. Moves nothing.
 *
 * `job:read`, because looking at a proposal changes nothing. Pass `phaseId`
 * when the change order names no phase, or to land the days on a different
 * one than the work was priced against.
 */
export async function proposeChangeOrderDays(
  ctx: ServiceContext, input: { id: string; phaseId?: string | undefined },
): Promise<ChangeOrderDaysProposal> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const order = await loadChangeOrder(tx, ctx.actor.organizationId, input.id);
    return proposeIn(tx, ctx.actor.organizationId, order, input.phaseId);
  });
}

/**
 * APPLY THE DAYS, AS THEY WERE PROPOSED. A person does this, once.
 *
 * `proposalKey` is what the person was shown. The proposal is worked out
 * again inside this transaction against the schedule as it stands, and if it
 * is not the same one the days are not applied and the person is told to look
 * again: somebody dragged a phase between the page loading and the click, and
 * "apply what I was shown" must not turn into "apply something else".
 *
 * Applied once. The change order row is locked, and a second call (a retry, or
 * a colleague clicking the same button) gets back what the first one did
 * instead of pushing every later phase out a second time. Visits already
 * booked are not moved; if the move leaves somebody booked twice, the schedule
 * flags it and leaves it to a person.
 */
export async function applyChangeOrderDays(
  ctx: ServiceContext, input: { id: string; phaseId?: string | undefined; proposalKey: string },
): Promise<ChangeOrderDaysProposal & { alreadyApplied: boolean }> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [locked] = await tx.select({ id: schema.projectChangeOrder.id }).from(schema.projectChangeOrder)
      .where(and(
        eq(schema.projectChangeOrder.id, input.id),
        eq(schema.projectChangeOrder.organizationId, ctx.actor.organizationId),
      )).for("update").limit(1);
    if (!locked) throw new NotFoundError("Change order");
    const order = await loadChangeOrder(tx, ctx.actor.organizationId, input.id);

    const seen = await proposeIn(tx, ctx.actor.organizationId, order, input.phaseId);
    if (seen.applied) return { ...seen, alreadyApplied: true };
    if (!seen.canApply || !seen.proposal) throw new ConflictError(seen.reason ?? "Nothing to apply.");
    if (seen.proposal.key !== input.proposalKey) {
      throw new ConflictError("The schedule changed since you looked at this proposal. Look at it again before you apply it.");
    }

    for (const change of seen.proposal.changes) {
      await tx.update(schema.projectPhase).set({
        startsOn: change.startsOn, endsOn: change.endsOn, updatedAt: new Date(),
      }).where(eq(schema.projectPhase.id, change.id));
    }
    const at = new Date();
    await tx.update(schema.projectChangeOrder).set({
      scheduleAppliedAt: at,
      scheduleAppliedBy: isSystem(ctx.actor) ? null : ctx.actor.userId,
      scheduleApplied: {
        phaseId: seen.phaseId!, days: order.scheduleDays!,
        moves: seen.proposal.changes.map((c) => ({
          id: c.id, startsOn: c.startsOn, endsOn: c.endsOn, wasStartsOn: c.wasStartsOn, wasEndsOn: c.wasEndsOn,
        })),
      },
      updatedAt: at,
    }).where(eq(schema.projectChangeOrder.id, order.id));
    await audit(tx, ctx, "project_change_order.schedule_applied", "project_change_order", order.id,
      { scheduleAppliedAt: null },
      { phaseId: seen.phaseId, days: order.scheduleDays, changes: seen.proposal.changes });
    const after = await loadChangeOrder(tx, ctx.actor.organizationId, order.id);
    return { ...(await proposeIn(tx, ctx.actor.organizationId, after, undefined)), alreadyApplied: false };
  });
}

export const handlers = {
  getProjectSchedule: (ctx: ServiceContext, input: { projectId: string }) => schedule(ctx, input),
  moveProjectPhase: (ctx: ServiceContext, input: { id: string; startsOn: string }) => move(ctx, input),
  setProjectPhaseDates: (ctx: ServiceContext, input: { id: string; startsOn: string | null; endsOn: string | null }) =>
    setDates(ctx, input),
  getChangeOrderScheduleDays: (ctx: ServiceContext, input: { id: string; phaseId?: string | undefined }) =>
    proposeChangeOrderDays(ctx, input),
  applyChangeOrderScheduleDays: (ctx: ServiceContext, input: { id: string; phaseId?: string | undefined; proposalKey: string }) =>
    applyChangeOrderDays(ctx, input),
} as const;
