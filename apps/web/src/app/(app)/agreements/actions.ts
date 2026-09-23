"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements, ConflictError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function bookVisit(_previous: unknown, form: FormData) {
  let result;
  try {
    result = await agreements.book(await ctx(), {
      agreementVisitId: String(form.get("agreementVisitId") ?? ""),
    });
  } catch (error) {
    // "Somebody else booked that one" is the expected outcome of two people
    // working the owed list at the same moment, not an error to throw at them.
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/agreements");
  redirect(`/jobs/${result.job.id}`);
}

export async function deliverVisit(_previous: unknown, form: FormData) {
  const agreementId = String(form.get("agreementId") ?? "");
  try {
    await agreements.deliver(await ctx(), {
      agreementVisitId: String(form.get("agreementVisitId") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/agreements/${agreementId}`);
  return { done: true };
}

export async function billInstalment(_previous: unknown, form: FormData) {
  const agreementId = String(form.get("agreementId") ?? "");
  try {
    await agreements.bill(await ctx(), {
      agreementBillingId: String(form.get("agreementBillingId") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/agreements/${agreementId}`);
  return { done: true };
}

export async function cancelAgreement(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  try {
    await agreements.cancel(await ctx(), {
      id,
      reason: String(form.get("reason") ?? ""),
      keepThePrepayment: form.get("keepThePrepayment") === "1",
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/agreements/${id}`);
  return { done: true };
}
