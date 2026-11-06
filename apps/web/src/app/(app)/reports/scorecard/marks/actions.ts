"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, fields, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { packMarks, ConflictError } from "@opentradesos/api/services";

/**
 * Marking a job type or an item as the trade pack's, through the service:
 * its checks (only marks the scorecard reads, settings rights) are the
 * service's, so a refusal here is the service's own sentence.
 */
export async function act(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const state = await attempt(form, async () => {
    const marks = fields(form, "mark");
    switch (op) {
      case "jobType": {
        await packMarks.setJobTypeMarks(ctx, { id: String(form.get("id") ?? ""), marks });
        return { message: marks.length > 0 ? "Saved. The scorecard counts it from now on, for every month." : "Saved. The scorecard no longer counts it." };
      }
      case "item": {
        const id = field(form, "id");
        if (!id) throw new ConflictError("Choose the item.");
        await packMarks.setItemMarks(ctx, { id, marks });
        return { message: marks.length > 0 ? "Saved. The scorecard counts it from now on, for every month." : "Saved. The scorecard no longer counts it." };
      }
      default:
        throw new Error(`Unknown operation: ${op}`);
    }
  });
  if (state?.done) revalidatePath("/reports/scorecard/marks");
  return state;
}
