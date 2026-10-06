import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { marketing as mk, type Actor } from "@opentradesos/core";
import * as acquisition from "../src/services/acquisition";
import * as report from "../src/services/marketing-report";
import * as overview from "../src/services/marketing-overview";
import * as phoneNumbers from "../src/services/phone-numbers";
import * as callTracking from "../src/services/call-tracking";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import { callRailSignature, SIGNATURE_HEADER } from "../src/call-tracking/callrail";
import "../src/call-tracking/index";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A LEAD IS CREDITED UNDER THE COMPANY'S MODEL, THE WAY A JOB IS
 *
 * The funnel credited a booked job under the chosen model and then counted a
 * person as a whole lead on every channel they had touched, so the lead column
 * added up to more people than there were and a split model could not be read
 * against it. Three people here:
 *
 *   Ana rang the Google Ads number, then was entered as a customer from a Meta
 *   ad, then had a job entered from a yard sign: three touches on three
 *   channels, and a job that those same three touches are credited to.
 *   Ben was entered once, from a yard sign.
 *   Cy rang the Google Ads number and was never made a customer.
 *
 * Everything goes through the paths the product uses.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("leadcredit:org");
const USER = fixtureId("leadcredit:user");
const SIGNING_KEY = "a-callrail-signing-key-for-lead-credit";
const SCALE = mk.WEIGHT_SCALE;

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});
const RANGE = { from: companyToday(-1), to: companyToday(1) };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lead Credit Co", slug: "lead-credit-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

async function ring(input: { id: string; from: string; to: string; at: Date }) {
  const [row] = await raw<{ settings: { webhookToken: string } }[]>`
    select settings from public.integration_connection
    where organization_id = ${ORG} and provider = 'callrail'`;
  const connection = await callTracking.resolveWebhook(db(), row!.settings.webhookToken, {
    readSecret: async (ref) => (ref.includes("SECRET") ? SIGNING_KEY : "not-a-real-api-key"),
  });
  const body = JSON.stringify({
    resource_id: input.id, tracking_phone_number: input.to, customer_phone_number: input.from,
    customer_name: "Caller", start_time: input.at.toISOString(), direction: "inbound",
    answered: true, duration: 120, voicemail: false, timestamp: input.at.toISOString(),
  });
  return callTracking.receive(db(), connection!, {
    body, headers: { [SIGNATURE_HEADER]: callRailSignature(SIGNING_KEY, body) },
  }, input.at);
}

const property = (line1: string) => ({
  address: { line1, city: "Austin", state: "TX", postalCode: "78745", country: "US" },
});
const newCustomer = (name: string, phone: string, channelId: string, line1: string) =>
  customers.create(ctx(), {
    type: "residential", name, phone, channelId,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: property(line1),
  });

type Funnel = Awaited<ReturnType<typeof report.funnel>>;
/** The people behind a cell, as the drill returns them. */
type Person = { key: string; customerId: string | null; share: string; weight: number; touches: number };
const peopleBehind = async (input: Omit<Parameters<typeof report.drill>[1], "measure">) => {
  const drilled = await report.drill(ctx(), { ...input, measure: "leads" });
  return { cell: drilled.cell, leads: (drilled as { leads?: Person[] }).leads ?? [] };
};
const weights = (funnel: Funnel) => Object.fromEntries(funnel.rows.map((r) => [r.key, r.leadsWeight]));

