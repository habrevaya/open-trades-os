import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, catalogue, money as m } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { costPerUseUnit, inForceAt, load, reviseWithin, unitsOf } from "./pricebook";
import * as once from "./once";

/**
 * WHAT A VENDOR CALLS OUR PARTS, AND THEIR CATALOGUE
 *
 * A purchase order goes to the supplier, so it has to say the supplier's part
 * number, and nothing here knew it: an order line named our item and somebody
 * typed the supplier's number into the notes from memory, or the counter
 * staff guessed. `vendor_item` is the missing link, one row per item per
 * vendor, and the catalogue import fills it from the file every supply house
 * already sends.
 *
 * PERMISSIONS. A link is vendor data, so reading one is `vendor:read` and
 * writing one is `vendor:write`. The cost on it is the vendor's price to us,
 * which is already on every purchase order a `po:read` holder can open, and
 * the roles that hold `vendor:read` all see cost. The import also creates and
 * revises price book items, so it needs `pricebook:write` as well, and it
 * shows an item's own cost beside the vendor's only to somebody who holds
 * `pricebook.cost:read`.
 */

export interface VendorLinkView {
  id: string;
  vendorId: string;
  vendorName: string;
  itemId: string;
  itemCode: string;
  itemName: string | null;
  partNumber: string;
  description: string | null;
  cost: string | null;
  costUpdatedAt: string | null;
  /** How many of our units are in one of theirs; `cost` is for one of theirs. "1" when they sell what we count. */
  packQuantity: string;
  /** What they call their unit, "box". Null for each. */
  purchaseUnit: string | null;
  /** Their price for one of their units at so many or more, lowest first. */
  priceBreaks: catalogue.PriceBreak[];
  /** What one of ours comes to at their base price. Null with no cost. */
  eachCost: string | null;
  /** The second way they sell it (by the box as well as the each), or null for a part sold one way. */
  secondPack: {
    /** The vendor's own number for this pack when it is not `partNumber`, or null when they share one. */
    partNumber: string | null;
    packQuantity: string; purchaseUnit: string | null; cost: string | null;
    priceBreaks: catalogue.PriceBreak[]; eachCost: string | null;
  } | null;
  /**
   * Both ways to buy it, cheaper per one of ours first: the order a purchase order offers them in.
   * `partNumber` is the number a purchase order for that pack is sent with.
   */
  packs: {
    packQuantity: string; purchaseUnit: string | null; cost: string | null; eachCost: string | null; second: boolean;
    partNumber: string;
  }[];
}

/** A link's ways to buy the part, as an order chooses between them, first pack first. */
function packsOf(link: typeof schema.vendorItem.$inferSelect): (catalogue.Pack & { second: boolean })[] {
  return [
    { quantity: link.packQuantity, unit: link.purchaseUnit, cost: link.cost, breaks: link.priceBreaks, second: false, partNumber: null },
    ...(link.secondPackQuantity ? [{
      quantity: link.secondPackQuantity, unit: link.secondPurchaseUnit, cost: link.secondCost,
      breaks: link.secondPriceBreaks, second: true, partNumber: link.secondPartNumber,
    }] : []),
  ];
}

async function linksWithin(
  tx: Database, filter: { itemId?: string | undefined; vendorId?: string | undefined },
): Promise<VendorLinkView[]> {
  const rows = await tx.select({
    link: schema.vendorItem,
    vendorName: schema.vendor.name,
    itemCode: schema.priceBookItem.code,
    itemName: schema.priceBookItemVersion.name,
  })
    .from(schema.vendorItem)
    .innerJoin(schema.vendor, eq(schema.vendor.id, schema.vendorItem.vendorId))
    .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.vendorItem.itemId))
    .leftJoin(schema.priceBookItemVersion, and(
      eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id),
      inForceAt(),
      isNull(schema.priceBookItemVersion.deletedAt),
    ))
    .where(and(
      filter.itemId ? eq(schema.vendorItem.itemId, filter.itemId) : undefined,
      filter.vendorId ? eq(schema.vendorItem.vendorId, filter.vendorId) : undefined,
      isNull(schema.vendor.deletedAt),
    ))
    .orderBy(asc(schema.vendor.name), asc(schema.vendorItem.partNumber));

  return rows.map((r) => ({
    id: r.link.id,
    vendorId: r.link.vendorId,
    vendorName: r.vendorName,
    itemId: r.link.itemId,
    itemCode: r.itemCode,
    itemName: r.itemName,
    partNumber: r.link.partNumber,
    description: r.link.description,
    cost: r.link.cost,
    costUpdatedAt: r.link.costUpdatedAt?.toISOString() ?? null,
    packQuantity: r.link.packQuantity,
    purchaseUnit: r.link.purchaseUnit,
    priceBreaks: r.link.priceBreaks,
    eachCost: r.link.cost ? catalogue.eachCost(r.link.cost, r.link.packQuantity) : null,
    secondPack: r.link.secondPackQuantity ? {
      partNumber: r.link.secondPartNumber,
      packQuantity: r.link.secondPackQuantity, purchaseUnit: r.link.secondPurchaseUnit, cost: r.link.secondCost,
      priceBreaks: r.link.secondPriceBreaks,
      eachCost: r.link.secondCost ? catalogue.eachCost(r.link.secondCost, r.link.secondPackQuantity) : null,
    } : null,
    packs: catalogue.cheaperFirst(packsOf(r.link)).map((p) => ({
      packQuantity: p.quantity, purchaseUnit: p.unit, cost: p.cost,
      eachCost: p.cost ? catalogue.eachCost(p.cost, p.quantity) : null, second: p.second,
      partNumber: p.partNumber ?? r.link.partNumber,
    })),
  }));
}

