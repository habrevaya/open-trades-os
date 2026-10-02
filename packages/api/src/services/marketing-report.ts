import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { marketing as mk, money as m, telephony as tel } from "@opentradesos/core";
import { guardedRead, ConflictError, NotFoundError, type ServiceContext } from "./context";
import * as acquisition from "./acquisition";
import { revenueByJob } from "./marketing";

/**
 * THE FUNNEL: WHAT IT COST, WHO RANG, WHO BOOKED, WHAT IT BILLED
 *
 * One report, three ways of cutting it (by channel, by tracking campaign, by
 * tracking number), over a date range the reader picks and under an
 * attribution model the reader picks. Every cell is the size of a list of
 * rows, and the list is what `drill` returns, so a number on the screen can
 * always be opened and counted.
 *
 * THE CELLS AND THE ROWS ARE THE SAME COMPUTATION. `build` puts every call,
 * lead, job and spend line into the bucket it belongs to, and a cell is the
 * sum of its bucket. The report and the drill both call `build`, so a drill
 * that does not add up to the number somebody clicked cannot be produced by
 * this file: the only way to get one is to change the arithmetic in one
 * place and not the other, and there is only one place.
 *
 * WHAT EACH COLUMN COUNTS, for a range from F to T:
 *
 *   Spend: spend rows dated F to T, plus the part of each fixed price
 *   campaign that falls between them, plus each per lead campaign's price
 *   times its leads.
 *
 *   Calls: inbound calls that started between F and T, on the number's
 *   channel and campaign AT THE TIME of the call. Answered, missed and first
 *   time are core's call outcome classifier's answer, not a status column.
 *
 *   Leads: PEOPLE (`mk.leadKey`: the customer, else the number that rang,
 *   else the browser) with a touch between F and T. One person touching two
 *   channels is a lead for each, and once in the total.
 *
 *   Booked jobs: jobs created between F and T and not cancelled, each
 *   credited across its own touches under the model, so a split model puts
 *   half a job on two channels and the halves add back to one. A job nothing
 *   was recorded for is "not attributed", never `direct`.
 *
 *   Completed and revenue: of those booked jobs, the ones finished, and
 *   their revenue by `marketing.REVENUE_SQL` to date, split the same way.
 *
 * So booked jobs are a cohort of the range and leads are an activity of the
 * range, and a customer who rang in March and booked in April is a March
 * lead and an April job. That is why a booking rate here can pass a hundred
 * per cent on a short range, and `funnelFigures` reports it rather than
 * refusing the whole report.
 */

export type Dimension = "channel" | "campaign" | "number";
export type Measure =
  | "spend" | "calls" | "answered" | "missed" | "firstTime"
  | "leads" | "booked" | "completed" | "revenue";

export const MEASURES: readonly Measure[] = [
  "spend", "calls", "answered", "missed", "firstTime", "leads", "booked", "completed", "revenue",
];

/** The bucket for a call, lead, job or cost nothing could place, in every view. */
export const NONE = "none";

export interface FunnelInput {
  from: string;
  to: string;
  by: Dimension;
  model?: mk.AttributionModelKey | undefined;
}

interface CallItem {
  callId: string;
  startedAt: Date;
  from: string;
  receivedOn: string | null;
  status: string;
  outcome: tel.CallOutcome;
  outcomeLabel: string;
  answered: boolean;
  missed: boolean;
  firstTime: boolean | null;
  durationSeconds: number | null;
  customerId: string | null;
  customerName: string | null;
  jobId: string | null;
}

interface LeadItem {
  key: string;
  customerId: string | null;
  customerName: string | null;
  callerE164: string | null;
  firstAt: Date;
  touches: number;
}

interface JobItem {
  jobId: string;
  number: number;
  summary: string;
  customerId: string;
  customerName: string | null;
  createdAt: Date;
  status: string;
  completed: boolean;
  /** This bucket's share of the job, in `mk.WEIGHT_SCALE`. */
  weight: number;
  /** This bucket's share of the job's revenue. */
  revenue: m.Money;
}

