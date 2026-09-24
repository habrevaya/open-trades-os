import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { reviews as rv } from "@opentradesos/core";
import * as reviews from "../src/services/reviews";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * REVIEWS, AND THE FEATURE THIS MUST NEVER GROW
 *
 * Twelve hundred lines of core knew when to ask, who to ring instead, what a
 * rating actually is, and which reply is owed by when. None of it had a
 * table or a caller.
 *
 * The thing every product in this space builds, and this one refuses, is
 * asking only the customers you think will say something nice. That is
 * review gating; every major platform prohibits it and it is what gets a
 * listing's reviews wiped. It is also trivially easy to build by accident:
 * one predicted rating column and a `where predicted >= 4`.
 *
 * The defence is that there is nowhere to put the number.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("reviews:org");
const USER = fixtureId("reviews:user");

let raw: postgres.Sql;
let customerId = "";
let propertyId = "";
let technicianId = "";

const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const setPolicy = (over: Partial<Parameters<typeof reviews.setPolicy>[1]> = {}) =>
  reviews.setPolicy(owner(), {
    timeZone: "America/Chicago",
    delayMinutes: 120,
    customerCooldownDays: 90,
    requirePaid: true,
    maxJobAgeDays: 14,
    earliestHour: 9,
    latestHour: 19,
    ...over,
  });

const declareGoogle = (prohibits: string[] = ["incentives", "bulk_requests", "templated_replies"]) =>
  reviews.setPlatform(owner(), {
    platform: "google",
    displayName: "Google Business Profile",
    prohibits,
    note: "Read their prohibited content policy in March 2026.",
  });

