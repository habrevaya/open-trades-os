import { and, eq, desc, gt, inArray, lt, lte, or, ilike, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { z } from "zod";
import {
  audit, type ServiceContext, guardedRead, guardedWrite, clean, decodeCursor, paginate, NotFoundError, ConflictError,
} from "./context";
import { assertUnclaimed, byExternal, provenance } from "./provenance";
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
/**
 * THE VERSION IN FORCE AT AN INSTANT, AND WHY THIS IS NOT `effective_to IS NULL`.
 *
 * It was. Four services asked "which price applies" as
 * `isNull(effectiveTo)`, and that is the open ended row rather than the
 * current one. The difference only shows when a revision is dated ahead,
 * which `revise` has always accepted:
 *
 *   `revise` closes the current version AT the new one's `effective_from`
 *   and opens the new one there. Dated next month, the old row gets
 *   `effective_to = next month` and the new row gets `effective_to = null`.
 *
 *   So `isNull(effectiveTo)` picks the FUTURE row. A price increase
 *   scheduled for next month applied today, and the price that was actually
 *   in force became invisible, in the price book list, in the estimate
 *   builder, in invoicing and on the technician's tablet.
 *
 * Nothing caught it because no test ever passed a future date, and the
 * parameter sits on the published contract. A company using it to prepare a
 * quarterly change would have quoted next quarter's prices from the day they
 * entered them.
 *
 * ONE PREDICATE, EXPORTED, used by every reader. Four copies of "which price
 * applies" is four chances to get this wrong again, and they had already
 * taken all four.
 *
 * The boundary is `from <= at` and `to > at`, which is half open and has to
 * be: `revise` sets the old row's `to` to exactly the new row's `from`, so a
 * closed upper bound would make both match at that instant and the answer
 * would depend on row order.
 */
export function inForceAt(at: Date = new Date()) {
  return and(
    lte(schema.priceBookItemVersion.effectiveFrom, at),
    or(
      isNull(schema.priceBookItemVersion.effectiveTo),
      gt(schema.priceBookItemVersion.effectiveTo, at),
    ),
  );
}

/**
 * NOT a module level constant any more.
 *
 * `inForceAt()` defaults to the moment it is CALLED, and a constant would
 * freeze that at the moment the module was imported. In a worker that stays
 * up for a week, every price read would be answered as of last Monday, and a
 * scheduled revision would never arrive. Each query asks for itself.
 */

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

export interface ItemRow {
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
  const version = clean(ctx, "priceBookItemVersion", row.version);
  const visible = version as Record<string, unknown>;
  const cost = (visible["cost"] ?? null) as string | null;

  /**
   * The fields that redaction can never remove are read from the ROW, not
   * from the redacted copy.
   *
   * Reading them back out of a `Record<string, unknown>` was losing every
   * type: `name` and `price` arrived at the caller as `unknown`, so the two
   * most used fields in the price book had to be cast at each consumer, and
   * a page rendering `price` where it meant `cost` would have compiled. Only
   * `cost` and `commissionRate` are conditional, and only those are read
   * through the redacted object.
   */
  return {
    id: row.item.id,
    versionId: row.version.id,
    version: row.version.version,
    kind: row.item.kind,
    code: row.item.code,
    name: row.version.name,
    description: row.version.description ?? null,
    imageUrl: row.version.imageUrl ?? null,
    categoryId: row.item.categoryId,
    price: row.version.price,
    taxable: row.version.taxable,
    taxClass: row.version.taxClass ?? null,
    laborMinutes: row.version.laborMinutes ?? null,
    warrantyMonths: row.version.warrantyMonths ?? null,
    active: row.item.active,
    externalRef: row.item.sourceSystem && row.item.sourceId
      ? { source: row.item.sourceSystem, id: row.item.sourceId }
      : null,
    // Absent entirely, rather than null, when the caller may not see it. A
    // null reads as "this item has no cost recorded", which is a different
    // fact from "you are not allowed to know".
    ...("cost" in visible ? { cost, margin: marginOf(row.version.price, cost) } : {}),
    ...("commissionRate" in visible ? { commissionRate: row.version.commissionRate } : {}),
    createdAt: row.item.createdAt,
    updatedAt: row.version.updatedAt,
  };
}

export async function list(ctx: ServiceContext, input: ListInput) {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);

    const where = and(
      isNull(schema.priceBookItem.deletedAt),
      inForceAt(),
      // Inactive items are hidden by default. A discontinued part still has to
      // exist, because invoices reference it, and it must not be offered to
      // somebody building a quote today.
      input.includeInactive ? undefined : eq(schema.priceBookItem.active, true),
      input.kind ? eq(schema.priceBookItem.kind, input.kind) : undefined,
      input.categoryId ? eq(schema.priceBookItem.categoryId, input.categoryId) : undefined,
      byExternal(schema.priceBookItem, input),
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
        inForceAt(),
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
    await assertUnclaimed(tx, "price_book_item", input.externalRef);

    const [item] = await tx.insert(schema.priceBookItem).values({
      organizationId: ctx.actor.organizationId,
      categoryId: input.categoryId ?? null,
      kind: input.kind,
      code: input.code,
      ...provenance(input.externalRef),
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
    const version = await reviseWithin(tx, ctx, current, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.cost !== undefined ? { cost: input.cost } : {}),
      ...(input.laborMinutes !== undefined ? { laborMinutes: input.laborMinutes } : {}),
      ...(input.taxable !== undefined ? { taxable: input.taxable } : {}),
    }, effectiveFrom);

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "pricebook.revise",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "price_book_item_version", entityId: version.id,
      });
    }

    return shape(ctx, { item: current.item, version });
  });
}

