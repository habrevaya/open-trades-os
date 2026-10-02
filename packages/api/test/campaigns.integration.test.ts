import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { campaign as cp } from "@opentradesos/core";
import * as campaigns from "../src/services/campaigns";
import * as unsubscribe from "../src/services/unsubscribe";
import * as email from "../src/services/email";
import * as commsSend from "../src/services/comms-send";
import * as marketing from "../src/services/marketing";
import * as jobs from "../src/services/jobs";
import * as messageTemplates from "../src/services/message-templates";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE HALF OF MARKETING THAT SENDS
 *
 * M19 could measure a channel and could not use one. `campaign:read` and
 * `campaign:write` were granted to the owner and the marketing manager from
 * the first migration and checked by nothing, which the permission guard test
 * excused with "M19 measures; it does not yet send a campaign".
 *
 * FOUR THINGS IN THIS BATCH ARE GUARDS THAT EXISTED AND COULD NOT FIRE, and
 * each has a test here that fails if it goes back to not firing:
 *
 *   `canSend`'s `quiet_hours` branch. Refused only when a caller passes both
 *   a window and a local hour, and no caller passed either. Tested at eleven
 *   at night below.
 *
 *   The unsubscribe URL `email.queue` has always demanded. Nothing served a
 *   page, so the only way through the gate was a URL belonging to something
 *   else. Tested by following the link the send produced.
 *
 *   `messaging_campaign.daily_cap`, written and displayed and read by no
 *   sender. Tested by staging a send across two days.
 *
 *   The sending-number choice. `senderFor` preferred `main`, the number on
 *   the truck, for every outbound text including a blast.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cmp:org");
const USER = fixtureId("cmp:user");
const OTHER_ORG = fixtureId("cmp:other-org");
const OTHER_USER = fixtureId("cmp:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const other = (): ServiceContext => ({
  actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
});
/**
 * Exactly these permissions and NO ROLE, so a pair can be told apart.
 *
 * `owner` holds both halves of every pair in this file, so a refusal test
 * written against it proves only that the owner is an owner.
 */
const granted = (...permissions: string[]): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

/* ----------------------------------------------------------------- fixtures */

let seq = 0;

/**
 * A customer, with whatever contact details and history the test needs.
 *
 * `tags` goes through `raw.json`, not `JSON.stringify(...)::jsonb`. postgres-js
 * JSON encodes a parameter bound to a jsonb column, so a pre-stringified array
 * is encoded twice and the column ends up holding the JSON STRING
 * `"[\"vip\"]"` rather than an array. `?|` then matches nothing, every
 * `tagged_any` audience comes back empty, and the rule looks like it does not
 * work. The first version of this file did exactly that.
 */
async function customer(opts: {
  name: string;
  phone?: string | undefined;
  email?: string | undefined;
  tags?: string[] | undefined;
  postcode?: string | undefined;
  doNotService?: boolean | undefined;
  mergedInto?: string | undefined;
}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.customer (
      organization_id, type, name, phone, email, tags, billing_postal_code,
      do_not_service, merged_into_id, payment_terms_days
    ) values (
      ${ORG}, 'residential', ${opts.name}, ${opts.phone ?? null}, ${opts.email ?? null},
      ${raw.json(opts.tags ?? [])}, ${opts.postcode ?? null},
      ${opts.doNotService ?? false}, ${opts.mergedInto ?? null}, 0
    ) returning id`;
  return row!.id;
}

/** A completed job, this many days ago. Null means never completed. */
async function completedJob(customerId: string, daysAgo: number | null, total = "0"): Promise<string> {
  seq += 1;
  /**
   * `job.property_id` is NOT NULL, so a job needs somewhere to have happened.
   * Linked to the customer as well, because the equipment and postcode rules
   * reach equipment through `customer_property` and a job fixture that skipped
   * the link would make those rules look like they matched nothing.
   */
  const propertyId = await property(customerId, "78702");
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (
      organization_id, number, customer_id, property_id, status, summary, total, completed_at
    ) values (
      ${ORG}, ${seq}, ${customerId}, ${propertyId},
      ${daysAgo === null ? "lead" : "completed"}, 'Work',
      ${total}, ${daysAgo === null ? null : raw`now() - make_interval(days => ${daysAgo}::int)`}
    ) returning id`;
  return row!.id;
}

async function property(customerId: string, postcode: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Main', 'Austin', 'TX', ${postcode}) returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${row!.id})`;
  return row!.id;
}

async function equipment(propertyId: string, opts: {
  installedYearsAgo: number; category?: string;
}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.equipment (organization_id, property_id, category, installed_on)
    values (
      ${ORG}, ${propertyId}, ${opts.category ?? "furnace"},
      (current_date - make_interval(years => ${opts.installedYearsAgo}::int))::date
    ) returning id`;
  return row!.id;
}

async function plan(): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.agreement_plan (organization_id, name, code, price, billing_frequency)
    values (${ORG}, 'Comfort Club', ${`cc-${seq += 1}`}, '199.0000', 'annual') returning id`;
  return row!.id;
}

async function agreement(customerId: string, opts: {
  status: string; endsInDays?: number | null;
}): Promise<string> {
  const planId = await plan();
  const [row] = await raw<{ id: string }[]>`
    insert into public.agreement (
      organization_id, plan_id, customer_id, status, started_on, ends_on, price, billing_frequency
    ) values (
      ${ORG}, ${planId}, ${customerId}, ${opts.status}::agreement_status, current_date - 365,
      ${opts.endsInDays === undefined || opts.endsInDays === null
        ? null
        : raw`(current_date + make_interval(days => ${opts.endsInDays}::int))::date`},
      '199.0000', 'annual'
    ) returning id`;
  return row!.id;
}

/** A sending number, registered, of the given purpose. */
async function number(e164: string, purpose: "main" | "sending" | "tracking"): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.phone_number (organization_id, e164, purpose, sms_registered, capabilities)
    values (${ORG}, ${e164}, ${purpose}::phone_number_purpose, true, '{"sms":true}'::jsonb)
    returning id`;
  return row!.id;
}

async function consentFor(address: string, opts: {
  channel: "sms" | "email"; purpose: "marketing" | "transactional"; state?: "granted" | "revoked";
}): Promise<void> {
  await raw`
    insert into public.communication_consent (
      organization_id, address, channel, purpose, state, method, proof_text
    ) values (
      ${ORG}, ${address}, ${opts.channel}::comm_channel, ${opts.purpose}::comm_purpose,
      ${opts.state ?? "granted"}::consent_state, 'web_form', 'Yes, text me offers'
    )`;
}

async function emailProvider(): Promise<void> {
  await raw`
    insert into public.integration_connection (
      organization_id, capability, provider, status, settings
    ) values (
      ${ORG}, 'email', 'smtp', 'connected',
      '{"fromAddress":"office@comfortco.test","fromName":"Comfort Co"}'::jsonb
    )`;
}

/** A carrier registration with a throughput and a daily cap. */
async function carrierCampaign(dailyCap: number | null, perSecond: number | null): Promise<string> {
  const [brand] = await raw<{ id: string }[]>`
    insert into public.messaging_brand (organization_id, legal_name, display_name, status)
    values (${ORG}, 'Comfort Co LLC', 'Comfort Co', 'approved') returning id`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.messaging_campaign (
      organization_id, brand_id, purpose, use_case, status, daily_cap, messages_per_second
    ) values (
      ${ORG}, ${brand!.id}, 'marketing', 'promotional', 'approved', ${dailyCap}, ${perSecond}
    ) returning id`;
  return row!.id;
}

const BASE = "https://comfortco.test";

/**
 * 11am in America/Chicago, and every send that is not about quiet hours passes
 * it.
 *
 * Not tidiness. The default quiet hours window is 9pm to 8am, so a suite that
 * let `send` read the clock passed in the morning and failed in the evening,
 * which is how it behaved the first time it was run: thirteen tests went red at
 * ten at night for a reason none of them was about. `at` is a parameter on the
 * sender precisely so this is expressible.
 */
