"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { retention } from "@opentradesos/api/services";

/** Changing a rule, holds, and purging now. Every refusal is the service's. */
export async function act(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "purge-on":
        await retention.updatePolicy(ctx, { id, purgeAllowed: true });
        return { message: "Purging is on for this rule. The daily pass removes what the preview lists." };
      case "purge-off":
        await retention.updatePolicy(ctx, { id, purgeAllowed: false });
        return { message: "Purging is off. Nothing this rule covers is removed." };
      case "months":
        await retention.updatePolicy(ctx, { id, retainMonths: Number(field(form, "retainMonths") ?? "") });
        return { message: "Changed." };
      case "hold":
        await retention.placeHold(ctx, {
          entityType: field(form, "entityType") ?? "",
          entityId: field(form, "entityId") ?? "",
          reason: field(form, "reason") ?? "",
        });
        return { message: "Held. It is kept whatever its age until the hold is released." };
      case "release":
        await retention.releaseHold(ctx, { id, ...(field(form, "note") ? { note: field(form, "note")! } : {}) });
        return { message: "Released." };
      case "run": {
        const run = await retention.runNow(ctx);
        return {
          message: `Removed ${run.purged}. Kept ${run.held} on hold.${run.failed > 0 ? ` ${run.failed} could not be removed; the reasons are below.` : ""}`,
        };
      }
      default:
        throw new Error(`Unknown op: ${op}`);
    }
  });
  if (state?.done) revalidatePath("/compliance/retention");
  return state;
}