export interface RevisionChanges {
  name?: string;
  description?: string;
  price?: string;
  cost?: string;
  laborMinutes?: number;
  taxable?: boolean;
  /**
   * Null clears it; left out, the current one carries forward. The setup
   * wizard's tax step and a trade pack upgrade are what change these, through
   * here, so a tax class or a warranty is versioned exactly like a price.
   */
  taxClass?: string | null;
  warrantyMonths?: number | null;
}

/**
 * THE ONE WAY A PRICE CHANGES, for a single edit and for a bulk one.
 *
 * Inside a transaction the caller holds, so the bulk change in
 * `repricing.ts` writes each item's new version exactly as `revise` does,
 * with the same window arithmetic and the same audit line, rather than a
 * second copy of "close the old one, open the new one" that would drift.
 */
export async function reviseWithin(
  tx: Database, ctx: ServiceContext, current: ItemRow, changes: RevisionChanges, effectiveFrom: Date,
): Promise<typeof schema.priceBookItemVersion.$inferSelect> {
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
    name: changes.name ?? current.version.name,
    description: changes.description ?? current.version.description,
    imageUrl: current.version.imageUrl,
    price: changes.price ?? current.version.price,
    cost: changes.cost ?? current.version.cost,
    laborMinutes: changes.laborMinutes ?? current.version.laborMinutes,
    taxable: changes.taxable ?? current.version.taxable,
    taxClass: changes.taxClass !== undefined ? changes.taxClass : current.version.taxClass,
    commissionRate: current.version.commissionRate,
    warrantyMonths: changes.warrantyMonths !== undefined ? changes.warrantyMonths : current.version.warrantyMonths,
    components: current.version.components,
    effectiveFrom,
  }).returning();

  await audit(
    tx, ctx, "pricebook.item_revised", "price_book_item", current.item.id,
    { version: current.version.version, price: current.version.price },
    { version: version!.version, price: version!.price },
  );
  return version!;
}

