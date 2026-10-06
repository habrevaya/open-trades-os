"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dispatchDays } from "@opentradesos/api/services";
import { attempt, type FormState } from "@/lib/actions";

/** The days of the week that suit a customer, ticked on their page. */
export async function preferredDaysAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("customerId") ?? "");
  const state = await attempt(form, async () => {
    const days = form.getAll("day").map(Number).filter((d) => Number.isInteger(d));
    await dispatchDays.setPreferredDays({ actor: (await requireSetupUser()).actor, db: getDb() }, { id, days });
    return { message: days.length === 0 ? "Saved: any day suits them." : "Saved." };
  });
  if (state?.done) revalidatePath(`/customers/${id}`);
  return state;
}
