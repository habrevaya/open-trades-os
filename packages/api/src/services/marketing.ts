import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { marketing as mk, money as m } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * MARKETING
 *
 * Core knew how to do all of this and could not do any of it, because the
 * only thing the product ever kept was a single word.
 *
 * `booking.sourceOf` called `parseTouch`, took `.source` off the result and
 * discarded everything else: the medium, the campaign, the click id, the
 * referring host, the basis on which the decision was made, and above all
 * the FACT THAT THERE HAD BEEN A TOUCH AT ALL as a separate event from any
 * other. Attribution is a property of a sequence, and the product was
 * keeping one string per lead, so `attribute`, `creditRevenue` and
 * `compareModels` had no possible caller and `summariseSpend` had no input.
 *
 * WHAT THIS FILE REFUSES TO DO
 *
 * It never invents a touch. A job with nothing recorded against it comes
 * back as "not attributed", never as `direct`, because every reporting
 * system's instinct is to give the untracked phone call to direct so the pie
 * chart adds up, and the cost of that is specific: `direct` becomes the
 * largest source in the business, an owner concludes their brand carries
 * them, and the channel actually booking the work gets cut.
 *
 * It never stores an attribution result. The credits are derived from the
 * touches on every read, under whichever model the reader asked for, for the
 * same reason a stock level is derived: a stored answer is a number somebody
 * can edit, and it freezes a modelling choice that should stay a question.
 */

/* ---------------------------------------------------------------- touches */

const known = new Set<string>(mk.LEAD_SOURCE_KEYS as readonly string[]);

const toCore = (row: typeof schema.marketingTouch.$inferSelect): mk.Touch => ({
  at: row.occurredAt,
  source: row.source as mk.LeadSourceKey,
  basis: row.basis,
  utm: {
    ...(row.utmSource ? { source: row.utmSource } : {}),
    ...(row.utmMedium ? { medium: row.utmMedium } : {}),
    ...(row.utmCampaign ? { campaign: row.utmCampaign } : {}),
    ...(row.utmTerm ? { term: row.utmTerm } : {}),
    ...(row.utmContent ? { content: row.utmContent } : {}),
  },
  referrerHost: row.referrerHost,
  clickId: row.clickId,
  campaign: row.utmCampaign,
  ...(row.unrecognised ? { unrecognised: row.unrecognised } : {}),
});

export interface RecordTouchInput {
  at?: Date | undefined;
  visitorId?: string | null;
  customerId?: string | null;
  jobId?: string | null;
  query?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
  trackedNumber?: string | null;
  ownHosts?: string[] | undefined;
}

/**
 * Write down that somebody arrived, and how we know.
 *
 * Takes a transaction, because a touch is almost always recorded alongside
 * the thing that produced it: a booking request, an inbound call, a form
 * submission. Recorded separately it survives a rollback of the event that
 * caused it, and a touch with no arrival behind it is a lead the report
 * counts and nobody can find.
 *
 * The number map is loaded here rather than passed in. Dynamic number
 * insertion is the only way anything physical gets measured, a yard sign
 * with its own number being the only yard sign that will ever appear in a
 * report, and making every caller remember to load it is making every caller
 * able to forget.
 */
export async function recordTouch(
  tx: Database,
  organizationId: string,
  input: RecordTouchInput,
): Promise<{ id: string; touch: mk.Touch }> {
  const numberMap = input.trackedNumber ? await numberMapFor(tx, organizationId) : undefined;

  const touch = mk.parseTouch({
    at: input.at ?? new Date(),
    query: input.query ?? null,
    referrer: input.referrer ?? null,
    trackedNumber: input.trackedNumber ?? null,
    ...(numberMap ? { numberMap } : {}),
    ...(input.ownHosts ? { ownHosts: input.ownHosts } : {}),
  });

  const [row] = await tx.insert(schema.marketingTouch).values({
    organizationId,
    visitorId: input.visitorId ?? null,
    customerId: input.customerId ?? null,
    jobId: input.jobId ?? null,
    source: touch.source,
    basis: touch.basis,
    utmSource: touch.utm.source ?? null,
    utmMedium: touch.utm.medium ?? null,
    utmCampaign: touch.utm.campaign ?? null,
    utmTerm: touch.utm.term ?? null,
    utmContent: touch.utm.content ?? null,
    clickId: touch.clickId,
    referrerHost: touch.referrerHost,
    landingPath: input.landingPath ?? null,
    trackedNumberE164: input.trackedNumber ?? null,
    /**
     * Kept verbatim, and this is the worklist rather than diagnostics. Every
     * row with something here is real money going into a campaign no report
     * can group, and working through them is the only way the alias list
     * gets better.
     */
    unrecognised: touch.unrecognised ?? null,
    occurredAt: touch.at,
  }).returning({ id: schema.marketingTouch.id });

  return { id: row!.id, touch };
}

