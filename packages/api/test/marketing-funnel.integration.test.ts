import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as acquisition from "../src/services/acquisition";
import * as report from "../src/services/marketing-report";
import * as marketing from "../src/services/marketing";
import * as phoneNumbers from "../src/services/phone-numbers";
import * as callTracking from "../src/services/call-tracking";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as leadConnectors from "../src/services/lead-connectors";
import * as leadIntake from "../src/services/lead-intake";
import { createLeadSource, signLeadWebhook, SIGNATURE_HEADER as LEAD_SIGNATURE, TIMESTAMP_HEADER } from "../src/marketing/index";
import { callRailSignature, SIGNATURE_HEADER } from "../src/call-tracking/callrail";
import "../src/call-tracking/index";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE STORY THE MARKETING MODULE EXISTS TO TELL
 *
 * The office sets up a channel (Google Ads) and a tracking campaign under it
 * (Spring AC tune up) with its cost, and puts a tracking number on the
 * campaign. Somebody rings that number and CallRail tells us. The caller
 * becomes a customer, a CSR books them a job the ordinary way, it is invoiced
 * and paid. And then the funnel, by number, by campaign and by channel, has to
 * say: one call, one lead, one booked job, this much revenue, this cost per
 * lead, this cost per booked job, this return, with every one of those
 * numbers openable into the rows behind it, and the rows adding up to it.
 *
 * Every step goes through the path the product uses. Nothing in here sets a
 * marketing column with SQL, because the defect this module had for longest
 * was a column that only a test ever wrote.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("funnel:org");
const USER = fixtureId("funnel:user");
const SIGNING_KEY = "a-callrail-signing-key-for-the-funnel";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const RANGE = { from: day(-1), to: day(1) };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Funnel Co", slug: "funnel-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

/** A signed CallRail post-call webhook, delivered through the same resolve and receive the route uses. */
async function ring(input: { id: string; from: string; to: string; answered?: boolean; at?: Date }) {
  const [row] = await raw<{ settings: { webhookToken: string } }[]>`
    select settings from public.integration_connection
    where organization_id = ${ORG} and provider = 'callrail'`;
  const connection = await callTracking.resolveWebhook(db(), row!.settings.webhookToken, {
    readSecret: async (ref) => (ref.includes("SECRET") ? SIGNING_KEY : "not-a-real-api-key"),
  });
  const at = input.at ?? new Date();
  const body = JSON.stringify({
    resource_id: input.id,
    tracking_phone_number: input.to,
    customer_phone_number: input.from,
    customer_name: "Caller",
    start_time: at.toISOString(),
    direction: "inbound",
    answered: input.answered ?? true,
    duration: input.answered === false ? 0 : 212,
    voicemail: false,
    timestamp: at.toISOString(),
  });
  return callTracking.receive(db(), connection!, {
    body, headers: { [SIGNATURE_HEADER]: callRailSignature(SIGNING_KEY, body) },
  }, at);
}

type Funnel = Awaited<ReturnType<typeof report.funnel>>;
type Cells = Funnel["total"];
/** Every kind of drill as one shape, so a test can read whichever list came back. */
type Drilled = {
  calls?: { callId: string; outcome: string; customerName: string | null }[];
  leads?: { customerId: string | null; weight: number; share: string }[];
  jobs?: { jobId: string; weight: number; revenue: string }[];
  spend?: { amount: string }[];
};
const drill = async (input: Parameters<typeof report.drill>[1]): Promise<Drilled> =>
  report.drill(ctx(), input) as Promise<Drilled>;

/**
 * THE DRILL ADDS UP TO THE CELL, for every row and every column.
 *
 * Calls are counted, people's and booked and completed jobs' shares are summed
 * in ten thousandths, revenue and spend are summed to the cent. A drill that
 * did not add up to the number somebody clicked would be the report's own
 * evidence against it.
 */