interface SpendItem {
  kind: "recorded" | "fixed" | "per_lead";
  spendId: string | null;
  campaignId: string | null;
  spentOn: string | null;
  label: string;
  amount: m.Money;
  note: string | null;
}

interface Bucket {
  calls: CallItem[];
  leads: Map<string, LeadItem>;
  jobs: JobItem[];
  spend: SpendItem[];
}

const emptyBucket = (): Bucket => ({ calls: [], leads: new Map(), jobs: [], spend: [] });

interface Built {
  buckets: Map<string, Bucket>;
  /** Every person with a touch in range, once. The total row's lead count. */
  people: Map<string, LeadItem>;
  labels: Map<string, { label: string; detail: string | null }>;
  model: mk.AttributionModelKey;
}

function checkRange(input: { from: string; to: string }) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(input.from) || !iso.test(input.to)) {
    throw new ConflictError("Give the dates as 2026-04-01.");
  }
  if (input.to < input.from) throw new ConflictError("The range ends before it starts.");
  if (mk.daysBetween(input.from, input.to) > 731) {
    throw new ConflictError("Ask for two years or less at a time. A longer range is two reports somebody should compare.");
  }
}

/**
 * A call's row as core's outcome classifier reads it.
 *
 * The provider statuses map onto core's call states with who ended it filled
 * in where the status says: no answer is the system giving up, busy is the
 * carrier, abandoned is the caller. A wrong number is the disposition
 * somebody set, which core lets beat every derived fact.
 */
function outcomeOf(call: {
  status: string; durationSeconds: number | null; ringSeconds: number | null;
  jobId: string | null; disposition: string | null; voicemailUrl: string | null;
}): tel.OutcomeVerdict {
  const talk = call.status === "completed" ? call.durationSeconds ?? 0 : 0;
  const state: tel.CallState =
    call.status === "no_answer" || call.status === "busy" ? "abandoned"
      : call.status === "failed" ? "failed"
        : call.status === "voicemail" ? "voicemail"
          : call.status === "abandoned" ? "abandoned"
            : call.status === "ringing" ? "ringing"
              : call.status === "in_progress" ? "in_progress"
                : "completed";
  return tel.classify({
    direction: "inbound",
    state,
    ringSeconds: call.ringSeconds ?? 0,
    talkSeconds: talk,
    endedBy: call.status === "abandoned" ? "caller" : call.status === "busy" ? "carrier"
      : call.status === "no_answer" ? "us" : "unknown",
    voicemailLeft: call.status === "voicemail" && (call.voicemailUrl !== null || (call.durationSeconds ?? 0) > 0),
    bookedJobId: call.jobId,
    markedWrongNumber: call.disposition === "wrong_number",
  });
}

