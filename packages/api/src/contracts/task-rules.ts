import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { TaskPriority } from "./tasks";

/**
 * RECURRING TASKS, ESCALATION AND CHECKLISTS (M34)
 *
 * The queue could hold work and could not do anything with it on its own: a
 * late task stayed late and told nobody, work that comes round every Monday
 * had to be typed in every Monday, and "open the shop" was one line somebody
 * closed after doing four of its six things.
 *
 * The worker raises recurring tasks and applies escalation rules; these
 * routes are where a company says what to raise and when to escalate, and
 * where a checklist inside one task is read and ticked.
 */

const IsoDate = z.string().date();
const Frequency = z.enum([
  "daily", "weekdays", "weekly", "every_other_week", "monthly", "last_weekday_of_month",
]);

const Template = z.object({
  id: Uuid,
  title: z.string(),
  body: z.string().nullable(),
  priority: TaskPriority,
  assigneeUserId: Uuid.nullable(),
  assigneeName: z.string().nullable(),
  queue: z.string().nullable(),
  frequency: Frequency,
  /** For `weekly`, `every_other_week` and `last_weekday_of_month`: 0 is Sunday. */
  weekday: z.number().int().nullable(),
  /** For monthly: 1 to 31, held to the month's length. */
  monthDay: z.number().int().nullable(),
  /** Minutes after the company's midnight. */
  dueMinutes: z.number().int(),
  checklist: z.array(z.string()),
  startsOn: IsoDate,
  /** Raises nothing on a date the company's holiday list says it is closed. */
  skipHolidays: z.boolean(),
  active: z.boolean(),
  lastRaisedOn: IsoDate.nullable(),
  /** "Every Monday". */
  schedule: z.string(),
  /** The next day it raises a task for, in the company's calendar. Null when paused. */
  nextOn: IsoDate.nullable(),
});

const TemplateFields = {
  title: z.string().min(1).max(300),
  body: z.string().max(5000).optional(),
  priority: TaskPriority.optional(),
  assigneeUserId: Uuid.nullable().optional(),
  queue: z.string().max(60).optional(),
  frequency: Frequency,
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  monthDay: z.number().int().min(1).max(31).nullable().optional(),
  dueMinutes: z.number().int().min(0).max(1439).optional(),
  checklist: z.array(z.string().min(1).max(300)).max(50).optional(),
  startsOn: IsoDate.optional(),
  /** Skip an occurrence that falls on a date the holiday list says the company is closed. Skipped, not moved. */
  skipHolidays: z.boolean().optional(),
};

export const listTaskTemplates = defineRoute({
  method: "get",
  path: "/v1/task-templates",
  summary: "The tasks that come round again",
  description:
    "Each with its schedule in words and the next day it raises a task for, read from the same function the worker uses.",
  module: "M34",
  permissions: ["task:read"],
  input: z.object({}),
  output: z.object({ templates: z.array(Template) }),
});

export const createTaskTemplate = defineRoute({
  method: "post",
  path: "/v1/task-templates",
  summary: "Make a task come round on a schedule",
  description:
    "`frequency` is `daily`, `weekdays` (Monday to Friday), `weekly` (needs `weekday`), `every_other_week` (needs `weekday`, counted from the first such weekday on or after `startsOn`), `monthly` (needs `monthDay`) or `last_weekday_of_month` (needs `weekday`: the last Friday, say). Raised by the worker on the day, in the company's own timezone, due at `dueMinutes` past its midnight. One task per day per template whatever the worker does: the task carries the template and the day under a unique index. A worker that was down raises the latest occurrence, not every one it missed.",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object(TemplateFields),
  output: Template,
});

export const updateTaskTemplate = defineRoute({
  method: "patch",
  path: "/v1/task-templates/{id}",
  summary: "Change a recurring task, or pause it",
  description:
    "Applies to the tasks it raises from now on. Ones already in the queue are left as they are, because somebody may be halfway through one.",
  module: "M34",
  permissions: ["task:write"],
  input: z.object({
    id: Uuid,
    ...TemplateFields,
    title: TemplateFields.title.optional(),
    frequency: Frequency.optional(),
    active: z.boolean().optional(),
  }),
  output: Template,
});

const Target = z.enum(["manager", "role", "person"]);
const MemberRole = z.enum([
  "owner", "admin", "office_manager", "branch_manager", "dispatcher", "csr", "technician", "crew_lead", "accountant", "readonly",
]);

const Rule = z.object({
  id: Uuid,
  name: z.string(),
  afterHours: z.number().int(),
  minimumPriority: TaskPriority.nullable(),
  target: Target,
  targetRole: z.string().nullable(),
  targetUserId: Uuid.nullable(),
  targetName: z.string().nullable(),
  reassignToUserId: Uuid.nullable(),
  reassignToName: z.string().nullable(),
  active: z.boolean(),
  /** What it does, as a sentence. */
  summary: z.string(),
  /** How many times it has acted. */
  fired: z.number().int(),
});

