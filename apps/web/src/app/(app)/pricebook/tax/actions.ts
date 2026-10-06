"use server";

import { revalidatePath } from "next/cache";
import { attempt, fields, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { setup } from "@opentradesos/api/services";

/**
 * Whether the chosen items are taxed, and their class, as a new version of
 * each one that changes. `requireUser`, because the setup wizard's tax step
 * posts here before setup is finished.
 */
export async function setTax(_previous: FormState, form: FormData): Promise<FormState> {
  const taxClass = String(form.get("taxClass") ?? "");
  const result = await attempt(form, async () => {
    const done = await setup.setItemTax(
      { actor: (await requireUser()).actor, db: getDb() },
      {
        itemIds: fields(form, "itemId"),
        taxable: form.get("taxable") === "yes",
        taxClass: taxClass === "" ? null : taxClass,
      },
    );
    return {
      message: done.changed === 0
        ? "Those were already set that way. Nothing changed."
        : `${done.changed} ${done.changed === 1 ? "item" : "items"} changed. Documents already written keep what they charged.`,
    };
  });
  revalidatePath("/pricebook/tax");
  revalidatePath("/setup/tax");
  return result;
}
