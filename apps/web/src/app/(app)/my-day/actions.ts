"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fieldOps, dispatch } from "@opentradesos/api/services";
import type { syncOperations } from "@opentradesos/api/contracts";
import type { z } from "zod";

type Operations = z.infer<typeof syncOperations.input>["operations"];

/**
 * The one write path from the phone.
 *
 * Everything the technician does goes through the same sync endpoint as the
 * native app will, rather than through a set of convenience endpoints. Two
 * write paths into the same tables is two sets of conflict rules, and the
 * second one is always the one that forgets the case where the office moved
 * something while the phone was underground.
 */
export async function sync(input: {
  deviceId: string;
  operations: Operations;
}): Promise<
  | { ok: true; results: Awaited<ReturnType<typeof fieldOps.sync>>["results"] }
  | { ok: false; message: string }
> {
  const user = await requireSetupUser();

  try {
    const response = await fieldOps.sync(
      { actor: user.actor, db: getDb() },
      { deviceId: input.deviceId, operations: input.operations },
    );
    revalidatePath("/my-day");
    return { ok: true, results: response.results };
  } catch (error) {
    /**
     * Returned rather than thrown. The caller is a queue that will try again,
     * and an exception here would be indistinguishable from the network being
     * down, which is the one case it must NOT treat as fatal.
     */
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Sync failed",
    };
  }
}

/**
 * The result comes back, and the screen says it.
 *
 * This used to throw away what the service returned and report `ok: true`
 * whenever nothing threw. Since the service sent nothing at all, that was
 * consistent, and both halves were wrong together. Now that a send can be
 * refused for a reason the technician can act on, "they replied STOP, phone
 * them" has to reach the person standing in the driveway.
 */
export async function onMyWay(input: {
  visitId: string;
  etaMinutes?: number;
}): Promise<{ ok: boolean; sent?: boolean; message?: string }> {
  const user = await requireSetupUser();
  try {
    const result = await dispatch.onMyWay(
      { actor: user.actor, db: getDb() },
      {
        id: input.visitId,
        channel: "sms",
        includeTracking: true,
        ...(input.etaMinutes !== undefined ? { etaMinutes: input.etaMinutes } : {}),
      },
    );
    revalidatePath("/my-day");
    return {
      ok: true,
      sent: result.sent,
      ...(result.reason ? { message: result.reason } : {}),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not send" };
  }
}
