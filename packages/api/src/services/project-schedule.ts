import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, isSystem, project as plan, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { loadProjectIn } from "./project-position";
import { announce, sideOf } from "./visit-notices";
import { officeMoved } from "./visit-changes";
import { dispatchPeople } from "./people-scope";
import { qualify, requiredSkillsOf } from "./qualification";
import { loadWeek } from "./business-hours";

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
 *
 * THE CLASH CHECK READS VISITS AND CREWS, not only phases. A crew sent to a
 * phase's visit holds each of its members, so a member booked by name on
 * another phase that runs at once is flagged like anybody else. And a person
 * held by two visits in overlapping hours (`visitClashes`), one of them the
 * project's and the other the project's or any other of theirs, is flagged
 * with the hours and, in words, what the dispatcher could do: another person
 * with the skills who is free then, or the same hours on another day when
 * this person is free. Suggestions only: nothing is moved or reassigned.
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
  /** Everyone held by two visits in overlapping hours, one of them the project's, with what could be done. Nobody is moved. */
  visitClashes: VisitClashView[];
}

/**
 * ONE PERSON ON TWO VISITS AT ONCE, as the schedule says it: who, which of
 * the project's visits, the hours, and suggestions in words. The other visit
 * is named only when it is the project's own; any other is "another visit",
 * with its hours and nothing about whose it is.
 */
export interface VisitClashView {
  technicianId: string;
  name: string;
  /** The project's visit, and the phase it is on. */
  visitId: string;
  phaseId: string | null;
  otherVisitId: string;
  /** Whether the other visit is the project's too. */
  otherIsProject: boolean;
  from: string;
  to: string;
  statement: string;
  /** People with the skills the project's visit needs who are free in those hours, at most three. */
  freePeople: { id: string; name: string }[];
  /** Days after it, at most three, when this person is free in the same hours, inside the phase's dates when it has some. */
  freeDays: string[];
  /** What could be done, in words. Nothing is moved by saying it. */
  suggestions: string[];
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
    const visitClashes = await visitClashesOf(tx, ctx, project, rows);

    return {
      projectId: project.id,
      name: project.name,
      start: analysis.start,
      finish: analysis.finish,
      targetCompletionOn: project.targetCompletionOn,
      criticalPath: analysis.criticalPath,
      statement: analysis.statement,
      clashes,
      visitClashes,
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
  /**
   * The people on each crew, as the crew is now: a crew's membership has no
   * history, so a visit next month is read with today's members, which is
   * what the board would send.
   */
  const members = crewIds.length === 0 ? [] : await tx.select({
    crewId: schema.crewMember.crewId, technicianId: schema.technician.id, name: schema.technician.displayName,
  }).from(schema.crewMember)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
    .where(inArray(schema.crewMember.crewId, crewIds));

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
        /** Each member is held by the crew's visit as surely as by one of their own. */
        for (const member of members.filter((m) => m.crewId === visit.crewId)) {
          if (people.some((p) => p.technicianId === member.technicianId)) continue;
          dated.push({ kind: "technician", id: member.technicianId, name: member.name, phaseId: visit.phaseId!, date });
        }
      }
    }
  }
  return { booked: out, dated };
}

/** A visit in one of these has happened, or will not: it does not hold anybody's day. */
const AHEAD_OVER = new Set(["completed", "cancelled", "no_show", "completed_after_cancellation"]);

/* ------------------------------------------------ one person, two visits */

const DAY_MS = 86_400_000;

/**
 * The hours a visit holds somebody: from the start of its window to the later
 * of the end of its window and its start plus its length. An arrival window
 * of eight to noon on a two hour job may hold a person until two, and a clash
 * check that read only the window would miss the afternoon.
 */
const hoursOf = (v: { windowStart: Date; windowEnd: Date | null; minutes: number }) => {
  const start = v.windowStart.getTime();
  return { start, end: Math.max(v.windowEnd?.getTime() ?? start, start + v.minutes * 60_000) };
};

/**
 * Every live visit holding any of these people between two instants: theirs
 * by name, and their crew's. Plus their approved leave, which holds them for
 * the test of who is free, though it is no clash of a visit's.
 */
