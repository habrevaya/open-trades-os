import { money, toString, compare, divide, multiply, type Money } from "../money/index.js";
import { reprice, checkRule } from "../repricing/index.js";

/**
 * A SUPPLIER'S CATALOGUE, BROUGHT IN AS A FILE
 *
 * Every supply house will send a contractor a spreadsheet of what they stock
 * and what they charge, and the price book was the one place that file could
 * not go. So costs went stale the week they were typed, a purchase order line
 * was typed from memory, and the vendor's part number lived on a sticky note
 * at the counter.
 *
 * This is the reading and the deciding, with no database in it, so the
 * preview a person reads and the writes that follow are worked out by the same
 * function from the same rows. The service hands it what exists, it hands back
 * what each row would do, and the service writes exactly that, recomputed
 * inside the write rather than trusted from a preview that may be a minute
 * old.
 *
 * A ROW IS SKIPPED WITH A REASON, NEVER GUESSED. A cost that is not a number
 * is not imported as nothing, a vendor nobody has heard of is not invented,
 * and a part number that matches two of our items is not given to either.
 * Each of those is a line on the preview saying why, and the rest of the file
 * still goes in.
 */

export interface CatalogueRow {
  /** The line in the file, counting the header as line one, so a person can find it. */
  line: number;
  sku: string;
  description: string;
  cost: string;
  /** As written in the file. Empty when the file has no vendor column. */
  vendor: string;
  /**
   * How many of our units are in one of theirs, when the file says: 25 for a
   * box of 25. The cost is then THEIR price for the box. Absent means one.
   */
  pack?: string | undefined;
  /** What they call their unit: "box", "case". Absent when the file has no such column. */
  unit?: string | undefined;
  /** Their price for one pack when buying at least so many packs, lowest first. */
  breaks?: PriceBreak[] | undefined;
}

/** Their price for one of THEIR units when ordering at least `minimum` of them. */
export interface PriceBreak {
  minimum: string;
  cost: string;
}

export interface CatalogueProblem {
  line: number;
  message: string;
}

/** A file larger than this is several files. Two thousand is a big supply house's whole HVAC section. */
export const MAX_ROWS = 5000;

/**
 * The headers, and every spelling the supply houses use.
 *
 * Matched with case and punctuation stripped, because "Part #", "PART_NO"
 * and "Part Number" are the same column from three suppliers and a contractor
 * should not have to rename headers before every import.
 */
const COLUMNS: Record<"sku" | "description" | "cost" | "vendor", string[]> = {
  sku: ["sku", "vendorsku", "partnumber", "partno", "part", "itemnumber", "itemno", "catalognumber", "catalogno", "productcode", "mfrpartnumber"],
  description: ["description", "desc", "itemdescription", "productdescription", "name", "itemname", "productname"],
  cost: ["cost", "unitcost", "price", "unitprice", "netprice", "yourprice", "netcost", "dealercost"],
  vendor: ["vendor", "vendorname", "supplier", "suppliername", "distributor"],
};

/**
 * Pack size and unit of measure, which most supply houses print and many
 * call something different. "Pack Qty", "Case Quantity" and "Units per Case"
 * are one column.
 */
const PACK = ["pack", "packqty", "packquantity", "packsize", "qtyperpack", "perpack", "casequantity", "caseqty", "casepack", "unitsperpack", "unitspercase", "qtypercase"];
const UNIT = ["uom", "unit", "unitofmeasure", "sellunit", "purchaseunit", "packunit", "sellinguom"];

/**
 * A price break column pair: the quantity and the price of break N, in the
 * spellings the supply houses export. "Break 1 Qty" and "Break 1 Price",
 * "Qty Break 1" and "Price Break 1", "Tier 1 Min" and "Tier 1 Price".
 */
const BREAK_QUANTITY = /^(?:break(\d)(?:qty|quantity|min|minimum)|qtybreak(\d)|breakqty(\d)|tier(\d)(?:qty|quantity|min|minimum)|minqty(\d))$/;
const BREAK_PRICE = /^(?:break(\d)(?:price|cost)|pricebreak(\d)|breakprice(\d)|tier(\d)(?:price|cost))$/;
const breakNumber = (match: RegExpMatchArray | null): number | null => {
  const digit = match?.slice(1).find((g) => g !== undefined);
  return digit === undefined ? null : Number(digit);
};

