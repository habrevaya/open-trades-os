import { eq, and, isNull, desc, like } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { packById, packs, type TradePack } from "@opentradesos/trade-packs";
import { assertCan, can, isSystem, setup as rules } from "@opentradesos/core";
import {
  audit, type ServiceContext, guardedRead, guardedWrite, ConflictError, NotFoundError,
} from "./context";
import { inForceAt, reviseWithin } from "./pricebook";
import { replayed, remember } from "./once";

/**
 * APPLYING A TRADE PACK
 *
 * This is what turns an empty database into something a contractor can use in
 * their first hour, and it runs during setup step two for exactly that reason:
 * every later question in the wizard is easier to answer against a real price
 * book than against nothing.
 *
 * Three rules shape it:
 *
 * 1. One transaction. A half applied pack, with job types but no price book,
 *    is worse than no pack, because the company now has to be cleaned up by
 *    hand before it can be seeded again.
 *
 * 2. Never overwrite. A company that has already edited a price item has told
 *    us something, and a pack update must not silently undo it. Existing codes
 *    are skipped and counted, not replaced.
 *
 * 3. Seeded rows are tagged with the pack id and version, and what the pack
 *    seeded is kept (`trade_pack_application.seeded`), so a later release can
 *    upgrade the rows nobody has touched and leave the edited ones alone.
 *    That upgrade is `previewUpgrade` and `upgrade` below.
 */
export interface ApplyResult {
  packId: string;
  version: number;
  created: { priceBookItems: number; jobTypes: number; categories: number };
  skipped: { priceBookItems: number; jobTypes: number };
}

export async function applyTradePack(ctx: ServiceContext, packId: string): Promise<ApplyResult> {
  const pack = packById(packId);
  if (!pack) throw new NotFoundError(`Trade pack "${packId}"`);

  return guardedWrite(ctx, "settings:write", async (tx) => {
    const org = ctx.actor.organizationId;

    const [existing] = await tx.select({ primaryTrade: schema.organization.primaryTrade })
      .from(schema.organization).where(eq(schema.organization.id, org)).limit(1);
    if (!existing) throw new NotFoundError("Organization");

    const before = await appliedVersion(tx, org, pack.id);
    const result = await seed(tx, org, pack);

    await tx.update(schema.organization)
      .set({ primaryTrade: pack.id, updatedAt: new Date() })
      .where(eq(schema.organization.id, org));

    /**
     * What this application seeded, kept the first time and whenever it
     * seeded something new. A second apply of the same pack that adds
     * nothing must not write a fresh snapshot over the first: the first one
     * is the record of what the pack put into rows that may since have been
     * edited, and an upgrade compares against it.
     */
    if (before === null || result.created.priceBookItems > 0) {
      await record(tx, ctx, pack, "apply", snapshotOf(pack), { ...result });
    }

    await audit(tx, ctx, "trade_pack.applied", "organization", org, null, {
      packId: pack.id, version: pack.version, ...result,
    });

    return { packId: pack.id, version: pack.version, ...result };
  });
}

/** The price book as a pack declares it, by code, in the shape an upgrade compares. */
function snapshotOf(pack: TradePack): Record<string, rules.SeedFields> {
  return Object.fromEntries(pack.priceBook.map((item) => [item.code, seedFields(item)]));
}

function seedFields(item: TradePack["priceBook"][number]): rules.SeedFields {
  return {
    name: item.name,
    description: item.description ?? null,
    price: item.price,
    cost: item.cost ?? null,
    laborMinutes: item.laborMinutes ?? null,
    taxable: item.taxable,
    taxClass: item.taxClass ?? null,
    warrantyMonths: item.warrantyMonths ?? null,
  };
}

async function record(
  tx: Database, ctx: ServiceContext, pack: TradePack, kind: "apply" | "upgrade",
  seeded: Record<string, rules.SeedFields>, result: Record<string, unknown>,
) {
  await tx.insert(schema.tradePackApplication).values({
    organizationId: ctx.actor.organizationId,
    packId: pack.id,
    version: pack.version,
    kind,
    seeded: seeded as unknown as Record<string, Record<string, unknown>>,
    result,
    appliedByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
  });
}