async function holdsOf(
  tx: Database, organizationId: string, people: readonly string[], from: Date, to: Date, projectJobs: ReadonlySet<string>,
): Promise<{ visits: plan.VisitHold[]; leave: Map<string, { start: number; end: number }[]> }> {
  const leave = new Map<string, { start: number; end: number }[]>();
  if (people.length === 0) return { visits: [], leave };
  const columns = {
    visitId: schema.visit.id, jobId: schema.visit.jobId, status: schema.visit.status,
    windowStart: schema.visit.windowStart, windowEnd: schema.visit.windowEnd, minutes: schema.visit.estimatedDurationMinutes,
    technicianId: schema.technician.id, name: schema.technician.displayName,
  };
  const inRange = and(
    eq(schema.visit.organizationId, organizationId),
    gte(schema.visit.windowStart, new Date(from.getTime() - DAY_MS)), lt(schema.visit.windowStart, to),
  );
  const byName = await tx.select(columns)
    .from(schema.visitAssignment)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(and(inRange, inArray(schema.visitAssignment.technicianId, [...people])));
  const byCrew = await tx.select({ ...columns, crew: schema.crew.name })
    .from(schema.crewMember)
    .innerJoin(schema.crew, eq(schema.crew.id, schema.crewMember.crewId))
    .innerJoin(schema.visit, eq(schema.visit.crewId, schema.crewMember.crewId))
    .innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
    .where(and(inRange, inArray(schema.crewMember.technicianId, [...people])));
  const visits: plan.VisitHold[] = [];
  for (const row of [...byName.map((r) => ({ ...r, crew: null })), ...byCrew]) {
    if (!row.windowStart || AHEAD_OVER.has(row.status)) continue;
    const { start, end } = hoursOf({ windowStart: row.windowStart, windowEnd: row.windowEnd, minutes: row.minutes });
    visits.push({
      visitId: row.visitId, personId: row.technicianId, name: row.name, start, end,
      crew: row.crew, ours: projectJobs.has(row.jobId),
    });
  }
  const away = await tx.select({
    technicianId: schema.timeOff.technicianId, startsAt: schema.timeOff.startsAt, endsAt: schema.timeOff.endsAt,
  }).from(schema.timeOff)
    .where(and(
      eq(schema.timeOff.organizationId, organizationId), eq(schema.timeOff.approved, true), isNull(schema.timeOff.deletedAt),
      inArray(schema.timeOff.technicianId, [...people]), lt(schema.timeOff.startsAt, to), gt(schema.timeOff.endsAt, from),
    ));
  for (const row of away) {
    leave.set(row.technicianId, [...(leave.get(row.technicianId) ?? []), { start: row.startsAt.getTime(), end: row.endsAt.getTime() }]);
  }
  return { visits, leave };
}

/** "10:00 AM", in the company's clock. */
const clockIn = (ms: number, zone: string) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
/** "Mon Nov 9", in the company's calendar. */
const dayIn = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const listOf = (items: readonly string[]) =>
  items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * THE VISIT CLASHES ON A PROJECT, with suggestions. Read inside the schedule's
 * own transaction and under its `job:read`: who is held twice, when, and in
 * words what could be done. The people suggested are only those the reader
 * may see on the board; a person's other visits outside the project are said
 * as "another visit" with their hours, never whose or where.
 */
