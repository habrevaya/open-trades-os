import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ads, isSystem, marketing as mk, money as m } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import * as acquisition from "./acquisition";
import { revenueByJob, touchToCore } from "./marketing";
import {
  adsActor, adapterFor, runPull, type AdsDeps, type Connection, type PullOutcome,
} from "./ad-platforms";
import {
  AuthorizationLostError, PlatformRefusedError, type OutboundEvent,
} from "../ads/index";

/**
 * TELLING THE ACCOUNT WHICH CLICKS BECAME WORK, BY ITSELF
 *
 * The conversion file has existed since attribution did: download it, upload
 * it to Google, remember to do it again next week. Nobody remembers. With a
 * platform connected and sending switched on, this does it: a LEAD the moment
 * a job is booked (to Meta and Google Analytics) and a PURCHASE the moment a
 * job's invoices are all paid (to Google Ads, Microsoft Advertising, Meta and Google Analytics), with
 * the revenue on it.
 *
 * FOUR RULES, each of which costs money or trust when broken.
 *
 *   ONCE. One row per job, per platform, per kind, under a unique index,
 *   written BEFORE the request goes. A second worker, a retry and a person
 *   pressing "Send now" all find the row. And the platform deduplicates too,
 *   on the event id the row carries, for the one window an index cannot
 *   close: the request succeeded and the process died before writing so.
 *
 *   ONLY TO THE PLATFORM THAT EARNED IT. A job is told to Google only when one
 *   of its own touches came from Google, and its value is Google's share of
 *   the job's revenue under the company's attribution model, which for a job
 *   only Google touched is all of it. Telling every platform about every job
 *   at full value is the common setup and it lets two platforms each claim
 *   the same furnace and bid as though they had sold two.
 *
 *   ONLY WHAT CONSENT ALLOWS. Core decides, per send, from the company's
 *   setting on the connection and the customer's own answer: a customer who
 *   said no has nothing sent, not even a click id.
 *
 *   EVERYTHING WRITTEN DOWN, including what was withheld and why, by name.
 *   Never the values: no hashed email is stored, because a table of hashes is
 *   a table of emails to anybody with a list to hash.
 */

const BATCH = 50;
/** A claim this old belongs to a worker that died mid send. Safe to send again: the platform dedupes on the event id. */
const STUCK_MS = 10 * 60_000;
const GOOGLE_CLICKS = new Set(["gclid", "gbraid", "wbraid"]);

type SendRow = typeof schema.adConversionSend.$inferSelect;

const settingsOf = (row: Connection) => (row.settings ?? {}) as Record<string, unknown>;

function modeOf(row: Connection): ads.PersonalDataMode {
  const value = settingsOf(row)["personalData"];
  return (ads.PERSONAL_DATA_MODES as readonly unknown[]).includes(value)
    ? value as ads.PersonalDataMode : ads.DEFAULT_PERSONAL_DATA_MODE;
}

/** Why sending is not happening for a connection, or null when it is set up to send. */
export function notSending(row: Connection): string | null {
  const settings = settingsOf(row);
  if (!ads.isAdsProvider(row.provider) || ads.PROVIDERS[row.provider].sends.length === 0) return "This platform is not sent conversions.";
  if (settings["sendConversions"] === false) return "Sending is switched off on this connection.";
  const has = (key: string) => typeof settings[key] === "string" && (settings[key] as string).trim() !== "";
  if (row.provider === "google_ads" && !has("conversionActionId")) return "No conversion action is chosen.";
  if (row.provider === "meta_ads" && !has("pixelId")) return "No pixel id is entered.";
  if (row.provider === "ga4" && !has("measurementId")) return "No measurement id is entered.";
  if (row.provider === "bing_ads" && !has("conversionName")) return "No offline conversion goal is named.";
  return null;
}

/** Whether a touch's click id is one this platform matches on. */
function clickFor(provider: ads.AdsProvider, touch: typeof schema.marketingTouch.$inferSelect): boolean {
  if (!touch.clickId) return false;
  if (provider === "google_ads") {
    return touch.clickIdParam ? GOOGLE_CLICKS.has(touch.clickIdParam) : touch.source === "google_ads";
  }
  if (provider === "meta_ads") return touch.clickIdParam ? touch.clickIdParam === "fbclid" : touch.source === "meta_ads";
  if (provider === "bing_ads") return touch.clickIdParam ? touch.clickIdParam === "msclkid" : touch.source === "bing_ads";
  return false;
}

type Prepared =
  | { send: true; event: OutboundEvent; customerId: string | null; value: string | null; clickId: string | null; identifiers: ads.Identifier[]; adUserData: string }
  | { send: false; reason: ads.WithheldReason; because: string; customerId: string | null; value: string | null };

