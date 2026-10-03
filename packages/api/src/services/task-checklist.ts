import { and, asc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, taskRules } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";

/**
 * A CHECKLIST INSIDE A TASK
 *
 * "Open the shop" is six things, and a task that says only that gets closed
 * by somebody who did four. Items are ticked one at a time, each saying who
 * and when, and a task with items unticked closes as done only with a reason
 * (`tasks.close`, through `core/tasks`).
 *
 * TICKING IS ACTING ON YOUR OWN WORK. The person a task is assigned to may
 * tick its items with `task:read`, the same class of act as claiming it;
 * anybody else needs `task:write`. A technician handed the van check can tick
 * the tyres off on the forecourt, which is the whole point of a checklist,
 * and still cannot close the task, which the module doc names as the open
 * question it is.
 */

export interface ChecklistItem {
  id: string;
  label: string;
  position: number;
  done: boolean;
  doneAt: string | null;
  doneBy: string | null;
}

async function loadTask(tx: Database, taskId: string) {
  const [task] = await tx.select().from(schema.task).where(eq(schema.task.id, taskId)).limit(1);
  if (!task) throw new NotFoundError("Task");
  return task;
}

function stillOpen(task: { completedAt: Date | null }): void {
  if (task.completedAt) throw new ConflictError("That task is closed, so its checklist is as it was left.");
}

async function itemsOf(tx: Database, taskId: string): Promise<ChecklistItem[]> {
  const names = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  const byUser = new Map([...names].map((row) => [row.user_id, row.name ?? row.email]));
  const rows = await tx.select().from(schema.taskChecklistItem)
    .where(eq(schema.taskChecklistItem.taskId, taskId))
    .orderBy(asc(schema.taskChecklistItem.position), asc(schema.taskChecklistItem.createdAt));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    position: row.position,
    done: row.doneAt !== null,
    doneAt: row.doneAt?.toISOString() ?? null,
    doneBy: row.doneByUserId ? byUser.get(row.doneByUserId) ?? null : null,
  }));
}

export async function list(ctx: ServiceContext, input: { taskId: string }) {
  return guardedRead(ctx, "task:read", async (tx) => {
    const task = await loadTask(tx, input.taskId);
    const items = await itemsOf(tx, input.taskId);
    const open = items.filter((item) => !item.done).length;
    return {
      taskId: task.id,
      items,
      open,
      /** Whether "done" would be accepted without a reason right now. */
      closable: open === 0,
      overrideReason: task.checklistOverrideReason,
    };
  });
}

export async function add(ctx: ServiceContext, input: { taskId: string; label: string }): Promise<ChecklistItem> {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const seen = await replayed<ChecklistItem>(tx, ctx, "task_checklist_item");
    if (seen) return seen;
    const task = await loadTask(tx, input.taskId);
    stillOpen(task);
    const label = input.label.trim();
    if (label === "") throw new ConflictError("Say what the item is.");

    const [last] = await tx.select({
      n: sql<number>`count(*)::int`,
      top: sql<number | null>`max(${schema.taskChecklistItem.position})`,
    }).from(schema.taskChecklistItem).where(eq(schema.taskChecklistItem.taskId, task.id));
    if (Number(last?.n ?? 0) >= taskRules.MAX_CHECKLIST_ITEMS) {
      throw new ConflictError(
        `A checklist holds ${taskRules.MAX_CHECKLIST_ITEMS} items at most. A longer one is a procedure, and belongs in a form.`,
      );
    }
    await tx.insert(schema.taskChecklistItem).values({
      organizationId: ctx.actor.organizationId,
      taskId: task.id,
      label: label.slice(0, 300),
      position: last?.top === null || last?.top === undefined ? 0 : Number(last.top) + 1,
    });
    const items = await itemsOf(tx, task.id);
    const made = items[items.length - 1]!;
    await audit(tx, ctx, "task.checklist_added", "task", task.id, null, { label });
    await remember(tx, ctx, "task_checklist_item", made.id, made);
    return made;
  });
}

/**
 * Tick an item, or untick it. Setting a state rather than flipping one, so a
 * retry lands where the first call did.
 */
export async function tick(
  ctx: ServiceContext, input: { taskId: string; itemId: string; done: boolean },
): Promise<ChecklistItem> {
  return guardedWrite(ctx, "task:read", async (tx) => {
    const task = await loadTask(tx, input.taskId);
    if (task.assigneeUserId !== ctx.actor.userId) assertCan(ctx.actor, "task:write");
    stillOpen(task);

    const [item] = await tx.select().from(schema.taskChecklistItem)
      .where(and(eq(schema.taskChecklistItem.id, input.itemId), eq(schema.taskChecklistItem.taskId, task.id)))
      .limit(1);
    if (!item) throw new NotFoundError("Checklist item");

    if ((item.doneAt !== null) !== input.done) {
      await tx.update(schema.taskChecklistItem).set({
        doneAt: input.done ? new Date() : null,
        doneByUserId: input.done ? ctx.actor.userId : null,
        updatedAt: new Date(),
      }).where(eq(schema.taskChecklistItem.id, item.id));
      await audit(tx, ctx, input.done ? "task.checklist_ticked" : "task.checklist_unticked", "task", task.id,
        null, { itemId: item.id, label: item.label });
    }
    const items = await itemsOf(tx, task.id);
    return items.find((i) => i.id === item.id)!;
  });
}

/** Take an item off. Gone already is not a refusal: the list is what was asked for. */
export async function remove(
  ctx: ServiceContext, input: { taskId: string; itemId: string },
): Promise<{ id: string; removed: true }> {
  return guardedWrite(ctx, "task:write", async (tx) => {
    const task = await loadTask(tx, input.taskId);
    stillOpen(task);
    const gone = await tx.delete(schema.taskChecklistItem)
      .where(and(eq(schema.taskChecklistItem.id, input.itemId), eq(schema.taskChecklistItem.taskId, task.id)))
      .returning({ label: schema.taskChecklistItem.label });
    if (gone[0]) {
      await audit(tx, ctx, "task.checklist_removed", "task", task.id, { label: gone[0].label }, null);
    }
    return { id: input.itemId, removed: true as const };
  });
}

export const handlers = {
  getTaskChecklist: (ctx: ServiceContext, input: { id: string }) => list(ctx, { taskId: input.id }),
  addTaskChecklistItem: (ctx: ServiceContext, input: { id: string; label: string }) =>
    add(ctx, { taskId: input.id, label: input.label }),
  tickTaskChecklistItem: (ctx: ServiceContext, input: { id: string; itemId: string; done: boolean }) =>
    tick(ctx, { taskId: input.id, itemId: input.itemId, done: input.done }),
  removeTaskChecklistItem: (ctx: ServiceContext, input: { id: string; itemId: string }) =>
    remove(ctx, { taskId: input.id, itemId: input.itemId }),
} as const;