const normaliseHeader = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A pack or break quantity: a positive whole or decimal number. "25", "12.5".
 * Nothing else, for the reason `parseCost` refuses what it cannot read.
 */
export function parsePack(raw: string): string | null {
  const text = raw.trim().replace(/,(?=\d{3}\b)/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(text)) return null;
  if (Number(text) <= 0) return null;
  return text;
}

/**
 * What one of OUR units costs when a vendor sells packs: their price for the
 * pack over how many are in it, at four places. This is the only division
 * in the import and it is the price book's, which counts each: the vendor's
 * own price for the pack is kept exactly as they printed it.
 */
export function eachCost(packCost: string, pack: string | null | undefined): string {
  if (!pack || compare(money(pack), money("1")) === 0) return toString(money(packCost));
  return toString(divide(money(packCost), pack));
}

/**
 * Check a break table: minimums of at least one pack, each once, put in
 * order. Returns the sentence to show when it cannot be used.
 */
export function checkBreaks(breaks: readonly PriceBreak[]): { ok: true; breaks: PriceBreak[] } | { ok: false; message: string } {
  const out: PriceBreak[] = [];
  for (const entry of breaks) {
    const minimum = parsePack(entry.minimum);
    const cost = parseCost(entry.cost);
    if (minimum === null || compare(money(minimum), money("1")) < 0) {
      return { ok: false, message: `A price break starts at "${entry.minimum}", which is not a number of packs of at least one.` };
    }
    if (cost === null) return { ok: false, message: `A price break of "${entry.cost}" is not an amount.` };
    if (out.some((b) => compare(money(b.minimum), money(minimum)) === 0)) {
      return { ok: false, message: `Two price breaks start at ${minimum}. Each quantity has one price.` };
    }
    out.push({ minimum: toString(money(minimum)), cost: toString(money(cost)) });
  }
  return { ok: true, breaks: out.sort((a, b) => compare(money(a.minimum), money(b.minimum))) };
}

/**
 * THE PRICE FOR AN ORDER OF SO MANY PACKS: the break with the highest
 * minimum the order reaches, else the base price. Per pack, as the vendor
 * quotes it.
 */
export function packPriceFor(base: string, breaks: readonly PriceBreak[], packs: string): { cost: string; breakMinimum: string | null } {
  let best: PriceBreak | null = null;
  for (const entry of breaks) {
    if (compare(money(packs), money(entry.minimum)) >= 0
      && (best === null || compare(money(entry.minimum), money(best.minimum)) > 0)) best = entry;
  }
  return best ? { cost: toString(money(best.cost)), breakMinimum: best.minimum } : { cost: toString(money(base)), breakMinimum: null };
}

/**
 * Whether a quantity of OUR units is a whole number of the vendor's packs,
 * and how many packs. A vendor selling by the box of 25 cannot be sent an
 * order for 30, and rounding it up quietly would spend money nobody chose
 * to: the order is refused in words with the two quantities that would go.
 */
export function packsIn(quantity: string, pack: string): { ok: true; packs: string } | { ok: false; below: string; above: string } {
  const q = money(quantity);
  const p = money(pack);
  if (p.amount <= 0n) return { ok: false, below: "0", above: "0" };
  const whole = q.amount / p.amount;
  if (whole * p.amount === q.amount) return { ok: true, packs: whole.toString() };
  const label = (m: Money) => toString(m).replace(/\.?0+$/, "");
  return {
    ok: false,
    below: label({ amount: whole * p.amount, currency: q.currency }),
    above: label({ amount: (whole + 1n) * p.amount, currency: q.currency }),
  };
}

/** A pack's price times a number of packs, exactly: what a line costs when priced by the pack. */
export const packTotal = (packCost: string, packs: string): string => toString(multiply(money(packCost), packs));

/**
 * Every record in the file, respecting quotes, including a quoted field that
 * runs over a line break.
 *
 * Supplier descriptions are full of commas ("Capacitor, dual run, 45/5 MFD")
 * and a few carry a line break inside quotes. Splitting on commas and new
 * lines turns either into a silent column shift where a description lands in
 * the cost, which imports a wrong number rather than failing.
 */
