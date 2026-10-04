import { eq, and, isNull, desc, like, inArray } from "drizzle-orm";
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
 *    seeded is kept (`trade_pack_application.seeded` for the price book,
 *    `seeded_setup` for the service report template, inspection programmes,
 *    retention rules and portal layout), so a later release can upgrade the
 *    rows nobody has touched and leave the edited ones alone. That upgrade is
 *    `previewUpgrade` and `upgrade` below.
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
      await record(tx, ctx, pack, "apply", snapshotOf(pack), setupSnapshotOf(pack), { ...result });
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
  seeded: Record<string, rules.SeedFields>, seededSetup: Record<string, Record<string, unknown>>,
  result: Record<string, unknown>,
) {
  await tx.insert(schema.tradePackApplication).values({
    organizationId: ctx.actor.organizationId,
    packId: pack.id,
    version: pack.version,
    kind,
    seeded: seeded as unknown as Record<string, Record<string, unknown>>,
    seededSetup,
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
  const pieces = setupPiecesOf(pack);
  const once = async (kind: rules.SetupKind, table: PackTable) => {
    if (await alreadySeeded(tx, org, pack.id, table)) return;
    for (const piece of pieces.filter((p) => p.kind === kind)) await insertPiece(tx, org, pack, piece);
  };
  await once("service_report", schema.serviceReportTemplate);
  await once("inspection_program", schema.inspectionProgram);
  await once("retention_rule", schema.retentionPolicy);
  await once("portal_layout", schema.portalLayout);

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

/* ------------------------------------------- the rest of what a pack sets up */

/**
 * The service report template, inspection programmes, retention rules and
 * portal layout a pack version declares, each in the shape an upgrade
 * compares: exactly what seeding writes, and nothing the company decides
 * for itself (in force or not, may purge, the default layout).
 */
export function setupPiecesOf(pack: TradePack): rules.SetupPiece[] {
  const pieces: rules.SetupPiece[] = [];
  if (pack.readings.length > 0) {
    const name = `${pack.name} service report`;
    pieces.push({
      kind: "service_report", key: "template", name,
      content: {
        name,
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
      },
    });
  }
  for (const program of pack.inspectionPrograms) {
    pieces.push({
      kind: "inspection_program", key: program.name, name: program.name,
      content: {
        name: program.name,
        standard: program.standard ?? null,
        reportAudience: program.reportAudience,
        frequencyMonths: program.frequencyMonths ?? null,
        checkpoints: program.checkpoints,
      },
    });
  }
  for (const rule of pack.retention) {
    const name = `${rule.entityType}${rule.entityKind ? ` (${rule.entityKind})` : ""}`;
    pieces.push({
      kind: "retention_rule", key: `${rule.entityType}:${rule.entityKind ?? ""}`, name,
      content: {
        name,
        entityType: rule.entityType,
        entityKind: rule.entityKind ?? null,
        clockStart: rule.clockStart,
        retainMonths: rule.retainMonths,
        basis: rule.basis ?? null,
      },
    });
  }
  if (pack.portalBlocks.length > 0) {
    const name = `${pack.name} portal`;
    pieces.push({
      kind: "portal_layout", key: "layout", name,
      content: {
        name,
        blocks: pack.portalBlocks.map((block) => ({
          kind: block.kind, title: block.title ?? null, visible: true, config: block.config,
        })),
      },
    });
  }
  return pieces;
}

/** What a version set up, by `kind:key`, as the application records it. */
function setupSnapshotOf(pack: TradePack): Record<string, Record<string, unknown>> {
  return Object.fromEntries(setupPiecesOf(pack).map((piece) => [rules.setupKey(piece), piece.content]));
}

type ProgramContent = {
  name: string; standard: string | null; reportAudience: string; frequencyMonths: number | null;
  checkpoints: typeof schema.inspectionProgram.$inferSelect["checkpoints"];
};
type RuleContent = {
  name: string; entityType: string; entityKind: string | null;
  clockStart: typeof schema.retentionPolicy.$inferSelect["clockStart"]; retainMonths: number; basis: string | null;
};
type LayoutContent = {
  name: string;
  blocks: { kind: typeof schema.portalBlock.$inferSelect["kind"]; title: string | null; visible: boolean; config: Record<string, unknown> }[];
};
type TemplateContent = { name: string; fields: typeof schema.serviceReportTemplate.$inferSelect["fields"] };

/** A piece set up as seeding sets it up, tagged with the version that set it up. */
async function insertPiece(tx: Database, org: string, pack: TradePack, piece: rules.SetupPiece): Promise<void> {
  const tag = `${pack.id}@${pack.version}`;
  switch (piece.kind) {
    case "service_report": {
      const content = piece.content as TemplateContent;
      await tx.insert(schema.serviceReportTemplate).values({
        organizationId: org, name: content.name, tradePackId: tag, fields: content.fields,
      });
      return;
    }
    case "inspection_program": {
      const content = piece.content as ProgramContent;
      await tx.insert(schema.inspectionProgram).values({
        organizationId: org, name: content.name, standard: content.standard, tradePackId: tag,
        reportAudience: content.reportAudience, frequencyMonths: content.frequencyMonths, checkpoints: content.checkpoints,
      });
      return;
    }
    case "retention_rule": {
      const content = piece.content as RuleContent;
      await tx.insert(schema.retentionPolicy).values({
        organizationId: org, name: content.name, entityType: content.entityType, entityKind: content.entityKind,
        clockStart: content.clockStart, retainMonths: content.retainMonths, basis: content.basis, tradePackId: tag,
      });
      return;
    }
    case "portal_layout": {
      const content = piece.content as LayoutContent;
      /**
       * Default, as every pack's layout is: the portal composes the default
       * layouts of every pack a company applied, its primary trade's first.
       */
      const [layout] = await tx.insert(schema.portalLayout).values({
        organizationId: org, name: content.name, tradePackId: tag, isDefault: true,
      }).returning({ id: schema.portalLayout.id });
      await insertBlocks(tx, org, layout!.id, content.blocks);
      return;
    }
  }
}

async function insertBlocks(tx: Database, org: string, layoutId: string, blocks: LayoutContent["blocks"]) {
  for (const [i, block] of blocks.entries()) {
    await tx.insert(schema.portalBlock).values({
      organizationId: org, layoutId, kind: block.kind, title: block.title, sortOrder: i,
      visible: block.visible, config: block.config,
    });
  }
}

const same = (a: Date, b: Date) => a.getTime() === b.getTime();

/**
 * The company's side of the rest of the pack: every row this pack set up,
 * and every row the company made under a key the pack also uses (a
 * programme of the same name, a rule for the same records), which is theirs.
 */
async function companySetup(tx: Database, org: string, packId: string): Promise<rules.CompanySetupPiece[]> {
  const tagged = like(schema.serviceReportTemplate.tradePackId, `${packId}@%`);
  const out: rules.CompanySetupPiece[] = [];

  const templates = await tx.select().from(schema.serviceReportTemplate)
    .where(and(eq(schema.serviceReportTemplate.organizationId, org), tagged));
  for (const row of templates) {
    out.push({
      kind: "service_report", key: "template", id: row.id, name: row.name, tradePackId: row.tradePackId,
      content: { name: row.name, fields: row.fields },
      untouched: row.version === 1 && same(row.createdAt, row.updatedAt),
    });
  }

  const programs = await tx.select().from(schema.inspectionProgram)
    .where(eq(schema.inspectionProgram.organizationId, org));
  for (const row of programs) {
    out.push({
      kind: "inspection_program", key: row.name, id: row.id, name: row.name, tradePackId: row.tradePackId,
      content: {
        name: row.name, standard: row.standard, reportAudience: row.reportAudience,
        frequencyMonths: row.frequencyMonths, checkpoints: row.checkpoints,
      },
      untouched: row.version === 1 && same(row.createdAt, row.updatedAt),
    });
  }

  const policies = await tx.select().from(schema.retentionPolicy)
    .where(eq(schema.retentionPolicy.organizationId, org));
  for (const row of policies) {
    out.push({
      kind: "retention_rule", key: `${row.entityType}:${row.entityKind ?? ""}`, id: row.id, name: row.name,
      tradePackId: row.tradePackId,
      content: {
        name: row.name, entityType: row.entityType, entityKind: row.entityKind,
        clockStart: row.clockStart, retainMonths: row.retainMonths, basis: row.basis,
      },
      untouched: same(row.createdAt, row.updatedAt),
      purgeAllowed: row.purgeAllowed,
    });
  }

  const layouts = await tx.select().from(schema.portalLayout)
    .where(and(eq(schema.portalLayout.organizationId, org), like(schema.portalLayout.tradePackId, `${packId}@%`)));
  if (layouts.length > 0) {
    const blocks = await tx.select().from(schema.portalBlock)
      .where(inArray(schema.portalBlock.layoutId, layouts.map((l) => l.id)))
      .orderBy(schema.portalBlock.sortOrder);
    for (const row of layouts) {
      const mine = blocks.filter((b) => b.layoutId === row.id);
      out.push({
        kind: "portal_layout", key: "layout", id: row.id, name: row.name, tradePackId: row.tradePackId,
        content: {
          name: row.name,
          blocks: mine.map((b) => ({ kind: b.kind, title: b.title, visible: b.visible, config: b.config })),
        },
        untouched: same(row.createdAt, row.updatedAt) && mine.every((b) => same(b.createdAt, b.updatedAt)),
      });
    }
  }

  /**
   * One row per key, the pack's own first: a programme the pack set up and a
   * second of the same name somebody made beside it are the pack's to
   * compare, and the other is simply theirs.
   */
  const ours = (row: rules.CompanySetupPiece) => rules.taggedVersion(row.tradePackId, packId) !== null;
  const byKey = new Map<string, rules.CompanySetupPiece>();
  for (const row of [...out.filter(ours), ...out.filter((row) => !ours(row))]) {
    if (!byKey.has(rules.setupKey(row))) byKey.set(rules.setupKey(row), row);
  }
  return [...byKey.values()];
}

/**
 * Write a piece's new version over a row that still says what the old one
 * set up. A template's readings and a programme's checkpoints get a new
 * version number, exactly as an edit by hand does, so a report captured
 * under the old questions still says which questions it answered. Whether a
 * template or rule is in force, whether a rule may purge and which layout is
 * the default are the company's and are not touched.
 */
async function updatePiece(
  tx: Database, org: string, tag: string, id: string, piece: rules.SetupPiece, changed: readonly string[], now: Date,
): Promise<void> {
  switch (piece.kind) {
    case "service_report": {
      const content = piece.content as TemplateContent;
      const [row] = await tx.select({ version: schema.serviceReportTemplate.version }).from(schema.serviceReportTemplate)
        .where(eq(schema.serviceReportTemplate.id, id)).limit(1);
      await tx.update(schema.serviceReportTemplate).set({
        name: content.name, fields: content.fields, tradePackId: tag, updatedAt: now,
        ...(changed.includes("fields") && row ? { version: row.version + 1 } : {}),
      }).where(and(eq(schema.serviceReportTemplate.organizationId, org), eq(schema.serviceReportTemplate.id, id)));
      return;
    }
    case "inspection_program": {
      const content = piece.content as ProgramContent;
      const [row] = await tx.select({ version: schema.inspectionProgram.version }).from(schema.inspectionProgram)
        .where(eq(schema.inspectionProgram.id, id)).limit(1);
      await tx.update(schema.inspectionProgram).set({
        name: content.name, standard: content.standard, reportAudience: content.reportAudience,
        frequencyMonths: content.frequencyMonths, checkpoints: content.checkpoints, tradePackId: tag,
        version: (row?.version ?? 1) + 1, updatedAt: now,
      }).where(and(eq(schema.inspectionProgram.organizationId, org), eq(schema.inspectionProgram.id, id)));
      return;
    }
    case "retention_rule": {
      const content = piece.content as RuleContent;
      await tx.update(schema.retentionPolicy).set({
        name: content.name, clockStart: content.clockStart, retainMonths: content.retainMonths,
        basis: content.basis, tradePackId: tag, updatedAt: now,
      }).where(and(eq(schema.retentionPolicy.organizationId, org), eq(schema.retentionPolicy.id, id)));
      return;
    }
    case "portal_layout": {
      const content = piece.content as LayoutContent;
      await tx.update(schema.portalLayout).set({ name: content.name, tradePackId: tag, updatedAt: now })
        .where(and(eq(schema.portalLayout.organizationId, org), eq(schema.portalLayout.id, id)));
      if (changed.includes("blocks")) {
        await tx.delete(schema.portalBlock).where(eq(schema.portalBlock.layoutId, id));
        await insertBlocks(tx, org, id, content.blocks);
      }
      return;
    }
  }
}

/** Move a piece that already says what the new version says onto the new version's tag. */
async function retagPiece(tx: Database, org: string, tag: string, kind: rules.SetupKind, id: string): Promise<void> {
  const table = {
    service_report: schema.serviceReportTemplate, inspection_program: schema.inspectionProgram,
    retention_rule: schema.retentionPolicy, portal_layout: schema.portalLayout,
  }[kind];
  await tx.update(table).set({ tradePackId: tag }).where(and(eq(table.organizationId, org), eq(table.id, id)));
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

  const [application] = fromVersion === null ? [] : await tx.select({
    seeded: schema.tradePackApplication.seeded, seededSetup: schema.tradePackApplication.seededSetup,
  })
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
    setup: {
      packId: pack.id,
      /** An application from before the rest of the pack was recorded has `{}`, which is no record at all. */
      baseline: application && Object.keys(application.seededSetup).length > 0 ? application.seededSetup : null,
      company: fromVersion === null ? [] : await companySetup(tx, org, pack.id),
      pack: setupPiecesOf(pack),
    },
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
  /** The service report template, inspection programmes, retention rules and portal layout. */
  setup: { added: number; updated: number; kept: number; dropped: number };
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

    /**
     * ---- The rest of the pack, by the same plan: what is new is set up,
     * what is still as the old version set it up takes the new version, and
     * what the company changed, removed or made is left exactly as it is.
     * What the new version sets up is recorded either way, as for the price
     * book, so the next upgrade reads an updated piece as untouched and a
     * kept one as still theirs.
     */
    const pieces = new Map(setupPiecesOf(pack).map((piece) => [rules.setupKey(piece), piece]));
    for (const added of plan.setup.add) {
      await insertPiece(tx, org, pack, pieces.get(rules.setupKey(added))!);
    }
    for (const change of plan.setup.update) {
      await updatePiece(tx, org, tag, change.id, pieces.get(rules.setupKey(change))!, change.changed, now);
    }
    const setupKept = new Set(plan.setup.kept.map(rules.setupKey));
    for (const row of await companySetup(tx, org, pack.id)) {
      const key = rules.setupKey(row);
      if (!pieces.has(key) || setupKept.has(key) || row.tradePackId === tag) continue;
      if (rules.taggedVersion(row.tradePackId, pack.id) === null) continue;
      await retagPiece(tx, org, tag, row.kind, row.id);
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
      setup: {
        added: plan.setup.add.length,
        updated: plan.setup.update.length,
        kept: plan.setup.kept.length,
        dropped: plan.setup.dropped.length,
      },
    };
    await record(tx, ctx, pack, "upgrade", snapshot, setupSnapshotOf(pack), { ...result });
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
