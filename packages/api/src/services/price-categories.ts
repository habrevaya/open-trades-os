import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { remember, replayed } from "./once";

/**
 * THE PRICE BOOK'S SHELVES
 *
 * `price_book_category` has been a column and a trade pack seed since the
 * first migration, with a parent and a sort order, and no screen: a company
 * could not add "Tankless" under "Water heaters", put "Diagnostics" first, or
 * move the twelve items the pack filed under "Misc" somewhere a technician
 * would look for them. The book is read by category on the tablet, so a book
 * nobody can reorganise is one technicians search by guessing.
 *
 * NESTED, THREE DEEP AT MOST. The schema allows any depth and a picker on a
 * phone does not: "Plumbing > Water heaters > Tankless" is a shelf, and a
 * fourth level is a filing system. A move that would make a cycle is refused
 * rather than repaired, because a category that is its own grandparent has
 * no place in a tree and the person moving it has made a mistake they would
 * rather hear about.
 *
 * A CATEGORY IS NOT ON A DOCUMENT. Invoices point at a price book VERSION,
 * and the category is on the item, so moving an item between categories
 * changes nothing anybody was charged. It is an edit in place, audited.
 */

export const MAX_CATEGORY_DEPTH = 3;

export interface CategoryRow {
  id: string;
  name: string;
  code: string | null;
  parentId: string | null;
  sortOrder: number;
  /** 0 for the top level. */
  depth: number;
  /** Items filed directly here that are still sold. */
  items: number;
}

type Raw = typeof schema.priceBookCategory.$inferSelect;

async function live(tx: Database): Promise<Raw[]> {
  return tx.select().from(schema.priceBookCategory)
    .where(isNull(schema.priceBookCategory.deletedAt))
    .orderBy(asc(schema.priceBookCategory.sortOrder), asc(schema.priceBookCategory.name));
}

/**
 * In reading order: each category followed by its children, siblings by
 * their sort order.
 *
 * Flat with a depth on every row, for the reason the equipment register is:
 * a recursive schema cannot be published, and a client indents off `depth`.
 * A category whose parent has gone, or that sits in a cycle somebody made
 * before this guard existed, is shown at the top rather than dropped.
 */
export function inTreeOrder(rows: Raw[], counts: Map<string, number>): CategoryRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string | null, Raw[]>();
  for (const row of rows) {
    const parent = row.parentId && ids.has(row.parentId) && row.parentId !== row.id ? row.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const out: CategoryRow[] = [];
  const placed = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const row of children.get(parent) ?? []) {
      if (placed.has(row.id)) continue;
      placed.add(row.id);
      out.push({
        id: row.id, name: row.name, code: row.code, parentId: row.parentId,
        sortOrder: row.sortOrder, depth, items: counts.get(row.id) ?? 0,
      });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything a cycle kept out of the walk, at the top, with its link intact.
  for (const row of rows) {
    if (placed.has(row.id)) continue;
    placed.add(row.id);
    out.push({
      id: row.id, name: row.name, code: row.code, parentId: row.parentId,
      sortOrder: row.sortOrder, depth: 0, items: counts.get(row.id) ?? 0,
    });
  }
  return out;
}

export async function list(ctx: ServiceContext): Promise<CategoryRow[]> {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const rows = await live(tx);
    const counted = await tx.select({
      categoryId: schema.priceBookItem.categoryId,
      n: sql<number>`count(*)::int`,
    }).from(schema.priceBookItem)
      .where(and(isNull(schema.priceBookItem.deletedAt), eq(schema.priceBookItem.active, true)))
      .groupBy(schema.priceBookItem.categoryId);
    const counts = new Map(counted.filter((c) => c.categoryId).map((c) => [c.categoryId!, Number(c.n)]));
    return inTreeOrder(rows, counts);
  });
}

/** How deep a category sits, and whether `ancestor` is above it. */
function lineage(rows: Raw[], id: string | null): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: string[] = [];
  let at = id;
  while (at && !chain.includes(at)) {
    chain.push(at);
    at = byId.get(at)?.parentId ?? null;
  }
  return chain;
}

/** The deepest a category's own subtree goes below it, 0 for a leaf. */
function heightOf(rows: Raw[], id: string): number {
  const kids = rows.filter((r) => r.parentId === id && r.id !== id);
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => heightOf(rows, k.id)));
}