const DAYTIME = "2026-07-01T16:00:00.000Z";
/** 23:30 the previous evening in the same zone. */
const NIGHT = "2026-07-01T04:30:00.000Z";
const previousBase = process.env["PUBLIC_BASE_URL"];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  process.env["PUBLIC_BASE_URL"] = BASE;
});
afterAll(async () => {
  if (raw) await raw.end();
  if (previousBase === undefined) delete process.env["PUBLIC_BASE_URL"];
  else process.env["PUBLIC_BASE_URL"] = previousBase;
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Comfort Co", slug: "comfort-co" });
  await seedOrg(raw, {
    organizationId: OTHER_ORG, userId: OTHER_USER, name: "Rival Co", slug: "rival-co",
  });
});

const sms = (over: Partial<campaigns.CampaignInput> = {}): campaigns.CampaignInput => ({
  name: `Spring tune up ${(seq += 1)}`,
  channel: "sms",
  audience: [{ kind: "served_at_least_once" }],
  body: "Comfort Co here: $89 tune ups this month. Reply STOP to opt out.",
  ...over,
});

/* ===================================================== the audience rules */

run("who the rules select", () => {
  it("refuses an audience with no rules, which would be everybody", async () => {
    /**
     * THE MOST VALUABLE REFUSAL IN THE FEATURE. No rules means the whole
     * customer list, which is how a company's one registered number gets
     * flagged by a carrier and its domain blocked in an afternoon. There must
     * be no accidental path to it, so the refusal is in core, checked on
     * create, checked again on update, and the audience query itself throws
     * rather than emitting a WHERE with no clauses.
     */
    await expect(campaigns.create(owner(), sms({ audience: [] })))
      .rejects.toThrow(/at least one rule/);

    await expect(campaigns.preview(owner(), { channel: "sms", audience: [] }))
      .rejects.toThrow(/at least one rule/);
  });

  it("refuses two live campaigns on one tag as a refusal, not as a crash", async () => {
    /**
     * `marketing_campaign_utm_idx` enforced it and nothing turned Postgres's
     * 23505 into a refusal. The tag is derived from the name unless somebody
     * supplies one, so a second campaign named like the first collides without
     * anybody typing a tag at all, and attribution is the whole point of it: two
     * campaigns sharing one means the booked job six weeks later names neither.
     * `services/duplicates.ts` has why it is caught rather than pre-checked.
     */
    await campaigns.create(owner(), sms({ utmCampaign: "spring-tune-up" }));
    await expect(campaigns.create(owner(), sms({ utmCampaign: "spring-tune-up" })))
      .rejects.toThrow(ConflictError);
    await expect(campaigns.create(owner(), sms({ utmCampaign: "spring-tune-up" })))
      .rejects.toThrow(/already the tag of a live campaign/);
  });

  it("selects a win back audience and leaves out somebody never served", async () => {
    /**
     * The sharp distinction in `no_job_since`. Read literally, "no completed
     * work in two years" is also true of a lead who rang for a price in 2019
     * and never bought, and a discount offer to somebody who has never been a
     * customer is a different campaign with a different message. The rule
     * compares the MOST RECENT completion, which makes having one part of the
     * comparison rather than a second clause somebody can drop.
     */
    const lapsed = await customer({ name: "Lapsed", phone: "+15125550001" });
    await completedJob(lapsed, 800);
    const recent = await customer({ name: "Recent", phone: "+15125550002" });
    await completedJob(recent, 30);
    const neverBought = await customer({ name: "Never", phone: "+15125550003" });
    await completedJob(neverBought, null);

    const result = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "no_job_since", days: 730 }],
    });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.name)).toEqual(["Lapsed"]);
    expect(result.inWords).toBe("Customers who were last served more than 730 days ago.");
  });

  it("ANDs the rules rather than ORing them", async () => {
    /**
     * An owner building two rules wants the intersection. The union is four
     * times the send and the bill, and it is what a tool whose filters OR
     * together gives them.
     */
    const both = await customer({ name: "Both", phone: "+15125550011", tags: ["vip"] });
    await completedJob(both, 900);
    const onlyOld = await customer({ name: "OnlyOld", phone: "+15125550012" });
    await completedJob(onlyOld, 900);
    const onlyVip = await customer({ name: "OnlyVip", phone: "+15125550013", tags: ["vip"] });
    await completedJob(onlyVip, 10);

    const result = await campaigns.preview(owner(), {
      channel: "sms",
      audience: [{ kind: "no_job_since", days: 730 }, { kind: "tagged_any", tags: ["vip"] }],
    });

    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.name)).toEqual(["Both"]);
  });

  it("finds an ageing unit through the property, and respects the category", async () => {
    const old = await customer({ name: "OldFurnace", phone: "+15125550021" });
    const oldProp = await property(old, "78704");
    await equipment(oldProp, { installedYearsAgo: 22, category: "furnace" });

    const newish = await customer({ name: "NewFurnace", phone: "+15125550022" });
    await equipment(await property(newish, "78704"), { installedYearsAgo: 3, category: "furnace" });

    const wrongKind = await customer({ name: "OldWaterHeater", phone: "+15125550023" });
    await equipment(await property(wrongKind, "78704"), {
      installedYearsAgo: 22, category: "water_heater",
    });

    const anyKind = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "equipment_older_than", years: 15 }],
    });
    expect(anyKind.sample.map((s) => s.name).sort()).toEqual(["OldFurnace", "OldWaterHeater"]);

    const furnacesOnly = await campaigns.preview(owner(), {
      channel: "sms",
      audience: [{ kind: "equipment_older_than", years: 15, category: "furnace" }],
    });
    expect(furnacesOnly.sample.map((s) => s.name)).toEqual(["OldFurnace"]);
  });

  it("separates an agreement ending soon from one that already lapsed", async () => {
    /**
     * A renewal campaign going to somebody whose renewal date has passed,
     * telling them it has not, is the failure this split prevents.
     */
    const renewing = await customer({ name: "Renewing", phone: "+15125550031" });
    await agreement(renewing, { status: "active", endsInDays: 20 });
    const gone = await customer({ name: "Gone", phone: "+15125550032" });
    await agreement(gone, { status: "lapsed", endsInDays: -40 });
    const longWay = await customer({ name: "LongWay", phone: "+15125550033" });
    await agreement(longWay, { status: "active", endsInDays: 300 });

    const ending = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "agreement_ending_within", days: 30 }],
    });
    expect(ending.sample.map((s) => s.name)).toEqual(["Renewing"]);

    const lapsed = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "agreement_lapsed" }],
    });
    expect(lapsed.sample.map((s) => s.name)).toEqual(["Gone"]);
  });

  it("counts a finished agreement as having had one", async () => {
    /**
     * THIS TEST CAUGHT THE RULE BEING WRONG, which is why it is here in this
     * shape. The first version of `no_agreement` filtered to the live statuses,
     * which makes it "holds no agreement right now" and quietly includes
     * everybody whose plan lapsed, was cancelled, or ran its term and
     * completed. An upsell email asking whether somebody has considered a
     * maintenance plan, sent to a customer who held one for six years, reads as
     * a company that does not know who its own customers are.
     *
     * It also made the contradiction refusal wrong: `no_agreement` and
     * `agreement_lapsed` are refused as a pair because they cannot both hold,
     * and under the old reading they could.
     */
    const finished = await customer({ name: "Finished", phone: "+15125550041" });
    await agreement(finished, { status: "completed", endsInDays: -10 });
    const never = await customer({ name: "NeverHad", phone: "+15125550042" });

    const none = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "no_agreement" }],
    });
    expect(none.sample.map((s) => s.name)).toEqual(["NeverHad"]);

    const lapsedToo = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "agreement_lapsed" }],
    });
    expect(lapsedToo.count).toBe(0);
  });

  it("matches a postcode on a property or on the billing address", async () => {
    /**
     * The disjunction is deliberate. The service address is what a contractor
     * means by a postcode, and a record carrying only the address the invoice
     * goes to is not therefore outside the area: excluding those would shrink
     * a geographic campaign by however much of the list predates property
     * linking, silently.
     */
    const byProperty = await customer({ name: "ByProperty", phone: "+15125550051" });
    await property(byProperty, "78704");
    const byBilling = await customer({
      name: "ByBilling", phone: "+15125550052", postcode: "78704",
    });
    const elsewhere = await customer({ name: "Elsewhere", phone: "+15125550053" });
    await property(elsewhere, "78759");

    const result = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "postal_code_in", codes: ["78704"] }],
    });
    expect(result.sample.map((s) => s.name).sort()).toEqual(["ByBilling", "ByProperty"]);
  });

  it("includes a quoted deficiency, not only an untouched one", async () => {
    /**
     * A quoted finding nobody approved is the better half of this audience:
     * the conversation has happened and the price is known.
     */
    const open = await customer({ name: "OpenFault", phone: "+15125550061" });
    const quoted = await customer({ name: "QuotedFault", phone: "+15125550062" });
    const fixed = await customer({ name: "Corrected", phone: "+15125550063" });
    for (const [who, status] of [[open, "open"], [quoted, "quoted"], [fixed, "corrected"]] as const) {
      const prop = await property(who, "78704");
      await raw`
        insert into public.deficiency (
          organization_id, property_id, customer_id, status, severity, checkpoint_key,
          description, found_on
        ) values (
          ${ORG}, ${prop}, ${who}, ${status}::deficiency_status, 'major', 'heat_exchanger',
          'Cracked', current_date
        )`;
    }

    const result = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "open_deficiency" }],
    });
    expect(result.sample.map((s) => s.name).sort()).toEqual(["OpenFault", "QuotedFault"]);
  });

  it("leaves out a do-not-service record and a merged one", async () => {
    /**
     * The merge case is the one that bites. A merge leaves the old row
     * pointing at the survivor, and selecting both texts one person twice from
     * two customer ids the once-per-campaign index cannot see are one person.
     */
    const keep = await customer({ name: "Keep", phone: "+15125550071" });
    await completedJob(keep, 10);
    const banned = await customer({ name: "Banned", phone: "+15125550072", doNotService: true });
    await completedJob(banned, 10);
    const merged = await customer({ name: "Merged", phone: "+15125550073", mergedInto: keep });
    await completedJob(merged, 10);

    const result = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "served_at_least_once" }],
    });
    expect(result.sample.map((s) => s.name)).toEqual(["Keep"]);
  });

  it("makes the channel part of the selection rather than a filter after it", async () => {
    /**
     * A customer with no email address is not a recipient of an email campaign
     * who was skipped. They were never in it. Counting them as a skip makes a
     * reach rate that says consent collection is failing when the truth is
     * that nobody ever asked for their address.
     */
    const bothWays = await customer({
      name: "Both", phone: "+15125550081", email: "both@example.test",
    });
    await completedJob(bothWays, 10);
    const phoneOnly = await customer({ name: "PhoneOnly", phone: "+15125550082" });
    await completedJob(phoneOnly, 10);
    const blankEmail = await customer({ name: "Blank", phone: "+15125550083", email: "   " });
    await completedJob(blankEmail, 10);

    const bySms = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "served_at_least_once" }],
    });
    expect(bySms.count).toBe(3);

    const byEmail = await campaigns.preview(owner(), {
      channel: "email", audience: [{ kind: "served_at_least_once" }],
    });
    expect(byEmail.sample.map((s) => s.name)).toEqual(["Both"]);
  });

  it("refuses the same rule twice and a pair that cannot both hold", async () => {
    await expect(campaigns.preview(owner(), {
      channel: "sms",
      audience: [{ kind: "no_job_since", days: 30 }, { kind: "no_job_since", days: 700 }],
    })).rejects.toThrow(/twice/);

    await expect(campaigns.preview(owner(), {
      channel: "sms",
      audience: [{ kind: "no_agreement" }, { kind: "agreement_lapsed" }],
    })).rejects.toThrow(/cannot both be true/);
  });

  it("reports every refusal, not the first", async () => {
    const result = cp.checkAudience([
      { kind: "no_job_since", days: 0 },
      { kind: "postal_code_in", codes: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.map((r) => r.reason).sort()).toEqual(["empty_list", "out_of_range"]);
    }
  });
});

