"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { laborSettings } from "@opentradesos/api/services";

/** Hours typed on the form, as the minutes the policy is declared in, or null when left empty. */
function minutes(form: FormData, name: string): number | null {
  const value = field(form, name);
  if (value === undefined) return null;
  const hours = Number(value);
  return Number.isFinite(hours) ? Math.round(hours * 60) : Number.NaN;
}

/**
 * Declaring the overtime policy, loading, changing and retiring wage scales,
 * and saying who is paid at which classification.
 *
 * Every rule is the service's and core's: a rounding rule that only runs
 * down, double time below overtime, a prevailing wage that cites nothing, a
 * change dated before the scale began. This only turns the form into the
 * call and hands the refusal back as written.
 */
export async function act(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "policy": {
        const roundingMinutes = field(form, "roundingMinutes");
        const declared = await laborSettings.setPolicy(ctx, {
          label: field(form, "label") ?? "",
          note: field(form, "note") ?? "",
          weekStartsOn: Number(field(form, "weekStartsOn") ?? "0"),
          weeklyThresholdMinutes: minutes(form, "weeklyHours"),
          weeklyDoubleTimeThresholdMinutes: minutes(form, "weeklyDoubleHours"),
          dailyThresholdMinutes: minutes(form, "dailyHours"),
          dailyDoubleTimeThresholdMinutes: minutes(form, "dailyDoubleHours"),
          overtimeMultiplier: field(form, "overtimeMultiplier") ?? "1.5",
          doubleTimeMultiplier: field(form, "doubleTimeMultiplier") ?? "2",
          onCallTreatment: field(form, "onCallTreatment") as "separate_rate_not_hours_worked",
          roundingMinutes: roundingMinutes ? Number(roundingMinutes) : null,
          roundingMode: (field(form, "roundingMode") ?? null) as "nearest" | "up" | "down" | null,
        });
        return {
          message: declared.reclassifiesApprovedTime
            ? `Declared. It replaces "${declared.replaced}", and weeks already approved are now split into straight time and overtime by this one. Their rates do not change.`
            : "Declared.",
        };
      }

      case "load":
        await laborSettings.setScale(ctx, {
          classification: field(form, "classification") ?? "",
          baseRate: field(form, "baseRate") ?? "",
          authority: (field(form, "authority") ?? "employee_default") as "employee_default",
          externalReference: field(form, "externalReference") ?? null,
          jurisdiction: field(form, "jurisdiction") ?? null,
          fringeRate: field(form, "fringeRate") ?? null,
          overtimeMultiplier: field(form, "overtimeMultiplier") ?? null,
          doubleTimeMultiplier: field(form, "doubleTimeMultiplier") ?? null,
          apprenticeRatio: field(form, "apprenticeRatio") ?? null,
          effectiveFrom: field(form, "effectiveFrom") ?? null,
        });
        return { message: "Loaded." };

      case "revise": {
        const scale = await laborSettings.reviseScale(ctx, {
          id: String(form.get("id") ?? ""),
          baseRate: field(form, "baseRate") ?? "",
          effectiveFrom: field(form, "effectiveFrom") ?? "",
          ...(field(form, "fringeRate") ? { fringeRate: field(form, "fringeRate")! } : {}),
        });
        return { message: `Changed from ${scale.effectiveFrom}. Time worked before then keeps its old rate.` };
      }

      case "retire":
        await laborSettings.closeScale(ctx, {
          id: String(form.get("id") ?? ""),
          effectiveTo: field(form, "effectiveTo") ?? "",
        });
        return { message: "Retired. It stays on the record for the time already costed at it." };

      case "classify":
        await laborSettings.setClassification(ctx, {
          technicianId: String(form.get("technicianId") ?? ""),
          classification: field(form, "classification") ?? null,
        });
        return { message: "Saved." };

      default:
        throw new Error(`Unknown op: ${op}`);
    }
  });

  if (state?.done) revalidatePath("/payroll/pay-rules");
  return state;
}