/**
 * The version of a pack this company is on, or null when it never applied it.
 *
 * From the applications when there are any. A company that applied its pack
 * before applications were recorded has only the tags on its price book
 * (`hvac@1`), and the highest of those is the version it is on.
 */
async function appliedVersion(tx: Database, org: string, packId: string): Promise<number | null> {
  const [latest] = await tx.select({ version: schema.tradePackApplication.version })
    .from(schema.tradePackApplication)
    .where(and(
      eq(schema.tradePackApplication.organizationId, org),
      eq(schema.tradePackApplication.packId, packId),
    ))
    .orderBy(desc(schema.tradePackApplication.version)).limit(1);
  if (latest) return latest.version;

  const tagged = await tx.selectDistinct({ tag: schema.priceBookItem.tradePackId })
    .from(schema.priceBookItem)
    .where(and(
      eq(schema.priceBookItem.organizationId, org),
      like(schema.priceBookItem.tradePackId, `${packId}@%`),
    ));
  const versions = tagged.map((row) => rules.taggedVersion(row.tag, packId)).filter((v): v is number => v !== null);
  return versions.length > 0 ? Math.max(...versions) : null;
}

type PackTable =
  | typeof schema.serviceReportTemplate | typeof schema.inspectionProgram
  | typeof schema.retentionPolicy | typeof schema.portalLayout;

/** Whether a pack's own rows of this kind are already in place, so applying again does not double them. */
async function alreadySeeded(tx: Database, org: string, packId: string, table: PackTable): Promise<boolean> {
  const [row] = await tx.select({ id: table.id }).from(table)
    .where(and(eq(table.organizationId, org), like(table.tradePackId, `${packId}@%`))).limit(1);
  return row !== undefined;
}

async function seed(tx: Database, org: string, pack: TradePack) {
  const created = { priceBookItems: 0, jobTypes: 0, categories: 0 };
  const skipped = { priceBookItems: 0, jobTypes: 0 };

  const categoryIds = await categoriesFor(tx, org, pack.priceBook.map((i) => i.category), created);

  // ---- Job types ----------------------------------------------------------
  for (const jt of pack.jobTypes) {
    const [already] = await tx.select({ id: schema.jobType.id }).from(schema.jobType)
      .where(and(eq(schema.jobType.organizationId, org), eq(schema.jobType.code, jt.code))).limit(1);
    if (already) { skipped.jobTypes++; continue; }
    await insertJobType(tx, org, jt);
    created.jobTypes++;
  }

  // ---- Price book ---------------------------------------------------------
  for (const item of pack.priceBook) {
    const [already] = await tx.select({ id: schema.priceBookItem.id }).from(schema.priceBookItem)
      .where(and(eq(schema.priceBookItem.organizationId, org), eq(schema.priceBookItem.code, item.code))).limit(1);
    if (already) { skipped.priceBookItems++; continue; }
    await insertItem(tx, org, pack, item, categoryIds);
    created.priceBookItems++;
  }

  /**
   * The rest of the pack is seeded once. Applying a pack a second time used
   * to add a second service report template, a second set of inspection
   * programmes, retention rules and portal layout beside the first, because
   * only the price book and the job types checked for what was already
   * there. Two default portal layouts is a portal that shows whichever one a
   * query reads first.
   */
  // ---- Service report templates, from the pack's readings -----------------
  if (pack.readings.length > 0 && !(await alreadySeeded(tx, org, pack.id, schema.serviceReportTemplate))) {
    await tx.insert(schema.serviceReportTemplate).values({
      organizationId: org,
      name: `${pack.name} service report`,
      tradePackId: `${pack.id}@${pack.version}`,
      fields: pack.readings.map((r) => ({
        key: r.key,
        label: r.label,
        kind: r.kind,
        ...(r.unit ? { unit: r.unit } : {}),
        ...(r.options ? { options: r.options } : {}),
        customerVisible: r.customerVisible,
        trend: r.trend,
        ...(r.min != null ? { min: r.min } : {}),
        ...(r.max != null ? { max: r.max } : {}),
        regulated: r.regulated,
      })),
    });
  }

  // ---- Inspection programmes ----------------------------------------------
  if (!(await alreadySeeded(tx, org, pack.id, schema.inspectionProgram))) {
    for (const program of pack.inspectionPrograms) {
      await tx.insert(schema.inspectionProgram).values({
        organizationId: org,
        name: program.name,
        standard: program.standard ?? null,
        tradePackId: `${pack.id}@${pack.version}`,
        reportAudience: program.reportAudience,
        frequencyMonths: program.frequencyMonths ?? null,
        checkpoints: program.checkpoints,
      });
    }
  }

  // ---- Retention policies --------------------------------------------------
  if (!(await alreadySeeded(tx, org, pack.id, schema.retentionPolicy))) {
    for (const rule of pack.retention) {
      await tx.insert(schema.retentionPolicy).values({
        organizationId: org,
        name: `${rule.entityType}${rule.entityKind ? ` (${rule.entityKind})` : ""}`,
        entityType: rule.entityType,
        entityKind: rule.entityKind ?? null,
        clockStart: rule.clockStart,
        retainMonths: rule.retainMonths,
        basis: rule.basis ?? null,
        tradePackId: `${pack.id}@${pack.version}`,
      });
    }
  }

  // ---- Customer portal layout ---------------------------------------------
  if (pack.portalBlocks.length > 0 && !(await alreadySeeded(tx, org, pack.id, schema.portalLayout))) {
    const [layout] = await tx.insert(schema.portalLayout).values({
      organizationId: org,
      name: `${pack.name} portal`,
      tradePackId: `${pack.id}@${pack.version}`,
      isDefault: true,
    }).returning({ id: schema.portalLayout.id });

    for (const [i, block] of pack.portalBlocks.entries()) {
      await tx.insert(schema.portalBlock).values({
        organizationId: org,
        layoutId: layout!.id,
        kind: block.kind,
        title: block.title ?? null,
        sortOrder: i,
        config: block.config,
      });
    }
  }

  return { created, skipped };
}

