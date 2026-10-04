"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inspections } from "@opentradesos/api/services";
import { routes } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

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
