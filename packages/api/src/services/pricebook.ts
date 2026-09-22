import { and, eq, desc, lt, or, ilike, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError,
} from "./context";
import { audit } from "./customers";
import type {
  listPriceBook, createPriceBookItem, revisePriceBookItem,
} from "../contracts/pricebook";

/**
 * THE PRICE BOOK
 *
 * Two tables and one rule: an item is a stable identity, a version holds
 * everything that can change, and EDITING CREATES A NEW VERSION.
 *
 * Documents reference the version, never the item. So raising the price of a
 * capacitor replacement from 218 to 240 leaves every invoice that already went
 * out saying 218, because each of them points at the row that said 218. The
 * alternative, mutating the item in place, quietly rewrites what a customer
 * was charged three years ago, and it is discovered during a dispute or an
 * audit, which is the worst possible moment.
 *
 * It costs a join on every read. That is the cheapest thing in this file.
 */

type ListInput = z.infer<typeof listPriceBook.input>;

/** The current version of an item is the one with no end date. */
const CURRENT = isNull(schema.priceBookItemVersion.effectiveTo);

/**
 * Margin is derived rather than stored, because a stored one goes stale the
 * moment either side of it changes and nobody notices.
 *
 * Returned as a rate string, and only to a caller who may see cost at all:
 * the redaction map removes `cost`, and a margin left behind would let anyone
 * recover the cost from the price in one division.
 */
function marginOf(price: string, cost: string | null): string | null {
  if (cost === null) return null;
  const p = Number(price);
  const c = Number(cost);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p === 0) return null;
  return ((p - c) / p).toFixed(4);
}

interface ItemRow {
  item: typeof schema.priceBookItem.$inferSelect;
  version: typeof schema.priceBookItemVersion.$inferSelect;
}

function shape(ctx: ServiceContext, row: ItemRow) {
  /**
   * Redaction runs on the VERSION, which is where cost lives, and the result
   * is then merged into the item's identity. Running it on the merged object
   * would ask the access map about an entity that does not exist, and it would
   * silently return everything.
   */
  const version = clean(ctx, "priceBookItemVersion", row.version) as Record<string, unknown>;
  const cost = (version["cost"] ?? null) as string | null;

  return {
    id: row.item.id,
    versionId: row.version.id,
    version: row.version.version,
    kind: row.item.kind,
    code: row.item.code,
    name: version["name"],
    description: version["description"] ?? null,
    imageUrl: version["imageUrl"] ?? null,
    categoryId: row.item.categoryId,
    price: version["price"],
    taxable: version["taxable"],
    taxClass: version["taxClass"] ?? null,
    laborMinutes: version["laborMinutes"] ?? null,
    warrantyMonths: version["warrantyMonths"] ?? null,
    active: row.item.active,
    // Absent entirely, rather than null, when the caller may not see it. A
    // null reads as "this item has no cost recorded", which is a different
    // fact from "you are not allowed to know".
    ...("cost" in version ? { cost, margin: marginOf(String(version["price"]), cost) } : {}),
    ...("commissionRate" in version ? { commissionRate: version["commissionRate"] } : {}),
    createdAt: row.item.createdAt,
    updatedAt: row.version.updatedAt,
  };
}

export async function list(ctx: ServiceContext, input: ListInput) {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);

    const where = and(
      isNull(schema.priceBookItem.deletedAt),
      CURRENT,
      // Inactive items are hidden by default. A discontinued part still has to
      // exist, because invoices reference it, and it must not be offered to
      // somebody building a quote today.
      input.includeInactive ? undefined : eq(schema.priceBookItem.active, true),
      input.kind ? eq(schema.priceBookItem.kind, input.kind) : undefined,
      input.categoryId ? eq(schema.priceBookItem.categoryId, input.categoryId) : undefined,
      // A technician in a truck searches by what the part is called, and the
      // office searches by code. Both have to work from one box.
      input.q
        ? or(
            ilike(schema.priceBookItemVersion.name, `%${input.q}%`),
            ilike(schema.priceBookItem.code, `%${input.q}%`),
            ilike(schema.priceBookItemVersion.description, `%${input.q}%`),
          )
        : undefined,
      cursor ? lt(schema.priceBookItem.createdAt, new Date(cursor)) : undefined,
    );

    const rows = await tx.select({
      item: schema.priceBookItem,
      version: schema.priceBookItemVersion,
    })
      .from(schema.priceBookItem)
      .innerJoin(schema.priceBookItemVersion, and(
        eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id),
        CURRENT,
      ))
      .where(where)
      .orderBy(desc(schema.priceBookItem.createdAt))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.item.createdAt.toISOString());
    return { ...page, data: page.data.map((row) => shape(ctx, row)) };
  });
}