/**
 * Everything one send needs, decided now: the value, the click, the consent,
 * the hashed identifiers. Run again for a retry, so a customer who said no
 * between a failed send and its retry is withheld rather than sent.
 */
async function prepare(
  tx: Database, row: Connection, kind: ads.EventKind, jobId: string, now: Date,
): Promise<Prepared> {
  const org = row.organizationId;
  const provider = row.provider as ads.AdsProvider;
  const [job] = await tx.select({ id: schema.job.id, customerId: schema.job.customerId, createdAt: schema.job.createdAt })
    .from(schema.job).where(and(eq(schema.job.organizationId, org), eq(schema.job.id, jobId))).limit(1);
  if (!job) throw new NotFoundError("Job");
  const touches = await tx.select().from(schema.marketingTouch)
    .where(and(eq(schema.marketingTouch.organizationId, org), eq(schema.marketingTouch.jobId, jobId)))
    .orderBy(asc(schema.marketingTouch.occurredAt));
  const [company] = await tx.select({ currency: schema.organization.currency })
    .from(schema.organization).where(eq(schema.organization.id, org)).limit(1);
  const currency = company?.currency ?? "USD";

  /* The value: the whole revenue for analytics, this platform's share of it for an ad platform. */
  let value: m.Money | null = null;
  if (kind === "purchase") {
    const revenue = (await revenueByJob(tx, [jobId])).get(jobId);
    if (!revenue || !m.isPositive(revenue)) {
      return { send: false, reason: "nothing_invoiced", because: ads.WITHHELD.nothing_invoiced, customerId: job.customerId, value: null };
    }
    value = revenue;
  }
  if (provider !== "ga4") {
    const model = (await acquisition.settingsWithin(tx, org)).attributionModel;
    const decision = mk.attribute(model, touches.map(touchToCore));
    const credited = decision.ok
      ? decision.credits.filter((c) => ads.answersFor(provider, c.source) && c.parts > 0)
      : [];
    if (credited.length === 0) {
      return { send: false, reason: "no_credit", because: ads.WITHHELD.no_credit, customerId: job.customerId, value: null };
    }
    if (value && decision.ok) {
      const shares = mk.creditRevenue(decision.credits, value);
      value = shares.filter((s) => ads.answersFor(provider, s.source))
        .reduce((sum, s) => m.add(sum, s.amount), m.zero(value.currency));
      if (!m.isPositive(value)) {
        return { send: false, reason: "no_credit", because: ads.WITHHELD.no_credit, customerId: job.customerId, value: null };
      }
    }
  }

  /* What the platform could match on. The latest of each, which is the one nearest the work. */
  const latest = <T>(list: T[], pick: (t: T) => boolean) => [...list].reverse().find(pick) ?? null;
  const click = latest(touches, (t) => clickFor(provider, t));
  let clientId = latest(touches, (t) => t.gaClientId !== null)?.gaClientId ?? null;
  let browserId = latest(touches, (t) => t.metaBrowserId !== null)?.metaBrowserId ?? null;
  if ((!clientId || !browserId) && job.customerId) {
    const theirs = await tx.select({ ga: schema.marketingTouch.gaClientId, fbp: schema.marketingTouch.metaBrowserId })
      .from(schema.marketingTouch)
      .where(and(eq(schema.marketingTouch.organizationId, org), eq(schema.marketingTouch.customerId, job.customerId)))
      .orderBy(desc(schema.marketingTouch.occurredAt)).limit(50);
    clientId ??= theirs.find((t) => t.ga)?.ga ?? null;
    browserId ??= theirs.find((t) => t.fbp)?.fbp ?? null;
  }
  const [customer] = job.customerId
    ? await tx.select({ email: schema.customer.email, phone: schema.customer.phone })
      .from(schema.customer).where(eq(schema.customer.id, job.customerId)).limit(1)
    : [];
  const [choice] = job.customerId
    ? await tx.select({ choice: schema.advertisingConsent.choice }).from(schema.advertisingConsent)
      .where(and(eq(schema.advertisingConsent.customerId, job.customerId), isNull(schema.advertisingConsent.supersededAt)))
      .limit(1)
    : [];

  const flavour: ads.Flavour = provider === "meta_ads" ? "meta" : "google";
  const email = ads.normaliseEmail(customer?.email, flavour);
  const phone = ads.normalisePhone(customer?.phone, flavour);
  const decided = ads.decideShare({
    provider,
    mode: modeOf(row),
    choice: choice?.choice ?? null,
    have: { click_id: click !== null, email: email !== null, phone: phone !== null, client_id: clientId !== null, browser_id: browserId !== null },
  });
  const valueText = value ? m.toString(m.round(value, 2)) : null;
  if (!decided.send) return { ...decided, customerId: job.customerId, value: valueText };

  /** When the work was won: paid for a purchase, booked for a lead. */
  let at = job.createdAt;
  if (kind === "purchase") {
    const [paid] = await tx.select({ at: sql<Date>`max(${schema.invoice.updatedAt})` }).from(schema.invoice)
      .where(and(eq(schema.invoice.jobId, jobId), eq(schema.invoice.status, "paid"), isNull(schema.invoice.deletedAt)));
    if (paid?.at) at = new Date(paid.at);
  }
  if (at > now) at = now;

  const uses = new Set(decided.identifiers);
  return {
    send: true,
    customerId: job.customerId,
    value: valueText,
    clickId: uses.has("click_id") ? click!.clickId : null,
    identifiers: decided.identifiers,
    adUserData: decided.adUserData,
    event: {
      eventId: ads.eventId(kind, jobId),
      kind,
      at,
      value: valueText,
      currency,
      clickId: uses.has("click_id") ? click!.clickId : null,
      clickParam: uses.has("click_id") ? click!.clickIdParam : null,
      clickSeenAt: uses.has("click_id") ? click!.occurredAt : null,
      hashedEmail: uses.has("email") ? await ads.sha256Hex(email!) : null,
      hashedPhone: uses.has("phone") ? await ads.sha256Hex(phone!) : null,
      clientId: uses.has("client_id") ? clientId : null,
      browserId: uses.has("browser_id") ? browserId : null,
      adUserData: decided.adUserData,
    },
  };
}

