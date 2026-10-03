"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agentEstimates } from "@opentradesos/api/services";
import { acceptEstimateDraft, createEstimateDraft, dismissEstimateDraft } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * The estimate drafter, from the job page: ask for options, turn them into a
 * draft estimate, or set them aside. Nothing here sends anything; the estimate
 * is sent from its own screen once a person has checked it.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function draftOptions(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const jobId = field(form, "jobId");
  const state = await attempt(form, () => agentEstimates.draft(c, parsed(createEstimateDraft.input, { jobId })));
  revalidatePath(`/jobs/${jobId}`);
  return state;
}

export async function makeEstimate(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentEstimates.accept(c, parsed(acceptEstimateDraft.input, { id: field(form, "id") })));
  revalidatePath(`/jobs/${field(form, "jobId")}`);
  return state;
}

export async function setOptionsAside(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentEstimates.handlers.dismissEstimateDraft(c, parsed(dismissEstimateDraft.input, { id: field(form, "id") })));
  revalidatePath(`/jobs/${field(form, "jobId")}`);
  return state;
}
