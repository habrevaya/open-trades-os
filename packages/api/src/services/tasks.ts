import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, taskRules } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, decodeCursor, paginate, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";

/**
 * TASKS
 *
 * The work that is not a job. Call this customer back, chase this approval,
 * this invoice needs a purchase order before it can go out.
 *
 * Reading and writing are separate permissions. Letting somebody who can see the
 * queue create work for other people is a different thing, and a queue anybody
 * can add to stops being a queue anybody reads.
 *
 * WHAT A READER MAY DO WITH THEIR OWN WORK: CLAIM IT, TICK IT, FINISH IT. A
 * technician can take an unclaimed task, tick its checklist, and mark a task
 * assigned to them done, with `task:read`, because each of those is acting on
 * your own work, the same class of act as clocking yourself in. It used to stop
 * at claiming, which left a technician who picked work off the queue unable to
 * say they had done it, and the office finishing it for them from a phone call.
 *
 * The rule is narrow on purpose, and it is in `close` rather than in a wider
 * grant. Only a task assigned to the caller, and only finishing it: dismissing
 * one ("we decided not to") is a judgement about whether the work was worth
 * raising and stays with `task:write`, and so does closing anybody else's. The
 * product decision behind it is in `docs/modules/m34-tasks-and-the-office-queue.md`.
 */

export type TaskView = "mine" | "unassigned" | "overdue" | "all";

export interface TaskInput {
  title: string;
  body?: string | undefined;
  priority?: "low" | "normal" | "high" | "urgent" | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  assigneeUserId?: string | undefined;
  queue?: string | undefined;
  dueAt?: Date | undefined;
  /** Things to tick off inside it, in order. */
  checklist?: string[] | undefined;
}

/**
 * Write a task's checklist, in order, inside the transaction that made it.
 *
 * Exported for the recurring pass, which copies a template's list onto each
 * task it raises: the copy is per task, so ticking Monday's does not tick
 * Tuesday's.
 */
export async function writeChecklist(
  tx: Database, organizationId: string, taskId: string, labels: readonly string[], from = 0,
): Promise<void> {
  const clean = labels.map((label) => label.trim()).filter((label) => label !== "");
  if (from + clean.length > taskRules.MAX_CHECKLIST_ITEMS) {
    throw new ConflictError(
      `A checklist holds ${taskRules.MAX_CHECKLIST_ITEMS} items at most. A longer one is a procedure, and belongs in a form.`,
    );
  }
  if (clean.length === 0) return;
  await tx.insert(schema.taskChecklistItem).values(clean.map((label, i) => ({
    organizationId, taskId, label: label.slice(0, 300), position: from + i,
  })));
}

/**
 * Whether a task is late.
 *
 * Derived from the due date and now, never stored. A task that has to be
 * marked overdue by a nightly job is quietly not overdue whenever that job
 * fails, which is the same argument as the invoice aging board.
 */
const isLate = sql`${schema.task.dueAt} is not null
  and ${schema.task.dueAt} < now()
  and ${schema.task.status} in ('open', 'in_progress')`;