/** An item's vendors, or a vendor's items, by part number. */
export async function links(
  ctx: ServiceContext, input: { itemId?: string | undefined; vendorId?: string | undefined },
): Promise<VendorLinkView[]> {
  return guardedRead(ctx, "vendor:read", (tx) => linksWithin(tx, input));
}

const PART_NUMBER_TAKEN = (partNumber: string) =>
  `${partNumber} is already this vendor's number for another of your items. One number is one part, `
  + "because a purchase order line and a receipt both find the item by it.";

/**
 * Say what a vendor calls one of our items, and what they charge.
 *
 * One row per item per vendor, so this replaces the item's existing link to
 * that vendor rather than adding a second: a supplier who renumbered a part
 * has one number for it, not two.
 */
export async function setLink(
  ctx: ServiceContext,
  input: {
    vendorId: string; itemId: string; partNumber: string;
    description?: string | null | undefined; cost?: string | null | undefined;
    /** How many of ours in one of theirs. Left out keeps what is on record. */
    packQuantity?: string | null | undefined;
    purchaseUnit?: string | null | undefined;
    /** Replaces the break table whole when given. */
    priceBreaks?: readonly catalogue.PriceBreak[] | null | undefined;
    /**
     * The second way they sell it, replaced whole when given; null takes it
     * away, and left out keeps what is on record.
     */
    secondPack?: {
      packQuantity: string; purchaseUnit?: string | null | undefined; cost?: string | null | undefined;
      priceBreaks?: readonly catalogue.PriceBreak[] | null | undefined;
      /** The vendor's number for this pack when it is not the first's. Replaced with the rest of the pack. */
      partNumber?: string | null | undefined;
    } | null | undefined;
  },
): Promise<VendorLinkView> {
  return guardedWrite(ctx, "vendor:write", async (tx) => {
    const partNumber = input.partNumber.trim();
    if (partNumber === "") throw new ConflictError("A vendor's part number cannot be blank.");
    const cost = input.cost === undefined || input.cost === null || input.cost.trim() === ""
      ? null : catalogue.parseCost(input.cost);
    if (input.cost && input.cost.trim() !== "" && cost === null) {
      throw new ConflictError(`"${input.cost}" is not an amount. Give the vendor's price for one, like 12.50.`);
    }
    const pack = input.packQuantity?.trim() ? catalogue.parsePack(input.packQuantity) : null;
    if (input.packQuantity?.trim() && pack === null) {
      throw new ConflictError(`"${input.packQuantity}" is not how many come in one of theirs. Give a number, like 25 for a box of 25.`);
    }
    const breaks = input.priceBreaks ? catalogue.checkBreaks(input.priceBreaks) : null;
    if (breaks && !breaks.ok) throw new ConflictError(breaks.message);

    const [vendor] = await tx.select({ id: schema.vendor.id }).from(schema.vendor)
      .where(and(eq(schema.vendor.id, input.vendorId), isNull(schema.vendor.deletedAt))).limit(1);
    if (!vendor) throw new NotFoundError("Vendor");
    const [item] = await tx.select({ id: schema.priceBookItem.id }).from(schema.priceBookItem)
      .where(and(eq(schema.priceBookItem.id, input.itemId), isNull(schema.priceBookItem.deletedAt))).limit(1);
    if (!item) throw new NotFoundError("Price book item");

    const [before] = await tx.select().from(schema.vendorItem)
      .where(and(eq(schema.vendorItem.vendorId, input.vendorId), eq(schema.vendorItem.itemId, input.itemId)))
      .limit(1);

    const second = secondPackOf(input.secondPack);
    const firstPack = pack === null ? before?.packQuantity ?? "1" : m.toString(m.money(pack));
    const secondQuantity = second === undefined ? before?.secondPackQuantity ?? null : second?.packQuantity ?? null;
    if (secondQuantity !== null && m.compare(m.money(secondQuantity), m.money(firstPack)) === 0) {
      throw new ConflictError(
        `Both ways to buy it are packs of ${Number(firstPack)}. A second way is a different pack, like the each and the box of 25.`,
      );
    }

    /**
     * THE SECOND PACK'S OWN NUMBER, replaced with the pack (a pack given without
     * one has none), kept when the pack is kept, and gone with the pack. The
     * same number as the first is no second number. It may not be, or be, a
     * number this vendor has for another link: a line and a receipt find the
     * item by it, so one number is one part.
     */
    const secondNumber = secondQuantity === null ? null
      : second === undefined ? before?.secondPartNumber ?? null : second?.partNumber ?? null;
    const secondKept = secondNumber !== null && secondNumber.toLowerCase() === partNumber.toLowerCase() ? null : secondNumber;
    if (secondNumber !== null && secondKept === null && second === undefined) {
      throw new ConflictError(
        `${partNumber} is also the number this vendor has for the second way to buy it. Take that number off the second way first, or keep the old first number.`,
      );
    }
    for (const taken of [partNumber, secondKept]) {
      if (taken === null) continue;
      const lower = taken.toLowerCase();
      const others = await tx.select({ id: schema.vendorItem.id }).from(schema.vendorItem).where(and(
        eq(schema.vendorItem.vendorId, input.vendorId),
        ne(schema.vendorItem.itemId, input.itemId),
        sql`(lower(${schema.vendorItem.partNumber}) = ${lower} or lower(${schema.vendorItem.secondPartNumber}) = ${lower})`,
      )).limit(1);
      if (others.length > 0) throw new ConflictError(PART_NUMBER_TAKEN(taken));
    }

    const values = {
      partNumber,
      secondPartNumber: secondKept,
      description: input.description?.trim() ? input.description.trim() : before?.description ?? null,
      cost: cost === null ? before?.cost ?? null : m.toString(m.money(cost)),
      costUpdatedAt: cost === null ? before?.costUpdatedAt ?? null : new Date(),
      packQuantity: pack === null ? before?.packQuantity ?? "1" : m.toString(m.money(pack)),
      purchaseUnit: input.purchaseUnit === undefined ? before?.purchaseUnit ?? null : input.purchaseUnit?.trim() || null,
      priceBreaks: breaks?.ok ? breaks.breaks : before?.priceBreaks ?? [],
      ...(second === undefined ? {} : {
        secondPackQuantity: second?.packQuantity ?? null,
        secondPurchaseUnit: second?.purchaseUnit ?? null,
        secondCost: second?.cost ?? null,
        secondPriceBreaks: second?.priceBreaks ?? [],
      }),
      updatedAt: new Date(),
    };
    const [row] = await refusingDuplicate("vendor_item_part_number_idx", PART_NUMBER_TAKEN(partNumber), () =>
      refusingDuplicate("vendor_item_second_part_number_idx", PART_NUMBER_TAKEN(secondKept ?? partNumber), () =>
        before
          ? tx.update(schema.vendorItem).set(values).where(eq(schema.vendorItem.id, before.id)).returning()
          : tx.insert(schema.vendorItem).values({
            organizationId: ctx.actor.organizationId, vendorId: input.vendorId, itemId: input.itemId, ...values,
          }).returning()));

    await audit(tx, ctx, before ? "vendor_item.updated" : "vendor_item.created", "vendor_item", row!.id, before ?? null, row!);
    return (await linksWithin(tx, { itemId: input.itemId })).find((l) => l.id === row!.id)!;
  });
}

