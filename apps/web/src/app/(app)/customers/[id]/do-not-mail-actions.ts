"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { doNotMail } from "@opentradesos/api/services";
import { attempt, field, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** `POST /v1/marketing/do-not-mail` for this customer: never mailed, wherever they live. */
export async function addCustomerToDoNotMail(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    await doNotMail.add(await ctx(), { customerId: id, ...(field(form, "reason") ? { reason: field(form, "reason") } : {}) });
    return { message: "On the list. No mailing will post to them." };
  });
  revalidatePath(`/customers/${id}`);
  revalidatePath("/marketing/mail");
  return result;
}

/** `POST /v1/marketing/do-not-mail/{id}/remove`. */
export async function takeCustomerOffDoNotMail(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = field(form, "customerId") ?? "";
  const result = await attempt(form, async () => {
    await doNotMail.remove(await ctx(), { id: field(form, "id") ?? "" });
    return { message: "Taken off the list." };
  });
  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/marketing/mail");
  return result;
}
