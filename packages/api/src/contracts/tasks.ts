import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, PageRequest, pageOf } from "./common";

/**
 * THE OFFICE WORK QUEUE, ON THE API
 *
 * `services/tasks.ts` was reachable only from `/tasks`, so the work that is not a
 * job (call this customer back, chase this approval, this invoice needs a purchase
 * order before it can go out) could not be created or completed by anything but a
 * person on a screen.
 *
 * That is the wrong way round for this module in particular, because the workflow
 * engine is its main author: relying on somebody to notice that an estimate went
 * unanswered for five days is relying on a report nobody runs, and a task is what
 * turns an event into something a person actually sees. An integration that wants
 * to put work in front of the office had nowhere to put it, and an agent could
 * read a job and not raise the follow up it just decided was needed.
 *
 * READ AND WRITE ARE SEPARATE PERMISSIONS, which is the module's one real rule. A
 * technician can be handed a task and complete it; letting them create work for
 * other people is a different thing, and a queue anybody can add to stops being a
 * queue anybody reads.
 */

export const TaskPriority = z.enum(["low", "normal", "high", "urgent"]);
export const TaskStatusValue = z.enum(["open", "in_progress", "done", "dismissed"]);

/**
 * Which slice of the queue.
 *
 * `mine` INCLUDES the queues nobody has taken, deliberately. A "my tasks" list
 * that hides unclaimed work means the unclaimed work is nobody's, which is how a
 * queue silently becomes a backlog.
 */
export const TaskViewName = z.enum(["mine", "unassigned", "overdue", "all"]);

export const TaskRow = z.object({
  id: Uuid,
  title: z.string(),
  body: z.string().nullable(),
  status: TaskStatusValue,
  priority: TaskPriority,
  entityType: z.string().nullable(),
  entityId: Uuid.nullable(),
  assigneeUserId: Uuid.nullable(),
  /** The person's name, or their email when they have no name set. */
  assigneeName: z.string().nullable(),
  queue: z.string().nullable(),
  dueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  outcome: z.string().nullable(),
  /** The run that raised it, when an automation did rather than a person. */
  raisedByRunId: Uuid.nullable(),
  createdAt: z.string(),
  /**
   * DERIVED from the due date and the clock, never stored. A task that has to be
   * marked overdue by a nightly job is quietly not overdue whenever that job
   * fails.
   */
  overdue: z.boolean(),
  /** When an escalation rule first acted on it. Null when none has. */
  escalatedAt: z.string().nullable(),
  /** Its checklist, counted, so a queue can say "2 of 5" without opening each one. */
  checklistTotal: z.number().int(),
  checklistDone: z.number().int(),
  /** The recurring template that raised it, when one did. */
  templateId: Uuid.nullable(),
});

export const listTasks = defineRoute({
  method: "get",
  path: "/v1/tasks",
  summary: "The office work queue",
  description:
    "Ordered by due date with undated work last, then by priority. The sort is written out rather than left to a default because `desc` puts nulls first, so flipping the direction would silently move every undated task above the thing that is late today and the change would look like it only touched the order.",
  module: "M34",
  permissions: ["task:read"],
  input: PageRequest.extend({ view: TaskViewName.optional() }),
  output: pageOf(TaskRow),
});

export const getTaskCounts = defineRoute({
  method: "get",
  path: "/v1/tasks/counts",
  summary: "How much is mine and how much is late",
  description:
    "What a navigation badge needs and nothing more. `mine` counts the unclaimed queues too, for the same reason the list does.",
  module: "M34",
  permissions: ["task:read"],
  input: z.object({}),
  output: z.object({ mine: z.number().int(), overdue: z.number().int() }),
});

export const createTask = defineRoute({
  method: "post",
  path: "/v1/tasks",
  summary: "Put work in front of the office",
  description:
    "A task hangs off the record it is about, so following one up opens the estimate rather than a sentence describing it. A to-do list of sentences makes somebody reconstruct the context before they can act, and the reconstruction is most of the work.",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object({
    title: z.string().min(1).max(300),
    body: z.string().max(5000).optional(),
    priority: TaskPriority.optional(),
    entityType: z.string().max(60).optional(),
    entityId: Uuid.optional(),
    assigneeUserId: Uuid.optional(),
    queue: z.string().max(60).optional(),
    dueAt: z.string().datetime().optional(),
    /** Things to tick off inside it, in order. Fifty at most. */
    checklist: z.array(z.string().min(1).max(300)).max(50).optional(),
  }),
  output: z.object({ id: Uuid }),
});

export const updateTask = defineRoute({
  method: "patch",
  path: "/v1/tasks/{id}",
  summary: "Change a task, or pick it up",
  description:
    "Only to `open` or `in_progress`: finishing and deciding against are their own call, because they carry an outcome and this does not.",
  module: "M34",
  permissions: ["task:write"],
  input: z.object({
    id: Uuid,
    title: z.string().min(1).max(300).optional(),
    body: z.string().max(5000).optional(),
    priority: TaskPriority.optional(),
    assigneeUserId: Uuid.optional(),
    queue: z.string().max(60).optional(),
    dueAt: z.string().datetime().optional(),
    status: z.enum(["open", "in_progress"]).optional(),
  }),
  output: z.object({ id: Uuid }),
});

/**
 * `task:read`, AND IT IS THE ONLY WRITE IN THIS MODULE GUARDED BY A READ.
 *
 * Taking an unclaimed task is acting on your own work, which is the same class of
 * act as clocking yourself in, and it is the one write a technician is trusted
 * with. Declaring `task:write` here would be the drift this project just spent a
 * commit removing: the service checks `task:read` and the published list has to
 * say so, or a role built from the docs is refused.
 *
 * Closing is still `task:write`, so a technician can take a task and cannot
 * finish it. That asymmetry is named rather than papered over, in
 * `docs/modules/m34-tasks-and-the-office-queue.md`.
 */
export const claimTask = defineRoute({
  method: "post",
  path: "/v1/tasks/{id}/claim",
  summary: "Take an unclaimed task",
  description:
    "Assigns it to the caller, conditionally, so two people opening the queue at the same moment cannot both take it and do the work twice. Separate from a patch that sets an assignee, because taking work and giving somebody else work are different acts and a queue where the second looks like the first is one people stop trusting. Needs only `task:read`: acting on your own work is the one write somebody who can see the queue is trusted with.",
  module: "M34",
  permissions: ["task:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, assigneeUserId: Uuid.nullable() }),
});

export const closeTask = defineRoute({
  method: "post",
  path: "/v1/tasks/{id}/close",
  summary: "Finish a task, or decide against it",
  description:
    "DISMISSED IS A SEPARATE STATE FROM DONE. \"We decided not to\" and \"we did it\" are different facts, and a queue where the second quietly absorbs the first tells an owner nothing about how much of the raised work was worth raising. A dismissal with no reason is indistinguishable from a task somebody could not be bothered with, so it is refused.",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    outcome: z.string().max(2000).optional(),
    dismissed: z.boolean().optional(),
    /**
     * Why it is done with checklist items unticked. Required in that case and
     * kept apart from the outcome, because "gauge missing" is a finding.
     */
    overrideReason: z.string().max(2000).optional(),
  }),
  output: z.object({ id: Uuid, status: TaskStatusValue }),
});

export const taskRoutes = {
  listTasks, getTaskCounts, createTask, updateTask, claimTask, closeTask,
} as const;
