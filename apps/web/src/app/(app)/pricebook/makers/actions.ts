"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { warrantyMakers } from "@opentradesos/api/services";
import { createWarrantyMaker, updateWarrantyMaker } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const done = (state: FormState) => {
  revalidatePath("/pricebook/makers");
  return state;
};

/** Empty days means the maker has not given any, which leaves each item's own days as the word. */
const daysOf = (form: FormData): number | null => {
  const said = field(form, "registrationDays");
  return said === undefined ? null : Number(said);
};

export async function addMaker(_previous: FormState, form: FormData): Promise<FormState> {
  return done(await attempt(form, async () => {
    const input = parsed(createWarrantyMaker.input, {
      name: field(form, "name"), registrationDays: daysOf(form), notes: field(form, "notes") ?? null,
    });
    await warrantyMakers.create(await ctx(), input);
    return { message: "Added." };
  }));
}

export async function editMaker(_previous: FormState, form: FormData): Promise<FormState> {
  return done(await attempt(form, async () => {
    const input = parsed(updateWarrantyMaker.input, {
      id: field(form, "id"), name: field(form, "name"), registrationDays: daysOf(form), notes: field(form, "notes") ?? null,
    });
    await warrantyMakers.update(await ctx(), input);
    return { message: "Saved. Units installed from now on use these days; deadlines already open keep their last day." };
  }));
}

export async function retireMaker(_previous: FormState, form: FormData): Promise<FormState> {
  return done(await attempt(form, async () => {
    await warrantyMakers.retire(await ctx(), { id: String(form.get("id") ?? "") });
  }));
}
