"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fieldOps, dispatch, fieldPayments } from "@opentradesos/api/services";
import type { syncOperations } from "@opentradesos/api/contracts";
import type { z } from "zod";
import { refusalOf } from "@/lib/actions";

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
    /*
      A refusal is the service's own sentence (a revoked device, an account
      that is no longer a technician), and the phone shows it beside the
      button that was pressed. Anything else is a fault, logged here and
      described to the technician without a stack of database words.
    */
    const refusal = refusalOf(error);
    if (refusal === null) console.error("field sync failed", error);
    return {
      ok: false,
      message: refusal
        ?? "The office's system could not record this. It is kept on your phone and will be sent again.",
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

/**
 * A card, through the link the customer already gets for their invoice.
 *
 * Sent there and then or not at all, like the text that says you are on
 * your way: the customer is stood beside the technician, and a link that
 * arrives an hour later from a queue is a payment that did not happen. The
 * refusal comes back in the service's own words, because "there is no
 * invoice yet" and "card payments are not connected" each tell the
 * technician to do something different.
 */
export async function paymentLink(input: { visitId: string; text: boolean }): Promise<
  | { ok: true; url: string; texted: boolean; message: string | null; amountDue: string }
  | { ok: false; message: string }
> {
  const user = await requireSetupUser();
  try {
    const result = await fieldPayments.paymentLink(
      { actor: user.actor, db: getDb() },
      { id: input.visitId, text: input.text },
    );
    return { ok: true, url: result.url, texted: result.texted, message: result.reason, amountDue: result.amountDue };
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) console.error("payment link failed", error);
    return { ok: false, message: refusal ?? "The link could not be made. Take cash or a check, or ask the office." };
  }
}
