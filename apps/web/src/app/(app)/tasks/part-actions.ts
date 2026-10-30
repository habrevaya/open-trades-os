"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobHolds } from "@opentradesos/api/services";
import { attempt, field, refused, type FormState } from "@/lib/actions";

/**
 * PUTTING THE JOB ON HOLD FOR A PART A TECHNICIAN ASKED FOR, FROM ITS TASK
 *
 * The office names the purchase order the part is on, and the hold is placed
 * through the same service as the job page's hold, saying which request it
 * answers: the request is linked to the hold and the task is finished.
 */
export async function holdForPart(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const jobId = field(form, "jobId") ?? "";
  const taskId = field(form, "taskId") ?? "";
  const purchaseOrderId = field(form, "purchaseOrderId");
  if (!purchaseOrderId) return refused(form, "Choose the purchase order the part is on. Write one under Purchasing first if there is none.");
  const note = field(form, "note");
  const result = await attempt(form, async () => {
    await jobHolds.place({ actor: user.actor, db: getDb() }, {
      id: jobId, reason: "part", purchaseOrderId, partRequestId: field(form, "partRequestId") ?? "",
      ...(note ? { note } : {}),
    });
    return { message: "The job is on hold for the part, and this task is done." };
  });
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath(`/jobs/${jobId}`);
  return result;
}
