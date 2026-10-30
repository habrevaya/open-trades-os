"use server";

import { attempt, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { people } from "@opentradesos/api/services";

/**
 * "Days ahead" for every card that is ticked, at once. The cards are ticked in the list below the form
 * (checkboxes that name this form), and a box left blank hands them all back to their kinds' numbers.
 * The service refuses the whole set, in words, when one of them cannot take a number.
 */
export async function setRenewalDaysForTicked(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
    const ids = form.getAll("id").map((v) => String(v)).filter((v) => v !== "");
    const typed = String(form.get("renewalLeadDays") ?? "").trim();
    const renewalLeadDays = typed === "" ? null : /^\d+$/.test(typed) ? Number(typed) : Number.NaN;
    const done = await people.handlers.setCertificationRenewalDaysMany(ctx, { ids, renewalLeadDays });
    const one = done.holdings.length === 1;
    const cards = one ? "1 card" : `${done.holdings.length} cards`;
    const follow = one ? "follows its kind's number" : "follow their kinds' numbers";
    return {
      message: done.changed === 0
        ? `${cards} already ${renewalLeadDays === null ? follow : `warn${one ? "s" : ""} ${renewalLeadDays} days ahead`}. Nothing changed.`
        : renewalLeadDays === null
          ? `Saved. ${cards} now ${follow}.`
          : `Saved. ${cards} now warn${one ? "s" : ""} ${renewalLeadDays} days ahead.`,
    };
  });
  revalidatePath("/certifications");
  return result;
}