export function splitRecords(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let current = "";
  let quoted = false;
  let line = 1;
  let startedOn = 1;
  const source = text.replace(/^﻿/, "");

  const endRecord = () => {
    cells.push(current.trim());
    if (cells.some((cell) => cell !== "")) out.push({ line: startedOn, cells });
    cells = [];
    current = "";
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { current += '"'; i += 1; } else { quoted = false; }
      } else {
        if (char === "\n") line += 1;
        current += char;
      }
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { cells.push(current.trim()); current = ""; continue; }
    if (char === "\r") continue;
    if (char === "\n") {
      endRecord();
      line += 1;
      startedOn = line;
      continue;
    }
    current += char;
  }
  endRecord();
  return out;
}

/**
 * An amount from whatever the catalogue wrote: "$12.50", "1,234.5", "12".
 *
 * Refuses anything else rather than reading it as nought, because a cost of
 * nothing is the one figure in a margin report nobody questions. "1.234,56"
 * is refused for the same reason the spend importer refuses it: it is a
 * thousand in one country and one in another.
 */
export function parseCost(raw: string): string | null {
  const text = raw.trim().replace(/^\$\s*/, "").replace(/,(?=\d{3}\b)/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(text)) return null;
  return text;
}

export interface ParsedCatalogue {
  rows: CatalogueRow[];
  problems: CatalogueProblem[];
  /** Whether the file named a vendor on each row, or the import has to be told one. */
  hasVendorColumn: boolean;
}

/** Read the file into rows, with a sentence for anything that is not one. */
export function parseCatalogue(text: string): ParsedCatalogue {
  const records = splitRecords(text);
  const header = records[0];
  if (!header) {
    return { rows: [], problems: [{ line: 1, message: "The file is empty." }], hasVendorColumn: false };
  }

  const names = header.cells.map(normaliseHeader);
  const find = (column: keyof typeof COLUMNS) => names.findIndex((name) => COLUMNS[column].includes(name));
  const at = { sku: find("sku"), description: find("description"), cost: find("cost"), vendor: find("vendor") };
  const packAt = names.findIndex((name) => PACK.includes(name));
  const unitAt = names.findIndex((name) => UNIT.includes(name));
  /** Break N's quantity column and price column, paired by N. A half pair is ignored and said. */
  const breakColumns = new Map<number, { quantity?: number; price?: number }>();
  names.forEach((name, index) => {
    const q = breakNumber(name.match(BREAK_QUANTITY));
    const p = breakNumber(name.match(BREAK_PRICE));
    if (q !== null) breakColumns.set(q, { ...breakColumns.get(q), quantity: index });
    if (p !== null) breakColumns.set(p, { ...breakColumns.get(p), price: index });
  });
  const breakPairs = [...breakColumns.entries()].sort(([a], [b]) => a - b)
    .filter(([, c]) => c.quantity !== undefined && c.price !== undefined) as [number, { quantity: number; price: number }][];

  const missing = (["sku", "cost"] as const).filter((column) => at[column] < 0);
  if (missing.length > 0) {
    return {
      rows: [],
      problems: [{
        line: header.line,
        message: `The first line has to name the columns, and there is no ${missing.join(" or ")} column. `
          + "Expected headers like sku, description, cost and vendor.",
      }],
      hasVendorColumn: at.vendor >= 0,
    };
  }

  const body = records.slice(1);
  if (body.length > MAX_ROWS) {
    return {
      rows: [],
      problems: [{ line: header.line, message: `The file has ${body.length} rows. Import at most ${MAX_ROWS} at a time.` }],
      hasVendorColumn: at.vendor >= 0,
    };
  }

  const cell = (cells: string[], index: number) => (index >= 0 ? (cells[index] ?? "").trim() : "");
  const rows: CatalogueRow[] = [];
  const problems: CatalogueProblem[] = [];
  for (const record of body) {
    const sku = cell(record.cells, at.sku);
    const rawCost = cell(record.cells, at.cost);
    /** The totals row some exports end with: no part number, a number in the cost. */
    if (sku === "") {
      problems.push({ line: record.line, message: "No part number, so there is nothing to match it to." });
      continue;
    }
    const cost = parseCost(rawCost);
    if (cost === null) {
      problems.push({
        line: record.line,
        message: rawCost === ""
          ? `${sku} has no cost.`
          : `${sku} has a cost of "${rawCost}", which is not an amount.`,
      });
      continue;
    }
    const extra: Pick<CatalogueRow, "pack" | "unit" | "breaks"> = {};
    if (packAt >= 0) {
      const rawPack = cell(record.cells, packAt);
      const pack = rawPack === "" ? "1" : parsePack(rawPack);
      if (pack === null) {
        problems.push({ line: record.line, message: `${sku} comes in packs of "${rawPack}", which is not a number of our units.` });
        continue;
      }
      extra.pack = pack;
    }
    if (unitAt >= 0) extra.unit = cell(record.cells, unitAt);
    if (breakPairs.length > 0) {
      const stated = breakPairs
        .map(([, c]) => ({ minimum: cell(record.cells, c.quantity), cost: cell(record.cells, c.price) }))
        .filter((b) => b.minimum !== "" || b.cost !== "");
      const checked = checkBreaks(stated);
      if (!checked.ok) {
        problems.push({ line: record.line, message: `${sku}: ${checked.message}` });
        continue;
      }
      extra.breaks = checked.breaks;
    }
    rows.push({
      line: record.line,
      sku,
      description: cell(record.cells, at.description),
      cost,
      vendor: cell(record.cells, at.vendor),
      ...extra,
    });
  }
  return { rows, problems, hasVendorColumn: at.vendor >= 0 };
}