/* ======================================================== what it can say */

run("what a campaign may say", () => {
  it("refuses a subject on a text and a text with no subject on email", async () => {
    await expect(campaigns.create(owner(), sms({ subject: "Spring offer" })))
      .rejects.toThrow(/text has no subject/);

    await expect(campaigns.create(owner(), sms({ channel: "email", subject: null })))
      .rejects.toThrow(/needs a subject/);
  });

  it("refuses a text the carrier would truncate", async () => {
    /**
     * What gets cut off is the end, where the opt out line is, so a truncated
     * marketing text is the opt out line missing.
     */
    await expect(campaigns.create(owner(), sms({ body: "a".repeat(cp.SMS_MAX + 1) })))
      .rejects.toThrow(/truncates/);
  });

  it("derives the utm value from the name so a report has one spelling", async () => {
    const created = await campaigns.create(owner(), sms({ name: "Spring Tune Up 2026!" }));
    expect(created.utmCampaign).toBe("spring-tune-up-2026");
  });

  it("will not let two live campaigns claim the same utm value", async () => {
    /**
     * Two campaigns claiming one utm value means an arriving touch credits
     * whichever the planner returned. The index is partial on neither deleted
     * nor cancelled, so the name is reusable after a campaign is abandoned.
     */
    await campaigns.create(owner(), sms({ name: "Duplicate", utmCampaign: "dupe" }));
    await expect(campaigns.create(owner(), sms({ name: "Other", utmCampaign: "dupe" })))
      .rejects.toThrow();
  });
});

/* ============================================================== the send */

