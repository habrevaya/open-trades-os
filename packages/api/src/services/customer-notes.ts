import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerNotes as rules } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, decodeCursor, encodeCursor,
  ConflictError, NotFoundError, type ExternalRef, type ServiceContext,
} from "./context";
import { customerScopeFilter } from "./scope";
import { admitInstant } from "./history";
import { remember, replayed } from "./once";

/**
 * NOTES ON A CUSTOMER (M03)
 *
 * Dated, signed, and added to rather than rewritten. The rules about who may
 * change a note and for how long are in `core/customer-notes`; this file
 * applies them to a request and keeps the three things a note can be asked to
 * do (be read, be added, be pinned) inside the customer's own scope.
 *
 * READ THROUGH THE CUSTOMER. Every route names a customer, or a note whose
 * customer is looked up, and the customer is found under the caller's scope
 * first, so a technician, a crew lead or a branch manager is told a customer
 * they may not see does not exist, as the customer list tells them.
 *
 * A TECHNICIAN READS ONLY WHAT WAS MARKED FOR THE FIELD. A note says what
 * somebody in the office learned, and most of that ("pays late", "asked
 * about financing") is not the technician's to read at the door. At the two
 * field scopes (`own`, `crew`) the list holds only the notes the office
 * marked for the field, which are also the ones on the visit. A branch
 * manager is office, and reads every note of a customer in their branch.
 */

export type NoteView = {
  id: string;
  customerId: string;
  body: string;
  notedAt: string;
  author: { userId: string; name: string | null } | null;
  origin: string;
  pinned: boolean;
  pinnedAt: string | null;
  forField: boolean;
  correctsNoteId: string | null;
  editedAt: string | null;
  /** Until when the person asking may still change it, or null when they may not. */
  editableUntil: string | null;
  externalRef: ExternalRef | null;
};

/** The two field scopes, at which only the notes marked for the field are read. */
const FIELD_SCOPES = new Set(["own", "crew"]);

async function visibleCustomer(tx: Database, ctx: ServiceContext, customerId: string): Promise<void> {
  const [row] = await tx.select({ id: schema.customer.id }).from(schema.customer)
    .where(and(
      eq(schema.customer.id, customerId),
      eq(schema.customer.organizationId, ctx.actor.organizationId),
      isNull(schema.customer.deletedAt),
      customerScopeFilter(scopeOf(ctx, "customer"), ctx.actor),
    )).limit(1);
  if (!row) throw new NotFoundError("Customer");
}

type NoteRow = typeof schema.customerNote.$inferSelect;

/**
 * The names of the people who wrote these, read through the function the
 * team screen uses: an account is outside the tenant, and a person who has
 * left the company keeps their notes and loses their name here.
 */
async function namesOf(tx: Database, userIds: (string | null)[]): Promise<Map<string, string | null>> {
  const wanted = new Set(userIds.filter((id): id is string => id !== null));
  if (wanted.size === 0) return new Map();
  const people = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  return new Map([...people].filter((p) => wanted.has(p.user_id)).map((p) => [p.user_id, p.name ?? p.email]));
}

async function shapeAll(tx: Database, ctx: ServiceContext, rows: NoteRow[], now: Date): Promise<NoteView[]> {
  const names = await namesOf(tx, rows.map((r) => r.authorUserId));
  return rows.map((note) => shape(ctx, note, names.get(note.authorUserId ?? "") ?? null, now));
}

function shape(ctx: ServiceContext, note: NoteRow, authorName: string | null, now: Date): NoteView {
  const verdict = rules.mayEdit(note, ctx.actor.userId, now);
  return {
    id: note.id,
    customerId: note.customerId,
    body: note.body,
    notedAt: note.notedAt.toISOString(),
    author: note.authorUserId ? { userId: note.authorUserId, name: authorName } : null,
    origin: note.origin,
    pinned: note.pinnedAt !== null,
    pinnedAt: note.pinnedAt?.toISOString() ?? null,
    forField: note.forField,
    correctsNoteId: note.correctsNoteId,
    editedAt: note.editedAt?.toISOString() ?? null,
    editableUntil: verdict.ok ? rules.editableUntil(note)!.toISOString() : null,
    externalRef: note.sourceSystem && note.sourceId ? { source: note.sourceSystem, id: note.sourceId } : null,
  };
}

