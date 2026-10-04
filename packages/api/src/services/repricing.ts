import { and, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, repricing, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { inForceAt, load, reviseWithin } from "./pricebook";
import { withDescendants } from "./price-categories";
import { remember, replayed } from "./once";

/**
 * CHANGING MANY PRICES AT ONCE
 *
 * The book a trade pack seeds is national averages, and before this the only
 * way to re-price it was one item at a time, so it stayed at national averages.
 * Now: choose items by category or search, choose a change (a percentage, an
 * amount, a margin over cost, rounding to a price ending, or a change and a
 * rounding), read every before and after, then apply.
 *
 * APPLIED AS NEW VERSIONS, the way a single edit is, through the same
 * `reviseWithin`. Not one version is edited in place, so every invoice already
 * raised keeps saying what it said. The change is recorded as a batch with
 * the version it closed and the version it wrote per item, which is what makes
 * undoing it an operation: the undo puts each item back to the price it had,
 * as another new version, and skips (and names) any item somebody has changed
 * again since, because putting the old price back over a newer one would undo
 * a decision this batch never made.
 *
 * WHAT THE PREVIEW SHOWS IS WHAT IS WRITTEN. Both go through `selection` and
 * `core/repricing`, and applying re-reads the items inside its own
 * transaction rather than trusting the numbers on the screen, which may be a
 * minute old.
 *
 * COST STAYS BEHIND ITS PERMISSION. Margin and cost appear in the preview
 * only for somebody holding `pricebook.cost:read`, and a margin rule needs it
 * outright: a price computed from cost, shown beside the rule that computed
 * it, gives the cost back in one division.
 *
 * DATED AHEAD, OR NOW. A bulk change takes effect when it is applied, or from
 * the start of a day ahead in the company's calendar, each item's new version
 * then waiting as a scheduled revision exactly as a single one dated ahead
 * does, and the change records the day. An item with a revision already
 * scheduled is left out and says why, because a new version would collide
 * with the one that is waiting. Undoing a change dated ahead before its day
 * calls the waiting versions off rather than writing more.
 */

export interface Selection {
  categoryId?: string | undefined;
  /** Include the categories under it. On unless said otherwise. */
  includeSubcategories?: boolean | undefined;
  q?: string | undefined;
  /** Only these, from within what the category and search select. */
  itemIds?: string[] | undefined;
}

export interface PreviewLine {
  itemId: string;
  code: string;
  name: string;
  categoryId: string | null;
  priceBefore: string;
  priceAfter: string | null;
  /** Present only for a caller who may see cost. */
  cost?: string | null;
  marginBefore?: string | null;
  marginAfter?: string | null;
  /** Why it will not change, when it will not. */
  skipped: string | null;
}

/** The most items one change may touch: the size of a large seeded book. */
export const MAX_ITEMS = 2000;

async function selected(tx: Database, selection: Selection) {
  const categories = selection.categoryId
    ? (selection.includeSubcategories === false ? [selection.categoryId] : await withDescendants(tx, selection.categoryId))
    : null;
  const q = selection.q?.trim();
  return tx.select({ item: schema.priceBookItem, version: schema.priceBookItemVersion })
    .from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, and(
      eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id),
      inForceAt(),
    ))
    .where(and(
      isNull(schema.priceBookItem.deletedAt),
      eq(schema.priceBookItem.active, true),
      categories ? inArray(schema.priceBookItem.categoryId, categories) : undefined,
      q ? or(
        ilike(schema.priceBookItemVersion.name, `%${q}%`),
        ilike(schema.priceBookItem.code, `%${q}%`),
      ) : undefined,
      selection.itemIds && selection.itemIds.length > 0
        ? inArray(schema.priceBookItem.id, selection.itemIds) : undefined,
    ))
    .orderBy(schema.priceBookItem.code)
    .limit(MAX_ITEMS + 1);
}