run("handing a batch to the outbox", () => {
  beforeEach(async () => {
    await number("+15125559999", "main");
  });

  it("writes a row for everybody, including the ones it will not send to", async () => {
    /**
     * THE WHOLE POINT OF THE RECIPIENT TABLE. Filtering the unreachable out
     * before the list is stored is how a company comes to believe it sent four
     * thousand texts when it sent nine hundred: the gate refused the rest for
     * consent and the refusals existed only in a log nobody reads. Stored with
     * the reason, the same list is the worklist for collecting the consent
     * that would make the next campaign twice the size.
     */
    const yes = await customer({ name: "Consented", phone: "+15125550101" });
    await completedJob(yes, 10);
    await consentFor("+15125550101", { channel: "sms", purpose: "marketing" });

    const no = await customer({ name: "NoConsent", phone: "+15125550102" });
    await completedJob(no, 10);

    const stopped = await customer({ name: "Stopped", phone: "+15125550103" });
    await completedJob(stopped, 10);
    await consentFor("+15125550103", { channel: "sms", purpose: "marketing" });
    await raw`
      insert into public.suppression (organization_id, address, channel, purpose, reason)
      values (${ORG}, '+15125550103', 'sms', null, 'stop_keyword')`;

    const created = await campaigns.create(owner(), sms());
    const report = await campaigns.send(owner(), { id: created.id, at: DAYTIME });

    expect(report.selected).toBe(3);
    expect(report.queued).toBe(1);
    expect(report.skipped).toBe(2);
    expect(report.skippedBy).toEqual({ no_consent: 1, suppressed: 1 });
    expect(report.state).toBe("sent");

    const { data } = await campaigns.recipients(owner(), { id: created.id, limit: 100 });
    const byName = new Map(data.map((r) => [r.customerName, r]));
    expect(byName.get("Consented")!.state).toBe("queued");
    expect(byName.get("Consented")!.messageId).not.toBeNull();
    expect(byName.get("NoConsent")!.skipReason).toBe("no_consent");
    /** The sentence, not the identifier. An operator reads this column. */
    expect(byName.get("Stopped")!.skipExplanation).toMatch(/replied STOP/);
    expect(yes && no && stopped).toBeTruthy();
  });

  it("refuses everybody at eleven at night, which no caller could ever make happen", async () => {
    /**
     * THE QUIET HOURS BRANCH THAT HAD NEVER FIRED.
     *
     * `comms.canSend` has refused `quiet_hours` since it was written, only
     * when a caller passes both a window and a local hour, and no caller
     * passed either: not the SMS sender, not the workflow executor, not the
     * email queue, not the consent screen. `inQuietHours` was tested in core
     * and unreachable from the product, and both `refusal` functions carried a
     * sentence for a reason neither could ever be handed.
     *
     * NIGHT is 23:30 the previous evening in America/Chicago.
     */
    const who = await customer({ name: "Asleep", phone: "+15125550111" });
    await completedJob(who, 10);
    await consentFor("+15125550111", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    const night = await campaigns.send(owner(), {
      id: created.id, at: NIGHT,
    });

    expect(night.queued).toBe(0);
    expect(night.skippedBy).toEqual({ quiet_hours: 1 });
  });

  it("sends inside the window the company set, and nothing when it is turned off", async () => {
    const who = await customer({ name: "Awake", phone: "+15125550112" });
    await completedJob(who, 10);
    await consentFor("+15125550112", { channel: "sms", purpose: "marketing" });

    /**
     * Quiet hours off entirely, which a B2B contractor texting facilities
     * managers may legitimately want. `null` is that choice; an absent key
     * takes the legal default.
     */
    await raw`update public.organization set settings = '{"quietHours":null}'::jsonb
              where id = ${ORG}`;

    const created = await campaigns.create(owner(), sms());
    const night = await campaigns.send(owner(), {
      id: created.id, at: NIGHT,
    });
    expect(night.queued).toBe(1);
  });

  it("falls back to the legal window when the setting is malformed", async () => {
    /**
     * The failure mode of the other choice is a typo in a settings blob
     * quietly removing the only thing stopping a two in the morning send.
     */
    const who = await customer({ name: "Typo", phone: "+15125550113" });
    await completedJob(who, 10);
    await consentFor("+15125550113", { channel: "sms", purpose: "marketing" });
    await raw`update public.organization set settings = '{"quietHours":{"startHour":"nine"}}'::jsonb
              where id = ${ORG}`;

    const created = await campaigns.create(owner(), sms());
    const night = await campaigns.send(owner(), {
      id: created.id, at: NIGHT,
    });
    expect(night.skippedBy).toEqual({ quiet_hours: 1 });
  });

  it("sends a blast from the sending pool, not from the number on the truck", async () => {
    /**
     * `senderFor` preferred `main` for every outbound text. A bulk send from
     * the number on the truck is the fastest way to lose the number on the
     * truck: carriers score a sending number on complaint and opt out rate, a
     * campaign moves that score in one afternoon, and when it moves far enough
     * the filtering lands on the "we are on our way" a customer is waiting
     * for.
     */
    await number("+15125558888", "sending");

    const who = await customer({ name: "Recipient", phone: "+15125550121" });
    await completedJob(who, 10);
    await consentFor("+15125550121", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });

    const [sent] = await raw<{ from_address: string; purpose: string }[]>`
      select from_address, purpose from public.message
      where organization_id = ${ORG} and direction = 'outbound'`;
    expect(sent!.from_address).toBe("+15125558888");
    expect(sent!.purpose).toBe("marketing");

    /** And a conversational text still comes from the number they recognise. */
    const conversational = await commsSend.sendability(db(), ORG, "+15125550121");
    expect(conversational.from?.e164).toBe("+15125559999");
  });

  it("never sends from a tracking number, whichever send it is", async () => {
    /**
     * Absent from both orders rather than ranked last, because ranking last
     * still picks one when it is all there is, and a campaign credited with a
     * lead that is a reply to our own text is worse than no campaign number.
     */
    await raw`delete from public.phone_number where organization_id = ${ORG}`;
    await number("+15125557777", "tracking");

    const who = await customer({ name: "Recipient", phone: "+15125550131" });
    await completedJob(who, 10);
    await consentFor("+15125550131", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    const report = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(report.skippedBy).toEqual({ channel_not_registered: 1 });
  });

  it("stages the send across days at the carrier's daily cap", async () => {
    /**
     * `messaging_campaign.daily_cap` and `.messages_per_second` carried the
     * comment "carrier assigned throughput, so the sender can pace rather than
     * fail" and were read by no sender. A carrier that allows 2,000 a day does
     * not slow down a sender that ignores it: it rejects the overflow, and
     * rejected marketing counts against the number whether or not anybody
     * reads the error.
     */
    const carrier = await carrierCampaign(2, 10);
    for (let i = 0; i < 5; i += 1) {
      const phone = `+151255502${10 + i}`;
      const who = await customer({ name: `Person${i}`, phone });
      await completedJob(who, 10);
      await consentFor(phone, { channel: "sms", purpose: "marketing" });
    }

    const created = await campaigns.create(owner(), sms({ messagingCampaignId: carrier }));

    const preview = await campaigns.preview(owner(), { id: created.id });
    expect(preview.count).toBe(5);
    expect(preview.pace).toEqual({
      firstBatch: 2, days: 3, secondsBetween: 0.1, staged: true,
    });

    const day1 = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(day1.queued).toBe(2);
    expect(day1.remaining).toBe(3);
    /** Still sending, because marking it sent with three left would lie. */
    expect(day1.state).toBe("sending");

    /**
     * A second press the SAME day sends nothing. The cap is the carrier's per
     * day, and it used to be applied per call, so pressing twice (or a worker
     * coming round again) sent a second day's worth into a carrier that would
     * reject it.
     */
    const again = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(again.queued).toBe(2);
    expect(again.remaining).toBe(3);

    const nextDay = (days: number) => new Date(Date.parse(DAYTIME) + days * 86_400_000).toISOString();
    const day2 = await campaigns.send(owner(), { id: created.id, at: nextDay(1) });
    expect(day2.queued).toBe(4);
    expect(day2.remaining).toBe(1);

    const day3 = await campaigns.send(owner(), { id: created.id, at: nextDay(2) });
    expect(day3.queued).toBe(5);
    expect(day3.remaining).toBe(0);
    expect(day3.state).toBe("sent");
  });

  it("sends nothing when the carrier has approved a cap of zero", async () => {
    /**
     * Zero is NOT "no cap". It is a carrier that approved the registration and
     * allowed nothing through, which happens, and the sender must send nothing
     * rather than everything. Treating a falsy cap as absent is the one line
     * where those two outcomes are a character apart.
     */
    const carrier = await carrierCampaign(0, null);
    const who = await customer({ name: "Waiting", phone: "+15125550231" });
    await completedJob(who, 10);
    await consentFor("+15125550231", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms({ messagingCampaignId: carrier }));
    const report = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(report.selected).toBe(0);
    expect(report.remaining).toBe(1);
    expect(report.state).toBe("sending");
  });

  it("does not send twice when the same campaign is sent again", async () => {
    const who = await customer({ name: "Once", phone: "+15125550241" });
    await completedJob(who, 10);
    await consentFor("+15125550241", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    const first = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(first.queued).toBe(1);

    /**
     * The campaign is `sent`, so a second send is refused by the state
     * machine. The row count is the assertion that matters: a future change
     * that allowed a re-send must not produce a second message.
     */
    await expect(campaigns.send(owner(), { id: created.id, at: DAYTIME })).rejects.toThrow(/already gone out/);
    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.message where organization_id = ${ORG}`;
    expect(n).toBe("1");
  });

  it("texts one phone once when two customers share it", async () => {
    /**
     * A husband and a wife, or a landlord and their company. The unique index
     * would refuse the second insert mid batch and abort everything after it;
     * keeping the first is also the right answer for the person holding the
     * phone.
     */
    const a = await customer({ name: "Aaron", phone: "+15125550251" });
    const b = await customer({ name: "Bea", phone: "(512) 555-0251" });
    await completedJob(a, 10);
    await completedJob(b, 10);
    await consentFor("+15125550251", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    const report = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(report.selected).toBe(1);
    expect(report.queued).toBe(1);
  });

  it("queues, never claims sent", async () => {
    /**
     * The outbox hands it to the carrier and records what came back. A row
     * saying `sent` here would make the log claim something the company cannot
     * stand behind.
     */
    const who = await customer({ name: "Queued", phone: "+15125550261" });
    await completedJob(who, 10);
    await consentFor("+15125550261", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    const [row] = await raw<{ status: string }[]>`
      select status from public.message where organization_id = ${ORG}`;
    expect(row!.status).toBe("queued");
  });

  it("attaches the text to a conversation so a reply lands in the inbox", async () => {
    /**
     * A marketing text a customer cannot reply to is a worse version of a
     * letter. The replies are the point of the channel.
     */
    const who = await customer({ name: "Replier", phone: "+15125550271" });
    await completedJob(who, 10);
    await consentFor("+15125550271", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });

    const [thread] = await raw<{ customer_id: string; external_address: string }[]>`
      select customer_id, external_address from public.conversation
      where organization_id = ${ORG}`;
    expect(thread!.customer_id).toBe(who);
    expect(thread!.external_address).toBe("+15125550271");
  });
});

/* ====================================================== the email channel */

run("an email campaign", () => {
  beforeEach(async () => {
    await emailProvider();
  });

  const mail = (over: Partial<campaigns.CampaignInput> = {}): campaigns.CampaignInput => ({
    name: `Maintenance plan ${(seq += 1)}`,
    channel: "email",
    subject: "Your furnace is 22 years old",
    audience: [{ kind: "served_at_least_once" }],
    body: "A plan covers two visits a year. Reply to this email to start one.",
    ...over,
  });

  it("carries an unsubscribe link that this product can actually serve", async () => {
    /**
     * `email.queue` has refused marketing with no unsubscribe URL since it was
     * written, which is CAN-SPAM and the Gmail and Yahoo bulk sender rules, and
     * this product served no page. The only way through the gate was a URL
     * belonging to something else: a 404 in a List-Unsubscribe header, or a page
     * on another system that cannot write a suppression into this database. The
     * company looked compliant, passed its own check, and kept emailing people
     * who asked it to stop.
     *
     * This is the end to end assertion: the send mints a link, the header
     * carries it, and following it reaches this product.
     */
    const who = await customer({ name: "Reader", email: "reader@example.test" });
    await completedJob(who, 10);
    await consentFor("reader@example.test", { channel: "email", purpose: "marketing" });

    const created = await campaigns.create(owner(), mail());
    const report = await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    expect(report.queued).toBe(1);

    const [sent] = await raw<{ headers: Record<string, string> }[]>`
      select headers from public.message
      where organization_id = ${ORG} and channel = 'email' and direction = 'outbound'`;
    const header = sent!.headers["List-Unsubscribe"];
    expect(header).toMatch(/^<https:\/\/comfortco\.test\/api\/v1\/public\/unsubscribe\/.+>$/);
    /** Without this one Gmail draws no unsubscribe control at all. */
    expect(sent!.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const token = header!.replace(/^<|>$/g, "").split("/").pop()!;
    const page = await unsubscribe.describe(db(), { token });
    expect(page.known).toBe(true);
    expect(page.company).toBe("Comfort Co");
  });

  it("refuses the whole batch, and writes no link, when it has no own address", async () => {
    /**
     * THE ORDER INSIDE `mintUnsubscribe` IS WHAT THIS TESTS: the host is
     * checked before the row is written. The other order mints a token, inserts
     * the row, then throws, which would leave a live unsubscribe link for a
     * mail that was never sent.
     *
     * There used to be a second check at the top of `send` as well, described
     * as stopping a misconfiguration being discovered one recipient at a time.
     * The breakage sweep removed it and this test stayed green, correctly: the
     * throw aborts the transaction either way, so the outcome is identical and
     * the line was two reads earlier in the function and nothing else. It is
     * gone.
     */
    delete process.env["PUBLIC_BASE_URL"];
    try {
      const who = await customer({ name: "Reader", email: "reader@example.test" });
      await completedJob(who, 10);
      await consentFor("reader@example.test", { channel: "email", purpose: "marketing" });

      const created = await campaigns.create(owner(), mail());
      await expect(campaigns.send(owner(), { id: created.id, at: DAYTIME }))
        .rejects.toThrow(/PUBLIC_BASE_URL/);

      const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
        select count(*)::text as n from public.unsubscribe_link where organization_id = ${ORG}`;
      expect(n).toBe("0");
    } finally {
      process.env["PUBLIC_BASE_URL"] = BASE;
    }
  });

  it("holds an overnight email back too", async () => {
    /**
     * Email is outside the TCPA and the window still applies, because a
     * marketing email landing at two in the morning is read at seven with
     * eleven hours of other mail on top of it, or wakes a phone.
     */
    const who = await customer({ name: "Asleep", email: "asleep@example.test" });
    await completedJob(who, 10);
    await consentFor("asleep@example.test", { channel: "email", purpose: "marketing" });

    const created = await campaigns.create(owner(), mail());
    const report = await campaigns.send(owner(), {
      id: created.id, at: NIGHT,
    });
    expect(report.skippedBy).toEqual({ quiet_hours: 1 });
  });
});

/* ======================================================== the unsubscribe */

run("the unsubscribe page", () => {
  async function linkFor(address: string): Promise<string> {
    const { token } = await campaigns.mintUnsubscribe(db(), ORG, { address });
    return token;
  }

  it("writes nothing on a GET, because every prefetcher sends one", async () => {
    /**
     * THE ASYMMETRY IS THE WHOLE DESIGN. RFC 8058 one click is a POST, sent by
     * the mailbox provider when somebody presses the control Gmail draws next
     * to the sender's name. A human clicking the link in the body arrives with
     * a GET, and so does every link prefetcher, corporate mail scanner,
     * security product that follows URLs in inbound mail, and chat client
     * rendering a preview.
     *
     * If GET unsubscribed, a company's whole list would be opted out by
     * software over a few months with no human having clicked anything, and the
     * symptom would be a marketing list that mysteriously stopped working.
     */
    const token = await linkFor("prefetch@example.test");

    const page = await unsubscribe.describe(db(), { token });
    expect(page.known).toBe(true);
    expect(page.done).toBe(false);

    const [{ n: suppressions } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.suppression where organization_id = ${ORG}`;
    const [{ n: consents } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.communication_consent
      where organization_id = ${ORG}`;
    const [{ n: used } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.unsubscribe_link
      where organization_id = ${ORG} and used_at is not null`;
    expect([suppressions, consents, used]).toEqual(["0", "0", "0"]);
  });

  it("stops marketing email and leaves the invoice alone", async () => {
    /**
     * A suppression for email MARKETING, never a blanket one. Somebody who
     * stops wanting promotions has not stopped wanting their invoice, their
     * appointment confirmation or their receipt, and a product that reads
     * unsubscribe as never-contact-again breaks the company's ability to do
     * business with a customer who is still a customer.
     */
    await emailProvider();
    await consentFor("both@example.test", { channel: "email", purpose: "marketing" });
    const token = await linkFor("both@example.test");

    await unsubscribe.confirm(db(), { token }, { ip: "203.0.113.9" });

    const marketing = await email.emailability(db(), ORG, "both@example.test", "marketing");
    expect(marketing.allowed).toBe(false);

    const transactional = await email.emailability(db(), ORG, "both@example.test", "transactional");
    expect(transactional.allowed).toBe(true);
  });

  it("writes the evidence as well as the enforcement", async () => {
    /**
     * Both rows, doing different jobs. The suppression is what `canSend`
     * checks first and refuses on before anything can override it. The consent
     * revocation is what answers "were you allowed to send that, on that day"
     * a year later, and it is also what stops an operator granting consent
     * again from a stale form and quietly resurrecting the address.
     */
    const token = await linkFor("evidence@example.test");
    await unsubscribe.confirm(db(), { token }, { ip: "203.0.113.9" });

    const [consent] = await raw<{
      state: string; method: string; purpose: string; channel: string;
      proof_reference: string | null; ip_address: string | null; captured_by_user_id: string | null;
    }[]>`
      select state, method, purpose, channel, proof_reference, ip_address, captured_by_user_id
      from public.communication_consent where organization_id = ${ORG}`;
    expect(consent!.state).toBe("revoked");
    expect(consent!.channel).toBe("email");
    expect(consent!.purpose).toBe("marketing");
    /**
     * `web_form`, not `api`. The recipient acted: they pressed a control in
     * their own mail client. Recording it as an API call would make the
     * company's own evidence say a system withdrew the consent for them.
     */
    expect(consent!.method).toBe("web_form");
    expect(consent!.proof_reference).toMatch(/^unsubscribe_link:/);
    expect(consent!.ip_address).toBe("203.0.113.9");
    /** Nobody is signed in, and a fabricated user id would be a false record. */
    expect(consent!.captured_by_user_id).toBeNull();

    const [suppression] = await raw<{ purpose: string | null; reason: string }[]>`
      select purpose, reason from public.suppression where organization_id = ${ORG}`;
    expect(suppression!.purpose).toBe("marketing");
    expect(suppression!.reason).toBe("unsubscribed");
  });

  it("answers a second press with the same page rather than an error", async () => {
    /**
     * Somebody who clicks twice is somebody who is not sure it worked, and
     * "something went wrong" is the last thing to show them.
     */
    const token = await linkFor("twice@example.test");
    const first = await unsubscribe.confirm(db(), { token });
    const second = await unsubscribe.confirm(db(), { token });
    expect(second.done).toBe(true);
    expect(second.message).toBe(first.message);

    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.suppression where organization_id = ${ORG}`;
    expect(n).toBe("1");
  });

  it("takes a second campaign's link for an address already suppressed", async () => {
    /**
     * The ordinary case rather than a race: a customer who unsubscribed from
     * March's campaign finds April's in a folder and presses it. Both live
     * suppression indexes are partial, so naming the columns alone in the
     * conflict target is a runtime error rather than a type error.
     */
    const first = await linkFor("again@example.test");
    const second = await linkFor("again@example.test");
    await unsubscribe.confirm(db(), { token: first });
    const page = await unsubscribe.confirm(db(), { token: second });
    expect(page.done).toBe(true);

    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.suppression
      where organization_id = ${ORG} and lifted_at is null`;
    expect(n).toBe("1");
  });

  it("says the same thing about a token that never existed as one that did", async () => {
    /**
     * Telling the difference would make this an oracle for whether a given
     * token is live, and the only party who benefits is somebody enumerating
     * them.
     */
    const nonsense = await unsubscribe.describe(db(), { token: "x".repeat(40) });
    expect(nonsense.known).toBe(false);
    expect(nonsense.address).toBeNull();
    expect(nonsense.company).toBeNull();

    const acted = await unsubscribe.confirm(db(), { token: "y".repeat(40) });
    expect(acted).toEqual(nonsense);
  });

  it("masks the address, because the link can be forwarded", async () => {
    /**
     * The holder already knows their own address. A forwarded link, a
     * screenshot or a support ticket reaches somebody who does not, and this
     * page is unauthenticated.
     */
    expect(unsubscribe.maskAddress("jennifer@example.test")).toBe("j*******@example.test");
    const token = await linkFor("jennifer@example.test");
    const page = await unsubscribe.describe(db(), { token });
    expect(page.address).toBe("j*******@example.test");
  });

  it("never expires", async () => {
    /**
     * `portal_grant.expires_at` is NOT NULL, which is why this does not reuse
     * it. "This link has expired" is the worst page to serve somebody trying
     * to stop hearing from a company: their next move is the complaint button,
     * which costs the sending domain more than ten unsubscribes and is
     * invisible to the company that caused it.
     */
    const token = await linkFor("ancient@example.test");
    await raw`update public.unsubscribe_link set created_at = now() - interval '4 years'
              where organization_id = ${ORG}`;
    const page = await unsubscribe.confirm(db(), { token });
    expect(page.done).toBe(true);
  });

  it("counts its opt outs against the campaign that caused them", async () => {
    await emailProvider();
    const who = await customer({ name: "Leaver", email: "leaver@example.test" });
    await completedJob(who, 10);
    await consentFor("leaver@example.test", { channel: "email", purpose: "marketing" });

    const created = await campaigns.create(owner(), {
      name: "April offer", channel: "email", subject: "April",
      audience: [{ kind: "served_at_least_once" }], body: "An offer.",
    });
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });

    const [link] = await raw<{ token_hash: string }[]>`
      select token_hash from public.unsubscribe_link where campaign_id = ${created.id}`;
    expect(link).toBeTruthy();

    const before = await campaigns.results(owner(), { id: created.id });
    expect(before.optOuts).toBe(0);

    await raw`update public.unsubscribe_link set used_at = now() where campaign_id = ${created.id}`;
    const after = await campaigns.results(owner(), { id: created.id });
    expect(after.optOuts).toBe(1);
  });
});

/* ======================================================== state and reads */

run("what a campaign may become", () => {
  beforeEach(async () => {
    await number("+15125559999", "main");
  });

  it("will not let a sent campaign be edited", async () => {
    /**
     * The body of a sent campaign is what is in four thousand inboxes, and a
     * record of it somebody can edit afterwards is not a record of anything.
     */
    const who = await customer({ name: "Sent", phone: "+15125550301" });
    await completedJob(who, 10);
    await consentFor("+15125550301", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });

    await expect(campaigns.update(owner(), { id: created.id, body: "Different" }))
      .rejects.toThrow(/already gone out/);
    await expect(campaigns.cancel(owner(), { id: created.id }))
      .rejects.toThrow(/already gone out/);
  });

  it("schedules on a date and unschedules when it is cleared", async () => {
    const created = await campaigns.create(owner(), sms());
    expect(created.state).toBe("draft");

    const scheduled = await campaigns.update(owner(), {
      id: created.id, scheduledFor: "2026-11-02T15:00:00.000Z",
    });
    expect(scheduled.state).toBe("scheduled");

    const back = await campaigns.update(owner(), { id: created.id, scheduledFor: null });
    expect(back.state).toBe("draft");
  });

  it("keeps what already went when a part sent campaign is cancelled", async () => {
    /**
     * A text handed to a carrier is gone. The rows that went stay `queued` so
     * the record says what actually happened rather than what somebody wished
     * had.
     */
    const carrier = await carrierCampaign(1, null);
    for (const suffix of ["311", "312"]) {
      const phone = `+1512555${suffix}0`;
      const who = await customer({ name: `P${suffix}`, phone });
      await completedJob(who, 10);
      await consentFor(phone, { channel: "sms", purpose: "marketing" });
    }

    const created = await campaigns.create(owner(), sms({ messagingCampaignId: carrier }));
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    const cancelled = await campaigns.cancel(owner(), { id: created.id, reason: "Wrong list" });

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.cancellationReason).toBe("Wrong list");
    expect(cancelled.result.queued).toBe(1);
    await expect(campaigns.send(owner(), { id: created.id, at: DAYTIME })).rejects.toThrow(/was cancelled/);
  });

  it("deletes a draft and refuses one that has recipients", async () => {
    const draft = await campaigns.create(owner(), sms({ name: "Abandoned" }));
    const gone = await campaigns.remove(owner(), { id: draft.id });
    expect(gone.deleted).toBe(true);
    await expect(campaigns.get(owner(), { id: draft.id })).rejects.toThrow(NotFoundError);

    /** And the name is reusable, which is what the partial index is for. */
    const reused = await campaigns.create(owner(), sms({ name: "Abandoned" }));
    expect(reused.utmCampaign).toBe("abandoned");

    const who = await customer({ name: "Got one", phone: "+15125550321" });
    await completedJob(who, 10);
    await campaigns.send(owner(), { id: reused.id, at: DAYTIME });
    await expect(campaigns.remove(owner(), { id: reused.id })).rejects.toThrow(/is sent/);

    /**
     * AND THE SECOND CHECK ON ITS OWN. The state check above is enough today,
     * because recipients are written only by `send` and `send` leaves the
     * campaign sending or sent. Forcing the state back to draft is the only way
     * to reach the recipient count check, and reaching it is the point: a
     * campaign with recipients is a record of what a company sent to real
     * people, and no path should be able to remove it because a state column
     * said draft.
     */
    await raw`update public.marketing_campaign set state = 'draft', finished_at = null
              where id = ${reused.id}`;
    await expect(campaigns.remove(owner(), { id: reused.id })).rejects.toThrow(/Cancel it/);
  });

  it("derives the counts rather than storing them", async () => {
    /**
     * A stored total is a number somebody can edit into agreement with what
     * they hoped for, and this is the total an owner is judging a spend
     * against. The assertion is that the columns do not exist: a tally the
     * database holds is a tally that can disagree with the rows.
     */
    const columns = await raw<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'marketing_campaign'`;
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain("sent_count");
    expect(names).not.toContain("queued_count");
    expect(names).not.toContain("skipped_count");
  });

  it("credits the work a campaign brought in through job.campaign_id", async () => {
    /**
     * That column has been on the job table since the first migration, and
     * for a long time this test set it with raw SQL because no product code
     * wrote it, so the results report read zero for every campaign anybody
     * ran. `marketing.creditWork` writes it now, from the credited touch's
     * utm tag, on every path that creates work; this books the job through
     * `jobs.create` like a CSR would and lets that happen.
     *
     * Revenue is the ledger's, the one definition every marketing figure
     * shares, so the job's revenue is posted as an invoice would post it.
     *
     * NO CONVERSION RATE COMES BACK, deliberately, and it is the one number
     * every tool in this category prints. Jobs divided by recipients is a
     * figure whose numerator is attributed under whichever model the reader has
     * not chosen; quoting one here would make this answer differ from the
     * attribution report's answer for the same campaign.
     */
    const who = await customer({ name: "Booked", phone: "+15125550331" });
    await completedJob(who, 10);
    await consentFor("+15125550331", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms());
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });

    /** They clicked the link in the text, which carried the campaign's own tag. */
    await inTenant(owner(), (tx) => marketing.recordTouch(tx, ORG, {
      customerId: who,
      query: `utm_source=newsletter&utm_medium=sms&utm_campaign=${created.utmCampaign}`,
    }));
    const propertyId = await property(who, "78703");
    const job = await jobs.create(owner(), {
      customerId: who, propertyId, summary: "Tune up from the text", tags: [], customFields: {},
    });
    const [written] = await raw<{ campaign_id: string | null }[]>`
      select campaign_id from public.job where id = ${job.id}`;
    expect(written!.campaign_id).toBe(created.id);
    await raw`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction,
                                       account_code, currency, amount, source_type, source_id, job_id)
      select ${ORG}, t.id, now(), d.direction, d.code, 'USD', '1250.0000', 'manual', t.id, ${job.id}
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, '1100'), ('credit'::ledger_direction, '4000'))
             as d(direction, code)`;

    const results = await campaigns.results(owner(), { id: created.id });
    expect(results.jobs).toBe(1);
    expect(results.revenue).toBe("1250.0000");
    expect(results.reachRate).toBe("100.0");
    expect(results).not.toHaveProperty("conversionRate");
  });

  it("keeps the work when the campaign that brought it is deleted", async () => {
    /**
     * ON DELETE SET NULL rather than CASCADE. Deleting a campaign must never
     * delete the jobs it brought in, and that constraint is added in
     * `after.sql` because declaring it in the drizzle schema would make
     * `work.ts` and `marketing.ts` import each other.
     */
    const draft = await campaigns.create(owner(), sms({ name: "Doomed" }));
    const who = await customer({ name: "Kept", phone: "+15125550341" });
    const booked = await completedJob(who, 1, "900.0000");
    await raw`update public.job set campaign_id = ${draft.id} where id = ${booked}`;

    await raw`delete from public.marketing_campaign where id = ${draft.id}`;

    const [job] = await raw<{ campaign_id: string | null; total: string }[]>`
      select campaign_id, total from public.job where id = ${booked}`;
    expect(job!.campaign_id).toBeNull();
    expect(job!.total).toBe("900.0000");
  });
});

/* ========================================================== who may do it */

run("who may run a campaign", () => {
  it("tells reading a campaign apart from writing one", async () => {
    /**
     * Both halves with an explicit grant and NO ROLE. The owner holds both, so
     * a refusal written against the owner proves only that the owner is an
     * owner, and `office_manager` and `marketing_manager` hold combinations
     * that would make one of these pass for the wrong reason.
     */
    const created = await campaigns.create(granted("campaign:write"), sms());
    expect(created.id).toBeTruthy();

    await expect(campaigns.create(granted("campaign:read"), sms()))
      .rejects.toThrow(/permission/);
    await expect(campaigns.get(granted("campaign:write"), { id: created.id }))
      .rejects.toThrow(/permission/);
    expect((await campaigns.get(granted("campaign:read"), { id: created.id })).id)
      .toBe(created.id);
  });

  it("will not let one company see or send another's campaign", async () => {
    /**
     * Row level security rather than an `organization_id` clause in the
     * service, which is why this test matters: the service's reads DO carry
     * the clause, so a test that passed through it would not distinguish the
     * two. `loadWithin` not finding the row is the clause; RLS is what makes
     * the raw query below return nothing.
     */
    const mine = await campaigns.create(owner(), sms());
    await expect(campaigns.get(other(), { id: mine.id })).rejects.toThrow(NotFoundError);
    await expect(campaigns.send(other(), { id: mine.id, at: DAYTIME })).rejects.toThrow(NotFoundError);
    const theirs = await campaigns.list(other(), { limit: 50 });
    expect(theirs.data).toEqual([]);
  });

  it("refuses a carrier registration belonging to nobody", async () => {
    await expect(campaigns.create(owner(), sms({ messagingCampaignId: fixtureId("cmp:ghost") })))
      .rejects.toThrow(NotFoundError);
  });
});

/* ================================================ merge fields and the clock */

run("a campaign that calls people by name", () => {
  const PERSONAL = "Hi {{ customer.firstName }}, {{ company.name }} here: $89 tune ups this month. Reply STOP to opt out.";

  it("previews the message as the first person on the list will read it", async () => {
    await number("+15125550950", "sending");
    const who = await customer({ name: "Maria Lopez", phone: "+15125550951" });
    await completedJob(who, 10);

    const created = await campaigns.create(owner(), sms({ body: PERSONAL }));
    const preview = await campaigns.preview(owner(), { id: created.id });
    expect(preview.rendered).toEqual({
      for: "Maria Lopez",
      body: "Hi Maria, Comfort Co here: $89 tune ups this month. Reply STOP to opt out.",
      subject: null,
    });

    /** And before it is saved, from the words on the form. */
    const trying = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "served_at_least_once" }], body: "Thanks {{ customer.name }}",
    });
    expect(trying.rendered?.body).toBe("Thanks Maria Lopez");
  });

  it("sends each person their own words", async () => {
    await number("+15125550952", "sending");
    const who = await customer({ name: "Maria Lopez", phone: "+15125550953" });
    await completedJob(who, 10);
    await consentFor("+15125550953", { channel: "sms", purpose: "marketing" });

    const created = await campaigns.create(owner(), sms({ body: PERSONAL }));
    await campaigns.send(owner(), { id: created.id, at: DAYTIME });
    const [sent] = await raw<{ body: string }[]>`
      select m.body from public.message m
      join public.campaign_recipient r on r.message_id = m.id
      where r.campaign_id = ${created.id}`;
    expect(sent!.body).toBe("Hi Maria, Comfort Co here: $89 tune ups this month. Reply STOP to opt out.");
  });

  it("refuses a field it cannot fill, which would otherwise go out as a gap", async () => {
    await expect(campaigns.create(owner(), sms({ body: "Hi {{ custmer.firstName }}" })))
      .rejects.toThrow(/not something a campaign can fill in/);
  });

  it("starts from a message template, and refuses one written for something else", async () => {
    await messageTemplates.define(owner(), {
      code: "spring.offer", name: "Spring offer", channel: "sms", purpose: "marketing", body: PERSONAL,
    });
    const created = await campaigns.create(owner(), sms({ body: undefined, templateCode: "spring.offer" }));
    expect(created.body).toBe(PERSONAL);

    await messageTemplates.define(owner(), {
      code: "arrival", name: "On the way", channel: "sms", body: "Your window is {{ visit.window }}",
    });
    await expect(campaigns.create(owner(), sms({ body: undefined, templateCode: "arrival" })))
      .rejects.toThrow(/not something a campaign can fill in/);
  });
});

