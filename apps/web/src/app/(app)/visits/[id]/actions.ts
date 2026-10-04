"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dispatchDays } from "@opentradesos/api/services";
import { setVisitMovable } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * The days the customer agreed this visit may happen on. Read by the multi
 * day rebalance and nothing else, so saving it moves nothing.
 */
export async function movableAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const clear = form.get("clear") === "yes";
    const input = parsed(setVisitMovable.input, {
      id,
      from: clear ? null : field(form, "from") ?? null,
      until: clear ? null : field(form, "until") ?? null,
    });
    await dispatchDays.setVisitMovable({ actor: (await requireSetupUser()).actor, db: getDb() }, input);
    return {
      message: clear || (!input.from && !input.until)
        ? "Cleared. The visit stays on its day unless the customer's days of the week allow another."
        : "Saved. Rebalancing several days may now move it to another day inside these, and the customer is told when it does.",
    };
  });
  if (state?.done) revalidatePath(`/visits/${id}`);
  return state;
}
