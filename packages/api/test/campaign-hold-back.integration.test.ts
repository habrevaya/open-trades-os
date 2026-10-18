import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { campaign as cp, type Actor } from "@opentradesos/core";
import * as campaigns from "../src/services/campaigns";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * HOLDING PART OF THE LIST BACK, AND SENDING IT THE WINNER
 *
 * A test can keep a share of its audience back. Those people are written as
 * held when the test goes and are sent nothing; once the test is judged, a
 * person sends them the winner, or version A when nothing won, from the
 * campaign page. Never the clock. Consent, unsubscribes and quiet hours are
 * checked again when they are sent, and the held back part is never counted in
 * the test that chose what they got. Every step goes through the services; the
 * only raw SQL is the fixtures and the clicks, which in life arrive from the
 * website snippet.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cmphold:org");
const USER = fixtureId("cmphold:user");
/** 11am in America/Chicago, outside quiet hours. */
const DAYTIME = "2026-07-01T16:00:00.000Z";
/** 3am the next morning in the same zone, inside the default quiet hours. */
const NIGHT = "2026-07-02T08:00:00.000Z";
const BASE = "https://holdco.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const reader = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["office_manager"] as Actor["roles"] }, db: db(),
});
const previousBase = process.env["PUBLIC_BASE_URL"];

const PEOPLE = 400;
const TEXTERS = 40;
/** A carrier's daily cap on texts, small enough that each part of the list takes days. */
const CAP = 5;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  process.env["PUBLIC_BASE_URL"] = BASE;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Hold Co", slug: "hold-co-rest" });
  /** Four hundred people who agreed to email, and forty more who agreed to texts. */
  await raw`
    insert into public.customer (organization_id, type, name, email, tags, payment_terms_days)
    select ${ORG}, 'residential', 'Person ' || lpad(g::text, 3, '0'), 'hold' || g || '@example.test', '["holdtest"]'::jsonb, 0
    from generate_series(1, ${PEOPLE}) g`;
  await raw`
    insert into public.communication_consent (organization_id, address, channel, purpose, state, method, proof_text)
    select ${ORG}, 'hold' || g || '@example.test', 'email'::comm_channel, 'marketing'::comm_purpose,
           'granted'::consent_state, 'web_form', 'Yes, email me offers'
    from generate_series(1, ${PEOPLE}) g`;
  await raw`
    insert into public.customer (organization_id, type, name, phone, tags, payment_terms_days)
    select ${ORG}, 'residential', 'Texter ' || lpad(g::text, 3, '0'), '+1512666' || lpad(g::text, 4, '0'), '["holdtext"]'::jsonb, 0
    from generate_series(1, ${TEXTERS}) g`;
  await raw`
    insert into public.communication_consent (organization_id, address, channel, purpose, state, method, proof_text)
    select ${ORG}, '+1512666' || lpad(g::text, 4, '0'), 'sms'::comm_channel, 'marketing'::comm_purpose,
           'granted'::consent_state, 'web_form', 'Yes, text me offers'
    from generate_series(1, ${TEXTERS}) g`;
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@holdco.test","fromName":"Hold Co"}'::jsonb)`;
  await raw`
    insert into public.phone_number (organization_id, e164, purpose, sms_registered, capabilities)
    values (${ORG}, '+15125558888', 'main'::phone_number_purpose, true, '{"sms":true}'::jsonb)`;
});

afterAll(async () => {
  if (raw) await raw.end();
  if (previousBase === undefined) delete process.env["PUBLIC_BASE_URL"];
  else process.env["PUBLIC_BASE_URL"] = previousBase;
});

let seq = 0;
const emailTest = (over: Partial<campaigns.CampaignInput> = {}): campaigns.CampaignInput => ({
  name: `Held offer ${(seq += 1)}`,
  channel: "email",
  subject: "Your spring tune up",
  audience: [{ kind: "tagged_any", tags: ["holdtest"] }],
  body: "Book your tune up: https://holdco.test/book?{{ campaign.utm }}",
  variantBBody: "Only $89 this month. Book: https://holdco.test/book?{{ campaign.utm }}",
  holdBackShare: 60,
  ...over,
});

async function rows(campaignId: string) {
  return raw<{ id: string; variant: string; customer_id: string; state: string; held_back: boolean; message_id: string | null; address: string; skip_reason: string | null }[]>`
    select id, variant::text as variant, customer_id, state::text as state, held_back, message_id, address, skip_reason
    from public.campaign_recipient where campaign_id = ${campaignId}`;
}

async function click(customerId: string, tag: string, content: string | null) {
  await raw`
    insert into public.marketing_touch (organization_id, customer_id, source, basis, utm_campaign, utm_content, occurred_at)
    values (${ORG}, ${customerId}, 'email', 'utm'::touch_basis, ${tag}, ${content}, now())`;
}