async function readOne(tx: Database, ctx: ServiceContext, id: string, now: Date): Promise<NoteView> {
  const [row] = await tx.select().from(schema.customerNote)
    .where(eq(schema.customerNote.id, id)).limit(1);
  if (!row) throw new NotFoundError("Note");
  return (await shapeAll(tx, ctx, [row], now))[0]!;
}

/**
 * A customer's notes: every pinned one first, then the rest newest first, a
 * page at a time.
 *
 * Pinned notes come back whole on every page rather than paged with the
 * rest, because there are a handful of them and they are the point of
 * pinning; the page of the others is keyed on the day and the id, so a note
 * added while somebody reads does not shift the next page.
 */
export async function list(
  ctx: ServiceContext,
  input: { id: string; limit?: number | undefined; cursor?: string | undefined },
) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    await visibleCustomer(tx, ctx, input.id);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const fieldOnly = FIELD_SCOPES.has(scopeOf(ctx, "customer"));
    const mine = and(
      eq(schema.customerNote.customerId, input.id),
      fieldOnly ? eq(schema.customerNote.forField, true) : undefined,
    );
    const now = new Date();

    const pinned = await tx.select().from(schema.customerNote)
      .where(and(mine, isNotNull(schema.customerNote.pinnedAt)))
      .orderBy(desc(schema.customerNote.pinnedAt), desc(schema.customerNote.id));

    const cursor = decodeCursor(input.cursor);
    const [afterAt, afterId] = cursor ? cursor.split("|") : [];
    const rows = await tx.select().from(schema.customerNote)
      .where(and(
        mine,
        isNull(schema.customerNote.pinnedAt),
        afterAt && afterId
          ? sql`(${schema.customerNote.notedAt}, ${schema.customerNote.id}) < (${afterAt}::timestamptz, ${afterId}::uuid)`
          : undefined,
      ))
      .orderBy(desc(schema.customerNote.notedAt), desc(schema.customerNote.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const shaped = await shapeAll(tx, ctx, [...pinned, ...page], now);
    return {
      pinned: shaped.slice(0, pinned.length),
      data: shaped.slice(pinned.length),
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(`${last.notedAt.toISOString()}|${last.id}`) : null,
      /** Said, so a screen can tell a technician why the list is short. */
      fieldOnly,
    };
  });
}

export interface AddInput {
  /** The customer. */
  id: string;
  body: string;
  forField?: boolean | undefined;
  pinned?: boolean | undefined;
  correctsNoteId?: string | undefined;
  /** The day it is about, for a note brought in from another system. Today when absent. */
  notedAt?: string | undefined;
  externalRef?: ExternalRef | undefined;
}

/**
 * Write a note on a customer.
 *
 * A note dated in the past is a statement about when something was said, so
 * it goes through the history rules every back dated record does: a week
 * back for anybody, earlier only with `data:import`, never ahead. One that
 * arrives with an `externalRef` came from another system and is marked
 * `imported`, with no author here, and nobody may change it afterwards.
 */