async function assertDrillsAddUp(funnel: Funnel, input: report.FunnelInput) {
  const keys = [...funnel.rows.map((r) => ({ key: r.key, cells: r as Cells })), { key: "all", cells: funnel.total }];
  const cents = (value: string) => Math.round(Number(value) * 100);
  for (const { key, cells } of keys) {
    for (const measure of report.MEASURES) {
      const drilled = await drill({ ...input, key, measure });
      const why = `${input.by} ${key} ${measure}`;
      switch (measure) {
        case "calls": case "answered": case "missed": case "firstTime":
          expect(drilled.calls?.length, why).toBe(cells[measure]);
          break;
        case "leads":
          /** A person's share on this row, so a person split across two rows is half a lead on each. */
          expect(drilled.leads!.reduce((s, l) => s + l.weight, 0), why).toBe(cells.leadsWeight);
          break;
        case "booked":
          expect(drilled.jobs!.reduce((s, j) => s + j.weight, 0), why).toBe(cells.bookedWeight);
          break;
        case "completed":
          expect(drilled.jobs!.reduce((s, j) => s + j.weight, 0), why).toBe(cells.completedWeight);
          break;
        case "revenue":
          expect(drilled.jobs!.reduce((s, j) => s + cents(j.revenue), 0), why).toBe(cents(cells.revenue));
          break;
        case "spend":
          expect(drilled.spend!.reduce((s, x) => s + cents(x.amount), 0), why).toBe(cents(cells.spend));
          break;
      }
    }
  }
}

