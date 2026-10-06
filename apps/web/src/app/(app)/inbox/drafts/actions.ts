"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agentIntake, booking } from "@opentradesos/api/services";
import {
  approveIntakeDraft, bookBookingRequest, createIntakeDraft, declineBookingRequest, dismissIntakeDraft,
} from "@opentradesos/api/contracts";

/**
 * The office's half of the intake agent: book what it drafted, say no to it,
 * or ask it to read a conversation now. Each is the service the API calls,
 * parsed through the route's own schema, so the screen is exactly as strict
 * as the API and the refusals are the service's sentences.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

const refresh = (form: FormData) => {
  revalidatePath("/inbox/drafts");
  const conversation = field(form, "conversationId");
  if (conversation) revalidatePath(`/inbox/${conversation}`);
};

export async function bookDraft(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const [date, arrivalWindowId] = (field(form, "window") ?? "").split("|");
  const state = await attempt(form, () => agentIntake.approve(c, parsed(approveIntakeDraft.input, {
    id: field(form, "id"),
    ...(date && arrivalWindowId ? { date, arrivalWindowId } : {}),
  })));
  refresh(form);
  return state?.done ? { done: true, message: "Booked. The job is on the board." } : state;
}

export async function dismissDraft(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentIntake.handlers.dismissIntakeDraft(c, parsed(dismissIntakeDraft.input, {
    id: field(form, "id"), reason: field(form, "reason"),
  })));
  refresh(form);
  return state;
}

export async function draftFromThread(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentIntake.draftNow(c, parsed(createIntakeDraft.input, {
    sourceKind: field(form, "sourceKind") ?? "conversation",
    sourceId: field(form, "sourceId"),
    fresh: form.get("fresh") === "yes",
  })));
  refresh(form);
  return state;
}

export async function bookRequest(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentIntake.bookRequest(c, parsed(bookBookingRequest.input, { id: field(form, "id") })));
  refresh(form);
  return state?.done ? { done: true, message: "Booked. The job is on the board." } : state;
}

export async function declineRequest(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => booking.decline(c, parsed(declineBookingRequest.input, {
    id: field(form, "id"), reason: field(form, "reason") ?? "other", notifyCustomer: false,
  })));
  refresh(form);
  return state;
}