/**
 * A second pack as somebody typed it, checked the way the first is: a number
 * in it, an amount for its price, a break table that reads. Undefined keeps
 * what is on record and null takes it away.
 */
function secondPackOf(input: {
  packQuantity: string; purchaseUnit?: string | null | undefined; cost?: string | null | undefined;
  priceBreaks?: readonly catalogue.PriceBreak[] | null | undefined;
  partNumber?: string | null | undefined;
} | null | undefined) {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const pack = catalogue.parsePack(input.packQuantity);
  if (pack === null) {
    throw new ConflictError(`"${input.packQuantity}" is not how many come in the second way they sell it. Give a number, like 25 for a box of 25.`);
  }
  const cost = input.cost?.trim() ? catalogue.parseCost(input.cost) : null;
  if (input.cost?.trim() && cost === null) {
    throw new ConflictError(`"${input.cost}" is not an amount. Give the vendor's price for one of the second pack.`);
  }
  const breaks = input.priceBreaks ? catalogue.checkBreaks(input.priceBreaks) : null;
  if (breaks && !breaks.ok) throw new ConflictError(breaks.message);
  return {
    packQuantity: m.toString(m.money(pack)),
    purchaseUnit: input.purchaseUnit?.trim() || null,
    cost: cost === null ? null : m.toString(m.money(cost)),
    priceBreaks: breaks?.ok ? breaks.breaks : [],
    partNumber: input.partNumber?.trim() || null,
  };
}

