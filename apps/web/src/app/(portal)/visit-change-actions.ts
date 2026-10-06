"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { visitChanges } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";

export type VisitChangeResult = { ok: true } | { ok: false; message: string };

/**
 * Asking to move or cancel a visit, from the customer's own device.
 *
 * Everything that decides comes from the service: which visit the link
 * reaches, whether the window is open, whether a reason is needed. A refusal
 * is shown in the service's own words, because they are written for the
 * person reading them; anything else is a fault and says so plainly rather
 * than leaving somebody believing they asked.
 */
export async function requestVisitChange(input: {
  token: string;
  visitId?: string | undefined;
  kind: "reschedule" | "cancel";
  requestedDate?: string | undefined;
  arrivalWindowId?: string | undefined;
  reason?: string | undefined;
  /** Where the page that asked lives, so it shows the request once it is made. */
  path: string;
}): Promise<VisitChangeResult> {
  const h = await headers();
  try {
    await visitChanges.request(getDb(), {
      token: input.token,
      ...(input.visitId ? { visitId: input.visitId } : {}),
      kind: input.kind,
      ...(input.requestedDate ? { requestedDate: input.requestedDate } : {}),
      ...(input.arrivalWindowId ? { arrivalWindowId: input.arrivalWindowId } : {}),
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    }, { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() });
  } catch (error) {
    const said = refusalOf(error);
    return {
      ok: false,
      message: said ?? "Something went wrong sending that. Please reply to the message that brought you here.",
    };
  }
  revalidatePath(input.path);
  return { ok: true };
}

/**
 * Taking or turning down the time the office offered, from the link. The
 * service decides everything; a refusal is shown in its words.
 */
export async function answerVisitChangeProposal(input: {
  token: string;
  visitId?: string | undefined;
  accept: boolean;
  answer?: string | undefined;
  path: string;
}): Promise<VisitChangeResult> {
  const h = await headers();
  try {
    await visitChanges.answer(getDb(), {
      token: input.token,
      ...(input.visitId ? { visitId: input.visitId } : {}),
      accept: input.accept,
      ...(input.answer?.trim() ? { answer: input.answer.trim() } : {}),
    }, { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() });
  } catch (error) {
    return {
      ok: false,
      message: refusalOf(error) ?? "Something went wrong sending that. Please reply to the message that brought you here.",
    };
  }
  revalidatePath(input.path);
  return { ok: true };
}