/** Items with a version dated after now, which a new version would collide with. */
async function scheduledFor(tx: Database, itemIds: string[]): Promise<Map<string, Date>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.select({
    itemId: schema.priceBookItemVersion.itemId,
    from: sql<Date>`min(${schema.priceBookItemVersion.effectiveFrom})`,
  }).from(schema.priceBookItemVersion)
    .where(and(
      inArray(schema.priceBookItemVersion.itemId, itemIds),
      gt(schema.priceBookItemVersion.effectiveFrom, new Date()),
      isNull(schema.priceBookItemVersion.deletedAt),
    ))
    .groupBy(schema.priceBookItemVersion.itemId);
  return new Map(rows.map((r) => [r.itemId, new Date(r.from)]));
}

function checked(rule: repricing.RepriceRule): void {
  const verdict = repricing.checkRule(rule);
  if (!verdict.ok) throw new UnprocessableError(verdict.message, [{ path: "rule", message: verdict.message }]);
}

async function compute(
  tx: Database, ctx: ServiceContext, selection: Selection, rule: repricing.RepriceRule,
): Promise<PreviewLine[]> {
  const rows = await selected(tx, selection);
  if (rows.length > MAX_ITEMS) {
    throw new ConflictError(
      `That selects more than ${MAX_ITEMS} items. Narrow it to a category or a search, and change the rest in another pass.`,
    );
  }
  const waiting = await scheduledFor(tx, rows.map((r) => r.item.id));
  const seesCost = can(ctx.actor, "pricebook.cost:read");
  /** The day a scheduled change starts, as the company counts days. */
  const zone = await timezoneOf(tx, ctx.actor.organizationId);

  return rows.map(({ item, version }) => {
    const pending = waiting.get(item.id);
    const outcome = pending
      ? { changed: false as const, message: `A price change is already scheduled for ${time.dateIn(pending, zone)}.` }
      : repricing.reprice({ price: version.price, cost: version.cost }, rule);
    const after = outcome.changed ? outcome.price : null;
    return {
      itemId: item.id,
      code: item.code,
      name: version.name,
      categoryId: item.categoryId,
      priceBefore: version.price,
      priceAfter: after,
      ...(seesCost ? {
        cost: version.cost,
        marginBefore: repricing.marginOf(version.price, version.cost),
        marginAfter: after ? repricing.marginOf(after, version.cost) : null,
      } : {}),
      skipped: outcome.changed ? null : outcome.message,
    };
  });
}

/**
 * Every item the change would touch, with its price before and after.
 *
 * `pricebook:write`, because it is a rehearsal of a write: the people who may
 * change the book are the people this is for.
 */
export async function preview(
  ctx: ServiceContext, input: { selection: Selection; rule: repricing.RepriceRule },
): Promise<{ description: string; lines: PreviewLine[]; changing: number }> {
  return guardedRead(ctx, "pricebook:write", async (tx) => {
    if (input.rule.adjust.kind === "margin") assertCan(ctx.actor, "pricebook.cost:read");
    checked(input.rule);
    const lines = await compute(tx, ctx, input.selection, input.rule);
    return {
      description: repricing.describeRule(input.rule),
      lines,
      changing: lines.filter((line) => line.priceAfter !== null).length,
    };
  });
}

export interface AppliedChange {
  id: string;
  description: string;
  changed: number;
  skipped: { itemId: string; code: string; reason: string }[];
}

