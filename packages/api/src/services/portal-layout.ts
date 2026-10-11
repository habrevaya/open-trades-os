import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerPortal as cp } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext } from "./context";
import { defaultLayouts } from "./portal-blocks";

/**
 * THE OFFICE ARRANGING A CUSTOMER'S ACCOUNT PAGE
 *
 * The page draws the company's portal layout: the one its trade pack seeded,
 * composed by core with what every account shows. This is the office moving
 * those blocks, hiding them and giving them headings of its own, from the
 * page as the customer sees it now.
 *
 * WRITTEN TO THE LAYOUT THE PAGE READS FIRST, NAMING EVERY BLOCK. So what is
 * saved is the whole page, in the office's order, and a block nobody chose
 * cannot turn up on it because a second pack named it. A company with no
 * pack gets a layout of its own, which the page reads before any pack's.
 *
 * NEVER OVERWRITTEN BY A PACK UPGRADE. A layout the pack seeded and the
 * office then changed no longer says what the pack set up, so the upgrade
 * keeps it and lists it as the company's (M02's rule, in
 * `core/setup/upgrade.ts`); a layout the company made itself carries no
 * pack's tag and is never the pack's to touch. Saving marks the layout as
 * changed now, which is what an upgrade without a record of what was set up
 * reads, and the content differs from what was set up, which is what one
 * with that record reads.
 *
 * A PLAN CAN HAVE A LAYOUT OF ITS OWN. Members of an agreement plan (a customer
 * with an active or past due agreement on it) can be given a different page,
 * arranged in this same editor. It starts from the company's layout as it
 * stands, is saved whole, and is never the company's default, so the page
 * everyone else sees is read without it and a pack upgrade never touches it.
 * Taking it away puts the plan's members back on the company's layout. A
 * customer on more than one plan with a layout sees the one of their oldest
 * active agreement.
 */

export interface LayoutView {
  blocks: (cp.LayoutRow & { usualTitle: string })[];
  startedFrom: string | null;
  changed: boolean;
  /** Set when this is a plan's layout: which plan, and whether it has a layout of its own or shows the company's. */
  plan: { id: string; name: string; ownLayout: boolean } | null;
}

async function viewWithin(tx: Database, organizationId: string): Promise<LayoutView> {
  const { layouts, blocks } = await defaultLayouts(tx, organizationId);
  const rows = cp.layoutRows(blocks.map((b) => ({ kind: b.kind, title: b.title, config: b.config, visible: b.visible })));
  const first = layouts[0] ?? null;
  return {
    blocks: rows.map((row) => ({ ...row, usualTitle: cp.BLOCK_TITLES[row.kind] })),
    startedFrom: first?.tradePackId ? first.name : null,
    changed: first !== null && (first.tradePackId === null || first.updatedAt.getTime() !== first.createdAt.getTime()),
    plan: null,
  };
}

async function planIn(tx: Database, organizationId: string, planId: string) {
  const [plan] = await tx.select({ id: schema.agreementPlan.id, name: schema.agreementPlan.name })
    .from(schema.agreementPlan)
    .where(and(eq(schema.agreementPlan.id, planId), eq(schema.agreementPlan.organizationId, organizationId))).limit(1);
  if (!plan) throw new NotFoundError("Plan");
  return plan;
}

async function planLayoutIn(tx: Database, organizationId: string, planId: string) {
  const [layout] = await tx.select().from(schema.portalLayout)
    .where(and(eq(schema.portalLayout.organizationId, organizationId), eq(schema.portalLayout.agreementPlanId, planId)))
    .limit(1);
  if (!layout) return null;
  const blocks = await tx.select().from(schema.portalBlock)
    .where(eq(schema.portalBlock.layoutId, layout.id)).orderBy(asc(schema.portalBlock.sortOrder));
  return { layout, blocks };
}

