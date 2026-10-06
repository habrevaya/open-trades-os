"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customerTags } from "@opentradesos/api/services";
import { renameCustomerTag, mergeCustomerTags } from "@opentradesos/api/contracts";
import { attempt, field, fields, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** Rename a tag on every customer carrying it. Refused onto a tag already in use, which is a merge. */
export async function renameTag(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const done = await customerTags.rename(await ctx(), parsed(renameCustomerTag.input, {
      from: field(form, "from"), to: field(form, "to"),
    }));
    return { message: `Renamed to "${done.tag}" on ${done.customers === 1 ? "1 customer" : `${done.customers} customers`}.` };
  });
  revalidatePath("/customers/tags");
  return state;
}

/** Fold the ticked tags into one. */
export async function mergeTags(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const done = await customerTags.merge(await ctx(), parsed(mergeCustomerTags.input, {
      from: fields(form, "from"), into: field(form, "into"),
    }));
    return { message: `Merged into "${done.tag}". ${done.customers === 1 ? "1 customer" : `${done.customers} customers`} changed.` };
  });
  revalidatePath("/customers/tags");
  return state;
}
