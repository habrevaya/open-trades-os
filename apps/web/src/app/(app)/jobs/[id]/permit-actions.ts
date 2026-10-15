"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { compliance, permitInspections } from "@opentradesos/api/services";
import { recordPermitInspection } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * A permit on this job: a compliance document of kind `permit` with the job as
 * its subject, so it sits in the register with its expiry and renewal like any
 * other document, and the city's inspections can be recorded under it.
 */
export async function filePermit(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = String(form.get("jobId") ?? "");
  const said = await attempt(form, async () => compliance.handlers.registerComplianceDocument(await ctx(), {
    kind: "permit",
    name: field(form, "name") ?? "",
    reference: field(form, "reference") ?? null,
    issuerName: field(form, "issuerName") ?? null,
    issuedOn: field(form, "issuedOn") ?? null,
    expiresOn: field(form, "expiresOn") ?? null,
    subjectType: "job",
    subjectId: jobId,
  }));
  if (said?.done) revalidatePath(`/jobs/${jobId}`);
  return said;
}

/** One of the inspector's visits, through the route's own schema. */
export async function recordInspection(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = String(form.get("jobId") ?? "");
  const result = field(form, "result");
  const said = await attempt(form, async () => permitInspections.handlers.recordPermitInspection(await ctx(), parsed(recordPermitInspection.input, {
    permitId: field(form, "permitId"),
    inspectedOn: field(form, "inspectedOn"),
    stage: field(form, "stage") ?? null,
    result,
    /** Whose work only means something on a fail; on a pass the box is ignored rather than refused. */
    failureScope: result === "failed" ? field(form, "failureScope") ?? null : null,
    findings: field(form, "findings") ?? null,
    inspectorName: field(form, "inspectorName") ?? null,
  })));
  if (said?.done) revalidatePath(`/jobs/${jobId}`);
  return said;
}

export async function removeInspection(_previous: FormState, form: FormData): Promise<FormState> {
  const jobId = String(form.get("jobId") ?? "");
  const said = await attempt(form, async () => permitInspections.handlers.removePermitInspection(await ctx(), {
    id: String(form.get("inspectionId") ?? ""),
  }));
  if (said?.done) revalidatePath(`/jobs/${jobId}`);
  return said;
}