/** A plan's page: its own layout when it has one, otherwise the company's, which is what its members see. */
async function planViewWithin(tx: Database, organizationId: string, planId: string): Promise<LayoutView> {
  const plan = await planIn(tx, organizationId, planId);
  const own = await planLayoutIn(tx, organizationId, planId);
  if (!own) return { ...(await viewWithin(tx, organizationId)), plan: { ...plan, ownLayout: false } };
  const rows = cp.layoutRows(own.blocks.map((b) => ({ kind: b.kind, title: b.title, config: b.config, visible: b.visible })));
  return {
    blocks: rows.map((row) => ({ ...row, usualTitle: cp.BLOCK_TITLES[row.kind] })),
    startedFrom: null,
    changed: true,
    plan: { ...plan, ownLayout: true },
  };
}

export async function get(ctx: ServiceContext): Promise<LayoutView> {
  return guardedRead(ctx, "settings:read", (tx) => viewWithin(tx, ctx.actor.organizationId));
}

export async function getForPlan(ctx: ServiceContext, input: { planId: string }): Promise<LayoutView> {
  return guardedRead(ctx, "settings:read", (tx) => planViewWithin(tx, ctx.actor.organizationId, input.planId));
}

type BlocksInput = { kind: string; title?: string | null | undefined; visible: boolean }[];

export async function set(ctx: ServiceContext, input: { blocks: BlocksInput }): Promise<LayoutView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const { layouts, blocks } = await defaultLayouts(tx, organizationId);
    const current = cp.layoutRows(blocks.map((b) => ({ kind: b.kind, title: b.title, config: b.config, visible: b.visible })));
    const arranged = cp.arrangeLayout(input.blocks.map((b) => ({ kind: b.kind, title: b.title ?? null, visible: b.visible })), current);
    if (!arranged.ok) throw new ConflictError(arranged.reason);

    const now = new Date();
    let target = layouts[0] ?? null;
    if (!target) {
      const [made] = await tx.insert(schema.portalLayout).values({
        organizationId, name: "Your portal", tradePackId: null, isDefault: true,
      }).returning();
      target = made!;
    }
    const before = blocks.filter((b) => b.layoutId === target!.id)
      .map((b) => ({ kind: b.kind, title: b.title, visible: b.visible }));
    await writeBlocks(tx, organizationId, target.id, arranged.blocks, now);
    await audit(tx, ctx, "portal.layout_changed", "portal_layout", target.id, { blocks: before }, {
      blocks: arranged.blocks.map((b) => ({ kind: b.kind, title: b.title, visible: b.visible })),
    });
    return viewWithin(tx, organizationId);
  });
}

async function writeBlocks(
  tx: Database, organizationId: string, layoutId: string, arranged: cp.ArrangedBlock[], now: Date,
) {
  await tx.delete(schema.portalBlock).where(eq(schema.portalBlock.layoutId, layoutId));
  for (const [i, block] of arranged.entries()) {
    await tx.insert(schema.portalBlock).values({
      organizationId, layoutId, kind: block.kind, title: block.title,
      sortOrder: i, visible: block.visible, config: block.config, createdAt: now, updatedAt: now,
    });
  }
  await tx.update(schema.portalLayout).set({ updatedAt: now }).where(eq(schema.portalLayout.id, layoutId));
}

/**
 * Give the members of one plan a page of their own, or change the one they
 * have. It starts from the company's layout (config and all, so a readings
 * block keeps the readings it trends) and is saved whole, like the company's.
 */
