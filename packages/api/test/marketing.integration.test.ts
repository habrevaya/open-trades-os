import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as marketing from "../src/services/marketing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { inTenant, ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * ATTRIBUTION, WHICH WAS IMPOSSIBLE BECAUSE ONE LINE THREW IT AWAY
 *
 * `packages/core/src/marketing` is eighteen hundred lines that knew how to
 * parse a touch, credit it under five named models, validate a lead form and
 * summarise spend against results. One function was reached in production:
 * `booking.sourceOf` called `parseTouch`, took `.source` off the result and
 * discarded the rest.
 *
 * Attribution is a property of a SEQUENCE. The product was keeping one word
 * per lead, so `attribute`, `creditRevenue` and `compareModels` had no
 * possible caller and `summariseSpend` had no input at all.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("marketing:org");
const USER = fixtureId("marketing:user");

let raw: postgres.Sql;
let customerId = "";
let propertyId = "";

const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const touch = (input: Parameters<typeof marketing.recordTouch>[2]) =>
  inTenant(owner(), (tx) => marketing.recordTouch(tx, ORG, input));

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Reach Co", slug: "reach-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Marketing Customer", phone: "+15125550144",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "7 Reach Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.marketing_touch where organization_id = ${ORG}`;
  await raw`delete from public.ad_spend where organization_id = ${ORG}`;
  await raw`delete from public.phone_number where organization_id = ${ORG}`;
});

run("a touch is kept whole", () => {
  it("keeps the click id, which the utm bag loses", async () => {
    /**
     * `gclid` is not a utm_ key. A widget that stored only utm_ keys lost
     * it, and the click id is the one value an ads platform will match a
     * conversion back to: without it a booked job can never be reported to
     * the account that bought it.
     */
    const result = await touch({
      query: "?utm_source=google&utm_medium=cpc&utm_campaign=ac-repair&gclid=EAIaIQobCh",
      landingPath: "/ac-repair",
    });

    expect(result.touch.source).toBe("google_ads");
    expect(result.touch.clickId).toBe("EAIaIQobCh");

    const [row] = await raw<{ click_id: string; utm_campaign: string; basis: string }[]>`
      select click_id, utm_campaign, basis from public.marketing_touch where id = ${result.id}`;
    expect(row!.click_id).toBe("EAIaIQobCh");
    expect(row!.utm_campaign).toBe("ac-repair");
    expect(row!.basis).toBe("utm");
  });

  it("records how it decided, not only what it decided", async () => {
    const tagged = await touch({ query: "?utm_source=facebook&utm_medium=paid_social" });
    const inferred = await touch({ referrer: "https://www.yelp.com/biz/someone" });

    /**
     * A report that cannot separate "they tagged it" from "we inferred it
     * from the referring host" cannot say how much of its attribution is
     * evidence. Most of it is not.
     */
    expect(tagged.touch.basis).toBe("utm");
    expect(inferred.touch.basis).toBe("referrer");
  });

  it("keeps what it could not place, because that is the worklist", async () => {
    await touch({ query: "?utm_source=spring-postcard-v2&utm_medium=mail" });
    await touch({ query: "?utm_source=spring-postcard-v2&utm_medium=mail" });
    await touch({ query: "?utm_source=chamber-newsletter&utm_medium=email" });

    const work = await marketing.unplaced(owner());
    expect(work.map((w) => w.wrote)).toContain("spring-postcard-v2");
    /** Grouped and counted, so the biggest gap is at the top. */
    expect(work.find((w) => w.wrote === "spring-postcard-v2")?.touches).toBe(2);
  });

  it("does not turn an untagged source into direct", async () => {
    /**
     * The difference between "we have a gap in our alias list" and "they came
     * straight to us". Collapsing them makes a data problem look like brand
     * strength.
     */
    const result = await touch({ query: "?utm_source=spring-postcard-v2" });
    expect(result.touch.source).toBe("unknown");
    expect(result.touch.source).not.toBe("direct");
  });

  it("a tracked number is a touch, which is how a yard sign gets measured", async () => {
    await raw`insert into public.phone_number
      (organization_id, e164, purpose, attribution_source)
      values (${ORG}, '+15125559001', 'tracking', 'direct_mail')`;

    const result = await touch({ trackedNumber: "+15125559001" });
    expect(result.touch.source).toBe("direct_mail");
    expect(result.touch.basis).toBe("tracked_number");
  });

  it("an untagged tracking number stays unknown rather than defaulting", async () => {
    await raw`insert into public.phone_number
      (organization_id, e164, purpose) values (${ORG}, '+15125559002', 'tracking')`;

    const result = await touch({ trackedNumber: "+15125559002" });
    /** A measurement nobody set up, not a channel. */
    expect(result.touch.source).toBe("unknown");
  });

  it("a number tagged with a source outside the catalogue is also unknown", async () => {
    /**
     * The other half of the same guard, and the half the null case never
     * reaches. `attribution_source` is free text, so somebody typing
     * "spring mailer" into it would otherwise put a value through to core
     * that no report can group, and core would take it at face value.
     */
    await raw`insert into public.phone_number
      (organization_id, e164, purpose, attribution_source)
      values (${ORG}, '+15125559003', 'tracking', 'spring mailer')`;

    const result = await touch({ trackedNumber: "+15125559003" });
    expect(result.touch.source).toBe("unknown");
  });
});

run("an anonymous history becomes somebody's", () => {
  it("stitches every earlier touch onto the customer at once", async () => {
    await touch({ visitorId: "v-1", at: at(30), query: "?utm_source=google&utm_medium=organic" });
    await touch({ visitorId: "v-1", at: at(10), query: "?utm_source=facebook&utm_medium=paid_social" });
    await touch({ visitorId: "v-1", at: at(1), query: "?utm_source=google&utm_medium=cpc" });

    const { stitched } = await inTenant(owner(), (tx) =>
      marketing.identify(tx, ORG, { visitorId: "v-1", customerId }));
    expect(stitched).toBe(3);

    const history = await marketing.touchesFor(owner(), { customerId });
    expect(history).toHaveLength(3);
    /** Oldest first, because first touch and last touch both depend on it. */
    expect(history[0]!.medium).toBe("organic");
    expect(history[2]!.medium).toBe("cpc");
  });

  it("leaves touches already belonging to somebody else alone", async () => {
    /**
     * A shared device in a household is real. Moving another person's
     * history onto this customer would be worse than leaving it split.
     */
    const other = await customers.create(owner(), {
      type: "residential", name: "Housemate", phone: "+15125550155",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    await touch({ visitorId: "v-shared", customerId: other.id, query: "?utm_source=bing&utm_medium=cpc" });
    await touch({ visitorId: "v-shared", query: "?utm_source=google&utm_medium=cpc" });

    const { stitched } = await inTenant(owner(), (tx) =>
      marketing.identify(tx, ORG, { visitorId: "v-shared", customerId }));
    expect(stitched).toBe(1);

    const theirs = await marketing.touchesFor(owner(), { customerId: other.id });
    expect(theirs).toHaveLength(1);
  });

  it("refuses to list every touch in the company", async () => {
    await expect(marketing.touchesFor(owner(), {})).rejects.toThrow(ConflictError);
  });
});

run("who gets the credit", () => {
  const aJob = async () => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Attributed job", tags: [], customFields: {},
    });
    return job.id;
  };

  it("reports every model, and says when they disagree", async () => {
    await touch({ visitorId: "v-2", at: at(30), query: "?utm_source=google&utm_medium=organic" });
    await touch({ visitorId: "v-2", at: at(2), query: "?utm_source=google&utm_medium=cpc" });
    await inTenant(owner(), (tx) => marketing.identify(tx, ORG, { visitorId: "v-2", customerId }));

    const jobId = await aJob();
    const result = await marketing.attributeJob(owner(), { jobId });

    expect(result.touchCount).toBe(2);
    expect(result.models).toHaveLength(5);

    const first = result.models.find((m) => m.model === "first_touch")!;
    const last = result.models.find((m) => m.model === "last_touch")!;
    if (!first.attributed || !last.attributed) throw new Error("both were attributed");
    expect(first.primary).toBe("organic_search");
    expect(last.primary).toBe("google_ads");

    /**
     * The disagreement IS the finding. Somebody reading only last touch is
     * about to conclude the ad won this job and cut the content that
     * started it.
     */
    expect(result.agree).toBe(false);
  });

  it("carries what each model is wrong about, beside its answer", async () => {
    await touch({ visitorId: "v-3", customerId, query: "?utm_source=google&utm_medium=cpc" });
    const jobId = await aJob();

    const result = await marketing.attributeJob(owner(), { jobId });
    for (const model of result.models) {
      /**
       * Not a tooltip somebody can skip. A figure presented without its
       * caveat is the thing that moves a budget onto the wrong channel.
       */
      expect(model.wrongAbout.length, model.model).toBeGreaterThan(40);
    }
  });

  it("says a job was not attributed rather than calling it direct", async () => {
    const jobId = await aJob();
    const result = await marketing.attributeJob(owner(), { jobId });

    expect(result.touchCount).toBe(0);
    for (const model of result.models) {
      if (model.attributed) throw new Error(`${model.model} attributed a job with no touches`);
      /**
       * Every instinct in a reporting system is to give this to `direct`,
       * because it makes the pie chart add up. The cost is specific:
       * `direct` becomes the largest source in the business and the channel
       * booking the work gets cut.
       */
      expect(model.detail).toContain("direct");
    }
  });

  it("splits an even model across every source that touched it", async () => {
    await touch({ visitorId: "v-4", at: at(20), query: "?utm_source=google&utm_medium=cpc" });
    await touch({ visitorId: "v-4", at: at(10), query: "?utm_source=facebook&utm_medium=paid_social" });
    await inTenant(owner(), (tx) => marketing.identify(tx, ORG, { visitorId: "v-4", customerId }));
    const jobId = await aJob();

    const result = await marketing.attributeJob(owner(), { jobId });
    const linear = result.models.find((m) => m.model === "linear")!;
    if (!linear.attributed) throw new Error("two touches were recorded");
    expect(linear.credits.map((c) => c.source).sort()).toEqual(["google_ads", "meta_ads"]);
    expect(linear.credits.every((c) => c.parts === linear.credits[0]!.parts)).toBe(true);
  });

  it("refuses a job from another company", async () => {
    const jobId = await aJob();
    const stranger: ServiceContext = {
      actor: { userId: USER, organizationId: fixtureId("marketing:other"), roles: ["owner"] as Actor["roles"] },
      db: db(),
    };
    await expect(marketing.attributeJob(stranger, { jobId })).rejects.toThrow(NotFoundError);
  });
});

run("what it cost and what came back", () => {
  it("refuses spend under a source no report can group", async () => {
    await expect(marketing.recordSpend(owner(), {
      source: "spring-postcards", spentOn: "2026-03-01", amount: "400.00",
    })).rejects.toThrow(/not a lead source/);
  });

  it("refuses negative spend", async () => {
    await expect(marketing.recordSpend(owner(), {
      source: "google_ads", spentOn: "2026-03-01", amount: "-50.00",
    })).rejects.toThrow(ConflictError);
  });

  it("re-running an import updates rather than doubling the month", async () => {
    const rows = [
      { source: "google_ads", campaign: "ac-repair", spentOn: "2026-03-01", amount: "120.00" },
      { source: "google_ads", campaign: "ac-repair", spentOn: "2026-03-02", amount: "140.00" },
    ];
    await marketing.importSpend(owner(), { origin: "google_ads_csv", rows });
    const second = await marketing.importSpend(owner(), { origin: "google_ads_csv", rows });

    expect(second.accepted).toBe(2);
    const [count] = await raw<{ n: string; total: string }[]>`
      select count(*) as n, sum(amount) as total from public.ad_spend where organization_id = ${ORG}`;
    expect(Number(count!.n)).toBe(2);
    expect(Number(count!.total)).toBe(260);
  });

  it("loads the good rows and names the bad ones", async () => {
    /**
     * A three hundred row export with two unrecognised campaign names should
     * load two hundred and ninety eight. A monthly import that fails
     * wholesale is a monthly import somebody stops doing.
     */
    const result = await marketing.importSpend(owner(), {
      origin: "mixed",
      rows: [
        { source: "google_ads", spentOn: "2026-03-01", amount: "100.00" },
        { source: "not-a-source", spentOn: "2026-03-01", amount: "50.00" },
        { source: "meta_ads", spentOn: "2026-03-01", amount: "nonsense" },
        { source: "meta_ads", spentOn: "2026-03-02", amount: "75.00" },
      ],
    });

    expect(result.accepted).toBe(2);
    expect(result.refused).toHaveLength(2);
    expect(result.refused[0]!.row).toBe(2);
    expect(result.refused[1]!.reason).toContain("nonsense");
  });

  it("keeps a typed figure and an imported one apart", async () => {
    /**
     * An import that overwrote a manual entry would delete the only record
     * of offline spend somebody keyed in; one that added to it would double
     * the month. They coexist and are told apart by origin.
     */
    await marketing.recordSpend(owner(), {
      source: "google_ads", spentOn: "2026-03-01", amount: "100.00",
    });
    await marketing.importSpend(owner(), {
      origin: "google_ads_csv",
      rows: [{ source: "google_ads", spentOn: "2026-03-01", amount: "98.42" }],
    });

    const rows = await raw<{ origin: string; amount: string }[]>`
      select origin, amount from public.ad_spend where organization_id = ${ORG} order by origin`;
    expect(rows.map((r) => r.origin)).toEqual(["google_ads_csv", "manual"]);
  });

  it("counts leads by person, not by touch", async () => {
    /**
     * A retargeting campaign that reached one homeowner eleven times is one
     * lead. Counting touches is the most flattering error available to an ad
     * platform and the one it makes by default.
     */
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 5; i += 1) {
      await touch({ customerId, query: "?utm_source=facebook&utm_medium=paid_social" });
    }
    await marketing.recordSpend(owner(), { source: "meta_ads", spentOn: today, amount: "200.00" });

    const result = await marketing.performance(owner(), { from: today, to: today });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const facebook = result.summary.rows.find((r) => r.source === "meta_ads")!;
    expect(facebook.leads).toBe(1);
  });

  it("names spend that booked nothing", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await marketing.recordSpend(owner(), { source: "google_ads", spentOn: today, amount: "900.00" });

    const result = await marketing.performance(owner(), { from: today, to: today });
    if (!result.ok) throw new Error("unreachable");

    expect(result.summary.wastedSources).toContain("google_ads");
    /** Null, never zero: zero sorts the worst line to the top of "cheapest". */
    const google = result.summary.rows.find((r) => r.source === "google_ads")!;
    expect(google.costPerLead).toBeNull();
    expect(google.verdict.kind).toBe("spend_no_leads");
  });

  it("refuses an empty period instead of reporting zeroes", async () => {
    /**
     * "No spend and no results" is not the same as a period of zeroes, and a
     * screen showing zeroes would say a channel wasted nothing when nobody
     * had told the product anything at all.
     */
    const result = await marketing.performance(owner(), { from: "2019-01-01", to: "2019-01-31" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("nothing_to_report");
  });
});

run("the paths that record a touch without being asked", () => {
  it("a booking keeps the whole touch, not one word", async () => {
    const booking = await import("../src/services/booking");
    const [org] = await raw<{ slug: string }[]>`
      select slug from public.organization where id = ${ORG}`;

    const [jobType] = await raw<{ id: string }[]>`insert into public.job_type
      (organization_id, name, capacity_model)
      values (${ORG}, 'AC tune up', 'technician_dispatch') returning id`;

    const service = await booking.createService(owner(), {
      jobTypeId: jobType!.id,
      publicName: "AC tune up",
      publicDescription: "A full seasonal service on one system.",
      displayPrice: "149.00",
      minNoticeHours: 1, maxAdvanceDays: 30, maxPerWindow: 4,
    });
    await booking.setWindows(owner(), {
      windows: [{
        name: "Morning", startsAt: "08:00", endsAt: "12:00",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      }],
    });
    const [window] = await raw<{ id: string }[]>`
      select id from public.arrival_window where organization_id = ${ORG} limit 1`;

    const created = await booking.createRequest(db(), {
      organizationSlug: org!.slug,
      bookableServiceId: service.id,
      contactName: "Dana Reyes",
      contactPhone: "+15125550133",
      addressLine1: "11 Touch Ln",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      requestedDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      arrivalWindowId: window!.id,
      utm: { utm_source: "google", utm_medium: "cpc" },
      /**
       * The raw query, carrying the click id. The utm bag alone cannot: a
       * gclid is not a utm_ key, and it is the only value an ads platform
       * will match a conversion back to.
       */
      landingQuery: "?utm_source=google&utm_medium=cpc&gclid=Cj0KCQjw",
      visitorId: "v-booking",
      intakeAnswers: {},
    });
    expect(created.request.id).toBeTruthy();

    const touches = await marketing.touchesFor(owner(), { visitorId: "v-booking" });
    expect(touches).toHaveLength(1);
    expect(touches[0]!.source).toBe("google_ads");
    expect(touches[0]!.clickId, "the click id survived the round trip").toBe("Cj0KCQjw");
  });

  it("an inbound call on a tracked number is a touch", async () => {
    const telephony = await import("../src/services/telephony");
    await raw`insert into public.phone_number
      (organization_id, e164, purpose, attribution_source)
      values (${ORG}, '+15125559010', 'tracking', 'yard_sign')`;

    await telephony.logCall(owner(), {
      direction: "inbound",
      fromE164: "+15125550199",
      toE164: "+15125559010",
      receivedOnE164: "+15125559010",
      status: "completed",
      customerId,
    });

    const touches = await marketing.touchesFor(owner(), { customerId });
    /**
     * The only way anything physical is ever measured. A yard sign carries
     * no query string and sets no referrer; the number is the tag.
     */
    expect(touches.some((t) => t.source === "yard_sign")).toBe(true);
    expect(touches.find((t) => t.source === "yard_sign")?.basis).toBe("tracked_number");
  });

  it("an outbound call is not a marketing touch", async () => {
    const telephony = await import("../src/services/telephony");
    await raw`insert into public.phone_number
      (organization_id, e164, purpose, attribution_source)
      values (${ORG}, '+15125559011', 'tracking', 'radio')`;

    await telephony.logCall(owner(), {
      direction: "outbound",
      fromE164: "+15125559011",
      toE164: "+15125550199",
      receivedOnE164: "+15125559011",
      status: "completed",
      customerId,
    });

    /**
     * The company ringing the customer is not the customer arriving.
     * Counting it would credit whatever channel the office happened to dial
     * out from.
     */
    const touches = await marketing.touchesFor(owner(), { customerId });
    expect(touches.filter((t) => t.source === "radio")).toEqual([]);
  });
});