/**
 * Which tracked number belongs to which source.
 *
 * Read from the phone numbers the office has configured. A number is in the
 * map only when its declared source is IN THE CATALOGUE, and that check is
 * what does the work here: `attribution_source` is free text, so an office
 * typing "spring mailer" into it would otherwise hand core a value no report
 * can group, and core would take it at face value.
 *
 * The `is not null` in the query below is a narrower read, not a second
 * guard: `known.has(null)` is already false, so removing it changes no
 * outcome. It is there so a company with two hundred numbers and four
 * tracking ones reads four rows.
 *
 * A number that fails either way is simply absent, so core resolves the
 * touch to `unknown`. An untagged tracking number is a measurement nobody
 * set up, not a channel.
 */
async function numberMapFor(
  tx: Database,
  organizationId: string,
): Promise<Record<string, mk.LeadSourceKey>> {
  const rows = await tx.select({
    e164: schema.phoneNumber.e164,
    settings: schema.phoneNumber.attributionSource,
  }).from(schema.phoneNumber)
    .where(and(
      eq(schema.phoneNumber.organizationId, organizationId),
      isNull(schema.phoneNumber.releasedAt),
      isNotNull(schema.phoneNumber.attributionSource),
    ));

  const map: Record<string, mk.LeadSourceKey> = {};
  for (const row of rows) {
    if (row.settings && known.has(row.settings)) {
      map[row.e164] = row.settings as mk.LeadSourceKey;
    }
  }
  return map;
}

/**
 * Tie an anonymous history to a person.
 *
 * The moment a form is filled in or a call is matched, every touch that
 * visitor made becomes part of this customer's history at once. Without it
 * the five touches before the conversion belong to nobody and the sixth
 * belongs to the customer, which is last touch attribution by accident
 * rather than by choice.
 *
 * Touches ALREADY tied to a different customer are left alone. A shared
 * device in a household is real, and moving somebody else's history onto
 * this customer would be worse than leaving it split.
 */
export async function identify(
  tx: Database,
  organizationId: string,
  input: { visitorId: string; customerId: string },
): Promise<{ stitched: number }> {
  const rows = await tx.update(schema.marketingTouch).set({
    customerId: input.customerId,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.marketingTouch.organizationId, organizationId),
    eq(schema.marketingTouch.visitorId, input.visitorId),
    isNull(schema.marketingTouch.customerId),
  )).returning({ id: schema.marketingTouch.id });

  return { stitched: rows.length };
}

/** Everything recorded for one customer, oldest first. */
export async function touchesFor(
  ctx: ServiceContext,
  input: {
    customerId?: string | undefined;
    visitorId?: string | undefined;
    jobId?: string | undefined;
  },
) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const rows = await loadTouches(tx, ctx.actor.organizationId, input);
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      basis: row.basis,
      campaign: row.utmCampaign,
      medium: row.utmMedium,
      referrerHost: row.referrerHost,
      clickId: row.clickId,
      landingPath: row.landingPath,
      trackedNumberE164: row.trackedNumberE164,
      unrecognised: row.unrecognised,
      occurredAt: row.occurredAt,
    }));
  });
}

async function loadTouches(
  tx: Database,
  organizationId: string,
  input: { customerId?: string | undefined; visitorId?: string | undefined; jobId?: string | undefined },
) {
  const filters = [eq(schema.marketingTouch.organizationId, organizationId)];
  if (input.customerId) filters.push(eq(schema.marketingTouch.customerId, input.customerId));
  if (input.visitorId) filters.push(eq(schema.marketingTouch.visitorId, input.visitorId));
  if (input.jobId) filters.push(eq(schema.marketingTouch.jobId, input.jobId));

  if (filters.length === 1) {
    throw new ConflictError(
      "Name a customer, a visitor or a job. Every touch in the company is not a question anybody asked, and answering it would be a slow way to say nothing.",
    );
  }

  return tx.select().from(schema.marketingTouch)
    .where(and(...filters))
    .orderBy(asc(schema.marketingTouch.occurredAt));
}

/* ------------------------------------------------------------ attribution */