/* ------------------------------------------------------------- deciding */

export interface KnownVendor { id: string; name: string }
export interface KnownLink {
  vendorId: string;
  itemId: string;
  partNumber: string;
  cost: string | null;
  description: string | null;
  /** How many of ours in one of theirs. Absent is one. */
  packQuantity?: string | undefined;
  purchaseUnit?: string | null | undefined;
  priceBreaks?: readonly PriceBreak[] | undefined;
}
export interface KnownItem {
  id: string;
  code: string;
  name: string;
  /** The item's own cost, from the version in force. Null when none is recorded. */
  cost: string | null;
  /**
   * A price change is already scheduled for it. Its cost is then left alone,
   * as the bulk price change leaves it alone: a version written now would sit
   * in front of the scheduled one and either collide with it or quietly undo
   * it on the day it was meant to take effect.
   */
  scheduled?: boolean | undefined;
}

export interface CatalogueState {
  vendors: readonly KnownVendor[];
  links: readonly KnownLink[];
  /** Every item the rows could name: matched by code, or behind an existing link. */
  items: readonly KnownItem[];
}

export interface PlanOptions {
  /** The vendor for rows that do not name one, or for a file with no vendor column. */
  defaultVendorId?: string | null | undefined;
  /**
   * The margin a new item is priced at over its cost, as a fraction: 0.45.
   * Without one, a row that would create an item is skipped rather than
   * created at its cost, because an item sold at cost is a job done for free
   * and nobody notices until the margin report.
   */
  margin?: string | null | undefined;
  /** Round a new item's price up to this ending, like the bulk price change does. */
  ending?: string | null | undefined;
  /** Whether the item's own cost (the one job costing reads) follows the vendor's. */
  updateItemCost: boolean;
}

interface Common {
  line: number;
  sku: string;
  vendorId: string;
  vendorName: string;
  /**
   * How they sell it: so many of ours to a pack, what they call the pack, and
   * their breaks. `cost` is their price for one pack, and `eachCost` is what
   * one of ours comes to, which is what the price book's cost is compared
   * with and set to.
   */
  pack: string;
  unit: string | null;
  breaks: PriceBreak[];
  eachCost: string;
}

export type RowPlan =
  /**
   * A new item, and its link to this vendor. `cost` is their price for a
   * pack; the item is costed at `eachCost` and priced from it.
   */
  | Common & { action: "create"; code: string; name: string; cost: string; price: string }
  /** One of our items already had this code; it gains this vendor's part number and cost. */
  | Common & {
    action: "link"; itemId: string; itemCode: string; itemName: string; cost: string;
    itemCostBefore: string | null; itemCostAfter: string | null; costHeldBack: boolean;
  }
  /** The vendor's link already existed; its cost, description or number changes. */
  | Common & {
    action: "update"; itemId: string; itemCode: string; itemName: string;
    partNumberBefore: string; costBefore: string | null; cost: string;
    itemCostBefore: string | null; itemCostAfter: string | null;
    /** The item's cost would have followed, and a scheduled price change is in the way. */
    costHeldBack: boolean;
  }
  /** Already exactly this. */
  | Common & { action: "unchanged"; itemId: string; itemCode: string; itemName: string; cost: string }
  | { action: "skip"; line: number; sku: string; reason: string };