/**
 * Jobs due a send of this kind to this platform and not yet written down.
 *
 * Jobs carried in from another system are left out: their history is a
 * record, and reporting a 2023 furnace to this year's ad account would teach
 * it about work it never bought.
 */
async function candidates(tx: Database, row: Connection, kind: ads.EventKind, now: Date): Promise<string[]> {
  const provider = row.provider as ads.AdsProvider;
  const answers = ads.PROVIDERS[provider].answersFor;
  const since = new Date(now.getTime() - ads.LOOKBACK_DAYS[kind] * 86_400_000);
  const sourceFilter = answers === "any"
    ? sql`true`
    : answers.length === 0 ? sql`false` : sql`t.source in (${sql.join(answers.map((a) => sql`${a}`), sql`, `)})`;
  const paid = kind === "purchase"
    ? sql`and exists (select 1 from public.invoice i where i.job_id = j.id and i.deleted_at is null
            and i.status in ('open', 'partially_paid', 'paid'))
          and not exists (select 1 from public.invoice i where i.job_id = j.id and i.deleted_at is null
            and i.status in ('open', 'partially_paid'))`
    : sql``;
  const rows = await tx.execute<{ id: string }>(sql`
    select j.id from public.job j
     where j.organization_id = ${row.organizationId}
       and j.deleted_at is null
       and j.status <> 'cancelled'
       and j.source_id is null
       and j.created_at >= ${since.toISOString()}::timestamptz
       and exists (select 1 from public.marketing_touch t where t.job_id = j.id and ${sourceFilter})
       ${paid}
       and not exists (select 1 from public.ad_conversion_send s
                        where s.organization_id = j.organization_id and s.provider = ${provider}
                          and s.kind = ${kind} and s.job_id = j.id)
     order by j.created_at
     limit ${BATCH}`);
  return [...rows].map((r) => r.id);
}

/**
 * One pass of sends for one connection: new jobs, and retries that are due.
 *
 * Claims are written first, each in the same transaction that decided it;
 * the requests go after the commit, outside any transaction; the outcomes are
 * written after that. A crash between the second and third leaves rows in
 * `sending`, which a later pass picks up after ten minutes and sends again,
 * harmlessly, because the platform has the event id.
 */
