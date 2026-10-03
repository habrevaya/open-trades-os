"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { estimates } from "@opentradesos/api/services";
import { setProposalTerms } from "@opentradesos/api/contracts";
import { attempt, parsed, type FormState } from "@/lib/actions";

/** `PUT /v1/proposal-terms`, refused in the service's words. */
export async function saveTerms(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const user = await requireSetupUser();
    await estimates.setProposalTerms({ actor: user.actor, db: getDb() },
      parsed(setProposalTerms.input, { terms: String(form.get("terms") ?? "") }));
  });
  revalidatePath("/estimates/terms");
  return result;
}
