"use server";

import { attempt, refused, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reviews, reviewSync, ConflictError, NotFoundError } from "@opentradesos/api/services";

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
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/reviews");
  return { done: true };
}

export async function markCalled(_previous: unknown, form: FormData) {
  try {
    await reviews.markRecovered(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    if (error instanceof NotFoundError) {
      return refused(form, "That call is already recorded.");
    }
    throw error;
  }
  revalidatePath("/reviews");
  return { done: true };
}

/** "Fetch from Google now", or Facebook: read every connected listing and post the replies waiting. */
export async function syncListings(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const outcome = await reviewSync.syncNow(await ctx());
    const failed = outcome.listings.find((l) => l.error);
    if (failed) throw new ConflictError(failed.error!);
    const read = outcome.listings.reduce((n, l) => n + l.read, 0);
    const from = outcome.listings.length === 1 ? reviewSync.siteName(outcome.listings[0]!.provider) : "your listings";
    return { message: `Read ${read} review${read === 1 ? "" : "s"} from ${from}.` };
  });
  revalidatePath("/reviews");
  return result;
}

/** Yes, the suggested customer wrote it; or no, they did not. Only a person ever says which. */
export async function answerMatch(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => reviewSync.confirmMatch(await ctx(), {
    id: String(form.get("id") ?? ""),
    accept: form.get("accept") === "yes",
  }));
  revalidatePath("/reviews");
  return result;
}

/**
 * Turn the one reminder on, with how many days to wait, or off. Left empty is off.
 */
export async function saveReminders(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const typed = String(form.get("afterDays") ?? "").trim();
    const afterDays = typed === "" ? null : Number(typed);
    /** The service refuses a gap that is a nag, or too long, in words. */
    await reviews.setReminders(await ctx(), { afterDays: afterDays === null || Number.isNaN(afterDays) ? (typed === "" ? null : -1) : afterDays });
    return { message: afterDays === null ? "Reminders are off." : `One reminder after ${afterDays} days.` };
  });
  revalidatePath("/reviews");
  return result;
}
