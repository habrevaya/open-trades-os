"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { consent, contacts, ConflictError, NotFoundError } from "@opentradesos/api/services";

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

/**
 * Add somebody at this customer, or at one of their properties.
 *
 * `customerId` comes from the path rather than the form, so a contact cannot
 * be attached to a customer the caller was not looking at. `propertyId` does
 * come from the form, and the service checks it exists; it does not check the
 * property belongs to this customer, which the page's own option list is what
 * constrains. That is a gap worth naming rather than leaving implied.
 */
export async function addContact(_previous: unknown, form: FormData) {
  const customerId = String(form.get("customerId") ?? "");
  try {
    await contacts.create(await ctx(), {
      customerId,
      propertyId: String(form.get("propertyId") ?? "") || null,
      name: String(form.get("name") ?? ""),
      title: String(form.get("title") ?? "") || null,
      phone: String(form.get("phone") ?? "") || null,
      email: String(form.get("email") ?? "") || null,
      preferredChannel: String(form.get("preferredChannel") ?? "sms") as "sms",
    });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath(`/customers/${customerId}`);
  return { done: true };
}

export async function removeContact(_previous: unknown, form: FormData) {
  const customerId = String(form.get("customerId") ?? "");
  try {
    await contacts.remove(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath(`/customers/${customerId}`);
  return { done: true };
}

export async function makePrimary(_previous: unknown, form: FormData) {
  const customerId = String(form.get("customerId") ?? "");
  try {
    /**
     * Id and the one flag, nothing else. The service validates the MERGED
     * row, so every other field stays as it was. Sending the whole record
     * back from a button that means one thing is how a stale field
     * overwrites a fresh one.
     */
    await contacts.update(await ctx(), {
      id: String(form.get("id") ?? ""), isPrimary: true,
    });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath(`/customers/${customerId}`);
  return { done: true };
}