export async function sendConversions(db: Database, row: Connection, deps: AdsDeps = {}): Promise<PullOutcome> {
  const provider = row.provider as ads.AdsProvider;
  const ctx: ServiceContext = { actor: adsActor(row.organizationId), db };
  const now = (deps.now ?? (() => new Date()))();

  return runPull(db, row, "conversions", async () => {
    if (notSending(row)) return { read: 0, written: 0 };
    const spec = ads.PROVIDERS[provider];

    const claimed = await inTenant(ctx, async (tx) => {
      const out: { id: string; event: OutboundEvent }[] = [];
      let considered = 0;
      for (const kind of spec.sends) {
        for (const jobId of await candidates(tx, row, kind, now)) {
          considered += 1;
          const prepared = await prepare(tx, row, kind, jobId, now);
          const [written] = await tx.insert(schema.adConversionSend).values({
            organizationId: row.organizationId,
            connectionId: row.id,
            provider,
            kind,
            jobId,
            customerId: prepared.customerId,
            state: prepared.send ? "sending" : "withheld",
            eventId: ads.eventId(kind, jobId),
            value: prepared.value,
            currency: prepared.send ? prepared.event.currency : null,
            identifiers: prepared.send ? prepared.identifiers : [],
            clickId: prepared.send ? prepared.clickId : null,
            adUserData: prepared.send ? prepared.adUserData : null,
            withheldReason: prepared.send ? null : prepared.reason,
            detail: prepared.send ? null : prepared.because,
          }).onConflictDoNothing().returning({ id: schema.adConversionSend.id });
          if (written && prepared.send) out.push({ id: written.id, event: prepared.event });
        }
      }

      /** Retries that are due, and claims a dead worker left behind. */
      const due = await tx.select().from(schema.adConversionSend).where(and(
        eq(schema.adConversionSend.organizationId, row.organizationId),
        eq(schema.adConversionSend.provider, provider),
        or(
          and(eq(schema.adConversionSend.state, "failed"), lte(schema.adConversionSend.nextAttemptAt, now)),
          and(eq(schema.adConversionSend.state, "sending"), lt(schema.adConversionSend.updatedAt, new Date(now.getTime() - STUCK_MS))),
        ),
      )).limit(BATCH);
      const claimedNow = new Set(out.map((c) => c.id));
      for (const send of due) {
        /** A row claimed a moment ago in this same pass is not a dead worker's. */
        if (claimedNow.has(send.id)) continue;
        considered += 1;
        const prepared = await prepare(tx, row, send.kind, send.jobId, now).catch(() => null);
        if (!prepared || !prepared.send) {
          await tx.update(schema.adConversionSend).set({
            state: "withheld",
            withheldReason: prepared && !prepared.send ? prepared.reason : null,
            detail: prepared && !prepared.send ? prepared.because : "The job is gone.",
            nextAttemptAt: null, updatedAt: new Date(),
          }).where(eq(schema.adConversionSend.id, send.id));
          continue;
        }
        await tx.update(schema.adConversionSend).set({
          state: "sending", identifiers: prepared.identifiers, clickId: prepared.clickId,
          adUserData: prepared.adUserData, value: prepared.value, nextAttemptAt: null, updatedAt: new Date(),
        }).where(eq(schema.adConversionSend.id, send.id));
        out.push({ id: send.id, event: prepared.event });
      }
      return { out, considered };
    });

    if (claimed.out.length === 0) return { read: claimed.considered, written: 0 };

    let outcomes: Map<string, { ok: boolean; message: string | null }>;
    let failedWith: Error | null = null;
    try {
      const adapter = await adapterFor(db, row, deps);
      const answers = await adapter.sendEvents!(claimed.out.map((c) => c.event));
      outcomes = new Map(answers.map((a) => [a.eventId, { ok: a.ok, message: a.ok ? null : a.message }]));
    } catch (error) {
      failedWith = error as Error;
      outcomes = new Map();
    }

    let sent = 0;
    await inTenant(ctx, async (tx) => {
      for (const { id, event } of claimed.out) {
        const [current] = await tx.select({ attempts: schema.adConversionSend.attempts }).from(schema.adConversionSend)
          .where(eq(schema.adConversionSend.id, id)).limit(1);
        const attempts = (current?.attempts ?? 0) + 1;
        const outcome = outcomes.get(event.eventId);
        if (outcome?.ok) {
          sent += 1;
          await tx.update(schema.adConversionSend).set({
            state: "sent", attempts, sentAt: new Date(), detail: null, nextAttemptAt: null, updatedAt: new Date(),
          }).where(eq(schema.adConversionSend.id, id));
        } else if (outcome || failedWith instanceof PlatformRefusedError) {
          await tx.update(schema.adConversionSend).set({
            state: "refused", attempts, detail: (outcome?.message ?? failedWith!.message).slice(0, 1000),
            nextAttemptAt: null, updatedAt: new Date(),
          }).where(eq(schema.adConversionSend.id, id));
        } else {
          const retry = failedWith instanceof AuthorizationLostError
            ? new Date(now.getTime() + 5 * 60_000)
            : ads.retryAt(attempts, now);
          await tx.update(schema.adConversionSend).set({
            state: "failed", attempts,
            detail: retry
              ? (failedWith?.message ?? "No answer for this event.").slice(0, 1000)
              : `Tried ${attempts} times and never got through: ${failedWith?.message ?? "no answer"}`.slice(0, 1000),
            nextAttemptAt: retry, updatedAt: new Date(),
          }).where(eq(schema.adConversionSend.id, id));
        }
      }
      await audit(tx, ctx, "ad_conversions.sent", "integration_connection", row.id, null, {
        provider, attempted: claimed.out.length, sent,
      });
    });
    /** The grant being gone is the connection's problem, not these sends': rethrown so the pull marks it. */
    if (failedWith instanceof AuthorizationLostError) throw failedWith;
    return { read: claimed.considered, written: sent };
  });
}

