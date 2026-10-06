import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { project as plan } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
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
    const booked = await bookings(tx, project.id);

    return {
      projectId: project.id,
      name: project.name,
      start: analysis.start,
      finish: analysis.finish,
      targetCompletionOn: project.targetCompletionOn,
      criticalPath: analysis.criticalPath,
      statement: analysis.statement,
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
        };
      }),
    };
  });
}

/**
 * The people on each phase, in three queries for the whole project rather
 * than three per phase: the visits of the phase's jobs, the technicians
 * assigned to them, and the crews they carry.
 */
async function bookings(tx: Database, projectId: string): Promise<Map<string, ScheduledPhase["booked"]>> {
  const visits = await tx.select({
    visitId: schema.visit.id,
    crewId: schema.visit.crewId,
    status: schema.visit.status,
    phaseId: schema.projectJob.projectPhaseId,
  }).from(schema.projectJob)
    .innerJoin(schema.visit, eq(schema.visit.jobId, schema.projectJob.jobId))
    .where(eq(schema.projectJob.projectId, projectId));
  const live = visits.filter((v) => v.phaseId !== null && v.status !== "cancelled");
  if (live.length === 0) return new Map();

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
  }
  return out;
}

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

export const handlers = {
  getProjectSchedule: (ctx: ServiceContext, input: { projectId: string }) => schedule(ctx, input),
  moveProjectPhase: (ctx: ServiceContext, input: { id: string; startsOn: string }) => move(ctx, input),
  setProjectPhaseDates: (ctx: ServiceContext, input: { id: string; startsOn: string | null; endsOn: string | null }) =>
    setDates(ctx, input),
} as const;
