"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { attempt, refused, refusalOf } from "@/lib/actions";
import { scheduleFromForm } from "@/lib/schedule-form";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { deliverySchedules } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function createSchedule(_previous: unknown, form: FormData) {
  try {
    await deliverySchedules.createReportSchedule(await ctx(), scheduleFromForm(form));
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
  revalidatePath("/reports/schedules");
  redirect("/reports/schedules");
}

export async function updateSchedule(_previous: unknown, form: FormData) {
  try {
    await deliverySchedules.updateReportSchedule(await ctx(), {
      id: String(form.get("id") ?? ""), ...scheduleFromForm(form),
    });
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
  revalidatePath("/reports/schedules");
  redirect("/reports/schedules");
}

export async function setPaused(_previous: unknown, form: FormData) {
  const result = await attempt(form, async () => deliverySchedules.setReportSchedulePaused(await ctx(), {
    id: String(form.get("id") ?? ""),
    paused: form.get("paused") === "true",
  }));
  revalidatePath("/reports/schedules");
  return result;
}

export async function deleteSchedule(_previous: unknown, form: FormData) {
  const result = await attempt(form, async () => deliverySchedules.removeReportSchedule(await ctx(), {
    id: String(form.get("id") ?? ""),
  }));
  revalidatePath("/reports/schedules");
  return result;
}
