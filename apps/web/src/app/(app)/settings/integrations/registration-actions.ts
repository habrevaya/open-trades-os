"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { messagingRegistration } from "@opentradesos/api/services";

/**
 * Writing down an A2P 10DLC registration made in the carrier's portal.
 * `requireUser`, because the setup wizard's phone and email step posts here.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/settings/integrations");
  revalidatePath("/setup", "layout");
}

export async function recordBrand(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => messagingRegistration.registerBrand(await ctx(), {
    legalName: field(form, "legalName") ?? "",
    displayName: field(form, "displayName") ?? "",
    entityType: field(form, "entityType") ?? null,
    taxIdLast4: field(form, "taxIdLast4") ?? null,
    website: field(form, "website") ?? null,
  }));
  refresh();
  return result;
}

export async function setBrandStatus(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => messagingRegistration.setBrandStatus(await ctx(), {
    id: String(form.get("id") ?? ""),
    status: String(form.get("status") ?? "") as messagingRegistration.RegistrationStatus,
    reason: field(form, "reason") ?? null,
  }));
  refresh();
  return result;
}

export async function recordCampaign(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => messagingRegistration.registerCampaign(await ctx(), {
    brandId: String(form.get("brandId") ?? ""),
    purpose: form.get("purpose") === "marketing" ? "marketing" : "transactional",
    useCase: field(form, "useCase") ?? "",
    description: field(form, "description") ?? null,
  }));
  refresh();
  return result;
}
