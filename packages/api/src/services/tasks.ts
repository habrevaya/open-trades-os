import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  guardedRead, guardedWrite, decodeCursor, paginate,
  NotFoundError, ConflictError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * TASKS
 *
 * The work that is not a job. Call this customer back, chase this approval,
 * this invoice needs a purchase order before it can go out.
 *
 * Reading and writing are separate permissions. A technician can be handed a
 * task and complete it; letting them create work for other people is a
 * different thing, and a queue anybody can add to stops being a queue anybody
 * reads.
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
      data: page.data.map(({ task, assigneeName, assigneeEmail }) => ({
        ...task,
        assigneeName: assigneeName ?? assigneeEmail,
        overdue: task.dueAt !== null
          && task.dueAt.getTime() < now
          && (task.status === "open" || task.status === "in_progress"),
      })),
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
  input: { id: string; outcome?: string; dismissed?: boolean },
) {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const [before] = await tx.select().from(schema.task)
      .where(eq(schema.task.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Task");
    if (before.completedAt) throw new ConflictError("That task is already closed");

    if (input.dismissed && !input.outcome?.trim()) {
      // A dismissal with no reason is indistinguishable from a task somebody
      // deleted to make their queue look shorter.
      throw new ConflictError("Say why it was dismissed");
    }

    const [after] = await tx.update(schema.task).set({
      status: input.dismissed ? "dismissed" : "done",
      outcome: input.outcome?.trim() || null,
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