function checkPlacement(rows: Raw[], id: string | null, parentId: string | null): void {
  if (parentId === null) return;
  const parent = rows.find((r) => r.id === parentId);
  if (!parent) throw new NotFoundError("Parent category");
  const above = lineage(rows, parentId);
  if (id && above.includes(id)) {
    throw new ConflictError("A category cannot go inside itself or inside one of its own sub categories.");
  }
  const depthOfNew = above.length; // the parent's chain length is the new depth, counting from 0
  const below = id ? heightOf(rows, id) : 0;
  if (depthOfNew + below >= MAX_CATEGORY_DEPTH) {
    throw new ConflictError(
      `Categories go ${MAX_CATEGORY_DEPTH} levels deep at most. "Plumbing, Water heaters, Tankless" is a shelf; `
      + "a fourth level is a filing system nobody finds anything in on a phone.",
    );
  }
}

const NAME_TAKEN = (name: string) =>
  `There is already a category called "${name}" there. Two shelves with one name is a book where half the items are on each.`;

export async function create(
  ctx: ServiceContext, input: { name: string; parentId?: string | null | undefined; code?: string | undefined },
): Promise<CategoryRow> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const seen = await replayed<CategoryRow>(tx, ctx, "price_book_category");
    if (seen) return seen;

    const name = input.name.trim().replace(/\s+/g, " ");
    if (name === "") throw new ConflictError("A category needs a name.");
    const rows = await live(tx);
    const parentId = input.parentId ?? null;
    checkPlacement(rows, null, parentId);

    const siblings = rows.filter((r) => (r.parentId ?? null) === parentId);
    const sortOrder = siblings.length === 0 ? 0 : Math.max(...siblings.map((r) => r.sortOrder)) + 1;

    const [row] = await refusingDuplicate("price_book_category_name_idx", NAME_TAKEN(name), () =>
      tx.insert(schema.priceBookCategory).values({
        organizationId: ctx.actor.organizationId,
        name,
        code: input.code?.trim() || null,
        parentId,
        sortOrder,
      }).returning());

    await audit(tx, ctx, "pricebook.category_created", "price_book_category", row!.id, null, row);
    const made: CategoryRow = {
      id: row!.id, name: row!.name, code: row!.code, parentId: row!.parentId,
      sortOrder: row!.sortOrder, depth: lineage(rows, parentId).length, items: 0,
    };
    await remember(tx, ctx, "price_book_category", row!.id, made);
    return made;
  });
}

/**
 * Rename, re-code or move under another parent. `parentId: null` is the top.
 *
 * A move goes to the end of its new siblings, because dropping it into the
 * middle of a list somebody ordered on purpose would reorder their shelves.
 */
export async function update(
  ctx: ServiceContext,
  input: { id: string; name?: string | undefined; code?: string | null | undefined; parentId?: string | null | undefined },
): Promise<{ id: string }> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const rows = await live(tx);
    const before = rows.find((r) => r.id === input.id);
    if (!before) throw new NotFoundError("Category");

    const name = input.name !== undefined ? input.name.trim().replace(/\s+/g, " ") : before.name;
    if (name === "") throw new ConflictError("A category needs a name.");

    const moving = input.parentId !== undefined && (input.parentId ?? null) !== (before.parentId ?? null);
    const parentId = moving ? (input.parentId ?? null) : before.parentId;
    if (moving) checkPlacement(rows, before.id, parentId);

    const siblings = rows.filter((r) => (r.parentId ?? null) === (parentId ?? null) && r.id !== before.id);
    const sortOrder = moving
      ? (siblings.length === 0 ? 0 : Math.max(...siblings.map((r) => r.sortOrder)) + 1)
      : before.sortOrder;

    const [after] = await refusingDuplicate("price_book_category_name_idx", NAME_TAKEN(name), () =>
      tx.update(schema.priceBookCategory).set({
        name,
        ...(input.code !== undefined ? { code: input.code?.trim() || null } : {}),
        parentId,
        sortOrder,
        updatedAt: new Date(),
      }).where(eq(schema.priceBookCategory.id, input.id)).returning());

    await audit(tx, ctx, "pricebook.category_updated", "price_book_category", input.id, before, after);
    return { id: input.id };
  });
}

/**
 * Put a category at a position among its siblings, counting from nought.
 *
 * A position rather than "up one", so a retry lands where the first call did
 * instead of one further: the screen's up and down buttons send the
 * position they want. The siblings are renumbered from nought, which also
 * repairs a seed that gave them all the same sort order.
 */
export async function place(
  ctx: ServiceContext, input: { id: string; position: number },
): Promise<{ id: string; position: number }> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const rows = await live(tx);
    const target = rows.find((r) => r.id === input.id);
    if (!target) throw new NotFoundError("Category");

    const siblings = rows.filter((r) => (r.parentId ?? null) === (target.parentId ?? null) && r.id !== target.id);
    const position = Math.max(0, Math.min(Math.trunc(input.position), siblings.length));
    const ordered = [...siblings.slice(0, position), target, ...siblings.slice(position)];

    for (const [i, row] of ordered.entries()) {
      if (row.sortOrder === i) continue;
      await tx.update(schema.priceBookCategory)
        .set({ sortOrder: i, updatedAt: new Date() })
        .where(eq(schema.priceBookCategory.id, row.id));
    }
    await audit(tx, ctx, "pricebook.category_placed", "price_book_category", input.id,
      { sortOrder: target.sortOrder }, { sortOrder: position });
    return { id: input.id, position };
  });
}