/** An item with its current version, or nothing. */
export async function load(tx: Database, itemId: string): Promise<ItemRow | undefined> {
  const [row] = await tx.select({
    item: schema.priceBookItem,
    version: schema.priceBookItemVersion,
  })
    .from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, and(
      eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id),
      inForceAt(),
    ))
    .where(and(
      eq(schema.priceBookItem.id, itemId),
      isNull(schema.priceBookItem.deletedAt),
    ))
    .limit(1);
  return row;
}

/** Exported for the tests that check version windows never gap or overlap. */
export const currentVersionFilter = inForceAt;

/**
 * RETIRE AN ITEM, OR BRING IT BACK.
 *
 * `price_book_item.active` was filtered on by `list`, published as
 * `includeInactive` on the contract, and had no way to become false. The
 * filter's only possible answer was "everything", so the flag on the screen
 * did nothing and an item sold last season stayed on every technician's
 * tablet forever.
 *
 * RETIRED, NOT DELETED, and that is the whole reason for a flag rather than
 * a soft delete. Every invoice line that ever used this item points at a
 * VERSION of it, and those have to keep resolving: a customer asking what
 * they paid for in 2024 gets an answer, and the margin report for that
 * quarter still has a cost. Deactivating stops it being SOLD; it changes
 * nothing about what was.
 */
export async function setActive(
  ctx: ServiceContext,
  input: { id: string; active: boolean; reason?: string | undefined },
) {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const [before] = await tx.select().from(schema.priceBookItem)
      .where(and(
        eq(schema.priceBookItem.id, input.id),
        eq(schema.priceBookItem.organizationId, ctx.actor.organizationId),
        isNull(schema.priceBookItem.deletedAt),
      )).limit(1);
    if (!before) throw new NotFoundError("Price book item");

    if (before.active === input.active) {
      /**
       * Absorbing rather than an error. Two people retiring the same
       * discontinued part on the same afternoon is ordinary, and the second
       * one has not done anything wrong.
       */
      return { id: before.id, code: before.code, active: input.active };
    }

    const [row] = await tx.update(schema.priceBookItem)
      .set({ active: input.active, updatedAt: new Date() })
      .where(eq(schema.priceBookItem.id, input.id))
      .returning();

    await audit(tx, ctx, input.active ? "pricebook.item_restored" : "pricebook.item_retired",
      "price_book_item", input.id, { active: before.active },
      { active: input.active, reason: input.reason ?? null });

    return { id: row!.id, code: row!.code, active: row!.active };
  });
}

/* ------------------------------------------------- revisions dated ahead */

/**
 * `pricebook:publish` WAS GRANTED TO ROLES AND CHECKED BY NOTHING, and the
 * excuse on the owed list said "M06 has no draft state to publish from".
 *
 * It had one and could not see it. `revise` has always accepted an
 * `effectiveFrom`, and a date in the future produces exactly a staged
 * revision: a version that is not in force yet, sitting behind one that is.
 * What was missing was any way to see them, bring one forward, or call one
 * off, and a bug that made the whole idea unusable, which `inForceAt`
 * documents.
 *
 * THE AUTHORITY SPLIT THIS CREATES, which is the one a company wants:
 * `pricebook:write` drafts next quarter's prices, and `pricebook:publish`
 * decides what the price is TODAY. Both operations below change what is in
 * force now, which is why both take the second permission: bringing a
 * revision forward raises the price early, and calling one off cancels a
 * change somebody may already have quoted against.
 */

export interface ScheduledRevision {
  versionId: string;
  itemId: string;
  code: string;
  name: string;
  version: number;
  /** What it will become. */
  price: string;
  /** What it is until then, from the version currently in force. */
  currentPrice: string | null;
  effectiveFrom: string;
}

/**
 * What is coming, soonest first.
 *
 * `pricebook:read`, because knowing a price change is scheduled is part of
 * reading the price book: a technician quoting work for next month needs to
 * know, and withholding it behind the publish permission would mean the
 * people most affected are the ones who cannot see it.
 */
