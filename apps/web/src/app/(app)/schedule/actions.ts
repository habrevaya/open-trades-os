"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dispatch, dispatchMap, liveLocation } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { refusalOf } from "@/lib/actions";

/**
 * The board's two gestures: drop a card on somebody, and drag it up or down,
 * and the two suggestions that end in one of them.
 *
 * Both return a message rather than throwing. A dispatcher who just dragged a
 * card wants to know it did not take and why, in place, and an error boundary
 * that replaces the whole board loses the rest of their day's context along
 * with it.
 */
export async function assignVisit(input: {
  visitId: string;
  technicianId: string;
  date: string;
  /** Send them although the qualification check refused, with the reason the audit log keeps. */
  overrideReason?: string;
}): Promise<
  | { ok: true; unknownSkills: string[]; droppedSkills: { skill: string; reason: string }[] }
  | { ok: false; message: string; qualification?: { mayOverride: boolean } }
> {
  const user = await requireSetupUser();

  let unknownSkills: string[] = [];
  let droppedSkills: { skill: string; reason: string }[] = [];
  try {
    const result = await dispatch.assign(
      { actor: user.actor, db: getDb() },
      {
        id: input.visitId,
        technicianIds: [input.technicianId],
        ...(input.overrideReason ? { overrideQualification: { reason: input.overrideReason } } : {}),
      },
    );
    unknownSkills = result.unknownSkills;
    droppedSkills = result.droppedSkills;
  } catch (error) {
    /**
     * A qualification refusal comes back with whether this person may send
     * them anyway, so the board offers the override to the people who hold
     * it and only to them, rather than offering a button that is refused.
     */
    const qualification = (error as { qualificationRefused?: boolean }).qualificationRefused
      ? { mayOverride: can(user.actor, "visit:assign_unqualified") }
      : undefined;
    return {
      ok: false,
      message: refusalOf(error) ?? "That did not take. Reload the board and try again.",
      ...(qualification ? { qualification } : {}),
    };
  }

  revalidatePath("/schedule");
  return { ok: true, unknownSkills, droppedSkills };
}

/**
 * The optimiser's proposal for one person's day. A read: nothing moves until
 * the dispatcher presses the button that sends `applyOrder` to `reorderDay`.
 */
export async function proposeRoute(input: { technicianId: string; date: string }): Promise<
  | { ok: true; proposal: Awaited<ReturnType<typeof dispatchMap.optimise>> }
  | { ok: false; message: string }
> {
  const user = await requireSetupUser();
  try {
    return { ok: true, proposal: await dispatchMap.optimise({ actor: user.actor, db: getDb() }, input) };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "No proposal could be made. Reload the board and try again." };
  }
}

/** Who should take each unassigned visit. Also a read. */
export async function suggestAssignments(input: { date: string }): Promise<
  | { ok: true; result: Awaited<ReturnType<typeof dispatchMap.suggestions>> }
  | { ok: false; message: string }
> {
  const user = await requireSetupUser();
  try {
    return { ok: true, result: await dispatchMap.suggestions({ actor: user.actor, db: getDb() }, input) };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "No suggestions could be made. Reload the board and try again." };
  }
}

export async function reorderDay(input: {
  technicianId: string;
  date: string;
  visitIds: string[];
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = await requireSetupUser();

  try {
    await dispatch.reorder(
      { actor: user.actor, db: getDb() },
      { technicianId: input.technicianId, date: input.date, visitIds: input.visitIds },
    );
  } catch (error) {
    return {
      ok: false,
      message: refusalOf(error) ?? "The order did not save. Reload the board.",
    };
  }

  revalidatePath("/schedule");
  return { ok: true };
}

/**
 * Lock a visit to whoever has it, or let it go. The rebalance and the route
 * optimiser leave a locked visit where it is.
 */
export async function lockVisit(input: { visitId: string; locked: boolean }): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = await requireSetupUser();
  try {
    await dispatchMap.lockVisit({ actor: user.actor, db: getDb() }, { id: input.visitId, locked: input.locked });
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "The lock did not save. Reload the board." };
  }
  revalidatePath("/schedule");
  return { ok: true };
}

/**
 * Where people are now, for the map's live pins, asked every half minute by
 * the map while it is open. Only somebody who dispatches is answered.
 */
export async function livePositions(): Promise<
  | { ok: true; live: Awaited<ReturnType<typeof liveLocation.latest>> }
  | { ok: false; message: string }
> {
  const user = await requireSetupUser();
  try {
    return { ok: true, live: await liveLocation.latest({ actor: user.actor, db: getDb() }) };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "Where people are could not be read." };
  }
}
