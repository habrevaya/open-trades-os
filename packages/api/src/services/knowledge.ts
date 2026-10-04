import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { z } from "zod";
import {
  audit, guardedRead, guardedWrite, NotFoundError, type ServiceContext,
} from "./context";
import type { createKnowledgeNote, updateKnowledgeNote } from "../contracts/field-sales";

/**
 * THE COMPANY'S HOW-TO NOTES
 *
 * Written in the office, read by the field assistant when a technician asks
 * "how do we do this here". The assistant answers a procedure from these and
 * nothing else, so what a company writes here is what its technicians are
 * told, and what it has not written they are told it has not.
 */

type Row = typeof schema.knowledgeNote.$inferSelect;

function shape(row: Row, names: Map<string, string>) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: row.tags,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedByUserId ? names.get(row.updatedByUserId) ?? null : null,
  };
}

async function people(tx: Database): Promise<Map<string, string>> {
  const rows = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  return new Map(rows.map((r) => [r.user_id, r.name ?? r.email]));
}

/** Tags as somebody would type them, once each, without the empty ones. */
const tidy = (tags: readonly string[]): string[] =>
  [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))].slice(0, 20);

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const rows = await tx.select().from(schema.knowledgeNote)
      .where(isNull(schema.knowledgeNote.deletedAt))
      .orderBy(desc(schema.knowledgeNote.updatedAt));
    const names = await people(tx);
    return { notes: rows.map((row) => shape(row, names)) };
  });
}

/** The notes in use, for the assistant to choose from. */
export async function inUseWithin(tx: Database): Promise<Row[]> {
  return tx.select().from(schema.knowledgeNote)
    .where(isNull(schema.knowledgeNote.deletedAt))
    .orderBy(desc(schema.knowledgeNote.updatedAt))
    .limit(500);
}

export async function create(ctx: ServiceContext, input: z.infer<typeof createKnowledgeNote.input>) {
  return guardedWrite(ctx, "knowledge:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId }).from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "knowledge_note"),
        )).limit(1);
      if (seen?.entityId) {
        const [row] = await tx.select().from(schema.knowledgeNote).where(eq(schema.knowledgeNote.id, seen.entityId)).limit(1);
        if (row) return shape(row, await people(tx));
      }
    }
    const [row] = await tx.insert(schema.knowledgeNote).values({
      organizationId: ctx.actor.organizationId,
      title: input.title.trim(),
      body: input.body.trim(),
      tags: tidy(input.tags),
      createdByUserId: ctx.actor.userId,
      updatedByUserId: ctx.actor.userId,
    }).returning();
    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "knowledge_note.create",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "knowledge_note", entityId: row!.id,
      });
    }
    await audit(tx, ctx, "knowledge_note.created", "knowledge_note", row!.id, null, { title: row!.title });
    return shape(row!, await people(tx));
  });
}

export async function update(ctx: ServiceContext, input: z.infer<typeof updateKnowledgeNote.input>) {
  return guardedWrite(ctx, "knowledge:write", async (tx) => {
    const [before] = await tx.select().from(schema.knowledgeNote)
      .where(and(eq(schema.knowledgeNote.id, input.id), isNull(schema.knowledgeNote.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Note");
    const [after] = await tx.update(schema.knowledgeNote).set({
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body.trim() } : {}),
      ...(input.tags !== undefined ? { tags: tidy(input.tags) } : {}),
      updatedByUserId: ctx.actor.userId,
      updatedAt: new Date(),
    }).where(eq(schema.knowledgeNote.id, before.id)).returning();
    await audit(tx, ctx, "knowledge_note.updated", "knowledge_note", before.id,
      { title: before.title, body: before.body, tags: before.tags },
      { title: after!.title, body: after!.body, tags: after!.tags });
    return shape(after!, await people(tx));
  });
}

/** Out of use, and kept: an answer given from it last week can still be traced to what it said. */
export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "knowledge:write", async (tx) => {
    const [row] = await tx.update(schema.knowledgeNote)
      .set({ deletedAt: new Date(), updatedByUserId: ctx.actor.userId, updatedAt: new Date() })
      .where(and(eq(schema.knowledgeNote.id, input.id), isNull(schema.knowledgeNote.deletedAt)))
      .returning({ id: schema.knowledgeNote.id });
    if (!row) {
      const [gone] = await tx.select({ id: schema.knowledgeNote.id }).from(schema.knowledgeNote)
        .where(eq(schema.knowledgeNote.id, input.id)).limit(1);
      if (!gone) throw new NotFoundError("Note");
      return { id: input.id, removed: false };
    }
    await audit(tx, ctx, "knowledge_note.removed", "knowledge_note", row.id, null, null);
    return { id: row.id, removed: true };
  });
}

export const handlers = {
  listKnowledgeNotes: (ctx: ServiceContext) => list(ctx),
  createKnowledgeNote: (ctx: ServiceContext, input: z.infer<typeof createKnowledgeNote.input>) => create(ctx, input),
  updateKnowledgeNote: (ctx: ServiceContext, input: z.infer<typeof updateKnowledgeNote.input>) => update(ctx, input),
  removeKnowledgeNote: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
} as const;
