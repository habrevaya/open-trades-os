"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { truckWater } from "@opentradesos/api/services";
import { attempt, field, type FormState } from "@/lib/actions";

/**
 * A truck's fresh water for a day, typed or corrected by the office, and a
 * reading taken off when it was read on the wrong truck. Each through the
 * service, so the refusals are its own.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function recordWaterAction(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => truckWater.record(await ctx(), {
    assetId: field(form, "assetId") ?? "",
    onDay: field(form, "onDay") ?? "",
    gallons: field(form, "gallons") ?? "",
    note: field(form, "note") ?? null,
  }));
  revalidatePath("/fleet/water");
  return result;
}

export async function removeWaterAction(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => truckWater.remove(await ctx(), {
    assetId: field(form, "assetId") ?? "",
    onDay: field(form, "onDay") ?? "",
  }));
  revalidatePath("/fleet/water");
  return result;
}
