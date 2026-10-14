import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { campaign as cp, type Actor } from "@opentradesos/core";
import * as campaigns from "../src/services/campaigns";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A CAMPAIGN TEST OF UP TO FOUR VERSIONS, IN CHOSEN SHARES
 *
 * The scope first (another company and a role that may only read cannot touch
 * one), then the writing (versions in order, never two the same, shares that
 * make a hundred), then the send (each person given the version the stable
 * hash and the shares give them, written on their row, in about the shares
 * chosen) and the results (every version side by side with its share, each
 * compared with the first under the wider bar).
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cmpabcd:org");
const USER = fixtureId("cmpabcd:user");
const OTHER = fixtureId("cmpabcd:other");
const OTHER_USER = fixtureId("cmpabcd:other-user");
/** 11am in America/Chicago, outside quiet hours. */
const DAYTIME = "2026-07-01T16:00:00.000Z";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (organizationId: string, userId: string, roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId, organizationId, roles }, db: db(),
});
const owner = () => as(ORG, USER);
const previousBase = process.env["PUBLIC_BASE_URL"];

const PEOPLE = 600;
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  process.env["PUBLIC_BASE_URL"] = "https://versions.test";
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Versions Co", slug: "versions-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_USER, name: "Versions Other", slug: "versions-other" });
  await raw`
    insert into public.customer (organization_id, type, name, email, tags, payment_terms_days)
    select ${ORG}, 'residential', 'Person ' || g, 'v' || g || '@example.test', '["versions"]'::jsonb, 0
    from generate_series(1, ${PEOPLE}) g`;
  await raw`
    insert into public.communication_consent (organization_id, address, channel, purpose, state, method, proof_text)
    select ${ORG}, 'v' || g || '@example.test', 'email'::comm_channel, 'marketing'::comm_purpose,
           'granted'::consent_state, 'web_form', 'Yes, email me offers'
    from generate_series(1, ${PEOPLE}) g`;
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@versions.test","fromName":"Versions Co"}'::jsonb)`;
});

afterAll(async () => {
  if (raw) await raw.end();
  if (previousBase === undefined) delete process.env["PUBLIC_BASE_URL"];
  else process.env["PUBLIC_BASE_URL"] = previousBase;
});

let seq = 0;
const LINK = "https://versions.test/book?{{ campaign.utm }}";
const fourWay = (over: Partial<campaigns.CampaignInput> = {}): campaigns.CampaignInput => ({
  name: `Four ways ${(seq += 1)}`,
  channel: "email",
  subject: "Your spring tune up",
  audience: [{ kind: "tagged_any", tags: ["versions"] }],
  body: `Book your tune up: ${LINK}`,
  variantBBody: `Only $89 this month: ${LINK}`,
  variantCBody: `Beat the summer rush: ${LINK}`,
  variantDBody: `Your system is due a check: ${LINK}`,
  variantShares: [70, 10, 10, 10],
  ...over,
});

async function given(campaignId: string) {
  return raw<{ variant: cp.Variant; customer_id: string; state: string; message_id: string | null }[]>`
    select variant::text as variant, customer_id, state::text as state, message_id
    from public.campaign_recipient where campaign_id = ${campaignId}`;
}

async function click(customerId: string, tag: string, version: string | null) {
  await raw`
    insert into public.marketing_touch (organization_id, customer_id, source, basis, utm_campaign, utm_content, occurred_at)
    values (${ORG}, ${customerId}, 'email', 'utm'::touch_basis, ${tag}, ${version}, now())`;
}