/**
 * The shelves price book items reference by name, made where missing.
 *
 * A shelf the company already has is used rather than made twice. Applying
 * a pack again, or a second pack that also has "Maintenance", used to add a
 * second category of the same name beside the first; the category manager
 * now refuses two shelves with one name under one parent, and so does the
 * index behind it, so the seed matches on the name the way that index does.
 */
async function categoriesFor(
  tx: Database, org: string, names: string[], created: { categories: number },
): Promise<Map<string, string>> {
  const wanted = [...new Set(names)];
  const ids = new Map<string, string>();
  const existing = await tx.select({ id: schema.priceBookCategory.id, name: schema.priceBookCategory.name })
    .from(schema.priceBookCategory)
    .where(and(
      eq(schema.priceBookCategory.organizationId, org),
      isNull(schema.priceBookCategory.parentId),
      isNull(schema.priceBookCategory.deletedAt),
    ));
  const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row.id]));

  for (const [index, name] of wanted.entries()) {
    const already = byName.get(name.toLowerCase());
    if (already) {
      ids.set(name, already);
      continue;
    }
    const [row] = await tx.insert(schema.priceBookCategory)
      .values({ organizationId: org, name, sortOrder: existing.length + index })
      .returning({ id: schema.priceBookCategory.id });
    ids.set(name, row!.id);
    created.categories++;
  }
  return ids;
}

async function insertJobType(tx: Database, org: string, jt: TradePack["jobTypes"][number]) {
  await tx.insert(schema.jobType).values({
    organizationId: org,
    name: jt.name,
    code: jt.code,
    capacityModel: jt.capacityModel,
    revenueClass: jt.revenueClass,
    defaultDurationMinutes: jt.defaultDurationMinutes,
    requiredSkills: jt.requiredSkills,
    color: jt.color ?? null,
  });
}

