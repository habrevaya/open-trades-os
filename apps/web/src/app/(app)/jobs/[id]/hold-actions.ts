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

/** The crew hours budgeted, or none when the box is left empty. */
export async function setBudgetedHours(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const typed = field(form, "budgetedHours");
  if (typed !== undefined && !/^\d{1,6}(\.\d{1,2})?$/.test(typed)) {
    return refused(form, "Give the crew hours as a number, like 32 or 32.5.");
  }
  const result = await attempt(form, async () => {
    await jobs.update(await ctx(), { id: jobId, budgetedHours: typed ?? null });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/** Marking a supply on the job as billed back to the customer at cost, or taking the mark off. */
export async function setBilledBack(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const result = await attempt(form, async () => {
    await jobs.markBilledBack(await ctx(), { id: field(form, "lineId") ?? "", billedBack: field(form, "billedBack") === "1" });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/** Naming the container haul a line on the job bills, or taking the name off. */
export async function setLineHaul(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const result = await attempt(form, async () => {
    await jobs.nameHaul(await ctx(), { id: field(form, "lineId") ?? "", rentalId: field(form, "rentalId") ?? null });
    return { message: "Saved." };
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}

/** How much work the job is, in its job type's unit: its size, and once done what the crew produced. */
export async function setProduction(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = field(form, "jobId") ?? "";
  const typed = field(form, "productionQuantity")?.replace(/,/g, "");
  if (typed !== undefined && !/^\d{1,9}(\.\d{1,4})?$/.test(typed)) {
    return refused(form, "Give how much work it is as a number, like 1200 or 12.5.");
  }
  const result = await attempt(form, async () => {
    await jobs.update(await ctx(), { id: jobId, productionQuantity: typed ?? null });
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}
