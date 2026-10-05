"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dispatchDays } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";

/**
 * Apply the days the dispatcher was looking at. The key is minted when the
 * page was drawn, so a double press is one application; the basis makes a
 * proposal about days that have since moved a refusal in words.
 */
export async function applyDays(input: {
  from: string;
  days: number;
  basis: string;
  key: string;
  dayMoves: { visitId: string; toDate: string; technicianId?: string | undefined; crewId?: string | undefined }[];
  moves: { visitId: string; technicianId?: string | undefined; crewId?: string | undefined }[];
  orders: { date: string; technicianId: string; visitIds: string[] }[];
  crewOrders: { date: string; crewId: string; visitIds: string[] }[];
}): Promise<{ ok: true; movedDays: number; told: number } | { ok: false; message: string }> {
  const user = await requireSetupUser();
  try {
    const result = await dispatchDays.applyRebalanceDays(
      { actor: user.actor, db: getDb(), idempotencyKey: `rebalance-days:${input.key}` },
      {
        from: input.from, days: input.days, basis: input.basis,
        dayMoves: input.dayMoves, moves: input.moves, orders: input.orders, crewOrders: input.crewOrders,
      },
    );
    revalidatePath("/schedule");
    return { ok: true, movedDays: result.movedDays, told: result.told.filter((t) => t.notified === "queued").length };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "Nothing was changed. Propose it again and try once more." };
  }
}