/**
 * Who gets the credit for a job, under every model at once.
 *
 * Every model, not one, and the disagreement is the finding. When first
 * touch and last touch name the same channel the answer is boring and safe.
 * When they name different ones, somebody is about to cut the channel that
 * starts every job, and the honest thing to put on a screen is both numbers
 * rather than a house model presented as the truth.
 *
 * `wrongAbout` travels with each model, because a figure shown without its
 * caveat is the thing that moves a budget onto the wrong channel.
 */
export async function attributeJob(
  ctx: ServiceContext,
  input: { jobId: string; models?: mk.AttributionModelKey[] | undefined },
) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const [job] = await tx.select({
      id: schema.job.id,
      customerId: schema.job.customerId,
    }).from(schema.job)
      .where(and(
        eq(schema.job.id, input.jobId),
        eq(schema.job.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!job) throw new NotFoundError("Job");

    /**
     * The customer's whole history, not only the touches tagged with this
     * job. A homeowner's first visit was months before this job existed and
     * could not have carried its id; restricting to tagged touches would
     * make every job look like a single last-touch event, which is the bug
     * this module exists to stop.
     */
    const rows = await tx.select().from(schema.marketingTouch)
      .where(and(
        eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
        eq(schema.marketingTouch.customerId, job.customerId),
      ))
      .orderBy(asc(schema.marketingTouch.occurredAt));

    const touches = rows.map(toCore);
    const models = input.models ?? mk.ATTRIBUTION_MODEL_KEYS;
    const compared = mk.compareModels(models, touches);

    return {
      jobId: job.id,
      touchCount: touches.length,
      agree: mk.modelsAgree(compared),
      models: compared.map(({ model, decision }) => ({
        model,
        label: mk.ATTRIBUTION_MODELS[model].label,
        meaning: mk.ATTRIBUTION_MODELS[model].meaning,
        /** Shown beside the number, always. Not a tooltip somebody can skip. */
        wrongAbout: mk.ATTRIBUTION_MODELS[model].wrongAbout,
        ...(decision.ok
          ? {
              attributed: true as const,
              primary: decision.primary,
              credits: decision.credits,
              note: decision.note ?? null,
            }
          : {
              attributed: false as const,
              /**
               * The refusal's own words. "Not attributed" on its own reads
               * as a bug in the product rather than as a gap somebody can
               * close by ringing the customer.
               */
              detail: decision.detail,
            }),
      })),
    };
  });
}

/* ----------------------------------------------------------------- spend */

export interface SpendInput {
  source: string;
  /**
   * `| undefined` on every optional, not just `| null`. Under
   * `exactOptionalPropertyTypes` a zod `.optional()` produces
   * `string | null | undefined` and an absent key is a real state, so a
   * field typed `string | null` here cannot receive one.
   */
  campaign?: string | null | undefined;
  spentOn: string;
  amount: string;
  impressions?: number | null | undefined;
  clicks?: number | null | undefined;
  origin?: string | undefined;
  externalId?: string | null | undefined;
}

/**
 * Record what a channel cost on a day.
 *
 * The source is checked against the catalogue on the way in. A spend row
 * under a source no report can group is money that disappears from every
 * summary, and it disappears silently: the total at the bottom of the screen
 * simply does not include it.
 *
 * `origin` keeps a typed figure and an imported one apart. An import that
 * overwrote a manual entry would delete the only record of the offline spend
 * somebody keyed in, and an import that added to it would double the month.
 */
export async function recordSpend(ctx: ServiceContext, input: SpendInput) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    if (!known.has(input.source)) {
      throw new ConflictError(
        `"${input.source}" is not a lead source this product knows, so spend recorded against it would not appear in any summary. `
        + `Use one of: ${mk.LEAD_SOURCE_KEYS.slice(0, 8).join(", ")} and the rest of the catalogue.`,
      );
    }
    if (m.isNegative(m.money(input.amount, "USD"))) {
      throw new ConflictError("Spend cannot be negative. A refund or a credit is its own row, not a negative day.");
    }

    const origin = input.origin ?? "manual";
    const [row] = await tx.insert(schema.adSpend).values({
      organizationId: ctx.actor.organizationId,
      source: input.source,
      campaign: input.campaign ?? null,
      spentOn: input.spentOn,
      amount: input.amount,
      impressions: input.impressions ?? null,
      clicks: input.clicks ?? null,
      origin,
      externalId: input.externalId ?? null,
    }).onConflictDoUpdate({
      target: [
        schema.adSpend.organizationId, schema.adSpend.source,
        schema.adSpend.campaign, schema.adSpend.spentOn, schema.adSpend.origin,
      ],
      /** Partial index: live rows only, so a deleted day can be re-entered. */
      targetWhere: isNull(schema.adSpend.deletedAt),
      set: {
        amount: input.amount,
        impressions: input.impressions ?? null,
        clicks: input.clicks ?? null,
        externalId: input.externalId ?? null,
        updatedAt: new Date(),
      },
    }).returning();

    return {
      id: row!.id, source: row!.source, campaign: row!.campaign,
      spentOn: row!.spentOn, amount: row!.amount, origin: row!.origin,
    };
  });
}