/**
 * Forget a vendor's number for an item. A real delete, because the link is
 * a lookup rather than a record of anything that happened: every purchase
 * order that used it kept its own copy of the number it was sent with.
 */
export async function removeLink(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: boolean }> {
  return guardedWrite(ctx, "vendor:write", async (tx) => {
    const [gone] = await tx.delete(schema.vendorItem).where(eq(schema.vendorItem.id, input.id)).returning();
    if (!gone) throw new NotFoundError("Vendor part number");
    await audit(tx, ctx, "vendor_item.removed", "vendor_item", input.id, gone, null);
    return { id: input.id, removed: true };
  });
}

/* ------------------------------------------------------- the catalogue */

export interface CatalogueInput {
  /** The file, as text. */
  csv: string;
  /** The vendor for rows that name none, or a file with no vendor column. */
  vendorId?: string | null | undefined;
  /** The margin new items are priced at over cost, as a fraction. Without one, new parts are skipped. */
  margin?: string | null | undefined;
  /** Round new items' prices up to this ending: "00", "95", "99". */
  ending?: string | null | undefined;
  /** Whether each item's own cost follows the vendor's. */
  updateItemCost?: boolean | undefined;
  /** The shelf new items go on. */
  categoryId?: string | null | undefined;
  /** Whether a vendor the file names that is not set up yet may be added. Off unless asked. */
  createVendors?: boolean | undefined;
}

export interface CatalogueResult {
  problems: catalogue.CatalogueProblem[];
  rows: catalogue.RowPlan[];
  counts: catalogue.CataloguePlan["counts"];
  /** The vendors applying it adds, by the name the file gives, with the first line that names each. */
  newVendors: catalogue.CataloguePlan["newVendors"];
}

/**
 * Everything the plan needs to know about what already exists: the vendors,
 * their links, and every item the file's part numbers could name, with the
 * cost in force and whether a price change is already scheduled.
 */
async function stateFor(tx: Database, rows: readonly catalogue.CatalogueRow[]): Promise<catalogue.CatalogueState> {
  const vendors = await tx.select({ id: schema.vendor.id, name: schema.vendor.name })
    .from(schema.vendor).where(isNull(schema.vendor.deletedAt));
  const links = await tx.select().from(schema.vendorItem);

  const codes = [...new Set(rows.map((r) => r.sku.trim().toLowerCase()))];
  const linkedIds = [...new Set(links.map((l) => l.itemId))];
  const items = codes.length === 0 && linkedIds.length === 0 ? [] : await tx.select({
    id: schema.priceBookItem.id,
    code: schema.priceBookItem.code,
    name: schema.priceBookItemVersion.name,
    cost: costPerUseUnit,
  })
    .from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, and(
      eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id),
      inForceAt(),
      isNull(schema.priceBookItemVersion.deletedAt),
    ))
    .where(and(
      isNull(schema.priceBookItem.deletedAt),
      or(
        codes.length ? inArray(sql`lower(${schema.priceBookItem.code})`, codes) : undefined,
        linkedIds.length ? inArray(schema.priceBookItem.id, linkedIds) : undefined,
      ),
    ));

  const ids = items.map((i) => i.id);
  const scheduled = ids.length === 0 ? [] : await tx.selectDistinct({ itemId: schema.priceBookItemVersion.itemId })
    .from(schema.priceBookItemVersion)
    .where(and(
      inArray(schema.priceBookItemVersion.itemId, ids),
      gt(schema.priceBookItemVersion.effectiveFrom, new Date()),
      isNull(schema.priceBookItemVersion.deletedAt),
    ));
  const ahead = new Set(scheduled.map((s) => s.itemId));

  return {
    vendors,
    links: links.map((l) => ({
      vendorId: l.vendorId, itemId: l.itemId, partNumber: l.partNumber, cost: l.cost, description: l.description,
      packQuantity: l.packQuantity, purchaseUnit: l.purchaseUnit, priceBreaks: l.priceBreaks,
      second: l.secondPackQuantity ? {
        partNumber: l.secondPartNumber,
        packQuantity: l.secondPackQuantity, purchaseUnit: l.secondPurchaseUnit, cost: l.secondCost, priceBreaks: l.secondPriceBreaks,
      } : null,
    })),
    items: items.map((i) => ({ ...i, scheduled: ahead.has(i.id) })),
  };
}

