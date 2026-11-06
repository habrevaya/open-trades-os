"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { estimateExtendedNotice } from "@opentradesos/api/services";
import { updateEstimateExtendedWords } from "@opentradesos/api/contracts";
import { attempt, parsed, type FormState } from "@/lib/actions";

const CODES = ["estimate_extended.sms", "estimate_extended.email"] as const;

/**
 * `PUT /v1/estimate-extended-words`, from the screen: the text and the email
 * that tell a customer they were given longer. A template's fields are named
 * by its code, so the form needs no hidden list of which is which.
 */
export async function saveExtendedWords(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const result = await attempt(form, async () => {
    const input = parsed(updateEstimateExtendedWords.input, {
      templates: CODES.map((code) => ({
        code,
        body: String(form.get(`${code}:body`) ?? ""),
        ...(code.endsWith(".email") ? { subject: String(form.get(`${code}:subject`) ?? "") } : {}),
      })),
    });
    await estimateExtendedNotice.updateWords({ actor: user.actor, db: getDb() }, input);
  });
  revalidatePath("/estimates/given-longer");
  return result;
}