/** A finished, paid job with the technician's departure recorded. */
async function aFinishedJob(over: { paid?: boolean; leftAt?: Date } = {}) {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Finished work", tags: [], customFields: {},
  });
  const visit = await jobs.addVisit(owner(), {
    id: job.id,
    windowStart: new Date(Date.now() - 4 * 3600_000).toISOString(),
    windowEnd: new Date(Date.now() - 2 * 3600_000).toISOString(),
    estimatedDurationMinutes: 60,
    technicianIds: [],
  });
  await jobs.complete(owner(), { id: visit.id });

  const leftAt = over.leftAt ?? new Date(Date.now() - 3 * 3600_000);
  await raw`update public.visit set completed_at = ${leftAt} where id = ${visit.id}`;

  const invoice = await billing.create(owner(), {
    customerId, jobId: job.id,
    lines: [{
      name: "Labour, 4 hours", quantity: "1", unitPrice: "300.00",
      discountAmount: "0", taxable: false,
    }],
  });
  if (over.paid !== false) {
    await billing.pay(owner(), {
      customerId, method: "check", amount: invoice.total, tipAmount: "0",
      allocations: [{ invoiceId: invoice.id, amount: invoice.total }],
    });
  }
  return job.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Rep Co", slug: "rep-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Review Customer", phone: "+15125550111",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "5 Star St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  propertyId = property.id;

  const [membership] = await raw<{ id: string }[]>`select id from public.membership
    where organization_id = ${ORG} and user_id = ${USER}`;
  const [tech] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Rosa Delgado') returning id`;
  technicianId = tech!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.review_request where organization_id = ${ORG}`;
  await raw`delete from public.review where organization_id = ${ORG}`;
  await raw`delete from public.review_platform where organization_id = ${ORG}`;
  await raw`delete from public.review_policy where organization_id = ${ORG}`;
  await raw`delete from public.obligation where organization_id = ${ORG}`;
});

run("the policy is declared, never assumed", () => {
  it("refuses to decide anything without one", async () => {
    /**
     * Every number in a review policy is a decision about how a company
     * talks to its customers: how soon after a visit, how often at most,
     * how late in the evening. A guessed default sends messages at nine at
     * night to somebody who had four jobs that week.
     */
    const jobId = await aFinishedJob();
    await expect(reviews.requestFor(owner(), { jobId })).rejects.toThrow(/No review policy/);
  });

  it("refuses bands that do not cover every rating", async () => {
    await expect(setPolicy({
      bands: [{
        upToRating: 3, withinHours: 4, businessHoursOnly: true, priority: 1,
        reason: "Only the bad ones, which leaves four and five uncovered.",
      }],
    })).rejects.toThrow(ConflictError);
  });

  it("ships core's bands when nobody has written their own", async () => {
    const policy = await setPolicy();
    /**
     * Worth contrasting with the platform policies, which ship nothing at
     * all. The difference is whose rule it is: being wrong about your own
     * service standard costs a reply sent a day late, and being wrong about
     * somebody else's costs the listing.
     */
    expect(policy.bands.length).toBe(rv.DEFAULT_RESPONSE_BANDS.length);
  });
});

run("whether to ask at all", () => {
  it("asks about a finished, paid job", async () => {
    await setPolicy();
    const jobId = await aFinishedJob();

    const outcome = await reviews.requestFor(owner(), { jobId });
    expect(outcome.asked).toBe(true);
    expect(outcome.sendAt).not.toBeNull();
  });

  it("withholds while the invoice is open, and says it will clear", async () => {
    await setPolicy();
    const jobId = await aFinishedJob({ paid: false });

    const outcome = await reviews.requestFor(owner(), { jobId });
    expect(outcome.asked).toBe(false);
    expect(outcome.withheld).toBe("job_not_paid");
    /**
     * The distinction that makes the withheld list a worklist: an unpaid
     * invoice passes on its own, an opt out does not.
     */
    expect(outcome.clearsOnItsOwn).toBe(true);
  });

  it("withholds while a complaint is open against the job", async () => {
    await setPolicy();
    const jobId = await aFinishedJob();
    await raw`insert into public.obligation
      (organization_id, kind, entity_type, entity_id, due_at, consequence, state)
      values (${ORG}, 'complaint', 'job', ${jobId}, now(), 'They rang to complain.', 'open')`;

    const outcome = await reviews.requestFor(owner(), { jobId });
    expect(outcome.asked).toBe(false);
    expect(outcome.withheld).toBe("complaint_open");
  });

  it("withholds while a callback is still open", async () => {
    /**
     * The customer's defining experience of this work is that we came back,
     * and it is not over. Asking now is asking about half a story.
     */
    await setPolicy();
    const jobId = await aFinishedJob();
    const callback = await jobs.create(owner(), {
      customerId, propertyId, summary: "Came back", tags: [], customFields: {},
    });
    await raw`update public.job set parent_job_id = ${jobId} where id = ${callback.id}`;

    const outcome = await reviews.requestFor(owner(), { jobId });
    expect(outcome.asked).toBe(false);
    expect(outcome.withheld).toBe("callback_unresolved");
  });

  it("withholds when the customer has told us not to", async () => {
    await setPolicy();
    const jobId = await aFinishedJob();
    await raw`update public.customer set do_not_service = true where id = ${customerId}`;

    const outcome = await reviews.requestFor(owner(), { jobId });
    expect(outcome.asked).toBe(false);
    expect(outcome.withheld).toBe("customer_opted_out");
    expect(outcome.clearsOnItsOwn).toBe(false);

    await raw`update public.customer set do_not_service = false where id = ${customerId}`;
  });

  it("withholds a second ask inside the cooldown, however many jobs they give us", async () => {
    /**
     * A commercial customer with four properties produces four completed
     * jobs in a week. Four requests in a week is how a good customer learns
     * to filter the company's address.
     */
    await setPolicy({ customerCooldownDays: 90 });
    const first = await aFinishedJob();
    const request = await reviews.requestFor(owner(), { jobId: first });
    await reviews.markSent(owner(), { id: request.requestId! });

    const second = await aFinishedJob();
    const outcome = await reviews.requestFor(owner(), { jobId: second });
    expect(outcome.asked).toBe(false);
    expect(outcome.withheld).toBe("customer_asked_recently");
  });

  it("WRITES DOWN a withheld request, so 'why was nobody asked' has an answer", async () => {
    await setPolicy();
    const jobId = await aFinishedJob({ paid: false });
    await reviews.requestFor(owner(), { jobId });

    const [row] = await raw<{ state: string; withheld_reason: string; withheld_detail: string }[]>`
      select state, withheld_reason, withheld_detail from public.review_request
      where organization_id = ${ORG}`;
    expect(row!.state).toBe("withheld");
    expect(row!.withheld_reason).toBe("job_not_paid");
    expect(row!.withheld_detail.length).toBeGreaterThan(20);

    const grouped = await reviews.withheld(owner());
    expect(grouped).toEqual([{ reason: "job_not_paid", count: 1 }]);
  });

  it("re-deciding updates the row rather than making a second one", async () => {
    await setPolicy();
    const jobId = await aFinishedJob({ paid: false });
    await reviews.requestFor(owner(), { jobId });

    const [invoice] = await raw<{ id: string; total: string }[]>`
      select id, total from public.invoice where job_id = ${jobId}`;
    await billing.pay(owner(), {
      customerId, method: "check", amount: invoice!.total, tipAmount: "0",
      allocations: [{ invoiceId: invoice!.id, amount: invoice!.total }],
    });

    const second = await reviews.requestFor(owner(), { jobId });
    expect(second.asked).toBe(true);

    const [count] = await raw<{ n: string }[]>`
      select count(*) as n from public.review_request where organization_id = ${ORG}`;
    expect(Number(count!.n), "one request per job, enforced by the index").toBe(1);
  });

  it("refuses a platform nobody has declared anything about", async () => {
    /**
     * The same default the recording consent gate takes for an undeclared
     * jurisdiction. Refusing costs a request that was probably fine.
     * Allowing costs a rule broken on a platform nobody checked, and the
     * penalty lands on the listing the company's phone calls come from.
     */
    await setPolicy();
    const jobId = await aFinishedJob();
    await expect(reviews.requestFor(owner(), { jobId, platform: "yelp" }))
      .rejects.toThrow(/Nothing has been declared/);
  });

  it("asks on a platform the operator has declared", async () => {
    await setPolicy();
    await declareGoogle();
    const jobId = await aFinishedJob();

    const outcome = await reviews.requestFor(owner(), { jobId, platform: "google" });
    expect(outcome.asked).toBe(true);
  });

  it("refuses to send the same request twice", async () => {
    await setPolicy();
    const jobId = await aFinishedJob();
    const request = await reviews.requestFor(owner(), { jobId });

    await reviews.markSent(owner(), { id: request.requestId! });
    await expect(reviews.markSent(owner(), { id: request.requestId! }))
      .rejects.toThrow(/second ask/);
  });
});

run("what to do about a review that arrived", () => {
  it("says a phone call is owed, to the person who just typed in the one star", async () => {
    await setPolicy();
    const result = await reviews.record(owner(), {
      platform: "google", rating: 1, postedAt: new Date(),
      body: "Nobody turned up and nobody rang.",
    });

    /**
     * Returned with the row rather than left on a list to be noticed. The
     * caller who just entered this needs to be told now.
     */
    expect(result.recoveryOwed).toBe(true);
    expect(result.recoveryUrgency).toBe("same_day");
    expect(result.recoveryDueAt).not.toBeNull();
    expect(result.because).toContain("not the point of the call");
  });

  it("owes nothing beyond a thank you for a five star", async () => {
    await setPolicy();
    const result = await reviews.record(owner(), {
      platform: "google", rating: 5, postedAt: new Date(),
    });
    expect(result.recoveryOwed).toBe(false);
    expect(result.recoveryDueAt).toBeNull();
  });

  it("refuses a rating outside one to five", async () => {
    await setPolicy();
    await expect(reviews.record(owner(), {
      platform: "google", rating: 0, postedAt: new Date(),
    })).rejects.toThrow(ConflictError);
  });

  it("recognises the same review twice rather than doubling every average", async () => {
    await setPolicy();
    const once = { platform: "google", rating: 4, postedAt: new Date(), externalId: "g-1" };
    await reviews.record(owner(), once);
    await reviews.record(owner(), once);

    const view = await reviews.rating(owner());
    expect(view.count).toBe(1);
  });

  it("orders by how late it is, not by how bad it is", async () => {
    /**
     * The rule, stated exactly, because my first version of this test
     * asserted my intuition instead of it and was wrong.
     *
     * Lateness is measured against each review's OWN deadline, and the
     * deadlines differ by band: four business hours for a one star, a
     * calendar week for a five. So a five star left for three weeks is
     * genuinely more overdue than a one star from two days ago, and core
     * puts it first. That is right: both are late, and the three week old
     * one has been sitting on a public profile unanswered for three weeks.
     *
     * What the ordering is NOT is by rating, which is the thing worth
     * asserting. Below, the one star is the later of the two and comes
     * first; the test after it shows the same list reordering when the
     * relative lateness flips.
     */
    await setPolicy();
    const hours = (n: number) => new Date(Date.now() - n * 3600_000);

    /** Two days past a four hour clock. */
    await reviews.record(owner(), { platform: "google", rating: 1, postedAt: hours(48) });
    /** Two hours past a one week clock. */
    await reviews.record(owner(), { platform: "google", rating: 5, postedAt: hours(170) });

    const list = await reviews.workList(owner());
    expect(list).toHaveLength(2);
    expect(list.every((item) => item.overdue)).toBe(true);
    expect(list[0]!.rating).toBe(1);
    /** And it carries the reason, so the clock is not a rule with no why. */
    expect(list[0]!.reason.length).toBeGreaterThan(30);
  });

  it("puts a long ignored five star above a fresh one star, which is correct", async () => {
    /**
     * The same rule with the lateness the other way round. A five star
     * unanswered for three weeks has been sitting on a public profile
     * unanswered for three weeks; a one star from two hours ago is barely
     * past a four hour clock.
     *
     * Asserted deliberately rather than left implicit, because "worst
     * first" is what everybody expects this screen to do and it is not
     * what it does.
     */
    await setPolicy();
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    await reviews.record(owner(), { platform: "google", rating: 5, postedAt: days(28) });
    await reviews.record(owner(), { platform: "google", rating: 1, postedAt: new Date(Date.now() - 5 * 3600_000) });

    const list = await reviews.workList(owner());
    expect(list[0]!.rating).toBe(5);
    expect(list[0]!.overdueBy).toBeGreaterThan(list[1]!.overdueBy);
  });

  it("breaks a tie by band priority, so the one star wins at equal lateness", async () => {
    /**
     * The tie break that does separate work: two reviews falling due at the
     * same moment in different bands. Both are exactly on their deadline,
     * so neither is later, and the band's priority decides.
     */
    await setPolicy();
    const now = Date.now();
    /** Exactly on a four business hour clock, and exactly on a one week one. */
    await reviews.record(owner(), { platform: "google", rating: 5, postedAt: new Date(now - 167 * 3600_000) });
    await reviews.record(owner(), { platform: "google", rating: 1, postedAt: new Date(now - 3 * 3600_000) });

    const list = await reviews.workList(owner());
    expect(list).toHaveLength(2);
    /** Neither is late yet, so the ordering falls through to the deadline. */
    expect(list.every((item) => !item.overdue)).toBe(true);
    expect(list[0]!.dueAt.getTime()).toBeLessThanOrEqual(list[1]!.dueAt.getTime());
  });

  it("drops a review off the list once it has an answer", async () => {
    await setPolicy();
    const { id } = await reviews.record(owner(), {
      platform: "google", rating: 2, postedAt: new Date(Date.now() - 86_400_000),
    });
    await declareGoogle();

    await reviews.respond(owner(), { id, body: "We got this wrong and here is what we changed." });
    const list = await reviews.workList(owner());
    expect(list.map((i) => i.id)).not.toContain(id);
  });

  it("refuses the same reply under a second review", async () => {
    /**
     * The real cost is that it is visible to any prospect who scrolls, and
     * some platforms treat identical replies at volume as automated
     * activity.
     */
    await setPolicy();
    await declareGoogle(["templated_replies"]);
    const body = "Thank you for taking the time to leave us a review.";

    const first = await reviews.record(owner(), { platform: "google", rating: 5, postedAt: new Date() });
    const second = await reviews.record(owner(), { platform: "google", rating: 4, postedAt: new Date() });

    await reviews.respond(owner(), { id: first.id, body });
    await expect(reviews.respond(owner(), { id: second.id, body })).rejects.toThrow(ConflictError);
  });

  it("allows a repeated reply where the operator says that platform permits it", async () => {
    await setPolicy();
    await declareGoogle([]);
    const body = "Thank you for taking the time to leave us a review.";

    const first = await reviews.record(owner(), { platform: "google", rating: 5, postedAt: new Date() });
    const second = await reviews.record(owner(), { platform: "google", rating: 4, postedAt: new Date() });

    await reviews.respond(owner(), { id: first.id, body });
    await expect(reviews.respond(owner(), { id: second.id, body })).resolves.toBeTruthy();
  });

  it("keeps the phone call separate from the public reply", async () => {
    /**
     * Two different acts: one is a conversation and the other is what the
     * next prospect reads. Merging them would let a good reply close out a
     * call that never happened.
     */
    await setPolicy();
    await declareGoogle();
    const { id } = await reviews.record(owner(), {
      platform: "google", rating: 1, postedAt: new Date(),
    });

    await reviews.respond(owner(), { id, body: "We are sorry and we have rung you." });

    const [row] = await raw<{ responded_at: Date; recovered_at: Date | null }[]>`
      select responded_at, recovered_at from public.review where id = ${id}`;
    expect(row!.responded_at).not.toBeNull();
    expect(row!.recovered_at, "a reply is not a phone call").toBeNull();

    await reviews.markRecovered(owner(), { id });
    const [after] = await raw<{ recovered_at: Date }[]>`
      select recovered_at from public.review where id = ${id}`;
    expect(after!.recovered_at).not.toBeNull();
  });

  it("refuses a reply nobody wrote", async () => {
    await setPolicy();
    await declareGoogle();
    const { id } = await reviews.record(owner(), {
      platform: "google", rating: 3, postedAt: new Date(),
    });
    await expect(reviews.respond(owner(), { id, body: "Thanks" })).rejects.toThrow(ConflictError);
  });
});

run("what the rating actually is", () => {
  it("has no rating at all with no reviews, rather than zero", async () => {
    /**
     * A business with no reviews does not have a rating of 0.0, and a 0.0
     * on a screen is a catastrophe rendered as a fact.
     */
    await setPolicy();
    const view = await reviews.rating(owner());
    expect(view.count).toBe(0);
    expect(view.mean).toBeNull();
    expect(view.confidence).toBeNull();
  });

  it("gives three numbers and what each is wrong about", async () => {
    await setPolicy();
    for (const rating of [5, 5, 4, 5, 3]) {
      await reviews.record(owner(), { platform: "google", rating, postedAt: new Date() });
    }

    const view = await reviews.rating(owner());
    expect(view.count).toBe(5);
    expect(view.mean).toBeCloseTo(4.4, 5);
    /**
     * Always below the mean, deliberately. It is for ordering, and it is
     * the number that must never be shown to a customer as the rating.
     */
    expect(view.confidence!).toBeLessThan(view.mean!);
    for (const caveat of Object.values(view.caveats)) {
      expect(caveat.length).toBeGreaterThan(40);
    }
  });

  it("discounts an old review in the recency weighted view and not in the mean", async () => {
    await setPolicy({ halfLifeDays: 30 } as never);
    const old = new Date(Date.now() - 365 * 86_400_000);
    await reviews.record(owner(), { platform: "google", rating: 1, postedAt: old });
    await reviews.record(owner(), { platform: "google", rating: 5, postedAt: new Date() });

    const view = await reviews.rating(owner());
    expect(view.mean).toBeCloseTo(3, 5);
    /**
     * The bad year is still in the mean and is nearly gone from the recent
     * view. That difference is the whole reason both are shown.
     */
    expect(view.recentMean!).toBeGreaterThan(4.5);
  });

  it("does not let a two review newcomer top the technician ranking", async () => {
    await setPolicy();
    const [membership] = await raw<{ id: string }[]>`select id from public.membership
      where organization_id = ${ORG} and user_id = ${USER}`;
    const [rookie] = await raw<{ id: string }[]>`insert into public.technician
      (organization_id, membership_id, display_name)
      values (${ORG}, ${membership!.id}, 'New Starter') returning id`;

    await reviews.record(owner(), { platform: "google", rating: 5, postedAt: new Date(), technicianId: rookie!.id });
    await reviews.record(owner(), { platform: "google", rating: 5, postedAt: new Date(), technicianId: rookie!.id });
    for (let i = 0; i < 30; i += 1) {
      await reviews.record(owner(), {
        platform: "google", rating: i === 0 ? 4 : 5, postedAt: new Date(), technicianId,
      });
    }

    const ranked = await reviews.byTechnician(owner());
    /**
     * The mean would put the two five stars on top. The person reading this
     * is deciding who to send to a difficult customer.
     */
    expect(ranked[0]!.technicianId).toBe(technicianId);
    expect(ranked[0]!.count).toBe(30);

    await raw`delete from public.technician where id = ${rookie!.id}`;
  });

  it("refuses to read another company's reviews", async () => {
    await setPolicy();
    const stranger: ServiceContext = {
      actor: { userId: USER, organizationId: fixtureId("reviews:other"), roles: ["owner"] as Actor["roles"] },
      db: db(),
    };
    await expect(reviews.rating(stranger)).rejects.toThrow(ConflictError);
  });
});
