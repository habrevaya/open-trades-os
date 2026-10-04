import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import postgres from "postgres";
import * as leadIntake from "../src/services/lead-intake";
import * as adPlatforms from "../src/services/ad-platforms";
import * as metaLeads from "../src/services/meta-leads";
import * as acquisition from "../src/services/acquisition";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { ENV, SECRETS, fakePlatform, formOf, stateOf } from "./ads-fakes";

/**
 * MICROSOFT ADVERTISING AND META'S INSTANT FORMS, AGAINST FAKES OF EACH
 *
 * Microsoft: a sign in on Microsoft's consent screen that asks for offline
 * access and keeps the refresh token Microsoft rotates on every refresh, and
 * spend as a report job: submitted, polled until it is ready, downloaded as a
 * zip and read into the spend rows, filed under the tracking campaign whose
 * name it shares, the same rows however often it is pulled. A report still
 * being prepared is asked for again at the next pull rather than waited on.
 *
 * Meta's instant forms: a post Meta did not sign, or for a Page nobody here
 * connected, opens nothing; a signed one has its lead read back from Meta and
 * credited to Meta and to the tracking campaign its ad campaign is; and the
 * same lead found again by the ten minute pull is the same lead.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("ads-ms-meta:org");
const USER = fixtureId("ads-ms-meta:user");
const PAGE = "4455667788";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const today = () => new Date().toISOString().slice(0, 10);

const store: Record<string, string> = {
  ...SECRETS,
  MS_OAUTH_CLIENT: JSON.stringify({ clientId: "ms-client", clientSecret: "ms-secret-not-real" }),
  MS_DEVELOPER_TOKEN: "ms-developer-token-not-real",
};
const readSecret = async (ref: string) => {
  const value = store[ref];
  if (!value) throw new Error(`No secret named ${ref}`);
  return value;
};
const fake = fakePlatform();
const deps = { transport: fake.transport, readSecret, env: ENV };

/** A zip holding one file, the way Microsoft hands a report back. CRC is not checked by the reader, so it is left zero. */
function zipOf(name: string, text: string): Buffer {
  const data = deflateRawSync(Buffer.from(text, "utf8"));
  const size = Buffer.byteLength(text, "utf8");
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralAt = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(centralAt, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

/* Microsoft's sign in, which rotates the refresh token on each refresh. */
const ms = { refresh: "ms-refresh-1", refreshes: 0, polls: 0, pendingPolls: 1, report: "" };
fake.on("POST", /^https:\/\/msoauth\.fake\/token$/, (call) => {
  const form = formOf(call.body);
  if (form["grant_type"] === "authorization_code") {
    expect(form["scope"]).toBe("https://ads.microsoft.com/msads.manage offline_access");
    return form["code"] === "ms-code"
      ? { status: 200, body: { access_token: "ms-access-1", expires_in: 3600, refresh_token: ms.refresh, scope: form["scope"] } }
      : { status: 400, body: { error: "invalid_grant" } };
  }
  if (form["refresh_token"] !== ms.refresh) return { status: 400, body: { error: "invalid_grant" } };
  ms.refreshes += 1;
  ms.refresh = `ms-refresh-${ms.refreshes + 1}`;
  return { status: 200, body: { access_token: `ms-access-${ms.refreshes + 1}`, expires_in: 3600, refresh_token: ms.refresh } };
});
fake.on("POST", /^https:\/\/msreport\.fake\/GenerateReport\/Submit$/, (call) => {
  expect(call.headers["DeveloperToken"]).toBe("ms-developer-token-not-real");
  expect(call.headers["CustomerId"]).toBe("1112223");
  expect(call.headers["CustomerAccountId"]).toBe("4445556");
  const request = (JSON.parse(call.body) as { ReportRequest: { Type: string; Aggregation: string; Scope: { AccountIds: number[] } } }).ReportRequest;
  expect(request).toMatchObject({ Type: "CampaignPerformanceReportRequest", Aggregation: "Daily", Scope: { AccountIds: [4445556] } });
  ms.polls = 0;
  return { status: 200, body: { ReportRequestId: "rr-1" } };
});
fake.on("POST", /^https:\/\/msreport\.fake\/GenerateReport\/Poll$/, () => {
  ms.polls += 1;
  return ms.polls <= ms.pendingPolls
    ? { status: 200, body: { ReportRequestStatus: { Status: "Pending", ReportDownloadUrl: null } } }
    : { status: 200, body: { ReportRequestStatus: { Status: "Success", ReportDownloadUrl: "https://msstorage.fake/report.zip?sig=abc" } } };
});
/** The download carries its own signature and must be fetched with no token. */
const download = async (callUrl: string, init: { method: string; headers: Record<string, string> }) => {
  expect(init.headers["Authorization"]).toBeUndefined();
  const bytes = zipOf("report.csv", ms.report);
  return {
    status: 200, headers: { get: () => null }, text: async () => "",
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
};
const transport: typeof fake.transport = (u, init) => (u.startsWith("https://msstorage.fake/") ? download(u, init) : fake.transport(u, init));

/* Meta's Graph API for a Page's instant forms. */
const metaLead = (id: string) => ({
  id, created_time: new Date().toISOString(), form_id: "form-1", ad_id: "ad-1", campaign_id: "c-901", campaign_name: "Furnace instant form",
  field_data: [
    { name: "full_name", values: ["Lena Ortiz"] }, { name: "phone_number", values: ["+15125550171"] },
    { name: "email", values: ["lena@example.com"] }, { name: "zip_code", values: ["78704"] },
  ],
});
fake.on("GET", /^https:\/\/graph\.fake\/token\?/, (call) => {
  const q = new URL(call.url).searchParams;
  if (q.get("grant_type") === "fb_exchange_token") return { status: 200, body: { access_token: "meta-user-long", expires_in: 5_184_000 } };
  return { status: 200, body: { access_token: "meta-user-short", expires_in: 3600 } };
});
fake.on("GET", new RegExp(`^https://graph\\.fake/v21\\.0/${PAGE}\\?fields=access_token$`), (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer meta-user-long");
  return { status: 200, body: { access_token: "meta-page-token", id: PAGE } };
});
fake.on("POST", new RegExp(`^https://graph\\.fake/v21\\.0/${PAGE}/subscribed_apps`), () => ({ status: 200, body: { success: true } }));
fake.on("GET", new RegExp(`^https://graph\\.fake/v21\\.0/${PAGE}/leadgen_forms`), () => ({ status: 200, body: { data: [{ id: "form-1", name: "Tune up" }] } }));
fake.on("GET", /^https:\/\/graph\.fake\/v21\.0\/form-1\/leads\?/, (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer meta-page-token");
  return { status: 200, body: { data: [metaLead("9001")] } };
});
fake.on("GET", /^https:\/\/graph\.fake\/v21\.0\/9001\?fields=/, (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer meta-page-token");
  return { status: 200, body: metaLead("9001") };
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ads MS Meta Co", slug: "ads-ms-meta-co" });
});
afterAll(async () => {
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await raw.end();
});

const signIn = async (provider: string, code: string) => {
  const started = await adPlatforms.startSignIn(ctx(`sign-in-${provider}`), { provider }, { ...deps, transport });
  return { started, done: await adPlatforms.finishSignIn(ctx(), { state: stateOf(started.url), code }, { ...deps, transport }) };
};

run("Microsoft Advertising", () => {
  let campaignId = "";
  let row: Awaited<ReturnType<typeof adPlatforms.connectedRow>>;

  it("signs in on Microsoft's consent screen for offline access, and connects", async () => {
    const channels = await acquisition.listChannels(ctx());
    const bing = channels.find((c) => c.sourceKey === "bing_ads")!;
    campaignId = (await acquisition.createCampaign(ctx(), { channelId: bing.id, name: "Bing brand" })).id;
    await leadIntake.connect(ctx(), {
      provider: "bing_ads",
      settings: {
        customerId: "1112223", accountId: "4445556", developerTokenRef: "MS_DEVELOPER_TOKEN", oauthClientRef: "MS_OAUTH_CLIENT",
        authUrl: "https://msoauth.fake/authorize", tokenUrl: "https://msoauth.fake/token", baseUrl: "https://msreport.fake",
      },
    });
    const { started, done } = await signIn("bing_ads", "ms-code");
    const asked = new URL(started.url).searchParams;
    expect(asked.get("scope")).toBe("https://ads.microsoft.com/msads.manage offline_access");
    expect(asked.get("prompt")).toBe("consent");
    expect(done.status).toBe("connected");
    row = await adPlatforms.connectedRow(db(), ORG, "bing_ads");
  });

  it("submits the report, waits for it, downloads the zip and files each day under the campaign it names", async () => {
    await raw`update public.integration_connection set settings = settings || '{"pollMs": 0}'::jsonb where id = ${row.id}`;
    row = await adPlatforms.connectedRow(db(), ORG, "bing_ads");
    ms.report = [
      "﻿TimePeriod,AccountId,CampaignId,CampaignName,Spend,Impressions,Clicks,CurrencyCode",
      `${today()},4445556,77,"Bing brand",12.34,400,9,USD`,
      `${today()},4445556,78,"Bing, generic",0.00,10,0,USD`,
    ].join("\r\n");
    ms.pendingPolls = 2;
    const outcome = await adPlatforms.pullSpend(db(), row, { ...deps, transport });
    expect(outcome).toMatchObject({ provider: "bing_ads", entity: "spend", read: 1, written: 1, error: null });
    expect(ms.polls).toBe(3);
    const spend = await raw<{ amount: string; acquisition_campaign_id: string; origin: string; source: string }[]>`
      select amount, acquisition_campaign_id, origin, source from public.ad_spend where organization_id = ${ORG} and deleted_at is null`;
    expect(spend).toEqual([{ amount: "12.3400", acquisition_campaign_id: campaignId, origin: "bing_ads", source: "bing_ads" }]);

    /** Pulled again with a revised figure: the same row, not a second one. */
    ms.report = ms.report.replace("12.34", "13.00");
    await adPlatforms.pullSpend(db(), row, { ...deps, transport });
    const again = await raw<{ amount: string }[]>`select amount from public.ad_spend where organization_id = ${ORG} and deleted_at is null`;
    expect(again).toEqual([{ amount: "13.0000" }]);
    /** Microsoft rotated the refresh token, and the new one was kept sealed. */
    const [grant] = await raw<{ rotated_at: Date | null }[]>`select rotated_at from public.sealed_credential where connection_id = ${row.id}`;
    expect(grant!.rotated_at).not.toBeNull();
  });

  it("leaves a report still being prepared for the next pull, saying so", async () => {
    ms.pendingPolls = 99;
    const outcome = await adPlatforms.pullSpend(db(), row, { ...deps, transport });
    expect(outcome.error).toContain("still preparing the spend report");
    const [connection] = await raw<{ status: string }[]>`select status from public.integration_connection where id = ${row.id}`;
    expect(connection!.status).toBe("connected");
  });
});

run("Meta's instant forms", () => {
  let campaignId = "";
  const sign = (body: string, secret = "meta-secret-not-real") => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const post = (leadgen: string, page = PAGE) => JSON.stringify({
    object: "page",
    entry: [{ id: page, time: 1759246800, changes: [{ field: "leadgen", value: { leadgen_id: leadgen, page_id: page, form_id: "form-1", created_time: 1759246800 } }] }],
  });

  it("answers Meta's check of the address only with the deployment's own verify token", () => {
    const env = { META_LEADS_VERIFY_TOKEN: "verify-me" };
    expect(metaLeads.challenge({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "1158201444" }, env)).toBe("1158201444");
    expect(metaLeads.challenge({ "hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "1158201444" }, env)).toBeNull();
    expect(metaLeads.challenge({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "1158201444" }, {})).toBeNull();
  });

  it("connects a Page with a Meta sign in", async () => {
    const channels = await acquisition.listChannels(ctx());
    const meta = channels.find((c) => c.sourceKey === "meta_ads")!;
    campaignId = (await acquisition.createCampaign(ctx(), { channelId: meta.id, name: "Furnace instant form" })).id;
    await leadIntake.connect(ctx(), {
      provider: "meta_lead_ads",
      settings: { pageId: PAGE, oauthClientRef: "META_OAUTH_CLIENT", authUrl: "https://facebook.fake/dialog", tokenUrl: "https://graph.fake/token", baseUrl: "https://graph.fake" },
    });
    const { done } = await signIn("meta_lead_ads", "meta-code");
    expect(done.status).toBe("connected");
    const [grant] = await raw<{ scopes: string[] }[]>`
      select g.scopes from public.sealed_credential g join public.integration_connection c on c.id = g.connection_id
       where c.organization_id = ${ORG} and c.provider = 'meta_lead_ads'`;
    expect(grant!.scopes).toContain("leads_retrieval");
  });

  it("opens nothing for a post Meta did not sign, or for a Page nobody here connected", async () => {
    const body = post("9001");
    expect((await metaLeads.receive(db(), { headers: { "x-hub-signature-256": sign(body, "wrong") }, body }, { ...deps, transport })).status).toBe(401);
    expect((await metaLeads.receive(db(), { headers: {}, body }, { ...deps, transport })).status).toBe(401);
    const stranger = post("9001", "1010101010");
    expect((await metaLeads.receive(db(), { headers: { "x-hub-signature-256": sign(stranger) }, body: stranger }, { ...deps, transport })).status).toBe(404);
    expect((await metaLeads.receive(db(), { headers: {}, body: "{}" }, { ...deps, transport })).status).toBe(422);
    const offers = await raw`select 1 from public.lead_offer where organization_id = ${ORG}`;
    expect(offers).toHaveLength(0);
  });

  it("reads a signed post's lead back from Meta into the inbox, credited to the campaign its ad campaign is", async () => {
    const body = post("9001");
    const answer = await metaLeads.receive(db(), { headers: { "x-hub-signature-256": sign(body) }, body }, { ...deps, transport });
    expect(answer).toEqual({ status: 200, body: { received: true, leads: 1 } });
    const [offer] = await raw<{ id: string; contact_name: string; contact_phone: string; postal_code: string; notes: string }[]>`
      select id, contact_name, contact_phone, postal_code, notes from public.lead_offer where organization_id = ${ORG}`;
    expect(offer).toMatchObject({ contact_name: "Lena Ortiz", contact_phone: "+15125550171", postal_code: "78704" });
    expect(offer!.notes).toContain("Furnace instant form");
    const [touch] = await raw<{ source: string; acquisition_campaign_id: string }[]>`
      select source, acquisition_campaign_id from public.marketing_touch where visitor_id = ${`lead_offer:${offer!.id}`}`;
    expect(touch).toEqual({ source: "meta_ads", acquisition_campaign_id: campaignId });
    const [mapped] = await raw<{ mapped_by: string }[]>`
      select mapped_by from public.ad_platform_campaign where organization_id = ${ORG} and external_id = 'c-901'`;
    expect(mapped!.mapped_by).toBe("matched");
  });

  it("finds the same lead again on the ten minute pull, and it is still one lead", async () => {
    const row = await adPlatforms.connectedRow(db(), ORG, "meta_lead_ads");
    const outcome = await adPlatforms.pullLeads(db(), row, { ...deps, transport });
    expect(outcome).toMatchObject({ entity: "leads", read: 1, written: 0, error: null });
    const offers = await raw`select 1 from public.lead_offer where organization_id = ${ORG}`;
    expect(offers).toHaveLength(1);
  });
});
