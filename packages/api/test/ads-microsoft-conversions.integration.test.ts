import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as leadIntake from "../src/services/lead-intake";
import * as adPlatforms from "../src/services/ad-platforms";
import * as adConversions from "../src/services/ad-conversions";
import * as marketing from "../src/services/marketing";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as websiteTracking from "../src/services/website-tracking";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";
import { ENV, SECRETS, fakePlatform, formOf, stateOf } from "./ads-fakes";

/**
 * BOOKED JOBS BACK TO MICROSOFT ADVERTISING, AGAINST A FAKE OF MICROSOFT
 *
 * THIS IS TESTED AGAINST A FAKE ONLY. The fake answers the way Microsoft's
 * documentation says the offline conversion upload does (the Campaign
 * Management service's `OfflineConversions/Apply`, a list of conversions each
 * with a goal name, a UTC time, a value and a `MicrosoftClickId`, and
 * `PartialErrors` naming the items it would not take by their `Index`). Nobody
 * has sent a conversion to a real Microsoft Advertising account; the first one
 * is where a difference from the documentation would show.
 *
 * A paid job goes back once, on the click that won it, with its revenue and no
 * customer detail; a customer who said no gets nothing; Microsoft's refusal of
 * one conversion is kept in Microsoft's words and the rest go; and the file
 * for the web importer is written in Microsoft's template.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("ads-ms-conv:org");
const USER = fixtureId("ads-ms-conv:user");
const SLUG = "ads-ms-conv-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});

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

type Conversion = {
  ConversionName: string; ConversionTime: string; ConversionValue?: number; ConversionCurrencyCode?: string;
  MicrosoftClickId: string; HashedEmailAddress?: string; HashedPhoneNumber?: string;
};
const uploads: Conversion[] = [];
const refuseClicks = new Set<string>();
/** Answer with an error that names no item, as Microsoft warns it may. */
let unplacedError = false;

fake.on("POST", /^https:\/\/msoauth\.fake\/token$/, (call) => {
  const form = formOf(call.body);
  return form["grant_type"] === "authorization_code"
    ? { status: 200, body: { access_token: "ms-access-1", expires_in: 3600, refresh_token: "ms-refresh-1", scope: form["scope"] } }
    : { status: 200, body: { access_token: "ms-access-2", expires_in: 3600, refresh_token: "ms-refresh-2" } };
});
fake.on("POST", /^https:\/\/mscampaign\.fake\/OfflineConversions\/Apply$/, (call) => {
  expect(call.headers["Authorization"]).toMatch(/^Bearer ms-access-[12]$/);
  expect(call.headers["DeveloperToken"]).toBe("ms-developer-token-not-real");
  expect(call.headers["CustomerId"]).toBe("1112223");
  expect(call.headers["CustomerAccountId"]).toBe("4445556");
  const sent = (JSON.parse(call.body) as { OfflineConversions: Conversion[] }).OfflineConversions;
  uploads.push(...sent);
  if (unplacedError) {
    return { status: 200, body: { PartialErrors: [{ Code: 2403, ErrorCode: "OfflineConversionGoalNotFound", Message: "No offline conversion goal has that name." }] } };
  }
  const errors = sent
    .map((c, Index) => ({ c, Index }))
    .filter(({ c }) => refuseClicks.has(c.MicrosoftClickId))
    .map(({ Index }) => ({ Index, Code: 2411, ErrorCode: "OfflineConversionTooOld", Message: "The click is older than the goal's conversion window." }));
  return { status: 200, body: { PartialErrors: errors } };
});

/**
 * The fake Microsoft this file stands up has its own address, which a
 * connection may name only where the deployment allows it
 * (docs/self-hosting/secrets.md). Only a test may, and this file says so.
 */
const allowedBefore = process.env["ALLOW_PROVIDER_BASE_URL"];
afterAll(() => {
  if (allowedBefore === undefined) delete process.env["ALLOW_PROVIDER_BASE_URL"];
  else process.env["ALLOW_PROVIDER_BASE_URL"] = allowedBefore;
});

beforeAll(async () => {
  process.env["ALLOW_PROVIDER_BASE_URL"] = "1";
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ads MS Conversions Co", slug: SLUG });
});
afterAll(async () => {
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await raw.end();
});

