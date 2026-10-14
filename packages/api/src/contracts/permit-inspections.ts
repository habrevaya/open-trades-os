import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE CITY'S INSPECTIONS OF A PERMITTED JOB
 *
 * A permit is a compliance document filed against a job (M23,
 * `POST /v1/compliance/documents` with kind `permit` and the job as its
 * subject). These are the authority's visits under it: the day, the stage,
 * pass or fail, and on a fail what the inspector found and whose work it was
 * about. The electrical pack's first time inspection pass rate is read from
 * them (M21).
 *
 * `job:read` and `document:read` to read, `job:write` to record or take one
 * off.
 */

const Result = z.enum(["passed", "failed"]);
/** Whose work a fail was about: ours, or something outside our work (another trade, the site, the customer's own equipment). */
const FailureScope = z.enum(["our_work", "outside_our_work"]);

export const PermitInspection = z.object({
  id: Uuid,
  permitId: Uuid,
  jobId: Uuid,
  /** The day the inspector came, `YYYY-MM-DD` in the company's calendar. */
  inspectedOn: z.string(),
  /** What the authority calls the visit: "Rough in", "Final". */
  stage: z.string().nullable(),
  result: Result,
  failureScope: FailureScope.nullable(),
  /** What the inspector wrote on a fail. */
  findings: z.string().nullable(),
  inspectorName: z.string().nullable(),
  recordedAt: z.string(),
});

export const JobPermit = z.object({
  id: Uuid,
  name: z.string(),
  /** The permit number. */
  reference: z.string().nullable(),
  /** The city or county that issued it. */
  issuerName: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  state: z.enum(["active", "superseded", "withdrawn"]),
  inspections: z.array(PermitInspection),
});

export const listJobPermitInspections = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/permit-inspections",
  summary: "A job's permits and the authority's inspections under each",
  description:
    "Every permit filed against the job (a compliance document of kind `permit`), each with its inspections in the order they "
    + "happened. `verdict` is where the job stands in the first time inspection pass rate: `passed` when every inspection "
    + "passed, `failed` when one failed for our work, `excluded` when one failed only for something outside our work, and "
    + "null before the first inspection. A job out of the caller's scope is not found.",
  module: "M23",
  permissions: ["job:read", "document:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    jobId: Uuid,
    permits: z.array(JobPermit),
    verdict: z.enum(["passed", "failed", "excluded"]).nullable(),
  }),
});

export const recordPermitInspection = defineRoute({
  method: "post",
  path: "/v1/permit-inspections",
  summary: "Record the authority's inspection of a permitted job",
  description:
    "The permit must be a compliance document of kind `permit` filed against a job the caller can see. A fail needs "
    + "`failureScope` (whose work it was about) and `findings` (what the inspector wrote); a pass takes neither scope. "
    + "Refused for a day still to come or before the permit was issued. Replayed with the same idempotency key, the "
    + "first answer comes back.",
  module: "M23",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    permitId: Uuid,
    inspectedOn: z.string().date(),
    stage: z.string().max(80).nullable().optional(),
    result: Result,
    failureScope: FailureScope.nullable().optional(),
    findings: z.string().max(4000).nullable().optional(),
    inspectorName: z.string().max(120).nullable().optional(),
  }),
  output: PermitInspection,
});

export const removePermitInspection = defineRoute({
  method: "delete",
  path: "/v1/permit-inspections/{id}",
  summary: "Take off an inspection recorded by mistake",
  description: "The audit log keeps what it said. Removing one already gone succeeds and says so.",
  module: "M23",
  permissions: ["job:write"],
  input: z.object({ id: Uuid }),
  output: z.object({ removed: z.boolean() }),
});

export const permitInspectionRoutes = {
  listJobPermitInspections, recordPermitInspection, removePermitInspection,
} as const;