export async function add(ctx: ServiceContext, input: AddInput): Promise<NoteView> {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const seen = await replayed<NoteView>(tx, ctx, "customer_note_add");
    if (seen) return seen;
    await visibleCustomer(tx, ctx, input.id);

    const verdict = rules.normalizeNote(input.body);
    if (!verdict.ok) throw new ConflictError(verdict.message);

    if (input.correctsNoteId) {
      const [corrected] = await tx.select({ customerId: schema.customerNote.customerId })
        .from(schema.customerNote)
        .where(and(
          eq(schema.customerNote.id, input.correctsNoteId),
          eq(schema.customerNote.organizationId, ctx.actor.organizationId),
        )).limit(1);
      if (!corrected || corrected.customerId !== input.id) {
        throw new ConflictError("The note this corrects is not one of this customer's notes.");
      }
    }

    const notedAt = input.notedAt ? new Date(input.notedAt) : new Date();
    if (input.notedAt) await admitInstant(tx, ctx, notedAt, "notedAt");

    if (input.externalRef) {
      const [claimed] = await tx.select({ id: schema.customerNote.id }).from(schema.customerNote)
        .where(and(
          eq(schema.customerNote.organizationId, ctx.actor.organizationId),
          eq(schema.customerNote.sourceSystem, input.externalRef.source),
          eq(schema.customerNote.sourceId, input.externalRef.id),
        )).limit(1);
      if (claimed) {
        throw new ConflictError(
          `${input.externalRef.source} customer note ${input.externalRef.id} is already here, as ${claimed.id}.`,
        );
      }
    }

    const imported = input.externalRef !== undefined;
    const [row] = await tx.insert(schema.customerNote).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.id,
      body: verdict.body,
      notedAt,
      authorUserId: imported ? null : ctx.actor.userId,
      origin: imported ? "imported" : "typed",
      forField: input.forField ?? false,
      correctsNoteId: input.correctsNoteId ?? null,
      ...(input.pinned ? { pinnedAt: new Date(), pinnedByUserId: ctx.actor.userId } : {}),
      sourceSystem: input.externalRef?.source ?? null,
      sourceId: input.externalRef?.id ?? null,
    }).returning();

    await audit(tx, ctx, "customer_note.added", "customer_note", row!.id, null, row!);
    const view = await readOne(tx, ctx, row!.id, new Date());
    await remember(tx, ctx, "customer_note_add", row!.id, view);
    return view;
  });
}

async function loadNote(tx: Database, ctx: ServiceContext, id: string) {
  const [note] = await tx.select().from(schema.customerNote)
    .where(and(
      eq(schema.customerNote.id, id),
      eq(schema.customerNote.organizationId, ctx.actor.organizationId),
    )).limit(1);
  if (!note) throw new NotFoundError("Note");
  await visibleCustomer(tx, ctx, note.customerId);
  /**
   * A technician who may not read a note may not touch it either, and is
   * told it is not there, as the list tells them.
   */
  if (FIELD_SCOPES.has(scopeOf(ctx, "customer")) && !note.forField) throw new NotFoundError("Note");
  return note;
}

/**
 * Its author fixing a note while it is fresh. The words, and whether it is
 * for the field; nothing else. After the window, or for anybody else, a
 * correction is a new note, and the refusal says so.
 */
export async function edit(
  ctx: ServiceContext,
  input: { id: string; body?: string | undefined; forField?: boolean | undefined },
): Promise<NoteView> {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const before = await loadNote(tx, ctx, input.id);
    const now = new Date();
    const allowed = rules.mayEdit(before, ctx.actor.userId, now);
    if (!allowed.ok) throw new ConflictError(allowed.message);

    let body = before.body;
    if (input.body !== undefined) {
      const verdict = rules.normalizeNote(input.body);
      if (!verdict.ok) throw new ConflictError(verdict.message);
      body = verdict.body;
    }
    const [after] = await tx.update(schema.customerNote).set({
      body,
      ...(input.forField !== undefined ? { forField: input.forField } : {}),
      editedAt: now,
      updatedAt: now,
    }).where(eq(schema.customerNote.id, input.id)).returning();

    await audit(tx, ctx, "customer_note.edited", "customer_note", input.id, before, after!);
    return readOne(tx, ctx, input.id, now);
  });
}

/**
 * Keep a note at the top, or stop keeping it there. Anybody who may write
 * notes may pin one, whoever wrote it, because pinning changes where it sits
 * and not what it says. Sending the same answer twice changes nothing.
 */