run("setting a hold back", () => {
  it("is off unless the office sets it, and is said in words", async () => {
    const plain = await campaigns.create(owner(), emailTest({ holdBackShare: undefined }));
    expect(plain.holdBackShare).toBeNull();
    expect(plain.holdBackInWords).toBeNull();
    const held = await campaigns.create(owner(), emailTest());
    expect(held.holdBackShare).toBe(60);
    expect(held.holdBackInWords).toContain("60% of the list is held back");
    expect(held.holdBackInWords).toContain("Nothing goes to them by itself");
  });

  it("is refused with no test, out of bounds, and when the test is taken off with it still set", async () => {
    await expect(campaigns.create(owner(), emailTest({ variantBBody: undefined })))
      .rejects.toThrow(/Write a second version first/);
    await expect(campaigns.create(owner(), emailTest({ holdBackShare: 99 })))
      .rejects.toThrow(/between 5% and 95%/);
    const draft = await campaigns.create(owner(), emailTest());
    await expect(campaigns.update(owner(), { id: draft.id, variantBBody: null }))
      .rejects.toThrow(/Write a second version first/);
    const off = await campaigns.update(owner(), { id: draft.id, variantBBody: null, holdBackShare: null });
    expect(off.abTest).toBe(false);
    expect(off.holdBackShare).toBeNull();
  });
});

