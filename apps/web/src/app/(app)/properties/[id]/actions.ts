"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { equipment, ConflictError, NotFoundError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

const text = (form: FormData, name: string): string | null =>
  String(form.get(name) ?? "").trim() || null;

export async function registerUnit(_previous: unknown, form: FormData) {
  const propertyId = String(form.get("propertyId") ?? "");
  try {
    await equipment.register(await ctx(), {
      propertyId,
      category: String(form.get("category") ?? ""),
      tag: text(form, "tag"),
      manufacturer: text(form, "manufacturer"),
      model: text(form, "model"),
      serialNumber: text(form, "serialNumber"),
      location: text(form, "location"),
      installedOn: text(form, "installedOn"),
      warrantyPartsExpiresOn: text(form, "warrantyPartsExpiresOn"),
      warrantyLaborExpiresOn: text(form, "warrantyLaborExpiresOn"),
    });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath(`/properties/${propertyId}`);
  return { done: true };
}

/**
 * Take a unit off the register.
 *
 * Soft, and the service refuses it while other units are nested inside,
 * because a child parented to something the register no longer shows
 * vanishes from the tree and stays in the table.
 */
export async function retireUnit(_previous: unknown, form: FormData) {
  const propertyId = String(form.get("propertyId") ?? "");
  try {
    await equipment.retire(await ctx(), {
      id: String(form.get("id") ?? ""),
      reason: String(form.get("reason") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath(`/properties/${propertyId}`);
  return { done: true };
}
