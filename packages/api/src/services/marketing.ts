import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { marketing as mk, money as m, referrals, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, NotFoundError, ConflictError, type ServiceContext,
} from "./context";
import * as acquisition from "./acquisition";
import { JOB_COSTING_SQL } from "./report-catalogue";


/**
 * A window of whole days in the company's zone, as the two instants a
 * `between` needs: the first moment of the first day and the last of the
 * last. Read as UTC days, a call at eight in the evening in Chicago on the
 * 31st was the 1st's, and a month's return on spend lost its last evening to
 * the next month.
 */
async function windowOf(
  tx: Database, organizationId: string, input: { from: string; to: string },
): Promise<{ from: Date; to: Date }> {
  const zone = await timezoneOf(tx, organizationId);
  return {
    from: time.startOfDayIn(input.from, zone),
    to: new Date(time.startOfDayIn(time.nextDay(input.to), zone).getTime() - 1),
  };
}
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

/** The same conversion, for the services that send a job's touches to an ad platform. */
export const touchToCore = toCore;

/**
 * A touch whose source is DECLARED rather than inferred.
 *
 * Two kinds of declarer, both `declared`: a marketplace posting a lead over a
 * signed connection, and a person choosing a lead source on a form. There is
 * no URL to read a source out of in either case, and the declarer's identity
 * is the evidence: `parseTouch` cannot produce this and should not be asked
 * to. `enteredByUserId` is what tells the two apart.
 *
 * Separate from `recordTouch` rather than an optional field on it, because
 * an optional `source` would be a way to bypass the parser from anywhere.
 * The source is checked against the catalogue here, since the caller is an
 * adapter and adapters are the thing most likely to invent a key. Callers
 * with free text resolve it through `acquisition.resolveDeclared` first, which
 * is the one place a channel list and an alias list are both consulted.
 */
