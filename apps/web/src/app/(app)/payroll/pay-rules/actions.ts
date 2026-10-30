"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { laborSettings, mileageOverrides, payExtras } from "@opentradesos/api/services";

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

      case "extras": {
        const rule = field(form, "tipSplit");
        /** Left empty means pay none, which is a choice the box has to be able to make. */
        await payExtras.set(ctx, {
          perDiemRate: field(form, "perDiemRate") ?? null,
          ...(rule === "even" || rule === "hours" || rule === "lead" ? { tipSplit: rule } : {}),
        });
        return { message: "Saved. Tips are shared this way from the next one, and a day away is recorded at this rate from now on. What was already shared or recorded keeps what it was worked out at." };
      }

      case "mileageAdd":
        await payExtras.addMileageRate(ctx, { from: field(form, "from") ?? "", perMile: field(form, "perMile") ?? "" });
        return { message: "Saved. Claims in miles for days from then on are worked out at this rate. Claims already made keep theirs." };

      case "mileageRemove":
        await payExtras.removeMileageRate(ctx, { from: field(form, "from") ?? "" });
        return { message: "Taken off. Claims already made keep the rate they were worked out at." };

      case "mileageOverrideAdd": {
        const technicianId = field(form, "technicianId");
        const assetId = field(form, "assetId");
        const jobTypeId = field(form, "jobTypeId");
        await mileageOverrides.add(ctx, {
          ...(technicianId ? { technicianId } : {}), ...(assetId ? { assetId } : {}), ...(jobTypeId ? { jobTypeId } : {}),
          from: field(form, "from") ?? "", perMile: field(form, "perMile") ?? "",
        });
        return { message: "Saved. Claims in miles for days from then on are worked out at this rate for them. Claims already made keep theirs." };
      }

      case "mileageOverrideRemove":
        await mileageOverrides.remove(ctx, { id: field(form, "id") ?? "" });
        return { message: "Taken off. Claims already made keep the rate they were worked out at." };

      case "placeAdd": {
        await payExtras.addPerDiemPlace(ctx, {
          name: field(form, "name") ?? "",
          city: field(form, "city") ?? null,
          state: field(form, "state") ?? null,
          from: field(form, "from") ?? "",
          perDay: field(form, "perDay") ?? "",
        });
        return { message: "Added. A day away recorded there from its first day is worked out at this rate." };
      }

      case "placeRateAdd":
        await payExtras.addPerDiemPlaceRate(ctx, {
          id: String(form.get("id") ?? ""), from: field(form, "from") ?? "", perDay: field(form, "perDay") ?? "",
        });
        return { message: "Saved. Days recorded there from then on are worked out at this rate. Days already recorded keep theirs." };

      case "placeRateRemove":
        await payExtras.removePerDiemPlaceRate(ctx, { id: String(form.get("id") ?? ""), from: String(form.get("from") ?? "") });
        return { message: "Taken off. Days already recorded keep the rate they were worked out at." };

      case "placeRetire":
        await payExtras.retirePerDiemPlace(ctx, { id: String(form.get("id") ?? "") });
        return { message: "No longer used. Days already recorded there keep its name and their rate." };

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
