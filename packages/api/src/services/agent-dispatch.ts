import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { agents as a, assertCan } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, ConflictError, type ServiceContext,
} from "./context";
import * as dispatchMap from "./dispatch-map";
import * as dispatch from "./dispatch";
import * as base from "./agents";
import { companyOf } from "./agent-facts";
import type { AiDeps } from "./ai";

/**
 * THE DISPATCH COPILOT
 *
 * The board already knows who MAY take each open visit and what each choice
 * costs: the route optimiser works out the extra driving and who would be made
 * late, and the qualification check refuses anybody without the skills or on
 * time off (`dispatch-map.suggestions`). What a dispatcher does not get from a
 * table of minutes is the sentence: "Ray, because he is already two streets
 * away and Sam is not gas certified."
 *
 * So the copilot is handed the optimiser's answer and the board's refusals,
 * chooses only among the people the board allows (`holdPicks` drops anybody
 * else and says so), and explains each choice in plain words. A dispatcher
 * applies it, all or some, and each assignment is made by the board's own
 * assignment call with its qualification check run again at that moment. It
 * never applies itself: putting people on a day stays with a person.
 */

interface PlanDraft {
  date: string;
  summary: string;
  assignments: {
    visitId: string; customerName: string; window: string | null;
    technicianId: string; technicianName: string; why: string;
    addedDriveMinutes: number | null; matchesOptimiser: boolean;
  }[];
  dropped: string[];
  nobodyMay: string[];
}

const clock = (at: Date, timezone: string) =>
  at.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });

/** Ask the copilot about a day, as the dispatcher asking. */
export async function plan(ctx: ServiceContext, input: { date: string }, deps: AiDeps = base.DEFAULT_AGENT_DEPS) {
  assertCan(ctx.actor, "visit:read");
  const replay = await inTenant(ctx, (tx) => base.proposalByKey(tx, ctx.idempotencyKey));
  if (replay) return base.shape(replay);

  const acting = await base.actingAs(ctx.db, ctx.actor.organizationId, "dispatch", ctx);
  if (!acting.ok) throw new ConflictError(acting.reason);
  if (!acting.settings.enabled) throw new ConflictError("The dispatch copilot is off. An owner can turn it on under Settings, AI agents.");

  const board = await dispatchMap.suggestions(acting.ctx, { date: input.date });
  if (board.suggestions.length === 0) {
    throw new ConflictError(board.unplaced.length > 0
      ? "The open visits on this day have no address on the map, so nothing can be measured. Place them first."
      : "Nothing is waiting to be assigned on this day.");
  }
  const now = (deps.now ?? (() => new Date()))();
  const { company, windows } = await inTenant(acting.ctx, async (tx) => {
    const company = await companyOf(tx, ctx.actor.organizationId, now);
    const rows = await tx.select({ id: schema.visit.id, start: schema.visit.windowStart, end: schema.visit.windowEnd })
      .from(schema.visit).where(inArray(schema.visit.id, board.suggestions.map((s) => s.visitId)));
    return {
      company,
      windows: new Map(rows.map((r) => [r.id, r.start && r.end ? `${clock(r.start, company.timezone)} to ${clock(r.end, company.timezone)}` : null])),
    };
  });

  const visits: a.CopilotVisit[] = board.suggestions.map((s) => ({
    visitId: s.visitId,
    customerName: s.customerName ?? "A customer",
    window: windows.get(s.visitId) ?? null,
    suggested: s.technicianId
      ? { technicianId: s.technicianId, technicianName: s.technicianName ?? "", addedDriveMinutes: s.addedDriveMinutes }
      : null,
    considered: s.considered.map((c) => ({
      technicianId: c.technicianId, technicianName: c.technicianName,
      addedDriveMinutes: c.addedDriveMinutes, makesLate: c.makesLate, refused: c.refused,
    })),
  }));
  const candidates: a.DispatchCandidate[] = visits.map((v) => ({
    visitId: v.visitId, allowed: v.considered.filter((c) => c.refused === null).map((c) => c.technicianId),
  }));

  const prompt = a.dispatchPrompt({ company, tone: acting.settings.tone, date: input.date, visits });
  const answer = await base.ask(acting, "dispatch", prompt, "dispatch:plan", deps);
  if (!answer.ok) throw new ConflictError(answer.reason);

  const picks = answer.input["assignments"] as { visitId: string; technicianId: string; why: string }[];
  const held = a.holdPicks(picks, candidates);
  if (held.dropped.length > 0) {
    await inTenant(acting.ctx, (tx) => base.note(tx, acting.ctx, {
      agent: "dispatch", kind: "refused", detail: held.dropped.join(" "),
    }));
  }
  const byVisit = new Map(visits.map((v) => [v.visitId, v]));
  const body: PlanDraft = {
    date: input.date,
    summary: String(answer.input["summary"]),
    assignments: held.kept.map((pick) => {
      const visit = byVisit.get(pick.visitId)!;
      const chosen = visit.considered.find((c) => c.technicianId === pick.technicianId)!;
      return {
        visitId: pick.visitId, customerName: visit.customerName, window: visit.window,
        technicianId: pick.technicianId, technicianName: chosen.technicianName, why: pick.why,
        addedDriveMinutes: chosen.addedDriveMinutes,
        matchesOptimiser: visit.suggested?.technicianId === pick.technicianId,
      };
    }),
    dropped: held.dropped,
    nobodyMay: visits.filter((v) => !v.suggested).map((v) => v.customerName),
  };

  const { row } = await inTenant(acting.ctx, async (tx) => {
    await tx.update(schema.aiAgentProposal).set({ status: "superseded", updatedAt: new Date() })
      .where(and(
        eq(schema.aiAgentProposal.agent, "dispatch"), eq(schema.aiAgentProposal.sourceKind, "schedule_day"),
        eq(schema.aiAgentProposal.sourceId, input.date), eq(schema.aiAgentProposal.status, "proposed"),
      ));
    return base.propose(tx, acting, {
      agent: "dispatch", action: "propose_assignments", sourceKind: "schedule_day", sourceId: input.date,
      summary: `${input.date}: ${body.assignments.length} of ${visits.length} open visit${visits.length === 1 ? "" : "s"} placed`,
      draft: body as unknown as Record<string, unknown>, usageId: answer.usageId,
      idempotencyKey: ctx.idempotencyKey,
    });
  });
  return base.shape(row);
}

