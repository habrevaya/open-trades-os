"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dispatch } from "@opentradesos/api/services";
import { ConflictError } from "@opentradesos/api/services";

/**
 * The board's two gestures: drop a card on somebody, and drag it up or down.
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
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = await requireSetupUser();

  try {
    await dispatch.assign(
      { actor: user.actor, db: getDb() },
      { id: input.visitId, technicianIds: [input.technicianId] },
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ConflictError
        ? error.message
        : "That did not take. Reload the board and try again.",
    };
  }

  revalidatePath("/schedule");
  return { ok: true };
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
      message: error instanceof ConflictError
        ? error.message
        : "The order did not save. Reload the board.",
    };
  }

  revalidatePath("/schedule");
  return { ok: true };
}