run("a test with part of the list held back", () => {
  let id = "";
  let tag = "";

  it("sends the test to the rest and writes the held back part as held, sent nothing", async () => {
    const created = await campaigns.create(owner(), emailTest());
    id = created.id;
    tag = created.utmCampaign;
    const report = await campaigns.send(owner(), { id, at: DAYTIME });
    expect(report.state).toBe("sent");
    expect(report.remaining).toBe(0);
    const all = await rows(id);
    expect(all).toHaveLength(PEOPLE);
    const held = all.filter((r) => r.held_back);
    expect(report.held).toBe(held.length);
    expect(report.queued).toBe(PEOPLE - held.length);
    /** About sixty in a hundred, by the hash, and the same people the hash names. */
    expect(held.length).toBeGreaterThan(PEOPLE * 0.5);
    expect(held.length).toBeLessThan(PEOPLE * 0.7);
    for (const r of all) expect(r.held_back, r.customer_id).toBe(cp.heldBackFor(id, r.customer_id, 60));
    expect(held.every((r) => r.state === "held" && r.message_id === null)).toBe(true);

    const view = await campaigns.get(owner(), { id });
    expect(view.result.held).toBe(held.length);
    const results = await campaigns.results(owner(), { id });
    /** Out of the people a send was tried on, not out of everybody selected. */
    expect(results.reachRate).toBe("100.0");
    /** The test counts only the people tested. */
    const test = results.abTest!;
    expect(test.versions.reduce((n, v) => n + v.sent, 0)).toBe(PEOPLE - held.length);
    expect(test.rest).toMatchObject({ share: 60, waiting: held.length, sent: 0, version: null });
  });

  it("offers version A when nothing won, and refuses to send anything else", async () => {
    const results = await campaigns.results(reader(), { id });
    expect(results.abTest!.winner).toBeNull();
    expect(results.abTest!.rest!.offer).toMatchObject({ version: "a", won: false });
    expect(results.abTest!.rest!.offer!.sentence).toContain("No version won");
    await expect(campaigns.sendRest(owner(), { id, version: "b", at: DAYTIME }))
      .rejects.toThrow(/can only be sent version A/);
  });

  it("is a person's act: a reader cannot send it, and quiet hours refuse it with nothing written", async () => {
    await expect(campaigns.sendRest(reader(), { id, version: "a", at: DAYTIME })).rejects.toThrow();
    await expect(campaigns.sendRest(owner(), { id, version: "a", at: NIGHT }))
      .rejects.toThrow(/inside your quiet hours/);
    const [c] = await raw<{ rest_variant: string | null }[]>`select rest_variant::text from public.marketing_campaign where id = ${id}`;
    expect(c!.rest_variant).toBeNull();
    expect((await rows(id)).filter((r) => r.state === "held").length).toBeGreaterThan(0);
  });

  it("checks consent, unsubscribes and the rules again at send time", async () => {
    const held = (await rows(id)).filter((r) => r.held_back).sort((a, b) => a.address.localeCompare(b.address));
    const [revoked, unsubscribed, outOfRules, moved] = held;
    await raw`update public.communication_consent set state = 'revoked'
              where organization_id = ${ORG} and address = ${revoked!.address} and channel = 'email'`;
    /** What the unsubscribe page writes: a stop on marketing to that address. */
    await raw`insert into public.suppression (organization_id, address, channel, purpose, reason)
              values (${ORG}, ${unsubscribed!.address}, 'email', 'marketing', 'unsubscribed')`;
    await raw`update public.customer set do_not_service = true where id = ${outOfRules!.customer_id}`;
    await raw`update public.customer set email = 'moved-away@example.test' where id = ${moved!.customer_id}`;

    const report = await campaigns.sendRest(owner(), { id, version: "a", at: DAYTIME });
    expect(report).toMatchObject({ version: "a", wasWinner: false, remaining: 0 });
    expect(report.queued + report.skipped).toBe(held.length);
    expect(report.skippedBy["no_longer_in_audience"]).toBe(2);
    expect(report.skipped).toBe(4);

    const after = await rows(id);
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(outOfRules!.id)).toMatchObject({ state: "skipped", skip_reason: "no_longer_in_audience" });
    expect(byId.get(moved!.id)).toMatchObject({ state: "skipped", skip_reason: "no_longer_in_audience" });
    expect(byId.get(revoked!.id)!.state).toBe("skipped");
    expect(byId.get(unsubscribed!.id)!.state).toBe("skipped");
    /** Everybody held back now carries the version they were sent. */
    expect(after.filter((r) => r.held_back).every((r) => r.variant === "a")).toBe(true);

    const sentOne = after.find((r) => r.held_back && r.state === "queued")!;
    const [message] = await raw<{ body: string; subject: string }[]>`select body, subject from public.message where id = ${sentOne.message_id!}`;
    expect(message!.body).toContain("Book your tune up");
    expect(message!.body).toContain(`utm_campaign=${tag}&utm_content=rest`);
    expect(message!.subject).toBe("Your spring tune up");

    const listed = await campaigns.recipients(owner(), { id, limit: 500, state: "skipped" });
    const explained = listed.data.find((r) => r.id === outOfRules!.id)!;
    expect(explained.heldBack).toBe(true);
    expect(explained.skipExplanation).toContain("No longer fits the campaign's rules");
  });

  it("is safe to repeat, and cannot change its mind part way", async () => {
    const before = await rows(id);
    const again = await campaigns.sendRest(owner(), { id, version: "a", at: DAYTIME });
    expect(again.remaining).toBe(0);
    const after = await rows(id);
    expect(after.filter((r) => r.state === "queued").length).toBe(before.filter((r) => r.state === "queued").length);
    await expect(campaigns.sendRest(owner(), { id, version: "b", at: DAYTIME }))
      .rejects.toThrow(/already being sent version A/);
    const view = await campaigns.get(owner(), { id });
    expect(view).toMatchObject({ restVersion: "a", restWasWinner: false });
    expect(view.restFinishedAt).not.toBeNull();
  });

  it("keeps the rest's clicks out of the test, and shows them beside it", async () => {
    const before = (await campaigns.results(owner(), { id })).abTest!;
    const restPerson = (await rows(id)).find((r) => r.held_back && r.state === "queued")!;
    await click(restPerson.customer_id, tag, "rest");
    const after = (await campaigns.results(owner(), { id })).abTest!;
    expect(after.versions.map((v) => v.clicks)).toEqual(before.versions.map((v) => v.clicks));
    expect(after.untaggedClicks).toBe(before.untaggedClicks);
    expect(after.rest).toMatchObject({ clicks: 1, version: "a", wasWinner: false, waiting: 0, offer: null });
    expect(after.versions.reduce((n, v) => n + v.sent, 0)).toBe(before.versions.reduce((n, v) => n + v.sent, 0));
  });
});

