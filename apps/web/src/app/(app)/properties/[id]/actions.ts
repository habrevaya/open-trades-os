"use server";

import { attempt, refused } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { equipment, geocoding, properties, ConflictError, NotFoundError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

const text = (form: FormData, name: string): string | null =>
  String(form.get(name) ?? "").trim() || null;

/**
 * Add a unit, or say where its serial is already on file.
 *
 * The service refuses a serial on file anywhere else in the company until the
 * person adding it says it is a different unit; the refusal comes back with
 * the units it matched, so the form can show each one with a link to it and
 * the box to tick. Moving the existing unit is the usual right answer and is
 * one click away on its page.
 */
export async function registerUnit(_previous: unknown, form: FormData) {
  const propertyId = String(form.get("propertyId") ?? "");
  const serial = text(form, "serialNumber");
  try {
    await equipment.register(await ctx(), {
      serialElsewhereConfirmed: form.get("serialElsewhereConfirmed") === "on",
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
      const matches = serial && error instanceof ConflictError
        ? (await equipment.matchSerial(await ctx(), { serialNumber: serial }))
            .map((m) => ({ id: m.id, propertyId: m.propertyId, address: m.address, retired: m.retired,
              what: [m.tag, m.manufacturer, m.model].filter(Boolean).join(" ") || m.category }))
        : [];
      return { ...refused(form, error.message), matches };
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
      return refused(form, error.message);
    }
    throw error;
  }
  revalidatePath(`/properties/${propertyId}`);
  return { done: true };
}

/**
 * Place the property on the map by hand. From then on the geocoder leaves it
 * alone, which is the point: the office knows the gate is round the back.
 */
export async function placePropertyPin(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  const result = await attempt(form, async () => geocoding.placePin(await ctx(), {
    entity: "property", id,
    latitude: Number(String(form.get("latitude") ?? "").trim() || "NaN"),
    longitude: Number(String(form.get("longitude") ?? "").trim() || "NaN"),
  }).then(() => ({ message: "Pin saved. The geocoder will not move it." })));
  revalidatePath(`/properties/${id}`);
  return result;
}

/** Take the hand placed pin off and let the geocoder find it again. */
export async function clearPropertyPin(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  const result = await attempt(form, async () => geocoding.clearPin(await ctx(), { entity: "property", id }));
  revalidatePath(`/properties/${id}`);
  return result;
}

/**
 * The sales tax rate charged on work at this address, which wins over the
 * customer's because the rate follows where the work is done. Empty for the
 * customer's, or the company's usual one.
 */
export async function setPropertyTaxRate(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  const rate = text(form, "taxRateId");
  const result = await attempt(form, async () => {
    await properties.update(await ctx(), { id, taxRateId: rate });
    return { message: "Saved. Invoices already raised keep what they charged." };
  });
  revalidatePath(`/properties/${id}`);
  return result;
}
