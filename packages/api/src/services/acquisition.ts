import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { marketing as mk, money as m } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";

/**
 * CHANNEL > CAMPAIGN > TRACKING NUMBER
 *
 * The company's own names for where work comes from, and the campaigns under
 * them. The schema comment in `acquisition.ts` says why there are two layers
 * and why neither is a text box; this file is the only writer of both, and
 * the place every other service asks "which channel and campaign does this
 * belong to".
 *
 * RESOLVED ONCE, AT THE MOMENT SOMETHING HAPPENS. A touch, a call, a spend row
 * and a job are each stamped with a channel and a campaign when they are
 * written, from the evidence there was then. Resolving on read instead would
 * let a tracking number moved to next season's campaign quietly drag last
 * season's calls along with it, and the report for a campaign that has ended
 * would keep changing.
 */

/* ------------------------------------------------------------- settings */

export interface MarketingSettings {
  /** The model every marketing figure uses until a reader picks another. */
  attributionModel: mk.AttributionModelKey;
  /**
   * Whether a new customer and a new job must say where they came from.
   * Off by default, because a company that turns it on before the office has
   * learned the list gets "Direct" chosen on every form to get past it, which
   * is worse than a blank somebody can still fill in.
   */
  requireLeadSource: boolean;
}

export async function settingsWithin(tx: Database, organizationId: string): Promise<MarketingSettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const stored = ((row?.settings ?? {}) as Record<string, unknown>)["marketing"] as
    Partial<MarketingSettings> | undefined;
  const model = stored?.attributionModel;
  return {
    attributionModel: model && (mk.ATTRIBUTION_MODEL_KEYS as string[]).includes(model)
      ? model : mk.DEFAULT_ATTRIBUTION_MODEL,
    requireLeadSource: stored?.requireLeadSource === true,
  };
}

/**
 * Read by anybody who books work, because the new job form needs to know
 * whether the lead source box is required before it is submitted.
 */
export async function getSettings(ctx: ServiceContext): Promise<MarketingSettings> {
  return guardedRead(ctx, "job:read", (tx) => settingsWithin(tx, ctx.actor.organizationId));
}

export type SettingsPatch = { [K in keyof MarketingSettings]?: MarketingSettings[K] | undefined };

