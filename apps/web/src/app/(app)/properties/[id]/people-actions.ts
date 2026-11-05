"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contacts } from "@opentradesos/api/services";
import { attempt, field, type FormState } from "@/lib/actions";

/**
 * THE PEOPLE AT AN ADDRESS, from the address's own page.
 *
 * The same service functions the API's address and contact routes run, so the
 * rules are one set: a phone or an email, a channel they can be reached on,
 * one primary per address, removal that keeps the history.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const channel = (form: FormData) => (field(form, "preferredChannel") ?? "sms") as "sms" | "email" | "voice";

export async function addAddressPerson(_previous: FormState, form: FormData): Promise<FormState> {
  const propertyId = String(form.get("propertyId") ?? "");
  const state = await attempt(form, async () => {
    await contacts.addForProperty(await ctx(), {
      id: propertyId, name: field(form, "name") ?? "", title: field(form, "title") ?? null,
      phone: field(form, "phone") ?? null, email: field(form, "email") ?? null, preferredChannel: channel(form),
      isPrimary: form.get("isPrimary") === "yes",
    });
  });
  revalidatePath(`/properties/${propertyId}`);
  return state;
}

export async function editAddressPerson(_previous: FormState, form: FormData): Promise<FormState> {
  const propertyId = String(form.get("propertyId") ?? "");
  const state = await attempt(form, async () => {
    await contacts.edit(await ctx(), {
      id: String(form.get("id") ?? ""), name: field(form, "name") ?? "", title: field(form, "title") ?? null,
      phone: field(form, "phone") ?? null, email: field(form, "email") ?? null, preferredChannel: channel(form),
    });
  });
  revalidatePath(`/properties/${propertyId}`);
  return state;
}

export async function makeAddressPersonPrimary(_previous: FormState, form: FormData): Promise<FormState> {
  const propertyId = String(form.get("propertyId") ?? "");
  const state = await attempt(form, async () => { await contacts.makePrimary(await ctx(), { id: String(form.get("id") ?? "") }); });
  revalidatePath(`/properties/${propertyId}`);
  return state;
}

export async function removeAddressPerson(_previous: FormState, form: FormData): Promise<FormState> {
  const propertyId = String(form.get("propertyId") ?? "");
  const state = await attempt(form, async () => { await contacts.removeOnce(await ctx(), { id: String(form.get("id") ?? "") }); });
  revalidatePath(`/properties/${propertyId}`);
  return state;
}