export async function list(
  ctx: ServiceContext,
  input: { view?: TaskView; limit?: number; cursor?: string } = {},
) {
  const limit = input.limit ?? 50;
  return guardedRead(ctx, "task:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);

    const view = {
      /**
       * Mine INCLUDES the queues nobody has taken. A "my tasks" list that
       * hides unclaimed work means the unclaimed work is nobody's, which is
       * how a queue silently becomes a backlog.
       */
      mine: or(
        eq(schema.task.assigneeUserId, ctx.actor.userId),
        isNull(schema.task.assigneeUserId),
      ),
      unassigned: isNull(schema.task.assigneeUserId),
      overdue: isLate,
      all: undefined,
    }[input.view ?? "mine"];

    const rows = await tx.select({
      task: schema.task,
      assigneeName: schema.user.name,
      assigneeEmail: schema.user.email,
      /** How far through its checklist, for the queue to say "2 of 5" without opening it. */
      /**
       * The identifiers are written out rather than interpolated: in a select
       * list Drizzle renders a column bare, and a bare "id" inside this
       * subquery would be the checklist item's own id.
       */
      checklistTotal: sql<number>`(select count(*)::int from public.task_checklist_item i where i.task_id = "task"."id")`,
      checklistDone: sql<number>`(select count(*)::int from public.task_checklist_item i where i.task_id = "task"."id" and i.done_at is not null)`,
    })
      .from(schema.task)
      .leftJoin(schema.user, eq(schema.user.id, schema.task.assigneeUserId))
      .where(and(
        // Done and dismissed are out of every view but `all`. A queue that
        // keeps finished work in it is a list nobody can scan.
        input.view === "all" ? undefined : sql`${schema.task.status} in ('open', 'in_progress')`,
        view,
        cursor ? lt(schema.task.createdAt, new Date(cursor)) : undefined,
      ))
      /**
       * Soonest due first, undated last.
       *
       * `nulls last` is explicit and is NOT what produces that today: Postgres
       * already defaults ASC to nulls last. It is defensive against the
       * direction changing. `DESC` defaults to nulls FIRST, so somebody
       * flipping this to show the furthest-out work first would silently move
       * every undated task to the top of the queue, above the thing that is
       * late today, and the diff would look like it only changed the order.
       *
       * The first version of this comment claimed the clause was doing the
       * work, which a deliberate-bug check disproved in one run.
       */
      .orderBy(sql`${schema.task.dueAt} asc nulls last`, desc(schema.task.priority))
      .limit(limit + 1);

    const page = paginate(rows, limit, (r) => r.task.createdAt.toISOString());
    const now = Date.now();
    return {
      ...page,
      data: page.data.map(({ task, assigneeName, assigneeEmail, checklistTotal, checklistDone }) => ({
        ...task,
        assigneeName: assigneeName ?? assigneeEmail,
        checklistTotal: Number(checklistTotal),
        checklistDone: Number(checklistDone),
        overdue: task.dueAt !== null
          && task.dueAt.getTime() < now
          && (task.status === "open" || task.status === "in_progress"),
      })),
    };
  });
}

/**
 * One task, for its own page: where its checklist is ticked and where a task
 * with items unticked is closed with a reason.
 */
export async function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "task:read", async (tx) => {
    const [row] = await tx.select().from(schema.task).where(eq(schema.task.id, input.id)).limit(1);
    if (!row) throw new NotFoundError("Task");
    const named = row.assigneeUserId
      ? (await tx.execute<{ name: string | null; email: string }>(
        sql`select name, email from app.organization_people() where user_id = ${row.assigneeUserId}::uuid`,
      ))[0]
      : undefined;
    return {
      ...row,
      assigneeName: named ? (named.name ?? named.email) : null,
      overdue: row.dueAt !== null && row.dueAt.getTime() < Date.now()
        && (row.status === "open" || row.status === "in_progress"),
    };
  });
}

/** What the navigation badge needs, and nothing more. */
export async function counts(ctx: ServiceContext) {
  return guardedRead(ctx, "task:read", async (tx) => {
    const [row] = await tx.execute<{ mine: number; overdue: number }>(sql`
      select
        count(*) filter (
          where (assignee_user_id = ${ctx.actor.userId}::uuid or assignee_user_id is null)
        )::int as mine,
        count(*) filter (
          where due_at is not null and due_at < now()
        )::int as overdue
      from public.task
      where status in ('open', 'in_progress')
    `);
    return { mine: row?.mine ?? 0, overdue: row?.overdue ?? 0 };
  });
}

export async function create(ctx: ServiceContext, input: TaskInput) {
  const title = input.title.trim();
  if (title === "") throw new ConflictError("A task needs a title");

  return guardedWrite(ctx, "task:write", async (tx) => {
    const [created] = await tx.insert(schema.task).values({
      organizationId: ctx.actor.organizationId,
      title,
      body: input.body ?? null,
      priority: input.priority ?? "normal",
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      queue: input.queue ?? null,
      dueAt: input.dueAt ?? null,
      createdByUserId: ctx.actor.userId,
    }).returning();
    await writeChecklist(tx, ctx.actor.organizationId, created!.id, input.checklist ?? []);

    await audit(tx, ctx, "task.created", "task", created!.id, null, created);
    return created!;
  });
}