export async function setSettings(ctx: ServiceContext, input: SettingsPatch) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await settingsWithin(tx, ctx.actor.organizationId);
    if (input.attributionModel !== undefined
      && !(mk.ATTRIBUTION_MODEL_KEYS as string[]).includes(input.attributionModel)) {
      throw new ConflictError(`"${input.attributionModel}" is not an attribution model this product knows.`);
    }
    const after: MarketingSettings = {
      attributionModel: input.attributionModel ?? before.attributionModel,
      requireLeadSource: input.requireLeadSource ?? before.requireLeadSource,
    };
    /**
     * Merged into the settings object with jsonb `||`, so changing the model
     * leaves quiet hours and the timezone alone. A read, a spread and a write
     * would race any other settings screen saved in the same second.
     */
    await tx.update(schema.organization).set({
      settings: sql`${schema.organization.settings} || ${JSON.stringify({ marketing: after })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "marketing.settings", "organization", ctx.actor.organizationId, before, after);
    return after;
  });
}

/* ------------------------------------------------------------- channels */

/**
 * When something was archived, after a patch: unchanged when the patch says
 * nothing, the ORIGINAL date when archiving something already archived, and
 * cleared when bringing it back.
 */
const archivedAt = (archived: boolean | undefined, before: Date | null): Date | null =>
  archived === undefined ? before : archived ? (before ?? new Date()) : null;

/**
 * The catalogue as this company's starting list, the first time anything asks.
 *
 * Lazily rather than at signup, because companies created before channels
 * existed have none and should get the same list the moment they open the
 * screen or book a job, rather than a migration that has to know every tenant.
 * `on conflict do nothing` makes two requests seeding at once harmless: the
 * name index refuses the second copy of each row and nothing is raised.
 */
export async function ensureChannels(tx: Database, organizationId: string): Promise<void> {
  const [any] = await tx.select({ id: schema.marketingChannel.id })
    .from(schema.marketingChannel)
    .where(eq(schema.marketingChannel.organizationId, organizationId))
    .limit(1);
  if (any) return;
  await tx.insert(schema.marketingChannel)
    .values(mk.SEED_CHANNELS.map((c) => ({ organizationId, name: c.name, sourceKey: c.sourceKey })))
    .onConflictDoNothing();
}

export interface ChannelView {
  id: string;
  name: string;
  sourceKey: string;
  sourceLabel: string;
  archived: boolean;
}

const channelView = (row: typeof schema.marketingChannel.$inferSelect): ChannelView => ({
  id: row.id,
  name: row.name,
  sourceKey: row.sourceKey,
  sourceLabel: mk.leadSourceLabel(row.sourceKey),
  archived: row.archivedAt !== null,
});

/**
 * The channel a catalogue key lands on when nothing more specific is known.
 *
 * The oldest live one with that key, which for a company that never touched
 * the list is the seeded one. A company that has added "Angi" and "Thumbtack"
 * under marketplace and archived the seeded row gets whichever it made first,
 * which is a guess, and the guess is only used when the evidence named the
 * key and nothing else.
 */
export async function channelForSource(
  tx: Database, organizationId: string, sourceKey: string,
): Promise<string | null> {
  await ensureChannels(tx, organizationId);
  const [row] = await tx.select({ id: schema.marketingChannel.id })
    .from(schema.marketingChannel)
    .where(and(
      eq(schema.marketingChannel.organizationId, organizationId),
      eq(schema.marketingChannel.sourceKey, sourceKey),
      isNull(schema.marketingChannel.archivedAt),
    ))
    .orderBy(asc(schema.marketingChannel.createdAt), asc(schema.marketingChannel.name))
    .limit(1);
  return row?.id ?? null;
}

export async function loadChannel(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.marketingChannel)
    .where(and(
      eq(schema.marketingChannel.organizationId, organizationId),
      eq(schema.marketingChannel.id, id),
    )).limit(1);
  if (!row) throw new NotFoundError("Channel");
  return row;
}

export async function listChannels(ctx: ServiceContext, input: { includeArchived?: boolean | undefined } = {}) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    await ensureChannels(tx, ctx.actor.organizationId);
    const rows = await tx.select().from(schema.marketingChannel)
      .where(and(
        eq(schema.marketingChannel.organizationId, ctx.actor.organizationId),
        ...(input.includeArchived ? [] : [isNull(schema.marketingChannel.archivedAt)]),
      ))
      .orderBy(asc(schema.marketingChannel.name));
    return rows.map(channelView);
  });
}

/**
 * The live channels and their live campaigns, for a picker on a form.
 *
 * `job:read` rather than the marketing permission, because the person choosing
 * a lead source on a new job is a CSR, who books work and does not read the
 * marketing report. A channel's name is not a secret; its spend is, and none
 * of that is here.
 */
export async function channelOptions(ctx: ServiceContext) {
  return guardedRead(ctx, "job:read", (tx) => optionsWithin(tx, ctx.actor.organizationId));
}

export async function optionsWithin(tx: Database, organizationId: string) {
  await ensureChannels(tx, organizationId);
  const channels = await tx.select().from(schema.marketingChannel)
    .where(and(
      eq(schema.marketingChannel.organizationId, organizationId),
      isNull(schema.marketingChannel.archivedAt),
    ))
    .orderBy(asc(schema.marketingChannel.name));
  const campaigns = await tx.select({
    id: schema.acquisitionCampaign.id,
    name: schema.acquisitionCampaign.name,
    channelId: schema.acquisitionCampaign.channelId,
  }).from(schema.acquisitionCampaign)
    .where(and(
      eq(schema.acquisitionCampaign.organizationId, organizationId),
      isNull(schema.acquisitionCampaign.archivedAt),
    ))
    .orderBy(asc(schema.acquisitionCampaign.name));
  return channels.map((c) => ({
    ...channelView(c),
    campaigns: campaigns.filter((k) => k.channelId === c.id).map((k) => ({ id: k.id, name: k.name })),
  }));
}

export async function createChannel(ctx: ServiceContext, input: { name: string; sourceKey: string }) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    await ensureChannels(tx, ctx.actor.organizationId);
    const verdict = mk.checkChannel(input);
    if (!verdict.ok) throw new ConflictError(verdict.reason);
    const [row] = await refusingDuplicate(
      "marketing_channel_name_idx",
      `There is already a channel called "${verdict.name}". Rename one of them, or archive the old one first.`,
      () => tx.insert(schema.marketingChannel).values({
        organizationId: ctx.actor.organizationId,
        name: verdict.name,
        sourceKey: verdict.sourceKey,
      }).returning(),
    );
    await audit(tx, ctx, "marketing_channel.created", "marketing_channel", row!.id, null, row!);
    return channelView(row!);
  });
}

/**
 * Rename, remap or archive.
 *
 * Changing the catalogue key is allowed and moves the channel's history with
 * it in the roll up, which is the point: a company that filed "Nextdoor" under
 * social and decides it is really a referral wants last year to move too.
 * The touches keep their own source key, so the per touch evidence is not
 * rewritten; only which channel the company groups it under.
 */
export async function updateChannel(ctx: ServiceContext, input: {
  id: string; name?: string | undefined; sourceKey?: string | undefined; archived?: boolean | undefined;
}) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const before = await loadChannel(tx, ctx.actor.organizationId, input.id);
    const verdict = mk.checkChannel({
      name: input.name ?? before.name,
      sourceKey: input.sourceKey ?? before.sourceKey,
    });
    if (!verdict.ok) throw new ConflictError(verdict.reason);
    const [after] = await refusingDuplicate(
      "marketing_channel_name_idx",
      `There is already a live channel called "${verdict.name}".`,
      () => tx.update(schema.marketingChannel).set({
        name: verdict.name,
        sourceKey: verdict.sourceKey,
        archivedAt: archivedAt(input.archived, before.archivedAt),
        updatedAt: new Date(),
      }).where(eq(schema.marketingChannel.id, input.id)).returning(),
    );
    /**
     * A tracking number's `attribution_source` is the key core's number map
     * reads, and it has to follow the channel or a remapped channel's calls
     * keep landing on the old key.
     */
    if (verdict.sourceKey !== before.sourceKey) {
      await tx.update(schema.phoneNumber).set({ attributionSource: verdict.sourceKey, updatedAt: new Date() })
        .where(and(
          eq(schema.phoneNumber.organizationId, ctx.actor.organizationId),
          eq(schema.phoneNumber.channelId, input.id),
        ));
    }
    await audit(tx, ctx, "marketing_channel.updated", "marketing_channel", input.id, before, after!);
    return channelView(after!);
  });
}

/* ---------------------------------------------------- tracking campaigns */

export async function loadCampaign(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.acquisitionCampaign)
    .where(and(
      eq(schema.acquisitionCampaign.organizationId, organizationId),
      eq(schema.acquisitionCampaign.id, id),
    )).limit(1);
  if (!row) throw new NotFoundError("Tracking campaign");
  return row;
}

function campaignView(
  row: typeof schema.acquisitionCampaign.$inferSelect,
  channel: { name: string; sourceKey: string } | undefined,
) {
  return {
    id: row.id,
    name: row.name,
    channelId: row.channelId,
    channelName: channel?.name ?? null,
    sourceKey: channel?.sourceKey ?? null,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    costModel: row.costModel,
    costAmount: row.costAmount,
    budget: row.budget,
    utmCampaign: row.utmCampaign,
    notes: row.notes,
    archived: row.archivedAt !== null,
  };
}

export type CampaignView = ReturnType<typeof campaignView>;

export interface TrackingCampaignInput {
  channelId: string;
  name: string;
  startsOn?: string | null | undefined;
  endsOn?: string | null | undefined;
  costModel?: mk.CostModel | undefined;
  costAmount?: string | null | undefined;
  budget?: string | null | undefined;
  utmCampaign?: string | null | undefined;
  notes?: string | null | undefined;
}

const UTM_TAKEN = "Another live tracking campaign already carries that utm tag, so a click with it could "
  + "be credited to either. Give this one its own tag.";
const NAME_TAKEN = "There is already a live tracking campaign with that name.";

export async function createCampaign(ctx: ServiceContext, input: TrackingCampaignInput) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const channel = await loadChannel(tx, ctx.actor.organizationId, input.channelId);
    if (channel.archivedAt) {
      throw new ConflictError(`${channel.name} is archived. Bring it back before running a campaign on it.`);
    }
    const verdict = mk.checkTrackingCampaign({ ...input, costModel: input.costModel ?? "recorded" });
    if (!verdict.ok) throw new ConflictError(verdict.problems.join(" "));
    const [row] = await refusingDuplicate("acquisition_campaign_utm_idx", UTM_TAKEN, () =>
      refusingDuplicate("acquisition_campaign_name_idx", NAME_TAKEN, () =>
        tx.insert(schema.acquisitionCampaign).values({
          organizationId: ctx.actor.organizationId,
          channelId: channel.id,
          name: verdict.name,
          startsOn: verdict.startsOn,
          endsOn: verdict.endsOn,
          costModel: verdict.costModel,
          costAmount: verdict.costAmount,
          budget: verdict.budget,
          utmCampaign: verdict.utmCampaign,
          notes: input.notes?.trim() || null,
        }).returning()));
    await audit(tx, ctx, "acquisition_campaign.created", "acquisition_campaign", row!.id, null, row!);
    return campaignView(row!, channel);
  });
}

export type CampaignPatch = { [K in keyof TrackingCampaignInput]?: TrackingCampaignInput[K] | undefined } & {
  id: string; archived?: boolean | undefined;
};

export async function updateCampaign(ctx: ServiceContext, input: CampaignPatch) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const before = await loadCampaign(tx, ctx.actor.organizationId, input.id);
    const channel = await loadChannel(tx, ctx.actor.organizationId, input.channelId ?? before.channelId);
    /**
     * Merged before checking, so a patch that changes only the cost model is
     * checked against the dates already stored rather than against none.
     */
    const verdict = mk.checkTrackingCampaign({
      name: input.name ?? before.name,
      startsOn: input.startsOn !== undefined ? input.startsOn : before.startsOn,
      endsOn: input.endsOn !== undefined ? input.endsOn : before.endsOn,
      costModel: input.costModel ?? before.costModel,
      costAmount: input.costAmount !== undefined ? input.costAmount : before.costAmount,
      budget: input.budget !== undefined ? input.budget : before.budget,
      utmCampaign: input.utmCampaign !== undefined ? input.utmCampaign : before.utmCampaign,
    });
    if (!verdict.ok) throw new ConflictError(verdict.problems.join(" "));
    const [after] = await refusingDuplicate("acquisition_campaign_utm_idx", UTM_TAKEN, () =>
      refusingDuplicate("acquisition_campaign_name_idx", NAME_TAKEN, () =>
        tx.update(schema.acquisitionCampaign).set({
          channelId: channel.id,
          name: verdict.name,
          startsOn: verdict.startsOn,
          endsOn: verdict.endsOn,
          costModel: verdict.costModel,
          costAmount: verdict.costAmount,
          budget: verdict.budget,
          utmCampaign: verdict.utmCampaign,
          ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
          archivedAt: archivedAt(input.archived, before.archivedAt),
          updatedAt: new Date(),
        }).where(eq(schema.acquisitionCampaign.id, input.id)).returning()));

    /** A number assigned to it follows a change of channel, and its source key with it. */
    if (channel.id !== before.channelId) {
      await tx.update(schema.phoneNumber).set({
        channelId: channel.id, attributionSource: channel.sourceKey, updatedAt: new Date(),
      }).where(and(
        eq(schema.phoneNumber.organizationId, ctx.actor.organizationId),
        eq(schema.phoneNumber.acquisitionCampaignId, input.id),
      ));
    }
    await audit(tx, ctx, "acquisition_campaign.updated", "acquisition_campaign", input.id, before, after!);
    return campaignView(after!, channel);
  });
}

export async function listCampaigns(ctx: ServiceContext, input: {
  channelId?: string | undefined; includeArchived?: boolean | undefined;
} = {}) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    await ensureChannels(tx, ctx.actor.organizationId);
    const rows = await tx.select({
      campaign: schema.acquisitionCampaign,
      channel: { name: schema.marketingChannel.name, sourceKey: schema.marketingChannel.sourceKey },
      numbers: sql<number>`(
        select count(*)::int from public.phone_number p
        where p.acquisition_campaign_id = "acquisition_campaign"."id" and p.released_at is null
      )`,
    }).from(schema.acquisitionCampaign)
      .innerJoin(schema.marketingChannel, eq(schema.marketingChannel.id, schema.acquisitionCampaign.channelId))
      .where(and(
        eq(schema.acquisitionCampaign.organizationId, ctx.actor.organizationId),
        ...(input.channelId ? [eq(schema.acquisitionCampaign.channelId, input.channelId)] : []),
        ...(input.includeArchived ? [] : [isNull(schema.acquisitionCampaign.archivedAt)]),
      ))
      .orderBy(asc(schema.marketingChannel.name), asc(schema.acquisitionCampaign.name));
    return rows.map((r) => ({ ...campaignView(r.campaign, r.channel), numbers: r.numbers }));
  });
}

/**
 * One campaign with what hangs off it: its numbers, and the calls each took in
 * the last ninety days, so a number nobody rings is visible on the page where
 * somebody decides whether to keep paying for it.
 */
export async function getCampaign(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const row = await loadCampaign(tx, ctx.actor.organizationId, input.id);
    const channel = await loadChannel(tx, ctx.actor.organizationId, row.channelId);
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const numbers = await tx.select({
      id: schema.phoneNumber.id,
      e164: schema.phoneNumber.e164,
      label: schema.phoneNumber.label,
      calls: sql<number>`(
        select count(*)::int from public.call c
        where c.phone_number_id = "phone_number"."id" and c.direction = 'inbound'
          and coalesce(c.started_at, c.created_at) >= ${since}::timestamptz
      )`,
    }).from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.organizationId, ctx.actor.organizationId),
        eq(schema.phoneNumber.acquisitionCampaignId, row.id),
        isNull(schema.phoneNumber.releasedAt),
      ))
      .orderBy(asc(schema.phoneNumber.e164));
    const [spend] = await tx.select({
      total: sql<string>`coalesce(sum(${schema.adSpend.amount}), 0)::text`,
    }).from(schema.adSpend)
      .where(and(
        eq(schema.adSpend.organizationId, ctx.actor.organizationId),
        eq(schema.adSpend.acquisitionCampaignId, row.id),
        isNull(schema.adSpend.deletedAt),
      ));
    return {
      ...campaignView(row, channel),
      numbers,
      /** Every recorded spend row against it, whatever the cost model, for the page to set beside the budget. */
      recordedSpend: m.toString(m.money(spend?.total ?? "0", "USD")),
    };
  });
}

/* ------------------------------------------------------------ resolution */

export interface Dimension {
  channelId: string | null;
  campaignId: string | null;
}

/**
 * Which channel and campaign a piece of evidence belongs to.
 *
 * In order of how specific the evidence is, which is the order core's touch
 * parser uses for the source and for the same reason:
 *
 *   THE NUMBER DIALLED. A tracking number assigned to a campaign is the
 *   campaign, and is the only tag a yard sign or a van can carry.
 *
 *   THE UTM CAMPAIGN. A tracking campaign that declared this tag owns the
 *   click. Compared without case, because "Spring_Tune_Up" and
 *   "spring_tune_up" are one campaign typed by two people.
 *
 *   THE SOURCE KEY. The channel that key lands on, with no campaign: this
 *   says Google Ads and does not pretend to know which Google campaign.
 */
export async function resolveDimension(tx: Database, organizationId: string, input: {
  phoneNumberId?: string | null | undefined;
  trackedNumber?: string | null | undefined;
  utmCampaign?: string | null | undefined;
  sourceKey?: string | null | undefined;
}): Promise<Dimension> {
  if (input.phoneNumberId || input.trackedNumber) {
    const [number] = await tx.select({
      channelId: schema.phoneNumber.channelId,
      campaignId: schema.phoneNumber.acquisitionCampaignId,
    }).from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.organizationId, organizationId),
        input.phoneNumberId
          ? eq(schema.phoneNumber.id, input.phoneNumberId)
          : eq(schema.phoneNumber.e164, input.trackedNumber!),
        isNull(schema.phoneNumber.releasedAt),
      )).limit(1);
    if (number?.channelId) return { channelId: number.channelId, campaignId: number.campaignId };
  }

  if (input.utmCampaign) {
    const [campaign] = await tx.select({
      id: schema.acquisitionCampaign.id, channelId: schema.acquisitionCampaign.channelId,
    }).from(schema.acquisitionCampaign)
      .where(and(
        eq(schema.acquisitionCampaign.organizationId, organizationId),
        sql`lower(${schema.acquisitionCampaign.utmCampaign}) = lower(${input.utmCampaign})`,
        isNull(schema.acquisitionCampaign.archivedAt),
      )).limit(1);
    if (campaign) return { channelId: campaign.channelId, campaignId: campaign.id };
  }

  if (input.sourceKey) {
    return { channelId: await channelForSource(tx, organizationId, input.sourceKey), campaignId: null };
  }
  return { channelId: null, campaignId: null };
}

export interface Declared {
  sourceKey: string;
  channelId: string;
  campaignId: string | null;
}

/**
 * What somebody chose on a form, checked against the channel list.
 *
 * Any one of the three is enough: a campaign implies its channel, a channel
 * implies its key, and a bare key (the API's `leadSource`, and every import)
 * lands on the channel for that key. What is refused is a combination that
 * disagrees with itself, a campaign under a different channel from the one
 * chosen, because whichever of the two was wrong, the report would be.
 *
 * A bare key is read through core's alias list, so "Google Ads" and
 * "googleads" from an import arrive as `google_ads`; a key nothing can place
 * is refused rather than stored, which is the whole reason the column stopped
 * being free text.
 */
export async function resolveDeclared(tx: Database, organizationId: string, input: {
  leadSource?: string | null | undefined;
  channelId?: string | null | undefined;
  campaignId?: string | null | undefined;
}): Promise<Declared | null> {
  if (input.campaignId) {
    const campaign = await loadCampaign(tx, organizationId, input.campaignId);
    if (input.channelId && input.channelId !== campaign.channelId) {
      throw new ConflictError(`${campaign.name} runs under a different channel from the one chosen. Pick one or the other.`);
    }
    const channel = await loadChannel(tx, organizationId, campaign.channelId);
    return { sourceKey: channel.sourceKey, channelId: channel.id, campaignId: campaign.id };
  }
  if (input.channelId) {
    const channel = await loadChannel(tx, organizationId, input.channelId);
    return { sourceKey: channel.sourceKey, channelId: channel.id, campaignId: null };
  }
  const text = input.leadSource?.trim();
  if (!text) return null;
  const key = (mk.LEAD_SOURCE_KEYS as string[]).includes(text) ? text : (() => {
    const resolved = mk.resolveSource(text);
    if (resolved.ok) return resolved.source;
    throw new ConflictError(
      `"${text}" is not a lead source this company reports on. ${resolved.detail} `
      + "Choose one of the channels on the list instead.",
    );
  })();
  const channelId = await channelForSource(tx, organizationId, key);
  if (!channelId) {
    throw new ConflictError(
      `Every channel for ${mk.leadSourceLabel(key)} is archived. Bring one back, or choose another.`,
    );
  }
  return { sourceKey: key, channelId, campaignId: null };
}

/**
 * The same, for a record that may have arrived from another system.
 *
 * A migration's lead source is whatever the old system said, and refusing a
 * value nobody can now correct stops the import of a customer over a word. So
 * for a record carrying an `externalRef`, a value that cannot be placed is
 * kept as it was written and marked `imported`, and is not made into a touch:
 * a touch dated the day of the cutover would make every imported customer a
 * lead this week.
 */
export async function declaredOrVerbatim(tx: Database, organizationId: string, input: {
  leadSource?: string | null | undefined;
  channelId?: string | null | undefined;
  campaignId?: string | null | undefined;
}, imported: boolean): Promise<{ declared: Declared | null; verbatim: string | null }> {
  if (!imported) return { declared: await resolveDeclared(tx, organizationId, input), verbatim: null };
  try {
    return { declared: await resolveDeclared(tx, organizationId, input), verbatim: null };
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return { declared: null, verbatim: input.leadSource?.trim() || null };
  }
}

/**
 * The refusal when the company requires a lead source and none was given.
 *
 * A record arriving from another system (one carrying an `externalRef`) is
 * exempt: a job from 2019 has whatever source the old system had, often none,
 * and refusing it would stop a migration on a field nobody can now answer.
 */
export async function assertLeadSourceGiven(
  tx: Database, organizationId: string, declared: Declared | null,
  what: "customer" | "job", imported: boolean,
): Promise<void> {
  if (declared || imported) return;
  const settings = await settingsWithin(tx, organizationId);
  if (settings.requireLeadSource) {
    throw new ConflictError(
      `This company asks where every new ${what} came from. Choose a lead source: if nobody knows, `
      + "ask them, and if they really cannot say, choose Direct.",
    );
  }
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listChannels: async (ctx: ServiceContext, input: { includeArchived?: boolean | undefined }) =>
    ({ channels: await listChannels(ctx, input) }),
  listChannelOptions: async (ctx: ServiceContext) => ({ channels: await channelOptions(ctx) }),
  createChannel: (ctx: ServiceContext, input: { name: string; sourceKey: string }) => createChannel(ctx, input),
  updateChannel: (ctx: ServiceContext, input: {
    id: string; name?: string | undefined; sourceKey?: string | undefined; archived?: boolean | undefined;
  }) => updateChannel(ctx, input),
  listTrackingCampaigns: async (ctx: ServiceContext, input: {
    channelId?: string | undefined; includeArchived?: boolean | undefined;
  }) => ({ campaigns: await listCampaigns(ctx, input) }),
  getTrackingCampaign: (ctx: ServiceContext, input: { id: string }) => getCampaign(ctx, input),
  createTrackingCampaign: (ctx: ServiceContext, input: TrackingCampaignInput) => createCampaign(ctx, input),
  updateTrackingCampaign: (ctx: ServiceContext, input: CampaignPatch) => updateCampaign(ctx, input),
  getMarketingSettings: (ctx: ServiceContext) => getSettings(ctx),
  setMarketingSettings: (ctx: ServiceContext, input: SettingsPatch) => setSettings(ctx, input),
} as const;

