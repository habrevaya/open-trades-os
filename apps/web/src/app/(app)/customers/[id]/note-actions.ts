"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customerNotes } from "@opentradesos/api/services";
import { addCustomerNote, editCustomerNote, pinCustomerNote } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * NOTES ON ONE CUSTOMER, from their page.
 *
 * Each runs the function its route runs, parsed by the route's own schema,
 * so the page is exactly as strict as `POST /v1/customers/{id}/notes`. Who may
 * change a note and for how long is the service's to say; a refusal comes
 * back in its words.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function addNote(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = String(form.get("customerId") ?? "");
  const state = await attempt(form, async () => {
    await customerNotes.add(await ctx(), parsed(addCustomerNote.input, {
      id: customerId,
      body: String(form.get("body") ?? ""),
      forField: form.get("forField") === "on",
      pinned: form.get("pinned") === "on",
      ...(field(form, "correctsNoteId") ? { correctsNoteId: field(form, "correctsNoteId") } : {}),
    }));
  });
  revalidatePath(`/customers/${customerId}`);
  return state;
}

export async function editNote(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = String(form.get("customerId") ?? "");
  const state = await attempt(form, async () => {
    await customerNotes.edit(await ctx(), parsed(editCustomerNote.input, {
      id: String(form.get("id") ?? ""),
      body: String(form.get("body") ?? ""),
      forField: form.get("forField") === "on",
    }));
  });
  revalidatePath(`/customers/${customerId}`);
  return state;
}

export async function pinNote(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = String(form.get("customerId") ?? "");
  const state = await attempt(form, async () => {
    await customerNotes.pin(await ctx(), parsed(pinCustomerNote.input, {
      id: String(form.get("id") ?? ""),
      pinned: form.get("pinned") === "yes",
    }));
  });
  revalidatePath(`/customers/${customerId}`);
  return state;
}
