"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { numberHours } from "@opentradesos/api/services";
import { addNumberHoliday } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * A phone number's hours: where they come from, its own week, and its own
 * days off. `requireUser` and the service's own check, as on Settings.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

const refresh = (id: string) => {
  revalidatePath(`/settings/numbers/${id}`);
  revalidatePath("/settings");
};

const HOURS_FROM = ["branch", "company", "own"] as const;
const hoursFromOf = (value: string | undefined) =>
  HOURS_FROM.find((h) => h === value) ?? "branch";

/** Its branch's hours, the company's, or its own (which it must already have). */
export async function saveHoursFrom(_previous: unknown, form: FormData): Promise<NonNullable<FormState>> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    await numberHours.setHours(await ctx(), { id, hoursFrom: hoursFromOf(field(form, "hoursFrom")) });
    return { message: "Saved." };
  });
  refresh(id);
  return result ?? { done: true };
}

/** Its own seven days, which also sets it to keep its own hours. */
export async function saveOwnWeek(_previous: unknown, form: FormData): Promise<NonNullable<FormState>> {
  const id = field(form, "id") ?? "";
  const days = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
    const closed = form.get(`closed-${dayOfWeek}`) === "on";
    const opensAt = String(form.get(`opens-${dayOfWeek}`) ?? "");
    const closesAt = String(form.get(`closes-${dayOfWeek}`) ?? "");
    return { dayOfWeek, opensAt: closed || !opensAt ? null : opensAt, closesAt: closed || !closesAt ? null : closesAt, closed };
  });
  const result = await attempt(form, async () => {
    await numberHours.setHours(await ctx(), { id, hoursFrom: "own", days });
  });
  refresh(id);
  return result ?? { done: true };
}

/** A day off of the number's own: a date, every year or once, closed or open shorter. */
export async function addOwnHoliday(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const open = field(form, "day") === "open";
    const input = parsed(addNumberHoliday.input, {
      id,
      name: field(form, "name"),
      date: field(form, "date") || undefined,
      repeatsYearly: form.get("repeatsYearly") === "yes",
      closed: !open,
      ...(open ? { opensAt: field(form, "opensAt") ?? null, closesAt: field(form, "closesAt") ?? null } : {}),
    });
    await numberHours.addHoliday(await ctx(), input);
  });
  refresh(id);
  return result;
}

export async function removeOwnHoliday(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    await numberHours.removeHoliday(await ctx(), { id, holidayId: field(form, "holidayId") ?? "" });
  });
  refresh(id);
  return result;
}