async function planWithin(tx: Database, ctx: ServiceContext, input: CatalogueInput): Promise<CatalogueResult & {
  parsed: catalogue.ParsedCatalogue;
}> {
  if (input.vendorId) {
    const [vendor] = await tx.select({ id: schema.vendor.id }).from(schema.vendor)
      .where(and(eq(schema.vendor.id, input.vendorId), isNull(schema.vendor.deletedAt))).limit(1);
    if (!vendor) throw new NotFoundError("Vendor");
  }
  const parsed = catalogue.parseCatalogue(input.csv);
  if (parsed.rows.length === 0 && parsed.problems.length > 0 && parsed.problems[0]!.line === 1) {
    /** The header itself is the problem, so there is no file to preview. */
    throw new ConflictError(parsed.problems[0]!.message);
  }
  const plan = catalogue.planCatalogue(parsed.rows, await stateFor(tx, parsed.rows), {
    defaultVendorId: input.vendorId ?? null,
    margin: input.margin ?? null,
    ending: input.ending ?? null,
    updateItemCost: input.updateItemCost ?? false,
    createVendors: input.createVendors ?? false,
  });
  return {
    parsed, problems: parsed.problems, rows: redacted(ctx, plan.rows), counts: plan.counts, newVendors: plan.newVendors,
  };
}

/** An item's own cost, beside the vendor's, only for a reader who may see cost. */
function redacted(ctx: ServiceContext, rows: catalogue.RowPlan[]): catalogue.RowPlan[] {
  if (can(ctx.actor, "pricebook.cost:read")) return rows;
  return rows.map((row) => {
    if (row.action !== "link" && row.action !== "update") return row;
    const { itemCostBefore: _before, ...rest } = row;
    return { ...rest, itemCostBefore: null };
  });
}

/**
 * What the file would do, row by row, with nothing written.
 *
 * `vendor:write` and `pricebook:write`, the two things applying it needs, so
 * nobody is shown a preview of a change they cannot make.
 */
export async function preview(ctx: ServiceContext, input: CatalogueInput): Promise<CatalogueResult> {
  assertCan(ctx.actor, "pricebook:write");
  return guardedRead(ctx, "vendor:write", async (tx) => {
    const { parsed: _parsed, ...result } = await planWithin(tx, ctx, input);
    return result;
  });
}

/**
 * Apply the file.
 *
 * RECOMPUTED INSIDE THE WRITE, from the same file and the same options, rather
 * than taken from the preview a person read, which may be a minute old: the
 * bulk price change does the same for the same reason. What is written is
 * exactly what the plan says, and `skipLines` leaves out any line the person
 * unticked.
 *
 * A NEW ITEM is a material at the margin asked for, taxable, on the chosen
 * shelf, version one. AN ITEM'S COST that follows the vendor's is a new
 * version through `reviseWithin`, the one way a price book item changes, so
 * every document already priced keeps the cost it was priced at.
 */
