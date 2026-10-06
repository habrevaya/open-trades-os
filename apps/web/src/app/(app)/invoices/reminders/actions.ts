"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agentCollections } from "@opentradesos/api/services";
import { dismissCollectionReminder, sendCollectionReminder } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * The collections agent's reminders, from their screen: check now, send one
 * as written or edited, or set it aside. Sending is the invoice's own email or
 * a text through the consent gate; nothing here is a second way to message a
 * customer.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function checkNow(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, async () => {
    const outcome = await agentCollections.runNow(c);
    return {
      message: outcome.drafted === 0
        ? "Nothing new is due a reminder."
        : `Drafted ${outcome.drafted} reminder${outcome.drafted === 1 ? "" : "s"}${outcome.sent > 0 ? `, ${outcome.sent} sent on their own` : ""}.`,
    };
  });
  revalidatePath("/invoices/reminders");
  return state;
}

export async function sendReminder(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentCollections.send(c, parsed(sendCollectionReminder.input, {
    id: field(form, "id"), body: field(form, "body"),
  })));
  revalidatePath("/invoices/reminders");
  return state;
}

export async function setReminderAside(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentCollections.handlers.dismissCollectionReminder(c, parsed(dismissCollectionReminder.input, {
    id: field(form, "id"),
  })));
  revalidatePath("/invoices/reminders");
  return state;
}
