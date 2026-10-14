"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reviews } from "@opentradesos/api/services";
import { setReviewPolicy, setReviewReminders } from "@opentradesos/api/contracts";
import { attempt, field, parsed, refused, type FormState } from "@/lib/actions";
import { BAND_ROWS, DAYS } from "./fields";

/**
 * SETTINGS → REVIEW POLICY, THE WRITES
 *
 * Through the services `PUT /v1/reviews/policy` and `PUT /v1/reviews/reminders`
 * call, parsed by those routes' own schemas, so the permission
 * (`settings:write`), the audit entry and every refusal are the same ones.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const PATH = "/settings/reviews";

/** A typed whole number, or undefined for an empty box (the service keeps its starting point). */
function whole(form: FormData, name: string): number | undefined {
  const typed = field(form, name);
  return typed === undefined ? undefined : Number(typed);
}

export async function saveReviewPolicy(_previous: FormState, form: FormData): Promise<FormState> {
  /**
   * The answer-within rows, lowest rating first. A row whose rating is "Not
   * used" is dropped; one that names a rating and leaves the hours or the
   * reason empty is refused by the route's schema, naming the field.
   */
  const bands: { upToRating: number; withinHours: number; businessHoursOnly: boolean; priority: number; reason: string }[] = [];
  for (let i = 0; i < BAND_ROWS; i += 1) {
    const upTo = field(form, `band:${i}:upTo`);
    if (!upTo) continue;
    bands.push({
      upToRating: Number(upTo),
      withinHours: Number(field(form, `band:${i}:hours`) ?? "0"),
      businessHoursOnly: form.get(`band:${i}:open`) === "on",
      priority: bands.length + 1,
      reason: field(form, `band:${i}:reason`) ?? "",
    });
  }
  if (bands.length === 0) return refused(form, "Say how soon each review is answered: at least one row, reaching 5 stars.");
  const timeZone = field(form, "timeZone") ?? "";
  if (!validZone(timeZone)) {
    return refused(form, `"${timeZone}" is not a time zone. Write it the way your settings do, like America/Chicago.`);
  }
  const result = await attempt(form, async () => {
    const input = parsed(setReviewPolicy.input, {
      timeZone,
      delayMinutes: whole(form, "delayMinutes"),
      customerCooldownDays: whole(form, "customerCooldownDays"),
      requirePaid: form.get("requirePaid") === "on",
      maxJobAgeDays: whole(form, "maxJobAgeDays"),
      earliestHour: whole(form, "earliestHour"),
      latestHour: whole(form, "latestHour"),
      recoverAtOrBelow: whole(form, "recoverAtOrBelow"),
      sameDayAtOrBelow: whole(form, "sameDayAtOrBelow"),
      businessDays: DAYS.map((_, index) => index).filter((index) => form.get(`day:${index}`) === "on"),
      openHour: whole(form, "openHour"),
      closeHour: whole(form, "closeHour"),
      halfLifeDays: whole(form, "halfLifeDays"),
      bands,
    });
    await reviews.setPolicy(await ctx(), input);
    return { message: "Saved. Asking and answering follow it from now." };
  });
  if (!result?.error) {
    revalidatePath(PATH);
    revalidatePath("/reviews");
  }
  return result;
}

/** The days and the words, together, as the reminder's own route takes them. */
export async function saveReminder(_previous: FormState, form: FormData): Promise<FormState> {
  const typed = field(form, "afterDays");
  const result = await attempt(form, async () => {
    const input = parsed(setReviewReminders.input, {
      afterDays: typed === undefined ? null : Number(typed),
      wording: {
        sms: String(form.get("sms") ?? ""),
        emailSubject: String(form.get("emailSubject") ?? ""),
        emailBody: String(form.get("emailBody") ?? ""),
      },
    });
    const saved = await reviews.setReminders(await ctx(), input);
    return {
      message: saved.afterDays === null
        ? "Saved. The reminder is off; its words are kept for when it is on."
        : `Saved. One reminder after ${saved.afterDays} days${saved.wording.custom ? ", in your words" : ""}.`,
    };
  });
  if (!result?.error) {
    revalidatePath(PATH);
    revalidatePath("/reviews");
  }
  return result;
}

/** The words we ship, back. The days stay as they are. */
export async function resetReminderWords(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await reviews.setReminders(await ctx(), { wording: null });
    return { message: "The reminder goes in the words we wrote again." };
  });
  if (!result?.error) revalidatePath(PATH);
  return result;
}

/** A zone the runtime knows, which is every zone the company's own setting offers. */
function validZone(zone: string): boolean {
  if (zone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