export async function apply(
  ctx: ServiceContext, input: CatalogueInput & { skipLines?: number[] | undefined },
): Promise<CatalogueResult & { created: number; linked: number; updated: number; itemCostsRevised: number; vendorsAdded: number }> {
  assertCan(ctx.actor, "pricebook:write");
  return guardedWrite(ctx, "vendor:write", async (tx) => {
    type Applied = CatalogueResult & {
      created: number; linked: number; updated: number; itemCostsRevised: number; vendorsAdded: number;
    };
    const seen = await once.replayed<Applied>(tx, ctx, "vendor_catalogue");
    if (seen) return seen;

    if (input.categoryId) {
      const [shelf] = await tx.select({ id: schema.priceBookCategory.id }).from(schema.priceBookCategory)
        .where(and(eq(schema.priceBookCategory.id, input.categoryId), isNull(schema.priceBookCategory.deletedAt)))
        .limit(1);
      if (!shelf) throw new NotFoundError("Category");
    }

    const result = await planWithin(tx, ctx, input);
    const skip = new Set(input.skipLines ?? []);

    /**
     * THE VENDORS THE FILE NAMES THAT ARE NOT SET UP, when the person asked
     * for them to be added: one per name, under the spelling of the first
     * line, and only a vendor at least one ticked row is for, so unticking a
     * vendor's rows does not leave an empty supplier behind.
     */
    const vendorIds = new Map<string, string>();
    let vendorsAdded = 0;
    for (const wanted of result.newVendors) {
      const ticked = result.rows.some((r) => r.action !== "skip" && r.newVendor && !skip.has(r.line)
        && r.vendorName.toLowerCase() === wanted.name.toLowerCase());
      if (!ticked) continue;
      const [vendor] = await refusingDuplicate(
        "vendor_name_idx",
        `${wanted.name} was added as a vendor while this file was being read. Preview it again.`,
        () => tx.insert(schema.vendor).values({ organizationId: ctx.actor.organizationId, name: wanted.name }).returning(),
      );
      await audit(tx, ctx, "vendor.created", "vendor", vendor!.id, null, { ...vendor!, from: "catalogue import", line: wanted.line });
      vendorIds.set(wanted.name.toLowerCase(), vendor!.id);
      vendorsAdded += 1;
    }
    /** The vendor a row is for: its own id, or the one just added for its name. */
    const vendorOf = (row: { vendorId: string | null; vendorName: string }): string | null =>
      row.vendorId ?? vendorIds.get(row.vendorName.toLowerCase()) ?? null;
    /**
     * Pack, unit and breaks as the FILE stated them. A file with no pack
     * column says nothing about packs, so an existing link keeps its own.
     */
    const parsedOf = new Map(result.parsed.rows.map((r) => [r.line, r]));
    const packing = (row: { line: number; pack: string; unit: string | null; breaks: catalogue.PriceBreak[] }) => {
      const read = parsedOf.get(row.line);
      return {
        ...(read?.pack !== undefined ? { packQuantity: row.pack } : {}),
        ...(read?.unit !== undefined ? { purchaseUnit: row.unit } : {}),
        ...(read?.breaks !== undefined ? { priceBreaks: row.breaks } : {}),
      };
    };
    /** The same, for the link's second pack: its quantity and price always, unit and breaks as the file states them. */
    const secondPacking = (row: { line: number; pack: string; unit: string | null; breaks: catalogue.PriceBreak[]; cost: string; packSku: string | null }) => {
      const read = parsedOf.get(row.line);
      return {
        secondPackQuantity: row.pack,
        secondCost: row.cost,
        secondPartNumber: row.packSku,
        ...(read?.unit !== undefined ? { secondPurchaseUnit: row.unit } : {}),
        ...(read?.breaks !== undefined ? { secondPriceBreaks: row.breaks } : {}),
      };
    };
    const now = new Date();
    let created = 0;
    let linked = 0;
    let updated = 0;
    let itemCostsRevised = 0;

    const reviseCost = async (itemId: string, cost: string) => {
      const current = await load(tx, itemId);
      if (!current) return;
      /**
       * The file's cost is per one of OUR units, which an item bought by the
       * gallon and used by the ounce counts in ounces; its version keeps the
       * cost per gallon, so the each cost goes back up by the ratio.
       */
      await reviseWithin(tx, ctx, current, { cost: catalogue.costPerBuy(cost, unitsOf(current.version)) }, now);
      itemCostsRevised += 1;
    };

    for (const row of result.rows) {
      if (skip.has(row.line)) continue;
      if (row.action === "skip" || row.action === "unchanged") continue;
      const vendorId = vendorOf(row);
      /** A new vendor whose rows were all unticked was not added, so nothing of theirs is written. */
      if (!vendorId) continue;
      switch (row.action) {
        case "create": {
          const [item] = await tx.insert(schema.priceBookItem).values({
            organizationId: ctx.actor.organizationId,
            categoryId: input.categoryId ?? null,
            kind: "material",
            code: row.code,
          }).returning({ id: schema.priceBookItem.id });
          await tx.insert(schema.priceBookItemVersion).values({
            organizationId: ctx.actor.organizationId,
            itemId: item!.id,
            version: 1,
            name: row.name,
            price: row.price,
            /** Per each, as the price book counts: their box price over the box. */
            cost: row.eachCost,
            taxable: true,
            effectiveFrom: now,
          });
          await tx.insert(schema.vendorItem).values({
            organizationId: ctx.actor.organizationId,
            vendorId,
            itemId: item!.id,
            partNumber: row.sku.trim(),
            description: row.name,
            cost: row.cost,
            costUpdatedAt: now,
            ...packing(row),
          });
          created += 1;
          break;
        }
        case "link": {
          await tx.insert(schema.vendorItem).values({
            organizationId: ctx.actor.organizationId,
            vendorId,
            itemId: row.itemId,
            partNumber: row.sku.trim(),
            description: result.parsed.rows.find((r) => r.line === row.line)?.description.trim() || null,
            cost: row.cost,
            costUpdatedAt: now,
            ...packing(row),
          });
          if (row.itemCostAfter !== null) await reviseCost(row.itemId, row.itemCostAfter);
          linked += 1;
          break;
        }
        case "update": {
          const description = result.parsed.rows.find((r) => r.line === row.line)?.description.trim();
          await tx.update(schema.vendorItem).set({
            partNumber: row.sku.trim(),
            ...(description ? { description } : {}),
            cost: row.cost,
            costUpdatedAt: now,
            ...packing(row),
            updatedAt: now,
          }).where(and(eq(schema.vendorItem.vendorId, vendorId), eq(schema.vendorItem.itemId, row.itemId)));
          if (row.itemCostAfter !== null) await reviseCost(row.itemId, row.itemCostAfter);
          updated += 1;
          break;
        }
        case "pack": {
          /**
           * The second way to buy it goes on the link the item already has
           * with this vendor, or the one an earlier line of this file just
           * made. Neither there (that line was unticked) is nothing to add
           * it to, and nothing is written.
           */
          const target = row.itemId
            ? and(eq(schema.vendorItem.vendorId, vendorId), eq(schema.vendorItem.itemId, row.itemId))
            : and(eq(schema.vendorItem.vendorId, vendorId), sql`lower(${schema.vendorItem.partNumber}) = ${row.sku.trim().toLowerCase()}`);
          const done = await refusingDuplicate(
            "vendor_item_part_number_idx",
            `${row.packSku ?? row.sku} is already this vendor's number for another of your items. Preview the file again.`,
            () => tx.update(schema.vendorItem)
              .set({ ...secondPacking(row), costUpdatedAt: now, updatedAt: now })
              .where(and(target, sql`${schema.vendorItem.packQuantity} <> ${row.pack}`))
              .returning({ id: schema.vendorItem.id }),
          );
          if (done.length > 0) updated += 1;
          break;
        }
      }
    }

    const answer: Applied = {
      problems: result.problems, rows: result.rows, counts: result.counts, newVendors: result.newVendors,
      created, linked, updated, itemCostsRevised, vendorsAdded,
    };
    await audit(tx, ctx, "vendor_catalogue.applied", input.vendorId ? "vendor" : "organization",
      input.vendorId ?? ctx.actor.organizationId, null, {
      created, linked, updated, itemCostsRevised, vendorsAdded,
      skipped: result.counts.skip + skip.size, problems: result.problems.length,
    });
    await once.remember(tx, ctx, "vendor_catalogue", null, answer);
    return answer;
  });
}

