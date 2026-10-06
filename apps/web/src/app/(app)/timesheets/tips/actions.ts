"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { attempt, field, type FormState } from "@/lib/actions";
import { cashTips } from "@opentradesos/api/services";

/**
 * Putting a cash tip on somebody's pay, and changing one. The service decides
 * who may (`tip:record`, for the people the reader's timesheet scope reaches),
 * that a reason is given, that a likely duplicate is refused and that a pay
 * period which has gone to payroll is not changed; this only turns the form
 * into the call and hands the refusal back as written.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/timesheets/tips");
  revalidatePath("/me/pay");
}

export async function record(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const jobNumber = field(form, "jobNumber");
    const made = await cashTips.recordFor(await ctx(), {
      technicianId: field(form, "technicianId") ?? "",
      amount: field(form, "amount") ?? "",
      ...(field(form, "receivedOn") ? { receivedOn: field(form, "receivedOn")! } : {}),
      ...(jobNumber ? { jobNumber: Number(jobNumber) } : {}),
      reason: field(form, "reason") ?? "",
    });
    return { message: `Put on ${made.technicianName}'s pay. They can see it, and why, under My pay.` };
  });
  if (state?.done) refresh();
  return state;
}

export async function correct(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const fixed = await cashTips.correct(await ctx(), {
      id: String(form.get("id") ?? ""),
      amount: field(form, "amount") ?? "",
      reason: field(form, "reason") ?? "",
    });
    return { message: Number(fixed.amount) === 0 ? "Taken off their pay." : "Changed. They can see why under My pay." };
  });
  if (state?.done) refresh();
  return state;
}
