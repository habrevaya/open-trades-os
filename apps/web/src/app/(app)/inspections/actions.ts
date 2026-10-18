"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inspections } from "@opentradesos/api/services";
import { routes } from "@opentradesos/api/contracts";
import { attempt, field, parsed, refused, type FormState } from "@/lib/actions";

/**
 * A FINDING INTO A QUOTE, FROM THE BACKLOG, IN ONE PRESS.
 *
 * `POST /v1/inspection-deficiencies/{id}/quote`, and then straight to the
 * estimate it wrote, which is where somebody reviews it and sends it. A
 * refusal (no evidence, a repair code the price book does not have, no
 * repair declared and no price given) stays on the backlog row in words.
 */
export async function quoteFinding(_previous: FormState, form: FormData): Promise<FormState> {
  let estimateId: string | null = null;
  const result = await attempt(form, async () => {
    const quoted = await inspections.quoteDeficiency(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(routes.quoteDeficiency.input, { id: field(form, "deficiencyId"), price: field(form, "price") ?? null }),
    );
    estimateId = quoted.estimateId;
  });
  if (estimateId) redirect(`/estimates/${estimateId}`);
  revalidatePath("/inspections");
  return result;
}

/**
 * THE CUSTOMER SAID NO TO A FINDING, FROM THE BACKLOG.
 *
 * The same call the unit's page makes, `POST /v1/inspection-deficiencies/{id}/status`
 * with `declined` and a code from the fixed list, so the office does not open
 * each piece of equipment to say it. The finding leaves this list the moment it
 * is declined, so the person is sent back to it with a line saying it was
 * recorded, rather than left looking at a form that has just been removed.
 */
export async function declineFinding(_previous: FormState, form: FormData): Promise<FormState> {
  const code = field(form, "declineCode");
  if (code !== "price" && code !== "not_now" && code !== "booked_elsewhere" && code !== "other") {
    return refused(form, "Say why they said no.");
  }
  const words = field(form, "reason");
  const result = await attempt(form, async () => {
    await inspections.setDeficiencyStatus(
      { actor: (await requireSetupUser()).actor, db: getDb() },
      parsed(routes.setDeficiencyStatus.input, {
        id: field(form, "deficiencyId"), status: "declined", declineCode: code, ...(words ? { reason: words } : {}),
      }),
    );
  });
  if (result?.done) {
    revalidatePath("/inspections");
    redirect("/inspections?declined=1");
  }
  return result;
}