async function build(tx: Database, organizationId: string, input: FunnelInput): Promise<Built> {
  checkRange(input);
  const model = input.model ?? (await acquisition.settingsWithin(tx, organizationId)).attributionModel;
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const to = new Date(`${input.to}T23:59:59.999Z`);
  const org = organizationId;

  await acquisition.ensureChannels(tx, org);
  const channels = await tx.select().from(schema.marketingChannel)
    .where(eq(schema.marketingChannel.organizationId, org));
  const campaigns = await tx.select().from(schema.acquisitionCampaign)
    .where(eq(schema.acquisitionCampaign.organizationId, org));
  const numbers = await tx.select().from(schema.phoneNumber)
    .where(eq(schema.phoneNumber.organizationId, org));

  const channelById = new Map(channels.map((c) => [c.id, c]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const numberById = new Map(numbers.map((n) => [n.id, n]));
  const liveNumberByE164 = new Map(numbers.filter((n) => !n.releasedAt).map((n) => [n.e164, n]));
  /** The channel a bare source key lands on, the same rule `acquisition.channelForSource` uses. */
  const defaultChannel = new Map<string, string>();
  for (const c of [...channels].filter((c) => !c.archivedAt)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.name.localeCompare(b.name))) {
    if (!defaultChannel.has(c.sourceKey)) defaultChannel.set(c.sourceKey, c.id);
  }
  const numbersOfCampaign = (campaignId: string) =>
    numbers.filter((n) => n.acquisitionCampaignId === campaignId && !n.releasedAt)
      .sort((a, b) => a.e164.localeCompare(b.e164));

  const buckets = new Map<string, Bucket>();
  const bucket = (key: string) => {
    let b = buckets.get(key);
    if (!b) { b = emptyBucket(); buckets.set(key, b); }
    return b;
  };

  /* ---- calls ---- */
  const callRows = await tx.select({
    call: schema.call,
    customerName: schema.customer.name,
  }).from(schema.call)
    .leftJoin(schema.customer, eq(schema.customer.id, schema.call.customerId))
    .where(and(
      eq(schema.call.organizationId, org),
      eq(schema.call.direction, "inbound"),
      /**
       * As ISO strings with a cast, because a Date has no binding against an
       * expression rather than a column: drizzle only knows how to encode one
       * for a column it can see the type of.
       */
      sql`coalesce(${schema.call.startedAt}, ${schema.call.createdAt}) >= ${from.toISOString()}::timestamptz`,
      sql`coalesce(${schema.call.startedAt}, ${schema.call.createdAt}) <= ${to.toISOString()}::timestamptz`,
    ));

  const callDim = (call: typeof schema.call.$inferSelect): string => {
    const number = call.phoneNumberId ? numberById.get(call.phoneNumberId) : undefined;
    if (input.by === "number") return call.phoneNumberId ?? NONE;
    if (input.by === "campaign") return call.acquisitionCampaignId ?? NONE;
    return call.channelId ?? number?.channelId ?? NONE;
  };

  for (const { call, customerName } of callRows) {
    const verdict = outcomeOf(call);
    bucket(callDim(call)).calls.push({
      callId: call.id,
      startedAt: call.startedAt ?? call.createdAt,
      from: call.fromE164,
      receivedOn: call.receivedOnE164,
      status: call.status,
      outcome: verdict.outcome,
      outcomeLabel: tel.CALL_OUTCOME[verdict.outcome].label,
      answered: verdict.reachedAPerson,
      missed: verdict.countsAsMissed,
      firstTime: call.firstTimeCaller,
      durationSeconds: call.durationSeconds,
      customerId: call.customerId,
      customerName,
      jobId: call.jobId,
    });
  }

  /* ---- the dimension of a touch ---- */
  type TouchRow = typeof schema.marketingTouch.$inferSelect;
  const touchCallIds = new Set<string>();
  const callNumber = new Map<string, string | null>();
  for (const { call } of callRows) callNumber.set(call.id, call.phoneNumberId);
  const touchDim = (t: TouchRow): string => {
    if (input.by === "channel") return t.channelId ?? defaultChannel.get(t.source) ?? NONE;
    if (input.by === "campaign") return t.acquisitionCampaignId ?? NONE;
    if (t.callId && callNumber.get(t.callId)) return callNumber.get(t.callId)!;
    if (t.trackedNumberE164) return liveNumberByE164.get(t.trackedNumberE164)?.id ?? NONE;
    return NONE;
  };

  /* ---- leads ---- */
  const touchRows = await tx.select({
    touch: schema.marketingTouch,
    customerName: schema.customer.name,
  }).from(schema.marketingTouch)
    .leftJoin(schema.customer, eq(schema.customer.id, schema.marketingTouch.customerId))
    .where(and(
      eq(schema.marketingTouch.organizationId, org),
      gte(schema.marketingTouch.occurredAt, from),
      lte(schema.marketingTouch.occurredAt, to),
    ));
  for (const { touch } of touchRows) if (touch.callId) touchCallIds.add(touch.callId);
  await loadCallNumbers(tx, org, [...touchCallIds].filter((id) => !callNumber.has(id)), callNumber);

  const people = new Map<string, LeadItem>();
  const addLead = (into: Map<string, LeadItem>, key: string, t: TouchRow, name: string | null) => {
    const existing = into.get(key);
    if (existing) {
      existing.touches += 1;
      if (t.occurredAt < existing.firstAt) existing.firstAt = t.occurredAt;
      return;
    }
    into.set(key, {
      key, customerId: t.customerId, customerName: name, callerE164: t.callerE164,
      firstAt: t.occurredAt, touches: 1,
    });
  };
  for (const { touch, customerName } of touchRows) {
    const key = mk.leadKey(touch);
    if (!key) continue;
    addLead(bucket(touchDim(touch)).leads, key, touch, customerName);
    addLead(people, key, touch, customerName);
  }

  /* ---- booked jobs ---- */
  const jobRows = await tx.select({
    job: {
      id: schema.job.id, number: schema.job.number, summary: schema.job.summary,
      customerId: schema.job.customerId, createdAt: schema.job.createdAt,
      status: schema.job.status, completedAt: schema.job.completedAt,
    },
    customerName: schema.customer.name,
  }).from(schema.job)
    .leftJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .where(and(
      eq(schema.job.organizationId, org),
      gte(schema.job.createdAt, from),
      lte(schema.job.createdAt, to),
      ne(schema.job.status, "cancelled"),
      isNull(schema.job.deletedAt),
    ));
  const jobIds = jobRows.map((r) => r.job.id);
  const jobTouches = jobIds.length === 0 ? [] : await tx.select().from(schema.marketingTouch)
    .where(and(
      eq(schema.marketingTouch.organizationId, org),
      inArray(schema.marketingTouch.jobId, jobIds),
    ));
  await loadCallNumbers(
    tx, org,
    jobTouches.map((t) => t.callId).filter((id): id is string => !!id && !callNumber.has(id)),
    callNumber,
  );
  const touchesByJob = new Map<string, TouchRow[]>();
  for (const t of jobTouches) {
    const list = touchesByJob.get(t.jobId!) ?? [];
    list.push(t);
    touchesByJob.set(t.jobId!, list);
  }
  const revenue = await revenueByJob(tx, jobIds);

  for (const { job, customerName } of jobRows) {
    const touches = touchesByJob.get(job.id) ?? [];
    const decision = mk.shareTouches(model, touches.map(toCoreTouch));
    const byDim = new Map<string, number>();
    if (decision.ok) {
      for (const share of decision.shares) {
        const dim = touchDim(touches[share.index]!);
        byDim.set(dim, (byDim.get(dim) ?? 0) + share.weight);
      }
    } else {
      byDim.set(NONE, mk.WEIGHT_SCALE);
    }
    const dims = [...byDim.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const total = revenue.get(job.id) ?? m.zero("USD");
    /** Split at the cent so the shares add back to the job's revenue exactly. */
    const shares = m.allocate(total, dims.map(([, w]) => String(w)), 2);
    const completed = job.completedAt !== null || ["completed", "invoiced", "paid"].includes(job.status);
    dims.forEach(([dim, weight], i) => {
      bucket(dim).jobs.push({
        jobId: job.id, number: job.number, summary: job.summary,
        customerId: job.customerId, customerName,
        createdAt: job.createdAt, status: job.status, completed,
        weight, revenue: shares[i] ?? m.zero("USD"),
      });
    });
  }

  /* ---- spend ---- */
  const spendRows = await tx.select().from(schema.adSpend)
    .where(and(
      eq(schema.adSpend.organizationId, org),
      gte(schema.adSpend.spentOn, input.from),
      lte(schema.adSpend.spentOn, input.to),
      isNull(schema.adSpend.deletedAt),
    ));

  /**
   * Where a cost line lands. By number, a campaign's cost is split evenly
   * across its live numbers, by allocation so the parts add back to the
   * line, because spend is bought per campaign and no ads account bills per
   * phone number. A campaign with no number puts its cost on "no tracking
   * number", where it is visible rather than lost.
   */
  const placeSpend = (item: SpendItem, channelId: string | null) => {
    if (input.by === "channel") { bucket(channelId ?? NONE).spend.push(item); return; }
    if (input.by === "campaign") { bucket(item.campaignId ?? NONE).spend.push(item); return; }
    const own = item.campaignId ? numbersOfCampaign(item.campaignId) : [];
    if (own.length === 0) { bucket(NONE).spend.push(item); return; }
    const parts = m.allocate(item.amount, own.map(() => "1"), 2);
    own.forEach((n, i) => bucket(n.id).spend.push({
      ...item,
      amount: parts[i] ?? m.zero("USD"),
      note: own.length > 1 ? `Split evenly across the campaign's ${own.length} numbers.` : item.note,
    }));
  };

  for (const row of spendRows) {
    const campaign = row.acquisitionCampaignId ? campaignById.get(row.acquisitionCampaignId) : undefined;
    const channelId = row.channelId ?? campaign?.channelId ?? defaultChannel.get(row.source) ?? null;
    placeSpend({
      kind: "recorded",
      spendId: row.id,
      campaignId: row.acquisitionCampaignId,
      spentOn: row.spentOn,
      label: campaign?.name ?? row.campaign ?? mk.leadSourceLabel(row.source),
      amount: m.money(row.amount, "USD"),
      note: row.origin === "manual" ? null : `Imported from ${row.origin}.`,
    }, channelId);
  }

  for (const campaign of campaigns) {
    if (!campaign.costAmount) continue;
    if (campaign.costModel === "fixed" && campaign.startsOn && campaign.endsOn) {
      const part = mk.proratedCost(m.money(campaign.costAmount, "USD"),
        { startsOn: campaign.startsOn, endsOn: campaign.endsOn }, input);
      if (part.daysInRange === 0) continue;
      placeSpend({
        kind: "fixed", spendId: null, campaignId: campaign.id, spentOn: null,
        label: campaign.name, amount: part.amount,
        note: `${part.daysInRange} of the campaign's ${part.days} days fall in this range.`,
      }, campaign.channelId);
    } else if (campaign.costModel === "per_lead") {
      /** The campaign's own leads in the range, counted the way the leads column counts them. */
      const leads = new Set<string>();
      for (const { touch } of touchRows) {
        const key = mk.leadKey(touch);
        if (key && touch.acquisitionCampaignId === campaign.id) leads.add(key);
      }
      if (leads.size === 0) continue;
      placeSpend({
        kind: "per_lead", spendId: null, campaignId: campaign.id, spentOn: null,
        label: campaign.name,
        amount: m.multiply(m.money(campaign.costAmount, "USD"), String(leads.size)),
        note: `${leads.size} lead${leads.size === 1 ? "" : "s"} at ${m.toString(m.round(m.money(campaign.costAmount, "USD"), 2))} each.`,
      }, campaign.channelId);
    }
  }

  /* ---- labels ---- */
  const labels = new Map<string, { label: string; detail: string | null }>();
  for (const key of buckets.keys()) {
    if (key === NONE) {
      labels.set(key, {
        label: input.by === "channel" ? "Not attributed" : input.by === "campaign" ? "No tracking campaign" : "No tracking number",
        detail: input.by === "channel"
          ? "Nothing was recorded, or it could not be placed. Not counted as direct, because it is not."
          : null,
      });
    } else if (input.by === "channel") {
      const c = channelById.get(key);
      labels.set(key, { label: c?.name ?? "A removed channel", detail: c ? mk.leadSourceLabel(c.sourceKey) : null });
    } else if (input.by === "campaign") {
      const c = campaignById.get(key);
      labels.set(key, {
        label: c?.name ?? "A removed campaign",
        detail: c ? channelById.get(c.channelId)?.name ?? null : null,
      });
    } else {
      const n = numberById.get(key);
      const campaign = n?.acquisitionCampaignId ? campaignById.get(n.acquisitionCampaignId) : undefined;
      labels.set(key, {
        label: n?.e164 ?? "A removed number",
        detail: [n?.label, campaign?.name].filter(Boolean).join(", ") || null,
      });
    }
  }

  return { buckets, people, labels, model };
}

async function loadCallNumbers(
  tx: Database, organizationId: string, ids: string[], into: Map<string, string | null>,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.select({ id: schema.call.id, phoneNumberId: schema.call.phoneNumberId })
    .from(schema.call)
    .where(and(eq(schema.call.organizationId, organizationId), inArray(schema.call.id, ids)));
  for (const row of rows) into.set(row.id, row.phoneNumberId);
}

function toCoreTouch(row: typeof schema.marketingTouch.$inferSelect): mk.Touch {
  return {
    at: row.occurredAt,
    source: row.source as mk.LeadSourceKey,
    basis: row.basis,
    utm: {},
    referrerHost: row.referrerHost,
    clickId: row.clickId,
    campaign: row.utmCampaign,
  };
}

/* ------------------------------------------------------------- the cells */

export interface FunnelCells {
  spend: string;
  calls: number;
  answered: number;
  missed: number;
  firstTime: number;
  leads: number;
  /** Credited booked jobs as a person reads them: "3", "1.5". */
  booked: string;
  /** The same, in ten thousandths, for anything that adds them up. */
  bookedWeight: number;
  completed: string;
  completedWeight: number;
  revenue: string;
  bookingRate: string | null;
  averageTicket: string | null;
  costPerLead: string | null;
  costPerBookedJob: string | null;
  roi: string | null;
  roas: string | null;
}

function cellsOf(b: Bucket, leadCount: number): FunnelCells {
  const spend = b.spend.reduce((sum, s) => m.add(sum, s.amount), m.zero("USD"));
  const bookedWeight = b.jobs.reduce((sum, j) => sum + j.weight, 0);
  const completedWeight = b.jobs.filter((j) => j.completed).reduce((sum, j) => sum + j.weight, 0);
  const invoicedWeight = b.jobs.filter((j) => !m.isZero(j.revenue)).reduce((sum, j) => sum + j.weight, 0);
  const revenue = b.jobs.reduce((sum, j) => m.add(sum, j.revenue), m.zero("USD"));
  const figures = mk.funnelFigures({ spend, leads: leadCount, bookedWeight, invoicedWeight, revenue });
  const text = (value: m.Money | null) => (value ? m.toString(m.round(value, 2)) : null);
  return {
    spend: m.toString(spend),
    calls: b.calls.length,
    answered: b.calls.filter((c) => c.answered).length,
    missed: b.calls.filter((c) => c.missed).length,
    firstTime: b.calls.filter((c) => c.firstTime === true).length,
    leads: leadCount,
    booked: mk.weightText(bookedWeight),
    bookedWeight,
    completed: mk.weightText(completedWeight),
    completedWeight,
    revenue: m.toString(revenue),
    bookingRate: figures.bookingRate,
    averageTicket: text(figures.averageTicket),
    costPerLead: text(figures.costPerLead),
    costPerBookedJob: text(figures.costPerBookedJob),
    roi: figures.roi,
    roas: figures.roas,
  };
}

/** The total row: every bucket's items, once each, and people counted once. */
function totalBucket(built: Built): Bucket {
  const all = emptyBucket();
  for (const b of built.buckets.values()) {
    all.calls.push(...b.calls);
    all.jobs.push(...b.jobs);
    all.spend.push(...b.spend);
  }
  all.leads = built.people;
  return all;
}

export async function funnel(ctx: ServiceContext, input: FunnelInput) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const built = await build(tx, ctx.actor.organizationId, input);
    const rows = [...built.buckets.entries()].map(([key, b]) => ({
      key,
      label: built.labels.get(key)?.label ?? key,
      detail: built.labels.get(key)?.detail ?? null,
      ...cellsOf(b, b.leads.size),
    })).sort((a, b) =>
      (a.key === NONE ? 1 : 0) - (b.key === NONE ? 1 : 0)
      || Number(m.compare(m.money(b.spend, "USD"), m.money(a.spend, "USD")))
      || b.bookedWeight - a.bookedWeight
      || a.label.localeCompare(b.label));
    const total = totalBucket(built);
    return {
      from: input.from,
      to: input.to,
      by: input.by,
      model: built.model,
      modelLabel: mk.ATTRIBUTION_MODELS[built.model].label,
      /** Shown beside the figures, always. */
      modelWrongAbout: mk.ATTRIBUTION_MODELS[built.model].wrongAbout,
      rows,
      total: cellsOf(total, total.leads.size),
    };
  });
}