export async function pin(ctx: ServiceContext, input: { id: string; pinned: boolean }): Promise<NoteView> {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const before = await loadNote(tx, ctx, input.id);
    const now = new Date();
    if ((before.pinnedAt !== null) !== input.pinned) {
      const [after] = await tx.update(schema.customerNote).set({
        pinnedAt: input.pinned ? now : null,
        pinnedByUserId: input.pinned ? ctx.actor.userId : null,
        updatedAt: now,
      }).where(eq(schema.customerNote.id, input.id)).returning();
      await audit(tx, ctx, input.pinned ? "customer_note.pinned" : "customer_note.unpinned",
        "customer_note", input.id, before, after!);
    }
    return readOne(tx, ctx, input.id, now);
  });
}

/** How many notes marked for the field ride along with each visit, newest first after the pinned. */
export const FIELD_NOTES_PER_CUSTOMER = 20;

export interface FieldNote {
  id: string;
  body: string;
  notedAt: string;
  pinned: boolean;
  by: string | null;
}

/**
 * The notes marked for the field, for the customers on a technician's day,
 * inside the transaction that is already building it.
 *
 * Read by customer id rather than through the scope filter, because the
 * caller has already been given these visits and their customers; what is
 * being decided here is which of the office's notes the technician sees,
 * and that is only the ones the office marked for them.
 */
export async function forField(tx: Database, customerIds: string[]): Promise<Map<string, FieldNote[]>> {
  const out = new Map<string, FieldNote[]>();
  const ids = [...new Set(customerIds)];
  if (ids.length === 0) return out;
  const rows = await tx.select({
    id: schema.customerNote.id,
    customerId: schema.customerNote.customerId,
    body: schema.customerNote.body,
    notedAt: schema.customerNote.notedAt,
    pinnedAt: schema.customerNote.pinnedAt,
    authorUserId: schema.customerNote.authorUserId,
  }).from(schema.customerNote)
    .where(and(inArray(schema.customerNote.customerId, ids), eq(schema.customerNote.forField, true)))
    .orderBy(sql`${schema.customerNote.pinnedAt} is null`, desc(schema.customerNote.pinnedAt),
      desc(schema.customerNote.notedAt), desc(schema.customerNote.id));
  const names = await namesOf(tx, rows.map((r) => r.authorUserId));
  for (const row of rows) {
    const list = out.get(row.customerId) ?? [];
    if (list.length >= FIELD_NOTES_PER_CUSTOMER) continue;
    list.push({
      id: row.id, body: row.body, notedAt: row.notedAt.toISOString(), pinned: row.pinnedAt !== null,
      by: names.get(row.authorUserId ?? "") ?? null,
    });
    out.set(row.customerId, list);
  }
  return out;
}

/**
 * The old notes box, carried into a first note on each customer whose box
 * holds something, and emptied. The same statement the migration that made
 * notes ran, for a copy restored from before then. Dated when the customer
 * was last changed, the nearest the row holds to when it was written.
 */
export async function carryOldBox(tx: Database): Promise<number> {
  const carried = await tx.execute(sql`
    with boxed as (
      select id, organization_id, btrim(notes) as body, updated_at from public.customer
      where notes is not null and btrim(notes) <> ''
    ), made as (
      insert into public.customer_note (organization_id, customer_id, body, noted_at, origin)
      select organization_id, id, body, updated_at, 'carried' from boxed
      returning customer_id
    )
    update public.customer set notes = null where notes is not null
    returning (select count(*) from made)::int as n`);
  return Number((carried as unknown as { n: number }[])[0]?.n ?? 0);
}

export const handlers = {
  listCustomerNotes: (
    ctx: ServiceContext, input: { id: string; limit?: number | undefined; cursor?: string | undefined },
  ) => list(ctx, input),
  addCustomerNote: (ctx: ServiceContext, input: AddInput) => add(ctx, input),
  editCustomerNote: (
    ctx: ServiceContext, input: { id: string; body?: string | undefined; forField?: boolean | undefined },
  ) => edit(ctx, input),
  pinCustomerNote: (ctx: ServiceContext, input: { id: string; pinned: boolean }) => pin(ctx, input),
} as const;
