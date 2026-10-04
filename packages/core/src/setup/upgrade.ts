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
  /** The rest of what a pack sets up. Absent when only the price book is being planned. */
  setup?: SetupUpgradeInput | undefined;
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
  /** The service report template, inspection programmes, retention rules and portal layout. */
  setup: SetupPlan;
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
    setup: input.setup ? planSetupUpgrade(input.setup) : { add: [], update: [], kept: [], unchanged: 0, dropped: [] },
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
  plan.add.length > 0 || plan.update.length > 0 || plan.jobTypes.add.length > 0
  || plan.setup.add.length > 0 || plan.setup.update.length > 0;

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

/* ------------------------------------------------- the rest of the pack */

/**
 * THE REST OF WHAT A PACK SETS UP, UNDER THE SAME RULE
 *
 * A pack seeds more than a price book: a service report template from its
 * readings, its inspection programmes, retention rules and a portal layout.
 * A newer version can fix any of them (a reading's range, a checkpoint the
 * standard added, a retention period the regulation changed), and the rule
 * is the price book's: a row is the pack's to update only while it still
 * says what the pack set up, and the moment anybody here changed it, it is
 * theirs and the upgrade says what it would have changed and leaves it.
 *
 * Each piece is compared as a whole, by its content: a template's name and
 * readings, a programme's name, standard, audience, frequency and
 * checkpoints, a rule's entity, clock, months and basis, a layout's name and
 * blocks. What only the company decides (whether a rule may purge, whether
 * a template or a rule is in force, which layout is the default) is not
 * content, is never compared and never touched.
 *
 * TWO MORE WAYS A PIECE IS THEIRS than an item has. A piece the pack set up
 * and the company removed stays removed: the record of what was set up says
 * it was there, and putting it back would be undoing a decision. And a
 * retention rule the company allowed to purge is never shortened by an
 * upgrade, because a shorter period on a rule that deletes is records gone
 * sooner than anybody agreed to; it is kept and the change listed.
 *
 * "Still says what the pack set up" is decided against the record of what
 * the company's current version set up, when there is one. An application
 * from before that record was kept has none, and there the row's own record
 * answers: a template or programme still on version one and never saved
 * since it was made, a rule or layout never saved since it was made. That
 * fails safe, keeping anything that has been touched at all.
 */

export type SetupKind = "service_report" | "inspection_program" | "retention_rule" | "portal_layout";

/** One piece as a pack version declares it, or as the company's row holds it, in the shape compared. */
export interface SetupPiece {
  kind: SetupKind;
  /** What makes it the same piece across versions: `template`, a programme's name, `entity:kind`, `layout`. */
  key: string;
  name: string;
  content: Record<string, unknown>;
}

export interface CompanySetupPiece extends SetupPiece {
  id: string;
  /** `hvac@1` when the pack set it up, anything else when it did not. */
  tradePackId: string | null;
  /** Without a record of what was set up: whether the row says nobody has saved it since it was made. */
  untouched: boolean;
  /** A retention rule the company has allowed to purge. */
  purgeAllowed?: boolean | undefined;
}

export interface SetupUpgradeInput {
  packId: string;
  /** What the company's current version set up, by `kind:key`. Null when it predates the record. */
  baseline: Readonly<Record<string, Record<string, unknown>>> | null;
  company: readonly CompanySetupPiece[];
  pack: readonly SetupPiece[];
}

export type SetupKeptReason = "edited" | "yours" | "removed" | "purging";

export interface SetupPlan {
  /** New to this company. */
  add: { kind: SetupKind; key: string; name: string }[];
  /** Still as the pack set them up, so they take the new version. `changed` names the parts. */
  update: { kind: SetupKind; key: string; id: string; name: string; changed: string[] }[];
  /** The new version changes these and the company owns them, so nothing happens. */
  kept: { kind: SetupKind; key: string; id: string | null; name: string; reason: SetupKeptReason; changed: string[] }[];
  /** Already what the new version says. */
  unchanged: number;
  /** Set up by an older version and not by this one. Left exactly as they are. */
  dropped: { kind: SetupKind; key: string; id: string; name: string }[];
}

/** The identity a baseline is kept under. */
export const setupKey = (piece: Pick<SetupPiece, "kind" | "key">): string => `${piece.kind}:${piece.key}`;

/**
 * JSON with its keys in order and nothing undefined, so two pieces that say
 * the same thing compare equal however their objects were built. A value
 * written by the database comes back with its keys in another order, and an
 * optional left out is the same as one left undefined.
 */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Which parts of a piece differ, by name. */
export function changedParts(from: Record<string, unknown>, to: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  return keys.filter((key) => canonical(from[key]) !== canonical(to[key]));
}

export function planSetupUpgrade(input: SetupUpgradeInput): SetupPlan {
  const plan: SetupPlan = { add: [], update: [], kept: [], unchanged: 0, dropped: [] };
  const byKey = new Map(input.company.map((piece) => [setupKey(piece), piece]));
  const ours = (piece: CompanySetupPiece) => taggedVersion(piece.tradePackId, input.packId) !== null;
  const wanted = new Set(input.pack.map(setupKey));

  for (const seed of input.pack) {
    const key = setupKey(seed);
    const row = byKey.get(key);
    if (!row) {
      if (input.baseline?.[key]) {
        plan.kept.push({ kind: seed.kind, key: seed.key, id: null, name: seed.name, reason: "removed", changed: [] });
      } else {
        plan.add.push({ kind: seed.kind, key: seed.key, name: seed.name });
      }
      continue;
    }
    const changed = changedParts(row.content, seed.content);
    if (changed.length === 0) {
      plan.unchanged += 1;
      continue;
    }
    const kept = (reason: SetupKeptReason) =>
      plan.kept.push({ kind: seed.kind, key: seed.key, id: row.id, name: row.name, reason, changed });
    if (!ours(row)) { kept("yours"); continue; }
    const seeded = input.baseline?.[key];
    const edited = seeded ? changedParts(row.content, seeded).length > 0 : !row.untouched;
    if (edited) { kept("edited"); continue; }
    const months = (content: Record<string, unknown>) => Number(content["retainMonths"]);
    if (row.kind === "retention_rule" && row.purgeAllowed && months(seed.content) < months(row.content)) {
      kept("purging");
      continue;
    }
    plan.update.push({ kind: seed.kind, key: seed.key, id: row.id, name: row.name, changed });
  }

  for (const row of input.company) {
    if (!ours(row) || wanted.has(setupKey(row))) continue;
    plan.dropped.push({ kind: row.kind, key: row.key, id: row.id, name: row.name });
  }
  return plan;
}

/** A piece's kind as an owner would say it. */
export const SETUP_KIND_LABELS: Record<SetupKind, string> = {
  service_report: "Service report",
  inspection_program: "Inspection programme",
  retention_rule: "Retention rule",
  portal_layout: "Customer portal layout",
};

/** A part of a piece as an owner would say it. */
export const SETUP_PART_LABELS: Record<string, string> = {
  name: "Name",
  fields: "Readings",
  standard: "Standard",
  reportAudience: "Who gets the report",
  frequencyMonths: "How often",
  checkpoints: "Checkpoints",
  entityType: "What it keeps",
  entityKind: "Which kind",
  clockStart: "When the clock starts",
  retainMonths: "Months kept",
  basis: "Why",
  blocks: "Sections",
};
