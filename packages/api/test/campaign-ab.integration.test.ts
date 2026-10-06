import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { campaign as cp, type Actor } from "@opentradesos/core";
import * as campaigns from "../src/services/campaigns";
import * as marketing from "../src/services/marketing";
import * as jobs from "../src/services/jobs";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A/B TESTS FOR A CAMPAIGN
 *
 * Two versions of the words, the audience split by a stable hash of the
 * campaign and the customer, and the counts read side by side with no winner
 * claimed unless a two proportion test says the gap is more than luck. Every
 * step goes through the services the product uses; the only raw SQL is the
 * fixtures (a customer list, their consent) and the clicks, which in life
 * arrive from the website snippet.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cmpab:org");
const USER = fixtureId("cmpab:user");
/** 11am in America/Chicago, outside quiet hours. */
const DAYTIME = "2026-07-01T16:00:00.000Z";
const BASE = "https://comfortco.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const previousBase = process.env["PUBLIC_BASE_URL"];

const PEOPLE = 400;
/**
 * A send to four hundred people is a few seconds on its own and a good deal more
 * on a machine running a whole suite, which the default five seconds is not.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  process.env["PUBLIC_BASE_URL"] = BASE;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Comfort Co", slug: "comfort-co-ab" });
  /** A list of four hundred people who agreed to email, a sending connection, and a main number for texts. */
  await raw`
    insert into public.customer (organization_id, type, name, email, phone, tags, payment_terms_days)
    select ${ORG}, 'residential', 'Person ' || g, 'ab' || g || '@example.test',
           '+1512555' || lpad(g::text, 4, '0'), '["abtest"]'::jsonb, 0
    from generate_series(1, ${PEOPLE}) g`;
  await raw`
    insert into public.communication_consent (organization_id, address, channel, purpose, state, method, proof_text)
    select ${ORG}, 'ab' || g || '@example.test', 'email'::comm_channel, 'marketing'::comm_purpose,
           'granted'::consent_state, 'web_form', 'Yes, email me offers'
    from generate_series(1, ${PEOPLE}) g`;
  await raw`
    insert into public.communication_consent (organization_id, address, channel, purpose, state, method, proof_text)
    select ${ORG}, '+1512555' || lpad(g::text, 4, '0'), 'sms'::comm_channel, 'marketing'::comm_purpose,
           'granted'::consent_state, 'web_form', 'Yes, text me offers'
    from generate_series(1, 30) g`;
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@comfortco.test","fromName":"Comfort Co"}'::jsonb)`;
  await raw`
    insert into public.phone_number (organization_id, e164, purpose, sms_registered, capabilities)
    values (${ORG}, '+15125559999', 'main'::phone_number_purpose, true, '{"sms":true}'::jsonb)`;
});

afterAll(async () => {
  if (raw) await raw.end();
  if (previousBase === undefined) delete process.env["PUBLIC_BASE_URL"];
  else process.env["PUBLIC_BASE_URL"] = previousBase;
});

let seq = 0;
const emailTest = (over: Partial<campaigns.CampaignInput> = {}): campaigns.CampaignInput => ({
  name: `Spring offer ${(seq += 1)}`,
  channel: "email",
  subject: "Your spring tune up",
  audience: [{ kind: "tagged_any", tags: ["abtest"] }],
  body: "Book your tune up: https://comfortco.test/book?{{ campaign.utm }}",
  variantBBody: "Only $89 this month. Book: https://comfortco.test/book?{{ campaign.utm }}",
  ...over,
});

/** Who got which half, from the recipient rows, and the customer each row is. */
async function halves(campaignId: string) {
  const rows = await raw<{ variant: "a" | "b"; customer_id: string; state: string; message_id: string | null }[]>`
    select variant::text as variant, customer_id, state::text as state, message_id
    from public.campaign_recipient where campaign_id = ${campaignId}`;
  return {
    rows,
    queued: (variant: "a" | "b") => rows.filter((r) => r.variant === variant && r.state === "queued"),
  };
}