run("sending the winner", () => {
  it("is refused before the test has gone, and for a campaign that held nobody back", async () => {
    const draft = await campaigns.create(owner(), emailTest());
    await expect(campaigns.sendRest(owner(), { id: draft.id, version: "a", at: DAYTIME }))
      .rejects.toThrow(/has not gone out yet/);
    const plain = await campaigns.create(owner(), emailTest({ holdBackShare: null }));
    await campaigns.send(owner(), { id: plain.id, at: DAYTIME });
    await expect(campaigns.sendRest(owner(), { id: plain.id, version: "a", at: DAYTIME }))
      .rejects.toThrow(/held nobody back/);
    expect((await campaigns.results(owner(), { id: plain.id })).abTest!.rest).toBeNull();
  });

  it("sends the named winner, refuses version A instead, and records that it won", async () => {
    const created = await campaigns.create(owner(), emailTest({ holdBackShare: 40 }));
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    const tested = (await rows(created.id)).filter((r) => !r.held_back && r.state === "queued");
    const a = tested.filter((r) => r.variant === "a");
    const b = tested.filter((r) => r.variant === "b");
    /** One in ten of A and one in two of B followed the link: far more than luck. */
    for (const r of a.slice(0, Math.round(a.length * 0.1))) await click(r.customer_id, created.utmCampaign, "a");
    for (const r of b.slice(0, Math.round(b.length * 0.5))) await click(r.customer_id, created.utmCampaign, "b");

    const results = await campaigns.results(owner(), { id: created.id });
    expect(results.abTest!.winner).toBe("b");
    expect(results.abTest!.rest!.offer).toMatchObject({ version: "b", won: true });

    await expect(campaigns.sendRest(owner(), { id: created.id, version: "a", at: DAYTIME }))
      .rejects.toThrow(/Version B won the test/);
    const report = await campaigns.sendRest(owner(), { id: created.id, version: "b", at: DAYTIME });
    expect(report).toMatchObject({ version: "b", wasWinner: true, remaining: 0 });

    const held = (await rows(created.id)).filter((r) => r.held_back);
    /** The few people an earlier test took consent from or moved are skipped here too; everybody else is sent. */
    expect(report.queued + report.skipped).toBe(held.length);
    expect(report.skipped).toBeLessThanOrEqual(4);
    expect(held.every((r) => r.variant === "b")).toBe(true);
    const queuedOne = held.find((r) => r.state === "queued")!;
    const [message] = await raw<{ body: string }[]>`select body from public.message where id = ${queuedOne.message_id!}`;
    expect(message!.body).toContain("Only $89");

    /** The result that chose the winner does not move when the winner goes to more people. */
    const after = (await campaigns.results(owner(), { id: created.id })).abTest!;
    expect(after.versions.map((v) => [v.sent, v.clicks])).toEqual(results.abTest!.versions.map((v) => [v.sent, v.clicks]));
    expect(after.winner).toBe("b");

    const [audit] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.audit_log
      where entity_id = ${created.id} and action = 'campaign.rest_chosen'`;
    expect(audit!.n).toBe("1");
  });
});

run("the rest of a text list under a carrier's daily cap", () => {
  it("waits for the whole test to go, then sends a day's worth at a time when a person presses", async () => {
    const [brand] = await raw<{ id: string }[]>`
      insert into public.messaging_brand (organization_id, legal_name, display_name, status)
      values (${ORG}, 'Hold Co LLC', 'Hold Co', 'approved') returning id`;
    const [carrier] = await raw<{ id: string }[]>`
      insert into public.messaging_campaign (organization_id, brand_id, purpose, use_case, status, daily_cap, messages_per_second)
      values (${ORG}, ${brand!.id}, 'marketing', 'promotional', 'approved', ${CAP}, null) returning id`;
    const created = await campaigns.create(owner(), {
      name: "Held text", channel: "sms",
      audience: [{ kind: "tagged_any", tags: ["holdtext"] }],
      body: "Hold Co: $89 tune ups. Reply STOP to opt out.",
      variantBBody: "Hold Co: tune up special, $79. Reply STOP to opt out.",
      holdBackShare: 50,
      messagingCampaignId: carrier!.id,
    });
    const day = (n: number) => new Date(Date.parse(DAYTIME) + n * 86_400_000 + 60_000).toISOString();

    const first = await campaigns.send(owner(), { id: created.id, at: day(0) });
    const held = first.held;
    /** Half of forty by a hash: more than a day's cap on each side, short of a one in a million draw. */
    expect(held).toBeGreaterThan(CAP);
    expect(TEXTERS - held).toBeGreaterThan(CAP);
    expect(first).toMatchObject({ state: "sending", queued: CAP });
    await expect(campaigns.sendRest(owner(), { id: created.id, version: "a", at: day(0) }))
      .rejects.toThrow(/still going out/);
    let n = 1;
    let state = first.state;
    while (state !== "sent") state = (await campaigns.send(owner(), { id: created.id, at: day(n++) })).state;

    const one = await campaigns.sendRest(owner(), { id: created.id, version: "a", at: day(n++) });
    expect(one).toMatchObject({ queued: CAP, remaining: held - CAP });
    /** The same day again sends nothing more: the cap is a day, not a press. */
    const same = await campaigns.sendRest(owner(), { id: created.id, version: "a", at: day(n - 1) });
    expect(same).toMatchObject({ queued: CAP, remaining: held - CAP });
    let last = same;
    while (last.remaining > 0) last = await campaigns.sendRest(owner(), { id: created.id, version: "a", at: day(n++) });
    expect(last.queued).toBe(held);
    /** The worker never carries the rest on: only `sending` and scheduled campaigns are due. */
    const due = await campaigns.sendDue(db(), { now: new Date(day(n + 1)), only: [created.id] });
    expect(due).toEqual([]);
  });
});
