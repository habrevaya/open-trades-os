import { eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerPortal as cp } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, ConflictError, type ServiceContext } from "./context";
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
 */

export interface LayoutView {
  blocks: (cp.LayoutRow & { usualTitle: string })[];
  startedFrom: string | null;
  changed: boolean;
}

async function viewWithin(tx: Database, organizationId: string): Promise<LayoutView> {
  const { layouts, blocks } = await defaultLayouts(tx, organizationId);
  const rows = cp.layoutRows(blocks.map((b) => ({ kind: b.kind, title: b.title, config: b.config, visible: b.visible })));
  const first = layouts[0] ?? null;
  return {
    blocks: rows.map((row) => ({ ...row, usualTitle: cp.BLOCK_TITLES[row.kind] })),
    startedFrom: first?.tradePackId ? first.name : null,
    changed: first !== null && (first.tradePackId === null || first.updatedAt.getTime() !== first.createdAt.getTime()),
  };
}

export async function get(ctx: ServiceContext): Promise<LayoutView> {
  return guardedRead(ctx, "settings:read", (tx) => viewWithin(tx, ctx.actor.organizationId));
}

export async function set(
  ctx: ServiceContext,
  input: { blocks: { kind: string; title?: string | null | undefined; visible: boolean }[] },
): Promise<LayoutView> {
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
    await tx.delete(schema.portalBlock).where(eq(schema.portalBlock.layoutId, target!.id));
    for (const [i, block] of arranged.blocks.entries()) {
      await tx.insert(schema.portalBlock).values({
        organizationId, layoutId: target!.id, kind: block.kind, title: block.title,
        sortOrder: i, visible: block.visible, config: block.config, createdAt: now, updatedAt: now,
      });
    }
    await tx.update(schema.portalLayout).set({ updatedAt: now }).where(eq(schema.portalLayout.id, target!.id));
    await audit(tx, ctx, "portal.layout_changed", "portal_layout", target!.id, { blocks: before }, {
      blocks: arranged.blocks.map((b) => ({ kind: b.kind, title: b.title, visible: b.visible })),
    });
    return viewWithin(tx, organizationId);
  });
}

export const handlers = {
  getPortalLayout: (ctx: ServiceContext) => get(ctx),
  setPortalLayout: (ctx: ServiceContext, input: { blocks: { kind: string; title?: string | null | undefined; visible: boolean }[] }) =>
    set(ctx, input),
} as const;