async function writeBatch(
  tx: Database, ctx: ServiceContext,
  input: {
    kind: "change" | "reversal";
    description: string;
    rule: Record<string, unknown>;
    selection: Record<string, unknown>;
    reversesBatchId?: string;
    effectiveFrom?: Date | null;
    lines: { itemId: string; price: string }[];
  },
): Promise<{ batchId: string; changed: number }> {
  const [batch] = await tx.insert(schema.priceChangeBatch).values({
    organizationId: ctx.actor.organizationId,
    kind: input.kind,
    rule: input.rule,
    description: input.description,
    selection: input.selection,
    itemCount: 0,
    reversesBatchId: input.reversesBatchId ?? null,
    effectiveFrom: input.effectiveFrom ?? null,
    appliedByUserId: ctx.actor.userId,
  }).returning({ id: schema.priceChangeBatch.id });

  const now = input.effectiveFrom ?? new Date();
  let changed = 0;
  for (const line of input.lines) {
    const current = await load(tx, line.itemId);
    if (!current) continue;
    const version = await reviseWithin(tx, ctx, current, { price: line.price }, now);
    await tx.insert(schema.priceChangeLine).values({
      organizationId: ctx.actor.organizationId,
      batchId: batch!.id,
      itemId: line.itemId,
      fromVersionId: current.version.id,
      toVersionId: version.id,
      priceBefore: current.version.price,
      priceAfter: version.price,
    });
    changed += 1;
  }

  await tx.update(schema.priceChangeBatch)
    .set({ itemCount: changed, updatedAt: new Date() })
    .where(eq(schema.priceChangeBatch.id, batch!.id));

  /**
   * One line for the whole change, beside the line per item `reviseWithin`
   * writes, so "who re-priced the plumbing book on Tuesday" is one row and
   * "what happened to this item" is still the item's own history.
   */
  await audit(tx, ctx, input.kind === "change" ? "pricebook.repriced" : "pricebook.reprice_reversed",
    "price_change_batch", batch!.id, null,
    { description: input.description, items: changed, reverses: input.reversesBatchId ?? null });

  return { batchId: batch!.id, changed };
}

/**
 * Apply the change, as a new version per item.
 *
 * Re-computed here, inside the write, rather than taken from the preview the
 * screen showed. `itemIds` narrows it to the items somebody left ticked.
 */
export async function apply(
  ctx: ServiceContext, input: { selection: Selection; rule: repricing.RepriceRule; effectiveOn?: string | undefined },
): Promise<AppliedChange> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const seen = await replayed<AppliedChange>(tx, ctx, "price_change_batch");
    if (seen) return seen;
    const effectiveFrom = await startOf(tx, ctx, input.effectiveOn);

    if (input.rule.adjust.kind === "margin") assertCan(ctx.actor, "pricebook.cost:read");
    checked(input.rule);
    const lines = await compute(tx, ctx, input.selection, input.rule);
    const changing = lines.filter((line) => line.priceAfter !== null);
    if (changing.length === 0) {
      throw new ConflictError("Nothing in that selection would change, so there is nothing to apply.");
    }

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const description = effectiveFrom
      ? `${repricing.describeRule(input.rule)}, from ${time.dateIn(effectiveFrom, zone)}`
      : repricing.describeRule(input.rule);
    const { batchId, changed } = await writeBatch(tx, ctx, {
      kind: "change",
      effectiveFrom,
      description,
      rule: input.rule as unknown as Record<string, unknown>,
      selection: input.selection as unknown as Record<string, unknown>,
      lines: changing.map((line) => ({ itemId: line.itemId, price: line.priceAfter! })),
    });

    const answer: AppliedChange = {
      id: batchId,
      description,
      changed,
      skipped: lines.filter((l) => l.skipped).map((l) => ({ itemId: l.itemId, code: l.code, reason: l.skipped! })),
    };
    await remember(tx, ctx, "price_change_batch", batchId, answer);
    return answer;
  });
}

/**
 * The instant a change dated `effectiveOn` takes effect: the start of that
 * day in the company's calendar. Null for now, which is what today means: a
 * change for today would otherwise be dated at a midnight already past.
 * A day gone by is refused, because a price is never changed backwards.
 */
async function startOf(tx: Database, ctx: ServiceContext, effectiveOn: string | undefined): Promise<Date | null> {
  if (!effectiveOn) return null;
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  const today = time.dateIn(new Date(), zone);
  if (effectiveOn < today) {
    throw new UnprocessableError("A price change cannot start in the past", [{
      path: "effectiveOn", message: `${effectiveOn} has gone. Choose today or a day ahead.`,
    }]);
  }
  return effectiveOn === today ? null : time.startOfDayIn(effectiveOn, zone);
}