run("a test of several versions: scope", () => {
  it("is never readable or sendable by another company, and a reader cannot write one", async () => {
    const created = await campaigns.create(owner(), fourWay());
    await expect(campaigns.results(as(OTHER, OTHER_USER), { id: created.id })).rejects.toThrow(/not found/i);
    await expect(campaigns.send(as(OTHER, OTHER_USER), { id: created.id, at: DAYTIME })).rejects.toThrow(/not found/i);
    await expect(campaigns.update(as(OTHER, OTHER_USER), { id: created.id, variantShares: [40, 20, 20, 20] }))
      .rejects.toThrow(/not found/i);
    await expect(campaigns.create(as(ORG, USER, ["office_manager"]), fourWay())).rejects.toThrow(/campaign:write/);
    expect(await given(created.id)).toHaveLength(0);
  });
});

run("writing a test of several versions", () => {
  it("keeps up to four versions with their shares, and says the split in words", async () => {
    const created = await campaigns.create(owner(), fourWay());
    expect(created).toMatchObject({
      abTest: true, versions: 4, variantShares: [70, 10, 10, 10],
      splitInWords: "70% get version A, 10% get version B, 10% get version C and 10% get version D.",
    });
    const even = await campaigns.create(owner(), fourWay({ variantDBody: undefined, variantShares: undefined }));
    expect(even).toMatchObject({ versions: 3, variantShares: null, variantDBody: null });
    const same = await campaigns.create(owner(), fourWay({ variantShares: [25, 25, 25, 25] }));
    expect(same.variantShares).toBeNull();
  });

  it("refuses a version with a gap before it, or the same words as another version", async () => {
    await expect(campaigns.create(owner(), fourWay({ variantBBody: undefined, variantShares: undefined })))
      .rejects.toThrow(/Version C needs the version before it/);
    await expect(campaigns.create(owner(), fourWay({ variantCBody: undefined, variantShares: undefined })))
      .rejects.toThrow(/Version D needs the version before it/);
    await expect(campaigns.create(owner(), fourWay({ variantDBody: `Only $89 this month: ${LINK}` })))
      .rejects.toThrow(/Version D says the same thing as version B/);
    await expect(campaigns.create(owner(), fourWay({ variantCBody: "Hi {{ custmer.firstName }}" })))
      .rejects.toThrow(/Version C: .*not something a campaign can fill in/);
  });

  it("refuses shares that do not make a hundred, leave a version too little, or do not match the versions", async () => {
    await expect(campaigns.create(owner(), fourWay({ variantShares: [70, 10, 10, 5] }))).rejects.toThrow(/add up to 95%/);
    await expect(campaigns.create(owner(), fourWay({ variantShares: [85, 10, 3, 2] }))).rejects.toThrow(/at least 5%/);
    await expect(campaigns.create(owner(), fourWay({ variantShares: [90, 10] }))).rejects.toThrow(/4 versions, so give 4 shares/);
  });

  it("takes later versions off with an earlier one, and refuses kept shares that no longer fit", async () => {
    const created = await campaigns.create(owner(), fourWay({ variantShares: undefined }));
    const two = await campaigns.update(owner(), { id: created.id, variantCBody: null });
    expect(two).toMatchObject({ versions: 2, variantCBody: null, variantDBody: null });
    const shared = await campaigns.update(owner(), { id: created.id, variantShares: [90, 10] });
    expect(shared.variantShares).toEqual([90, 10]);
    await expect(campaigns.update(owner(), { id: created.id, variantCBody: `Beat the summer rush: ${LINK}` }))
      .rejects.toThrow(/3 versions, so give 3 shares/);
    const three = await campaigns.update(owner(), {
      id: created.id, variantCBody: `Beat the summer rush: ${LINK}`, variantShares: [80, 10, 10],
    });
    expect(three).toMatchObject({ versions: 3, variantShares: [80, 10, 10] });
    const off = await campaigns.update(owner(), { id: created.id, variantBBody: null, variantShares: null });
    expect(off).toMatchObject({ abTest: false, versions: 1, variantCBody: null });
  });
});

