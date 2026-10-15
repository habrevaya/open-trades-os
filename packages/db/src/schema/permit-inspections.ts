import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, date, index, timestamp, check } from "drizzle-orm/pg-core";
import { pk } from "./_shared";
import { organization, user } from "./tenancy";
import { complianceDocument } from "./compliance";
import { job } from "./work";

/**
 * WHAT THE CITY'S INSPECTOR SAID ABOUT A PERMITTED JOB.
 *
 * A permit is a compliance document filed against a job (`compliance_document`
 * with kind `permit`, subject `job`). What it did not hold was the authority's
 * visits to that job: the rough in, the final, the reinspection after a
 * correction notice, and whether each one passed. M33's `inspection` is a
 * different thing and is not reused for this: it is the CONTRACTOR'S own
 * statutory inspection of a property (a backflow test, a fire system) with a
 * programme of checkpoints, and the city signing off a panel change has
 * neither a programme nor checkpoints. It has a date, a stage, a pass or a
 * fail, and on a fail a correction notice.
 *
 * WHOSE WORK A FAIL WAS ABOUT. The electrical pack's first time inspection
 * pass rate EXCLUDES jobs failed for something outside the electrical scope
 * ("counting those hides whether the crews are the problem"), and nothing
 * else in the product can say that: an inspector failing a rough in because
 * the framer had not finished is not the electrician's miss. So a fail says
 * whose it was, chosen from two, and is refused without it, rather than
 * guessed later from the inspector's words. The words are kept as well.
 *
 * Deleted outright when somebody recorded one by mistake, with the audit log
 * keeping what it said: there is no state for a visit the inspector did not
 * make, and a kept row nobody counts is a row somebody later counts.
 */
export const permitInspectionResult = pgEnum("permit_inspection_result", ["passed", "failed"]);

/**
 * `our_work`: the inspector failed something we installed or should have.
 * `outside_our_work`: another trade's work, the site not ready, the customer's
 * own equipment, a missing plan from somebody else.
 */
export const permitFailureScope = pgEnum("permit_failure_scope", ["our_work", "outside_our_work"]);

export const permitInspection = pgTable("permit_inspection", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The permit it was made under: a compliance document of kind `permit` filed against the job. */
  permitId: uuid("permit_id").notNull().references(() => complianceDocument.id, { onDelete: "cascade" }),
  /**
   * The job the permit is filed against, copied when the inspection is
   * recorded so a report reads it without unpacking the document's subject
   * pair. The service refuses one that disagrees with the permit.
   */
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  /** The day the inspector came, in the company's calendar. */
  inspectedOn: date("inspected_on").notNull(),
  /** What the authority calls this visit: "Rough in", "Final", "Service release". Free text, for people. */
  stage: text("stage"),
  result: permitInspectionResult("result").notNull(),
  /** Whose work a fail was about. Required on a fail and empty on a pass. */
  failureScope: permitFailureScope("failure_scope"),
  /** What the inspector wrote: the correction notice, in their words. Required on a fail. */
  findings: text("findings"),
  inspectorName: text("inspector_name"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** A job's inspections in the order they happened, which is what the pass rate reads. */
  jobIdx: index("permit_inspection_job_idx").on(t.organizationId, t.jobId, t.inspectedOn),
  permitIdx: index("permit_inspection_permit_idx").on(t.permitId),
  /** A fail says whose it was and what was found; a pass says neither. */
  scopeOnFail: check("permit_inspection_scope_on_fail",
    sql`(${t.result} = 'failed') = (${t.failureScope} is not null)`),
  findingsOnFail: check("permit_inspection_findings_on_fail",
    sql`${t.result} <> 'failed' or (${t.findings} is not null and length(trim(${t.findings})) > 0)`),
}));
