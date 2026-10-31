"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { externalWork, externalWorkCodes } from "@opentradesos/api/services";

export type ExternalState = FormState;

/**
 * Moving an order on our side, and recording what the client's system was told.
 *
 * Nothing here decides what is allowed. The asymmetry is the module's: a
 * contractor cannot declare that the client cancelled it or sent it back, because
 * either would let a missed deadline be rewritten as the client's doing, and the
 * screen offers only what `weMayMoveTo` already says is possible.
 *
 * The push is SEPARATE from the move, and that is the module's shape rather than
 * an extra step: one is a dispatcher deciding something, the other is a network
 * accepting it. Collapsing them would mean a push that failed left the order
 * looking as though nobody had decided anything.
 */
export async function act(_previous: ExternalState, form: FormData): Promise<ExternalState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "move":
        await externalWork.move(ctx, {
          id,
          to: String(form.get("to") ?? ""),
          /**
           * A job only when accepting. The service refuses a job on a rejected
           * order, because work nobody is doing sitting on the board and in the
           * margin report is worse than an order with no job.
           */
          jobId: field(form, "jobId") ?? null,
          ...(field(form, "note") ? { note: field(form, "note")! } : {}),
        });
        return;
      case "invoice":
        await externalWork.acceptViaInvoice(ctx, {
          id, invoiceId: String(form.get("invoiceId") ?? ""),
        });
        return;
      case "pushed":
        await externalWork.pushed(ctx, { id });
        return;
      case "push-failed":
        /**
         * A failure KEEPS it in the queue, which is the whole point: an order
         * whose push failed and left the queue is a contractor whose scorecard
         * says they never responded.
         */
        await externalWork.pushFailed(ctx, { id, error: String(form.get("error") ?? "") });
        return;
      default:
        throw new Error(`Unknown external work operation: ${op}`);
    }
  });

  if (state?.done) revalidatePath("/contracts/external");
  return state;
}

/* ------------------------------------------- a client's codes, mapped to ours */

/**
 * A client's whole list of codes, saved as one, the way the page shows it. A
 * row with no code is an empty row and is left out; a row taken off the form is
 * taken off the list. Every refusal is the service's own sentence.
 */
export async function saveCodes(_previous: ExternalState, form: FormData): Promise<ExternalState> {
  const customerId = field(form, "customerId") ?? "";
  const rows = Math.min(Number(field(form, "rows") ?? "0") || 0, 200);
  const codes: Array<{ code: string; description: string | null; jobTypeId: string | null; priceBookItemId: string | null; quantity: string }> = [];
  for (let i = 0; i < rows; i += 1) {
    const code = field(form, `code.${i}`);
    if (!code) continue;
    codes.push({
      code,
      description: field(form, `description.${i}`) ?? null,
      jobTypeId: field(form, `jobTypeId.${i}`) ?? null,
      priceBookItemId: field(form, `itemId.${i}`) ?? null,
      quantity: field(form, `quantity.${i}`) ?? "1",
    });
  }
  const state = await attempt(form, async () => {
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
    const saved = await externalWorkCodes.setCodes(ctx, { customerId, codes });
    return { message: `Saved. ${saved.data.length} ${saved.data.length === 1 ? "code" : "codes"} on the list.` };
  });
  if (state?.done) revalidatePath(`/contracts/external/codes/${customerId}`);
  return state;
}

/** Which client an order is for. Refused by the service once the order has a job. */
export async function saveClient(_previous: ExternalState, form: FormData): Promise<ExternalState> {
  const id = field(form, "id") ?? "";
  const state = await attempt(form, async () => {
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
    const order = await externalWorkCodes.setClient(ctx, { id, customerId: field(form, "customerId") ?? "" });
    return { message: `Saved. This order is for ${order.clientName}.` };
  });
  if (state?.done) {
    revalidatePath(`/contracts/external/${id}`);
    revalidatePath("/contracts/external");
  }
  return state;
}

/**
 * Accept the order and make its job from the proposal on the screen. The key of
 * what was shown goes with it, so a list changed in between is refused rather
 * than used, and the form's own key makes a double press one job.
 */
export async function acceptAsProposed(_previous: ExternalState, form: FormData): Promise<ExternalState> {
  const id = field(form, "id") ?? "";
  const formKey = field(form, "formKey");
  const state = await attempt(form, async () => {
    const ctx = {
      actor: (await requireSetupUser()).actor, db: getDb(),
      ...(formKey ? { idempotencyKey: `accept-as-proposed:${formKey}` } : {}),
    };
    const summary = field(form, "summary");
    await externalWorkCodes.acceptAsProposed(ctx, {
      id,
      key: field(form, "key") ?? "",
      propertyId: field(form, "propertyId") ?? "",
      jobTypeId: field(form, "jobTypeId") ?? null,
      ...(summary ? { summary } : {}),
    });
    return { message: "Accepted. The job is made, and the client is owed word that we accepted." };
  });
  if (state?.done) {
    revalidatePath(`/contracts/external/${id}`);
    revalidatePath("/contracts/external");
  }
  return state;
}
