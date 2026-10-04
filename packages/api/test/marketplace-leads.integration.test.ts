import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as marketplaceLeads from "../src/services/marketplace-leads";
import * as leadConnectors from "../src/services/lead-connectors";
import * as leadIntake from "../src/services/lead-intake";
import * as acquisition from "../src/services/acquisition";
import { signLeadWebhook } from "../src/marketing/index";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { fakePlatform } from "./ads-fakes";

/**
 * ANGI, THUMBTACK AND YELP, AGAINST FAKES OF EACH
 *
 * Each marketplace posts to the lead endpoint its own way and is verified its
 * own way: a post without the password, or about another business, opens
 * nothing. A lead becomes an offer credited to the channel and the tracking
 * campaign chosen, with what the marketplace charged recorded as spend once,
 * however often it is posted. A customer's messages are the lead's thread,
 * kept once each, and a reply goes back through the marketplace, once however
 * often it is pressed, with the marketplace's refusal kept in its words. Yelp
 * posts only an id and the lead is read back from Yelp. The generic signed
 * webhook still answers exactly as it did.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("marketplaces:org");
const USER = fixtureId("marketplaces:user");
const BASE = "https://ots.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});

const store: Record<string, string> = { THUMBTACK_TOKEN: "tt-token-not-real", YELP_TOKEN: "yelp-token-not-real" };
const readSecret = async (ref: string) => {
  const value = store[ref];
  if (!value) throw new Error(`No secret named ${ref}`);
  return value;
};

const fake = fakePlatform();
const deps = { transport: fake.transport, readSecret };
let refuseReply = false;
fake.on("POST", /^https:\/\/thumbtack\.fake\/v2\/business\/biz-77\/lead\/[^/]+\/message$/, (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer tt-token-not-real");
  if (refuseReply) return { status: 400, body: { error: { message: "This lead is closed." } } };
  return { status: 200, body: { messageID: `msg-${fake.calls.length}` } };
});
const yelpLead = {
  id: "yl-1", business_id: "yelp-biz-9", conversation_id: "c-1",
  temporary_email_address: "dana.r.7f3@messaging.yelp.com", time_created: "2026-09-30T15:00:00+00:00",
  user: { display_name: "Dana R." },
  project: {
    survey_answers: [{ question_text: "What needs repair?", answer_text: ["Furnace"] }],
    location: { postal_code: "78704" }, additional_info: "It clicks and will not light.", job_names: ["Furnace repair"],
  },
};
fake.on("GET", /^https:\/\/yelp\.fake\/v3\/leads\/yl-1$/, (call) => {
  expect(call.headers["Authorization"]).toBe("Bearer yelp-token-not-real");
  return { status: 200, body: yelpLead };
});
fake.on("GET", /^https:\/\/yelp\.fake\/v3\/leads\/yl-other$/, () => ({ status: 200, body: { ...yelpLead, id: "yl-other", business_id: "someone-else" } }));
fake.on("GET", /^https:\/\/yelp\.fake\/v3\/leads\/yl-1\/events\?/, () => ({
  status: 200,
  body: { events: [
    { id: "ev-1", event_type: "TEXT", user_type: "CONSUMER", time_created: "2026-09-30T15:00:00+00:00", event_content: { text: "Can somebody come Thursday?" } },
    { id: "ev-0", event_type: "QUOTE_REQUEST", user_type: "CONSUMER", time_created: "2026-09-30T14:59:00+00:00", event_content: {} },
  ] },
}));
fake.on("POST", /^https:\/\/yelp\.fake\/v3\/leads\/yl-1\/events$/, (call) => {
  expect(JSON.parse(call.body)).toEqual({ request_content: "Thursday at 9 works.", request_type: "TEXT" });
  return { status: 200, body: { id: "ev-2" } };
});

const basic = (password: string) => `Basic ${Buffer.from(`thumbtack:${password}`).toString("base64")}`;
const post = (token: string, body: unknown, headers: Record<string, string> = {}) => marketplaceLeads.receiveWebhook(db(), {
  token, url: `${BASE}/api/webhooks/leads/${token}`, method: "POST", headers, query: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
}, deps);
const tokenOf = (path: string) => path.split("/").pop()!;

const thumbtackLead = (leadID: string, price = "18.50") => ({
  leadID, createTimestamp: "1759246800", price,
  business: { businessID: "biz-77", name: "Hartley Heating" },
  customer: { customerID: "c-9", name: "Wren Calloway", phone: "+15125550142" },
  request: {
    requestID: "r-1", category: "Furnace repair", title: "Furnace repair", description: "No heat since Sunday.",
    location: { address1: "12 Pecan St", city: "Austin", state: "TX", zipCode: "78704" },
    details: [{ question: "Type of furnace", answer: "Gas" }],
  },
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Marketplace Co", slug: "marketplace-co" });
});
afterAll(async () => {
  if (raw) await raw.end();
});

run("Thumbtack", () => {
  let path = "";
  let campaignId = "";
  let offerId = "";

  it("is set up with a business id and the names of its secrets, and hands over the password once", async () => {
    const channels = await acquisition.listChannels(ctx());
    const marketplace = channels.find((c) => c.sourceKey === "marketplace")!;
    const campaign = await acquisition.createCampaign(ctx(), { channelId: marketplace.id, name: "Thumbtack pro listing" });
    campaignId = campaign.id;

    await expect(marketplaceLeads.connectMarketplace(ctx(), {
      platform: "thumbtack", businessId: "biz-77", apiTokenRef: "THUMBTACK_TOKEN",
      webhookSecretRef: "abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789",
    })).rejects.toThrow(/looks like the secret itself/);

    const made = await marketplaceLeads.connectMarketplace(ctx("tt-connect"), {
      platform: "thumbtack", businessId: "biz-77", apiTokenRef: "THUMBTACK_TOKEN",
      webhookSecretRef: "THUMBTACK_WEBHOOK_PASSWORD", campaignId,
    });
    expect(made).toMatchObject({ platform: "thumbtack", campaignId, replies: true, needsApproval: true, channelId: marketplace.id });
    expect(made.password).toMatch(/^lhpw_/);
    store["THUMBTACK_WEBHOOK_PASSWORD"] = made.password!;
    path = made.webhookPath;
    await raw`update public.integration_connection set settings = settings || '{"baseUrl": "https://thumbtack.fake"}'::jsonb
      where organization_id = ${ORG} and provider = 'thumbtack'`;

    /** The same request again hands back the same connector and no password. */
    const again = await marketplaceLeads.connectMarketplace(ctx("tt-connect"), {
      platform: "thumbtack", businessId: "biz-77", apiTokenRef: "THUMBTACK_TOKEN", webhookSecretRef: "THUMBTACK_WEBHOOK_PASSWORD", campaignId,
    });
    expect(again).toMatchObject({ id: made.id, password: null });
  });

  it("refuses a post without the password, with the wrong one, or about another business", async () => {
    const token = tokenOf(path);
    expect((await post(token, thumbtackLead("tt-1"))).status).toBe(401);
    expect((await post(token, thumbtackLead("tt-1"), { authorization: basic("guess") })).status).toBe(401);
    const other = { ...thumbtackLead("tt-1"), business: { businessID: "someone-else" } };
    expect((await post(token, other, { authorization: basic(store["THUMBTACK_WEBHOOK_PASSWORD"]!) })).status).toBe(401);
    expect((await post("not-a-token", thumbtackLead("tt-1"), { authorization: basic(store["THUMBTACK_WEBHOOK_PASSWORD"]!) })).status).toBe(404);
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.lead_offer where organization_id = ${ORG}`;
    const n = count!.n;
    expect(n).toBe(0);
  });

  it("takes a lead into the inbox credited to the campaign, with its price as spend once", async () => {
    const auth = { authorization: basic(store["THUMBTACK_WEBHOOK_PASSWORD"]!) };
    const first = await post(tokenOf(path), thumbtackLead("tt-1"), auth);
    expect(first.status).toBe(201);
    offerId = first.body["offerId"] as string;
    const again = await post(tokenOf(path), thumbtackLead("tt-1"), auth);
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, offerId } });

    const [offer] = await raw<{ contact_name: string; contact_phone: string; charge: string; postal_code: string; notes: string }[]>`
      select contact_name, contact_phone, charge, postal_code, notes from public.lead_offer where id = ${offerId}`;
    expect(offer).toMatchObject({ contact_name: "Wren Calloway", contact_phone: "+15125550142", charge: "18.5000", postal_code: "78704" });
    expect(offer!.notes).toContain("Type of furnace: Gas");

    const touches = await raw<{ acquisition_campaign_id: string; source: string }[]>`
      select acquisition_campaign_id, source from public.marketing_touch where visitor_id = ${`lead_offer:${offerId}`}`;
    expect(touches).toEqual([{ acquisition_campaign_id: campaignId, source: "marketplace" }]);
    const spend = await raw<{ amount: string; acquisition_campaign_id: string; origin: string }[]>`
      select amount, acquisition_campaign_id, origin from public.ad_spend where organization_id = ${ORG} and deleted_at is null`;
    expect(spend).toEqual([{ amount: "18.5000", acquisition_campaign_id: campaignId, origin: "lead_charge" }]);
  });

  it("keeps the customer's message once, and sends a reply through Thumbtack once however often it is pressed", async () => {
    const auth = { authorization: basic(store["THUMBTACK_WEBHOOK_PASSWORD"]!) };
    const message = { leadID: "tt-1", businessID: "biz-77", message: { messageID: "m-1", createTimestamp: "1759247000", text: "Is Tuesday possible?" } };
    expect((await post(tokenOf(path), message, auth)).body).toMatchObject({ messages: 1 });
    expect((await post(tokenOf(path), message, auth)).body).toMatchObject({ messages: 0 });

    fake.reset();
    const sent = await marketplaceLeads.sendOfferMessage(ctx("tt-reply-1"), { id: offerId, body: "Tuesday at 10 works." }, deps);
    expect(sent.state).toBe("sent");
    const repeat = await marketplaceLeads.sendOfferMessage(ctx("tt-reply-1"), { id: offerId, body: "Tuesday at 10 works." }, deps);
    expect(repeat).toEqual(sent);
    expect(fake.callsTo(/thumbtack\.fake/).map((c) => JSON.parse(c.body))).toEqual([{ text: "Tuesday at 10 works." }]);

    refuseReply = true;
    const refused = await marketplaceLeads.sendOfferMessage(ctx("tt-reply-2"), { id: offerId, body: "Still there?" }, deps);
    refuseReply = false;
    expect(refused.state).toBe("failed");
    expect(refused.error).toContain("This lead is closed.");

    const detail = await marketplaceLeads.offerDetail(ctx(), { id: offerId });
    expect(detail.messages.map((m) => [m.direction, m.state, m.body])).toEqual([
      ["inbound", "received", "Is Tuesday possible?"],
      ["outbound", "sent", "Tuesday at 10 works."],
      ["outbound", "failed", "Still there?"],
    ]);
    expect(detail).toMatchObject({ canReply: true, charge: "18.5000", campaignName: "Thumbtack pro listing" });
  });

  it("credits the job made by accepting it to the campaign", async () => {
    const accepted = await leadIntake.acceptOffer(ctx(), { id: offerId });
    const [job] = await raw<{ acquisition_campaign_id: string }[]>`select acquisition_campaign_id from public.job where id = ${accepted.jobId}`;
    expect(job!.acquisition_campaign_id).toBe(campaignId);
  });
});

run("Angi", () => {
  let path = "";
  it("takes a lead with its fee, on the marketplace channel, and has no way to reply", async () => {
    const made = await marketplaceLeads.connectMarketplace(ctx(), { platform: "angi", webhookSecretRef: "ANGI_PASSWORD" });
    expect(made).toMatchObject({ replies: false, campaignId: null });
    store["ANGI_PASSWORD"] = made.password!;
    path = made.webhookPath;
    const lead = {
      leadOid: 4410021, srOid: 99, firstName: "Ana", lastName: "Ruiz", primaryPhone: "512-555-0177",
      email: "ana@example.com", address: "4 Elm St", city: "Austin", stateProvince: "TX", postalCode: "78745",
      taskName: "Repair a Water Heater", comments: "Leaking at the base.", fee: "31.00",
      interview: [{ question: "Gas or electric?", answer: "Gas" }],
    };
    expect((await post(tokenOf(path), lead, { authorization: basic("nope") })).status).toBe(401);
    expect((await post(tokenOf(path), lead, { "x-api-key": "nope" })).status).toBe(401);
    /** Angi's own way: the key in a header. */
    expect((await post(tokenOf(path), { ...lead, leadOid: 4410099 }, { "x-api-key": made.password! })).status).toBe(201);
    const answer = await post(tokenOf(path), lead, { authorization: basic(made.password!) });
    expect(answer.status).toBe(201);
    const offerId = answer.body["offerId"] as string;
    const detail = await marketplaceLeads.offerDetail(ctx(), { id: offerId });
    expect(detail).toMatchObject({
      contactName: "Ana Ruiz", contactPhone: "512-555-0177", serviceRequested: "Repair a Water Heater",
      charge: "31.0000", canReply: false, channelName: "A lead marketplace",
    });
    expect(detail.cannotReplyBecause).toContain("Angi");
    await expect(marketplaceLeads.sendOfferMessage(ctx(), { id: offerId, body: "Hello" }, deps)).rejects.toThrow(/Angi/);
  });
});

run("Yelp", () => {
  let token = "";
  it("answers Yelp's check of the address, and nothing else on a GET", async () => {
    const made = await marketplaceLeads.connectMarketplace(ctx(), { platform: "yelp", businessId: "yelp-biz-9", apiTokenRef: "YELP_TOKEN" });
    expect(made.password).toBeNull();
    token = tokenOf(made.webhookPath);
    await raw`update public.integration_connection set settings = settings || '{"baseUrl": "https://yelp.fake"}'::jsonb
      where organization_id = ${ORG} and provider = 'yelp'`;
    const get = (query: Record<string, string>) => marketplaceLeads.receiveWebhook(db(), {
      token, url: `${BASE}/api/webhooks/leads/${token}`, method: "GET", headers: {}, body: "", query,
    }, deps);
    expect(await get({ verification: "abc123" })).toEqual({ status: 200, body: { verification: "abc123" } });
    expect((await get({})).status).toBe(405);
  });

  it("refuses a notice about another business, and reads a notice's lead and messages back from Yelp once", async () => {
    const notice = (business: string, lead: string) => ({
      time: "2026-09-30T15:00:01+00:00", object: "business",
      data: { id: business, updates: [{ event_type: "NEW_EVENT", event_id: "ev-1", lead_id: lead }] },
    });
    expect((await post(token, notice("someone-else", "yl-1"))).status).toBe(401);

    fake.reset();
    const first = await post(token, notice("yelp-biz-9", "yl-1"));
    expect(first).toMatchObject({ status: 201, body: { leads: 1, messages: 1 } });
    const again = await post(token, notice("yelp-biz-9", "yl-1"));
    expect(again).toMatchObject({ status: 200, body: { leads: 0, duplicates: 1, messages: 0 } });
    /** A lead Yelp says belongs to another business is not taken, whatever the notice said. */
    expect((await post(token, notice("yelp-biz-9", "yl-other"))).body).toMatchObject({ leads: 0 });

    const offerId = first.body["offerId"] as string;
    const detail = await marketplaceLeads.offerDetail(ctx(), { id: offerId });
    expect(detail).toMatchObject({
      contactName: "Dana R.", contactEmail: "dana.r.7f3@messaging.yelp.com", postalCode: "78704", serviceRequested: "Furnace repair",
    });
    expect(detail.notes).toContain("What needs repair?: Furnace");
    expect(detail.messages.map((m) => m.body)).toEqual(["Can somebody come Thursday?"]);

    const reply = await marketplaceLeads.sendOfferMessage(ctx("yelp-reply"), { id: offerId, body: "Thursday at 9 works." }, deps);
    expect(reply.state).toBe("sent");
  });
});

run("the generic signed webhook", () => {
  it("still answers 201, 200 for a resend, 401 for a bad signature and 422 for nobody to call", async () => {
    store["GENERIC_SECRET"] = "lhsec_generic_secret_value";
    const made = await leadConnectors.create(ctx(), { source: "our_website", displayName: "Website", fieldMap: {} });
    await raw`update public.integration_connection set credential_ref = 'GENERIC_SECRET'
      where organization_id = ${ORG} and provider = 'lead_webhook:our_website'`;
    const token = tokenOf(made.webhookPath!);
    const target = `${BASE}/api/webhooks/leads/${token}`;
    const send = (body: string, secret = "lhsec_generic_secret_value") => {
      const signed = signLeadWebhook({ secret, url: target, body, timestamp: Date.now() });
      return marketplaceLeads.receiveWebhook(db(), {
        token, url: target, method: "POST", query: {}, body,
        headers: { "x-otos-signature": signed.signature, "x-otos-timestamp": signed.timestamp },
      }, deps);
    };
    const body = JSON.stringify({ id: "w-1", name: "Jo Park", phone: "+15125550190" });
    expect((await send(body)).status).toBe(201);
    expect((await send(body)).status).toBe(200);
    expect((await send(body, "wrong")).status).toBe(401);
    expect((await send(JSON.stringify({ id: "w-2", name: "Nobody" }))).status).toBe(422);
  });
});
