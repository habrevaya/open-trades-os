"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { consent, ConflictError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Record that somebody agreed to marketing messages.
 *
 * `customerId` is not taken from the form. The address is what consent is
 * about and the customer is a convenience link, and trusting a client to say
 * which customer a consent row belongs to is a field somebody can retarget.
 */
export async function grantMarketing(_previous: unknown, form: FormData) {
  try {
    await consent.grant(await ctx(), {
      address: String(form.get("address") ?? ""),
      channel: "sms",
      purpose: "marketing",
      method: String(form.get("method") ?? "verbal") as "verbal",
      proofText: String(form.get("proofText") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/customers");
  return { done: true };
}

export async function revokeMarketing(_previous: unknown, form: FormData) {
  try {
    await consent.revoke(await ctx(), {
      address: String(form.get("address") ?? ""),
      channel: "sms",
      purpose: "marketing",
      method: "verbal",
      proofText: String(form.get("proofText") ?? "") || null,
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/customers");
  return { done: true };
}