export async function setForPlan(
  ctx: ServiceContext, input: { planId: string; blocks: BlocksInput },
): Promise<LayoutView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const plan = await planIn(tx, organizationId, input.planId);
    const own = await planLayoutIn(tx, organizationId, plan.id);
    const base = own ? own.blocks : (await defaultLayouts(tx, organizationId)).blocks;
    const current = cp.layoutRows(base.map((b) => ({ kind: b.kind, title: b.title, config: b.config, visible: b.visible })));
    const arranged = cp.arrangeLayout(input.blocks.map((b) => ({ kind: b.kind, title: b.title ?? null, visible: b.visible })), current);
    if (!arranged.ok) throw new ConflictError(arranged.reason);

    const now = new Date();
    let layoutId = own?.layout.id;
    if (!layoutId) {
      const [made] = await tx.insert(schema.portalLayout).values({
        organizationId, name: `${plan.name} members`, tradePackId: null, isDefault: false, agreementPlanId: plan.id,
      }).onConflictDoNothing().returning({ id: schema.portalLayout.id });
      layoutId = made?.id ?? (await planLayoutIn(tx, organizationId, plan.id))?.layout.id;
      if (!layoutId) throw new ConflictError("That could not be saved. Try again.");
    }
    await writeBlocks(tx, organizationId, layoutId, arranged.blocks, now);
    await audit(tx, ctx, "portal.plan_layout_changed", "portal_layout", layoutId,
      own ? { blocks: own.blocks.map((b) => ({ kind: b.kind, title: b.title, visible: b.visible })) } : null,
      { planId: plan.id, blocks: arranged.blocks.map((b) => ({ kind: b.kind, title: b.title, visible: b.visible })) });
    return planViewWithin(tx, organizationId, plan.id);
  });
}

/** Put a plan's members back on the company's layout. Removing what is not there changes nothing. */
export async function removeForPlan(ctx: ServiceContext, input: { planId: string }): Promise<LayoutView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const plan = await planIn(tx, organizationId, input.planId);
    const own = await planLayoutIn(tx, organizationId, plan.id);
    if (own) {
      await tx.delete(schema.portalLayout).where(eq(schema.portalLayout.id, own.layout.id));
      await audit(tx, ctx, "portal.plan_layout_removed", "portal_layout", own.layout.id,
        { planId: plan.id, blocks: own.blocks.map((b) => ({ kind: b.kind, title: b.title, visible: b.visible })) }, null);
    }
    return planViewWithin(tx, organizationId, plan.id);
  });
}

export interface PlanLayoutRow { planId: string; name: string; active: boolean; ownLayout: boolean; members: number }

/** The company's plans and which of them have a page of their own, with how many members each has now. */
export async function plansWithLayouts(ctx: ServiceContext): Promise<{ plans: PlanLayoutRow[] }> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const plans = await tx.select({
      id: schema.agreementPlan.id, name: schema.agreementPlan.name, active: schema.agreementPlan.active,
    }).from(schema.agreementPlan).where(eq(schema.agreementPlan.organizationId, organizationId))
      .orderBy(asc(schema.agreementPlan.name));
    const own = new Set((await tx.select({ planId: schema.portalLayout.agreementPlanId }).from(schema.portalLayout)
      .where(and(eq(schema.portalLayout.organizationId, organizationId), isNotNull(schema.portalLayout.agreementPlanId))))
      .map((r) => r.planId));
    const counts = plans.length === 0 ? [] : await tx.select({
      planId: schema.agreement.planId, n: sql<number>`count(distinct ${schema.agreement.customerId})::int`,
    }).from(schema.agreement)
      .where(and(eq(schema.agreement.organizationId, organizationId), inArray(schema.agreement.status, ["active", "past_due"])))
      .groupBy(schema.agreement.planId);
    const members = new Map(counts.map((c) => [c.planId, c.n]));
    return {
      plans: plans.map((p) => ({
        planId: p.id, name: p.name, active: p.active, ownLayout: own.has(p.id), members: members.get(p.id) ?? 0,
      })),
    };
  });
}

export const handlers = {
  getPortalLayout: (ctx: ServiceContext) => get(ctx),
  setPortalLayout: (ctx: ServiceContext, input: { blocks: BlocksInput }) => set(ctx, input),
  listPlanPortalLayouts: (ctx: ServiceContext) => plansWithLayouts(ctx),
  getPlanPortalLayout: (ctx: ServiceContext, input: { id: string }) => getForPlan(ctx, { planId: input.id }),
  setPlanPortalLayout: (ctx: ServiceContext, input: { id: string; blocks: BlocksInput }) =>
    setForPlan(ctx, { planId: input.id, blocks: input.blocks }),
  removePlanPortalLayout: (ctx: ServiceContext, input: { id: string }) => removeForPlan(ctx, { planId: input.id }),
} as const;