/**
 * Call off a change dated ahead before its day: every version it scheduled is
 * withdrawn and the price in force runs on, as calling off one scheduled
 * revision does. Recorded as an undo with a line per item, from the price it
 * would have become back to the price that stays.
 */
async function callOff(
  tx: Database, ctx: ServiceContext, batch: typeof schema.priceChangeBatch.$inferSelect,
): Promise<AppliedChange> {
  const lines = await tx.select({ line: schema.priceChangeLine, code: schema.priceBookItem.code })
    .from(schema.priceChangeLine)
    .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceChangeLine.itemId))
    .where(eq(schema.priceChangeLine.batchId, batch.id));
  const description = `Called off "${batch.description}" before it took effect`;
  const [undo] = await tx.insert(schema.priceChangeBatch).values({
    organizationId: ctx.actor.organizationId,
    kind: "reversal",
    rule: { reverses: batch.id, skipped: [] },
    description,
    selection: {},
    itemCount: 0,
    reversesBatchId: batch.id,
    appliedByUserId: ctx.actor.userId,
  }).returning({ id: schema.priceChangeBatch.id });

  const skipped: AppliedChange["skipped"] = [];
  let changed = 0;
  for (const { line, code } of lines) {
    const [waiting] = await tx.select().from(schema.priceBookItemVersion)
      .where(and(eq(schema.priceBookItemVersion.id, line.toVersionId), isNull(schema.priceBookItemVersion.deletedAt)))
      .limit(1);
    const [previous] = waiting
      ? await tx.select().from(schema.priceBookItemVersion)
        .where(and(
          eq(schema.priceBookItemVersion.itemId, line.itemId),
          eq(schema.priceBookItemVersion.effectiveTo, waiting.effectiveFrom),
          isNull(schema.priceBookItemVersion.deletedAt),
        )).limit(1)
      : [];
    if (!waiting || waiting.effectiveTo !== null || !previous) {
      skipped.push({ itemId: line.itemId, code, reason: "Its price has been changed again since, so it was left as it is." });
      continue;
    }
    await tx.update(schema.priceBookItemVersion).set({ effectiveTo: null, updatedAt: new Date() })
      .where(eq(schema.priceBookItemVersion.id, previous.id));
    await tx.update(schema.priceBookItemVersion).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.priceBookItemVersion.id, waiting.id));
    await tx.insert(schema.priceChangeLine).values({
      organizationId: ctx.actor.organizationId,
      batchId: undo!.id,
      itemId: line.itemId,
      fromVersionId: waiting.id,
      toVersionId: previous.id,
      priceBefore: waiting.price,
      priceAfter: previous.price,
    });
    await audit(tx, ctx, "pricebook.revision_discarded", "price_book_item", line.itemId,
      { versionId: waiting.id, price: waiting.price }, null);
    changed += 1;
  }
  if (changed === 0) {
    throw new ConflictError("Every item in that change has been changed again since, so there is nothing to call off.");
  }
  await tx.update(schema.priceChangeBatch).set({ itemCount: changed, rule: { reverses: batch.id, skipped }, updatedAt: new Date() })
    .where(eq(schema.priceChangeBatch.id, undo!.id));
  await tx.update(schema.priceChangeBatch).set({ reversedByBatchId: undo!.id, updatedAt: new Date() })
    .where(eq(schema.priceChangeBatch.id, batch.id));
  await audit(tx, ctx, "pricebook.reprice_reversed", "price_change_batch", undo!.id, null,
    { description, items: changed, reverses: batch.id });
  return { id: undo!.id, description, changed, skipped };
}

/**
 * Put every item a change touched back to the price it had before.
 *
 * Another change, written the same way, pointing back at this one. An item
 * whose version in force is no longer the one this change wrote has been
 * changed again since, and is left alone and named: putting the old price
 * back over it would undo somebody else's decision.
 */
