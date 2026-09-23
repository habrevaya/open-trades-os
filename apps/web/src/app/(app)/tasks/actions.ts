"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks, ConflictError } from "@opentradesos/api/services";

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