/**
 * Raised by an automation rather than a person.
 *
 * Separate from `create` because it carries the run that raised it and
 * because it must be idempotent: a workflow firing on every event would
 * otherwise raise the same "chase this estimate" task every hour until
 * somebody turns the automation off, which is how a queue becomes something
 * people stop opening.
 */
export async function raise(
  tx: Database,
  organizationId: string,
  runId: string,
  input: TaskInput,
): Promise<{ id: string; created: boolean }> {
  const inserted = await tx.insert(schema.task).values({
    organizationId,
    title: input.title.trim(),
    body: input.body ?? null,
    priority: input.priority ?? "normal",
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    assigneeUserId: input.assigneeUserId ?? null,
    queue: input.queue ?? null,
    dueAt: input.dueAt ?? null,
    raisedByRunId: runId,
  }).onConflictDoNothing().returning({ id: schema.task.id });

  if (inserted[0]) return { id: inserted[0].id, created: true };

  const [existing] = await tx.select({ id: schema.task.id }).from(schema.task)
    .where(and(
      eq(schema.task.raisedByRunId, runId),
      input.entityId ? eq(schema.task.entityId, input.entityId) : isNull(schema.task.entityId),
    ))
    .limit(1);
  return { id: existing?.id ?? "", created: false };
}

export async function update(
  ctx: ServiceContext,
  input: { id: string } & Partial<TaskInput> & { status?: "open" | "in_progress" },
) {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const [before] = await tx.select().from(schema.task)
      .where(eq(schema.task.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Task");

    const [after] = await tx.update(schema.task).set({
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
      ...(input.queue !== undefined ? { queue: input.queue } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.task.id, input.id)).returning();

    await audit(tx, ctx, "task.updated", "task", input.id, before, after);
    return after!;
  });
}

/**
 * Finishing, or deciding against.
 *
 * Dismissed is a separate state from done because "we decided not to" and "we
 * did it" are different facts, and a queue where the second quietly absorbs
 * the first tells an owner nothing about how much of the raised work was
 * worth raising.
 */
export async function close(
  ctx: ServiceContext,
  input: { id: string; outcome?: string; dismissed?: boolean; overrideReason?: string },
) {
  return guardedWrite(ctx, "task:read", async (tx) => {
    const [before] = await tx.select().from(schema.task)
      .where(eq(schema.task.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Task");

    /**
     * FINISHING YOUR OWN TASK NEEDS ONLY `task:read`; everything else here
     * needs `task:write`. Checked before anything else is said about the
     * task, so somebody without the right to close it learns nothing from the
     * refusal about its state.
     */
    const ownFinish = before.assigneeUserId === ctx.actor.userId && input.dismissed !== true;
    if (!ownFinish) assertCan(ctx.actor, "task:write");

    if (before.completedAt) throw new ConflictError("That task is already closed");

    if (input.dismissed && !input.outcome?.trim()) {
      // A dismissal with no reason is indistinguishable from a task somebody
      // deleted to make their queue look shorter.
      throw new ConflictError("Say why it was dismissed");
    }

    /**
     * A checklist with items unticked closes as done only with a reason, and
     * the reason is kept apart from the outcome. See `core/tasks`.
     */
    const items = await tx.select({ doneAt: schema.taskChecklistItem.doneAt })
      .from(schema.taskChecklistItem)
      .where(eq(schema.taskChecklistItem.taskId, input.id));
    const verdict = taskRules.closeVerdict({
      items: items.map((item) => ({ done: item.doneAt !== null })),
      dismissed: input.dismissed ?? false,
      overrideReason: input.overrideReason,
    });
    if (!verdict.ok) throw new ConflictError(verdict.message);

    const [after] = await tx.update(schema.task).set({
      status: input.dismissed ? "dismissed" : "done",
      outcome: input.outcome?.trim() || null,
      checklistOverrideReason: verdict.overrideReason,
      completedAt: new Date(),
      completedByUserId: ctx.actor.userId,
      updatedAt: new Date(),
    }).where(eq(schema.task.id, input.id)).returning();

    await audit(tx, ctx, input.dismissed ? "task.dismissed" : "task.completed",
      "task", input.id, before, after);
    return after!;
  });
}

/** Claim an unassigned task. The one write a technician is trusted with. */
export async function claim(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "task:read", async (tx) => {
    /**
     * Conditional, so two people opening the queue at the same moment cannot
     * both take the same task and do the work twice.
     */
    const claimed = await tx.update(schema.task)
      .set({ assigneeUserId: ctx.actor.userId, status: "in_progress", updatedAt: new Date() })
      .where(and(
        eq(schema.task.id, input.id),
        isNull(schema.task.assigneeUserId),
        isNull(schema.task.completedAt),
      ))
      .returning();

    if (!claimed[0]) throw new ConflictError("Somebody else has that one");
    await audit(tx, ctx, "task.claimed", "task", input.id, null, claimed[0]);
    return claimed[0];
  });
}


/**
 * A task on the wire, with every instant as a string.
 *
 * The service works in `Date` because the database does, and the contract
 * publishes ISO strings because JSON has no date. Converting here rather than at
 * each route keeps one answer to "what does a task look like over HTTP".
 */
const onTheWire = (row: {
  id: string; title: string; body: string | null; status: string; priority: string;
  entityType: string | null; entityId: string | null; assigneeUserId: string | null;
  assigneeName: string | null; queue: string | null; dueAt: Date | null;
  completedAt: Date | null; outcome: string | null; raisedByRunId: string | null;
  createdAt: Date; overdue: boolean; escalatedAt: Date | null;
  checklistTotal: number; checklistDone: number; templateId: string | null;
}) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  status: row.status,
  priority: row.priority,
  entityType: row.entityType,
  entityId: row.entityId,
  assigneeUserId: row.assigneeUserId,
  assigneeName: row.assigneeName,
  queue: row.queue,
  dueAt: row.dueAt?.toISOString() ?? null,
  completedAt: row.completedAt?.toISOString() ?? null,
  outcome: row.outcome,
  raisedByRunId: row.raisedByRunId,
  createdAt: row.createdAt.toISOString(),
  overdue: row.overdue,
  escalatedAt: row.escalatedAt?.toISOString() ?? null,
  checklistTotal: row.checklistTotal,
  checklistDone: row.checklistDone,
  templateId: row.templateId,
});