/**
 * Apply the copilot's plan, or the visits of it the dispatcher ticked.
 *
 * Each assignment is `dispatch.assign`, the board's own call, so the
 * qualification check runs again now rather than trusting the moment the plan
 * was written. A visit somebody assigned by hand meanwhile is left alone and
 * said, rather than taken off them.
 */
export async function apply(ctx: ServiceContext, input: { id: string; visitIds?: string[] | undefined }) {
  const row = await guardedRead(ctx, "visit:dispatch", (tx) => base.proposalWithin(tx, "dispatch", input.id));
  if (row.status === "applied") return base.shape(row);
  if (row.status !== "proposed") throw new ConflictError(`This plan was ${row.status}. Ask the copilot again.`);
  const body = row.draft as unknown as PlanDraft;
  const chosen = body.assignments.filter((x) => !input.visitIds || input.visitIds.includes(x.visitId));
  if (chosen.length === 0) throw new ConflictError("Tick at least one assignment to apply.");

  const taken = await guardedRead(ctx, "visit:dispatch", async (tx) => {
    const rows = await tx.select({ visitId: schema.visitAssignment.visitId }).from(schema.visitAssignment)
      .where(inArray(schema.visitAssignment.visitId, chosen.map((x) => x.visitId)));
    return new Set(rows.map((r) => r.visitId));
  });

  const assigned: string[] = [];
  const failed: { visitId: string; reason: string }[] = [];
  for (const assignment of chosen) {
    if (taken.has(assignment.visitId)) {
      failed.push({ visitId: assignment.visitId, reason: `${assignment.customerName} was put on somebody's day meanwhile, so it was left as it is.` });
      continue;
    }
    try {
      await dispatch.assign({ ...ctx, idempotencyKey: `ai-dispatch:${row.id}:${assignment.visitId}` }, {
        id: assignment.visitId, technicianIds: [assignment.technicianId],
      });
      assigned.push(assignment.visitId);
    } catch (error) {
      failed.push({ visitId: assignment.visitId, reason: error instanceof Error ? error.message : "It could not be assigned." });
    }
  }
  if (assigned.length === 0) {
    throw new ConflictError(`Nothing was assigned. ${failed.map((f) => f.reason).join(" ")}`);
  }
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    const applied = await base.markApplied(tx, ctx, row, {
      automatic: false,
      outcome: { assigned, failed },
      detail: `Applied ${assigned.length} assignment${assigned.length === 1 ? "" : "s"} for ${body.date}${failed.length ? `; ${failed.length} left as they were` : ""}.`,
    });
    return base.shape(applied);
  });
}

export const handlers = {
  listDispatchPlans: (ctx: ServiceContext, input: { date?: string | undefined; limit?: number | undefined }) =>
    base.proposals(ctx, "visit:read", "dispatch", {
      ...(input.date ? { sourceKind: "schedule_day", sourceId: input.date } : {}),
      limit: input.limit,
    }),
  createDispatchPlan: (ctx: ServiceContext, input: { date: string }) => plan(ctx, input),
  applyDispatchPlan: (ctx: ServiceContext, input: { id: string; visitIds?: string[] | undefined }) => apply(ctx, input),
  dismissDispatchPlan: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    base.dismiss(ctx, "visit:dispatch", "dispatch", input),
} as const;