run("a call on a campaign's number, through to a paid job, on the funnel", () => {
  let channelId = "";
  let campaignId = "";
  let numberId = "";
  let callId = "";
  let customerId = "";
  let jobId = "";

  it("starts from the catalogue, and the company adds a campaign under a channel with its cost", async () => {
    const channels = await acquisition.listChannels(ctx());
    const google = channels.find((c) => c.sourceKey === "google_ads")!;
    expect(google.name).toBe("Google Ads");
    expect(channels.some((c) => c.sourceKey === "unknown")).toBe(false);
    channelId = google.id;

    const campaign = await acquisition.createCampaign(ctx(), {
      channelId, name: "Spring AC tune up", budget: "1500", utmCampaign: "Spring AC",
      startsOn: day(-20), endsOn: day(20),
    });
    expect(campaign.utmCampaign).toBe("spring_ac");
    expect(campaign.costModel).toBe("recorded");
    campaignId = campaign.id;

    await expect(acquisition.createCampaign(ctx(), { channelId, name: "spring ac tune up" }))
      .rejects.toThrow(/already a live tracking campaign/);
  });

  it("puts a tracking number on the campaign, and the number's source follows the channel", async () => {
    const number = await phoneNumbers.add(ctx(), {
      e164: "+15125550900", purpose: "tracking", label: "Spring flyer", campaignId,
    });
    expect(number.campaignId).toBe(campaignId);
    expect(number.channelId).toBe(channelId);
    expect(number.attributionSource).toBe("google_ads");
    numberId = number.id;
  });

  it("records what the campaign cost, once per day however often it is typed", async () => {
    await marketing.recordSpend(ctx(), { campaignId, spentOn: day(0), amount: "250.00" });
    await marketing.recordSpend(ctx(), { campaignId, spentOn: day(0), amount: "300.00" });
    const rows = await marketing.listSpend(ctx(), RANGE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe("300.0000");
    expect(rows[0]!.campaignName).toBe("Spring AC tune up");
    expect(rows[0]!.source).toBe("google_ads");
  });

  it("takes the call through the CallRail webhook, on the campaign, as a first time caller", async () => {
    await callTracking.connect(ctx(), { accountId: "ACC1234" });
    const outcome = await ring({ id: "CAL-funnel-1", from: "+15125550177", to: "+15125550900" });
    expect(outcome.kind).toBe("recorded");
    if (outcome.kind !== "recorded") return;
    callId = outcome.callId;

    const [call] = await raw<{
      channel_id: string; acquisition_campaign_id: string; first_time_caller: boolean; phone_number_id: string;
    }[]>`select channel_id, acquisition_campaign_id, first_time_caller, phone_number_id
         from public.call where id = ${callId}`;
    expect(call!.channel_id).toBe(channelId);
    expect(call!.acquisition_campaign_id).toBe(campaignId);
    expect(call!.first_time_caller).toBe(true);
    expect(call!.phone_number_id).toBe(numberId);

    const [touch] = await raw<{ call_id: string; caller_e164: string; acquisition_campaign_id: string; source: string }[]>`
      select call_id, caller_e164, acquisition_campaign_id, source from public.marketing_touch where call_id = ${callId}`;
    expect(touch).toMatchObject({
      call_id: callId, caller_e164: "+15125550177", acquisition_campaign_id: campaignId, source: "google_ads",
    });
  });

  it("counts the caller as a lead before anybody has made them a customer", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "campaign" });
    const row = funnel.rows.find((r) => r.key === campaignId)!;
    expect(row.calls).toBe(1);
    expect(row.leads).toBe(1);
    expect(row.booked).toBe("0");
    expect(row.costPerLead).toBe("300.0000");
    expect(row.costPerBookedJob).toBeNull();
  });

  it("stitches the call to the customer it becomes, however the number was typed", async () => {
    const created = await customers.create(ctx(), {
      type: "residential", name: "Rosa Delgado", phone: "(512) 555-0177",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
      property: { address: { line1: "41 Larkspur Ln", city: "Austin", state: "TX", postalCode: "78745", country: "US" } },
    });
    customerId = created.id as string;
    expect(created.leadSource).toBe("google_ads");
    expect(created.leadSourceOrigin).toBe("derived");
    expect(created.channelId).toBe(channelId);
    expect(created.acquisitionCampaignId).toBe(campaignId);

    const [call] = await raw<{ customer_id: string }[]>`select customer_id from public.call where id = ${callId}`;
    expect(call!.customer_id).toBe(customerId);
  });

  it("credits the job a CSR books through the ordinary path, and links the call to it", async () => {
    const [property] = await raw<{ id: string }[]>`
      select property_id as id from public.customer_property where customer_id = ${customerId}`;
    const job = await jobs.create(ctx(), {
      customerId, propertyId: property!.id, summary: "AC tune up", tags: [], customFields: {}, callId,
    });
    jobId = job.id as string;
    expect(job.leadSource).toBe("google_ads");
    expect(job.leadSourceOrigin).toBe("derived");
    expect(job.channelId).toBe(channelId);
    expect(job.acquisitionCampaignId).toBe(campaignId);

    const [call] = await raw<{ job_id: string }[]>`select job_id from public.call where id = ${callId}`;
    expect(call!.job_id).toBe(jobId);

    const origin = await marketing.attributeJob(ctx(), { jobId });
    expect(origin.touchCount).toBe(1);
    expect(origin.touches[0]!.campaignName).toBe("Spring AC tune up");
    expect(origin.touches[0]!.channelName).toBe("Google Ads");
  });

  it("invoices and is paid", async () => {
    const invoice = await billing.create(ctx(), {
      customerId, jobId,
      lines: [
        { name: "Tune up", quantity: "1", unitPrice: "389.00", discountAmount: "0", taxable: false },
        { name: "Filter", quantity: "1", unitPrice: "111.00", discountAmount: "0", taxable: false },
      ],
    });
    await billing.pay({ ...ctx(), idempotencyKey: `funnel-pay-${jobId}` }, {
      customerId, method: "card", amount: "500.00", tipAmount: "0",
      allocations: [{ invoiceId: invoice.id as string, amount: "500.00" }],
    });
    const job = await jobs.get(ctx(), { id: jobId });
    expect(job.status).toBe("paid");
  });

  it("shows the number, the campaign and the channel each with the call, the lead, the job, the revenue and the return", async () => {
    for (const [by, key] of [["number", numberId], ["campaign", campaignId], ["channel", channelId]] as const) {
      const funnel = await report.funnel(ctx(), { ...RANGE, by });
      const row = funnel.rows.find((r) => r.key === key)!;
      expect(row, by).toBeDefined();
      expect(row.spend, by).toBe("300.0000");
      expect(row.calls, by).toBe(1);
      expect(row.answered, by).toBe(1);
      expect(row.missed, by).toBe(0);
      expect(row.firstTime, by).toBe(1);
      expect(row.leads, by).toBe(1);
      expect(row.booked, by).toBe("1");
      expect(row.completed, by).toBe("1");
      expect(row.revenue, by).toBe("500.0000");
      expect(row.bookingRate, by).toBe("100.00");
      expect(row.averageTicket, by).toBe("500.0000");
      expect(row.costPerLead, by).toBe("300.0000");
      expect(row.costPerBookedJob, by).toBe("300.0000");
      expect(row.roas, by).toBe("1.6667");
      expect(row.roi, by).toBe("66.67");
      await assertDrillsAddUp(funnel, { ...RANGE, by });
    }
  });

  it("opens each number into the rows behind it", async () => {
    const calls = await drill({ ...RANGE, by: "campaign", key: campaignId, measure: "calls" });
    expect(calls.calls!.map((c) => c.callId)).toEqual([callId]);
    expect(calls.calls![0]!.outcome).toBe("booked");
    expect(calls.calls![0]!.customerName).toBe("Rosa Delgado");

    const leads = await drill({ ...RANGE, by: "campaign", key: campaignId, measure: "leads" });
    expect(leads.leads![0]!.customerId).toBe(customerId);

    const jobsRows = await drill({ ...RANGE, by: "campaign", key: campaignId, measure: "revenue" });
    expect(jobsRows.jobs!.map((j) => [j.jobId, j.revenue])).toEqual([[jobId, "500.0000"]]);

    const spend = await drill({ ...RANGE, by: "campaign", key: campaignId, measure: "spend" });
    expect(spend.spend!.map((s) => s.amount)).toEqual(["300.0000"]);
  });

  it("lists the call on the call log with what it amounted to", async () => {
    const log = await report.callLog(ctx(), RANGE);
    const row = log.find((c) => c.id === callId)!;
    expect(row.campaignName).toBe("Spring AC tune up");
    expect(row.channelName).toBe("Google Ads");
    expect(row.firstTimeCaller).toBe(true);
    expect(row.outcomeLabel).toBe("Booked");
    expect(row.customerName).toBe("Rosa Delgado");
  });

  it("puts the same campaign and channel on the jobs report and the calls dataset", async () => {
    const reports = await import("../src/services/reports");
    const byCampaign = await reports.run(ctx(), {
      dataset: "jobs", dimensions: ["tracking_campaign", "channel", "lead_source"], measures: ["count"],
    });
    expect(byCampaign.rows).toContainEqual(expect.objectContaining({
      tracking_campaign: "Spring AC tune up", channel: "Google Ads", lead_source: "Google Ads", count: 1,
    }));
    const calls = await reports.run(ctx(), {
      dataset: "calls", dimensions: ["tracking_campaign"], measures: ["count", "booked"],
    });
    expect(calls.rows).toContainEqual(expect.objectContaining({ tracking_campaign: "Spring AC tune up", count: 1, booked: 1 }));
  });

  it("calls the second ring from the same number an existing caller", async () => {
    await ring({ id: "CAL-funnel-2", from: "+15125550177", to: "+15125550900", answered: false });
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "number" });
    const row = funnel.rows.find((r) => r.key === numberId)!;
    expect(row.calls).toBe(2);
    expect(row.firstTime).toBe(1);
    expect(row.missed).toBe(1);
    /** Still one person. */
    expect(row.leads).toBe(1);
    await assertDrillsAddUp(funnel, { ...RANGE, by: "number" });
  });
});

