import { sql } from "drizzle-orm";
import type { Database } from "@opentradesos/db";
import { ads } from "@opentradesos/core";
import { guardedWrite, ConflictError, type ServiceContext } from "./context";
import { replayed, remember } from "./once";
import {
  connectedRow, connectedRows, finishSignIn, isDue, listPlatformCampaigns, mapPlatformCampaign, platforms,
  pullLeads, pullSpend, startSignIn, type AdsDeps, type Connection, type PullOutcome,
} from "./ad-platforms";
import { adChoice, listSends, retrySend, sendConversions, setAdChoice } from "./ad-conversions";
import { confirmMatch, postPendingReplies, pullReviews, syncNow } from "./review-sync";
import "../ads/index";

/**
 * THE AD PLATFORMS ON A CLOCK, AND ON A BUTTON
 *
 * The worker's pass and the "do it now" route run the same functions, so a
 * pull a person forces and a pull the clock makes are the same pull with the
 * same record of it.
 */

/** Everything due for one connection, by the cadences core sets. */
async function workOn(db: Database, row: Connection, deps: AdsDeps, now: Date, force: boolean): Promise<PullOutcome[]> {
  const spec = ads.PROVIDERS[row.provider as ads.AdsProvider];
  const out: PullOutcome[] = [];
  if (spec.pullsSpend && (force || await isDue(db, row, "spend", now))) out.push(await pullSpend(db, row, deps));
  if (spec.pullsLeads && (force || await isDue(db, row, "leads", now))) out.push(await pullLeads(db, row, deps));
  if (spec.pullsReviews) {
    if (force || await isDue(db, row, "reviews", now)) out.push(await pullReviews(db, row, deps));
    else await postPendingReplies(db, row, deps).catch((error: unknown) => {
      console.warn(`[ads] posting replies for ${row.organizationId}: ${(error as Error).message}`);
    });
  }
  if (spec.sends.length > 0 && (force || await isDue(db, row, "conversions", now))) out.push(await sendConversions(db, row, deps));
  return out;
}

/**
 * The worker's pass: every company with a connected platform, least recently
 * visited first, through `app.ad_work_organizations`, which returns ids and
 * nothing else. Inside each company, each connection does what is due. One
 * connection failing, or one company's, stops nothing else: the failure is on
 * the connection's sync row and its last error, where the screen shows it.
 */
export async function adsPass(db: Database, options: {
  deps?: AdsDeps | undefined; shouldStop?: (() => boolean) | undefined; limit?: number | undefined;
} = {}): Promise<{ organizationId: string; outcomes: PullOutcome[] }[]> {
  const deps = options.deps ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const found = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.ad_work_organizations(${options.limit ?? 50})`,
  );
  const results = [];
  for (const { organization_id: organizationId } of found) {
    if (options.shouldStop?.()) break;
    const outcomes: PullOutcome[] = [];
    try {
      for (const row of await connectedRows(db, organizationId)) {
        if (options.shouldStop?.()) break;
        try {
          outcomes.push(...await workOn(db, row, deps, now, false));
        } catch (error) {
          console.error(`[ads] ${row.provider} for ${organizationId}:`, (error as Error).message);
        }
      }
    } catch (error) {
      console.error(`[ads] ${organizationId}:`, (error as Error).message);
    }
    for (const outcome of outcomes.filter((o) => o.error)) {
      console.warn(`[ads] ${outcome.provider} ${outcome.entity} for ${organizationId}: ${outcome.error}`);
    }
    results.push({ organizationId, outcomes });
  }
  return results;
}

/**
 * Pull and send now, for one platform, whatever the clock says.
 *
 * Reviews are not here: answering the review screen's "fetch now" is
 * `review:respond`, which an office manager running reviews may hold without
 * holding the ad spend permissions this route needs.
 */
export async function syncPlatform(
  ctx: ServiceContext, input: { provider: string }, deps: AdsDeps = {},
): Promise<{ provider: string; runs: { entity: string; read: number; written: number; error: string | null; needsSignIn: boolean }[] }> {
  const again = await guardedWrite(ctx, "adspend:write", (tx) =>
    replayed<{ provider: string; runs: { entity: string; read: number; written: number; error: string | null; needsSignIn: boolean }[] }>(tx, ctx, "ad_platform_sync"));
  if (again) return again;
  if (!ads.isAdsProvider(input.provider)) throw new ConflictError(`"${input.provider}" is not an ad platform.`);
  if (ads.PROVIDERS[input.provider].pullsReviews) {
    throw new ConflictError("Reviews are fetched from the review screen, which is where replies are written.");
  }
  const row = await connectedRow(ctx.db, ctx.actor.organizationId, input.provider);
  const outcomes = await workOn(ctx.db, row, deps, (deps.now ?? (() => new Date()))(), true);
  const answer = {
    provider: input.provider,
    runs: outcomes.map((o) => ({ entity: o.entity, read: o.read, written: o.written, error: o.error, needsSignIn: o.needsSignIn })),
  };
  await guardedWrite(ctx, "adspend:write", (tx) => remember(tx, ctx, "ad_platform_sync", null, answer));
  return answer;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  startConnectorSignIn: (ctx: ServiceContext, input: { provider: string }) => startSignIn(ctx, input),
  finishConnectorSignIn: (ctx: ServiceContext, input: { state: string; code?: string | undefined; error?: string | undefined }) =>
    finishSignIn(ctx, input),
  listMarketingPlatforms: async (ctx: ServiceContext) => ({ platforms: await platforms(ctx) }),
  syncMarketingPlatform: (ctx: ServiceContext, input: { provider: string }) => syncPlatform(ctx, input),
  listPlatformCampaigns: async (ctx: ServiceContext) => ({ campaigns: await listPlatformCampaigns(ctx) }),
  mapPlatformCampaign: (ctx: ServiceContext, input: { id: string; campaignId: string | null }) => mapPlatformCampaign(ctx, input),
  listConversionSends: async (ctx: ServiceContext, input: {
    state?: string | undefined; provider?: string | undefined; jobId?: string | undefined; limit?: number | undefined;
  }) => ({ sends: await listSends(ctx, input) }),
  retryConversionSend: (ctx: ServiceContext, input: { id: string }) => retrySend(ctx, input),
  getCustomerAdData: (ctx: ServiceContext, input: { id: string }) => adChoice(ctx, { customerId: input.id }),
  setCustomerAdData: (ctx: ServiceContext, input: {
    id: string; choice: "granted" | "refused"; method?: "verbal" | "written" | "web_form" | "api" | undefined;
    proofText?: string | undefined;
  }) => setAdChoice(ctx, {
    customerId: input.id, choice: input.choice,
    ...(input.method ? { method: input.method } : {}),
    ...(input.proofText ? { proofText: input.proofText } : {}),
  }),
  confirmReviewMatch: (ctx: ServiceContext, input: { id: string; accept: boolean }) => confirmMatch(ctx, input),
  syncReviews: (ctx: ServiceContext) => syncNow(ctx),
} as const;
