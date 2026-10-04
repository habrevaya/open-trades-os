import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { voice, type telephony } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import { directoryFor } from "./phone-menus";

/**
 * WAITING LINES
 *
 * "All our team are on other calls." A phone menu option, the after hours
 * setting or a ring group's no answer can send a caller to a waiting line:
 * they hear music and their place in line, the people in the line's ring
 * group are rung until one of them answers, and after the longest wait the
 * company allows they go to voicemail or wherever the line says.
 *
 * Saved and checked here, against what exists, the way a menu is
 * (`phone-menus.ts`); a call's time in the line is in `voice.ts`, beside the
 * rest of what a call does. `settings:read` to see them and `settings:write`
 * to change them, the same as every other part of how the company's number
 * answers.
 */

type Destination = telephony.RoutingDestination;

export interface QueueView {
  id: string;
  name: string;
  ringGroupId: string;
  ringGroupName: string | null;
  maxWaitSeconds: number;
  announcePosition: boolean;
  holdMusicUrl: string | null;
  overflowTo: Destination;
}

type Row = typeof schema.callQueue.$inferSelect;

export const queueOf = (row: Row): voice.CallQueue => ({
  id: row.id,
  name: row.name,
  ringGroupId: row.ringGroupId,
  maxWaitSeconds: row.maxWaitSeconds,
  announcePosition: row.announcePosition,
  holdMusicUrl: row.holdMusicUrl,
  overflowTo: row.overflowTo as Destination,
});

async function viewOf(tx: Database, row: Row): Promise<QueueView> {
  const [group] = await tx.select({ name: schema.ringGroup.name }).from(schema.ringGroup)
    .where(eq(schema.ringGroup.id, row.ringGroupId)).limit(1);
  return { ...queueOf(row), ringGroupName: group?.name ?? null };
}

/** One line, as a call reaches it mid way. Null when it has been deleted. */
export async function loadQueue(tx: Database, organizationId: string, id: string): Promise<voice.CallQueue | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await tx.select().from(schema.callQueue)
    .where(and(eq(schema.callQueue.organizationId, organizationId), eq(schema.callQueue.id, id))).limit(1);
  return row ? queueOf(row) : null;
}

export async function listQueues(ctx: ServiceContext): Promise<QueueView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.callQueue)
      .where(eq(schema.callQueue.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.callQueue.name));
    return Promise.all(rows.map((row) => viewOf(tx, row)));
  });
}

export interface QueueInput {
  name: string;
  ringGroupId: string;
  maxWaitSeconds?: number | undefined;
  announcePosition?: boolean | undefined;
  holdMusicUrl?: string | null | undefined;
  overflowTo: Destination;
}

/** The voicemail box is one box today, whatever a caller sent. */
const normal = (to: Destination): Destination => to.kind === "voicemail" ? { kind: "voicemail", box: "main" } : to;

/**
 * Save a waiting line, new or changed. The id is chosen before the check, so
 * a line overflowing into itself is caught by name.
 */
export async function saveQueue(ctx: ServiceContext, input: QueueInput & { id?: string | undefined }): Promise<QueueView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const creating = !input.id;
    if (creating) {
      const again = await replayed<{ id: string }>(tx, ctx, "call_queue");
      if (again) {
        const [row] = await tx.select().from(schema.callQueue).where(eq(schema.callQueue.id, again.id)).limit(1);
        if (row) return viewOf(tx, row);
      }
    }
    const id = input.id ?? randomUUID();
    const [before] = creating ? [] : await tx.select().from(schema.callQueue)
      .where(and(eq(schema.callQueue.organizationId, ctx.actor.organizationId), eq(schema.callQueue.id, id))).limit(1);
    if (!creating && !before) throw new NotFoundError("Waiting line");

    const queue: voice.CallQueue = {
      id,
      name: input.name.trim(),
      ringGroupId: input.ringGroupId,
      maxWaitSeconds: input.maxWaitSeconds ?? 300,
      announcePosition: input.announcePosition ?? true,
      holdMusicUrl: input.holdMusicUrl?.trim() || null,
      overflowTo: normal(input.overflowTo),
    };
    const directory = await directoryFor(tx, ctx.actor.organizationId);
    (directory.queues as Map<string, string>).set(id, queue.name || "this");
    const verdict = voice.checkQueue(queue, directory);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const values = {
      name: queue.name, ringGroupId: queue.ringGroupId, maxWaitSeconds: queue.maxWaitSeconds,
      announcePosition: queue.announcePosition, holdMusicUrl: queue.holdMusicUrl, overflowTo: queue.overflowTo as never,
    };
    const [row] = creating
      ? await tx.insert(schema.callQueue).values({ id, organizationId: ctx.actor.organizationId, ...values }).returning()
      : await tx.update(schema.callQueue).set({ ...values, updatedAt: new Date() }).where(eq(schema.callQueue.id, id)).returning();
    await audit(tx, ctx, creating ? "call_queue.created" : "call_queue.changed", "call_queue", id, before ?? null, row!);
    if (creating) await remember(tx, ctx, "call_queue", id, { id });
    return viewOf(tx, row!);
  });
}