async function insertItem(
  tx: Database, org: string, pack: TradePack, item: TradePack["priceBook"][number],
  categoryIds: Map<string, string>,
) {
  const [created] = await tx.insert(schema.priceBookItem).values({
    organizationId: org,
    code: item.code,
    kind: item.kind,
    categoryId: categoryIds.get(item.category) ?? null,
    // Tagged so a future pack release can offer an upgrade for rows nobody
    // has edited, and leave the edited ones alone.
    tradePackId: `${pack.id}@${pack.version}`,
  }).returning({ id: schema.priceBookItem.id });

  /**
   * Version 1 of the item, which is what documents will reference. The item
   * row is the stable identity and this carries everything that can change,
   * so raising a price later never rewrites what an old invoice said.
   */
  await tx.insert(schema.priceBookItemVersion).values({
    organizationId: org,
    itemId: created!.id,
    version: 1,
    name: item.name,
    description: item.description ?? null,
    price: item.price,
    cost: item.cost ?? null,
    laborMinutes: item.laborMinutes ?? null,
    taxable: item.taxable,
    taxClass: item.taxClass ?? null,
    warrantyMonths: item.warrantyMonths ?? null,
  });
}

/* ------------------------------------------------------------------ packs */

export interface PackStanding {
  id: string;
  name: string;
  summary: string;
  /** The version this product ships. */
  version: number;
  /** The version this company is on, or null when it never applied the pack. */
  applied: number | null;
  /** A newer version than the company's is available. */
  upgradable: boolean;
  priceBookItems: number;
  jobTypes: number;
}

/** Every pack this product ships, and where this company stands with each. */
export async function standings(ctx: ServiceContext): Promise<{ primaryTrade: string | null; packs: PackStanding[] }> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const [org] = await tx.select({ primaryTrade: schema.organization.primaryTrade })
      .from(schema.organization).where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    const out: PackStanding[] = [];
    for (const pack of packs) {
      const applied = await appliedVersion(tx, ctx.actor.organizationId, pack.id);
      out.push({
        id: pack.id,
        name: pack.name,
        summary: pack.summary,
        version: pack.version,
        applied,
        upgradable: applied !== null && applied < pack.version,
        priceBookItems: pack.priceBook.length,
        jobTypes: pack.jobTypes.length,
      });
    }
    return { primaryTrade: org?.primaryTrade ?? null, packs: out };
  });
}

/* ---------------------------------------------------------------- upgrade */

/**
 * WHAT A NEWER VERSION OF THE PACK WOULD CHANGE, before anybody agrees to it.
 *
 * The plan is `planUpgrade` in core: add what is missing, update what is
 * still exactly as the old version seeded it, keep everything the company
 * changed or made, delete nothing. This reads the company's side of it and
 * hands both to that function, so the preview and the apply are the same
 * decision read twice.
 *
 * Cost is a field the plan compares and not one everybody may read. A person
 * without `pricebook.cost:read` previewing an upgrade sees that an item's
 * cost would change and not what to, so the preview is not a way around the
 * redaction on the price book itself.
 */
export async function previewUpgrade(ctx: ServiceContext, packId: string): Promise<rules.UpgradePlan> {
  const pack = packById(packId);
  if (!pack) throw new NotFoundError(`Trade pack "${packId}"`);
  return previewUpgradeTo(ctx, pack);
}

/** The same, against a pack handed in. For the tests, as `upgradeTo` is. */
export async function previewUpgradeTo(ctx: ServiceContext, pack: TradePack): Promise<rules.UpgradePlan> {
  return guardedRead(ctx, "settings:read", async (tx) => redactCost(ctx, await planFor(tx, ctx, pack)));
}

function redactCost(ctx: ServiceContext, plan: rules.UpgradePlan): rules.UpgradePlan {
  if (can(ctx.actor, "pricebook.cost:read")) return plan;
  const hide = (changes: rules.FieldChange[]) =>
    changes.map((c) => (c.field === "cost" ? { ...c, from: null, to: null } : c));
  return {
    ...plan,
    add: plan.add.map((item) => ({ ...item, cost: null })),
    update: plan.update.map((u) => ({ ...u, changes: hide(u.changes) })),
    kept: plan.kept.map((k) => ({ ...k, changes: hide(k.changes) })),
  };
}

