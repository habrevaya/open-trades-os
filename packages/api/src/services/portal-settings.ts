import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerPortal as cp } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, ConflictError, type ServiceContext } from "./context";
import { portalBase } from "../lib/portal-base";

/**
 * WHAT A COMPANY LETS ITS CUSTOMERS DO FOR THEMSELVES
 *
 * Two decisions, both off until somebody makes them: whether a customer
 * paying from the portal is offered a tip for the technicians, and whether
 * every job photograph is shown on the customer's job page or only the ones
 * somebody chose. Kept in `organization.settings.portal` beside the other
 * settings the company owns, and read through core so a hand edited blob can
 * only ever read as "off".
 *
 * The sign in page needs no setting. It exists for every company at
 * `/portal/{slug}`, and a customer who has neither an email nor a phone on
 * their record simply cannot be sent a code, which is the same answer the
 * page gives a stranger.
 */

export async function settingsWithin(tx: Database, organizationId: string): Promise<cp.PortalSettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return cp.readPortalSettings(((row?.settings ?? {}) as Record<string, unknown>)["portal"]);
}

export interface PortalSettingsView extends cp.PortalSettings {
  /** Where a customer signs in, to put on the website, an invoice footer or a fridge magnet. */
  signInUrl: string;
}

export async function get(ctx: ServiceContext): Promise<PortalSettingsView> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const settings = await settingsWithin(tx, ctx.actor.organizationId);
    const [org] = await tx.select({ slug: schema.organization.slug })
      .from(schema.organization).where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    return { ...settings, signInUrl: `${portalBase()}/portal/${org?.slug ?? ""}` };
  });
}

export interface PortalSettingsInput {
  tipping?: { enabled: boolean; presets: number[] } | undefined;
  jobPhotos?: cp.PhotoSharing | undefined;
}

/**
 * Change one or both. What is not named is left as it was, and the whole
 * portal blob is written back merged with jsonb `||` so the company's other
 * settings beside it are never touched.
 */
export async function set(ctx: ServiceContext, input: PortalSettingsInput): Promise<PortalSettingsView> {
  await guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await settingsWithin(tx, ctx.actor.organizationId);
    let tipping = before.tipping;
    if (input.tipping) {
      const checked = cp.checkTipSettings(input.tipping);
      if (!checked.ok) throw new ConflictError(checked.reason);
      tipping = checked.settings;
    }
    const after: cp.PortalSettings = { tipping, jobPhotos: input.jobPhotos ?? before.jobPhotos };
    await tx.update(schema.organization).set({
      settings: sql`${schema.organization.settings} || ${JSON.stringify({ portal: after })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "portal.settings", "organization", ctx.actor.organizationId, before, after);
  });
  return get(ctx);
}

export const handlers = {
  getPortalSettings: (ctx: ServiceContext) => get(ctx),
  setPortalSettings: (ctx: ServiceContext, input: PortalSettingsInput) => set(ctx, input),
} as const;