/**
 * Bring a whole export in at once.
 *
 * Every ads platform exports a daily CSV and every contractor already knows
 * how to download one, which is why this exists before any API adapter does:
 * a company can measure its spend today, with no credentials, no OAuth
 * consent screen and no vendor approval process.
 *
 * Rows are accepted and refused INDIVIDUALLY. A three hundred row export
 * with two unrecognised campaign names should load two hundred and ninety
 * eight rows and name the two, not refuse the file: a monthly import that
 * fails wholesale is a monthly import somebody stops doing.
 */
export async function importSpend(
  ctx: ServiceContext,
  input: { origin: string; rows: SpendInput[] },
) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const accepted: string[] = [];
    const refused: { row: number; reason: string }[] = [];

    for (const [index, row] of input.rows.entries()) {
      if (!known.has(row.source)) {
        refused.push({ row: index + 1, reason: `"${row.source}" is not a lead source in the catalogue.` });
        continue;
      }
      let amount;
      try {
        amount = m.money(row.amount, "USD");
      } catch {
        refused.push({ row: index + 1, reason: `"${row.amount}" is not an amount.` });
        continue;
      }
      if (m.isNegative(amount)) {
        refused.push({ row: index + 1, reason: "Spend cannot be negative." });
        continue;
      }

      const [written] = await tx.insert(schema.adSpend).values({
        organizationId: ctx.actor.organizationId,
        source: row.source,
        campaign: row.campaign ?? null,
        spentOn: row.spentOn,
        amount: row.amount,
        impressions: row.impressions ?? null,
        clicks: row.clicks ?? null,
        origin: input.origin,
        externalId: row.externalId ?? null,
      }).onConflictDoUpdate({
        target: [
          schema.adSpend.organizationId, schema.adSpend.source,
          schema.adSpend.campaign, schema.adSpend.spentOn, schema.adSpend.origin,
        ],
        targetWhere: isNull(schema.adSpend.deletedAt),
        set: {
          amount: row.amount,
          impressions: row.impressions ?? null,
          clicks: row.clicks ?? null,
          externalId: row.externalId ?? null,
          updatedAt: new Date(),
        },
      }).returning({ id: schema.adSpend.id });
      accepted.push(written!.id);
    }

    await audit(tx, ctx, "ad_spend.imported", "organization", ctx.actor.organizationId, null, {
      origin: input.origin, accepted: accepted.length, refused: refused.length,
    });

    return { accepted: accepted.length, refused };
  });
}

/**
 * What every channel cost and what it returned, for a period.
 *
 * The results half is COUNTED from touches and work, never read off a spend
 * row. A stored conversion count is a number somebody can edit into
 * agreement with a target, and the one number in a marketing report that
 * must be beyond argument is how many jobs it actually booked.
 *
 * Leads are counted by DISTINCT CUSTOMER per source, not by touch. Counting
 * touches would make a retargeting campaign that reached one homeowner
 * eleven times look like eleven leads, which is the single most flattering
 * error available to an ad platform and the one it makes by default.
 */