async function visitClashesOf(
  tx: Database, ctx: ServiceContext, project: { id: string; businessUnitId: string | null },
  phases: Awaited<ReturnType<typeof phasesOf>>,
): Promise<VisitClashView[]> {
  const organizationId = ctx.actor.organizationId;
  const zone = await timezoneOf(tx, organizationId);
  const ours = await tx.select({
    visitId: schema.visit.id, jobId: schema.visit.jobId, status: schema.visit.status, crewId: schema.visit.crewId,
    windowStart: schema.visit.windowStart, windowEnd: schema.visit.windowEnd, minutes: schema.visit.estimatedDurationMinutes,
    phaseId: schema.projectJob.projectPhaseId, jobNumber: schema.job.number, summary: schema.job.summary,
  }).from(schema.projectJob)
    .innerJoin(schema.visit, eq(schema.visit.jobId, schema.projectJob.jobId))
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .where(eq(schema.projectJob.projectId, project.id));
  /** Only what still lies ahead holds anybody: a visit done, missed or called off is history. */
  const now = Date.now();
  const live = ours.filter((v): v is typeof v & { windowStart: Date } =>
    v.windowStart !== null && !AHEAD_OVER.has(v.status) && hoursOf({ ...v, windowStart: v.windowStart }).end > now);
  if (live.length === 0) return [];
  const projectJobs = new Set(ours.map((v) => v.jobId));
  const byVisit = new Map(ours.map((v) => [v.visitId, v]));

  const assigned = await tx.select({ visitId: schema.visitAssignment.visitId, technicianId: schema.visitAssignment.technicianId })
    .from(schema.visitAssignment).where(inArray(schema.visitAssignment.visitId, live.map((v) => v.visitId)));
  const crewIds = [...new Set(live.map((v) => v.crewId).filter((x): x is string => x !== null))];
  const members = crewIds.length === 0 ? [] : await tx.select({ crewId: schema.crewMember.crewId, technicianId: schema.crewMember.technicianId })
    .from(schema.crewMember).where(inArray(schema.crewMember.crewId, crewIds));
  const people = [...new Set([...assigned.map((a) => a.technicianId), ...members.map((m) => m.technicianId)])];
  if (people.length === 0) return [];

  const spans = live.map((v) => hoursOf(v));
  const from = new Date(Math.min(...spans.map((x) => x.start)));
  const to = new Date(Math.max(...spans.map((x) => x.end)));
  const { visits: holds } = await holdsOf(tx, organizationId, people, from, to, projectJobs);
  const clashes = plan.findVisitClashes(holds).filter((c) => byVisit.has(c.visitIds[0]) && live.some((v) => v.visitId === c.visitIds[0]));
  if (clashes.length === 0) return [];

  /** The people the reader may see on the board, who could be offered instead. */
  const visible = await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
    .from(schema.technician)
    .where(and(eq(schema.technician.organizationId, organizationId), eq(schema.technician.active, true), dispatchPeople(ctx)))
    .orderBy(asc(schema.technician.displayName));
  const week = (await loadWeek(tx, organizationId, project.businessUnitId)).week;
  const phaseOf = new Map(phases.map((p) => [p.id, p]));
  const label = (visitId: string) => {
    const v = byVisit.get(visitId);
    if (!v) return "another visit";
    const phase = v.phaseId ? phaseOf.get(v.phaseId) : undefined;
    return `#${v.jobNumber} ${phase ? `(${phase.name})` : v.summary ?? ""}`.trim();
  };

  const out: VisitClashView[] = [];
  for (const clash of clashes) {
    const visit = byVisit.get(clash.visitIds[0])!;
    const span = hoursOf({ ...visit, windowStart: visit.windowStart! });
    const date = time.dateIn(new Date(span.start), zone);
    const phase = visit.phaseId ? phaseOf.get(visit.phaseId) ?? null : null;
    const onIt = new Set([
      ...assigned.filter((a) => a.visitId === visit.visitId).map((a) => a.technicianId),
      ...members.filter((m) => m.crewId === visit.crewId).map((m) => m.technicianId),
    ]);

    /** Another person: with the skills the visit needs on its day, and nothing holding them in its hours. */
    let freePeople: { id: string; name: string }[] = [];
    const viaCrew = clash.crews[0] !== null;
    if (!viaCrew) {
      const candidates = visible.filter((t) => !onIt.has(t.id) && t.id !== clash.personId);
      const skills = (await requiredSkillsOf(tx, visit.visitId)).skills;
      const verdicts = await qualify(tx, organizationId, { technicianIds: candidates.map((c) => c.id), skills, on: date });
      const able = candidates.filter((c) => verdicts.get(c.id)?.qualified !== false);
      const theirs = await holdsOf(tx, organizationId, able.map((c) => c.id), new Date(span.start), new Date(span.end), projectJobs);
      freePeople = able.filter((c) =>
        plan.freeOf(theirs.visits.filter((h) => h.personId === c.id), span.start, span.end)
        && plan.freeOf(theirs.leave.get(c.id) ?? [], span.start, span.end)).slice(0, 3);
    }

    /**
     * Another day: the same hours on the days after, for this person, inside
     * the phase's dates when it has some and the week after otherwise, on a
     * day the company works, with nothing holding them then.
     */
    const lastDay = phase?.endsOn && phase.endsOn > date ? phase.endsOn : time.addDays(date, 7);
    const ahead = new Date(time.instantOfLocal(time.addDays(lastDay, 1), 0, zone));
    const mine = await holdsOf(tx, organizationId, [clash.personId], new Date(span.end), ahead, projectJobs);
    const startMinute = time.minutesInDay(new Date(span.start), zone);
    const length = span.end - span.start;
    const freeDays: string[] = [];
    for (let day = time.addDays(date, 1); day <= lastDay && freeDays.length < 3; day = time.addDays(day, 1)) {
      if (week && week[new Date(`${day}T12:00:00Z`).getUTCDay()] === null) continue;
      const start = time.instantOfLocal(day, startMinute, zone).getTime();
      const others = mine.visits.filter((h) => h.visitId !== visit.visitId);
      if (plan.freeOf(others, start, start + length) && plan.freeOf(mine.leave.get(clash.personId) ?? [], start, start + length)) {
        freeDays.push(day);
      }
    }

    const who = `${clash.name}${clash.crews[0] ? ` (with ${clash.crews[0]})` : ""}`;
    const hours = `${clockIn(clash.from, zone)} to ${clockIn(clash.to, zone)} on ${dayIn(date)}`;
    const statement = `${who} is booked on ${label(clash.visitIds[0])} and on ${label(clash.visitIds[1])}`
      + `${clash.crews[1] ? ` (with ${clash.crews[1]})` : ""} at once, ${hours}.`;
    const suggestions: string[] = [];
    if (viaCrew) {
      suggestions.push(`${clash.name} is on ${label(visit.visitId)} with ${clash.crews[0]}, so another person means changing the crew on the crews screen.`);
    } else if (freePeople.length > 0) {
      suggestions.push(`${listOf(freePeople.map((p) => p.name))} ${freePeople.length === 1 ? "has" : "have"} the skills and ${freePeople.length === 1 ? "is" : "are"} free then. Give ${label(visit.visitId)} to ${freePeople.length === 1 ? "them" : "one of them"} on the board.`);
    } else {
      suggestions.push("Nobody else with the skills is free then.");
    }
    const inside = phase?.endsOn && phase.endsOn > date ? `, inside ${phase.name}'s dates` : " in the week after";
    suggestions.push(freeDays.length > 0
      ? `${clash.name} is free at the same time on ${listOf(freeDays.map(dayIn))}${inside}. Move ${label(visit.visitId)} there on the board.`
      : `${clash.name} has no other day free at that time${inside}.`);

    out.push({
      technicianId: clash.personId, name: clash.name, visitId: visit.visitId, phaseId: visit.phaseId,
      otherVisitId: clash.visitIds[1], otherIsProject: byVisit.has(clash.visitIds[1]),
      from: new Date(clash.from).toISOString(), to: new Date(clash.to).toISOString(),
      statement, freePeople, freeDays, suggestions,
    });
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
  applied: {
    at: Date; phaseId: string; days: number; changes: plan.DayChange[];
    /** The day on the phase the days landed from. Null on a change order applied before it was asked. */
    from: string | null;
    /** The visits it moved, and the ones it left where they were with why. Empty before visits moved with the days. */
    visits: AppliedVisits;
  } | null;
  /** Whether applying is possible now, and when it is not, why in a sentence. */
  canApply: boolean;
  reason: string | null;
  /** What would move. Null when nothing can. */
  proposal: {
    changes: plan.DayChange[];
    finishBefore: string | null;
    finishAfter: string | null;
    statement: string;
    /**
     * The first day of the phase the days land on that they push out (or, for
     * days taken off, the first day taken off). Its visits from that day go
     * by the days; `fromChosen` is false for the default, the phase's end.
     */
    from: string;
    fromChosen: boolean;
    /** Visits booked on the phases that move, and on the phase the days land on from `from`: each going, or left where it is and why. */
    visits: { moves: plan.VisitMove[]; left: plan.VisitLeft[] };
    /** What the person was shown. Applying hands it back, and a schedule or a booking that changed since is refused. */
    key: string;
  } | null;
}

export interface AppliedVisits {
  moved: { id: string; label: string; wasStart: string; wasEnd: string | null; start: string; end: string | null; notified: string }[];
  left: { id: string; label: string; wasStart: string; reason: string }[];
}

/**
 * A short fingerprint of exactly which dates a proposal would write, and which
 * visits it would move or leave, so a booking changed since is looked at again.
 */
const keyOf = (changes: readonly plan.DayChange[], visits: { moves: plan.VisitMove[]; left: plan.VisitLeft[] }, from: string) =>
  createHash("sha256")
    .update([
      `from:${from}`,
      ...changes.map((c) => `${c.id}:${c.wasStartsOn}:${c.wasEndsOn}:${c.startsOn}:${c.endsOn}`),
      ...visits.moves.map((v) => `v:${v.id}:${v.wasStart.toISOString()}:${v.start.toISOString()}`),
      ...visits.left.map((v) => `l:${v.id}:${v.wasStart.toISOString()}:${v.reason}`),
    ].join("|"))
    .digest("hex").slice(0, 32);

/**
 * The visits booked on the phases that move, with everybody on each (a crew's
 * members included), and what holds those people's time: their approved time
 * off and their other visits still to come. Read for `core/project.planVisitMoves`.
 */
async function visitsToMove(
  tx: Database, projectId: string, shiftDays: ReadonlyMap<string, number>, zone: string, now: Date,
  target?: { phaseId: string; from: string; days: number },
): Promise<{ moves: plan.VisitMove[]; left: plan.VisitLeft[] }> {
  const phaseIds = [
    ...[...shiftDays.entries()].filter(([, d]) => d !== 0).map(([id]) => id),
    ...(target && target.days !== 0 ? [target.phaseId] : []),
  ];
  if (phaseIds.length === 0) return { moves: [], left: [] };
  const rows = await tx.select({
    id: schema.visit.id, status: schema.visit.status, start: schema.visit.windowStart, end: schema.visit.windowEnd,
    minutes: schema.visit.estimatedDurationMinutes, crewId: schema.visit.crewId,
    phaseId: schema.projectJob.projectPhaseId, jobNumber: schema.job.number, customerName: schema.customer.name,
  }).from(schema.projectJob)
    .innerJoin(schema.visit, eq(schema.visit.jobId, schema.projectJob.jobId))
    .innerJoin(schema.job, eq(schema.job.id, schema.projectJob.jobId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .where(and(eq(schema.projectJob.projectId, projectId), inArray(schema.projectJob.projectPhaseId, phaseIds)));
  const booked = rows.filter((r) => r.start !== null && r.phaseId !== null && !AHEAD_OVER.has(r.status));
  if (booked.length === 0) return { moves: [], left: [] };

  const assigned = await tx.select({
    visitId: schema.visitAssignment.visitId, id: schema.technician.id, name: schema.technician.displayName,
  }).from(schema.visitAssignment)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(inArray(schema.visitAssignment.visitId, booked.map((v) => v.id)));
  const crewIds = [...new Set(booked.map((v) => v.crewId).filter((id): id is string => id !== null))];
  const crewPeople = crewIds.length === 0 ? [] : await tx.select({
    crewId: schema.crewMember.crewId, id: schema.technician.id, name: schema.technician.displayName,
  }).from(schema.crewMember)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.crewMember.technicianId))
    .where(inArray(schema.crewMember.crewId, crewIds));
  const visits: plan.BookedVisit[] = booked.map((v) => ({
    id: v.id, phaseId: v.phaseId!, status: v.status, start: v.start!, end: v.end, minutes: v.minutes,
    label: `${v.customerName}, job ${v.jobNumber}`,
    people: [
      ...assigned.filter((a) => a.visitId === v.id).map((a) => ({ id: a.id, name: a.name })),
      ...crewPeople.filter((c) => c.crewId === v.crewId).map((c) => ({ id: c.id, name: c.name })),
    ],
  }));

  const people = [...new Set(visits.flatMap((v) => v.people.map((p) => p.id)))];
  const away = people.length === 0 ? [] : (await tx.select({
    personId: schema.timeOff.technicianId, start: schema.timeOff.startsAt, end: schema.timeOff.endsAt,
  }).from(schema.timeOff).where(and(
    inArray(schema.timeOff.technicianId, people), eq(schema.timeOff.approved, true), gt(schema.timeOff.endsAt, now),
  )));
  /** Their other visits still to come, by assignment and by crew. */
  const live = notInArray(schema.visit.status, [...AHEAD_OVER] as ("completed" | "cancelled" | "no_show" | "completed_after_cancellation")[]);
  const byAssignment = people.length === 0 ? [] : await tx.select({
    personId: schema.visitAssignment.technicianId, visitId: schema.visit.id,
    start: schema.visit.windowStart, end: schema.visit.windowEnd, minutes: schema.visit.estimatedDurationMinutes,
  }).from(schema.visitAssignment)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
    .where(and(inArray(schema.visitAssignment.technicianId, people), gt(schema.visit.windowStart, now), live));
  const byCrew = people.length === 0 ? [] : await tx.select({
    personId: schema.crewMember.technicianId, visitId: schema.visit.id,
    start: schema.visit.windowStart, end: schema.visit.windowEnd, minutes: schema.visit.estimatedDurationMinutes,
  }).from(schema.crewMember)
    .innerJoin(schema.visit, eq(schema.visit.crewId, schema.crewMember.crewId))
    .where(and(inArray(schema.crewMember.technicianId, people), gt(schema.visit.windowStart, now), live));
  const busy = [...byAssignment, ...byCrew].flatMap((b) => {
    const span = time.visitSpan(b.start, b.end, b.minutes);
    return span ? [{ personId: b.personId, visitId: b.visitId, start: span.start, end: span.end }] : [];
  });
  return plan.planVisitMoves({ visits, shiftDays, timeZone: zone, now, away, busy, target });
}

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
  order: Awaited<ReturnType<typeof loadChangeOrder>>, phaseId: string | undefined, from?: string | undefined,
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
        visits: done.visits ?? { moved: [], left: [] },
        from: done.from ?? null,
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
  /**
   * The day on the phase itself that the days push out from, or are taken
   * off from: chosen by the person, or the careful default, which moves none
   * of the phase's own visits inside its dates (`core/project.landingFrom`).
   */
  const own = decision.changes[0]!;
  const landing = plan.landingFrom(
    { name: own.name, startsOn: own.wasStartsOn, endsOn: own.wasEndsOn }, order.scheduleDays, from,
  );
  if (!landing.ok) return refused(landing.reason);
  /** Each phase whose start moves takes its booked visits with it, by the same days, and so does the target from that day. */
  const shiftDays = new Map(decision.changes
    .filter((c) => c.startsOn !== c.wasStartsOn)
    .map((c) => [c.id, plan.daysBetween(c.wasStartsOn, c.startsOn)]));
  const visits = await visitsToMove(tx, order.projectId, shiftDays, await timezoneOf(tx, organizationId), new Date(), {
    phaseId: own.id, from: landing.from, days: order.scheduleDays,
  });
  return {
    ...base, applied: null, canApply: true, reason: null,
    proposal: {
      changes: decision.changes, finishBefore: decision.finishBefore, finishAfter: decision.finishAfter,
      statement: decision.statement, from: landing.from, fromChosen: Boolean(from), visits,
      key: keyOf(decision.changes, visits, landing.from),
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
  ctx: ServiceContext, input: { id: string; phaseId?: string | undefined; from?: string | undefined },
): Promise<ChangeOrderDaysProposal> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const order = await loadChangeOrder(tx, ctx.actor.organizationId, input.id);
    return proposeIn(tx, ctx.actor.organizationId, order, input.phaseId, input.from);
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
 * instead of pushing every later phase out a second time.
 *
 * THE VISITS GO WITH THEIR PHASES. Each visit the proposal showed moving is
 * moved to its new time, the people on it hear it moved through the visit's
 * notices, and the customer is told through the same visit change notice the
 * office's other moves use, saying it is the change order that moved it.
 * Each visit the proposal showed staying stays, and is named on the change
 * order with why. Moving a booked visit is a decision about the schedule of
 * visits, so it needs `visit:reschedule` as well, which a customer service
 * seat does not hold: they are told so and can apply a proposal that moves
 * no visit. If a phase move still leaves somebody booked twice, the schedule
 * flags it and leaves it to a person.
 */
export async function applyChangeOrderDays(
  ctx: ServiceContext, input: { id: string; phaseId?: string | undefined; from?: string | undefined; proposalKey: string },
): Promise<ChangeOrderDaysProposal & { alreadyApplied: boolean }> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [locked] = await tx.select({ id: schema.projectChangeOrder.id }).from(schema.projectChangeOrder)
      .where(and(
        eq(schema.projectChangeOrder.id, input.id),
        eq(schema.projectChangeOrder.organizationId, ctx.actor.organizationId),
      )).for("update").limit(1);
    if (!locked) throw new NotFoundError("Change order");
    const order = await loadChangeOrder(tx, ctx.actor.organizationId, input.id);

    const seen = await proposeIn(tx, ctx.actor.organizationId, order, input.phaseId, input.from);
    if (seen.applied) return { ...seen, alreadyApplied: true };
    if (!seen.canApply || !seen.proposal) throw new ConflictError(seen.reason ?? "Nothing to apply.");
    if (seen.proposal.key !== input.proposalKey) {
      throw new ConflictError("The schedule changed since you looked at this proposal, or a booked visit did. Look at it again before you apply it.");
    }
    if (seen.proposal.visits.moves.length > 0) assertCan(ctx.actor, "visit:reschedule");

    for (const change of seen.proposal.changes) {
      await tx.update(schema.projectPhase).set({
        startsOn: change.startsOn, endsOn: change.endsOn, updatedAt: new Date(),
      }).where(eq(schema.projectPhase.id, change.id));
    }
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const visits: AppliedVisits = { moved: [], left: [] };
    for (const move of seen.proposal.visits.moves) {
      const before = await sideOf(tx, move.id);
      await tx.update(schema.visit).set({ windowStart: move.start, windowEnd: move.end, updatedAt: new Date() })
        .where(eq(schema.visit.id, move.id));
      if (before) await announce(tx, ctx, move.id, before);
      const shift = plan.daysBetween(time.dateIn(move.wasStart, zone), time.dateIn(move.start, zone));
      const notified = await officeMoved(tx, ctx, {
        visitId: move.id, was: { start: move.wasStart, end: move.wasEnd },
        because: `because the change to your project you agreed (change order ${order.number}) moves this part of the work `
          + `${Math.abs(shift)} ${Math.abs(shift) === 1 ? "day" : "days"} ${shift > 0 ? "later" : "earlier"}`,
      });
      visits.moved.push({
        id: move.id, label: move.label, wasStart: move.wasStart.toISOString(), wasEnd: move.wasEnd?.toISOString() ?? null,
        start: move.start.toISOString(), end: move.end?.toISOString() ?? null, notified,
      });
    }
    for (const stay of seen.proposal.visits.left) {
      visits.left.push({ id: stay.id, label: stay.label, wasStart: stay.wasStart.toISOString(), reason: stay.reason });
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
        visits,
        from: seen.proposal.from,
      },
      updatedAt: at,
    }).where(eq(schema.projectChangeOrder.id, order.id));
    await audit(tx, ctx, "project_change_order.schedule_applied", "project_change_order", order.id,
      { scheduleAppliedAt: null },
      { phaseId: seen.phaseId, days: order.scheduleDays, from: seen.proposal.from, changes: seen.proposal.changes, visits });
    const after = await loadChangeOrder(tx, ctx.actor.organizationId, order.id);
    return { ...(await proposeIn(tx, ctx.actor.organizationId, after, undefined)), alreadyApplied: false };
  });
}

export const handlers = {
  getProjectSchedule: (ctx: ServiceContext, input: { projectId: string }) => schedule(ctx, input),
  moveProjectPhase: (ctx: ServiceContext, input: { id: string; startsOn: string }) => move(ctx, input),
  setProjectPhaseDates: (ctx: ServiceContext, input: { id: string; startsOn: string | null; endsOn: string | null }) =>
    setDates(ctx, input),
  getChangeOrderScheduleDays: (ctx: ServiceContext, input: { id: string; phaseId?: string | undefined; from?: string | undefined }) =>
    proposeChangeOrderDays(ctx, input),
  applyChangeOrderScheduleDays: (ctx: ServiceContext, input: {
    id: string; phaseId?: string | undefined; from?: string | undefined; proposalKey: string;
  }) =>
    applyChangeOrderDays(ctx, input),
} as const;