export async function recordDeclaredTouch(
  tx: Database,
  organizationId: string,
  input: {
    source: string;
    at?: Date | undefined;
    customerId?: string | null;
    jobId?: string | null;
    campaign?: string | null;
    channelId?: string | null | undefined;
    campaignId?: string | null | undefined;
    callerE164?: string | null | undefined;
    enteredByUserId?: string | null | undefined;
    /** An anonymous thread to stitch on later: a lead offer uses its own id. */
    visitorId?: string | null | undefined;
  },
): Promise<{ id: string }> {
  if (!known.has(input.source)) {
    throw new ConflictError(
      `"${input.source}" is not a lead source in the catalogue, so a touch recorded against it would appear in no report.`,
    );
  }

  const dimension = input.channelId
    ? { channelId: input.channelId, campaignId: input.campaignId ?? null }
    : await acquisition.resolveDimension(tx, organizationId, {
      utmCampaign: input.campaign ?? null, sourceKey: input.source,
    });

  const [row] = await tx.insert(schema.marketingTouch).values({
    organizationId,
    customerId: input.customerId ?? null,
    jobId: input.jobId ?? null,
    source: input.source,
    basis: "declared",
    utmCampaign: input.campaign ?? null,
    channelId: dimension.channelId,
    acquisitionCampaignId: dimension.campaignId,
    callerE164: input.callerE164 ?? null,
    enteredByUserId: input.enteredByUserId ?? null,
    visitorId: input.visitorId ?? null,
    occurredAt: input.at ?? new Date(),
  }).returning({ id: schema.marketingTouch.id });

  return { id: row!.id };
}

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
  /** The call this touch is, when it is one. */
  callId?: string | null | undefined;
  /** The number that rang, normalised by the caller with `mk.callerKey`. */
  callerE164?: string | null | undefined;
  /** The visitor's Google Analytics client id, checked by the caller. */
  gaClientId?: string | null | undefined;
  /** Meta's `_fbp` browser id, checked by the caller. */
  metaBrowserId?: string | null | undefined;
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
 * able to forget. The channel and campaign are resolved here for the same
 * reason.
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

  /**
   * A REFERRAL CODE BEATS EVERYTHING THE PARSER INFERRED. `ref` in the
   * landing query is the code from one of this company's own customers'
   * shareable links, so the visit was sent by a named person, and the touch
   * says so: source `referral_customer`, basis `declared`, and the referrer
   * on the row. A code nobody holds is ignored and the touch is whatever the
   * rest of the query says, because a mistyped code is not evidence of
   * anything.
   */
  const referrer = await referrerFor(tx, organizationId, input.query ?? null);
  if (referrer) {
    touch.source = "referral_customer";
    touch.basis = "declared";
    delete touch.unrecognised;
  }

  /**
   * The number wins over the tag only when the touch's source CAME from the
   * number. A tagged click that then rang a tracking number has a utm pair
   * that resolved, and its campaign is the one in the tag.
   */
  const dimension = await acquisition.resolveDimension(tx, organizationId, {
    trackedNumber: touch.basis === "tracked_number" ? input.trackedNumber ?? null : null,
    utmCampaign: touch.utm.campaign ?? null,
    sourceKey: touch.source,
  });

  const [row] = await tx.insert(schema.marketingTouch).values({
    organizationId,
    visitorId: input.visitorId ?? null,
    customerId: input.customerId ?? null,
    jobId: input.jobId ?? null,
    source: touch.source,
    basis: touch.basis,
    channelId: dimension.channelId,
    acquisitionCampaignId: dimension.campaignId,
    callId: input.callId ?? null,
    callerE164: input.callerE164 ?? null,
    referrerCustomerId: referrer?.id ?? null,
    utmSource: touch.utm.source ?? null,
    utmMedium: touch.utm.medium ?? null,
    utmCampaign: touch.utm.campaign ?? null,
    utmTerm: touch.utm.term ?? null,
    utmContent: touch.utm.content ?? null,
    clickId: touch.clickId,
    clickIdParam: touch.clickParam ?? null,
    gaClientId: input.gaClientId ?? null,
    metaBrowserId: input.metaBrowserId ?? null,
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

/** The customer whose referral code is in a landing query, if anybody's is. */
export async function referrerFor(
  tx: Database, organizationId: string, query: string | null,
): Promise<{ id: string; name: string } | null> {
  if (!query) return null;
  const code = referrals.normaliseCode(mk.parseQuery(query)["ref"]);
  if (!code) return null;
  const [row] = await tx.select({ id: schema.customer.id, name: schema.customer.name })
    .from(schema.customer)
    .where(and(
      eq(schema.customer.organizationId, organizationId),
      eq(schema.customer.referralCode, code),
      isNull(schema.customer.deletedAt),
    )).limit(1);
  return row ?? null;
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

  await claimReferral(tx, organizationId, input.customerId);
  return { stitched: rows.length };
}

/**
 * A customer whose history now holds a referral learns who referred them.
 *
 * The earliest referral touch wins and is written once: the neighbour who
 * first sent them is the referrer, and a second link clicked a year later
 * does not move the reward. A customer cannot refer themselves, which is the
 * one shape a shared family device produces.
 */
export async function claimReferral(tx: Database, organizationId: string, customerId: string): Promise<void> {
  const [first] = await tx.select({ referrer: schema.marketingTouch.referrerCustomerId })
    .from(schema.marketingTouch)
    .where(and(
      eq(schema.marketingTouch.organizationId, organizationId),
      eq(schema.marketingTouch.customerId, customerId),
      isNotNull(schema.marketingTouch.referrerCustomerId),
      sql`${schema.marketingTouch.referrerCustomerId} <> ${customerId}`,
    ))
    .orderBy(asc(schema.marketingTouch.occurredAt)).limit(1);
  if (!first?.referrer) return;
  await tx.update(schema.customer).set({ referredByCustomerId: first.referrer, updatedAt: new Date() })
    .where(and(
      eq(schema.customer.id, customerId),
      eq(schema.customer.organizationId, organizationId),
      isNull(schema.customer.referredByCustomerId),
    ));
}

/**
 * The same, for somebody who RANG before anybody knew who they were.
 *
 * Called when a customer is created and whenever a customer's phone changes,
 * with the number normalised to E.164 by `mk.callerKey`, so "(512) 555-0134"
 * on the form and "+15125550134" from the call tracking provider are one
 * person. The calls themselves are claimed too, so the call log shows the
 * customer against a call that arrived before they existed.
 *
 * Same rule as `identify`: touches and calls already somebody else's stay
 * theirs. Two customers sharing a landline is ordinary, and the first one to
 * be created keeps the history rather than the most recent edit taking it.
 */
export async function identifyCaller(
  tx: Database,
  organizationId: string,
  input: { phone: string | null | undefined; customerId: string },
): Promise<{ stitched: number }> {
  const caller = mk.callerKey(input.phone);
  if (!caller) return { stitched: 0 };
  const rows = await tx.update(schema.marketingTouch).set({
    customerId: input.customerId,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.marketingTouch.organizationId, organizationId),
    eq(schema.marketingTouch.callerE164, caller),
    isNull(schema.marketingTouch.customerId),
  )).returning({ id: schema.marketingTouch.id });

  await tx.update(schema.call).set({ customerId: input.customerId, updatedAt: new Date() })
    .where(and(
      eq(schema.call.organizationId, organizationId),
      eq(schema.call.direction, "inbound"),
      eq(schema.call.fromE164, caller),
      isNull(schema.call.customerId),
    ));

  /**
   * AND THE WEBSITE VISITS BEHIND THOSE CALLS. A call on a pool number
   * carries the visitor id of the visit that was shown the number, so the
   * pages somebody read before ringing are theirs as well. Without this the
   * call would be the customer's and the ad click that led to it nobody's.
   */
  const visits = await tx.selectDistinct({ visitorId: schema.marketingTouch.visitorId })
    .from(schema.marketingTouch)
    .where(and(
      eq(schema.marketingTouch.organizationId, organizationId),
      eq(schema.marketingTouch.callerE164, caller),
      eq(schema.marketingTouch.customerId, input.customerId),
      isNotNull(schema.marketingTouch.visitorId),
    ));
  let stitched = rows.length;
  for (const visit of visits) {
    stitched += (await identify(tx, organizationId, { visitorId: visit.visitorId!, customerId: input.customerId })).stitched;
  }
  await claimReferral(tx, organizationId, input.customerId);

  return { stitched };
}

/**
 * What an inbound call is, before it is written: whose number it arrived on,
 * which channel and campaign that number belongs to now, who rang if we know
 * them, and whether they have rung before.
 *
 * One function for both writers of inbound calls, the call tracking webhook
 * and the session logging path, so the two cannot disagree about what a first
 * time caller is.
 *
 * FIRST TIME means no earlier inbound call from this number AND no customer
 * already holding it. A provider that says (CallRail's `first_call`) is
 * believed over this, because it has seen calls from before the company
 * started using this product, and this has not.
 */
export async function inboundCallFacts(tx: Database, organizationId: string, input: {
  fromE164: string;
  receivedOnE164: string | null;
  at: Date;
  providerSaysFirst?: boolean | null | undefined;
}) {
  const caller = mk.callerKey(input.fromE164);
  const [number] = input.receivedOnE164
    ? await tx.select({
      id: schema.phoneNumber.id,
      channelId: schema.phoneNumber.channelId,
      campaignId: schema.phoneNumber.acquisitionCampaignId,
    }).from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.organizationId, organizationId),
        eq(schema.phoneNumber.e164, input.receivedOnE164),
        isNull(schema.phoneNumber.releasedAt),
      )).limit(1)
    : [];

  /**
   * Matched on the normalised number, against every customer, rather than on
   * the string as typed. A customer saved as "(512) 555-0134" did not match a
   * call from "+15125550134" before, so a known customer ringing a tracking
   * number looked like a stranger and the call stitched to nobody.
   */
  const customers = caller
    ? await tx.select({ id: schema.customer.id, phone: schema.customer.phone })
      .from(schema.customer)
      .where(and(
        eq(schema.customer.organizationId, organizationId),
        isNull(schema.customer.deletedAt),
        isNotNull(schema.customer.phone),
        sql`regexp_replace(${schema.customer.phone}, '[^0-9]', '', 'g') like ${`%${caller.slice(-10)}`}`,
      ))
      .orderBy(asc(schema.customer.createdAt))
    : [];
  const customer = customers.find((c) => mk.callerKey(c.phone) === caller);

  let firstTime: boolean | null = input.providerSaysFirst ?? null;
  if (firstTime === null && caller) {
    const [earlier] = await tx.select({ id: schema.call.id }).from(schema.call)
      .where(and(
        eq(schema.call.organizationId, organizationId),
        eq(schema.call.direction, "inbound"),
        eq(schema.call.fromE164, caller),
        lt(schema.call.startedAt, input.at),
      )).limit(1);
    firstTime = !earlier && !customer;
  }

  return {
    callerE164: caller,
    phoneNumberId: number?.id ?? null,
    channelId: number?.channelId ?? null,
    campaignId: number?.campaignId ?? null,
    customerId: customer?.id ?? null,
    firstTimeCaller: firstTime,
  };
}

