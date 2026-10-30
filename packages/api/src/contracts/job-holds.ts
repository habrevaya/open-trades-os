import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { JobStatus } from "./jobs";

/**
 * WHY A JOB IS ON HOLD
 *
 * A hold is a record with a reason from a fixed list, and a part hold names
 * the purchase order the part is on. The plumbing and electrical first time
 * fix rates leave out "jobs held for a part order" (an electrician's "or an
 * inspection"), and they read this, never the words in a note.
 */
export const HoldReason = z.enum(["part", "inspection", "customer", "weather", "other"]);

export const JobHold = z.object({
  id: Uuid,
  jobId: Uuid,
  reason: HoldReason,
  /** The reason as an owner says it: "Waiting on a part". */
  reasonLabel: z.string(),
  purchaseOrderId: Uuid.nullable(),
  /** Null for a reader without `po:read`, who is told an order was named and not which. */
  purchaseOrderNumber: z.number().int().nullable(),
  purchaseOrderStatus: z.string().nullable(),
  note: z.string().nullable(),
  /** Where the job goes back to when it comes off hold. */
  statusBefore: JobStatus,
  placedAt: z.string().datetime(),
  placedByName: z.string().nullable(),
  /** Null while the job is still held. */
  releasedAt: z.string().datetime().nullable(),
});

const Holds = z.object({ data: z.array(JobHold) });

export const listJobHolds = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/holds",
  summary: "Why a job is, or was, on hold",
  description: "Every hold the job has had, oldest first. The open one has no `releasedAt`.",
  module: "M10",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: Holds,
});

export const placeJobHold = defineRoute({
  method: "post",
  path: "/v1/jobs/{id}/holds",
  summary: "Put a job on hold, saying why",
  description:
    "Moves a booked job, or one under way, to on hold with a reason from a fixed list. A part hold names the purchase order the part is on (and needs `po:read` to name it); an inspection, or anything else, says which in `note`. A job already on hold for a reason is refused: take it off hold first. A job moved to on hold before reasons existed can be given one here, and goes back to booked when it comes off.",
  module: "M10",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: HoldReason,
    purchaseOrderId: Uuid.optional(),
    note: z.string().max(2000).optional(),
    /**
     * The part a technician asked for from the field (`GET /v1/jobs/{id}/part-requests`) that this
     * hold answers. Only with `reason: "part"`, once per request: the request names the hold and
     * the office task it raised is finished.
     */
    partRequestId: Uuid.optional(),
  }),
  output: Holds,
});

export const PartRequest = z.object({
  id: Uuid,
  jobId: Uuid,
  visitId: Uuid.nullable(),
  /** The part in the technician's words. */
  part: z.string(),
  note: z.string().nullable(),
  requestedAt: z.string().datetime(),
  /** Who asked, by their name on the team. */
  requestedBy: z.string().nullable(),
  /** The office task it raised, and that task's status. */
  taskId: Uuid.nullable(),
  taskStatus: z.string().nullable(),
  /** The hold the office placed from it. Null until then. */
  holdId: Uuid.nullable(),
  /** The order the hold names. Null before a hold, and for a reader without `po:read`. */
  purchaseOrderId: Uuid.nullable(),
  purchaseOrderNumber: z.number().int().nullable(),
});

export const listJobPartRequests = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/part-requests",
  summary: "Parts a technician asked for from the field",
  description:
    "Every part asked for on the job from the phone (`part.request` in the field queue), oldest first, each with the office task it raised and, once the office put the job on hold for it, the hold and the order. A technician never places a hold; the office does, from the task, with `partRequestId` on `POST /v1/jobs/{id}/holds`.",
  module: "M10",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ data: z.array(PartRequest) }),
});

export const releaseJobHold = defineRoute({
  method: "post",
  path: "/v1/job-holds/{id}/released",
  summary: "Take a job off hold",
  description:
    "Closes the hold and puts the job back in the status it was held from. A job somebody already moved off hold some other way only has its hold closed (an ordinary status change closes it too).",
  module: "M10",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Holds,
});

const HoldNudgeAssign = z.enum(["nobody", "placed_by", "person", "role", "branch_manager"]);
/** The roles a nudge can go to: the ones that work in the office. */
const HoldNudgeRole = z.enum(["owner", "admin", "office_manager", "branch_manager", "dispatcher", "csr", "accountant"]);

const HoldNudge = z.object({
  /** How many days on hold before the office is nudged. Null: off. */
  days: z.number().int().min(1).max(90).nullable(),
  /** Company days the office has to act on the task, from the day it is raised. Null: no due date. */
  dueDays: z.number().int().min(0).max(30).nullable(),
  /** Days after one nudge to raise it again while the job is still on hold. Null: never. */
  repeatDays: z.number().int().min(1).max(90).nullable(),
  /**
   * Who the task goes to: nobody (the office queue), whoever put the job on hold, a named person,
   * everybody in a role (`assigneeRole`) or the manager of the job's branch.
   */
  assignTo: HoldNudgeAssign,
  assigneeUserId: Uuid.nullable(),
  assigneeName: z.string().nullable(),
  /** Only when `assignTo` is `role`; left out otherwise. */
  assigneeRole: HoldNudgeRole.optional(),
});

/** Every field is optional: one left out keeps what the company had. */
const HoldNudgeChange = z.object({
  days: HoldNudge.shape.days.optional(),
  dueDays: HoldNudge.shape.dueDays.optional(),
  repeatDays: HoldNudge.shape.repeatDays.optional(),
  assignTo: HoldNudgeAssign.optional(),
  assigneeUserId: Uuid.nullable().optional(),
  assigneeRole: HoldNudgeRole.nullable().optional(),
});