run("a lead source somebody chose", () => {
  it("is a declared touch, and the job's own columns say it was chosen", async () => {
    const options = await acquisition.channelOptions(ctx());
    const yard = options.find((c) => c.sourceKey === "yard_sign")!;
    const created = await customers.create(ctx(), {
      type: "residential", name: "Theo Brandt", phone: "+15125550411", channelId: yard.id,
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
      property: { address: { line1: "9 Pecan St", city: "Austin", state: "TX", postalCode: "78704", country: "US" } },
    });
    expect(created.leadSource).toBe("yard_sign");
    expect(created.leadSourceOrigin).toBe("manual");
    const [property] = await raw<{ id: string }[]>`
      select property_id as id from public.customer_property where customer_id = ${created.id as string}`;
    const job = await jobs.create(ctx(), {
      customerId: created.id as string, propertyId: property!.id, summary: "Leaking valve",
      tags: [], customFields: {},
    });
    expect(job.leadSource).toBe("yard_sign");
    const [touch] = await raw<{ basis: string; entered_by_user_id: string; job_id: string }[]>`
      select basis, entered_by_user_id, job_id from public.marketing_touch where customer_id = ${created.id as string}`;
    expect(touch).toMatchObject({ basis: "declared", entered_by_user_id: USER, job_id: job.id });

    /** Corrected on the job: a second declared touch, and the columns follow. */
    const google = options.find((c) => c.sourceKey === "google_ads")!;
    const updated = await jobs.update(ctx(), { id: job.id as string, channelId: google.id });
    expect(updated.leadSource).toBe("google_ads");
    const [count] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.marketing_touch where job_id = ${job.id as string}`;
    expect(count!.n).toBe(2);
  });

  it("refuses a word the channel list cannot place, and keeps it for a record from another system", async () => {
    await expect(customers.create(ctx(), {
      type: "residential", name: "Unplaced", leadSource: "my cousin's barbecue",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    })).rejects.toThrow(ConflictError);

    const aliased = await customers.create(ctx(), {
      type: "residential", name: "Aliased", leadSource: "Angi",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    expect(aliased.leadSource).toBe("marketplace");

    const imported = await customers.create(ctx(), {
      type: "residential", name: "Imported", leadSource: "my cousin's barbecue",
      externalRef: { source: "jobber", id: "C-991" },
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    expect(imported.leadSource).toBe("my cousin's barbecue");
    expect(imported.leadSourceOrigin).toBe("imported");
  });

  it("is required when the company says so, and only when nothing else can say", async () => {
    await acquisition.setSettings(ctx(), { requireLeadSource: true });
    try {
      await expect(customers.create(ctx(), {
        type: "residential", name: "Nobody asked", phone: "+15125550499",
        paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
      })).rejects.toThrow(/asks where every new customer came from/);
    } finally {
      await acquisition.setSettings(ctx(), { requireLeadSource: false });
    }
  });
});

run("every path that creates work is credited", () => {
  it("credits an estimate converted to a job", async () => {
    const options = await acquisition.channelOptions(ctx());
    const mail = options.find((c) => c.sourceKey === "direct_mail")!;
    const created = await customers.create(ctx(), {
      type: "residential", name: "Estimate Person", channelId: mail.id,
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
      property: { address: { line1: "3 Elm", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
    });
    const customerId = created.id as string;
    const [property] = await raw<{ id: string }[]>`
      select property_id as id from public.customer_property where customer_id = ${customerId}`;
    const estimate = await estimates.create(ctx(), {
      customerId, propertyId: property!.id, taxRate: "0",
      options: [{ name: "Standard", isRecommended: true, lines: [
        { name: "Condenser", quantity: "1", unitPrice: "4000.00", discountAmount: "0",
          taxable: false, isOptional: false, isSelected: false }] }],
    }) as Record<string, unknown>;
    const optionId = (estimate["options"] as { id: string }[])[0]!.id;
    await estimates.approve(ctx(), {
      id: estimate["id"] as string, optionId, selectedLineIds: [], signerName: "Pat", capturedVia: "phone",
    });
    const converted = await estimates.convert(ctx(), {
      id: estimate["id"] as string, createJob: true, createInvoice: false,
    });
    const [job] = await raw<{ lead_source: string; channel_id: string; lead_source_origin: string }[]>`
      select lead_source, channel_id, lead_source_origin from public.job where id = ${converted.jobId!}`;
    expect(job).toMatchObject({ lead_source: "direct_mail", channel_id: mail.id, lead_source_origin: "derived" });
  });
});

run("a lead from a marketplace named angi", () => {
  const SAMPLE = {
    lead_id: "ANG-777",
    contact: { full_name: "Dana Whitfield", phone_number: "+15125550133", email: "dana@example.com" },
    address: { street: "812 Mesquite Dr", city: "Austin", state: "TX", zip: "78745" },
    task: "Water heater not producing hot water",
    notes: "Gate code 4417",
  };
  const MAP = {
    externalId: "lead_id", contactName: "contact.full_name", contactPhone: "contact.phone_number",
    contactEmail: "contact.email", addressLine1: "address.street", city: "address.city",
    state: "address.state", postalCode: "address.zip", serviceRequested: "task", notes: "notes",
  };

  /**
   * THE WEBHOOK, END TO END: the connector the office made, its token, its
   * own field map and signing secret, the same verify and parse the route
   * calls, and `receiveLead`. The documented example connector is `angi`,
   * and until this change it could not receive a single lead: the source
   * went straight to the touch, the touch refused anything outside the
   * catalogue, and the lead was rolled back with it.
   */
  async function deliver(body: object) {
    const [connector] = await raw<{ id: string; field_map: Record<string, string>; source: string; webhook_token: string }[]>`
      select id, field_map, source, webhook_token from public.lead_source_connector
      where organization_id = ${ORG} and source = 'angi' and deleted_at is null`;
    const secret = "lhsec_test_secret_for_angi";
    const url = `https://example.test/api/webhooks/leads/${connector!.webhook_token}`;
    const text = JSON.stringify(body);
    const signed = signLeadWebhook({ secret, url, body: text, timestamp: Date.now() });
    const adapter = createLeadSource("lead_webhook", { fieldMap: connector!.field_map, source: connector!.source });
    const request = {
      url, body: text,
      headers: { [LEAD_SIGNATURE]: signed.signature, [TIMESTAMP_HEADER]: signed.timestamp },
    };
    expect(adapter.verify(request, secret)).toBe(true);
    const lead = adapter.parse(request)!;
    return leadIntake.receiveLead(db(), {
      connectorId: connector!.id, organizationId: ORG, lead: { ...lead, source: connector!.source },
    });
  }

  /** What the marketplace row held before these leads, since earlier tests in this file chose it too. */
  let before = { leads: 0, bookedWeight: 0 };
  const marketplaceRow = async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel" });
    return funnel.rows.find((r) => r.label === "A lead marketplace") ?? { leads: 0, bookedWeight: 0, booked: "0" };
  };

  it("sets up angi onto the marketplace channel, because the alias list knows what angi is", async () => {
    const row = await marketplaceRow();
    before = { leads: row.leads, bookedWeight: row.bookedWeight };
    const made = await leadConnectors.create(ctx(), { source: "angi", displayName: "Angi", fieldMap: MAP });
    const options = await acquisition.channelOptions(ctx());
    expect(made.channelId).toBe(options.find((c) => c.sourceKey === "marketplace")!.id);
    expect(made.channelGuessed).toBe(false);
  });

  it("takes the lead, keeps who to ring, and counts it as a lead on the marketplace", async () => {
    const outcome = await deliver(SAMPLE);
    expect(outcome.accepted).toBe(true);
    const [offer] = await raw<{ contact_name: string; contact_phone: string; contact_email: string; notes: string }[]>`
      select contact_name, contact_phone, contact_email, notes from public.lead_offer where id = ${outcome.offerId!}`;
    expect(offer).toEqual({
      contact_name: "Dana Whitfield", contact_phone: "+15125550133",
      contact_email: "dana@example.com", notes: "Gate code 4417",
    });
    const [touch] = await raw<{ source: string; basis: string }[]>`
      select source, basis from public.marketing_touch where visitor_id = ${leadIntake.offerThread(outcome.offerId!)}`;
    expect(touch).toEqual({ source: "marketplace", basis: "declared" });

    expect((await marketplaceRow()).leads).toBe(before.leads + 1);
  });

  it("accepts it into a customer, a property and a job credited to the marketplace", async () => {
    const [offer] = await raw<{ id: string }[]>`
      select id from public.lead_offer where organization_id = ${ORG} and external_id = 'ANG-777'`;
    const accepted = await leadIntake.acceptOffer(ctx(), { id: offer!.id });
    const again = await leadIntake.acceptOffer(ctx(), { id: offer!.id });
    expect(again.jobId).toBe(accepted.jobId);

    const [job] = await raw<{ lead_source: string; summary: string }[]>`
      select lead_source, summary from public.job where id = ${accepted.jobId}`;
    expect(job).toEqual({ lead_source: "marketplace", summary: "Water heater not producing hot water" });
    const [customer] = await raw<{ name: string; phone: string }[]>`
      select name, phone from public.customer where id = ${accepted.customerId}`;
    expect(customer).toEqual({ name: "Dana Whitfield", phone: "+15125550133" });

    /** One more job, and still one more person rather than two: the lead and the customer are one. */
    const row = await marketplaceRow();
    expect(row.bookedWeight).toBe(before.bookedWeight + 10_000);
    expect(row.leads).toBe(before.leads + 1);
  });

  it("declines another with a reason that can be counted", async () => {
    const outcome = await deliver({ ...SAMPLE, lead_id: "ANG-778", contact: { ...SAMPLE.contact, phone_number: "+15125550134" } });
    await leadIntake.declineOffer(ctx(), { id: outcome.offerId!, reason: "outside_area", note: "Round Rock" });
    const [offer] = await raw<{ status: string; decline_reason: string }[]>`
      select status, decline_reason from public.lead_offer where id = ${outcome.offerId!}`;
    expect(offer).toEqual({ status: "declined", decline_reason: "outside_area: Round Rock" });
    await expect(leadIntake.acceptOffer(ctx(), { id: outcome.offerId! })).rejects.toThrow(/declined already/);
  });
});