export async function performance(
  ctx: ServiceContext,
  input: { from: string; to: string },
) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const spendRows = await tx.select({
      source: schema.adSpend.source,
      amount: schema.adSpend.amount,
    }).from(schema.adSpend)
      .where(and(
        eq(schema.adSpend.organizationId, ctx.actor.organizationId),
        gte(schema.adSpend.spentOn, input.from),
        lte(schema.adSpend.spentOn, input.to),
        isNull(schema.adSpend.deletedAt),
      ));

    const spendBySource = new Map<string, m.Money>();
    for (const row of spendRows) {
      const current = spendBySource.get(row.source) ?? m.zero("USD");
      spendBySource.set(row.source, m.add(current, m.money(row.amount, "USD")));
    }

    const from = new Date(`${input.from}T00:00:00Z`);
    const to = new Date(`${input.to}T23:59:59.999Z`);

    /**
     * One row per source per customer, so the count below is of people
     * rather than of page views. Distinct at the database rather than in
     * JavaScript because the table is the one that grows fastest in this
     * schema.
     */
    const leadRows = await tx.selectDistinct({
      source: schema.marketingTouch.source,
      customerId: schema.marketingTouch.customerId,
    }).from(schema.marketingTouch)
      .where(and(
        eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
        gte(schema.marketingTouch.occurredAt, from),
        lte(schema.marketingTouch.occurredAt, to),
        isNotNull(schema.marketingTouch.customerId),
      ));

    /**
     * Booked value comes from the INVOICE, not from an estimate or a figure
     * on the job. A marketing report that measured return on quoted work
     * would credit a channel for every proposal a customer declined, which
     * is the one number in the report that has to be beyond argument.
     *
     * A left join, so a job with no invoice yet still counts as booked work
     * at zero value rather than disappearing. Dropping it would make a
     * channel look worse the faster it books, because the newest jobs are
     * the ones not yet invoiced.
     */
    const jobRows = await tx.select({
      source: schema.marketingTouch.source,
      jobId: schema.job.id,
      value: schema.invoice.total,
    }).from(schema.marketingTouch)
      .innerJoin(schema.job, eq(schema.job.id, schema.marketingTouch.jobId))
      .leftJoin(schema.invoice, eq(schema.invoice.jobId, schema.job.id))
      .where(and(
        eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
        gte(schema.marketingTouch.occurredAt, from),
        lte(schema.marketingTouch.occurredAt, to),
      ));

    const bySource = new Map<string, { leads: number; jobs: Set<string>; value: m.Money }>();
    const bucket = (source: string) => {
      let entry = bySource.get(source);
      if (!entry) {
        entry = { leads: 0, jobs: new Set(), value: m.zero("USD") };
        bySource.set(source, entry);
      }
      return entry;
    };
    for (const row of leadRows) bucket(row.source).leads += 1;
    for (const row of jobRows) {
      const entry = bucket(row.source);
      /**
       * A set, because one job reached by three touches from the same source
       * is one job. Adding it three times is the same flattering error as
       * counting touches for leads, one table further along.
       */
      if (!entry.jobs.has(row.jobId)) {
        entry.jobs.add(row.jobId);
        if (row.value) entry.value = m.add(entry.value, m.money(row.value, "USD"));
      }
    }

    const sources = new Set([...spendBySource.keys(), ...bySource.keys()]);
    const decision = mk.summariseSpend(
      [...spendBySource.entries()]
        .filter(([source]) => known.has(source))
        .map(([source, spend]) => ({ source: source as mk.LeadSourceKey, spend })),
      [...sources]
        .filter((source) => known.has(source))
        .map((source) => {
          const entry = bySource.get(source);
          return {
            source: source as mk.LeadSourceKey,
            leads: entry?.leads ?? 0,
            bookedJobs: entry?.jobs.size ?? 0,
            bookedValue: entry?.value ?? m.zero("USD"),
          };
        }),
      "USD",
    );

    return decision;
  });
}

/**
 * The campaigns nobody can group, newest first.
 *
 * A worklist rather than a log. Every row is real money going into something
 * no report can name, and the fix is one alias in core's catalogue. Left
 * alone it becomes a quarter of the leads sitting under `unknown` with no
 * way to find out what they were.
 */
export async function unplaced(ctx: ServiceContext, limit = 50) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const rows = await tx.select({
      unrecognised: schema.marketingTouch.unrecognised,
      medium: schema.marketingTouch.utmMedium,
      count: sql<number>`count(*)::int`,
      lastSeen: sql<Date>`max(${schema.marketingTouch.occurredAt})`,
    }).from(schema.marketingTouch)
      .where(and(
        eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
        isNotNull(schema.marketingTouch.unrecognised),
      ))
      .groupBy(schema.marketingTouch.unrecognised, schema.marketingTouch.utmMedium)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);

    return rows.map((row) => ({
      wrote: row.unrecognised ?? "",
      medium: row.medium,
      touches: row.count,
      lastSeen: row.lastSeen,
    }));
  });
}

/* --------------------------------------------------------------- handlers */