export async function reverse(ctx: ServiceContext, input: { id: string }): Promise<AppliedChange> {
  return guardedWrite(ctx, "pricebook:write", async (tx) => {
    const seen = await replayed<AppliedChange>(tx, ctx, "price_change_reversal");
    if (seen) return seen;

    const [batch] = await tx.select().from(schema.priceChangeBatch)
      .where(eq(schema.priceChangeBatch.id, input.id)).limit(1);
    if (!batch) throw new NotFoundError("Price change");
    if (batch.reversedByBatchId) throw new ConflictError("That change has already been undone.");
    if (batch.effectiveFrom && batch.effectiveFrom > new Date()) {
      const answer = await callOff(tx, ctx, batch);
      await remember(tx, ctx, "price_change_reversal", answer.id, answer);
      return answer;
    }

    const lines = await tx.select({
      line: schema.priceChangeLine,
      code: schema.priceBookItem.code,
    }).from(schema.priceChangeLine)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceChangeLine.itemId))
      .where(eq(schema.priceChangeLine.batchId, batch.id));

    const back: { itemId: string; price: string }[] = [];
    const skipped: AppliedChange["skipped"] = [];
    for (const { line, code } of lines) {
      const current = await load(tx, line.itemId);
      if (!current) {
        skipped.push({ itemId: line.itemId, code, reason: "It has been removed from the price book." });
        continue;
      }
      const verdict = current.version.id === line.toVersionId
        ? repricing.reversalOf({ priceBefore: line.priceBefore, priceAfter: line.priceAfter, priceNow: current.version.price })
        : { ok: false as const, message: "Its price has been changed again since, so putting the old one back would undo that too." };
      if (verdict.ok) back.push({ itemId: line.itemId, price: verdict.price });
      else skipped.push({ itemId: line.itemId, code, reason: verdict.message });
    }

    const description = `Undid "${batch.description}"`;
    const { batchId, changed } = back.length > 0
      ? await writeBatch(tx, ctx, {
        kind: "reversal", description, rule: { reverses: batch.id, skipped }, selection: {}, reversesBatchId: batch.id, lines: back,
      })
      : { batchId: null as string | null, changed: 0 };
    if (!batchId) {
      throw new ConflictError("Every item in that change has been changed again since, so there is nothing to put back.");
    }

    await tx.update(schema.priceChangeBatch)
      .set({ reversedByBatchId: batchId, updatedAt: new Date() })
      .where(eq(schema.priceChangeBatch.id, batch.id));

    const answer: AppliedChange = { id: batchId, description, changed, skipped };
    await remember(tx, ctx, "price_change_reversal", batchId, answer);
    return answer;
  });
}

export interface ChangeSummary {
  id: string;
  kind: "change" | "reversal";
  description: string;
  itemCount: number;
  appliedBy: string | null;
  appliedAt: string;
  reversesId: string | null;
  reversedById: string | null;
  effectiveFrom: string | null;
}

/** The changes made, newest first. */
export async function history(ctx: ServiceContext, input: { limit?: number | undefined } = {}): Promise<ChangeSummary[]> {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const rows = await tx.select({
      batch: schema.priceChangeBatch,
      name: schema.user.name,
      email: schema.user.email,
    }).from(schema.priceChangeBatch)
      .leftJoin(schema.user, eq(schema.user.id, schema.priceChangeBatch.appliedByUserId))
      .orderBy(desc(schema.priceChangeBatch.createdAt))
      .limit(Math.min(input.limit ?? 50, 200));
    return rows.map(({ batch, name, email }) => ({
      id: batch.id,
      kind: batch.kind,
      description: batch.description,
      itemCount: batch.itemCount,
      appliedBy: name ?? email,
      appliedAt: batch.createdAt.toISOString(),
      reversesId: batch.reversesBatchId,
      reversedById: batch.reversedByBatchId,
      effectiveFrom: batch.effectiveFrom?.toISOString() ?? null,
    }));
  });
}

