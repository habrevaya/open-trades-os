"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { afterHours, holidays } from "@opentradesos/api/services";
import { createHoliday } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * Not `requireSetupUser`: the same forms are drawn on the setup wizard's
 * hours step, where setup is by definition not finished.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/** Both pages that draw the list, so a change shows on whichever one it was made from. */
function refresh() {
  revalidatePath("/settings/holidays");
  revalidatePath("/setup/hours");
}

/** A holiday: closed all day, or open with hours of its own. */
export async function addHoliday(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const open = field(form, "day") === "open";
    const input = parsed(createHoliday.input, {
      name: field(form, "name"),
      date: field(form, "date"),
      repeatsYearly: form.get("repeatsYearly") === "yes",
      closed: !open,
      ...(open ? { opensAt: field(form, "opensAt") ?? null, closesAt: field(form, "closesAt") ?? null } : {}),
    });
    await holidays.create(await ctx(), input);
  });
  refresh();
  return result;
}

export async function removeHoliday(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await holidays.remove(await ctx(), { id: field(form, "id") ?? "" });
  });
  refresh();
  return result;
}

/** Which item is charged after hours and which on a holiday. Empty is none. */
export async function saveRates(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await afterHours.setRates(await ctx(), {
      afterHoursItemId: field(form, "afterHoursItemId") || null,
      holidayItemId: field(form, "holidayItemId") || null,
    });
    return { message: "Saved." };
  });
  revalidatePath("/settings/holidays");
  revalidatePath("/setup/rates");
  return result;
}