run("a job two channels share, under a split model", () => {
  it("puts half a job on each and the halves add back to one, to the cent", async () => {
    const options = await acquisition.channelOptions(ctx());
    const meta = options.find((c) => c.sourceKey === "meta_ads")!;
    const radio = options.find((c) => c.sourceKey === "radio")!;
    const created = await customers.create(ctx(), {
      type: "residential", name: "Split Person", channelId: meta.id,
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
      property: { address: { line1: "77 Split Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
    });
    const customerId = created.id as string;
    const [property] = await raw<{ id: string }[]>`
      select property_id as id from public.customer_property where customer_id = ${customerId}`;
    const job = await jobs.create(ctx(), {
      customerId, propertyId: property!.id, summary: "Split job", channelId: radio.id, tags: [], customFields: {},
    });
    await billing.create(ctx(), {
      customerId, jobId: job.id as string,
      lines: [{ name: "Work", quantity: "1", unitPrice: "100.01", discountAmount: "0", taxable: false }],
    });

    const input = { ...RANGE, by: "channel" as const, model: "linear" as const };
    const funnel = await report.funnel(ctx(), input);
    const metaRow = funnel.rows.find((r) => r.key === meta.id)!;
    const radioRow = funnel.rows.find((r) => r.key === radio.id)!;
    expect(metaRow.booked).toBe("0.5");
    expect(radioRow.booked).toBe("0.5");
    expect(Math.round((Number(metaRow.revenue) + Number(radioRow.revenue)) * 100)).toBe(10001);
    await assertDrillsAddUp(funnel, input);
  });
});

run("costs that are not a spend row a day", () => {
  it("spreads a fixed price over its days and prices a lead at the campaign's price", async () => {
    const options = await acquisition.channelOptions(ctx());
    const radio = options.find((c) => c.sourceKey === "radio")!;
    const lsa = options.find((c) => c.sourceKey === "google_lsa")!;
    const fixed = await acquisition.createCampaign(ctx(), {
      channelId: radio.id, name: "Morning drive spot", costModel: "fixed", costAmount: "1000",
      startsOn: day(-9), endsOn: day(0),
    });
    const perLead = await acquisition.createCampaign(ctx(), {
      channelId: lsa.id, name: "LSA plumbing", costModel: "per_lead", costAmount: "35",
      utmCampaign: "lsa_plumbing",
    });
    await phoneNumbers.add(ctx(), { e164: "+15125550901", purpose: "tracking", campaignId: perLead.id });
    await ring({ id: "CAL-lsa-1", from: "+15125550601", to: "+15125550901" });
    await ring({ id: "CAL-lsa-2", from: "+15125550602", to: "+15125550901" });

    const funnel = await report.funnel(ctx(), { from: day(-1), to: day(1), by: "campaign" });
    /** Ten days for a thousand, two of which are in the range. */
    expect(funnel.rows.find((r) => r.key === fixed.id)!.spend).toBe("200.0000");
    const lsaRow = funnel.rows.find((r) => r.key === perLead.id)!;
    expect(lsaRow.leads).toBe(2);
    expect(lsaRow.spend).toBe("70.0000");
    expect(lsaRow.costPerLead).toBe("35.0000");
    await assertDrillsAddUp(funnel, { from: day(-1), to: day(1), by: "campaign" });
  });
});
