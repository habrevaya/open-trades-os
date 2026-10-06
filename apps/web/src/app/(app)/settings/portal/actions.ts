"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { portalSettings } from "@opentradesos/api/services";
import { attempt, field, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Tipping on or off, and the percentages offered. The percentages arrive as
 * one box ("10, 15, 20") because that is how somebody says them; core
 * decides whether they are acceptable and the refusal is its sentence.
 */
export async function saveTipping(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    const presets = (field(form, "presets") ?? "")
      .split(/[\s,%]+/).filter((v) => v !== "").map((v) => Number(v));
    await portalSettings.set(await ctx(), {
      tipping: { enabled: form.get("enabled") === "on", presets },
    });
    revalidatePath("/settings/portal");
    return { message: "Saved." };
  });
}

export async function saveJobPhotos(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    await portalSettings.set(await ctx(), { jobPhotos: field(form, "jobPhotos") === "all" ? "all" : "chosen" });
    revalidatePath("/settings/portal");
    return { message: "Saved." };
  });
}

/** Bank payments on or off. Off until somebody turns it on, because the money arrives days later and can still fail. */
export async function saveBankPayments(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    await portalSettings.set(await ctx(), { bankAccounts: form.get("bankAccounts") === "on" });
    revalidatePath("/settings/portal");
    return { message: "Saved." };
  });
}
