"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { laborSettings, ConflictError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

const minutes = (form: FormData, name: string): number | null => {
  const raw = String(form.get(name) ?? "").trim();
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Declare the overtime policy.
 *
 * Validation is core's, not this action's. `checkOvertimePolicy` refuses a
 * rounding rule that only runs down, a multiplier below one, a double time
 * threshold under the overtime threshold and an undeclared on call
 * treatment, and its messages say why. Re-checking any of that here would
 * make two rules about wages that can disagree, which is the failure this
 * whole module is arranged to avoid.
 */
export async function declarePolicy(_previous: unknown, form: FormData) {
  let result;
  try {
    result = await laborSettings.setPolicy(await ctx(), {
      label: String(form.get("label") ?? ""),
      note: String(form.get("note") ?? ""),
      weekStartsOn: Number(form.get("weekStartsOn") ?? 0),
      dayAttribution: String(form.get("dayAttribution") ?? "shift_start") as "shift_start",
      weeklyThresholdMinutes: minutes(form, "weeklyThresholdMinutes"),
      dailyThresholdMinutes: minutes(form, "dailyThresholdMinutes"),
      overtimeMultiplier: String(form.get("overtimeMultiplier") ?? "1.5"),
      doubleTimeMultiplier: String(form.get("doubleTimeMultiplier") ?? "2"),
      onCallTreatment: String(form.get("onCallTreatment") ?? "") as "hours_worked_at_base",
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/timesheets");
  /**
   * Surfaced rather than swallowed. Overtime classification is derived on
   * read, so a new declaration moves the straight time and overtime split on
   * weeks already signed off. The rates stay frozen; the split does not.
   */
  return { done: true, reclassifies: result.reclassifiesApprovedTime };
}