const connection = () => adPlatforms.connectedRow(db(), ORG, "bing_ads");
const setSetting = (patch: Record<string, unknown>) => raw`
  update public.integration_connection set settings = settings || ${raw.json(patch as never)}
  where organization_id = ${ORG} and provider = 'bing_ads'`;

/** A visitor who clicked a Microsoft ad, became a customer, and booked a job that was invoiced and paid. */
async function aPaidJobFromAClick(input: {
  visitor: string; msclkid: string | null; name: string; email: string; phone: string; amount: string;
}) {
  await websiteTracking.recordVisit(db(), {
    companyKey: SLUG, visitorId: input.visitor,
    query: `${input.msclkid ? `msclkid=${input.msclkid}&` : ""}utm_source=bing&utm_medium=cpc`,
  });
  const customer = await customers.create(ctx(), {
    type: "residential", name: input.name, email: input.email, phone: input.phone,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: `${input.visitor.length} Oak St`, city: "Austin", state: "TX", postalCode: "78745", country: "US" } },
  });
  const customerId = customer.id as string;
  await inTenant(ctx(), (tx) => marketing.identify(tx, ORG, { visitorId: input.visitor, customerId }));
  const [property] = await raw<{ id: string }[]>`
    select property_id as id from public.customer_property where customer_id = ${customerId}`;
  const job = await jobs.create(ctx(), { customerId, propertyId: property!.id, summary: "Furnace repair", tags: [], customFields: {} });
  const jobId = job.id as string;
  const invoice = await billing.create(ctx(), {
    customerId, jobId,
    lines: [{ name: "Repair", quantity: "1", unitPrice: input.amount, discountAmount: "0", taxable: false }],
  });
  await billing.pay({ ...ctx(), idempotencyKey: `ads-ms-pay-${jobId}` }, {
    customerId, method: "card", amount: input.amount, tipAmount: "0",
    allocations: [{ invoiceId: invoice.id as string, amount: input.amount }],
  });
  return { customerId, jobId };
}

run("Microsoft Advertising, set up to be told about work", () => {
  it("connects with the name of the offline conversion goal, and a connection without one says it is not sending", async () => {
    await leadIntake.connect(ctx(), {
      provider: "bing_ads",
      settings: {
        customerId: "1112223", accountId: "4445556", developerTokenRef: "MS_DEVELOPER_TOKEN", oauthClientRef: "MS_OAUTH_CLIENT",
        authUrl: "https://msoauth.fake/authorize", tokenUrl: "https://msoauth.fake/token",
        baseUrl: "https://msreport.fake", campaignUrl: "https://mscampaign.fake",
      },
    });
    const started = await adPlatforms.startSignIn(ctx("ms-conv-sign-in"), { provider: "bing_ads" }, deps);
    const done = await adPlatforms.finishSignIn(ctx(), { state: stateOf(started.url), code: "ms-code" }, deps);
    expect(done.status).toBe("connected");

    const platform = (await adPlatforms.platforms(ctx())).find((p) => p.provider === "bing_ads")!;
    expect(platform.notices.join(" ")).toContain("No offline conversion goal is named, so paid jobs are not being sent to Microsoft Advertising");
    expect(adConversions.notSending(await connection())).toBe("No offline conversion goal is named.");
    await setSetting({ conversionName: "Booked job" });
    expect(adConversions.notSending(await connection())).toBeNull();
  });

  it("does nothing at all while no goal is named", async () => {
    await setSetting({ conversionName: "" });
    await aPaidJobFromAClick({
      visitor: "visitor-ms-0", msclkid: "msclk-unnamed", name: "Una Reyes", email: "una@example.com", phone: "512-555-0100", amount: "75.00",
    });
    uploads.length = 0;
    const outcome = await adConversions.sendConversions(db(), await connection(), deps);
    expect(outcome).toMatchObject({ read: 0, written: 0, error: null });
    expect(uploads).toHaveLength(0);
    await setSetting({ conversionName: "Booked job" });
  });
});