/* ------------------------------------------------------------ the ledger */

export interface SendView {
  id: string;
  provider: string;
  providerLabel: string;
  kind: string;
  state: string;
  jobId: string;
  jobNumber: number | null;
  customerId: string | null;
  customerName: string | null;
  value: string | null;
  currency: string | null;
  identifiers: string[];
  withheldReason: string | null;
  detail: string | null;
  attempts: number;
  sentAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

/** Every send, newest first: what went, what was withheld and why, what the platform refused and in its words. */
export async function listSends(ctx: ServiceContext, input: {
  state?: string | undefined; provider?: string | undefined; jobId?: string | undefined; limit?: number | undefined;
}): Promise<SendView[]> {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const states = ["sending", "sent", "withheld", "refused", "failed"] as const;
    const state = states.find((s) => s === input.state);
    const rows = await tx.select({
      send: schema.adConversionSend, number: schema.job.number, customerName: schema.customer.name,
    }).from(schema.adConversionSend)
      .leftJoin(schema.job, eq(schema.job.id, schema.adConversionSend.jobId))
      .leftJoin(schema.customer, eq(schema.customer.id, schema.adConversionSend.customerId))
      .where(and(
        eq(schema.adConversionSend.organizationId, ctx.actor.organizationId),
        ...(state ? [eq(schema.adConversionSend.state, state)] : []),
        ...(input.provider ? [eq(schema.adConversionSend.provider, input.provider)] : []),
        ...(input.jobId ? [eq(schema.adConversionSend.jobId, input.jobId)] : []),
      ))
      .orderBy(desc(schema.adConversionSend.createdAt))
      .limit(Math.min(input.limit ?? 200, 500));
    return rows.map(({ send, number, customerName }) => ({
      id: send.id,
      provider: send.provider,
      providerLabel: ads.isAdsProvider(send.provider) ? ads.PROVIDERS[send.provider].label : send.provider,
      kind: send.kind,
      state: send.state,
      jobId: send.jobId,
      jobNumber: number,
      customerId: send.customerId,
      customerName,
      value: send.value,
      currency: send.currency,
      identifiers: send.identifiers,
      withheldReason: send.withheldReason,
      detail: send.detail,
      attempts: send.attempts,
      sentAt: send.sentAt?.toISOString() ?? null,
      nextAttemptAt: send.nextAttemptAt?.toISOString() ?? null,
      createdAt: send.createdAt.toISOString(),
    }));
  });
}

/**
 * Try a send again: one the platform refused once its cause is fixed, one
 * that ran out of attempts, or one withheld for a reason that has changed
 * (the customer said yes after all). Decided afresh on the next pass, consent
 * included. A send that went is refused, because sending it again is the
 * double count this table exists to prevent.
 */
export async function retrySend(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; state: string }> {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const again = await replayed<{ id: string; state: string }>(tx, ctx, "ad_conversion_send");
    if (again) return again;
    const [row] = await tx.select().from(schema.adConversionSend).where(and(
      eq(schema.adConversionSend.organizationId, ctx.actor.organizationId), eq(schema.adConversionSend.id, input.id),
    )).limit(1);
    if (!row) throw new NotFoundError("Conversion send");
    if (row.state === "sent") {
      throw new ConflictError("This one reached the platform already. Sending it again would count the job twice.");
    }
    if (row.state === "sending") throw new ConflictError("This one is being sent right now.");
    await tx.update(schema.adConversionSend).set({
      state: "failed", attempts: 0, nextAttemptAt: new Date(), updatedAt: new Date(),
    }).where(eq(schema.adConversionSend.id, row.id));
    await audit(tx, ctx, "ad_conversion.retried", "ad_conversion_send", row.id, { state: row.state }, { state: "failed" });
    const answer = { id: row.id, state: "failed" };
    await remember(tx, ctx, "ad_conversion_send", row.id, answer);
    return answer;
  });
}

/* ------------------------------------------------- the customer's own answer */

export interface AdChoiceView {
  customerId: string;
  choice: ads.AdDataChoice | null;
  method: string | null;
  proofText: string | null;
  capturedAt: string | null;
  history: { choice: string; method: string; capturedAt: string; supersededAt: string | null }[];
}

