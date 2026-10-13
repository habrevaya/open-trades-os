"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { costing } from "@opentradesos/api/services";
import { setCostingRate, setOverheadMix } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** A burden or overhead rate from a date. The service refuses a second rate on one day in words. */
export async function addRate(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(setCostingRate.input, {
      component: field(form, "component"),
      basis: field(form, "basis"),
      rate: (field(form, "rate") ?? "").replace(/[%$,\s]/g, ""),
      effectiveFrom: field(form, "effectiveFrom"),
      note: field(form, "note"),
    });
    await costing.set(await ctx(), input);
  });
  revalidatePath("/settings/costing");
  return result;
}

export async function removeRate(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await costing.remove(await ctx(), { id: field(form, "id") ?? "" });
  });
  revalidatePath("/settings/costing");
  return result;
}

/** Overhead from a date as a mix; an empty box is a part not charged from that day. */
export async function setOverhead(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const amount = (name: string) => {
      const value = (field(form, name) ?? "").replace(/[%$,\s]/g, "");
      return value === "" ? undefined : value;
    };
    const input = parsed(setOverheadMix.input, {
      effectiveFrom: field(form, "effectiveFrom"),
      perHour: amount("perHour"),
      perJob: amount("perJob"),
      percentOfRevenue: amount("percentOfRevenue"),
      note: field(form, "note"),
    });
    const done = await costing.setOverhead(await ctx(), input);
    return { message: `Overhead set from ${done.effectiveFrom}.` };
  });
  revalidatePath("/settings/costing");
  return result;
}
