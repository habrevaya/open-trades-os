"use server";

import { attempt, field, fields, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { company } from "@opentradesos/api/services";

export type ServiceAreaState = FormState;

/**
 * Declaring, renaming and retiring a territory.
 *
 * Every refusal here is the service's own: a territory with no name, and the
 * one that matters, a postal code already claimed by another territory. An
 * address can only be in one service area, so the overlap check is in
 * `services/company.ts` where both the API and this screen go through it,
 * rather than in a validator either caller could skip.
 */
export async function act(_previous: ServiceAreaState, form: FormData): Promise<ServiceAreaState> {
  // `requireUser`: the setup wizard's service area step posts here too.
  const ctx = { actor: (await requireUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "create":
        return company.createTerritory(ctx, {
          name: field(form, "name") ?? "",
          postalCodes: codesFrom(form),
          travelFee: field(form, "travelFee") ?? null,
        });
      case "edit": {
        /**
         * An empty codes box CLEARS the codes, and an empty fee box clears the
         * fee back to the company default. Both are real intents, which is why
         * neither goes through `field`'s "undefined when empty": leaving a
         * territory's codes alone is done by not submitting this form.
         */
        return company.updateTerritory(ctx, {
          id: String(form.get("id") ?? ""),
          name: field(form, "name") ?? "",
          postalCodes: codesFrom(form),
          travelFee: field(form, "travelFee") ?? null,
        });
      }
      case "retire":
        return company.updateTerritory(ctx, { id: String(form.get("id") ?? ""), active: false });
      case "restore":
        return company.updateTerritory(ctx, { id: String(form.get("id") ?? ""), active: true });
      default:
        throw new Error(`Unknown op: ${op}`);
    }
  });

  if (state?.done) {
    revalidatePath("/settings/service-area");
    revalidatePath("/setup/service-area");
  }
  return state;
}

/**
 * Codes typed the way somebody types them: separated by commas, spaces or new
 * lines, because a box that only accepts one of the three is a box people get
 * wrong once and then distrust. The service normalises and de-duplicates what
 * comes out of here.
 */
function codesFrom(form: FormData): string[] {
  return fields(form, "postalCodes").flatMap((value) => value.split(/[\s,;]+/)).filter((v) => v !== "");
}
