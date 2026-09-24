"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reviews, ConflictError, NotFoundError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function respondToReview(_previous: unknown, form: FormData) {
  try {
    await reviews.respond(await ctx(), {
      id: String(form.get("id") ?? ""),
      body: String(form.get("body") ?? ""),
    });
  } catch (error) {
    /**
     * A refused reply is almost always one of two things somebody can fix
     * in ten seconds: too short to say anything, or the same text already
     * posted under another review. Both come back as the service's own
     * sentence rather than a generic failure.
     */
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/reviews");
  return { done: true };
}

export async function markCalled(_previous: unknown, form: FormData) {
  try {
    await reviews.markRecovered(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    if (error instanceof NotFoundError) {
      return { error: "That call is already recorded." };
    }
    throw error;
  }
  revalidatePath("/reviews");
  return { done: true };
}