const RuleFields = {
  name: z.string().min(1).max(120),
  afterHours: z.number().int().min(1).max(672),
  minimumPriority: TaskPriority.nullable().optional(),
  target: Target,
  targetRole: MemberRole.nullable().optional(),
  targetUserId: Uuid.nullable().optional(),
  reassignToUserId: Uuid.nullable().optional(),
};

export const listTaskEscalationRules = defineRoute({
  method: "get",
  path: "/v1/task-escalation-rules",
  summary: "What happens when a task stays late",
  module: "M34",
  permissions: ["task:read"],
  input: z.object({}),
  output: z.object({ rules: z.array(Rule) }),
});

export const createTaskEscalationRule = defineRoute({
  method: "post",
  path: "/v1/task-escalation-rules",
  summary: "Tell somebody when a task is late, and optionally hand it over",
  description:
    "After `afterHours` past due, the worker tells the assignee's manager, everybody in a role, or a named person, with a task in their queue linked to the late one and an email when the company sends email, and hands the task to `reassignToUserId` when one is set. Once per task per rule, recorded before anybody is told. With no manager recorded, or nobody in the role, the owners are told and the record says why.",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object(RuleFields),
  output: Rule,
});

export const updateTaskEscalationRule = defineRoute({
  method: "patch",
  path: "/v1/task-escalation-rules/{id}",
  summary: "Change an escalation rule, or turn it off",
  description: "A task it already acted on is not acted on again under the changed rule.",
  module: "M34",
  permissions: ["task:write"],
  input: z.object({
    id: Uuid,
    ...RuleFields,
    name: RuleFields.name.optional(),
    afterHours: RuleFields.afterHours.optional(),
    target: Target.optional(),
    active: z.boolean().optional(),
  }),
  output: Rule,
});

export const listTaskEscalations = defineRoute({
  method: "get",
  path: "/v1/tasks/{id}/escalations",
  summary: "What escalation has done to one task",
  module: "M34",
  permissions: ["task:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    escalations: z.array(z.object({
      id: Uuid,
      rule: z.string(),
      at: z.string(),
      notified: z.array(z.string()),
      note: z.string().nullable(),
      reassignedTo: z.string().nullable(),
    })),
  }),
});

const Item = z.object({
  id: Uuid,
  label: z.string(),
  position: z.number().int(),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
});

export const getTaskChecklist = defineRoute({
  method: "get",
  path: "/v1/tasks/{id}/checklist",
  summary: "The things to tick off inside a task",
  module: "M34",
  permissions: ["task:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    taskId: Uuid,
    items: z.array(Item),
    open: z.number().int(),
    /** Whether "done" would be accepted without a reason right now. */
    closable: z.boolean(),
    /** Why it was closed with items unticked, when it was. */
    overrideReason: z.string().nullable(),
  }),
});

export const addTaskChecklistItem = defineRoute({
  method: "post",
  path: "/v1/tasks/{id}/checklist",
  summary: "Add an item to a task's checklist",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object({ id: Uuid, label: z.string().min(1).max(300) }),
  output: Item,
});

export const tickTaskChecklistItem = defineRoute({
  method: "post",
  path: "/v1/tasks/{id}/checklist/{itemId}/tick",
  summary: "Tick an item off, or untick it",
  description:
    "`task:read` for the person the task is assigned to, because ticking off your own work is the same class of act as claiming it; anybody else needs `task:write`. Sets a state rather than flipping one, so a retry lands where the first call did.",
  module: "M34",
  permissions: ["task:read"],
  idempotent: true,
  input: z.object({ id: Uuid, itemId: Uuid, done: z.boolean() }),
  output: Item,
});

export const removeTaskChecklistItem = defineRoute({
  method: "post",
  path: "/v1/tasks/{id}/checklist/{itemId}/remove",
  summary: "Take an item off a task's checklist",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object({ id: Uuid, itemId: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const listReportingLines = defineRoute({
  method: "get",
  path: "/v1/reporting-lines",
  summary: "Who answers to whom",
  description:
    "Read by escalation, where \"tell the assignee's manager\" needs a person and a role preset is not one, and shown on a person's own page (`reportsTo` on `GET /v1/people/{membershipId}`).",
  module: "M34",
  permissions: ["user:read"],
  input: z.object({}),
  output: z.object({
    people: z.array(z.object({
      userId: Uuid,
      name: z.string(),
      role: z.string(),
      reportsToUserId: Uuid.nullable(),
      reportsToName: z.string().nullable(),
    })),
  }),
});

export const setReportingLine = defineRoute({
  method: "post",
  path: "/v1/reporting-lines",
  summary: "Say who somebody answers to",
  description: "`reportsToUserId: null` records that nobody is. Setting a value is idempotent by nature.",
  module: "M34",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ userId: Uuid, reportsToUserId: Uuid.nullable() }),
  output: z.object({ userId: Uuid, reportsToUserId: Uuid.nullable() }),
});

export const taskRuleRoutes = {
  listTaskTemplates, createTaskTemplate, updateTaskTemplate,
  listTaskEscalationRules, createTaskEscalationRule, updateTaskEscalationRule, listTaskEscalations,
  getTaskChecklist, addTaskChecklistItem, tickTaskChecklistItem, removeTaskChecklistItem,
  listReportingLines, setReportingLine,
} as const;