run("paid jobs told back to Microsoft", () => {
  let first = { customerId: "", jobId: "" };

  it("sends a paid job once, on its click, with its revenue and nothing about the customer", async () => {
    first = await aPaidJobFromAClick({
      visitor: "visitor-ms-1", msclkid: "msclk-first", name: "Rosa Delgado",
      email: "rosa.delgado@example.com", phone: "(512) 555-0133", amount: "480.00",
    });
    uploads.length = 0;
    /** The earlier job (no goal was named then) is picked up too; this one is what is asserted. */
    const outcome = await adConversions.sendConversions(db(), await connection(), deps);
    expect(outcome.error).toBeNull();
    const mine = uploads.filter((u) => u.MicrosoftClickId === "msclk-first");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({
      ConversionName: "Booked job",
      ConversionTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      ConversionValue: 480,
      ConversionCurrencyCode: "USD",
      MicrosoftClickId: "msclk-first",
    });
    /** Microsoft's own fields for a hashed email and phone are never used, and no detail is in the body. */
    const body = fake.callsTo(/OfflineConversions\/Apply/).at(-1)!.body;
    expect(body).not.toMatch(/Hashed|rosa|delgado|555/i);

    const sends = await adConversions.listSends(ctx(), { jobId: first.jobId });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      state: "sent", kind: "purchase", provider: "bing_ads", providerLabel: "Microsoft Advertising",
      identifiers: ["click_id"], value: "480.0000",
    });
  });

  it("does not send it again, however often the pass runs, and will not retry a job that went", async () => {
    uploads.length = 0;
    await adConversions.sendConversions(db(), await connection(), deps);
    await adConversions.sendConversions(db(), await connection(), deps);
    expect(uploads.filter((u) => u.MicrosoftClickId === "msclk-first")).toHaveLength(0);
    const [send] = await adConversions.listSends(ctx(), { jobId: first.jobId });
    await expect(adConversions.retrySend(ctx(), { id: send!.id })).rejects.toThrow(/count the job twice/);
  });

  it("does not tell Microsoft again when the job's value changes, because it has no way to take a conversion back", async () => {
    await raw`insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, currency, amount, source_type, source_id, job_id)
              select ${ORG}, t.id, now(), d.direction, d.code, 'USD', '50.0000', 'manual', t.id, ${first.jobId}
              from (select gen_random_uuid() as id) t,
                   (values ('debit'::ledger_direction, '1100'), ('credit'::ledger_direction, '4000')) as d(direction, code)`;
    uploads.length = 0;
    const outcome = await adConversions.restateConversions(db(), await connection(), deps);
    expect(outcome).toMatchObject({ read: 0, written: 0, error: null });
    expect(uploads).toHaveLength(0);
  });

  it("sends nothing at all for a customer who said no, and writes down why", async () => {
    const second = await aPaidJobFromAClick({
      visitor: "visitor-ms-2", msclkid: "msclk-refused-by-customer", name: "Lee Park",
      email: "lee@example.com", phone: "512-555-0155", amount: "99.00",
    });
    await adConversions.setAdChoice(ctx(), { customerId: second.customerId, choice: "refused" });
    uploads.length = 0;
    await adConversions.sendConversions(db(), await connection(), deps);
    expect(uploads.map((u) => u.MicrosoftClickId)).not.toContain("msclk-refused-by-customer");
    const [send] = await adConversions.listSends(ctx(), { jobId: second.jobId });
    expect(send).toMatchObject({ state: "withheld", withheldReason: "customer_refused", identifiers: [] });
  });

  it("withholds a job that came from Microsoft with no click id on it, since the click is the only thing sent", async () => {
    const third = await aPaidJobFromAClick({
      visitor: "visitor-ms-3", msclkid: null, name: "Nia Cole", email: "nia@example.com", phone: "512-555-0166", amount: "60.00",
    });
    await adConversions.sendConversions(db(), await connection(), deps);
    const [send] = await adConversions.listSends(ctx(), { jobId: third.jobId });
    expect(send).toMatchObject({ state: "withheld", withheldReason: "nothing_to_match" });
  });

  it("keeps Microsoft's refusal of one conversion in its words, sends the rest, and sends the refused one on a retry", async () => {
    const stale = await aPaidJobFromAClick({
      visitor: "visitor-ms-4", msclkid: "msclk-stale", name: "Ana Ruiz", email: "ana@example.com", phone: "512-555-0177", amount: "120.00",
    });
    const fine = await aPaidJobFromAClick({
      visitor: "visitor-ms-5", msclkid: "msclk-fine", name: "Ben Ito", email: "ben@example.com", phone: "512-555-0188", amount: "210.00",
    });
    refuseClicks.add("msclk-stale");
    uploads.length = 0;
    await adConversions.sendConversions(db(), await connection(), deps);
    expect(uploads.map((u) => u.MicrosoftClickId).sort()).toEqual(["msclk-fine", "msclk-stale"]);
    const [refused] = await adConversions.listSends(ctx(), { jobId: stale.jobId });
    expect(refused).toMatchObject({ state: "refused" });
    expect(refused!.detail).toBe("OfflineConversionTooOld: The click is older than the goal's conversion window.");
    expect((await adConversions.listSends(ctx(), { jobId: fine.jobId }))[0]!.state).toBe("sent");

    const retried = await adConversions.retrySend(ctx("ms-conv-retry"), { id: refused!.id });
    expect(retried.state).toBe("failed");
    refuseClicks.clear();
    uploads.length = 0;
    await adConversions.sendConversions(db(), await connection(), deps);
    expect(uploads.map((u) => u.MicrosoftClickId)).toEqual(["msclk-stale"]);
    expect((await adConversions.listSends(ctx(), { jobId: stale.jobId }))[0]!.state).toBe("sent");
  });

  it("refuses the whole request in Microsoft's words when an error names no item", async () => {
    const odd = await aPaidJobFromAClick({
      visitor: "visitor-ms-6", msclkid: "msclk-no-goal", name: "Cy Moss", email: "cy@example.com", phone: "512-555-0199", amount: "33.00",
    });
    unplacedError = true;
    try {
      await adConversions.sendConversions(db(), await connection(), deps);
    } finally {
      unplacedError = false;
    }
    const [send] = await adConversions.listSends(ctx(), { jobId: odd.jobId });
    expect(send).toMatchObject({ state: "refused" });
    expect(send!.detail).toContain("OfflineConversionGoalNotFound: No offline conversion goal has that name.");
  });

  it("moves a conversion one second past the click when the job was booked in the same instant", async () => {
    const { adapterFor } = await import("../src/services/ad-platforms");
    const adapter = await adapterFor(db(), await connection(), deps);
    const click = new Date("2026-07-01T16:00:00.000Z");
    uploads.length = 0;
    const outcomes = await adapter.sendEvents!([{
      eventId: "ots_purchase_same-instant", kind: "purchase", at: click, value: "10.00", currency: "USD",
      clickId: "msclk-instant", clickParam: "msclkid", clickSeenAt: click, hashedEmail: null, hashedPhone: null,
      clientId: null, browserId: null, adUserData: "DENIED",
    }]);
    expect(outcomes).toEqual([{ eventId: "ots_purchase_same-instant", ok: true }]);
    expect(uploads[0]!.ConversionTime).toBe("2026-07-01T16:00:01.000Z");
  });

  it("says in Microsoft's template what the web importer takes, leaving out what a connection has already sent", async () => {
    await setSetting({ sendConversions: false });
    const filed = await aPaidJobFromAClick({
      visitor: "visitor-ms-7", msclkid: "msclk-for-the-file", name: "Dee Lund", email: "dee@example.com", phone: "512-555-0123", amount: "310.50",
    });
    try {
      const result = await marketing.conversionHandlers.getConversions(ctx(), {
        from: companyToday(-1), to: companyToday(1), format: "microsoft",
      });
      const lines = result.csv!.split("\n");
      expect(lines[0]).toBe("Microsoft Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency");
      const mine = lines.filter((l) => l.startsWith("msclk-for-the-file,"));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatch(/^msclk-for-the-file,Booked job,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z,310\.50\d*,USD$/);
      /** A job already sent by the connection is not in it, so uploading both cannot count it twice. */
      expect(lines.some((l) => l.startsWith("msclk-first,"))).toBe(false);
      /** A customer who said no is in no file, not even by their click. */
      expect(lines.some((l) => l.startsWith("msclk-refused-by-customer,"))).toBe(false);
      /** Only Microsoft's own clicks are in a Microsoft file. */
      expect(lines.slice(1).every((l) => l.startsWith("msclk-"))).toBe(true);
    } finally {
      await setSetting({ sendConversions: true });
    }
    expect(filed.jobId).toBeTruthy();
  });

  it("returns to JSON rows without a format, and the file is only Microsoft's when asked for", async () => {
    const result = await marketing.conversionHandlers.getConversions(ctx(), { from: companyToday(-1), to: companyToday(1) });
    expect(result.csv).toBeUndefined();
    const google = await marketing.conversionHandlers.getConversions(ctx(), { from: companyToday(-1), to: companyToday(1), format: "google" });
    expect(google.csv!.split("\n").slice(1).some((l) => l.startsWith("msclk-"))).toBe(false);
  });
});