run("leads credited by the attribution model", () => {
  let google = "";
  let meta = "";
  let yard = "";
  let campaignId = "";
  let numberId = "";
  let anaJobId = "";

  it("sets up three people with touches on three channels and a job for one of them", async () => {
    const options = await acquisition.channelOptions(ctx());
    google = options.find((c) => c.sourceKey === "google_ads")!.id;
    meta = options.find((c) => c.sourceKey === "meta_ads")!.id;
    yard = options.find((c) => c.sourceKey === "yard_sign")!.id;
    const campaign = await acquisition.createCampaign(ctx(), { channelId: google, name: "Lead credit AC", utmCampaign: "lead_credit_ac" });
    campaignId = campaign.id;
    const number = await phoneNumbers.add(ctx(), { e164: "+15125550930", purpose: "tracking", label: "Flyer", campaignId });
    numberId = number.id;
    await callTracking.connect(ctx(), { accountId: "ACC-LC" });

    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);
    await ring({ id: "CAL-lc-ana", from: "+15125550811", to: "+15125550930", at: hoursAgo(3) });
    await ring({ id: "CAL-lc-cy", from: "+15125550822", to: "+15125550930", at: hoursAgo(2) });

    const ana = await newCustomer("Ana Lopez", "+15125550811", meta, "1 Ana St");
    await newCustomer("Ben Ito", "+15125550833", yard, "2 Ben St");
    const [prop] = await raw<{ id: string }[]>`
      select property_id as id from public.customer_property where customer_id = ${ana.id as string}`;
    const job = await jobs.create(ctx(), {
      customerId: ana.id as string, propertyId: prop!.id, summary: "Ana's job", channelId: yard,
      tags: [], customFields: {},
    });
    anaJobId = job.id as string;

    const touches = await raw<{ source: string; customer_id: string | null; job_id: string | null }[]>`
      select source, customer_id, job_id from public.marketing_touch
      where organization_id = ${ORG} order by occurred_at, id`;
    /** Ana's call was stitched to her once she became a customer, and the job holds all three of her touches. */
    expect(touches.filter((t) => t.job_id === anaJobId).map((t) => t.source)).toEqual(["google_ads", "meta_ads", "yard_sign"]);
  });

  it("counts each person once in the total and, by default, on the last channel that was not direct", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel" });
    expect(funnel.model).toBe("last_non_direct");
    expect(funnel.total.leads).toBe(3);
    expect(funnel.total.leadsWeight).toBe(3 * SCALE);
    expect(weights(funnel)).toEqual({ [google]: SCALE, [yard]: 2 * SCALE });
    /** Before this, Ana was a whole lead on Google, Meta and the yard sign and the column added to five. */
    expect(funnel.rows.reduce((sum, r) => sum + r.leadsWeight, 0)).toBe(funnel.total.leadsWeight);
  });

  it("credits first touch to the first thing each person did", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel", model: "first_touch" });
    expect(weights(funnel)).toEqual({ [google]: 2 * SCALE, [yard]: SCALE });
  });

  it("credits last touch to the last thing each person did", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel", model: "last_touch" });
    expect(weights(funnel)).toEqual({ [google]: SCALE, [yard]: 2 * SCALE });
  });

  it("splits Ana a third each under an even split, and the thirds add back to her", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel", model: "linear" });
    expect(weights(funnel)).toEqual({ [google]: SCALE + 3334, [meta]: 3333, [yard]: SCALE + 3333 });
    expect(funnel.rows.find((r) => r.key === meta)!.leads).toBe(0.3333);
    expect(funnel.total.leads).toBe(3);
  });

  it("weights the first and the last of Ana's touches under the weighted split", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel", model: "position_based" });
    expect(weights(funnel)).toEqual({ [google]: SCALE + 4000, [meta]: 2000, [yard]: SCALE + 4000 });
  });

  it("credits a lead and a job by the same rule, so Ana's lead and her job land on the same rows", async () => {
    for (const model of mk.ATTRIBUTION_MODEL_KEYS) {
      const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel", model });
      /** Cy is a whole lead on Google under every model, and Ben a whole lead on the yard sign. */
      const others: Record<string, number> = { [google]: SCALE, [yard]: SCALE };
      for (const row of funnel.rows) {
        expect(row.bookedWeight, `${model} ${row.label}`).toBe(row.leadsWeight - (others[row.key] ?? 0));
      }
      expect(funnel.rows.reduce((sum, r) => sum + r.bookedWeight, 0), model).toBe(SCALE);
    }
  });

  it("adds up to the total on every cut of the report, under every model", async () => {
    for (const model of mk.ATTRIBUTION_MODEL_KEYS) {
      for (const by of ["channel", "campaign", "number", "platform"] as const) {
        const funnel = await report.funnel(ctx(), { ...RANGE, by, model });
        expect(funnel.rows.reduce((sum, r) => sum + r.leadsWeight, 0), `${model} by ${by}`).toBe(3 * SCALE);
        expect(funnel.total.leadsWeight, `${model} by ${by}`).toBe(3 * SCALE);
      }
    }
  });

  it("puts the people with no tracking campaign on a row of their own rather than dropping them", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "campaign", model: "linear" });
    const none = funnel.rows.find((r) => r.key === "none")!;
    const campaign = funnel.rows.find((r) => r.key === campaignId)!;
    /** Ana's two calls-less touches (Meta and the yard sign) and Ben are not on the campaign. */
    expect(none.leadsWeight).toBe(SCALE + 3333 + 3333);
    expect(campaign.leadsWeight).toBe(SCALE + 3334);
  });

  it("opens a row into the people behind it with each one's share, and the shares add to the cell", async () => {
    const input = { ...RANGE, by: "channel" as const, model: "linear" as const };
    const funnel = await report.funnel(ctx(), input);
    for (const row of [...funnel.rows, { key: "all", ...funnel.total }]) {
      const drilled = await peopleBehind({ ...input, key: row.key });
      const leads = drilled.leads;
      expect(leads.reduce((sum, l) => sum + l.weight, 0), row.key).toBe(row.leadsWeight);
      expect(drilled.cell.leadsWeight).toBe(row.leadsWeight);
    }
    const onMeta = await peopleBehind({ ...input, key: meta });
    expect(onMeta.leads).toHaveLength(1);
    expect(onMeta.leads[0]).toMatchObject({ customerId: expect.any(String), share: "0.33", weight: 3333, touches: 1 });
    const total = await peopleBehind({ ...input, key: "all" });
    expect(total.leads.map((l) => l.share)).toEqual(["1", "1", "1"]);
  });

  it("cuts cost per lead and booking rate by the credited leads", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel", model: "linear" });
    const row = funnel.rows.find((r) => r.key === meta)!;
    /** A third of a person and a third of a job: the rate is the same fraction either way. */
    expect(row.bookedWeight).toBe(3333);
    expect(row.bookingRate).toBe("100.00");
  });

  it("uses the company's own model when none is asked for, and the overview agrees with the funnel", async () => {
    await acquisition.setSettings(ctx(), { attributionModel: "linear" });
    try {
      const funnel = await report.funnel(ctx(), { ...RANGE, by: "channel" });
      expect(funnel.model).toBe("linear");
      expect(funnel.rows.find((r) => r.key === meta)!.leadsWeight).toBe(3333);
      const view = await overview.overview(ctx(), RANGE);
      expect(view.totals.leadsWeight).toBe(3 * SCALE);
      expect(view.rows.reduce((sum, r) => sum + r.leadsWeight, 0)).toBe(3 * SCALE);
      expect(view.rows.find((r) => r.source === "meta_ads")).toMatchObject({ leads: 0.3333, leadsWeight: 3333 });
    } finally {
      await acquisition.setSettings(ctx(), { attributionModel: "last_non_direct" });
    }
  });

  it("reads a number's own leads off the number the person rang", async () => {
    const funnel = await report.funnel(ctx(), { ...RANGE, by: "number", model: "first_touch" });
    /** Ana's first touch and Cy's only touch were calls on the number. */
    expect(funnel.rows.find((r) => r.key === numberId)!.leadsWeight).toBe(2 * SCALE);
  });
});