/* ------------------------------------------------------------ crediting */

/**
 * REVENUE, ONE DEFINITION FOR EVERY MARKETING FIGURE.
 *
 * Revenue recognised on the job in the ledger: net of discounts and credit
 * notes, excluding sales tax, and with a voided invoice subtracting itself.
 * The same fragment the job costing reports read, from `report-catalogue.ts`,
 * and that is the reason to choose it over the two this module used to use.
 * The performance report summed `invoice.total`, which counts tax as income
 * and keeps a voided invoice's money; the campaign results summed `job.total`,
 * which is a figure on the job somebody can type. A marketing report whose
 * revenue disagrees with the profit report by the sales tax is a report an
 * owner stops believing on the first day.
 *
 * It is INVOICED revenue, not collected cash. A channel is credited with the
 * work it won when the work is billed, not when the customer gets round to
 * paying, because chasing a slow payer is not a marketing outcome.
 */
export const REVENUE_SQL = JOB_COSTING_SQL.revenue;

/** Revenue per job, by `REVENUE_SQL`, for a list of jobs. */
export async function revenueByJob(tx: Database, jobIds: string[]): Promise<Map<string, m.Money>> {
  const out = new Map<string, m.Money>();
  if (jobIds.length === 0) return out;
  const rows = await tx.execute<{ id: string; revenue: string }>(sql`
    select job.id, (${sql.raw(REVENUE_SQL)})::text as revenue
    from public.job job
    where job.id in ${sql`(${sql.join(jobIds.map((id) => sql`${id}::uuid`), sql`, `)})`}
  `);
  for (const row of rows) out.set(row.id, m.money(row.revenue ?? "0", "USD"));
  return out;
}

export interface CreditInput {
  jobId: string;
  /** The browser that became this customer, when the path knows it. */
  visitorId?: string | null | undefined;
  /** What somebody chose on the form, already checked by `acquisition.resolveDeclared`. */
  declared?: acquisition.Declared | null | undefined;
  /** The call this work was booked from. */
  callId?: string | null | undefined;
  /** Who chose `declared`, when a person did. */
  userId?: string | null | undefined;
}

export interface CreditOutcome {
  /** False when there was nothing to credit, which is said rather than filed under direct. */
  credited: boolean;
  sourceKey: string | null;
  channelId: string | null;
  campaignId: string | null;
  /** The outbound send the credited touch's utm tag belongs to. */
  marketingCampaignId: string | null;
  touches: number;
}

/**
 * CREDIT A PIECE OF WORK TO WHAT BROUGHT IT IN.
 *
 * This used to live inside `booking.confirm` and nowhere else, so a job booked
 * online was credited and a job a CSR typed in after a call on the Google Ads
 * number was not. Most trades work arrives by phone, which meant most work
 * was invisible to the marketing report. It is one function now, called by
 * every path that creates work for a customer: `jobs.create`, booking
 * confirmation, converting an estimate, accepting a lead offer and booking
 * from a call.
 *
 * In order, inside the caller's transaction:
 *
 *   1. STITCH. The browser and the phone number this customer used before
 *      anybody knew who they were become theirs.
 *
 *   2. DECLARE. A lead source chosen on the form is written as a declared
 *      touch, tagged with the person who chose it, so a CSR's answer is
 *      evidence the models can weigh rather than a column that overrides
 *      them.
 *
 *   3. TAG. Every touch of this customer not yet credited to earlier work is
 *      tagged with this job. A repeat customer's first visit belongs to their
 *      first job, and re-tagging it here would move last year's credit onto
 *      this one. This is what makes a job's touches a partition rather than a
 *      matter of opinion: each touch belongs to exactly one job, so a report
 *      can add jobs up without counting a touch twice.
 *
 *   4. CREDIT. The company's chosen model picks the credited touch, and the
 *      job's channel, tracking campaign and outbound campaign are written
 *      from it. `lead_source` is filled only where it is blank, marked
 *      `derived`, and the same for the customer, so a source somebody typed
 *      is never overwritten by an inference.
 */
