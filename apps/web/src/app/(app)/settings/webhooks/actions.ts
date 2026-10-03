"use server";

import { attempt, field, fields, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { webhooks } from "@opentradesos/api/services";

/**
 * Registering an endpoint, switching one on and off, removing one, and sending
 * what it was sent again.
 *
 * Every refusal is the service's own sentence. The two worth not softening are
 * a subscription to an event nothing emits, which is a receiver somebody will
 * build and that will never be called, and a replay of an event the endpoint
 * never subscribed to, which was never sent there and has nothing to send
 * again.
 */
export async function act(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "register": {
        const endpoint = await webhooks.register(ctx, {
          url: field(form, "url") ?? "",
          events: fields(form, "events"),
        });
        return {
          secret: {
            value: endpoint.secret,
            caption:
              "This is the signing secret for that endpoint. Copy it into the receiver now: it is not "
              + "shown again, and every delivery is signed with it.",
          },
        };
      }

      case "on":
        await webhooks.update(ctx, { id, active: true });
        return { message: "Switched on. It carries on from where it stopped." };

      case "off":
        await webhooks.update(ctx, { id, active: false });
        return { message: "Switched off. Nothing is sent to it until it is switched back on." };

      case "remove":
        await webhooks.remove(ctx, { id });
        return { message: "Removed. Its history stays on the record." };

      case "replay-delivery":
        await webhooks.requestReplay(ctx, { id, deliveryId: String(form.get("deliveryId") ?? "") });
        return { message: "Queued. It goes on the next pass, signed again." };

      case "replay-from": {
        const from = Number(field(form, "fromSequence") ?? "");
        const through = field(form, "throughSequence");
        const replay = await webhooks.requestReplay(ctx, {
          id,
          fromSequence: from,
          ...(through ? { throughSequence: Number(through) } : {}),
        });
        return {
          message: `Queued events ${replay.fromSequence} to ${replay.throughSequence}. `
            + "They go in order on the next pass, after anything new.",
        };
      }

      default:
        throw new Error(`Unknown op: ${op}`);
    }
  });

  if (state?.done) revalidatePath("/settings/webhooks");
  return state;
}
