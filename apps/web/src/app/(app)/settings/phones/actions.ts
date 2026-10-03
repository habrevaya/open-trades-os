"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fieldDevices } from "@opentradesos/api/services";

/**
 * Taking a phone away, and setting the number a sign in code is texted to.
 * Both are `user:write`, decided in the service; a refusal is the service's
 * own sentence under the button that was pressed.
 */
export async function act(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "revoke":
        await fieldDevices.revoke(ctx, { id });
        return { message: "Taken away. It is signed out and will not be told about changes." };
      case "mobile": {
        const saved = await fieldDevices.setMobile(ctx, { id, mobilePhone: field(form, "mobilePhone") ?? null });
        return { message: saved.mobilePhone ? `Codes will be texted to ${saved.mobilePhone}.` : "Cleared. Codes go by email only." };
      }
      default:
        throw new Error(`Unknown operation ${op}`);
    }
  });
  if (state?.done) revalidatePath("/settings/phones");
  return state;
}