export interface CataloguePlan {
  rows: RowPlan[];
  counts: Record<RowPlan["action"], number>;
}

const same = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : compare(money(a), money(b)) === 0;

const sameBreaks = (a: readonly PriceBreak[], b: readonly PriceBreak[]): boolean =>
  a.length === b.length && a.every((x, i) => same(x.minimum, b[i]!.minimum) && same(x.cost, b[i]!.cost));

/** Four places, no trailing noise: "12.5" and "12.5000" are one cost. */
const tidy = (value: string): string => toString(money(value));

/**
 * What each row would do, in the file's order.
 *
 * A row is matched in this order, and the first that holds wins:
 *
 *   the vendor's own part number, through a link that already exists, which
 *   is an update to that link;
 *
 *   our item code equal to the part number, compared without capitals, which
 *   links that item to this vendor (and renumbers the link if the item was
 *   already linked to this vendor under an old number, which is a supplier
 *   changing its SKU);
 *
 *   nothing, which creates the item with the part number as its code.
 */
export function planCatalogue(
  rows: readonly CatalogueRow[], state: CatalogueState, options: PlanOptions,
): CataloguePlan {
  const vendorByName = new Map(state.vendors.map((v) => [v.name.trim().toLowerCase(), v]));
  const vendorById = new Map(state.vendors.map((v) => [v.id, v]));
  const itemById = new Map(state.items.map((i) => [i.id, i]));
  const itemsByCode = new Map<string, KnownItem[]>();
  for (const item of state.items) {
    const key = item.code.trim().toLowerCase();
    itemsByCode.set(key, [...(itemsByCode.get(key) ?? []), item]);
  }
  const linkByPart = new Map(state.links.map((l) => [`${l.vendorId}:${l.partNumber.trim().toLowerCase()}`, l]));
  const linkByItem = new Map(state.links.map((l) => [`${l.vendorId}:${l.itemId}`, l]));

  const marginRule = options.margin
    ? { adjust: { kind: "margin" as const, margin: options.margin }, ...(options.ending ? { ending: options.ending } : {}) }
    : null;
  const marginProblem = marginRule && !checkRule(marginRule).ok
    ? (checkRule(marginRule) as { ok: false; message: string }).message
    : null;

  /** A file naming one part twice for one vendor sets it once; the second is said, not silently last wins. */
  const seen = new Map<string, number>();
  /** Codes a create in this same file has already taken. */
  const createdCodes = new Set<string>();
  /** Items this same file has already linked to a vendor, so two rows cannot both claim one. */
  const claimedItems = new Map<string, number>();

  const out: RowPlan[] = rows.map((row): RowPlan => {
    const skip = (reason: string): RowPlan => ({ action: "skip", line: row.line, sku: row.sku, reason });

    const vendor = row.vendor.trim() !== ""
      ? vendorByName.get(row.vendor.trim().toLowerCase())
      : options.defaultVendorId ? vendorById.get(options.defaultVendorId) : undefined;
    if (!vendor) {
      return skip(row.vendor.trim() !== ""
        ? `There is no vendor called "${row.vendor.trim()}". Add them under Purchasing first, with that exact name.`
        : "The row names no vendor. Choose which vendor this file is from.");
    }

    const key = `${vendor.id}:${row.sku.trim().toLowerCase()}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      return skip(`${row.sku} for ${vendor.name} is already on line ${earlier} of this file.`);
    }
    seen.set(key, row.line);

    const cost = tidy(row.cost);
    /**
     * A file with no pack column says nothing about packs, so the link this
     * row will update keeps its own: a box of 25 imported once and then
     * re-priced from a file without the column is still a box of 25.
     */
    const codeMatches = itemsByCode.get(row.sku.trim().toLowerCase()) ?? [];
    const existing = linkByPart.get(key)
      ?? (codeMatches.length === 1 ? linkByItem.get(`${vendor.id}:${codeMatches[0]!.id}`) : undefined);
    const pack = tidy(row.pack ?? existing?.packQuantity ?? "1");
    const each = eachCost(cost, pack);
    const unitStated = row.unit !== undefined ? row.unit : existing?.purchaseUnit ?? null;
    const common = {
      line: row.line, sku: row.sku, vendorId: vendor.id, vendorName: vendor.name,
      pack, unit: unitStated?.trim() ? unitStated.trim() : null,
      breaks: row.breaks ?? [...(existing?.priceBreaks ?? [])], eachCost: each,
    };
    /**
     * The item's own cost is per EACH, because the price book counts each:
     * a box of 25 at 112.50 sets an item's cost to 4.50, never to 112.50,
     * which would make every job that used one look 25 times as expensive.
     */
    const wantsCost = (item: KnownItem): boolean => options.updateItemCost && !same(item.cost, each);
    const itemCost = (item: KnownItem) => ({
      itemCostBefore: item.cost,
      itemCostAfter: wantsCost(item) && item.scheduled !== true ? each : null,
      costHeldBack: wantsCost(item) && item.scheduled === true,
    });

    const claim = (itemId: string): RowPlan | null => {
      const claimant = claimedItems.get(`${vendor.id}:${itemId}`);
      if (claimant !== undefined) {
        return skip(`Line ${claimant} already gives ${vendor.name}'s number for that item.`);
      }
      claimedItems.set(`${vendor.id}:${itemId}`, row.line);
      return null;
    };

    const link = linkByPart.get(key);
    if (link) {
      const item = itemById.get(link.itemId);
      if (!item) return skip(`${row.sku} is linked to an item that no longer exists.`);
      const refused = claim(item.id);
      if (refused) return refused;
      const description = row.description.trim() === "" ? link.description : row.description.trim();
      const costs = itemCost(item);
      /**
       * A file with no pack or break columns says nothing about them, so it
       * leaves what the link already has; a file with them states them.
       */
      const packSame = row.pack === undefined || same(link.packQuantity ?? "1", pack);
      const unitSame = row.unit === undefined || (link.purchaseUnit ?? null) === common.unit;
      const breaksSame = row.breaks === undefined || sameBreaks(link.priceBreaks ?? [], common.breaks);
      if (same(link.cost, cost) && description === link.description && link.partNumber === row.sku.trim()
        && packSame && unitSame && breaksSame
        && costs.itemCostAfter === null && !costs.costHeldBack) {
        return { ...common, action: "unchanged", itemId: item.id, itemCode: item.code, itemName: item.name, cost };
      }
      return {
        ...common, action: "update", itemId: item.id, itemCode: item.code, itemName: item.name,
        partNumberBefore: link.partNumber, costBefore: link.cost, cost, ...costs,
      };
    }

    const byCode = itemsByCode.get(row.sku.trim().toLowerCase()) ?? [];
    if (byCode.length > 1) {
      return skip(`${byCode.length} items have the code ${row.sku} apart from capitals, so it is not clear which one this is.`);
    }
    const item = byCode[0];
    if (item) {
      const refused = claim(item.id);
      if (refused) return refused;
      const existing = linkByItem.get(`${vendor.id}:${item.id}`);
      if (existing) {
        /** The supplier renumbered the part: same item, same vendor, a new SKU. */
        return {
          ...common, action: "update", itemId: item.id, itemCode: item.code, itemName: item.name,
          partNumberBefore: existing.partNumber, costBefore: existing.cost, cost, ...itemCost(item),
        };
      }
      return {
        ...common, action: "link", itemId: item.id, itemCode: item.code, itemName: item.name, cost,
        ...itemCost(item),
      };
    }

    if (row.description.trim() === "") {
      return skip(`${row.sku} is not in the price book and has no description to create it with.`);
    }
    if (createdCodes.has(row.sku.trim().toLowerCase())) {
      return skip(`${row.sku} is created by an earlier line of this file for another vendor. Import the second vendor's file after this one to link it.`);
    }
    if (!marginRule) {
      return skip(`${row.sku} is new. Give a margin to price new items at, or add it to the price book first.`);
    }
    if (marginProblem) return skip(marginProblem);
    const priced = reprice({ price: "0", cost: each }, marginRule);
    if (!priced.changed) return skip(`${row.sku} could not be priced: ${priced.message}`);
    createdCodes.add(row.sku.trim().toLowerCase());
    const refused = claim(`new:${row.sku.trim().toLowerCase()}`);
    if (refused) return refused;
    return {
      ...common, action: "create", code: row.sku.trim(), name: row.description.trim(),
      cost, price: priced.price,
    };
  });

  const counts: CataloguePlan["counts"] = { create: 0, link: 0, update: 0, unchanged: 0, skip: 0 };
  for (const row of out) counts[row.action] += 1;
  return { rows: out, counts };
}