export async function adChoice(ctx: ServiceContext, input: { customerId: string }): Promise<AdChoiceView> {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const [customer] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(eq(schema.customer.organizationId, ctx.actor.organizationId), eq(schema.customer.id, input.customerId))).limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const rows = await tx.select().from(schema.advertisingConsent)
      .where(eq(schema.advertisingConsent.customerId, input.customerId))
      .orderBy(desc(schema.advertisingConsent.capturedAt)).limit(20);
    const live = rows.find((r) => r.supersededAt === null);
    return {
      customerId: input.customerId,
      choice: live?.choice ?? null,
      method: live?.method ?? null,
      proofText: live?.proofText ?? null,
      capturedAt: live?.capturedAt.toISOString() ?? null,
      history: rows.map((r) => ({
        choice: r.choice, method: r.method, capturedAt: r.capturedAt.toISOString(),
        supersededAt: r.supersededAt?.toISOString() ?? null,
      })),
    };
  });
}

/**
 * Record what a customer said about their details being used to measure
 * advertising. Superseding, never editing: the earlier answer stays with who
 * recorded it. A "no" stops every future send about them; what already went
 * cannot be called back from a platform, and the screen says so.
 */
export async function setAdChoice(ctx: ServiceContext, input: {
  customerId: string; choice: ads.AdDataChoice;
  method?: "verbal" | "written" | "web_form" | "api" | undefined; proofText?: string | undefined;
}): Promise<AdChoiceView> {
  await guardedWrite(ctx, "customer:write", async (tx) => {
    const [customer] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(eq(schema.customer.organizationId, ctx.actor.organizationId), eq(schema.customer.id, input.customerId))).limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const [before] = await tx.select().from(schema.advertisingConsent)
      .where(and(eq(schema.advertisingConsent.customerId, input.customerId), isNull(schema.advertisingConsent.supersededAt)))
      .for("update").limit(1);
    if (before?.choice === input.choice) return;
    const now = new Date();
    if (before) {
      await tx.update(schema.advertisingConsent).set({ supersededAt: now, updatedAt: now })
        .where(eq(schema.advertisingConsent.id, before.id));
    }
    const [row] = await tx.insert(schema.advertisingConsent).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.customerId,
      choice: input.choice,
      method: input.method ?? "verbal",
      proofText: input.proofText?.trim() || null,
      capturedAt: now,
      capturedByUserId: ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId,
    }).returning();
    await audit(tx, ctx, "customer.ad_data_choice", "customer", input.customerId,
      before ? { choice: before.choice } : null, { choice: row!.choice, method: row!.method });
  });
  return adChoice(ctx, { customerId: input.customerId });
}

/* -------------------------------------------------------- restating a send */

/** How far back a sent purchase is watched for a change in what the job is worth. */
const RESTATE_DAYS = 90;

/**
 * This platform's share of a job's revenue now, to the cent, by the same rules
 * the first send was valued by: the whole recognised revenue, split under the
 * company's attribution model, this platform's part of it. Zero when nothing
 * is left or the model now gives it none.
 */
async function shareNow(tx: Database, row: Connection, jobId: string): Promise<string> {
  const org = row.organizationId;
  const provider = row.provider as ads.AdsProvider;
  const revenue = (await revenueByJob(tx, [jobId])).get(jobId);
  if (!revenue || !m.isPositive(revenue)) return "0.00";
  const touches = await tx.select().from(schema.marketingTouch)
    .where(and(eq(schema.marketingTouch.organizationId, org), eq(schema.marketingTouch.jobId, jobId)))
    .orderBy(asc(schema.marketingTouch.occurredAt));
  const model = (await acquisition.settingsWithin(tx, org)).attributionModel;
  const decision = mk.attribute(model, touches.map(touchToCore));
  if (!decision.ok) return "0.00";
  const share = mk.creditRevenue(decision.credits, revenue)
    .filter((s) => ads.answersFor(provider, s.source))
    .reduce((sum, s) => m.add(sum, s.amount), m.zero(revenue.currency));
  return m.isPositive(share) ? m.toString(m.round(share, 2)) : "0.00";
}

type AdjustmentRow = typeof schema.adConversionAdjustment.$inferSelect;

/**
 * One pass of restatements for one connection: purchases sent whose job is
 * worth something different to this platform now, each told once, and the
 * adjustments already decided that are due a (re)try.
 *
 * Decided in a transaction, sent after it, recorded after that, the same
 * shape as the sends above, for the same reasons.
 */
