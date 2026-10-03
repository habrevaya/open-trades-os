"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customerTags } from "@opentradesos/api/services";
import { setCustomerTags } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * TAGS ON ONE CUSTOMER, from their page.
 *
 * Their own file rather than beside the page's other actions, so the tag
 * section can be read, and changed, without the twelve other forms that page
 * carries. The service gives a new tag the spelling the company already uses,
 * so nothing here decides how a tag is written.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function addTag(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("customerId") ?? "");
  const state = await attempt(form, async () => {
    const tag = field(form, "tag");
    await customerTags.setOnCustomer(await ctx(), {
      customerId: id,
      ...parsed(setCustomerTags.input.pick({ add: true }), { add: tag ? [tag] : [] }),
    });
  });
  revalidatePath(`/customers/${id}`);
  return state;
}

export async function removeTag(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("customerId") ?? "");
  const state = await attempt(form, async () => {
    await customerTags.setOnCustomer(await ctx(), {
      customerId: id, remove: [String(form.get("tag") ?? "")],
    });
  });
  revalidatePath(`/customers/${id}`);
  return state;
}
