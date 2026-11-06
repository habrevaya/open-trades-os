"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { files } from "@opentradesos/api/services";
import { moveFormFileToJob } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * A FILE A LEAD SENT, PUT ON ONE OF THE CUSTOMER'S JOBS:
 * `POST /v1/attachments/{id}/job`, with the route's two permissions
 * (`document:read` and `job:write`) checked by the service, which keeps the
 * file's kind so nobody new can see it, and writes the audit row.
 */
export async function moveFormFile(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = field(form, "customerId") ?? "";
  let jobId: string | null = null;
  const result = await attempt(form, async () => {
    const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
    const moved = await files.moveFormFileToJob(ctx, parsed(moveFormFileToJob.input, {
      id: field(form, "id"), jobId: field(form, "jobId"),
    }));
    jobId = moved.entityId;
    return { message: "Moved onto the job." };
  });
  revalidatePath(`/customers/${customerId}`);
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return result;
}