export async function creditWork(
  tx: Database,
  organizationId: string,
  input: CreditInput,
): Promise<CreditOutcome> {
  const [job] = await tx.select({
    id: schema.job.id,
    customerId: schema.job.customerId,
    leadSource: schema.job.leadSource,
  }).from(schema.job)
    .where(and(eq(schema.job.organizationId, organizationId), eq(schema.job.id, input.jobId)))
    .limit(1);
  if (!job) throw new NotFoundError("Job");

  const [customer] = await tx.select({
    phone: schema.customer.phone,
    leadSource: schema.customer.leadSource,
  }).from(schema.customer).where(eq(schema.customer.id, job.customerId)).limit(1);

  if (input.visitorId) {
    await identify(tx, organizationId, { visitorId: input.visitorId, customerId: job.customerId });
  }
  await identifyCaller(tx, organizationId, { phone: customer?.phone, customerId: job.customerId });

  if (input.callId) {
    /**
     * The call is linked to the work it produced, which is the fact core's
     * call outcome classifier reads to call it `booked`, and its touch is
     * claimed for this customer even when the caller's number is not the one
     * on the account (somebody ringing from work for their mother's house).
     */
    await tx.update(schema.call).set({ jobId: job.id, customerId: job.customerId, updatedAt: new Date() })
      .where(and(eq(schema.call.organizationId, organizationId), eq(schema.call.id, input.callId)));
    await tx.update(schema.marketingTouch).set({ customerId: job.customerId, updatedAt: new Date() })
      .where(and(
        eq(schema.marketingTouch.organizationId, organizationId),
        eq(schema.marketingTouch.callId, input.callId),
        isNull(schema.marketingTouch.customerId),
      ));
  }

  if (input.declared) {
    await recordDeclaredTouch(tx, organizationId, {
      source: input.declared.sourceKey,
      customerId: job.customerId,
      jobId: job.id,
      channelId: input.declared.channelId,
      campaignId: input.declared.campaignId,
      enteredByUserId: input.userId ?? null,
    });
  }

  await tx.update(schema.marketingTouch).set({ jobId: job.id, updatedAt: new Date() })
    .where(and(
      eq(schema.marketingTouch.organizationId, organizationId),
      eq(schema.marketingTouch.customerId, job.customerId),
      isNull(schema.marketingTouch.jobId),
    ));

  const rows = await tx.select().from(schema.marketingTouch)
    .where(and(
      eq(schema.marketingTouch.organizationId, organizationId),
      eq(schema.marketingTouch.jobId, job.id),
    ))
    .orderBy(asc(schema.marketingTouch.occurredAt));

  const settings = await acquisition.settingsWithin(tx, organizationId);
  const decision = mk.shareTouches(settings.attributionModel, rows.map(toCore));

  if (!decision.ok) {
    return {
      credited: false, sourceKey: null, channelId: null, campaignId: null,
      marketingCampaignId: null, touches: 0,
    };
  }

  /** The touch with the largest share, the later one on a tie. */
  const top = [...decision.shares].sort((a, b) =>
    b.weight - a.weight
    || rows[b.index]!.occurredAt.getTime() - rows[a.index]!.occurredAt.getTime())[0]!;
  const credited = rows[top.index]!;

  /**
   * The CSR's answer is what this job's own columns say when there is one.
   * The models still weigh it as one touch among the rest, which is where a
   * report reads from; the columns are what a person reads on the job.
   */
  const chosen = input.declared
    ? { source: input.declared.sourceKey, channelId: input.declared.channelId, campaignId: input.declared.campaignId }
    : { source: credited.source, channelId: credited.channelId, campaignId: credited.acquisitionCampaignId };

  let marketingCampaignId: string | null = null;
  if (credited.utmCampaign) {
    const [send] = await tx.select({ id: schema.marketingCampaign.id })
      .from(schema.marketingCampaign)
      .where(and(
        eq(schema.marketingCampaign.organizationId, organizationId),
        sql`lower(${schema.marketingCampaign.utmCampaign}) = lower(${credited.utmCampaign})`,
        isNull(schema.marketingCampaign.deletedAt),
      ))
      .orderBy(desc(schema.marketingCampaign.createdAt))
      .limit(1);
    marketingCampaignId = send?.id ?? null;
  }

  await tx.update(schema.job).set({
    channelId: chosen.channelId,
    acquisitionCampaignId: chosen.campaignId,
    campaignId: marketingCampaignId,
    ...(input.declared
      ? { leadSource: chosen.source, leadSourceOrigin: "manual" }
      : job.leadSource ? {} : { leadSource: chosen.source, leadSourceOrigin: "derived" }),
    updatedAt: new Date(),
  }).where(eq(schema.job.id, job.id));

  if (!customer?.leadSource) {
    await tx.update(schema.customer).set({
      leadSource: chosen.source,
      leadSourceOrigin: input.declared ? "manual" : "derived",
      channelId: chosen.channelId,
      acquisitionCampaignId: chosen.campaignId,
      updatedAt: new Date(),
    }).where(eq(schema.customer.id, job.customerId));
  }

  return {
    credited: true,
    sourceKey: chosen.source,
    channelId: chosen.channelId,
    campaignId: chosen.campaignId,
    marketingCampaignId,
    touches: rows.length,
  };
}

/**
 * A new customer's lead source, from what they did before they were one.
 *
 * Called when a customer is created with no source chosen: the calls and
 * visits just stitched to them say where they came from, under the
 * company's model, and the answer is written as `derived` so it is never
 * mistaken for somebody's choice. Nothing recorded leaves it blank, which is
 * the honest answer and the one that prompts somebody to ask.
 */
export async function deriveCustomerSource(
  tx: Database, organizationId: string, customerId: string,
): Promise<{ sourceKey: string; channelId: string | null; campaignId: string | null } | null> {
  const rows = await tx.select().from(schema.marketingTouch)
    .where(and(
      eq(schema.marketingTouch.organizationId, organizationId),
      eq(schema.marketingTouch.customerId, customerId),
      isNull(schema.marketingTouch.jobId),
    ))
    .orderBy(asc(schema.marketingTouch.occurredAt));
  const settings = await acquisition.settingsWithin(tx, organizationId);
  const decision = mk.shareTouches(settings.attributionModel, rows.map(toCore));
  if (!decision.ok) return null;
  const top = [...decision.shares].sort((a, b) =>
    b.weight - a.weight
    || rows[b.index]!.occurredAt.getTime() - rows[a.index]!.occurredAt.getTime())[0]!;
  const credited = rows[top.index]!;
  await tx.update(schema.customer).set({
    leadSource: credited.source,
    leadSourceOrigin: "derived",
    channelId: credited.channelId,
    acquisitionCampaignId: credited.acquisitionCampaignId,
    updatedAt: new Date(),
  }).where(and(eq(schema.customer.id, customerId), isNull(schema.customer.leadSource)));
  return { sourceKey: credited.source, channelId: credited.channelId, campaignId: credited.acquisitionCampaignId };
}

/**
 * A lead source changed on a job or a customer after the fact.
 *
 * Recorded as a declared touch and written to the record's own columns as
 * `manual`. The touch is what lets the change reach the reports; the columns
 * are what the page shows. Nothing earlier is deleted, so "the tracking number
 * said Google and the customer later said a neighbour told them" is two rows
 * a reader can weigh rather than one overwritten by the other.
 */
