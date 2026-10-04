"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { attempt, field, type FormState } from "@/lib/actions";
import { timeOff } from "@opentradesos/api/services";

/**
 * Answering time off. The service decides who may (`timesheet:approve`, for
 * the people the approver's timesheet scope reaches), that an overlap with
 * leave already granted is refused, and that taking an approval back needs a
 * reason.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/timesheets/time-off");
  revalidatePath("/schedule");
  revalidatePath("/me/time-off");
}

export async function approve(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const done = await timeOff.approve(await ctx(), { id: String(form.get("id") ?? "") });
    return { message: `Approved. ${done.technicianName ?? "They"} will show as away on the board.` };
  });
  if (state?.done) refresh();
  return state;
}

export async function decline(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await timeOff.decline(await ctx(), { id: String(form.get("id") ?? ""), reason: field(form, "reason") ?? null });
    return { message: "Done." };
  });
  if (state?.done) refresh();
  return state;
}