/**
 * THE ROWS BEHIND ONE CELL.
 *
 * `key` is a row's key from `funnel`, or `all` for the total row. The rows
 * come out of the same buckets the cell was summed from, so what is listed
 * here is exactly what was counted there.
 */
export async function drill(ctx: ServiceContext, input: FunnelInput & { key: string; measure: Measure }) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    if (!MEASURES.includes(input.measure)) throw new ConflictError(`"${input.measure}" is not a column on this report.`);
    const built = await build(tx, ctx.actor.organizationId, input);
    const b = input.key === "all" ? totalBucket(built) : built.buckets.get(input.key) ?? emptyBucket();
    const label = input.key === "all" ? "Everything" : built.labels.get(input.key)?.label ?? "Nothing here";

    const calls = (filter: (c: CallItem) => boolean) => b.calls.filter(filter).map((c) => ({
      ...c, startedAt: c.startedAt.toISOString(),
    }));
    const jobs = (filter: (j: JobItem) => boolean) => b.jobs.filter(filter).map((j) => ({
      jobId: j.jobId, number: j.number, summary: j.summary,
      customerId: j.customerId, customerName: j.customerName,
      createdAt: j.createdAt.toISOString(), status: j.status, completed: j.completed,
      share: mk.weightText(j.weight), weight: j.weight, revenue: m.toString(j.revenue),
    }));

    const base = { key: input.key, label, measure: input.measure, model: built.model, cell: cellsOf(b, b.leads.size) };
    switch (input.measure) {
      case "calls": return { ...base, kind: "calls" as const, calls: calls(() => true) };
      case "answered": return { ...base, kind: "calls" as const, calls: calls((c) => c.answered) };
      case "missed": return { ...base, kind: "calls" as const, calls: calls((c) => c.missed) };
      case "firstTime": return { ...base, kind: "calls" as const, calls: calls((c) => c.firstTime === true) };
      case "leads": return {
        ...base, kind: "leads" as const,
        leads: [...b.leads.values()]
          .sort((x, y) => x.firstAt.getTime() - y.firstAt.getTime())
          .map((l) => ({ ...l, firstAt: l.firstAt.toISOString() })),
      };
      case "booked": return { ...base, kind: "jobs" as const, jobs: jobs(() => true) };
      case "completed": return { ...base, kind: "jobs" as const, jobs: jobs((j) => j.completed) };
      case "revenue": return { ...base, kind: "jobs" as const, jobs: jobs((j) => !m.isZero(j.revenue)) };
      case "spend": return {
        ...base, kind: "spend" as const,
        spend: b.spend.map((s) => ({ ...s, amount: m.toString(s.amount) })),
      };
    }
  });
}