export async function scheduledRevisions(
  ctx: ServiceContext, now: Date = new Date(),
): Promise<ScheduledRevision[]> {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const rows = await tx.select({
      version: schema.priceBookItemVersion,
      code: schema.priceBookItem.code,
    })
      .from(schema.priceBookItemVersion)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
      .where(and(
        eq(schema.priceBookItemVersion.organizationId, ctx.actor.organizationId),
        gt(schema.priceBookItemVersion.effectiveFrom, now),
        isNull(schema.priceBookItemVersion.deletedAt),
      ))
      .orderBy(schema.priceBookItemVersion.effectiveFrom);

    if (rows.length === 0) return [];

    /**
     * The price in force today, beside the one that is coming, because a
     * scheduled revision on its own does not answer the question anybody
     * opens this screen for: by how much is it going up.
     */
    const live = await tx.select({
      itemId: schema.priceBookItemVersion.itemId,
      price: schema.priceBookItemVersion.price,
    }).from(schema.priceBookItemVersion)
      .where(and(
        eq(schema.priceBookItemVersion.organizationId, ctx.actor.organizationId),
        inArray(schema.priceBookItemVersion.itemId, rows.map((r) => r.version.itemId)),
        inForceAt(now),
      ));
    const priceNow = new Map(live.map((l) => [l.itemId, l.price]));

    return rows.map(({ version, code }) => ({
      versionId: version.id,
      itemId: version.itemId,
      code,
      name: version.name,
      version: version.version,
      price: version.price,
      currentPrice: priceNow.get(version.itemId) ?? null,
      effectiveFrom: version.effectiveFrom.toISOString(),
    }));
  });
}

/**
 * Bring a scheduled revision forward to now.
 *
 * Two writes that have to agree: the predecessor closes at this instant and
 * the revision opens at it. Doing one without the other is the gap or the
 * overlap `revise` is careful about, and here it would be worse, because the
 * rows already exist and the window being moved is in the middle of a chain.
 */
export async function publishRevision(
  ctx: ServiceContext, input: { versionId: string }, now: Date = new Date(),
): Promise<{ versionId: string; effectiveFrom: string }> {
  return guardedWrite(ctx, "pricebook:publish", async (tx) => {
    const [version] = await tx.select().from(schema.priceBookItemVersion)
      .where(and(
        eq(schema.priceBookItemVersion.organizationId, ctx.actor.organizationId),
        eq(schema.priceBookItemVersion.id, input.versionId),
      ));
    if (!version) throw new NotFoundError("Price book version");

    if (version.effectiveFrom <= now) {
      throw new ConflictError(
        "That revision is already in force. There is nothing to publish.",
      );
    }

    /**
     * The predecessor is the row whose window ENDS where this one starts,
     * which is how `revise` left the chain. Found that way rather than by
     * version number, because a second scheduled revision on the same item
     * would make "the previous version number" the wrong row.
     */
    const [previous] = await tx.select().from(schema.priceBookItemVersion)
      .where(and(
        eq(schema.priceBookItemVersion.organizationId, ctx.actor.organizationId),
        eq(schema.priceBookItemVersion.itemId, version.itemId),
        eq(schema.priceBookItemVersion.effectiveTo, version.effectiveFrom),
      ));

    if (previous) {
      await tx.update(schema.priceBookItemVersion)
        .set({ effectiveTo: now, updatedAt: new Date() })
        .where(eq(schema.priceBookItemVersion.id, previous.id));
    }

    await tx.update(schema.priceBookItemVersion)
      .set({ effectiveFrom: now, updatedAt: new Date() })
      .where(eq(schema.priceBookItemVersion.id, version.id));

    await audit(
      tx, ctx, "pricebook.revision_published", "price_book_item", version.itemId,
      { effectiveFrom: version.effectiveFrom.toISOString() },
      { effectiveFrom: now.toISOString(), price: version.price },
    );

    return { versionId: version.id, effectiveFrom: now.toISOString() };
  });
}