export const handlers = {
  listTasks: async (
    ctx: ServiceContext,
    input: { view?: TaskView | undefined; limit?: number | undefined; cursor?: string | undefined },
  ) => {
    const page = await list(ctx, {
      ...(input.view ? { view: input.view } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return { ...page, data: page.data.map(onTheWire) };
  },

  getTaskCounts: (ctx: ServiceContext) => counts(ctx),

  createTask: async (
    ctx: ServiceContext,
    input: {
      title: string; body?: string | undefined; priority?: TaskInput["priority"];
      entityType?: string | undefined; entityId?: string | undefined;
      assigneeUserId?: string | undefined; queue?: string | undefined;
      dueAt?: string | undefined; checklist?: string[] | undefined;
    },
  ) => ({
    id: (await create(ctx, {
      ...(input.checklist !== undefined ? { checklist: input.checklist } : {}),
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
      ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
      ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
      ...(input.queue !== undefined ? { queue: input.queue } : {}),
      ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt) } : {}),
    })).id,
  }),

  updateTask: async (
    ctx: ServiceContext,
    input: {
      id: string; title?: string | undefined; body?: string | undefined;
      priority?: TaskInput["priority"]; assigneeUserId?: string | undefined;
      queue?: string | undefined; dueAt?: string | undefined;
      status?: "open" | "in_progress" | undefined;
    },
  ) => ({
    id: (await update(ctx, {
      id: input.id,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
      ...(input.queue !== undefined ? { queue: input.queue } : {}),
      ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    })).id,
  }),

  claimTask: async (ctx: ServiceContext, input: { id: string }) => {
    const after = await claim(ctx, input);
    return { id: after.id, assigneeUserId: after.assigneeUserId };
  },

  closeTask: async (
    ctx: ServiceContext,
    input: {
      id: string; outcome?: string | undefined; dismissed?: boolean | undefined;
      overrideReason?: string | undefined;
    },
  ) => {
    const after = await close(ctx, {
      id: input.id,
      ...(input.overrideReason !== undefined ? { overrideReason: input.overrideReason } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.dismissed !== undefined ? { dismissed: input.dismissed } : {}),
    });
    return { id: after.id, status: after.status };
  },
} as const;