export const getJobHoldNudge = defineRoute({
  method: "get",
  path: "/v1/job-hold-nudge",
  summary: "How a job left on hold is nudged: after how long, due when, raised again, and for whom",
  module: "M10",
  permissions: ["settings:read"],
  input: z.object({}),
  output: HoldNudge,
});

export const setJobHoldNudge = defineRoute({
  method: "patch",
  path: "/v1/job-hold-nudge",
  summary: "Set how a job left on hold is nudged",
  description:
    "`days`: whole days from 1 to 90, counted in the company's own calendar, or null to turn nudging off (it is off until a company turns it on). When a hold has lasted that long the worker raises one task in the office queue about the job, naming the job, the reason it is held and how long; ending the hold closes it. `dueDays`: the task is due that many company days after it is raised (0 to 30), so the queue's late rules act on it; null leaves it without a due date. `repeatDays`: while the job is still on hold, raise the task again that many days after the last one (1 to 90), but only once the last one has been closed; null never raises it again. `assignTo` is `nobody` (the office queue), `placed_by` (whoever put the job on hold; a job has no owner of its own), `person` (with `assigneeUserId`, somebody who works here now), `role` (with `assigneeRole`: everybody who holds that role is told, and the one task stays in the office queue for whoever acts on it) or `branch_manager` (the same, for the managers of the job's own branch); a person who has left, a role nobody holds, a job in no branch or a branch with no manager is skipped and the task stays in the office queue, and says so. A field left out keeps what the company had. Without repeats, a task somebody closed by hand is not raised again for the same hold. Holds already past a new `days` are nudged on the next pass, and tasks already raised stay where they are.",
  module: "M10",
  permissions: ["settings:write"],
  idempotent: true,
  input: HoldNudgeChange,
  output: HoldNudge,
});

/* ---------------------------------------------- the nudge by reason and branch */

const RuleAssignTo = HoldNudgeAssign;

/**
 * What one rule changes. A field left out is "as the company has it"; a field
 * set to null is "none": no nudge at all (`days`), no due date (`dueDays`), never
 * raised again (`repeatDays`). `assignTo` with the person or role it needs is one choice.
 */
const RuleChanges = {
  days: HoldNudge.shape.days.optional(),
  dueDays: HoldNudge.shape.dueDays.optional(),
  repeatDays: HoldNudge.shape.repeatDays.optional(),
  assignTo: RuleAssignTo.optional(),
  assigneeUserId: Uuid.nullable().optional(),
  assigneeRole: HoldNudgeRole.nullable().optional(),
};

const HoldNudgeRuleView = z.object({
  id: Uuid,
  /** Null: whatever the reason. */
  reason: HoldReason.nullable(),
  reasonLabel: z.string().nullable(),
  /** Null: whatever the branch. */
  businessUnitId: Uuid.nullable(),
  businessUnitName: z.string().nullable(),
  ...RuleChanges,
  /** The person's name, when the rule gives the task to a person. */
  assigneeName: z.string().nullable(),
  /** What the rule says, as a sentence. */
  summary: z.string(),
});

export const listJobHoldNudgeRules = defineRoute({
  method: "get",
  path: "/v1/job-hold-nudge-rules",
  summary: "The nudge for a job on hold, where it differs by reason or by branch",
  description:
    "Each rule changes some of the company's nudge numbers (`GET /v1/job-hold-nudge`) for one reason, one branch, or one reason in one branch. A field a rule leaves out is the company's. For a hold, the rule for its reason in its branch wins, then the rule for its reason, then the rule for its branch, then the company's numbers, field by field.",
  module: "M10",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ data: z.array(HoldNudgeRuleView) }),
});

export const createJobHoldNudgeRule = defineRoute({
  method: "post",
  path: "/v1/job-hold-nudge-rules",
  summary: "Nudge differently for one reason a job is on hold, one branch, or both",
  description:
    "Names a reason (`part`, `inspection`, `customer`, `weather`, `other`), a branch (`businessUnitId`) or both; at least one, because a rule for everything is the company's own setting. Says what changes: `days` (null: never nudge for these), `dueDays` (null: no due date), `repeatDays` (null: never again), and who gets the task (`assignTo`, with `assigneeUserId` for a person or `assigneeRole` for a role). One rule for each reason and branch. It applies to nudges raised from then on, and holds already nudged keep what they were given.",
  module: "M10",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    reason: HoldReason.nullable().optional(),
    businessUnitId: Uuid.nullable().optional(),
    ...RuleChanges,
  }),
  output: HoldNudgeRuleView,
});

export const updateJobHoldNudgeRule = defineRoute({
  method: "patch",
  path: "/v1/job-hold-nudge-rules/{id}",
  summary: "Change a nudge rule",
  description:
    "A field left out keeps what the rule had. `clear` lists fields to hand back to the company's own (`days`, `dueDays`, `repeatDays`, `assign`). A rule left changing nothing is refused: delete it instead. The reason and the branch of a rule are not changed: make another rule.",
  module: "M10",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    ...RuleChanges,
    clear: z.array(z.enum(["days", "dueDays", "repeatDays", "assign"])).max(4).optional(),
  }),
  output: HoldNudgeRuleView,
});

export const deleteJobHoldNudgeRule = defineRoute({
  method: "delete",
  path: "/v1/job-hold-nudge-rules/{id}",
  summary: "Take away a nudge rule",
  description: "Holds it covered use the company's numbers, or another rule's, from the next pass. Tasks already raised stay where they are.",
  module: "M10",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const jobHoldRoutes = { listJobHolds, placeJobHold, releaseJobHold, getJobHoldNudge, setJobHoldNudge, listJobPartRequests,
  listJobHoldNudgeRules, createJobHoldNudgeRule, updateJobHoldNudgeRule, deleteJobHoldNudgeRule,
} as const;
