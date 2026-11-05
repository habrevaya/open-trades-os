"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { menuHours } from "@opentradesos/api/services";
import { addMenuHoliday } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * A phone menu's hours: whose it goes by, its own week, and its own days off.
 * `requireUser` and the service's own check, as on Settings, Phone.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

const refresh = (id: string) => {
  revalidatePath(`/settings/phone/menus/${id}`);
  revalidatePath("/settings/phone");
};

/**
 * The choice comes as one value: `number`, `company`, `own`, or
 * `branch:<id>` for a branch's hours, so one list chooses both.
 */
export async function saveMenuHoursFrom(_previous: unknown, form: FormData): Promise<NonNullable<FormState>> {
  const id = field(form, "id") ?? "";
  const chosen = field(form, "hoursFrom") ?? "number";
  const result = await attempt(form, async () => {
    if (chosen.startsWith("branch:")) {
      await menuHours.setHours(await ctx(), { id, hoursFrom: "branch", businessUnitId: chosen.slice("branch:".length) });
    } else {
      const hoursFrom = chosen === "company" || chosen === "own" ? chosen : "number";
      await menuHours.setHours(await ctx(), { id, hoursFrom });
    }
    return { message: "Saved." };
  });
  refresh(id);
  return result ?? { done: true };
}

/** Its own seven days, which also sets it to keep its own hours. */
export async function saveMenuOwnWeek(_previous: unknown, form: FormData): Promise<NonNullable<FormState>> {
  const id = field(form, "id") ?? "";
  const days = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
    const closed = form.get(`closed-${dayOfWeek}`) === "on";
    const opensAt = String(form.get(`opens-${dayOfWeek}`) ?? "");
    const closesAt = String(form.get(`closes-${dayOfWeek}`) ?? "");
    return { dayOfWeek, opensAt: closed || !opensAt ? null : opensAt, closesAt: closed || !closesAt ? null : closesAt, closed };
  });
  const result = await attempt(form, async () => {
    await menuHours.setHours(await ctx(), { id, hoursFrom: "own", days });
  });
  refresh(id);
  return result ?? { done: true };
}

/** A day off of the menu's own: a date, every year or once, closed or open shorter. */
export async function addMenuOwnHoliday(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const open = field(form, "day") === "open";
    const input = parsed(addMenuHoliday.input, {
      id,
      name: field(form, "name"),
      date: field(form, "date") || undefined,
      repeatsYearly: form.get("repeatsYearly") === "yes",
      closed: !open,
      ...(open ? { opensAt: field(form, "opensAt") ?? null, closesAt: field(form, "closesAt") ?? null } : {}),
    });
    await menuHours.addHoliday(await ctx(), input);
  });
  refresh(id);
  return result;
}

export async function removeMenuOwnHoliday(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    await menuHours.removeHoliday(await ctx(), { id, holidayId: field(form, "holidayId") ?? "" });
  });
  refresh(id);
  return result;
}