/** Clicks as the website snippet records them: a touch on the campaign's tag with the version in utm_content. */
async function click(customerId: string, tag: string, version: "a" | "b" | null) {
  await raw`
    insert into public.marketing_touch (organization_id, customer_id, source, basis, utm_campaign, utm_content, occurred_at)
    values (${ORG}, ${customerId}, 'email', 'utm'::touch_basis, ${tag}, ${version}, now())`;
}

run("writing a campaign with two versions", () => {
  it("keeps version B beside version A, and says it is a test", async () => {
    const created = await campaigns.create(owner(), emailTest());
    expect(created.abTest).toBe(true);
    expect(created.variantBBody).toContain("Only $89");
    expect(created.variantBSubject).toBeNull();
    const plain = await campaigns.create(owner(), emailTest({ variantBBody: undefined }));
    expect(plain.abTest).toBe(false);
    expect(plain.variantBBody).toBeNull();
  });

  it("refuses a version B that says what version A says", async () => {
    await expect(campaigns.create(owner(), emailTest({ variantBBody: emailTest().body! })))
      .rejects.toThrow(/nothing to test/);
  });

  it("checks version B as it checks A: merge fields, a subject on a text, a subject for a version B with a body of its own", async () => {
    await expect(campaigns.create(owner(), emailTest({ variantBBody: "Hi {{ custmer.firstName }}" })))
      .rejects.toThrow(/Version B: .*not something a campaign can fill in/);
    await expect(campaigns.create(owner(), emailTest({
      channel: "sms", subject: null, body: "Offer. Reply STOP to opt out.",
      variantBBody: "Other offer. Reply STOP to opt out.", variantBSubject: "A subject on a text",
    }))).rejects.toThrow(/Version B: A text has no subject/);
    await expect(campaigns.create(owner(), emailTest({ variantBBody: undefined, variantBSubject: "Only a subject" })))
      .rejects.toThrow(ConflictError);
  });

  it("lets version B change only the subject of an email by changing the body too, and otherwise sends under version A's subject", async () => {
    const created = await campaigns.create(owner(), emailTest());
    const sent = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(sent.queued).toBeGreaterThan(0);
    const { rows } = await halves(created.id);
    const bOne = rows.find((r) => r.variant === "b" && r.message_id)!;
    const [message] = await raw<{ subject: string; body: string }[]>`
      select subject, body from public.message where id = ${bOne.message_id!}`;
    expect(message!.subject).toBe("Your spring tune up");
    expect(message!.body).toContain("Only $89");
  });

  it("can take the test off a draft, and puts the two versions through the same check when either is edited", async () => {
    const created = await campaigns.create(owner(), emailTest());
    await expect(campaigns.update(owner(), { id: created.id, body: created.variantBBody! }))
      .rejects.toThrow(/nothing to test/);
    const off = await campaigns.update(owner(), { id: created.id, variantBBody: null });
    expect(off.abTest).toBe(false);
    const on = await campaigns.update(owner(), { id: created.id, variantBBody: "Version B words" });
    expect(on.abTest).toBe(true);
    expect(on.variantBBody).toBe("Version B words");
  });

  it("cannot be changed once it has gone", async () => {
    const created = await campaigns.create(owner(), emailTest());
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    await expect(campaigns.update(owner(), { id: created.id, variantBBody: "Too late" }))
      .rejects.toThrow(/already gone out|sent/);
  });
});

