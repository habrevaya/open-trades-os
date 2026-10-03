"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dispatchMap } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";

/**
 * Apply the rebalance the dispatcher was looking at. The key is minted when
 * the page was drawn, so a double press is one application, and the basis
 * makes a proposal about a board that has since moved a refusal in words.
 */
export async function applyRebalance(input: {
  date: string;
  basis: string;
  key: string;
  moves: { visitId: string; technicianId: string }[];
  orders: { technicianId: string; visitIds: string[] }[];
}): Promise<{ ok: true; moved: number } | { ok: false; message: string }> {
  const user = await requireSetupUser();
  try {
    const result = await dispatchMap.applyRebalance(
      { actor: user.actor, db: getDb(), idempotencyKey: `rebalance:${input.key}` },
      { date: input.date, basis: input.basis, moves: input.moves, orders: input.orders },
    );
    revalidatePath("/schedule");
    return { ok: true, moved: result.moved };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "The day was not changed. Propose it again and try once more." };
  }
}
