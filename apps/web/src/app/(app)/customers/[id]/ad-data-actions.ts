"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ads } from "@opentradesos/api/services";
import { setCustomerAdData } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/** What the customer said about their details and advertising, recorded through the route's own schema. */
export async function setAdData(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const input = parsed(setCustomerAdData.input, {
      id, choice: field(form, "choice"), method: "verbal",
      ...(field(form, "proofText") ? { proofText: field(form, "proofText") } : {}),
    });
    const done = await ads.handlers.setCustomerAdData(ctx, input);
    return { message: done.choice === "refused" ? "Recorded. Nothing about them goes to an ad platform." : "Recorded." };
  });
  revalidatePath(`/customers/${id}`);
  return result;
}