async function planFor(tx: Database, ctx: ServiceContext, pack: TradePack): Promise<rules.UpgradePlan> {
  const org = ctx.actor.organizationId;
  const fromVersion = await appliedVersion(tx, org, pack.id);

  const [application] = fromVersion === null ? [] : await tx.select({ seeded: schema.tradePackApplication.seeded })
    .from(schema.tradePackApplication)
    .where(and(
      eq(schema.tradePackApplication.organizationId, org),
      eq(schema.tradePackApplication.packId, pack.id),
      eq(schema.tradePackApplication.version, fromVersion),
    ))
    .orderBy(desc(schema.tradePackApplication.createdAt)).limit(1);

  const rows = await tx.select({ item: schema.priceBookItem, version: schema.priceBookItemVersion })
    .from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, and(
      eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id),
      inForceAt(),
    ))
    .where(and(eq(schema.priceBookItem.organizationId, org), isNull(schema.priceBookItem.deletedAt)));

  const types = await tx.select({ code: schema.jobType.code }).from(schema.jobType)
    .where(eq(schema.jobType.organizationId, org));

  return rules.planUpgrade({
    packId: pack.id,
    toVersion: pack.version,
    fromVersion,
    baseline: (application?.seeded as Record<string, rules.SeedFields> | undefined) ?? null,
    company: rows.map(({ item, version }) => ({
      itemId: item.id,
      code: item.code,
      tradePackId: item.tradePackId,
      version: version.version,
      current: {
        name: version.name,
        description: version.description,
        price: version.price,
        cost: version.cost,
        laborMinutes: version.laborMinutes,
        taxable: version.taxable,
        taxClass: version.taxClass,
        warrantyMonths: version.warrantyMonths,
      },
    })),
    pack: pack.priceBook.map((item) => ({ code: item.code, kind: item.kind, category: item.category, ...seedFields(item) })),
    companyJobTypeCodes: types.flatMap((t) => (t.code ? [t.code] : [])),
    packJobTypes: pack.jobTypes.map((t) => ({ code: t.code, name: t.name })),
  });
}

export interface UpgradeResult {
  packId: string;
  fromVersion: number | null;
  toVersion: number;
  added: number;
  updated: number;
  kept: number;
  unchanged: number;
  dropped: number;
  jobTypesAdded: number;
}

/**
 * Apply the newer version, by the plan the preview showed.
 *
 * The plan is computed again inside this transaction rather than taken from
 * the request, so an item somebody edited between the preview and the
 * button is kept, not overwritten from a stale page. An updated item gets a
 * NEW VERSION through `reviseWithin`, exactly as a price change by hand
 * does, so an invoice that quoted the old price still says the old price.
 */
export async function upgrade(ctx: ServiceContext, packId: string): Promise<UpgradeResult> {
  const pack = packById(packId);
  if (!pack) throw new NotFoundError(`Trade pack "${packId}"`);
  return upgradeTo(ctx, pack);
}

/**
 * The same, against a pack handed in rather than looked up. Exported for the
 * tests, which need a version two of a pack that ships only version one.
 */
