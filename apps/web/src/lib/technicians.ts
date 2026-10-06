import "server-only";
import { dispatch, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { todayIn } from "./dates";
import type { TechnicianChoice } from "@/components/VisitFields";

/**
 * Who can be sent, read from the dispatch board rather than a list of its
 * own, so the people a booking offers are exactly the columns a dispatcher
 * sees, with today's time off marked the same way.
 *
 * Empty for somebody who may not read the board: they can still book, and
 * the visit goes on the board unassigned for somebody who can.
 */
export async function technicianChoices(ctx: ServiceContext, timezone: string): Promise<TechnicianChoice[]> {
  if (!can(ctx.actor, "visit:read")) return [];
  const board = await dispatch.board(ctx, { date: todayIn(timezone) });
  return board.technicians.map((t) => ({ id: t.id, displayName: t.displayName, away: t.timeOffWholeDay }));
}