run("sending and reading a test of several versions", () => {
  let campaignId = "";
  let tag = "";

  it("shows every version as the first person would read it before anything is sent", async () => {
    const draft = await campaigns.create(owner(), fourWay());
    campaignId = draft.id;
    tag = draft.utmCampaign;
    const preview = await campaigns.preview(owner(), { id: draft.id });
    expect(preview.renderedVersions.map((v) => v.version)).toEqual(["b", "c", "d"]);
    expect(preview.renderedVersions[1]!.body).toContain(`utm_content=c`);
    expect(preview.renderedVersions[1]!.body).toContain("Beat the summer rush");
    expect(preview.renderedB!.body).toBe(preview.renderedVersions[0]!.body);
  });

  it("gives each person the version the hash and the shares give them, in about the shares chosen", async () => {
    const report = await campaigns.send(owner(), { id: campaignId, at: DAYTIME });
    expect(report.queued).toBe(PEOPLE);
    const rows = await given(campaignId);
    expect(rows).toHaveLength(PEOPLE);
    for (const row of rows) {
      expect(row.variant).toBe(cp.variantFor(campaignId, row.customer_id, { versions: 4, shares: [70, 10, 10, 10] }));
    }
    const share = (v: cp.Variant) => rows.filter((r) => r.variant === v).length / PEOPLE;
    expect(share("a")).toBeGreaterThan(0.6);
    expect(share("a")).toBeLessThan(0.8);
    for (const v of ["b", "c", "d"] as const) {
      expect(share(v)).toBeGreaterThan(0.04);
      expect(share(v)).toBeLessThan(0.17);
    }
    const words: Record<cp.Variant, string> = {
      a: "Book your tune up", b: "Only $89", c: "Beat the summer rush", d: "Your system is due a check",
    };
    for (const v of ["a", "b", "c", "d"] as const) {
      const one = rows.find((r) => r.variant === v)!;
      const [message] = await raw<{ body: string; subject: string }[]>`select body, subject from public.message where id = ${one.message_id!}`;
      expect(message!.body).toContain(words[v]);
      expect(message!.body).toContain(`utm_campaign=${tag}&utm_content=${v}`);
      expect(message!.subject).toBe("Your spring tune up");
    }
    const listed = await campaigns.recipients(owner(), { id: campaignId, limit: 500 });
    expect(new Set(listed.data.map((r) => r.variant))).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("reads every version side by side with its share, and compares each with the first under the wider bar", async () => {
    const rows = (await given(campaignId)).filter((r) => r.state === "queued");
    const of = (v: cp.Variant) => rows.filter((r) => r.variant === v);
    /** One in ten of A, B and D clicked; half of C did. */
    for (const v of ["a", "b", "d"] as const) {
      for (const row of of(v).slice(0, Math.round(of(v).length * 0.1))) await click(row.customer_id, tag, v);
    }
    for (const row of of("c").slice(0, Math.round(of("c").length * 0.5))) await click(row.customer_id, tag, "c");
    /** A version this campaign does not have is in no column. */
    await click(of("a")[of("a").length - 1]!.customer_id, tag, "e");

    const test = (await campaigns.results(owner(), { id: campaignId })).abTest!;
    expect(test.versions.map((v) => [v.version, v.share, v.sent])).toEqual(
      (["a", "b", "c", "d"] as const).map((v, i) => [v, [70, 10, 10, 10][i], of(v).length]),
    );
    expect(test.versions.find((v) => v.version === "c")!.clicks).toBe(Math.round(of("c").length * 0.5));
    expect(test.untaggedClicks).toBe(1);
    expect(test.measures.map((m) => `${m.against}:${m.measure}`)).toEqual([
      "b:clicks", "b:booked", "c:clicks", "c:booked", "d:clicks", "d:booked",
    ]);
    const c = test.measures.find((m) => m.against === "c" && m.measure === "clicks")!;
    expect(c.verdict).toBe("b_higher");
    expect(c.sentence).toContain("Version C did better");
    expect(test.winner).toBe("c");
    expect(test.headline).toContain("Version C did better than version A on people who clicked the link");
    expect(test.headline).toContain("compared only with version A");
  });
});