/* ------------------------------------------------- a purchase order line */

/**
 * Find the part a purchase order line names, for one vendor.
 *
 * By the vendor's own number first, because that is what is printed on their
 * catalogue and their invoices; then by our item code, which is what a
 * person in our office knows it by. Either way the line carries the item, the
 * vendor's number as it stands today, and their price when they have given
 * one.
 */
export async function resolvePart(
  tx: Database, vendorId: string, line: { itemId?: string | undefined; partNumber?: string | undefined },
): Promise<{
  itemId: string; partNumber: string | null; cost: string | null;
  /** How the vendor sells it: so many of ours in one of theirs, called what, and their breaks. */
  packQuantity: string; purchaseUnit: string | null; priceBreaks: catalogue.PriceBreak[];
  /** Every way they sell it: the first pack above, and the second when there is one, each with its own number when it has one. */
  packs: catalogue.Pack[];
  /**
   * The pack the number typed names, when it is the number of the second pack
   * (the box numbered apart from the each): how many of ours are in it. Null
   * when the number typed is the link's own, or the part was found another way.
   */
  namedPack: string | null;
}> {
  const packing = (link: typeof schema.vendorItem.$inferSelect | undefined, namedPack: string | null = null) => ({
    packQuantity: link?.packQuantity ?? "1",
    purchaseUnit: link?.purchaseUnit ?? null,
    priceBreaks: link?.priceBreaks ?? [],
    packs: link ? packsOf(link).map(({ second: _second, ...pack }) => pack) : [],
    namedPack,
  });
  const typed = line.partNumber?.trim() ?? "";
  const bySecond = (link: typeof schema.vendorItem.$inferSelect | undefined) =>
    link?.secondPartNumber && typed !== "" && link.secondPartNumber.toLowerCase() === typed.toLowerCase()
      ? link.secondPackQuantity : null;
  if (line.itemId) {
    const [link] = await tx.select().from(schema.vendorItem)
      .where(and(eq(schema.vendorItem.vendorId, vendorId), eq(schema.vendorItem.itemId, line.itemId))).limit(1);
    const named = bySecond(link);
    if (typed !== "" && link && link.partNumber.toLowerCase() !== typed.toLowerCase() && named === null) {
      throw new ConflictError(`${typed} is not this vendor's number for that item: they call it ${link.partNumber}${link.secondPartNumber ? `, or ${link.secondPartNumber} for the ${link.secondPurchaseUnit ?? "pack"} of ${Number(link.secondPackQuantity)}` : ""}.`);
    }
    return { itemId: line.itemId, partNumber: link?.partNumber ?? (typed === "" ? null : typed), cost: link?.cost ?? null, ...packing(link, named) };
  }
  if (typed === "") throw new ConflictError("Every line needs a part: our item, or the vendor's part number.");

  /** The vendor's number for either of its ways to sell the part, found the same way. */
  const [byPart] = await tx.select().from(schema.vendorItem)
    .where(and(
      eq(schema.vendorItem.vendorId, vendorId),
      sql`(lower(${schema.vendorItem.partNumber}) = ${typed.toLowerCase()} or lower(${schema.vendorItem.secondPartNumber}) = ${typed.toLowerCase()})`,
    ))
    .limit(1);
  if (byPart) return { itemId: byPart.itemId, partNumber: byPart.partNumber, cost: byPart.cost, ...packing(byPart, bySecond(byPart)) };

  const byCode = await tx.select({ id: schema.priceBookItem.id }).from(schema.priceBookItem)
    .where(and(isNull(schema.priceBookItem.deletedAt), sql`lower(${schema.priceBookItem.code}) = ${typed.toLowerCase()}`))
    .limit(2);
  if (byCode.length === 1) {
    const [link] = await tx.select().from(schema.vendorItem)
      .where(and(eq(schema.vendorItem.vendorId, vendorId), eq(schema.vendorItem.itemId, byCode[0]!.id))).limit(1);
    return { itemId: byCode[0]!.id, partNumber: link?.partNumber ?? null, cost: link?.cost ?? null, ...packing(link) };
  }
  throw new ConflictError(
    `Nothing answers to ${typed}: it is not this vendor's part number for any item, and not one of your item codes. `
    + "Add their number to the item, or import their catalogue.",
  );
}

export const handlers = {
  listVendorItems: async (ctx: ServiceContext, input: { itemId?: string | undefined; vendorId?: string | undefined }) =>
    ({ links: await links(ctx, input) }),
  setVendorItem: (ctx: ServiceContext, input: {
    vendorId: string; itemId: string; partNumber: string;
    description?: string | null | undefined; cost?: string | null | undefined;
    packQuantity?: string | null | undefined; purchaseUnit?: string | null | undefined;
    priceBreaks?: readonly { minimum: string; cost: string }[] | null | undefined;
    secondPack?: {
      packQuantity: string; purchaseUnit?: string | null | undefined; cost?: string | null | undefined;
      priceBreaks?: readonly { minimum: string; cost: string }[] | null | undefined;
      partNumber?: string | null | undefined;
    } | null | undefined;
  }) => setLink(ctx, input),
  removeVendorItem: (ctx: ServiceContext, input: { id: string }) => removeLink(ctx, input),
  previewVendorCatalogue: (ctx: ServiceContext, input: CatalogueInput) => preview(ctx, input),
  applyVendorCatalogue: (ctx: ServiceContext, input: CatalogueInput & { skipLines?: number[] | undefined }) =>
    apply(ctx, input),
} as const;