export async function declareSource(
  tx: Database,
  organizationId: string,
  input: { declared: acquisition.Declared; customerId: string; jobId?: string | null; userId?: string | null },
): Promise<void> {
  await recordDeclaredTouch(tx, organizationId, {
    source: input.declared.sourceKey,
    customerId: input.customerId,
    jobId: input.jobId ?? null,
    channelId: input.declared.channelId,
    campaignId: input.declared.campaignId,
    enteredByUserId: input.userId ?? null,
  });
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
     * The touches credited to this job. `creditWork` tags every touch of the
     * customer not yet credited to earlier work when the job is created, so a
     * first job carries the homeowner's whole history back to the visit
     * months before it existed, and a repeat customer's second job carries
     * only what happened since the first. That partition is what the funnel
     * report adds up, and reading anything else here would let this page and
     * that report credit one job differently.
     *
     * A job created before crediting existed has nothing tagged, and falls
     * back to the customer's history so it still says something.
     */
    let rows = await tx.select().from(schema.marketingTouch)
      .where(and(
        eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
        eq(schema.marketingTouch.jobId, job.id),
      ))
      .orderBy(asc(schema.marketingTouch.occurredAt));
    if (rows.length === 0) {
      rows = await tx.select().from(schema.marketingTouch)
        .where(and(
          eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
          eq(schema.marketingTouch.customerId, job.customerId),
          isNull(schema.marketingTouch.jobId),
        ))
        .orderBy(asc(schema.marketingTouch.occurredAt));
    }

    const touches = rows.map(toCore);
    const models = input.models ?? mk.ATTRIBUTION_MODEL_KEYS;
    const compared = mk.compareModels(models, touches);
    const settings = await acquisition.settingsWithin(tx, ctx.actor.organizationId);

    /** The names behind the ids, so the timeline reads as "Google Ads, Spring AC tune up". */
    const channelIds = [...new Set(rows.map((r) => r.channelId).filter((id): id is string => !!id))];
    const campaignIds = [...new Set(rows.map((r) => r.acquisitionCampaignId).filter((id): id is string => !!id))];
    const channelNames = new Map((channelIds.length === 0 ? [] : await tx.select({
      id: schema.marketingChannel.id, name: schema.marketingChannel.name,
    }).from(schema.marketingChannel).where(inArray(schema.marketingChannel.id, channelIds)))
      .map((c) => [c.id, c.name]));
    const campaignNames = new Map((campaignIds.length === 0 ? [] : await tx.select({
      id: schema.acquisitionCampaign.id, name: schema.acquisitionCampaign.name,
    }).from(schema.acquisitionCampaign).where(inArray(schema.acquisitionCampaign.id, campaignIds)))
      .map((c) => [c.id, c.name]));

    return {
      jobId: job.id,
      /** The company's own model, which the job's lead source columns were filled from. */
      companyModel: settings.attributionModel,
      touchCount: touches.length,
      /**
       * Every touch credited to this job, oldest first: what happened, how we
       * know, and which channel and campaign it belonged to at the time.
       */
      touches: rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt,
        source: row.source,
        sourceLabel: mk.leadSourceLabel(row.source),
        basis: row.basis,
        /** A person chose it on a form, as against a marketplace declaring it. */
        enteredByPerson: row.enteredByUserId !== null,
        channelName: row.channelId ? channelNames.get(row.channelId) ?? null : null,
        campaignName: row.acquisitionCampaignId ? campaignNames.get(row.acquisitionCampaignId) ?? null : null,
        trackedNumberE164: row.trackedNumberE164,
        callId: row.callId,
        utmCampaign: row.utmCampaign,
      })),
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
  /**
   * The catalogue key. Optional when a channel or a tracking campaign is
   * named, because those imply it.
   */
  source?: string | undefined;
  /**
   * `| undefined` on every optional, not just `| null`. Under
   * `exactOptionalPropertyTypes` a zod `.optional()` produces
   * `string | null | undefined` and an absent key is a real state, so a
   * field typed `string | null` here cannot receive one.
   */
  campaign?: string | null | undefined;
  /** The company's channel this money went to. */
  channelId?: string | null | undefined;
  /** The tracking campaign this money went to, which implies the channel. */
  campaignId?: string | null | undefined;
  spentOn: string;
  amount: string;
  impressions?: number | null | undefined;
  clicks?: number | null | undefined;
  origin?: string | undefined;
  externalId?: string | null | undefined;
}

/**
 * The key, channel and campaign of a spend row, made to agree.
 *
 * The same rule a tracking number follows: the campaign implies its channel,
 * the channel implies its key, and the key alone lands on that key's channel.
 * A key nothing can place is refused, because spend under a source no report
 * groups is money that silently drops out of every total.
 */
async function placeSpend(tx: Database, organizationId: string, row: SpendInput) {
  if (row.campaignId || row.channelId) {
    const declared = await acquisition.resolveDeclared(tx, organizationId, {
      channelId: row.channelId, campaignId: row.campaignId,
    });
    return { source: declared!.sourceKey, channelId: declared!.channelId, campaignId: declared!.campaignId };
  }
  if (!row.source || !known.has(row.source)) {
    throw new ConflictError(
      `"${row.source ?? ""}" is not a lead source this product knows, so spend recorded against it would not appear in any summary. `
      + `Use one of: ${mk.LEAD_SOURCE_KEYS.slice(0, 8).join(", ")} and the rest of the catalogue, or name a channel.`,
    );
  }
  return {
    source: row.source,
    channelId: await acquisition.channelForSource(tx, organizationId, row.source),
    campaignId: null as string | null,
  };
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
 *
 * ONE FIGURE PER CHANNEL OR CAMPAIGN PER DAY, typed again to correct it. Found
 * and updated by those columns rather than by the unique index, which keys on
 * the free text campaign label and treats two blank labels as different, so
 * typing Monday's figure twice used to record Monday twice.
 */
export async function recordSpend(ctx: ServiceContext, input: SpendInput) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const placed = await placeSpend(tx, ctx.actor.organizationId, input);
    if (m.isNegative(m.money(input.amount, "USD"))) {
      throw new ConflictError("Spend cannot be negative. A refund or a credit is its own row, not a negative day.");
    }

    const origin = input.origin ?? "manual";
    const [existing] = await tx.select({ id: schema.adSpend.id }).from(schema.adSpend)
      .where(and(
        eq(schema.adSpend.organizationId, ctx.actor.organizationId),
        eq(schema.adSpend.source, placed.source),
        placed.channelId ? eq(schema.adSpend.channelId, placed.channelId) : isNull(schema.adSpend.channelId),
        placed.campaignId
          ? eq(schema.adSpend.acquisitionCampaignId, placed.campaignId)
          : isNull(schema.adSpend.acquisitionCampaignId),
        input.campaign ? eq(schema.adSpend.campaign, input.campaign) : isNull(schema.adSpend.campaign),
        eq(schema.adSpend.spentOn, input.spentOn),
        eq(schema.adSpend.origin, origin),
        isNull(schema.adSpend.deletedAt),
      )).limit(1);

    const values = {
      amount: input.amount,
      impressions: input.impressions ?? null,
      clicks: input.clicks ?? null,
      externalId: input.externalId ?? null,
    };
    const [row] = existing
      ? await tx.update(schema.adSpend).set({ ...values, updatedAt: new Date() })
        .where(eq(schema.adSpend.id, existing.id)).returning()
      : await tx.insert(schema.adSpend).values({
        organizationId: ctx.actor.organizationId,
        source: placed.source,
        channelId: placed.channelId,
        acquisitionCampaignId: placed.campaignId,
        campaign: input.campaign ?? null,
        spentOn: input.spentOn,
        origin,
        ...values,
      }).returning();

    await audit(tx, ctx, "ad_spend.recorded", "ad_spend", row!.id, null, row!);
    return {
      id: row!.id, source: row!.source, campaign: row!.campaign,
      channelId: row!.channelId, campaignId: row!.acquisitionCampaignId,
      spentOn: row!.spentOn, amount: row!.amount, origin: row!.origin,
    };
  });
}