export async function restateConversions(db: Database, row: Connection, deps: AdsDeps = {}): Promise<PullOutcome> {
  const provider = row.provider as ads.AdsProvider;
  const ctx: ServiceContext = { actor: adsActor(row.organizationId), db };
  const now = (deps.now ?? (() => new Date()))();

  return runPull(db, row, "adjustments", async () => {
    if (!ads.RESTATES.includes(provider) || notSending(row)) return { read: 0, written: 0 };

    const due = await inTenant(ctx, async (tx) => {
      const [company] = await tx.select({ currency: schema.organization.currency })
        .from(schema.organization).where(eq(schema.organization.id, row.organizationId)).limit(1);
      const currency = company?.currency ?? "USD";
      const sent = await tx.select().from(schema.adConversionSend).where(and(
        eq(schema.adConversionSend.organizationId, row.organizationId),
        eq(schema.adConversionSend.provider, provider),
        eq(schema.adConversionSend.kind, "purchase"),
        eq(schema.adConversionSend.state, "sent"),
        sql`${schema.adConversionSend.sentAt} >= ${new Date(now.getTime() - RESTATE_DAYS * 86_400_000).toISOString()}::timestamptz`,
      )).orderBy(asc(schema.adConversionSend.sentAt)).limit(BATCH * 4);
      let considered = 0;

      for (const send of sent) {
        considered += 1;
        const history = await tx.select().from(schema.adConversionAdjustment)
          .where(eq(schema.adConversionAdjustment.sendId, send.id))
          .orderBy(desc(schema.adConversionAdjustment.sequence));
        const latest = history[0] ?? null;
        /** Something still in flight is finished before anything new is decided about the same job. */
        if (latest && (latest.state === "sending" || latest.state === "failed")) continue;
        const believed = history.find((a) => a.state === "sent")?.newValue ?? send.value ?? "0";
        const recorded = latest?.newValue ?? send.value ?? "0";
        const now$ = await shareNow(tx, row, send.jobId);
        if (m.equals(m.round(m.money(now$)), m.round(m.money(recorded)))) continue;
        const decision = ads.decideAdjustment({ provider, told: believed, now: now$ });
        if (decision.kind === "none") continue;
        const sequence = (latest?.sequence ?? 0) + 1;
        await tx.insert(schema.adConversionAdjustment).values({
          organizationId: row.organizationId,
          sendId: send.id,
          provider,
          jobId: send.jobId,
          sequence,
          kind: decision.kind,
          previousValue: believed,
          newValue: now$,
          sentValue: decision.kind === "restatement" || decision.kind === "increase" ? decision.value : null,
          currency,
          state: decision.kind === "cannot_lower" ? "withheld" : "sending",
          eventId: ads.adjustmentEventId(send.jobId, sequence),
          detail: decision.kind === "cannot_lower" ? decision.because : null,
        }).onConflictDoNothing();
      }

      /** Decided now, or failed earlier and due again, or left mid send by a worker that died. */
      const queued = await tx.select().from(schema.adConversionAdjustment).where(and(
        eq(schema.adConversionAdjustment.organizationId, row.organizationId),
        eq(schema.adConversionAdjustment.provider, provider),
        or(
          and(eq(schema.adConversionAdjustment.state, "sending"), eq(schema.adConversionAdjustment.attempts, 0)),
          and(eq(schema.adConversionAdjustment.state, "failed"), lte(schema.adConversionAdjustment.nextAttemptAt, now)),
          and(eq(schema.adConversionAdjustment.state, "sending"), lt(schema.adConversionAdjustment.updatedAt, new Date(now.getTime() - STUCK_MS))),
        ),
      )).limit(BATCH);

      const out: { adjustment: AdjustmentRow; event: OutboundEvent | null }[] = [];
      for (const adjustment of queued) {
        await tx.update(schema.adConversionAdjustment).set({ state: "sending", updatedAt: new Date() })
          .where(eq(schema.adConversionAdjustment.id, adjustment.id));
        if (provider !== "meta_ads") { out.push({ adjustment, event: null }); continue; }
        /**
         * Meta matches the increase to a person the way it matched the
         * purchase, so it is decided afresh: a customer who said no since the
         * purchase went has nothing more sent.
         */
        const prepared = await prepare(tx, row, "purchase", adjustment.jobId, now).catch(() => null);
        if (!prepared || !prepared.send) {
          await tx.update(schema.adConversionAdjustment).set({
            state: "withheld",
            detail: prepared && !prepared.send ? prepared.because : "The job is gone.",
            updatedAt: new Date(),
          }).where(eq(schema.adConversionAdjustment.id, adjustment.id));
          continue;
        }
        out.push({
          adjustment,
          event: { ...prepared.event, eventId: adjustment.eventId, value: adjustment.sentValue, at: now, currency: adjustment.currency ?? prepared.event.currency },
        });
      }
      return { out, considered };
    });

    if (due.out.length === 0) return { read: due.considered, written: 0 };

    let outcomes = new Map<string, { ok: boolean; message: string | null }>();
    let failedWith: Error | null = null;
    try {
      const adapter = await adapterFor(db, row, deps);
      if (provider === "google_ads") {
        const answers = await adapter.adjustConversions!(due.out.map(({ adjustment }) => ({
          orderId: ads.eventId("purchase", adjustment.jobId),
          kind: adjustment.kind === "retraction" ? "retraction" as const : "restatement" as const,
          value: adjustment.sentValue,
          currency: adjustment.currency ?? "USD",
          at: now,
        })));
        outcomes = new Map(due.out.map(({ adjustment }, i) => [adjustment.id, { ok: answers[i]?.ok ?? false, message: answers[i]?.message ?? null }]));
      } else {
        const answers = await adapter.sendEvents!(due.out.map((d) => d.event!));
        const byEvent = new Map(answers.map((a) => [a.eventId, a]));
        outcomes = new Map(due.out.map(({ adjustment }) => {
          const a = byEvent.get(adjustment.eventId);
          return [adjustment.id, { ok: a?.ok ?? false, message: a && !a.ok ? a.message : null }];
        }));
      }
    } catch (error) {
      failedWith = error as Error;
    }

    let sent = 0;
    await inTenant(ctx, async (tx) => {
      for (const { adjustment } of due.out) {
        const attempts = adjustment.attempts + 1;
        const outcome = outcomes.get(adjustment.id);
        if (outcome?.ok) {
          sent += 1;
          await tx.update(schema.adConversionAdjustment).set({
            state: "sent", attempts, sentAt: new Date(), detail: null, nextAttemptAt: null, updatedAt: new Date(),
          }).where(eq(schema.adConversionAdjustment.id, adjustment.id));
        } else if (outcome || failedWith instanceof PlatformRefusedError) {
          await tx.update(schema.adConversionAdjustment).set({
            state: "refused", attempts, detail: (outcome?.message ?? failedWith?.message ?? "Refused.").slice(0, 1000),
            nextAttemptAt: null, updatedAt: new Date(),
          }).where(eq(schema.adConversionAdjustment.id, adjustment.id));
        } else {
          const retry = ads.retryAt(attempts, now);
          await tx.update(schema.adConversionAdjustment).set({
            state: "failed", attempts,
            detail: (failedWith?.message ?? "No answer for this adjustment.").slice(0, 1000),
            nextAttemptAt: retry, updatedAt: new Date(),
          }).where(eq(schema.adConversionAdjustment.id, adjustment.id));
        }
      }
      await audit(tx, ctx, "ad_conversions.restated", "integration_connection", row.id, null, {
        provider, attempted: due.out.length, sent,
      });
    });
    if (failedWith instanceof AuthorizationLostError) throw failedWith;
    return { read: due.considered, written: sent };
  });
}

