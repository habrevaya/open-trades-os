import { eq, and, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { packById, type TradePack } from "@opentradesos/trade-packs";
import { type ServiceContext, guardedWrite, ConflictError, NotFoundError } from "./context";
import { audit } from "./customers";

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
 * 3. Seeded rows are tagged with the pack id and version, so a later pack
 *    release can offer an upgrade for the rows nobody has touched while
 *    leaving edited ones alone.
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

    const result = await seed(tx, org, pack);

    await tx.update(schema.organization)
      .set({ primaryTrade: pack.id, updatedAt: new Date() })
      .where(eq(schema.organization.id, org));

    await audit(tx, ctx, "trade_pack.applied", "organization", org, null, {
      packId: pack.id, version: pack.version, ...result,
    });

    return { packId: pack.id, version: pack.version, ...result };
  });
}

async function seed(tx: Database, org: string, pack: TradePack) {
  const created = { priceBookItems: 0, jobTypes: 0, categories: 0 };
  const skipped = { priceBookItems: 0, jobTypes: 0 };

  // ---- Categories, which price book items reference by name ---------------
  const categoryNames = [...new Set(pack.priceBook.map((i) => i.category))];
  const categoryIds = new Map<string, string>();

  for (const [index, name] of categoryNames.entries()) {
    const [row] = await tx.insert(schema.priceBookCategory)
      .values({ organizationId: org, name, sortOrder: index })
      .returning({ id: schema.priceBookCategory.id });
    categoryIds.set(name, row!.id);
    created.categories++;
  }

  // ---- Job types ----------------------------------------------------------
  for (const jt of pack.jobTypes) {
    const [already] = await tx.select({ id: schema.jobType.id }).from(schema.jobType)
      .where(and(eq(schema.jobType.organizationId, org), eq(schema.jobType.code, jt.code))).limit(1);
    if (already) { skipped.jobTypes++; continue; }

    await tx.insert(schema.jobType).values({
      organizationId: org,
      name: jt.name,
      code: jt.code,
      capacityModel: jt.capacityModel,
      defaultDurationMinutes: jt.defaultDurationMinutes,
      requiredSkills: jt.requiredSkills,
      color: jt.color ?? null,
    });
    created.jobTypes++;
  }

  // ---- Price book ---------------------------------------------------------
  for (const item of pack.priceBook) {
    const [already] = await tx.select({ id: schema.priceBookItem.id }).from(schema.priceBookItem)
      .where(and(eq(schema.priceBookItem.organizationId, org), eq(schema.priceBookItem.code, item.code))).limit(1);
    if (already) { skipped.priceBookItems++; continue; }

    const [created_] = await tx.insert(schema.priceBookItem).values({
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
      itemId: created_!.id,
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
    created.priceBookItems++;
  }

  // ---- Service report templates, from the pack's readings -----------------
  if (pack.readings.length > 0) {
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

  // ---- Retention policies --------------------------------------------------
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

  // ---- Customer portal layout ---------------------------------------------
  if (pack.portalBlocks.length > 0) {
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