/**
 * The contract shapes.
 *
 * `getPerformance` flattens core's discriminated union, for the same reason
 * the recording decision does: a JSON consumer cannot narrow on `ok` without
 * knowing the union, so `reported` is the boolean and `detail` carries the
 * refusal's own sentence. The refusal matters here: "no spend and no results
 * for this period" is not the same as a period of zeroes, and a screen that
 * showed zeroes would say a channel wasted nothing when nobody had told the
 * product anything at all.
 */
export const handlers = {
  listTouches: async (ctx: ServiceContext, input: {
    customerId?: string | undefined; visitorId?: string | undefined; jobId?: string | undefined;
  }): Promise<{
    touches: {
      id: string; source: string; basis: string;
      campaign: string | null; medium: string | null;
      referrerHost: string | null; clickId: string | null;
      landingPath: string | null; trackedNumberE164: string | null;
      unrecognised: string | null; occurredAt: Date;
    }[];
  }> => ({ touches: await touchesFor(ctx, input) }),

  /**
   * The model union is written out rather than imported from core, so the
   * handler table's inferred type does not name core's internal module path.
   * The contract's own enum checks it on the way in.
   */
  getJobAttribution: (ctx: ServiceContext, input: {
    jobId: string;
    models?: ("first_touch" | "last_touch" | "last_non_direct" | "linear" | "position_based")[] | undefined;
  }): Promise<{
    jobId: string;
    touchCount: number;
    agree: boolean;
    models: {
      model: string;
      label: string;
      meaning: string;
      wrongAbout: string;
      attributed: boolean;
      primary?: string;
      credits?: { source: string; parts: number; touches: number; percent: string }[];
      note?: string | null;
      detail?: string;
    }[];
  }> => attributeJob(ctx, {
    jobId: input.jobId,
    ...(input.models ? { models: input.models } : {}),
  }),

  recordSpend: (ctx: ServiceContext, input: SpendInput) => recordSpend(ctx, input),

  importSpend: (ctx: ServiceContext, input: { origin: string; rows: SpendInput[] }) =>
    importSpend(ctx, input),

  getPerformance: async (ctx: ServiceContext, input: { from: string; to: string }): Promise<{
    reported: boolean;
    detail?: string;
    currency?: string;
    rows?: {
      source: string; spend: string; leads: number; bookedJobs: number;
      bookedValue: string; costPerLead: string | null; costPerBookedJob: string | null;
      roas: string | null; bookingRate: string | null;
      verdict: { kind: string; message: string };
    }[];
    totalSpend?: string;
    totalLeads?: number;
    totalBookedJobs?: number;
    totalBookedValue?: string;
    blendedCostPerLead?: string | null;
    blendedCostPerBookedJob?: string | null;
    blendedRoas?: string | null;
    wastedSpend?: string;
    wastedSources?: string[];
    unpricedSources?: string[];
  }> => {
    const decision = await performance(ctx, input);
    if (!decision.ok) return { reported: false, detail: decision.detail };

    const s = decision.summary;
    return {
      reported: true,
      currency: s.currency,
      rows: s.rows.map((row) => ({
        source: row.source,
        spend: m.toString(row.spend),
        leads: row.leads,
        bookedJobs: row.bookedJobs,
        bookedValue: m.toString(row.bookedValue),
        costPerLead: row.costPerLead ? m.toString(row.costPerLead) : null,
        costPerBookedJob: row.costPerBookedJob ? m.toString(row.costPerBookedJob) : null,
        roas: row.roas,
        bookingRate: row.bookingRate,
        verdict: { kind: row.verdict.kind, message: row.verdict.message },
      })),
      totalSpend: m.toString(s.totalSpend),
      totalLeads: s.totalLeads,
      totalBookedJobs: s.totalBookedJobs,
      totalBookedValue: m.toString(s.totalBookedValue),
      blendedCostPerLead: s.blendedCostPerLead ? m.toString(s.blendedCostPerLead) : null,
      blendedCostPerBookedJob: s.blendedCostPerBookedJob ? m.toString(s.blendedCostPerBookedJob) : null,
      blendedRoas: s.blendedRoas,
      wastedSpend: m.toString(s.wastedSpend),
      wastedSources: [...s.wastedSources],
      unpricedSources: [...s.unpricedSources],
    };
  },

  listUnplacedSources: async (ctx: ServiceContext, input: { limit: number }): Promise<{
    sources: { wrote: string; medium: string | null; touches: number; lastSeen: Date }[];
  }> => ({ sources: await unplaced(ctx, input.limit) }),
} as const;