/**
 * What still sends callers to a waiting line, in words, for a delete that
 * would strand them.
 */
async function usedBy(tx: Database, organizationId: string, id: string): Promise<string[]> {
  const same = (to: Destination | null | undefined) => to?.kind === "queue" && to.id === id;
  const found: string[] = [];
  const menus = await tx.select().from(schema.phoneMenu).where(eq(schema.phoneMenu.organizationId, organizationId));
  for (const menu of menus) {
    const options = menu.options as { to: Destination }[];
    if (options.some((o) => same(o.to)) || same(menu.noInputTo as Destination) || same(menu.afterHoursTo as Destination | null)) {
      found.push(`the ${menu.name} menu`);
    }
  }
  const groups = await tx.select().from(schema.ringGroup).where(eq(schema.ringGroup.organizationId, organizationId));
  for (const group of groups) if (same(group.noAnswerTo as Destination)) found.push(`the ${group.name} ring group`);
  const queues = await tx.select().from(schema.callQueue).where(eq(schema.callQueue.organizationId, organizationId));
  for (const queue of queues) if (queue.id !== id && same(queue.overflowTo as Destination)) found.push(`the ${queue.name} waiting line`);
  return found;
}

export async function deleteQueue(ctx: ServiceContext, id: string) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const queue = await loadQueue(tx, ctx.actor.organizationId, id);
    if (!queue) throw new NotFoundError("Waiting line");
    const users = await usedBy(tx, ctx.actor.organizationId, id);
    if (users.length > 0) {
      throw new ConflictError(`Calls still go to this waiting line from ${users.join(", ")}. Change those first.`);
    }
    /** A caller in the line right now goes on waiting at the carrier and is sent to voicemail at their next turn of music. */
    await tx.update(schema.call).set({ queueId: null, updatedAt: new Date() }).where(and(
      eq(schema.call.queueId, id), sql`${schema.call.queueResult} is null`,
    ));
    await tx.delete(schema.callQueue).where(eq(schema.callQueue.id, id));
    await audit(tx, ctx, "call_queue.deleted", "call_queue", id, queue, null);
    return { id, deleted: true as const };
  });
}

const queueInput = (input: {
  name: string; ringGroupId: string; maxWaitSeconds?: number | undefined; announcePosition?: boolean | undefined;
  holdMusicUrl?: string | null | undefined; overflowTo: Destination;
}): QueueInput => ({
  name: input.name, ringGroupId: input.ringGroupId, overflowTo: input.overflowTo,
  ...(input.maxWaitSeconds !== undefined ? { maxWaitSeconds: input.maxWaitSeconds } : {}),
  ...(input.announcePosition !== undefined ? { announcePosition: input.announcePosition } : {}),
  ...(input.holdMusicUrl !== undefined ? { holdMusicUrl: input.holdMusicUrl } : {}),
});

export const handlers = {
  listCallQueues: async (ctx: ServiceContext) => ({ queues: await listQueues(ctx) }),
  createCallQueue: (ctx: ServiceContext, input: Parameters<typeof queueInput>[0]) => saveQueue(ctx, queueInput(input)),
  updateCallQueue: (ctx: ServiceContext, input: Parameters<typeof queueInput>[0] & { id: string }) =>
    saveQueue(ctx, { ...queueInput(input), id: input.id }),
  deleteCallQueue: (ctx: ServiceContext, input: { id: string }) => deleteQueue(ctx, input.id),
} as const;