/** Take a spend row out, because it was typed against the wrong day or campaign. */
export async function removeSpend(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const [before] = await tx.select().from(schema.adSpend)
      .where(and(eq(schema.adSpend.organizationId, ctx.actor.organizationId), eq(schema.adSpend.id, input.id)))
      .limit(1);
    if (!before || before.deletedAt) throw new NotFoundError("Spend row");
    await tx.update(schema.adSpend).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.adSpend.id, input.id));
    await audit(tx, ctx, "ad_spend.removed", "ad_spend", input.id, before, null);
    return { id: input.id, removed: true as const };
  });
}

/** Recent spend rows, newest day first, for the screen that enters them. */
export async function listSpend(ctx: ServiceContext, input: { from: string; to: string }) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const rows = await tx.select({
      spend: schema.adSpend,
      channelName: schema.marketingChannel.name,
      campaignName: schema.acquisitionCampaign.name,
    }).from(schema.adSpend)
      .leftJoin(schema.marketingChannel, eq(schema.marketingChannel.id, schema.adSpend.channelId))
      .leftJoin(schema.acquisitionCampaign, eq(schema.acquisitionCampaign.id, schema.adSpend.acquisitionCampaignId))
      .where(and(
        eq(schema.adSpend.organizationId, ctx.actor.organizationId),
        gte(schema.adSpend.spentOn, input.from),
        lte(schema.adSpend.spentOn, input.to),
        isNull(schema.adSpend.deletedAt),
      ))
      .orderBy(desc(schema.adSpend.spentOn), asc(schema.adSpend.createdAt))
      .limit(500);
    return rows.map(({ spend, channelName, campaignName }) => ({
      id: spend.id,
      spentOn: spend.spentOn,
      source: spend.source,
      channelId: spend.channelId,
      channelName,
      campaignId: spend.acquisitionCampaignId,
      campaignName,
      label: spend.campaign,
      amount: spend.amount,
      origin: spend.origin,
    }));
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
 *
 * A row whose campaign label is the name or utm tag of one of the company's
 * tracking campaigns is linked to it, so a Google Ads export lands on "Spring
 * AC tune up" without anybody mapping it, as long as the names agree.
 */
