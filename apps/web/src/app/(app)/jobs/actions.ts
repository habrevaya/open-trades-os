"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs } from "@opentradesos/api/services";
import { createJob, scheduleVisit } from "@opentradesos/api/contracts";
import { attempt, field, fields, parsed, type FormState, refused } from "@/lib/actions";
import { windowFrom } from "@/lib/visit-window";

/**
 * BOOKING A JOB, FROM THE OFFICE
 *
 * Booking existed only as `POST /v1/jobs`, so the definition of done for the
 * first phase (a person who has never seen the code books a job) could not
 * be met by a person. This is that call, made by the form: the input is
 * parsed by the route's own schema, the service decides everything, and a
 * refusal (a technician on holiday, a property that is not this customer's)
 * comes back as the service's sentence under the form.
 */
export async function bookJob(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const window = windowFrom({
    date: field(form, "date"), start: field(form, "start"), windowHours: field(form, "windowHours"),
  }, user.organizationTimezone);
  if (window.kind === "invalid") return refused(form, window.message);

  let createdId: string | null = null;
  const result = await attempt(form, async () => {
    const input = parsed(createJob.input, {
      customerId: field(form, "customerId"),
      propertyId: field(form, "propertyId"),
      jobTypeId: field(form, "jobTypeId"),
      summary: field(form, "summary") ?? "",
      description: field(form, "description"),
      customerComplaint: field(form, "customerComplaint"),
      ...(window.kind === "window"
        ? {
            visit: {
              windowStart: window.windowStart,
              windowEnd: window.windowEnd,
              estimatedDurationMinutes: Number(field(form, "duration") ?? "60"),
              technicianIds: fields(form, "technicianIds"),
            },
          }
        : {}),
    });
    const job = await jobs.create({ actor: user.actor, db: getDb() }, input);
    createdId = job.id;
  });
  if (!createdId) return result;
  redirect(`/jobs/${createdId}`);
}

/**
 * Another visit on a job already booked: a second day, a return with the
 * part, a crew of two for the install.
 */
export async function addVisit(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const jobId = field(form, "jobId") ?? "";
  const window = windowFrom({
    date: field(form, "date"), start: field(form, "start"), windowHours: field(form, "windowHours"),
  }, user.organizationTimezone);
  if (window.kind === "invalid") return refused(form, window.message);

  const result = await attempt(form, async () => {
    const input = parsed(scheduleVisit.input, {
      id: jobId,
      ...(window.kind === "window" ? { windowStart: window.windowStart, windowEnd: window.windowEnd } : {}),
      estimatedDurationMinutes: Number(field(form, "duration") ?? "60"),
      technicianIds: fields(form, "technicianIds"),
    });
    await jobs.addVisit({ actor: user.actor, db: getDb() }, input);
  });
  revalidatePath(`/jobs/${jobId}`);
  return result;
}
