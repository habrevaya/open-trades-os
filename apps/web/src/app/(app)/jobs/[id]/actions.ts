"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commercial, entitlements, jobs, ConflictError } from "@opentradesos/api/services";
import type { coverage } from "@opentradesos/core";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function authorizeJob(_previous: unknown, form: FormData) {
  const jobId = String(form.get("jobId") ?? "");
  const amount = String(form.get("amount") ?? "").trim();
  try {
    await commercial.authorize(await ctx(), {
      jobId,
      /**
       * An empty amount is "approved, bill what it costs", which is a real
       * answer a client gives, rather than a zero ceiling that would refuse
       * every invoice on the job.
       */
      amount: amount === "" ? null : amount,
      ...(String(form.get("grantedByName") ?? "").trim()
        ? { grantedByName: String(form.get("grantedByName")).trim() } : {}),
      /**
       * Distinct field names on the two forms. They share a page, and a
       * shared name is ambiguous for anything that addresses the page by
       * one: a browser autofill, a screen reader, a script.
       */
      ...(String(form.get("authorizationReference") ?? "").trim()
        ? { externalReference: String(form.get("authorizationReference")).trim() } : {}),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/jobs/${jobId}`);
  return { done: true };
}

export async function setCoverage(_previous: unknown, form: FormData) {
  const jobId = String(form.get("jobId") ?? "");
  const source = String(form.get("source") ?? "");
  try {
    if (source === "") {
      await entitlements.clear(await ctx(), { jobId });
    } else {
      await entitlements.resolve(await ctx(), {
        jobId,
        source: source as coverage.CoverageSource,
        ...(String(form.get("coverageReference") ?? "").trim()
          ? { externalReference: String(form.get("coverageReference")).trim() } : {}),
      });
    }
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/jobs/${jobId}`);
  return { done: true };
}

export async function setPriority(_previous: unknown, form: FormData) {
  const jobId = String(form.get("jobId") ?? "");
  try {
    await jobs.update(await ctx(), { id: jobId, priority: Number(form.get("priority") ?? 0) });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/jobs/${jobId}`);
  return { done: true };
}
