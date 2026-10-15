"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobHolds, jobs } from "@opentradesos/api/services";
import { work } from "@opentradesos/core";
import { attempt, field, refused, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

const REASONS = work.HOLD_REASONS.map((r) => r.value) as string[];

/** Putting a job on hold with its reason. The service says what is missing, in its own words. */
export async function placeHold(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const reason = field(form, "reason") ?? "";
  if (!REASONS.includes(reason)) return refused(form, "Choose why the job is waiting.");
  const purchaseOrderId = field(form, "purchaseOrderId");
  const note = field(form, "note");
  const result = await attempt(form, async () => {
    await jobHolds.place(await ctx(), {
      id: jobId, reason: reason as work.HoldReason,
      ...(reason === "part" && purchaseOrderId ? { purchaseOrderId } : {}),
      ...(note ? { note } : {}),
    });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

export async function releaseHold(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const result = await attempt(form, async () => {
    await jobHolds.release(await ctx(), { id: field(form, "holdId") ?? "" });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/** Saying the job is planned as more than one visit, or taking that back. */
export async function setMultiVisitPlanned(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const planned = field(form, "planned") === "1";
  const result = await attempt(form, async () => {
    await jobs.update(await ctx(), { id: jobId, multiVisitPlanned: planned });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}