run("the clock", () => {
  /**
   * `scheduled_for` was stored and fired by nothing, so a staged send was one
   * press per batch. These run the worker's own function, against the real
   * clock for "is it due" (the database decides that) and a chosen one for
   * quiet hours and the cap.
   */
  const mine = (results: campaigns.DueResult[], id: string) => results.filter((r) => r.campaignId === id);

  it("fires a scheduled campaign once it is due, as its author, and only once", async () => {
    await number("+15125550960", "sending");
    for (const [i, phone] of ["+15125550961", "+15125550962"].entries()) {
      const who = await customer({ name: `Due ${i}`, phone });
      await completedJob(who, 10);
      await consentFor(phone, { channel: "sms", purpose: "marketing" });
    }
    const created = await campaigns.create(owner(), sms());
    await campaigns.update(owner(), {
      id: created.id, scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(mine(await campaigns.sendDue(db(), { now: new Date(DAYTIME) }), created.id)).toEqual([]);

    await campaigns.update(owner(), { id: created.id, scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    const fired = mine(await campaigns.sendDue(db(), { now: new Date(DAYTIME) }), created.id);
    expect(fired).toEqual([expect.objectContaining({ action: "sent", queued: 2, remaining: 0 })]);

    /** Sent is sent: the next pass finds nothing due and writes nothing twice. */
    expect(mine(await campaigns.sendDue(db(), { now: new Date(DAYTIME) }), created.id)).toEqual([]);
    const [count] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.campaign_recipient where campaign_id = ${created.id}`;
    expect(count!.n).toBe(2);
  });

  it("waits through quiet hours rather than skipping everybody for good", async () => {
    await number("+15125550970", "sending");
    const who = await customer({ name: "Night", phone: "+15125550971" });
    await completedJob(who, 10);
    await consentFor("+15125550971", { channel: "sms", purpose: "marketing" });
    const created = await campaigns.create(owner(), sms());
    await campaigns.update(owner(), { id: created.id, scheduledFor: new Date(Date.now() - 60_000).toISOString() });

    expect(mine(await campaigns.sendDue(db(), { now: new Date(NIGHT) }), created.id))
      .toEqual([expect.objectContaining({ action: "waiting", reason: "quiet_hours" })]);
    const [none] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.campaign_recipient where campaign_id = ${created.id}`;
    expect(none!.n).toBe(0);

    expect(mine(await campaigns.sendDue(db(), { now: new Date(DAYTIME) }), created.id))
      .toEqual([expect.objectContaining({ action: "sent", queued: 1 })]);
  });

  it("takes one day of the carrier's cap and comes back for the rest", async () => {
    await number("+15125550980", "sending");
    const carrier = await carrierCampaign(1, null);
    for (const [i, phone] of ["+15125550981", "+15125550982"].entries()) {
      const who = await customer({ name: `Capped ${i}`, phone });
      await completedJob(who, 10);
      await consentFor(phone, { channel: "sms", purpose: "marketing" });
    }
    const created = await campaigns.create(owner(), sms({ messagingCampaignId: carrier }));
    await campaigns.update(owner(), { id: created.id, scheduledFor: new Date(Date.now() - 60_000).toISOString() });

    expect(mine(await campaigns.sendDue(db(), { now: new Date(DAYTIME) }), created.id))
      .toEqual([expect.objectContaining({ action: "sent", queued: 1, remaining: 1 })]);
    /** Still sending, and the same day's cap is spent. */
    expect(mine(await campaigns.sendDue(db(), { now: new Date(DAYTIME) }), created.id))
      .toEqual([expect.objectContaining({ action: "waiting", reason: "daily_cap" })]);
    const tomorrow = new Date(Date.parse(DAYTIME) + 86_400_000);
    expect(mine(await campaigns.sendDue(db(), { now: tomorrow }), created.id))
      .toEqual([expect.objectContaining({ action: "sent", queued: 2, remaining: 0 })]);
  });
});

/* ============================================================== the pacing */

describe("pacing, as arithmetic", () => {
  it("treats an absent cap and a cap of zero as different things", () => {
    expect(cp.pace(100, {})).toEqual({
      firstBatch: 100, days: 1, secondsBetween: null, staged: false,
    });
    expect(cp.pace(100, { dailyCap: 0 })).toEqual({
      firstBatch: 0, days: 0, secondsBetween: null, staged: true,
    });
  });

  it("rounds the days up, because a partial day is still a day", () => {
    expect(cp.pace(2001, { dailyCap: 1000 }).days).toBe(3);
  });

  it("says nothing about seconds when nothing was declared", () => {
    expect(cp.pace(10, { dailyCap: 5 }).secondsBetween).toBeNull();
    expect(cp.pace(10, { perSecond: 4 }).secondsBetween).toBe(0.25);
  });

  it("has no send to pace when there is nobody in it", () => {
    expect(cp.pace(0, {})).toEqual({
      firstBatch: 0, days: 0, secondsBetween: null, staged: false,
    });
  });
});

describe("a campaign in words", () => {
  it("refuses to describe an empty audience as anything but what it is", () => {
    expect(cp.describeAudience([])).toBe("Everybody, which this will not do.");
  });

  it("reads back as a sentence somebody can check against what they meant", () => {
    /**
     * The difference between two years and two months is a factor of twelve in
     * the size of the send and the bill, and it is one character in a form.
     */
    expect(cp.describeAudience([
      { kind: "no_job_since", days: 730 },
      { kind: "no_agreement" },
    ])).toBe("Customers who were last served more than 730 days ago and have never held an agreement.");
  });

  it("gets the singular right, because 1 days reads as a bug", () => {
    expect(cp.describeRule({ kind: "agreement_ending_within", days: 1 }))
      .toBe("hold an agreement ending within 1 day");
  });
});

describe("the refusals a campaign can hit", () => {
  it("has a sentence for every state a campaign cannot leave", () => {
    for (const state of cp.CAMPAIGN_STATES) {
      const message = cp.transitionRefusal(state, "sending");
      expect(message.length).toBeGreaterThan(20);
    }
  });

  it("lets a staged send continue, which is a transition to its own state", () => {
    expect(cp.canTransition("sending", "sending")).toBe(true);
    expect(cp.canTransition("sent", "sending")).toBe(false);
    expect(cp.canTransition("cancelled", "draft")).toBe(false);
  });
});

describe("the reach rate", () => {
  it("is null rather than zero when nobody was selected", () => {
    /**
     * Zero per cent reached says the consent collection failed. Nothing to
     * reach says the rules matched nobody, which is a different problem with a
     * different fix.
     */
    expect(cp.reachRate({ selected: 0, queued: 0, skipped: 0, skippedBy: {} })).toBeNull();
    expect(cp.reachRate({ selected: 8, queued: 6, skipped: 2, skippedBy: {} })).toBe("75.0");
  });
});

/** Keeps the ConflictError import honest. */
describe("refusal types", () => {
  it("uses ConflictError for a refusal about content rather than a missing row", async () => {
    expect(new ConflictError("x")).toBeInstanceOf(Error);
  });
});
