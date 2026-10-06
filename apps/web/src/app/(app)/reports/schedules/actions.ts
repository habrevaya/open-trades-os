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

/**
 * Send one now, as the person pressing it. The page then shows the delivery
 * under "Last", with who it went to and why anybody was left out, and the
 * sentence here says when the email itself leaves.
 */
export async function sendNow(_previous: unknown, form: FormData) {
  const result = await attempt(form, async () => {
    const sent = await deliverySchedules.sendReportScheduleNow(await ctx(), { id: String(form.get("id") ?? "") });
    const going = sent.recipients.filter((r) => !r.refused).length;
    return {
      message: going === 0
        ? "Run, and sent to nobody. The list below says why."
        : `Queued for ${going} ${going === 1 ? "person" : "people"}. It leaves with the next email the worker sends.`,
    };
  });
  revalidatePath("/reports/schedules");
  return result;
}
