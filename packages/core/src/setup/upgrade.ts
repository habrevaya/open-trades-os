import { money } from "../money/index.js";

/**
 * A NEWER TRADE PACK OVER A COMPANY RUNNING ON AN OLDER ONE
 *
 * A pack ships a price book at national averages, and the first thing a
 * company does with it (the wizard asks them to) is change it. So by the
 * time version two of a pack ships, most companies' price books are part
 * pack and part their own, and an upgrade that cannot tell the two apart
 * has exactly two possible behaviours, both wrong: overwrite everything,
 * which puts the national average back over a price the owner set for their
 * market, or touch nothing, which means a pack fix (a mistyped labour time,
 * a tax class the author got wrong) never reaches anybody.
 *
 * THE RULE: an item is the pack's to update only while it still says what
 * the pack seeded. The moment anybody here changed it, by any route, it is
 * theirs and the upgrade leaves it alone and says what it would have
 * changed. An item the company made itself, or another pack made, with the
 * same code, is theirs too. Nothing is ever deleted: an item the new
 * version dropped is reported and kept, because invoices point at it and
 * the company may well still sell it.
 *
 * HOW "STILL SAYS WHAT THE PACK SEEDED" IS DECIDED. Against the snapshot the
 * service stored when the company's current version was applied, field by
 * field, which catches an edit however it was made (one revision, a bulk
 * re-price, an import). A company that applied its pack before snapshots
 * were stored has no snapshot, and there the item's version number answers
 * it: the seed wrote version one, so an item still on version one has never
 * been revised. That is the weaker test (a revision back to the same price
 * reads as an edit) and it fails in the safe direction, keeping the item.
 *
 * Pure, so every one of those cases is a unit test rather than a fixture.
 */

/** The fields a pack seeds onto an item's version, and the only ones compared. */
export interface SeedFields {
  name: string;
  description: string | null;
  price: string;
  cost: string | null;
  laborMinutes: number | null;
  taxable: boolean;
  taxClass: string | null;
  warrantyMonths: number | null;
}

export const SEED_FIELDS = [
  "name", "description", "price", "cost", "laborMinutes", "taxable", "taxClass", "warrantyMonths",
] as const satisfies readonly (keyof SeedFields)[];

export interface PackSeedItem extends SeedFields {
  code: string;
  kind: string;
  category: string;
}

export interface CompanyItem {
  itemId: string;
  code: string;
  /** `hvac@1` when a pack made it, null when somebody here did. */
  tradePackId: string | null;
  /** The version in force now. */
  version: number;
  current: SeedFields;
}

export interface UpgradeInput {
  packId: string;
  toVersion: number;
  /** The version the company is on, or null when it never applied this pack. */
  fromVersion: number | null;
  /** What `fromVersion` seeded, by code. Null when it predates snapshots. */
  baseline: Readonly<Record<string, SeedFields>> | null;
  company: readonly CompanyItem[];
  pack: readonly PackSeedItem[];
  companyJobTypeCodes: readonly string[];
  packJobTypes: readonly { code: string; name: string }[];
}

export interface FieldChange {
  field: keyof SeedFields;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
}

export interface UpgradePlan {
  packId: string;
  fromVersion: number | null;
  toVersion: number;
  /** Already on this version or a newer one: there is nothing to apply. */
  upToDate: boolean;
  /** New to this company. */
  add: PackSeedItem[];
  /** Still exactly as the pack seeded them, so they take the new values. */
  update: { itemId: string; code: string; name: string; changes: FieldChange[] }[];
  /**
   * The pack changed these and the company owns them, so nothing happens.
   * `edited`: somebody here changed it after the pack seeded it.
   * `yours`: the company (or another pack) made an item with this code.
   */
  kept: { itemId: string; code: string; name: string; reason: "edited" | "yours"; changes: FieldChange[] }[];
  /** Already what the new version says. */
  unchanged: number;
  /** In the old version and not the new one. Left exactly as they are. */
  dropped: { itemId: string; code: string; name: string }[];
  jobTypes: { add: { code: string; name: string }[]; present: number };
}

/** `hvac@3` is version three of hvac. Anything else is not this pack. */
export function taggedVersion(tag: string | null, packId: string): number | null {
  if (!tag) return null;
  const match = /^(.+)@(\d+)$/.exec(tag);
  if (!match || match[1] !== packId) return null;
  return Number(match[2]);
}

function same(field: keyof SeedFields, a: unknown, b: unknown): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return left === right;
  /**
   * Money compared as money. The database hands back `189.0000` for a pack
   * that wrote `189`, and comparing the strings would call every price in
   * the book edited.
   */
  if (field === "price" || field === "cost") {
    return money(String(left)).amount === money(String(right)).amount;
  }
  return left === right;
}

/** What would change, going from `from` to `to`, field by field. */
export function differences(from: SeedFields, to: SeedFields): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of SEED_FIELDS) {
    if (!same(field, from[field], to[field])) {
      out.push({ field, from: from[field] ?? null, to: to[field] ?? null });
    }
  }
  return out;
}

export function planUpgrade(input: UpgradeInput): UpgradePlan {
  const byCode = new Map(input.company.map((item) => [item.code, item]));
  const packCodes = new Set(input.pack.map((item) => item.code));

  const plan: UpgradePlan = {
    packId: input.packId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    upToDate: input.fromVersion !== null && input.fromVersion >= input.toVersion,
    add: [],
    update: [],
    kept: [],
    unchanged: 0,
    dropped: [],
    jobTypes: { add: [], present: 0 },
  };

  for (const seed of input.pack) {
    const item = byCode.get(seed.code);
    if (!item) {
      plan.add.push(seed);
      continue;
    }

    const changes = differences(item.current, seed);
    if (changes.length === 0) {
      plan.unchanged += 1;
      continue;
    }

    const name = item.current.name;
    if (taggedVersion(item.tradePackId, input.packId) === null) {
      plan.kept.push({ itemId: item.itemId, code: item.code, name, reason: "yours", changes });
      continue;
    }

    const seeded = input.baseline?.[item.code];
    const edited = seeded
      ? differences(item.current, seeded).length > 0
      : item.version > 1;
    if (edited) {
      plan.kept.push({ itemId: item.itemId, code: item.code, name, reason: "edited", changes });
    } else {
      plan.update.push({ itemId: item.itemId, code: item.code, name, changes });
    }
  }

  for (const item of input.company) {
    if (packCodes.has(item.code)) continue;
    if (taggedVersion(item.tradePackId, input.packId) === null) continue;
    plan.dropped.push({ itemId: item.itemId, code: item.code, name: item.current.name });
  }

  const have = new Set(input.companyJobTypeCodes);
  for (const type of input.packJobTypes) {
    if (have.has(type.code)) plan.jobTypes.present += 1;
    else plan.jobTypes.add.push({ code: type.code, name: type.name });
  }

  return plan;
}

/** Whether applying the plan would change anything at all. */
export const planChangesSomething = (plan: UpgradePlan): boolean =>
  plan.add.length > 0 || plan.update.length > 0 || plan.jobTypes.add.length > 0;

/** A field's name as an owner would say it. */
export const FIELD_LABELS: Record<keyof SeedFields, string> = {
  name: "Name",
  description: "Description",
  price: "Price",
  cost: "Cost",
  laborMinutes: "Labour minutes",
  taxable: "Taxable",
  taxClass: "Tax class",
  warrantyMonths: "Warranty months",
};