/**
 * Take a category away. Only an empty one.
 *
 * Refused while it holds items or sub categories, and the refusal says how
 * many, because removing a shelf with forty items on it would leave forty
 * items in no category and nobody would know which forty. Soft deleted, so
 * an audit line naming it still resolves.
 */
export async function remove(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const rows = await live(tx);
    const target = rows.find((r) => r.id === input.id);
    if (!target) throw new NotFoundError("Category");

    const kids = rows.filter((r) => r.parentId === target.id).length;
    const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.priceBookItem)
      .where(and(eq(schema.priceBookItem.categoryId, target.id), isNull(schema.priceBookItem.deletedAt)));
    const items = Number(held?.n ?? 0);
    if (kids > 0 || items > 0) {
      const parts = [
        ...(items > 0 ? [`${items} ${items === 1 ? "item" : "items"}`] : []),
        ...(kids > 0 ? [`${kids} sub ${kids === 1 ? "category" : "categories"}`] : []),
      ];
      throw new ConflictError(`"${target.name}" still holds ${parts.join(" and ")}. Move ${items + kids === 1 ? "it" : "them"} first.`);
    }

    await tx.update(schema.priceBookCategory)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.priceBookCategory.id, target.id));
    await audit(tx, ctx, "pricebook.category_removed", "price_book_category", target.id, target, null);
    return { id: target.id, removed: true as const };
  });
}

/**
 * File these items under a category, or under none.
 *
 * In place on the item, because the category is not on any document. Idempotent
 * by nature: filing an item where it already is changes nothing.
 */
export async function fileItems(
  ctx: ServiceContext, input: { itemIds: string[]; categoryId: string | null },
): Promise<{ moved: number }> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    if (input.itemIds.length === 0) throw new ConflictError("Choose at least one item to move.");
    if (input.categoryId) {
      const [category] = await tx.select({ id: schema.priceBookCategory.id }).from(schema.priceBookCategory)
        .where(and(eq(schema.priceBookCategory.id, input.categoryId), isNull(schema.priceBookCategory.deletedAt)));
      if (!category) throw new NotFoundError("Category");
    }
    const before = await tx.select({ id: schema.priceBookItem.id, categoryId: schema.priceBookItem.categoryId })
      .from(schema.priceBookItem)
      .where(and(inArray(schema.priceBookItem.id, input.itemIds), isNull(schema.priceBookItem.deletedAt)));
    if (before.length !== new Set(input.itemIds).size) throw new NotFoundError("Price book item");

    const moving = before.filter((row) => row.categoryId !== input.categoryId);
    if (moving.length > 0) {
      await tx.update(schema.priceBookItem)
        .set({ categoryId: input.categoryId, updatedAt: new Date() })
        .where(inArray(schema.priceBookItem.id, moving.map((row) => row.id)));
      await audit(tx, ctx, "pricebook.items_filed", "price_book_category", input.categoryId ?? ctx.actor.organizationId,
        { items: moving.map((row) => ({ id: row.id, categoryId: row.categoryId })) },
        { categoryId: input.categoryId });
    }
    return { moved: moving.length };
  });
}

/** A category and every one beneath it, for selecting "everything on this shelf". */
export async function withDescendants(tx: Database, categoryId: string): Promise<string[]> {
  const rows = await live(tx);
  const out = [categoryId];
  for (let i = 0; i < out.length; i += 1) {
    for (const row of rows) if (row.parentId === out[i] && !out.includes(row.id)) out.push(row.id);
  }
  return out;
}

export const handlers = {
  listPriceBookCategories: async (ctx: ServiceContext) => ({ categories: await list(ctx) }),
  createPriceBookCategory: (
    ctx: ServiceContext,
    input: { name: string; parentId?: string | null | undefined; code?: string | undefined },
  ) => create(ctx, input),
  updatePriceBookCategory: (
    ctx: ServiceContext,
    input: { id: string; name?: string | undefined; code?: string | null | undefined; parentId?: string | null | undefined },
  ) => update(ctx, input),
  placePriceBookCategory: (ctx: ServiceContext, input: { id: string; position: number }) => place(ctx, input),
  removePriceBookCategory: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
  filePriceBookItems: (ctx: ServiceContext, input: { itemIds: string[]; categoryId: string | null }) =>
    fileItems(ctx, input),
} as const;