export async function create(ctx: ServiceContext, input: z.infer<typeof createPriceBookItem.input>) {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "price_book_item"),
        )).limit(1);
      if (seen?.entityId) {
        const existing = await load(tx, seen.entityId);
        if (existing) return shape(ctx, existing);
      }
    }

    /**
     * The code is the handle a human uses and an import matches on, so a
     * duplicate is rejected rather than allowed to shadow the original. The
     * check is inside the write transaction, so two simultaneous creates
     * cannot both pass it.
     */
    const [clash] = await tx.select({ id: schema.priceBookItem.id })
      .from(schema.priceBookItem)
      .where(and(
        eq(schema.priceBookItem.code, input.code),
        isNull(schema.priceBookItem.deletedAt),
      )).limit(1);
    if (clash) {
      throw new ConflictError(`A price book item with code "${input.code}" already exists.`);
    }

    const [item] = await tx.insert(schema.priceBookItem).values({
      organizationId: ctx.actor.organizationId,
      categoryId: input.categoryId ?? null,
      kind: input.kind,
      code: input.code,
    }).returning();

    const [version] = await tx.insert(schema.priceBookItemVersion).values({
      organizationId: ctx.actor.organizationId,
      itemId: item!.id,
      version: 1,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      cost: input.cost ?? null,
      taxable: input.taxable,
      taxClass: input.taxClass ?? null,
      laborMinutes: input.laborMinutes ?? null,
      warrantyMonths: input.warrantyMonths ?? null,
      effectiveFrom: new Date(),
    }).returning();

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "pricebook.create",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "price_book_item", entityId: item!.id,
      });
    }

    await audit(tx, ctx, "pricebook.item_created", "price_book_item", item!.id, null, {
      code: item!.code, price: version!.price,
    });
    return shape(ctx, { item: item!, version: version! });
  });
}

export async function revise(ctx: ServiceContext, input: z.infer<typeof revisePriceBookItem.input>) {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const current = await load(tx, input.id);
    if (!current) throw new NotFoundError("Price book item");

    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "price_book_item_version"),
        )).limit(1);
      if (seen?.entityId) {
        const again = await load(tx, input.id);
        if (again) return shape(ctx, again);
      }
    }

    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();

    /**
     * The old version is closed at exactly the moment the new one opens, so
     * there is never a gap and never an overlap. A gap means a document priced
     * in that window finds no version at all; an overlap means two rows both
     * claim to be current and which one answers depends on row order.
     */
    await tx.update(schema.priceBookItemVersion)
      .set({ effectiveTo: effectiveFrom, updatedAt: new Date() })
      .where(eq(schema.priceBookItemVersion.id, current.version.id));

    const [version] = await tx.insert(schema.priceBookItemVersion).values({
      organizationId: ctx.actor.organizationId,
      itemId: current.item.id,
      version: current.version.version + 1,
      // Every field carries forward unless this call changes it. A revision
      // that only raises the price must not blank the description.
      name: input.name ?? current.version.name,
      description: input.description ?? current.version.description,
      imageUrl: current.version.imageUrl,
      price: input.price ?? current.version.price,
      cost: input.cost ?? current.version.cost,
      laborMinutes: input.laborMinutes ?? current.version.laborMinutes,
      taxable: input.taxable ?? current.version.taxable,
      taxClass: current.version.taxClass,
      commissionRate: current.version.commissionRate,
      warrantyMonths: current.version.warrantyMonths,
      components: current.version.components,
      effectiveFrom,
    }).returning();

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "pricebook.revise",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "price_book_item_version", entityId: version!.id,
      });
    }

    await audit(
      tx, ctx, "pricebook.item_revised", "price_book_item", current.item.id,
      { version: current.version.version, price: current.version.price },
      { version: version!.version, price: version!.price },
    );
    return shape(ctx, { item: current.item, version: version! });
  });
}

/** An item with its current version, or nothing. */
async function load(tx: Database, itemId: string): Promise<ItemRow | undefined> {
  const [row] = await tx.select({
    item: schema.priceBookItem,
    version: schema.priceBookItemVersion,
  })
    .from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, and(
      eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id),
      CURRENT,
    ))
    .where(and(
      eq(schema.priceBookItem.id, itemId),
      isNull(schema.priceBookItem.deletedAt),
    ))
    .limit(1);
  return row;
}

/** Exported for the tests that check version windows never gap or overlap. */
export const currentVersionFilter = CURRENT;