/** One change, item by item. */
export async function lines(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "pricebook:read", async (tx) => {
    const [batch] = await tx.select().from(schema.priceChangeBatch)
      .where(eq(schema.priceChangeBatch.id, input.id)).limit(1);
    if (!batch) throw new NotFoundError("Price change");
    const rows = await tx.select({
      line: schema.priceChangeLine,
      code: schema.priceBookItem.code,
      name: schema.priceBookItemVersion.name,
    }).from(schema.priceChangeLine)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceChangeLine.itemId))
      .innerJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.id, schema.priceChangeLine.toVersionId))
      .where(eq(schema.priceChangeLine.batchId, batch.id))
      .orderBy(schema.priceBookItem.code);
    return {
      id: batch.id,
      kind: batch.kind,
      description: batch.description,
      appliedAt: batch.createdAt.toISOString(),
      reversesId: batch.reversesBatchId,
      reversedById: batch.reversedByBatchId,
      effectiveFrom: batch.effectiveFrom?.toISOString() ?? null,
      /**
       * The items an undo left alone because they had been changed again
       * since, kept on the undo itself, so the answer to "why is this one
       * still at the new price" outlives the moment the button was pressed.
       */
      skipped: Array.isArray(batch.rule["skipped"]) ? batch.rule["skipped"] as AppliedChange["skipped"] : [],
      lines: rows.map(({ line, code, name }) => ({
        itemId: line.itemId, code, name, priceBefore: line.priceBefore, priceAfter: line.priceAfter,
      })),
    };
  });
}

/* ------------------------------------------------------------- the API */

export interface RuleInput {
  mode: "percent" | "amount" | "margin" | "round";
  /** The percentage, the amount, or the margin as a fraction. Absent for `round`. */
  value?: string | undefined;
  ending?: string | undefined;
}

/**
 * The rule from its flat form, which is what a query string and a form can
 * carry. A union in a query string is not something the OpenAPI document can
 * describe well, and a person filling a form chooses a mode and types a
 * number.
 */
export function ruleFrom(input: RuleInput): repricing.RepriceRule {
  const value = input.value?.trim() ?? "";
  const ending = input.ending?.trim() || undefined;
  const adjust: repricing.Adjustment = input.mode === "percent" ? { kind: "percent", percent: value }
    : input.mode === "amount" ? { kind: "amount", amount: value }
    : input.mode === "margin" ? { kind: "margin", margin: value }
    : { kind: "none" };
  return { adjust, ...(ending ? { ending } : {}) };
}

type FlatInput = RuleInput & {
  effectiveOn?: string | undefined;
  categoryId?: string | undefined;
  includeSubcategories?: boolean | undefined;
  q?: string | undefined;
  itemIds?: string[] | undefined;
};

const selectionFrom = (input: FlatInput): Selection => ({
  ...(input.categoryId ? { categoryId: input.categoryId } : {}),
  ...(input.includeSubcategories !== undefined ? { includeSubcategories: input.includeSubcategories } : {}),
  ...(input.q ? { q: input.q } : {}),
  ...(input.itemIds ? { itemIds: input.itemIds } : {}),
});

export const handlers = {
  previewPriceChange: (ctx: ServiceContext, input: FlatInput) =>
    preview(ctx, { selection: selectionFrom(input), rule: ruleFrom(input) }),
  applyPriceChange: (ctx: ServiceContext, input: FlatInput) =>
    apply(ctx, { selection: selectionFrom(input), rule: ruleFrom(input), effectiveOn: input.effectiveOn }),
  listPriceChanges: async (ctx: ServiceContext, input: { limit?: number | undefined }) =>
    ({ changes: await history(ctx, input) }),
  getPriceChange: (ctx: ServiceContext, input: { id: string }) => lines(ctx, input),
  reversePriceChange: (ctx: ServiceContext, input: { id: string }) => reverse(ctx, input),
} as const;
