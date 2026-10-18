"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dispatchDays, productsApplied, visitCancellations } from "@opentradesos/api/services";
import { recordVisitProduct, setVisitMovable } from "@opentradesos/api/contracts";
import { attempt, field, parsed, refused, type FormState } from "@/lib/actions";
import { instantFromLocal } from "@/lib/local-time";

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

/**
 * Calling off this one visit, saying who asked. Who is required and has no
 * default: whether a customer cancelled late or the company called off a
 * rain day is the whole difference on the cancellation rate, and a default
 * would decide it for whoever is in a hurry. When is read in the company's
 * zone and is optional, for a call the office took earlier than now.
 */
export async function cancelVisitAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const by = field(form, "by");
  if (by !== "customer" && by !== "company") return refused(form, "Say who asked to call it off: the customer, or us.");
  const user = await requireSetupUser();
  const askedAt = instantFromLocal(field(form, "askedAt"), user.organizationTimezone);
  const state = await attempt(form, async () => {
    const done = await visitCancellations.cancel({ actor: user.actor, db: getDb() }, {
      id, by, ...(askedAt ? { askedAt } : {}),
    });
    return {
      message: by === "company"
        ? "Called off. It is left out of the customer cancellation rate, and whoever was on it has been told not to go."
        : done.late
          ? `Called off. It came inside the ${done.cancelNoticeHours} hour notice window, so it counts as a late cancellation.`
          : "Called off, with enough notice. Whoever was on it has been told not to go.",
    };
  });
  if (state?.done) revalidatePath(`/visits/${id}`);
  return state;
}

/**
 * A product the technician did not record, chosen from the price book's
 * chemicals and written to the visit's report as the phone would write it.
 */
export async function recordProductAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const input = parsed(recordVisitProduct.input, {
      id,
      field: field(form, "field") ?? "",
      priceBookItemId: field(form, "priceBookItemId") ?? "",
      quantity: field(form, "quantity") ?? "",
      ...(field(form, "applicatorLicense") ? { applicatorLicense: field(form, "applicatorLicense") } : {}),
      ...(field(form, "targetPest") ? { targetPest: field(form, "targetPest") } : {}),
    });
    await productsApplied.record({ actor: (await requireSetupUser()).actor, db: getDb() }, input);
    return { message: "Recorded on the visit's report, with the product's EPA number from the price book." };
  });
  if (state?.done) revalidatePath(`/visits/${id}`);
  return state;
}
