"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { expenses } from "@opentradesos/api/services";
import { recordPerDiem } from "@opentradesos/api/contracts";

/**
 * Deciding what the company pays back, and recording a day away. The service
 * decides who may (`expense:approve`, for the people the approver's timesheet
 * scope reaches), that a refusal says why, that a decision is final, and that
 * a day inside a closed pay period is refused; this only turns the form into
 * the call and hands the refusal back as written.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/timesheets/expenses");
  revalidatePath("/me/expenses");
  revalidatePath("/payroll");
}

export async function decide(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const decision = String(form.get("decision") ?? "") === "refuse" ? "refuse" : "approve";
    const done = await expenses.decide(await ctx(), {
      id: String(form.get("id") ?? ""), decision, reason: field(form, "reason") ?? null,
    });
    return {
      message: decision === "approve"
        ? done.paidIn
          ? `Approved. It goes out with ${done.paidIn.label}, with no tax taken.`
          : "Approved. No pay period covers today yet, so it will not go to payroll until one does."
        : "Refused. They will see why.",
    };
  });
  if (state?.done) refresh();
  return state;
}

export async function perDiem(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const jobNumber = field(form, "jobNumber");
    const done = await expenses.recordPerDiem(await ctx(), parsed(recordPerDiem.input, {
      technicianId: field(form, "technicianId") ?? "",
      ...(jobNumber ? { jobNumber: Number(jobNumber) } : {}),
      from: field(form, "from") ?? "",
      to: field(form, "to") ?? field(form, "from") ?? "",
      note: field(form, "note") ?? null,
    }));
    const days = done.recorded.length;
    const had = done.alreadyHad.length;
    return {
      message: `${days === 0 ? "No new days" : `${days} ${days === 1 ? "day" : "days"} recorded`} at ${done.rate}${had > 0 ? `. ${had} already had one and were left as they were` : ""}.`,
    };
  });
  if (state?.done) refresh();
  return state;
}

export async function removeDay(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await expenses.removePerDiem(await ctx(), { id: String(form.get("id") ?? "") });
    return { message: "Taken out." };
  });
  if (state?.done) refresh();
  return state;
}
