import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { remember, replayed } from "./once";

/**
 * MAKERS, AND THE DAYS EACH GIVES TO REGISTER A UNIT (M32)
 *
 * The days to register a unit used to be one number typed on each price book
 * item, so a company that sells Carrier's furnace, coil and condenser typed the
 * same number three times and fixed it three times the day Carrier changed it.
 * A maker is written down once with its days, and an item names the maker it
 * comes from (`price_book_item.warranty_maker_id`, set with `PATCH
 * /v1/pricebook/items/{id}`). An item that names none still uses its own days,
 * and a maker with no days of its own leaves the item's days as the only word.
 *
 * A CHANGE IS FOR INSTALLS FROM THEN ON. The deadline an install raised says its
 * last day in a sentence the office has already read, so changing a maker's days
 * moves no deadline that is already open; the next unit installed counts from the
 * new days. Said on the screen, because the alternative (quietly moving a day
 * somebody has put in their calendar) is worse than a stale one.
 *
 * `pricebook:read` to list and `pricebook:write` to change, because the days are
 * a term of what the company sells, the same permission the item's own days take.
 */

export interface MakerRow {
  id: string;
  name: string;
  registrationDays: number | null;
  notes: string | null;
  /** Items still sold that name this maker. */
  items: number;
}

const NAME_TAKEN = (name: string) => `There is already a maker called "${name}".`;
const DAYS_WORDS = "Days to register are a whole number from 1 to 365, or empty when the maker has not given any.";

function checkedDays(days: number | null | undefined): number | null {
  if (days === undefined || days === null) return null;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new ConflictError(DAYS_WORDS);
  return days;
}

function checkedName(name: string): string {
  const clean = name.trim();
  if (clean === "") throw new ConflictError("A maker needs a name.");
  if (clean.length > 120) throw new ConflictError("A maker's name is 120 letters at most.");
  return clean;
}

const cleanNotes = (notes: string | null | undefined): string | null => {
  const clean = notes?.trim();
  return clean ? clean.slice(0, 1000) : null;
};

async function itemCounts(tx: Database): Promise<Map<string, number>> {
  const rows = await tx.select({ makerId: schema.priceBookItem.warrantyMakerId, n: sql<number>`count(*)::int` })
    .from(schema.priceBookItem)
    .where(and(isNull(schema.priceBookItem.deletedAt), eq(schema.priceBookItem.active, true)))
    .groupBy(schema.priceBookItem.warrantyMakerId);
  return new Map(rows.filter((r) => r.makerId !== null).map((r) => [r.makerId!, r.n]));
}

const rowOf = (maker: typeof schema.warrantyMaker.$inferSelect, items: number): MakerRow => ({
  id: maker.id, name: maker.name, registrationDays: maker.registrationDays, notes: maker.notes, items,
});

export async function list(ctx: ServiceContext): Promise<{ makers: MakerRow[] }> {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const makers = await tx.select().from(schema.warrantyMaker)
      .where(isNull(schema.warrantyMaker.deletedAt))
      .orderBy(asc(sql`lower(${schema.warrantyMaker.name})`));
    const counts = await itemCounts(tx);
    return { makers: makers.map((m) => rowOf(m, counts.get(m.id) ?? 0)) };
  });
}

export async function create(
  ctx: ServiceContext, input: { name: string; registrationDays?: number | null | undefined; notes?: string | null | undefined },
): Promise<MakerRow> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const again = await replayed<MakerRow>(tx, ctx, "warranty_maker");
    if (again) return again;
    const name = checkedName(input.name);
    const days = checkedDays(input.registrationDays);
    const [made] = await refusingDuplicate("warranty_maker_name_idx", NAME_TAKEN(name), () =>
      tx.insert(schema.warrantyMaker).values({
        organizationId: ctx.actor.organizationId, name, registrationDays: days, notes: cleanNotes(input.notes),
      }).returning());
    await audit(tx, ctx, "warranty_maker.created", "warranty_maker", made!.id, null,
      { name: made!.name, registrationDays: made!.registrationDays });
    const answer = rowOf(made!, 0);
    await remember(tx, ctx, "warranty_maker", made!.id, answer);
    return answer;
  });
}

export async function update(
  ctx: ServiceContext,
  input: { id: string; name?: string | undefined; registrationDays?: number | null | undefined; notes?: string | null | undefined },
): Promise<MakerRow> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const [before] = await tx.select().from(schema.warrantyMaker)
      .where(and(eq(schema.warrantyMaker.id, input.id), isNull(schema.warrantyMaker.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Maker");

    const name = input.name !== undefined ? checkedName(input.name) : before.name;
    const days = input.registrationDays !== undefined ? checkedDays(input.registrationDays) : before.registrationDays;
    const [after] = await refusingDuplicate("warranty_maker_name_idx", NAME_TAKEN(name), () =>
      tx.update(schema.warrantyMaker).set({
        name, registrationDays: days,
        notes: input.notes !== undefined ? cleanNotes(input.notes) : before.notes,
        updatedAt: new Date(),
      }).where(eq(schema.warrantyMaker.id, input.id)).returning());
    await audit(tx, ctx, "warranty_maker.updated", "warranty_maker", input.id,
      { name: before.name, registrationDays: before.registrationDays, notes: before.notes },
      { name: after!.name, registrationDays: after!.registrationDays, notes: after!.notes });
    return rowOf(after!, (await itemCounts(tx)).get(input.id) ?? 0);
  });
}

/**
 * Take a maker off the list. Refused while an item still names it: the item
 * would silently go back to its own days, and a deadline that stops being raised
 * is the failure nobody sees. Move the items first.
 */
export async function retire(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; retired: true }> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const [before] = await tx.select().from(schema.warrantyMaker)
      .where(and(eq(schema.warrantyMaker.id, input.id), isNull(schema.warrantyMaker.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Maker");
    const used = (await itemCounts(tx)).get(input.id) ?? 0;
    if (used > 0) {
      throw new ConflictError(
        `${used === 1 ? "One item still comes" : `${used} items still come`} from ${before.name}. `
        + "Move them to another maker, or take the maker off them, first.",
      );
    }
    await tx.update(schema.warrantyMaker).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.warrantyMaker.id, input.id));
    await audit(tx, ctx, "warranty_maker.retired", "warranty_maker", input.id,
      { name: before.name, registrationDays: before.registrationDays }, null);
    return { id: input.id, retired: true as const };
  });
}

export const handlers = {
  listWarrantyMakers: (ctx: ServiceContext) => list(ctx),
  createWarrantyMaker: (
    ctx: ServiceContext, input: { name: string; registrationDays?: number | null | undefined; notes?: string | null | undefined },
  ) => create(ctx, input),
  updateWarrantyMaker: (
    ctx: ServiceContext,
    input: { id: string; name?: string | undefined; registrationDays?: number | null | undefined; notes?: string | null | undefined },
  ) => update(ctx, input),
  retireWarrantyMaker: (ctx: ServiceContext, input: { id: string }) => retire(ctx, input),
} as const;