export async function importSpend(
  ctx: ServiceContext,
  input: { origin: string; rows: SpendInput[] },
) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const accepted: string[] = [];
    const refused: { row: number; reason: string }[] = [];
    const campaigns = await tx.select({
      id: schema.acquisitionCampaign.id,
      name: schema.acquisitionCampaign.name,
      utm: schema.acquisitionCampaign.utmCampaign,
    }).from(schema.acquisitionCampaign)
      .where(and(
        eq(schema.acquisitionCampaign.organizationId, ctx.actor.organizationId),
        isNull(schema.acquisitionCampaign.archivedAt),
      ));
    const byLabel = new Map<string, string>();
    for (const c of campaigns) {
      byLabel.set(c.name.toLowerCase(), c.id);
      if (c.utm) byLabel.set(c.utm.toLowerCase(), c.id);
    }

    for (const [index, row] of input.rows.entries()) {
      let placed;
      try {
        const matched = !row.campaignId && row.campaign ? byLabel.get(row.campaign.trim().toLowerCase()) : undefined;
        placed = await placeSpend(tx, ctx.actor.organizationId, {
          ...row,
          ...(matched ? { campaignId: matched, channelId: null } : {}),
        });
      } catch (error) {
        if (!(error instanceof ConflictError) && !(error instanceof NotFoundError)) throw error;
        refused.push({ row: index + 1, reason: error.message });
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
        source: placed.source,
        channelId: placed.channelId,
        acquisitionCampaignId: placed.campaignId,
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
          channelId: placed.channelId,
          acquisitionCampaignId: placed.campaignId,
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

    const { from, to } = await windowOf(tx, ctx.actor.organizationId, input);

    /**
     * One row per source per PERSON, so the count below is of people rather
     * than of page views. A person is the customer, else the number that
     * rang, else the browser (`mk.leadKey`): counting only touches with a
     * customer on them, which this did first, left out every new caller and
     * every form nobody had turned into a customer yet, which are exactly the
     * leads nobody has rung back.
     */
    const leadRows = await tx.selectDistinct({
      source: schema.marketingTouch.source,
      customerId: schema.marketingTouch.customerId,
      callerE164: schema.marketingTouch.callerE164,
      visitorId: schema.marketingTouch.visitorId,
    }).from(schema.marketingTouch)
      .where(and(
        eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
        gte(schema.marketingTouch.occurredAt, from),
        lte(schema.marketingTouch.occurredAt, to),
      ));

    /**
     * Booked value is `REVENUE_SQL`, the one revenue definition every
     * marketing figure shares: what the ledger recognised on the job, net of
     * discounts and credits and without the tax. A job not invoiced yet still
     * counts as booked work at zero value rather than disappearing, because
     * dropping it would make a channel look worse the faster it books.
     */
    const jobRows = await tx.selectDistinct({
      source: schema.marketingTouch.source,
      jobId: schema.marketingTouch.jobId,
    }).from(schema.marketingTouch)
      .innerJoin(schema.job, eq(schema.job.id, schema.marketingTouch.jobId))
      .where(and(
        eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
        gte(schema.marketingTouch.occurredAt, from),
        lte(schema.marketingTouch.occurredAt, to),
      ));
    const revenue = await revenueByJob(tx, [...new Set(jobRows.map((r) => r.jobId!))]);

    const bySource = new Map<string, { leads: Set<string>; jobs: Set<string>; value: m.Money }>();
    const bucket = (source: string) => {
      let entry = bySource.get(source);
      if (!entry) {
        entry = { leads: new Set(), jobs: new Set(), value: m.zero("USD") };
        bySource.set(source, entry);
      }
      return entry;
    };
    for (const row of leadRows) {
      const key = mk.leadKey(row);
      if (key) bucket(row.source).leads.add(key);
    }
    for (const row of jobRows) {
      const entry = bucket(row.source);
      /**
       * A set, because one job reached by three touches from the same source
       * is one job. Adding it three times is the same flattering error as
       * counting touches for leads, one table further along.
       */
      if (!entry.jobs.has(row.jobId!)) {
        entry.jobs.add(row.jobId!);
        entry.value = m.add(entry.value, revenue.get(row.jobId!) ?? m.zero("USD"));
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
            leads: entry?.leads.size ?? 0,
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
    companyModel: string;
    touchCount: number;
    touches: {
      id: string; occurredAt: Date; source: string; sourceLabel: string; basis: string;
      enteredByPerson: boolean; channelName: string | null; campaignName: string | null;
      trackedNumberE164: string | null; callId: string | null; utmCampaign: string | null;
    }[];
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

  listSpend: async (ctx: ServiceContext, input: { from: string; to: string }) =>
    ({ spend: await listSpend(ctx, input) }),

  removeSpend: (ctx: ServiceContext, input: { id: string }) => removeSpend(ctx, input),

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

/* ------------------------------------------------- closing the loop back */

export interface ConversionRow {
  /** The click the ads platform will match on. */
  clickId: string;
  /** Which platform's click it is, so the right file is produced. */
  source: string;
  /** When the work was won, not when the click happened. */
  convertedAt: Date;
  /** This source's SHARE of the job, not the whole invoice. */
  value: string;
  jobId: string;
}

/**
 * WHAT TO TELL THE AD ACCOUNT, AND WHY IT IS THE POINT OF ALL OF THIS
 *
 * An ads platform optimises towards whatever it is told a conversion is. Left
 * alone it is told about form fills, so it learns to buy form fills, and a
 * contractor ends up paying more and more for people who were never going to
 * book. The platform is not wrong; it is doing exactly what it was asked.
 *
 * The fix is to report the JOB rather than the enquiry, with the money on it,
 * against the click id that produced it. Then the account bids towards work.
 * That single loop is worth more than every report in this module, and it is
 * the reason the click id was worth a schema change.
 *
 * THE VALUE IS THE SOURCE'S SHARE, NOT THE INVOICE.
 *
 * A job touched by Google and by Meta is reported to each at a fraction, and
 * `creditRevenue` splits it by allocation so the parts sum to the invoice
 * exactly. Sending the full amount to both, which is what most setups do
 * because it is easier, tells each platform it produced twice the revenue it
 * did, and both then bid as though the work were worth double.
 *
 * WHICH MODEL SPLITS IT IS THE CALLER'S CHOICE, and it has to be, because
 * this is the one place a modelling choice becomes real money spent. The
 * default is `position_based` only because something has to be, and the API
 * makes the caller see the name of what they picked.
 */
export async function conversions(
  ctx: ServiceContext,
  input: { from: string; to: string; model?: mk.AttributionModelKey },
): Promise<ConversionRow[]> {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const model = input.model ?? "position_based";
    const { from, to } = await windowOf(tx, ctx.actor.organizationId, input);

    /**
     * Jobs that were WON in the period, rather than touches that happened in
     * it. A conversion is reported at the moment work was booked; the clicks
     * behind it are often months older, and filtering on their dates would
     * leave out exactly the long considered purchases a contractor most
     * wants their account to bid on.
     */
    const jobRows = await tx.selectDistinct({
      jobId: schema.job.id,
      customerId: schema.job.customerId,
      createdAt: schema.job.createdAt,
    }).from(schema.job)
      .innerJoin(schema.marketingTouch, eq(schema.marketingTouch.jobId, schema.job.id))
      .where(and(
        eq(schema.job.organizationId, ctx.actor.organizationId),
        gte(schema.job.createdAt, from),
        lte(schema.job.createdAt, to),
      ));

    if (jobRows.length === 0) return [];

    /**
     * Jobs a connected Google Ads or Meta has been sent, or is being sent,
     * as a purchase, keyed by the lead source the file groups by.
     */
    const sends = await tx.select({ provider: schema.adConversionSend.provider, jobId: schema.adConversionSend.jobId })
      .from(schema.adConversionSend).where(and(
        eq(schema.adConversionSend.organizationId, ctx.actor.organizationId),
        eq(schema.adConversionSend.kind, "purchase"),
        inArray(schema.adConversionSend.state, ["sent", "sending"]),
        inArray(schema.adConversionSend.jobId, jobRows.map((j) => j.jobId)),
      ));
    const sentByConnector = new Set(sends.map((row) => `${row.provider}:${row.jobId}`));

    /**
     * A customer who said their details are not to be used for advertising has
     * nothing about them told to any platform, not even the click, and a file
     * the office uploads by hand is no different from a connection sending it:
     * a click id beside a booked job is the customer whatever the platform
     * calls it. So their jobs are left out of every file.
     */
    const refusedCustomers = new Set((await tx.select({ customerId: schema.advertisingConsent.customerId })
      .from(schema.advertisingConsent)
      .where(and(
        eq(schema.advertisingConsent.organizationId, ctx.actor.organizationId),
        eq(schema.advertisingConsent.choice, "refused"),
        isNull(schema.advertisingConsent.supersededAt),
      ))).map((row) => row.customerId));

    const out: ConversionRow[] = [];

    for (const job of jobRows) {
      if (refusedCustomers.has(job.customerId)) continue;
      /**
       * The revenue every marketing figure uses (`REVENUE_SQL`), so the value
       * told to Google is the value on the marketing report, without the
       * sales tax an invoice total carries.
       *
       * A job with nothing invoiced yet is SKIPPED rather than reported at
       * zero. A zero conversion teaches the account that this click produced
       * nothing, which is the opposite of true and is a lesson it will act
       * on. The job will be picked up by a later export once it is
       * invoiced, and the platforms accept a conversion dated in the past.
       */
      const value = (await revenueByJob(tx, [job.jobId])).get(job.jobId);
      if (!value || !m.isPositive(value)) continue;

      /**
       * The touches credited to THIS job, which `creditWork` tagged, rather
       * than the customer's whole history: a repeat customer's second job
       * must not report the click that won their first.
       */
      const rows = await tx.select().from(schema.marketingTouch)
        .where(and(
          eq(schema.marketingTouch.organizationId, ctx.actor.organizationId),
          eq(schema.marketingTouch.jobId, job.jobId),
        ))
        .orderBy(asc(schema.marketingTouch.occurredAt));

      const decision = mk.attribute(model, rows.map(toCore));
      if (!decision.ok) continue;

      const shares = mk.creditRevenue(decision.credits, value);
      const shareOf = new Map(shares.map((s) => [s.source, s.amount]));

      /**
       * One row per CLICK ID, not per source. A customer who clicked the
       * same campaign three times has three click ids and only one of them
       * is the one the platform recorded the conversion window against; the
       * platform matches on the id and ignores the rest, so sending them all
       * is correct and sending a guess is not.
       *
       * The share is divided again across that source's own click ids, so a
       * source's total across the file is still its share of the invoice.
       */
      const bySource = new Map<string, string[]>();
      for (const row of rows) {
        if (!row.clickId) continue;
        const list = bySource.get(row.source) ?? [];
        if (!list.includes(row.clickId)) list.push(row.clickId);
        bySource.set(row.source, list);
      }

      for (const [source, clickIds] of bySource) {
        const share = shareOf.get(source as mk.LeadSourceKey);
        if (!share) continue;
        /**
         * A job already told to the platform by its connector is left out of
         * the file, so uploading the file as well cannot count it twice.
         */
        if (sentByConnector.has(`${source}:${job.jobId}`)) continue;
        const perClick = m.allocate(share, clickIds.map(() => "1"), 2);
        clickIds.forEach((clickId, index) => {
          out.push({
            clickId,
            source,
            convertedAt: job.createdAt,
            value: m.toString(perClick[index] ?? m.zero("USD")),
            jobId: job.jobId,
          });
        });
      }
    }

    return out;
  });
}

/**
 * The conversions as the file each platform takes.
 *
 * A file rather than an API call, for the same reason the spend import is a
 * file: it works today, with no developer token and no consent screen, and
 * both Google Ads and Meta accept an offline conversion upload in exactly
 * this shape. An operator who can get API access should have it; one who
 * cannot should still be able to close the loop.
 *
 * The header names are the platforms' own, verbatim, because their importers
 * match on them and a helpful rename means a file that is rejected with a
 * message about a missing column.
 */
export function conversionsCsv(
  rows: readonly ConversionRow[],
  platform: "google" | "meta" | "microsoft",
): string {
  if (platform === "microsoft") {
    /**
     * Microsoft Advertising's offline conversion template, by its own header
     * names. The goal named has to be an offline conversion goal made in the
     * account first, spelled exactly as it is there, and the time is UTC (the
     * web importer offers a time zone; this file is written so it needs none).
     * "Booked job" is the same name the Google file uses, so one name is
     * made in each account.
     */
    return [
      "Microsoft Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency",
      ...rows
        .filter((row) => row.source === "bing_ads")
        .map((row) => [
          row.clickId,
          "Booked job",
          row.convertedAt.toISOString().slice(0, 19) + "Z",
          row.value,
          "USD",
        ].join(",")),
    ].join("\n");
  }

  if (platform === "google") {
    const lines = [
      "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency",
      ...rows
        .filter((row) => row.source === "google_ads" || row.source === "google_lsa")
        .map((row) =>
          [
            row.clickId,
            "Booked job",
            /**
             * Google's importer wants an explicit offset. UTC is written as
             * +0000 rather than the `Z` an ISO string ends with, because
             * their parser rejects `Z` and the error says only "invalid
             * date".
             */
            `${row.convertedAt.toISOString().slice(0, 19).replace("T", " ")}+0000`,
            row.value,
            "USD",
          ].join(","),
        ),
    ];
    return lines.join("\n");
  }

  return [
    "fbclid,event_name,event_time,value,currency",
    ...rows
      .filter((row) => row.source === "meta_ads")
      .map((row) =>
        [
          row.clickId,
          "Purchase",
          /** Meta takes a unix timestamp in seconds. */
          String(Math.floor(row.convertedAt.getTime() / 1000)),
          row.value,
          "USD",
        ].join(","),
      ),
  ].join("\n");
}

/**
 * The conversions handler, which returns the file as well as the rows.
 *
 * Both, rather than one or the other, because the two readers are different
 * people: an integration wants the rows, and the operator about to upload a
 * file to Google wants the file. Making them call twice, or making the
 * integration parse a CSV, would serve neither.
 */
export const conversionHandlers = {
  getConversions: async (ctx: ServiceContext, input: {
    from: string; to: string;
    model?: ("first_touch" | "last_touch" | "last_non_direct" | "linear" | "position_based") | undefined;
    format?: ("google" | "meta" | "microsoft") | undefined;
  }): Promise<{
    model: string;
    rows: { clickId: string; source: string; convertedAt: Date; value: string; jobId: string }[];
    csv?: string;
  }> => {
    const model = input.model ?? "position_based";
    const rows = await conversions(ctx, { from: input.from, to: input.to, model });
    return {
      model,
      rows,
      ...(input.format ? { csv: conversionsCsv(rows, input.format) } : {}),
    };
  },
} as const;
