"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks, obligations, ConflictError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function claimTask(_previous: unknown, form: FormData) {
  try {
    await tasks.claim(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    // "Somebody else has that one" is the expected outcome of two people
    // opening the queue at the same moment, not an error to throw at them.
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/tasks");
  return { done: true };
}

export async function closeTask(_previous: unknown, form: FormData) {
  const outcome = String(form.get("outcome") ?? "").trim();
  try {
    await tasks.close(await ctx(), {
      id: String(form.get("id") ?? ""),
      dismissed: form.get("dismissed") === "1",
      ...(outcome ? { outcome } : {}),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/tasks");
  return { done: true };
}

/**
 * DEADLINES
 *
 * `obligation` is the schema's one primitive for SLAs, acknowledge-by dates,
 * invoicing windows and warranty registration deadlines, and exactly one
 * place in the product wrote to it: a technician completing work on a visit
 * that was already cancelled, under a comment promising it "shows up in the
 * same place every other approaching deadline does".
 *
 * It showed up nowhere, so nobody ever decided whether to bill any of that
 * work. These two actions are the other half.
 */
export async function satisfyObligation(_previous: unknown, form: FormData) {
  try {
    await obligations.satisfy(await ctx(), {
      id: String(form.get("id") ?? ""),
      satisfiedByEvent: String(form.get("satisfiedByEvent") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/tasks");
  return { done: true };
}

export async function waiveObligation(_previous: unknown, form: FormData) {
  try {
    await obligations.waive(await ctx(), {
      id: String(form.get("id") ?? ""),
      reason: String(form.get("reason") ?? ""),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/tasks");
  return { done: true };
}