export async function upgradeTo(ctx: ServiceContext, pack: TradePack): Promise<UpgradeResult> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const seen = await replayed<UpgradeResult>(tx, ctx, "trade_pack_upgrade");
    if (seen) return seen;

    const org = ctx.actor.organizationId;
    const plan = await planFor(tx, ctx, pack);
    if (plan.fromVersion === null) {
      throw new ConflictError(
        `This company has never applied the ${pack.name} pack, so there is nothing to upgrade. Apply it instead.`,
      );
    }
    if (plan.upToDate) {
      throw new ConflictError(`This company is already on version ${plan.fromVersion} of the ${pack.name} pack.`);
    }

    const tag = `${pack.id}@${pack.version}`;
    const now = new Date();
    const seeds = new Map(pack.priceBook.map((item) => [item.code, item]));
    const snapshot: Record<string, rules.SeedFields> = {};

    // ---- New items, on the shelves they name.
    const categoryIds = await categoriesFor(tx, org, plan.add.map((i) => i.category), { categories: 0 });
    for (const added of plan.add) {
      await insertItem(tx, org, pack, seeds.get(added.code)!, categoryIds);
    }

    // ---- Items still as the old version left them: a new version each.
    for (const change of plan.update) {
      const [current] = await tx.select({ item: schema.priceBookItem, version: schema.priceBookItemVersion })
        .from(schema.priceBookItem)
        .innerJoin(schema.priceBookItemVersion, and(
          eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id),
          inForceAt(now),
        ))
        .where(eq(schema.priceBookItem.id, change.itemId)).limit(1);
      if (!current) continue;
      const target = seedFields(seeds.get(change.code)!);
      const version = await reviseWithin(tx, ctx, current, {
        name: target.name,
        ...(target.description !== null ? { description: target.description } : {}),
        price: target.price,
        ...(target.cost !== null ? { cost: target.cost } : {}),
        ...(target.laborMinutes !== null ? { laborMinutes: target.laborMinutes } : {}),
        taxable: target.taxable,
        taxClass: target.taxClass,
        warrantyMonths: target.warrantyMonths,
      }, now);
      /**
       * What was actually written, which is the pack's values except where
       * a version cannot clear a field the pack dropped (a description, a
       * cost). Recording the written values is what lets the next upgrade
       * read this item as untouched.
       */
      snapshot[change.code] = {
        name: version.name, description: version.description, price: version.price, cost: version.cost,
        laborMinutes: version.laborMinutes, taxable: version.taxable, taxClass: version.taxClass,
        warrantyMonths: version.warrantyMonths,
      };
    }

    /**
     * Everything else the new version declares is recorded as the new
     * version seeds it. For an item somebody edited, that keeps it reading as
     * edited next time, which is the point: it stays theirs.
     */
    for (const item of pack.priceBook) snapshot[item.code] ??= seedFields(item);

    /**
     * The pack's items move to the new version's tag: the ones updated, and
     * the ones that already said what the new version says. Kept items stay
     * on the old tag, which is the truth about them.
     */
    const kept = new Set(plan.kept.map((k) => k.code));
    for (const item of pack.priceBook) {
      if (kept.has(item.code)) continue;
      await tx.update(schema.priceBookItem).set({ tradePackId: tag, updatedAt: now })
        .where(and(
          eq(schema.priceBookItem.organizationId, org),
          eq(schema.priceBookItem.code, item.code),
          like(schema.priceBookItem.tradePackId, `${pack.id}@%`),
        ));
    }

    // ---- Job types the company does not have yet.
    for (const type of plan.jobTypes.add) {
      await insertJobType(tx, org, pack.jobTypes.find((t) => t.code === type.code)!);
    }

    const result: UpgradeResult = {
      packId: pack.id,
      fromVersion: plan.fromVersion,
      toVersion: pack.version,
      added: plan.add.length,
      updated: plan.update.length,
      kept: plan.kept.length,
      unchanged: plan.unchanged,
      dropped: plan.dropped.length,
      jobTypesAdded: plan.jobTypes.add.length,
    };
    await record(tx, ctx, pack, "upgrade", snapshot, { ...result });
    await audit(tx, ctx, "trade_pack.upgraded", "organization", org,
      { packId: pack.id, version: plan.fromVersion }, { ...result });
    await remember(tx, ctx, "trade_pack_upgrade", null, result);
    return result;
  });
}

/* --------------------------------------------------------------- handlers */

/**
 * The permission is asserted before the pack is looked up, so a caller who
 * may not do this is told that, rather than told whether a pack by that name
 * exists.
 */
export const handlers = {
  listTradePacks: (ctx: ServiceContext) => standings(ctx),
  applyTradePack: (ctx: ServiceContext, input: { id: string }) => {
    assertCan(ctx.actor, "settings:write");
    return applyTradePack(ctx, input.id);
  },
  previewTradePackUpgrade: (ctx: ServiceContext, input: { id: string }) => {
    assertCan(ctx.actor, "settings:read");
    return previewUpgrade(ctx, input.id);
  },
  upgradeTradePack: (ctx: ServiceContext, input: { id: string }) => {
    assertCan(ctx.actor, "settings:write");
    return upgrade(ctx, input.id);
  },
} as const;