run("splitting the audience", () => {
  let campaignId = "";
  let tag = "";

  it("puts every person in the half the stable hash gives them, and each half gets its own words", async () => {
    const created = await campaigns.create(owner(), emailTest());
    campaignId = created.id;
    tag = created.utmCampaign;
    const report = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(report.queued).toBe(PEOPLE);

    const { rows } = await halves(campaignId);
    expect(rows).toHaveLength(PEOPLE);
    for (const row of rows) {
      expect(row.variant, row.customer_id).toBe(cp.variantFor(campaignId, row.customer_id));
    }
    /** A random half, so close to even and never the whole list. */
    const inA = rows.filter((r) => r.variant === "a").length;
    expect(inA).toBeGreaterThan(PEOPLE * 0.4);
    expect(inA).toBeLessThan(PEOPLE * 0.6);

    for (const variant of ["a", "b"] as const) {
      const one = rows.find((r) => r.variant === variant)!;
      const [message] = await raw<{ body: string }[]>`select body from public.message where id = ${one.message_id!}`;
      expect(message!.body).toContain(`utm_campaign=${tag}&utm_content=${variant}`);
      expect(message!.body).toContain(variant === "a" ? "Book your tune up" : "Only $89");
    }
  });

  it("does not move anybody when the same people are selected again", async () => {
    const again = await campaigns.send(owner(), { id: campaignId, at: DAYTIME }).catch((e) => e as Error);
    /** A sent campaign refuses a second send; the halves on its rows are what was written, once. */
    expect(again).toBeInstanceOf(Error);
    const { rows } = await halves(campaignId);
    expect(rows).toHaveLength(PEOPLE);
    const listed = await campaigns.recipients(owner(), { id: campaignId, limit: 500 });
    expect(listed.data.every((r) => r.variant === cp.variantFor(campaignId, r.customerId))).toBe(true);
  });

  it("splits the same list differently for a different campaign", async () => {
    const other = await campaigns.create(owner(), emailTest());
    await campaigns.send(owner(), { id: other.id, at: DAYTIME });
    const first = await halves(campaignId);
    const second = await halves(other.id);
    const variantOf = new Map(first.rows.map((r) => [r.customer_id, r.variant]));
    const same = second.rows.filter((r) => variantOf.get(r.customer_id) === r.variant).length;
    expect(same).toBeGreaterThan(PEOPLE * 0.4);
    expect(same).toBeLessThan(PEOPLE * 0.6);
  });

  it("gives a campaign with no test version A for everybody", async () => {
    const plain = await campaigns.create(owner(), emailTest({ variantBBody: undefined }));
    await campaigns.send(owner(), { id: plain.id, at: DAYTIME });
    const { rows } = await halves(plain.id);
    expect(rows.every((r) => r.variant === "a")).toBe(true);
    const results = await campaigns.results(owner(), { id: plain.id });
    expect(results.abTest).toBeNull();
  });

  it("shows the counts side by side, and names a winner when the gap is far more than luck", async () => {
    const { queued } = await halves(campaignId);
    const a = queued("a");
    const b = queued("b");
    /** One in five of A and two in five of B followed the link, each with the version on it. */
    for (const row of a.slice(0, Math.round(a.length * 0.2))) await click(row.customer_id, tag, "a");
    for (const row of b.slice(0, Math.round(b.length * 0.4))) await click(row.customer_id, tag, "b");
    /** A link typed by hand, with no version on it: counted apart, in neither column. */
    await click(a[a.length - 1]!.customer_id, tag, null);

    const results = await campaigns.results(owner(), { id: campaignId });
    const test = results.abTest!;
    const [va, vb] = test.versions;
    expect(va).toMatchObject({ version: "a", sent: a.length, clicks: Math.round(a.length * 0.2), booked: 0 });
    expect(vb).toMatchObject({ version: "b", sent: b.length, clicks: Math.round(b.length * 0.4), booked: 0 });
    expect(test.untaggedClicks).toBe(1);
    /** Replies in an email are not read back without a reply domain, so they are not counted as nobody. */
    expect(test.repliesKnown).toBe(false);
    expect(va!.replies).toBeNull();
    expect(test.measures.map((m) => m.measure)).toEqual(["clicks", "booked"]);

    const clicks = test.measures.find((m) => m.measure === "clicks")!;
    expect(clicks.verdict).toBe("b_higher");
    expect(clicks.sentence).toContain("Version B did better");
    expect(test.winner).toBe("b");
    expect(test.headline).toContain("Version B did better on people who clicked the link");
    /** Nobody booked: too few to say anything, and it says so rather than "no difference". */
    expect(test.measures.find((m) => m.measure === "booked")!.verdict).toBe("too_few");
  });

  it("names no winner when the halves did almost the same", async () => {
    const created = await campaigns.create(owner(), emailTest());
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    const { queued } = await halves(created.id);
    const a = queued("a");
    const b = queued("b");
    /** 40 of A and 3 more of B, which luck explains. */
    const forA = 40;
    for (const row of a.slice(0, forA)) await click(row.customer_id, created.utmCampaign, "a");
    for (const row of b.slice(0, forA + 3)) await click(row.customer_id, created.utmCampaign, "b");

    const test = (await campaigns.results(owner(), { id: created.id })).abTest!;
    const clicks = test.measures.find((m) => m.measure === "clicks")!;
    expect(clicks.verdict).toBe("no_clear_difference");
    expect(clicks.sentence).toContain("neither is shown to be better");
    expect(test.winner).toBeNull();
    expect(test.headline).toContain("No clear winner");
    /** The counts are all still there to read. */
    expect(test.versions.map((v) => v.clicks)).toEqual([forA, forA + 3]);
  });

  it("counts who booked by the version they were sent, through the job the click credited", async () => {
    const created = await campaigns.create(owner(), emailTest());
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    const { queued } = await halves(created.id);
    const person = queued("b")[0]!;
    /** The click arrives as it does from the snippet, and the job is booked the ordinary way. */
    await inTenant(owner(), (tx) => marketing.recordTouch(tx, ORG, {
      customerId: person.customer_id,
      query: `utm_source=newsletter&utm_medium=email&utm_campaign=${created.utmCampaign}&utm_content=b`,
    }));
    const [property] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '1 Main', 'Austin', 'TX', '78702') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id)
              values (${ORG}, ${person.customer_id}, ${property!.id})`;
    await jobs.create(owner(), {
      customerId: person.customer_id, propertyId: property!.id, summary: "Tune up from the email",
      tags: [], customFields: {},
    });

    const test = (await campaigns.results(owner(), { id: created.id })).abTest!;
    expect(test.versions.map((v) => [v.version, v.booked, v.jobs, v.clicks])).toEqual([["a", 0, 0, 0], ["b", 1, 1, 1]]);
    expect(test.versions[1]!.revenue).toBe("0.0000");
  });

  it("shows both versions as the first person would read them before anything is sent", async () => {
    const draft = await campaigns.create(owner(), emailTest());
    const preview = await campaigns.preview(owner(), { id: draft.id });
    expect(preview.rendered!.body).toContain(`utm_campaign=${draft.utmCampaign}&utm_content=a`);
    expect(preview.renderedB!.body).toContain(`utm_content=b`);
    expect(preview.renderedB!.subject).toBe("Your spring tune up");
    const plain = await campaigns.create(owner(), emailTest({ variantBBody: undefined }));
    expect((await campaigns.preview(owner(), { id: plain.id })).renderedB).toBeNull();
  });
});

run("replies to a text test", () => {
  it("counts replies by version where they are read back, and leaves them in the test", async () => {
    const created = await campaigns.create(owner(), {
      name: "Text offer", channel: "sms",
      audience: [{ kind: "tagged_any", tags: ["abtest"] }],
      body: "Comfort Co: $89 tune ups. Reply STOP to opt out.",
      variantBBody: "Comfort Co: tune up special, $79. Reply STOP to opt out.",
    });
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    const { rows } = await halves(created.id);
    const sent = rows.filter((r) => r.state === "queued");
    expect(sent.length).toBe(30);
    const replied = sent.filter((r) => r.variant === "b").slice(0, 2);
    for (const row of replied) {
      const [sentMessage] = await raw<{ conversation_id: string; to_address: string; from_address: string }[]>`
        select conversation_id, to_address, from_address from public.message where id = ${row.message_id!}`;
      await raw`
        insert into public.message (organization_id, conversation_id, direction, channel, from_address, to_address, body, status)
        values (${ORG}, ${sentMessage!.conversation_id}, 'inbound', 'sms', ${sentMessage!.to_address},
                ${sentMessage!.from_address}, 'Yes please, Tuesday?', 'received')`;
    }
    const test = (await campaigns.results(owner(), { id: created.id })).abTest!;
    expect(test.repliesKnown).toBe(true);
    expect(test.versions.map((v) => v.replies)).toEqual([0, replied.length]);
    expect(test.measures.map((m) => m.measure)).toEqual(["clicks", "replies", "booked"]);
    /** Two replies in thirty is too few to call, and it says that rather than naming a leader. */
    expect(test.winner).toBeNull();
    expect(test.measures.find((m) => m.measure === "replies")!.verdict).toBe("too_few");
  });
});
