import { and, eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { branding } from "@opentradesos/core";
import {
  guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * A COMPANY'S OWN LOOK
 *
 * The columns for this have been on `organization` since the first migration.
 * `brand_color` was written by the seed and read by NOTHING, and `logo_url`
 * was returned in one portal payload and rendered nowhere. Two more of the
 * declared capabilities this codebase keeps finding in itself.
 *
 * The decisions worth naming are in core: whether anything readable sits on
 * the colour somebody picked, and whether a file is the picture it says it
 * is. This is the door.
 */

export interface Branding {
  /** What they chose, used as a fill. */
  color: string | null;
  /** The text colour that goes on that fill. Computed, never stored. */
  on: string | null;
  /** The same colour, dark enough to read as text on the page. */
  text: string | null;
  hasLogo: boolean;
  hasFavicon: boolean;
  /**
   * Bumped whenever a mark changes, and put on the URL that serves it.
   *
   * The logo is on every page and wants a long cache, and a long cache is a
   * logo somebody replaced still showing up a week later. A version in the
   * path makes the new one a different URL, which is the only cache
   * invalidation that actually works.
   */
  version: number;
}

/**
 * What the shell and the portal need, in one read.
 *
 * NO PERMISSION, for the same reason the bytes need none. This is the
 * company's own face, on every screen in the product and on the pages their
 * customers open. Gating it on `settings:read` would mean a technician, who
 * cannot open the settings screen, is the one person in the company who sees
 * an unbranded application all day.
 *
 * Tenant scoped, which is the part that matters: the read runs inside the
 * organization's own transaction and row level security is forced on both
 * tables, so this returns one company's look and never another's.
 *
 * The two derived colours are computed here rather than stored. Storing
 * either means a row where the three can disagree, and the one that
 * disagrees is always the one being read.
 */
export async function current(ctx: ServiceContext): Promise<Branding> {
  return inTenant(ctx, async (tx) => {
    const [org] = await tx.select({
      color: schema.organization.brandColor,
      updatedAt: schema.organization.updatedAt,
    }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);

    const assets = await tx.select({
      kind: schema.brandAsset.kind,
      updatedAt: schema.brandAsset.updatedAt,
    }).from(schema.brandAsset);

    const color = org?.color ? branding.parseColor(org.color) : null;
    const latest = [org?.updatedAt, ...assets.map((a) => a.updatedAt)]
      .filter((at) => at !== null && at !== undefined)
      .reduce((max, at) => (at! > max ? at! : max), new Date(0));

    return {
      color,
      on: color ? branding.readableOn(color) : null,
      /**
       * Derived rather than stored, like `on`. Storing either means a row
       * where the three can disagree, and the one that disagrees is always
       * the one being read.
       */
      text: color ? branding.textSafe(color) : null,
      hasLogo: assets.some((a) => a.kind === "logo"),
      hasFavicon: assets.some((a) => a.kind === "favicon"),
      version: Math.floor(latest.getTime() / 1000),
    };
  });
}

export async function setColor(ctx: ServiceContext, input: { color: string }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const trimmed = input.color.trim();

    if (trimmed === "") {
      /**
       * Cleared, which is a real answer. A company with no brand colour gets
       * the product's own, and refusing to let somebody undo a choice is how
       * a settings screen becomes one people are afraid of.
       */
      await tx.update(schema.organization).set({ brandColor: null, updatedAt: new Date() })
        .where(eq(schema.organization.id, ctx.actor.organizationId));
      await audit(tx, ctx, "organization.brand_color_cleared", "organization", ctx.actor.organizationId, null, null);
      return { color: null, on: null, text: null, darkened: false };
    }

    const verdict = branding.checkColor(trimmed);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    await tx.update(schema.organization).set({ brandColor: verdict.color, updatedAt: new Date() })
      .where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "organization.brand_color_set", "organization", ctx.actor.organizationId, null, { color: verdict.color });

    return {
      color: verdict.color,
      on: verdict.on,
      text: verdict.text,
      /**
       * Carried out rather than swallowed. An owner whose links come out a
       * shade darker than their brand guide should be told why, once, on
       * the screen where they chose it.
       */
      darkened: verdict.darkened,
    };
  });
}

export async function setAsset(
  ctx: ServiceContext,
  input: { kind: branding.BrandAssetKind; bytes: Uint8Array },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const verdict = branding.checkAsset(input.kind, input.bytes);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const buffer = Buffer.from(input.bytes);
    /**
     * One row per kind, replaced. A second logo is a logo nothing chooses
     * between, and "which one is live" becomes a question about insertion
     * order.
     */
    await tx.insert(schema.brandAsset).values({
      organizationId: ctx.actor.organizationId,
      kind: input.kind,
      // From the bytes. What the upload claimed is never consulted.
      contentType: verdict.contentType,
      bytes: buffer,
      sizeBytes: buffer.length,
      uploadedByUserId: ctx.actor.userId,
    }).onConflictDoUpdate({
      target: [schema.brandAsset.organizationId, schema.brandAsset.kind],
      set: {
        contentType: verdict.contentType,
        bytes: buffer,
        sizeBytes: buffer.length,
        uploadedByUserId: ctx.actor.userId,
        updatedAt: new Date(),
      },
    });

    await audit(tx, ctx, `organization.${input.kind}_set`, "organization", ctx.actor.organizationId,
      null, { contentType: verdict.contentType, sizeBytes: buffer.length });
    return { contentType: verdict.contentType, sizeBytes: buffer.length };
  });
}

export async function clearAsset(
  ctx: ServiceContext, input: { kind: branding.BrandAssetKind },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    await tx.delete(schema.brandAsset)
      .where(and(
        eq(schema.brandAsset.organizationId, ctx.actor.organizationId),
        eq(schema.brandAsset.kind, input.kind),
      ));
    await audit(tx, ctx, `organization.${input.kind}_cleared`, "organization", ctx.actor.organizationId, null, null);
  });
}

/**
 * The bytes, for the route that serves them.
 *
 * `settings:read` is deliberately NOT required. A logo is on the customer's
 * proposal and on the tracking page for a job, both of which are opened by
 * somebody with no account at all, so gating it on a staff permission would
 * mean the customer facing pages are the ones that cannot show it.
 *
 * It is still tenant scoped: the read runs inside the organization's own
 * transaction, so one company cannot fetch another's mark by guessing an id.
 */
export async function assetBytes(
  ctx: ServiceContext, input: { kind: branding.BrandAssetKind },
): Promise<{ bytes: Buffer; contentType: string }> {
  const [found] = await inTenant(ctx, async (tx) =>
    tx.select({ bytes: schema.brandAsset.bytes, contentType: schema.brandAsset.contentType })
      .from(schema.brandAsset)
      .where(eq(schema.brandAsset.kind, input.kind))
      .limit(1));

  if (!found) throw new NotFoundError("Brand asset");
  return { bytes: found.bytes, contentType: found.contentType };
}
