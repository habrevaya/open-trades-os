"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { externalWork } from "@opentradesos/api/services";

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