/**
 * Call a scheduled revision off, and reopen the version it was going to
 * replace.
 *
 * SOFT DELETED AND NOT REMOVED, because an estimate written this week may
 * already have been priced against it by somebody reading the schedule, and
 * "what was the plan before it was cancelled" is a question that gets asked.
 *
 * REOPENING THE PREDECESSOR IS THE HALF THAT MATTERS. Without it the old
 * version stays closed at a date in the future and, once that date passes,
 * the item has no version in force at all: `inForceAt` matches nothing, the
 * item vanishes from the price book, and an estimate referencing it finds no
 * price. That is the gap the whole versioning model exists to prevent, and
 * cancelling a revision is the one operation that can open one.
 */
export async function discardRevision(
  ctx: ServiceContext, input: { versionId: string }, now: Date = new Date(),
): Promise<{ versionId: string; discarded: boolean }> {
  return guardedWrite(ctx, "pricebook:publish", async (tx) => {
    const [version] = await tx.select().from(schema.priceBookItemVersion)
      .where(and(
        eq(schema.priceBookItemVersion.organizationId, ctx.actor.organizationId),
        eq(schema.priceBookItemVersion.id, input.versionId),
        isNull(schema.priceBookItemVersion.deletedAt),
      ));
    if (!version) throw new NotFoundError("Price book version");

    if (version.effectiveFrom <= now) {
      throw new ConflictError(
        "That revision is already in force, so it cannot be called off. Revise the item "
        + "again to change the price back: a price that was live is part of what somebody "
        + "was quoted.",
      );
    }

    const [previous] = await tx.select().from(schema.priceBookItemVersion)
      .where(and(
        eq(schema.priceBookItemVersion.organizationId, ctx.actor.organizationId),
        eq(schema.priceBookItemVersion.itemId, version.itemId),
        eq(schema.priceBookItemVersion.effectiveTo, version.effectiveFrom),
      ));

    if (!previous) {
      /**
       * Refused rather than carried out. A scheduled revision with no
       * predecessor is the item's FIRST version, dated ahead, and discarding
       * it leaves an item with no price at any instant. That is a different
       * operation: retire the item.
       */
      throw new ConflictError(
        "That is the only version this item has, so calling it off would leave the item "
        + "with no price at all. Retire the item instead.",
      );
    }

    await tx.update(schema.priceBookItemVersion)
      /**
       * Open ended again, which is what it was before the revision closed it.
       * Not "whatever it was", because a scheduled revision is always the end
       * of the chain: `revise` appends, so the row it closed had no successor
       * and therefore no `effective_to` of its own.
       */
      .set({ effectiveTo: null, updatedAt: new Date() })
      .where(eq(schema.priceBookItemVersion.id, previous.id));

    await tx.update(schema.priceBookItemVersion)
      .set({ deletedAt: now, updatedAt: new Date() })
      .where(eq(schema.priceBookItemVersion.id, version.id));

    await audit(
      tx, ctx, "pricebook.revision_discarded", "price_book_item", version.itemId,
      { versionId: version.id, price: version.price },
      null,
    );

    return { versionId: version.id, discarded: true };
  });
}

export const revisionHandlers = {
  listScheduledRevisions: async (ctx: ServiceContext): Promise<{ revisions: ScheduledRevision[] }> =>
    ({ revisions: await scheduledRevisions(ctx) }),
  publishRevision: (ctx: ServiceContext, input: { versionId: string }): Promise<{
    versionId: string; effectiveFrom: string;
  }> => publishRevision(ctx, input),
  discardRevision: (ctx: ServiceContext, input: { versionId: string }): Promise<{
    versionId: string; discarded: boolean;
  }> => discardRevision(ctx, input),
} as const;
