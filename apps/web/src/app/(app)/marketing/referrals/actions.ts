"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { referrals } from "@opentradesos/api/services";
import { attempt, field, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function saveReferralSettings(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await referrals.setSettings(await ctx(), {
      reward: field(form, "reward") ?? "none",
      amount: field(form, "amount"),
    });
    return { message: "Saved. Rewards already given are not changed." };
  });
  revalidatePath("/marketing/referrals");
  return result;
}

export async function settleReward(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, () => (async () => referrals.settleReward(await ctx(), {
    id: field(form, "id") ?? "",
    action: field(form, "action") === "void" ? "void" : "paid",
    note: field(form, "note"),
  }))());
  revalidatePath("/marketing/referrals");
  return result;
}