export interface AdjustmentView {
  id: string;
  provider: string;
  providerLabel: string;
  jobId: string;
  jobNumber: number | null;
  sequence: number;
  kind: string;
  previousValue: string;
  newValue: string;
  sentValue: string | null;
  state: string;
  detail: string | null;
  attempts: number;
  sentAt: string | null;
  createdAt: string;
}

/** Every restatement decided, newest first, with what was sent and what the platform said. */
export async function listAdjustments(ctx: ServiceContext, input: { jobId?: string | undefined; limit?: number | undefined }): Promise<AdjustmentView[]> {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const rows = await tx.select({ adjustment: schema.adConversionAdjustment, number: schema.job.number })
      .from(schema.adConversionAdjustment)
      .leftJoin(schema.job, eq(schema.job.id, schema.adConversionAdjustment.jobId))
      .where(and(
        eq(schema.adConversionAdjustment.organizationId, ctx.actor.organizationId),
        ...(input.jobId ? [eq(schema.adConversionAdjustment.jobId, input.jobId)] : []),
      ))
      .orderBy(desc(schema.adConversionAdjustment.createdAt))
      .limit(Math.min(input.limit ?? 200, 500));
    return rows.map(({ adjustment: a, number }) => ({
      id: a.id,
      provider: a.provider,
      providerLabel: ads.isAdsProvider(a.provider) ? ads.PROVIDERS[a.provider].label : a.provider,
      jobId: a.jobId,
      jobNumber: number,
      sequence: a.sequence,
      kind: a.kind,
      previousValue: a.previousValue,
      newValue: a.newValue,
      sentValue: a.sentValue,
      state: a.state,
      detail: a.detail,
      attempts: a.attempts,
      sentAt: a.sentAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    }));
  });
}