/* ------------------------------------------------------------ the call log */

/**
 * Every inbound call, newest first, with what it was.
 *
 * The outcome is core's classifier's answer from the facts, not a status
 * column and not a disposition somebody remembered to pick: an answered call
 * of four seconds is "answered, but barely", and a call that turned into a
 * job is "booked" because the job says so.
 */
export async function callLog(ctx: ServiceContext, input: {
  from: string; to: string;
  numberId?: string | undefined; campaignId?: string | undefined; channelId?: string | undefined;
  limit?: number | undefined;
}) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    checkRange(input);
    const org = ctx.actor.organizationId;
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T23:59:59.999Z`);
    const rows = await tx.select({
      call: schema.call,
      customerName: schema.customer.name,
      channelName: schema.marketingChannel.name,
      campaignName: schema.acquisitionCampaign.name,
      numberLabel: schema.phoneNumber.label,
    }).from(schema.call)
      .leftJoin(schema.customer, eq(schema.customer.id, schema.call.customerId))
      .leftJoin(schema.marketingChannel, eq(schema.marketingChannel.id, schema.call.channelId))
      .leftJoin(schema.acquisitionCampaign, eq(schema.acquisitionCampaign.id, schema.call.acquisitionCampaignId))
      .leftJoin(schema.phoneNumber, eq(schema.phoneNumber.id, schema.call.phoneNumberId))
      .where(and(
        eq(schema.call.organizationId, org),
        eq(schema.call.direction, "inbound"),
        sql`coalesce(${schema.call.startedAt}, ${schema.call.createdAt}) >= ${from.toISOString()}::timestamptz`,
        sql`coalesce(${schema.call.startedAt}, ${schema.call.createdAt}) <= ${to.toISOString()}::timestamptz`,
        ...(input.numberId ? [eq(schema.call.phoneNumberId, input.numberId)] : []),
        ...(input.campaignId ? [eq(schema.call.acquisitionCampaignId, input.campaignId)] : []),
        ...(input.channelId ? [eq(schema.call.channelId, input.channelId)] : []),
      ))
      .orderBy(sql`coalesce(${schema.call.startedAt}, ${schema.call.createdAt}) desc`)
      .limit(Math.min(input.limit ?? 200, 500));

    return rows.map(({ call, customerName, channelName, campaignName, numberLabel }) => {
      const verdict = outcomeOf(call);
      return {
        id: call.id,
        startedAt: (call.startedAt ?? call.createdAt).toISOString(),
        from: call.fromE164,
        receivedOn: call.receivedOnE164,
        numberLabel,
        channelId: call.channelId,
        channelName,
        campaignId: call.acquisitionCampaignId,
        campaignName,
        status: call.status,
        durationSeconds: call.durationSeconds,
        firstTimeCaller: call.firstTimeCaller,
        outcome: verdict.outcome,
        outcomeLabel: tel.CALL_OUTCOME[verdict.outcome].label,
        outcomeWhy: verdict.why,
        customerId: call.customerId,
        customerName,
        jobId: call.jobId,
      };
    });
  });
}

/** One call, for the page that turns it into a customer and a job. */
export async function getCall(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const [row] = await tx.select({
      call: schema.call,
      customerName: schema.customer.name,
      channelName: schema.marketingChannel.name,
      campaignName: schema.acquisitionCampaign.name,
    }).from(schema.call)
      .leftJoin(schema.customer, eq(schema.customer.id, schema.call.customerId))
      .leftJoin(schema.marketingChannel, eq(schema.marketingChannel.id, schema.call.channelId))
      .leftJoin(schema.acquisitionCampaign, eq(schema.acquisitionCampaign.id, schema.call.acquisitionCampaignId))
      .where(and(eq(schema.call.organizationId, ctx.actor.organizationId), eq(schema.call.id, input.id)))
      .limit(1);
    if (!row) throw new NotFoundError("Call");
    const verdict = outcomeOf(row.call);
    return {
      id: row.call.id,
      startedAt: (row.call.startedAt ?? row.call.createdAt).toISOString(),
      from: row.call.fromE164,
      receivedOn: row.call.receivedOnE164,
      channelId: row.call.channelId,
      channelName: row.channelName,
      campaignId: row.call.acquisitionCampaignId,
      campaignName: row.campaignName,
      status: row.call.status,
      durationSeconds: row.call.durationSeconds,
      firstTimeCaller: row.call.firstTimeCaller,
      outcome: verdict.outcome,
      outcomeLabel: tel.CALL_OUTCOME[verdict.outcome].label,
      customerId: row.call.customerId,
      customerName: row.customerName,
      jobId: row.call.jobId,
    };
  });
}

export const handlers = {
  getMarketingFunnel: (ctx: ServiceContext, input: FunnelInput) => funnel(ctx, input),
  drillMarketingFunnel: (ctx: ServiceContext, input: FunnelInput & { key: string; measure: Measure }) =>
    drill(ctx, input),
  listMarketingCalls: async (ctx: ServiceContext, input: {
    from: string; to: string; numberId?: string | undefined; campaignId?: string | undefined;
    channelId?: string | undefined; limit?: number | undefined;
  }) => ({ calls: await callLog(ctx, input) }),
  getMarketingCall: (ctx: ServiceContext, input: { id: string }) => getCall(ctx, input),
} as const;
