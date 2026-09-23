import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  decideRequest, routeReply, summarise, rankByConfidence, wilsonLowerBound,
  respondBy, responseWorkList, bandFor, checkResponsePolicy,
  checkPlatformPolicies, checkPlannedRequest, checkPlannedReply,
  WITHHOLDING_RULES, REQUEST_INPUTS, DEFAULT_RESPONSE_BANDS, PROHIBITIONS, PROHIBITION,
  type JobFacts, type RequestPolicy, type ResponsePolicy, type Review,
  type PlatformPolicy, type WithheldReason, type RatedGroup,
} from "../src/reviews/index.js";

/**
 * REVIEWS AND REPUTATION
 *
 * The first block of tests is the important one, and it is unusual: it tests
 * the ABSENCE of a feature. Review gating, asking privately first and routing
 * only the pleased to a public page, is prohibited by consumer protection
 * rules and by the platforms' own terms, and it is the most requested feature
 * in this category. Merely not having written it is not enough, because the
 * next person asked to add it will not read a comment. So the absence is
 * enforced twice: once by watching which facts the decision actually reads,
 * and once by reading the source with the prose removed.
 */

const NOW = new Date("2026-06-10T16:00:00Z");

const POLICY: RequestPolicy = {
  timeZone: "America/Chicago",
  delayMinutes: 120,
  customerCooldownDays: 30,
  requirePaid: true,
  maxJobAgeDays: 30,
  earliestHour: 8,
  latestHour: 20,
};

const facts = (over: Partial<JobFacts> = {}): JobFacts => ({
  jobId: "job-1",
  customerId: "cust-1",
  completed: true,
  paid: true,
  technicianLeftAt: new Date("2026-06-10T15:00:00Z"),
  callback: null,
  complaintOpen: false,
  optedOut: false,
  requests: [],
  ...over,
});

/* ------------------------------------------------------------------ */

/**
 * Words that must not appear in executable code in the request path, in any
 * casing or compound. They are all fine in the comments, where the file
 * spends several hundred words explaining why they are not in the code.
 */
const BANNED = new Set([
  "sentiment", "sentiments", "predict", "predicts", "predicted", "prediction",
  "gating", "gate", "gated", "happy", "unhappy", "satisfied", "dissatisfied",
  "mood", "positive", "negative",
]);

const wordsIn = (identifier: string): string[] =>
  identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_$]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);

/**
 * Records every property the decision touches, at any depth.
 *
 * This is the guard that cannot be talked around. A branch on a predicted
 * rating has to read the prediction from somewhere, and reading it from the
 * facts shows up here as a path that nobody declared.
 */
function watched(input: JobFacts): { proxy: JobFacts; read: Set<string> } {
  const read = new Set<string>();
  const wrap = <T extends object>(target: T, prefix: string): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        if (typeof property !== "string") return Reflect.get(object, property, receiver);
        const path = prefix === "" ? property : `${prefix}.${property}`;
        read.add(path);
        const value: unknown = Reflect.get(object, property, receiver);
        if (value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
          return wrap(value as object, path);
        }
        return value;
      },
    });
  return { proxy: wrap(input, ""), read };
}

/**
 * The source with the prose taken out: block comments, line comments and the
 * contents of string literals. Interpolated expressions inside a template are
 * KEPT, because they are code and somebody could hide a read in one.
 */
function executableSource(): string {
  return readFileSync(new URL("../src/reviews/index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, (literal) => (literal.match(/\$\{[^}]*\}/g) ?? []).join(" "))
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/* ================================================================== */

describe("the feature this module refuses to build", () => {
  it("reads nothing about what the customer is expected to say", () => {
    /**
     * Every shape of job, eligible and withheld, put through a proxy that
     * records the reads. If any of them touches a fact outside the declared
     * set, this fails and names it.
     */
    const shapes: JobFacts[] = [
      facts(),
      facts({ completed: false }),
      facts({ paid: false }),
      facts({ optedOut: true }),
      facts({ complaintOpen: true }),
      facts({ callback: { resolvedAt: null } }),
      facts({ callback: { resolvedAt: new Date("2026-06-10T15:30:00Z") } }),
      facts({ technicianLeftAt: null }),
      facts({ requests: [{ jobId: "job-1", sentAt: new Date("2026-06-01T12:00:00Z") }] }),
      facts({ requests: [{ jobId: "job-0", sentAt: new Date("2026-06-01T12:00:00Z") }] }),
      facts({ technicianLeftAt: new Date("2026-01-01T15:00:00Z") }),
    ];

    const allowed = new Set(REQUEST_INPUTS);
    for (const shape of shapes) {
      const { proxy, read } = watched(shape);
      decideRequest(proxy, POLICY, NOW);
      for (const path of read) {
        expect(allowed.has(path), `the decision read "${path}", which is not in REQUEST_INPUTS`).toBe(true);
      }
    }
  });

  it("declares no input that is anybody's guess about the customer", () => {
    for (const input of REQUEST_INPUTS) {
      for (const word of wordsIn(input)) {
        expect(BANNED.has(word), `REQUEST_INPUTS contains "${input}"`).toBe(false);
      }
    }
  });

  it("has no branch on a predicted rating anywhere in the source", () => {
    const identifiers = executableSource().match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    const found = identifiers.filter((identifier) =>
      wordsIn(identifier).some((word) => BANNED.has(word)));
    expect(found, `executable code mentions ${[...new Set(found)].join(", ")}`).toEqual([]);
  });

  it("ignores a prediction even when somebody attaches one to the job", () => {
    /**
     * Belt and braces for the proxy: an untyped caller bolting a prediction
     * onto the facts must not change a single thing about the answer.
     */
    const plain = decideRequest(facts(), POLICY, NOW);
    const smuggled = decideRequest(
      { ...facts(), predictedRating: 1, likelyToComplain: true } as unknown as JobFacts,
      POLICY,
      NOW,
    );
    expect(smuggled).toEqual(plain);
  });

  it("refuses a rule pushed onto the exported table at runtime", () => {
    /**
     * `readonly` is a compile time adjective. Before the table was frozen an
     * importer could cast it back to a mutable array, push a rule whose
     * condition read a private score off the job, and report the hold under an
     * innocuous reason already in the table. That is working gating built out
     * of this module's public exports with no edit to the source, which is the
     * one thing the file says is impossible.
     */
    const table = WITHHOLDING_RULES as unknown as Array<Record<string, unknown>>;
    const before = WITHHOLDING_RULES.length;
    expect(() => table.push({
      reason: "complaint_open",
      clearsOnItsOwn: true,
      applies: (job: Record<string, unknown>) =>
        typeof job["privateScore"] === "number" && (job["privateScore"] as number) <= 3
          ? "Held back on a number nobody declared, which is the whole violation."
          : false,
    })).toThrow(TypeError);
    expect(WITHHOLDING_RULES.length).toBe(before);
    expect(Object.isFrozen(WITHHOLDING_RULES)).toBe(true);

    const smuggled = decideRequest(
      { ...facts(), privateScore: 1 } as unknown as JobFacts, POLICY, NOW);
    expect(smuggled).toEqual(decideRequest(facts(), POLICY, NOW));
  });

  it("refuses an overwrite of a condition on a rule already in the table", () => {
    // The same door by the other handle: leave the table alone and rewrite
    // what one of the rules in it asks.
    for (const rule of WITHHOLDING_RULES) expect(Object.isFrozen(rule)).toBe(true);
    const first = WITHHOLDING_RULES[0] as unknown as Record<string, unknown>;
    expect(() => {
      first["applies"] = () => "Withheld, and the reason is nobody's business.";
    }).toThrow(TypeError);
    expect(decideRequest(facts({ optedOut: true }), POLICY, NOW).ask).toBe(false);
    expect(decideRequest(facts(), POLICY, NOW).ask).toBe(true);
  });

  it("will not let a caller widen the declared set of readable facts", () => {
    // REQUEST_INPUTS is what the proxy test above measures against. A caller
    // who can push onto it can widen the guard as well as the decision.
    const inputs = REQUEST_INPUTS as unknown as string[];
    expect(Object.isFrozen(REQUEST_INPUTS)).toBe(true);
    expect(() => inputs.push("privateScore")).toThrow(TypeError);
    expect(REQUEST_INPUTS).not.toContain("privateScore");
  });

  it("cannot be defeated by replacing a rule by index or reordering the table", () => {
    /**
     * The two routes the freeze has to cover beyond push and property write.
     * An index assignment swaps a rule for a gate without adding one, and a
     * reverse puts a permissive rule ahead of the one that would have held
     * the request. Both are ordinary array operations on a frozen array and
     * both throw, but neither was exercised until somebody tried them.
     */
    const gate = {
      reason: "complaint_open",
      applies: (f: Record<string, unknown>) => Number(f.privateScore ?? 5) < 4,
    };
    expect(() => { (WITHHOLDING_RULES as unknown as unknown[])[0] = gate; }).toThrow(TypeError);
    expect(() => (WITHHOLDING_RULES as unknown as unknown[]).reverse()).toThrow(TypeError);
  });

  it("draws the recovery line exactly where the policy puts it", () => {
    // The boundaries, which the case by case test above steps over: three and
    // five say nothing about what four does.
    const recovery = { recoverAtOrBelow: 3, sameDayAtOrBelow: 2 };
    const reply = (rating: number) =>
      routeReply({ jobId: "job-1", customerId: "cust-1", rating, receivedAt: NOW }, recovery);
    expect(reply(4).recover).toBe(false);
    expect(reply(3).recover).toBe(true);
    const onTheLine = reply(2);
    expect(onTheLine.recover && onTheLine.urgency).toBe("same_day");
    const justOver = reply(3);
    expect(justOver.recover && justOver.urgency).toBe("next_business_day");
  });

  it("uses the reply to decide who gets a phone call, not who gets asked", () => {
    // The legitimate version, and the ordering is the whole difference: this
    // runs after the public invitation has already gone out.
    const recovery = { recoverAtOrBelow: 3, sameDayAtOrBelow: 2 };
    const bad = routeReply(
      { jobId: "job-1", customerId: "cust-1", rating: 1, receivedAt: NOW }, recovery);
    expect(bad.recover).toBe(true);
    expect(bad.recover && bad.urgency).toBe("same_day");

    const middling = routeReply(
      { jobId: "job-2", customerId: "cust-2", rating: 3, receivedAt: NOW }, recovery);
    expect(middling.recover && middling.urgency).toBe("next_business_day");

    expect(routeReply(
      { jobId: "job-3", customerId: "cust-3", rating: 5, receivedAt: NOW }, recovery).recover).toBe(false);
  });
});

/* ================================================================== */

describe("when to ask", () => {
  it("waits the declared delay after the technician leaves", () => {
    const decision = decideRequest(facts(), POLICY, NOW);
    expect(decision.ask).toBe(true);
    // Left at ten in the morning in Chicago, two hour delay, so midday.
    expect(decision.ask && decision.sendAt.toISOString()).toBe("2026-06-10T17:00:00.000Z");
    expect(decision.ask && decision.readyNow).toBe(false);
  });

  it("refuses a second request for the same job", () => {
    const decision = decideRequest(
      facts({ requests: [{ jobId: "job-1", sentAt: new Date("2026-06-01T12:00:00Z") }] }),
      POLICY, NOW);
    expect(decision.ask).toBe(false);
    expect(!decision.ask && decision.withheld).toBe("already_asked_for_this_job");
    expect(!decision.ask && decision.clearsOnItsOwn).toBe(false);
  });

  it("asks a customer with three jobs in a week exactly once", () => {
    /**
     * A commercial customer with four properties generates four completed
     * jobs in a week. Four requests in a week is how a good customer learns
     * to filter our address.
     */
    const sent: { jobId: string; sentAt: Date }[] = [];
    const asked: string[] = [];
    const days = ["2026-06-08", "2026-06-09", "2026-06-10"];

    days.forEach((day, index) => {
      const jobId = `job-${index}`;
      const left = new Date(`${day}T15:00:00Z`);
      const now = new Date(`${day}T18:00:00Z`);
      const decision = decideRequest(
        facts({ jobId, technicianLeftAt: left, requests: [...sent] }), POLICY, now);
      if (decision.ask) {
        asked.push(jobId);
        sent.push({ jobId, sentAt: decision.sendAt });
      } else {
        expect(decision.withheld).toBe("customer_asked_recently");
      }
    });

    expect(asked).toEqual(["job-0"]);
  });

  it("holds the ask while a callback is open and releases it once resolved", () => {
    const open = decideRequest(facts({ callback: { resolvedAt: null } }), POLICY, NOW);
    expect(!open.ask && open.withheld).toBe("callback_unresolved");
    expect(!open.ask && open.clearsOnItsOwn).toBe(true);

    const closed = decideRequest(
      facts({ callback: { resolvedAt: new Date("2026-06-10T15:30:00Z") } }), POLICY, NOW);
    expect(closed.ask).toBe(true);
  });

  it("measures the delay from the callback closing, not from the first visit", () => {
    /**
     * Measuring from the original visit fires the request the instant a
     * callback is resolved, about a job whose defining event for the
     * customer was us coming back twice.
     */
    const decision = decideRequest(
      facts({
        technicianLeftAt: new Date("2026-06-08T15:00:00Z"),
        callback: { resolvedAt: new Date("2026-06-10T15:00:00Z") },
      }),
      POLICY, NOW);
    expect(decision.ask && decision.sendAt.toISOString()).toBe("2026-06-10T17:00:00.000Z");
  });

  it("will not ask while a complaint is open, and says the hold lifts by itself", () => {
    const decision = decideRequest(facts({ complaintOpen: true }), POLICY, NOW);
    expect(!decision.ask && decision.withheld).toBe("complaint_open");
    expect(!decision.ask && decision.clearsOnItsOwn).toBe(true);
  });

  it("never asks somebody who opted out, and says nothing will change that", () => {
    const decision = decideRequest(facts({ optedOut: true }), POLICY, NOW);
    expect(!decision.ask && decision.withheld).toBe("customer_opted_out");
    expect(!decision.ask && decision.clearsOnItsOwn).toBe(false);
  });

  it("will not ask about a job nobody recorded a departure time for", () => {
    const decision = decideRequest(facts({ technicianLeftAt: null }), POLICY, NOW);
    expect(!decision.ask && decision.withheld).toBe("departure_time_unknown");
  });

  it("will not ask about an unpaid job while the policy requires payment", () => {
    expect(!decideRequest(facts({ paid: false }), POLICY, NOW).ask).toBe(true);
    const relaxed = decideRequest(facts({ paid: false }), { ...POLICY, requirePaid: false }, NOW);
    expect(relaxed.ask).toBe(true);
  });

  it("will not sweep the back catalogue when somebody turns the feature on", () => {
    // The sweep is the fastest way to trip a platform's bulk solicitation rule.
    const decision = decideRequest(
      facts({ technicianLeftAt: new Date("2026-01-04T15:00:00Z") }), POLICY, NOW);
    expect(!decision.ask && decision.withheld).toBe("job_too_old");
  });

  it("pushes a late evening job to the next morning in the company's zone", () => {
    // Left at eight in the evening in Chicago, so the two hour delay lands at
    // ten at night. Nobody is sent a text at ten at night.
    const decision = decideRequest(
      facts({ technicianLeftAt: new Date("2026-06-11T01:00:00Z") }),
      POLICY,
      new Date("2026-06-11T01:00:00Z"));
    expect(decision.ask && decision.sendAt.toISOString()).toBe("2026-06-11T13:00:00.000Z");
  });

  it("pushes an overnight job forward to opening rather than back to yesterday", () => {
    const decision = decideRequest(
      facts({ technicianLeftAt: new Date("2026-06-11T06:00:00Z") }),
      POLICY,
      new Date("2026-06-11T06:00:00Z"));
    expect(decision.ask && decision.sendAt.toISOString()).toBe("2026-06-11T13:00:00.000Z");
  });

  it("opens the sending window an hour late when its first hour never happened", () => {
    /**
     * The same daylight saving gap on the sending side. An overnight window
     * that opens at two, on the Sunday in Chicago when two o'clock did not
     * exist, so the window opens at three instead. Without the fallback the
     * opening instant lands at one in the morning, which is before the window,
     * and the search walks in place until it gives up and sends outside it.
     */
    const overnight: RequestPolicy = { ...POLICY, delayMinutes: 60, earliestHour: 2, latestHour: 10 };
    const at = new Date("2026-03-08T04:00:00Z");
    const decision = decideRequest(facts({ technicianLeftAt: at }), overnight, at);
    expect(decision.ask && decision.sendAt.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("reports the most definitive reason when several apply at once", () => {
    /**
     * "Why did that customer never get asked" is the question this module is
     * opened for, and reporting "complaint open" about a job we already asked
     * about sends somebody to close a complaint for no reason.
     */
    const decision = decideRequest(
      facts({
        optedOut: true,
        complaintOpen: true,
        requests: [{ jobId: "job-1", sentAt: new Date("2026-06-01T12:00:00Z") }],
      }),
      POLICY, NOW);
    expect(!decision.ask && decision.withheld).toBe("customer_opted_out");
  });

  it("gives every withheld request an explanation somebody could act on", () => {
    const triggers: Record<WithheldReason, JobFacts> = {
      customer_opted_out: facts({ optedOut: true }),
      already_asked_for_this_job: facts({ requests: [{ jobId: "job-1", sentAt: new Date("2026-06-01T12:00:00Z") }] }),
      job_not_completed: facts({ completed: false }),
      departure_time_unknown: facts({ technicianLeftAt: null }),
      job_not_paid: facts({ paid: false }),
      complaint_open: facts({ complaintOpen: true }),
      callback_unresolved: facts({ callback: { resolvedAt: null } }),
      job_too_old: facts({ technicianLeftAt: new Date("2026-01-04T15:00:00Z") }),
      customer_asked_recently: facts({ requests: [{ jobId: "job-0", sentAt: new Date("2026-06-01T12:00:00Z") }] }),
    };

    for (const [reason, shape] of Object.entries(triggers)) {
      const decision = decideRequest(shape, POLICY, NOW);
      expect(decision.ask, reason).toBe(false);
      expect(!decision.ask && decision.withheld, reason).toBe(reason);
      expect(!decision.ask && decision.explanation.length, reason).toBeGreaterThan(40);
    }
  });

  it("keeps the rule table in the precedence order the decision relies on", () => {
    expect(WITHHOLDING_RULES.map((rule) => rule.reason)).toEqual([
      "customer_opted_out",
      "already_asked_for_this_job",
      "job_not_completed",
      "departure_time_unknown",
      "job_not_paid",
      "complaint_open",
      "callback_unresolved",
      "job_too_old",
      "customer_asked_recently",
    ]);
  });
});

/* ================================================================== */

const review = (over: Partial<Review> & { rating: number; id: string }): Review => ({
  platform: "primary",
  postedAt: new Date("2026-06-01T12:00:00Z"),
  ...over,
});

const many = (count: number, rating: number, prefix: string, postedAt?: Date): Review[] =>
  Array.from({ length: count }, (_unused, index) =>
    review({ id: `${prefix}-${index}`, rating, ...(postedAt ? { postedAt } : {}) }));

describe("what the rating actually is", () => {
  it("does not report a business with no reviews as a zero", () => {
    // A 0.0 on a screen is a catastrophe rendered as a fact.
    const view = summarise([], { halfLifeDays: 180 }, NOW);
    expect(view.mean).toBeNull();
    expect(view.confidence).toBeNull();
    expect(view.count).toBe(0);
  });

  it("does not let four five star reviews outrank forty at 4.8", () => {
    /**
     * The failure this whole section exists for. A mean has no idea how many
     * numbers went into it, so the newcomer tops every list in the product
     * and somebody hands them the commercial accounts.
     */
    const newcomer: RatedGroup = { key: "newcomer", reviews: many(4, 5, "n") };
    const veteran: RatedGroup = {
      key: "veteran",
      reviews: [...many(32, 5, "v5"), ...many(8, 4, "v4")],
    };

    const ranked = rankByConfidence([newcomer, veteran], { halfLifeDays: 3650 }, NOW);
    expect(ranked.map((group) => group.key)).toEqual(["veteran", "newcomer"]);
    expect(ranked[0]?.view.confidence).toBeCloseTo(4.34, 2);
    expect(ranked[1]?.view.confidence).toBeCloseTo(3.04, 2);
  });

  it("shows the mean disagreeing, which is why the mean is not what we sort by", () => {
    const newcomer = summarise(many(4, 5, "n"), { halfLifeDays: 3650 }, NOW);
    const veteran = summarise(
      [...many(32, 5, "v5"), ...many(8, 4, "v4")], { halfLifeDays: 3650 }, NOW);
    expect(newcomer.mean).toBe(5);
    expect(veteran.mean).toBeCloseTo(4.8, 10);
    // The mean says the newcomer is better. It is wrong, and it cannot know.
    expect((newcomer.mean ?? 0) > (veteran.mean ?? 0)).toBe(true);
  });

  it("widens the gap between the bound and the mean as the sample shrinks", () => {
    const small = summarise(many(3, 5, "s"), { halfLifeDays: 3650 }, NOW);
    const large = summarise(many(300, 5, "l"), { halfLifeDays: 3650 }, NOW);
    expect((small.mean ?? 0) - (small.confidence ?? 0))
      .toBeGreaterThan((large.mean ?? 0) - (large.confidence ?? 0));
    // And the bound never flatters: it is below the mean, always.
    expect(large.confidence).toBeLessThan(large.mean ?? 0);
  });

  it("pins the bound at the ends rather than drifting outside the scale", () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
    expect(wilsonLowerBound(10, 10)).toBeGreaterThan(0);
    expect(wilsonLowerBound(5, 0)).toBe(0);
    expect(summarise(many(50, 1, "worst"), { halfLifeDays: 3650 }, NOW).confidence).toBe(1);
  });

  it("lets recent work move the recency weighted view while the mean sits still", () => {
    /**
     * The mean is wrong about TIME: a shop that was badly run two years ago
     * and is well run now reads as mediocre forever.
     */
    const reviews = [
      ...many(20, 1, "old", new Date("2024-06-01T12:00:00Z")),
      ...many(20, 5, "new", new Date("2026-06-01T12:00:00Z")),
    ];
    const view = summarise(reviews, { halfLifeDays: 120 }, NOW);
    expect(view.mean).toBeCloseTo(3, 10);
    expect(view.recentMean ?? 0).toBeGreaterThan(4.9);
  });

  it("falls back to the mean rather than a NaN when every review is ancient", () => {
    const view = summarise(
      many(5, 4, "ancient", new Date("1990-01-01T00:00:00Z")), { halfLifeDays: 1 }, NOW);
    expect(Number.isNaN(view.recentMean)).toBe(false);
    expect(view.recentMean).toBe(4);
  });

  it("names the method it ranked by and says what each number is wrong about", () => {
    const view = summarise(many(4, 5, "n"), { halfLifeDays: 180 }, NOW);
    expect(view.method).toBe("wilson_lower_bound_95_on_share_of_maximum");
    expect(view.caveats.mean.length).toBeGreaterThan(40);
    expect(view.caveats.recentMean.length).toBeGreaterThan(40);
    expect(view.caveats.confidence.length).toBeGreaterThan(40);
  });

  it("puts five stars from three reviews below four and a half from two hundred", () => {
    /**
     * The arithmetic pinned against known values. A perfect three is 2.75 on
     * this scale and two hundred at four and a half is 4.29, so the newcomer
     * sits below, which is the entire reason the bound is here.
     */
    const ranked = rankByConfidence(
      [
        { key: "three-perfect", reviews: many(3, 5, "p") },
        { key: "two-hundred", reviews: [...many(100, 5, "a"), ...many(100, 4, "b")] },
      ],
      { halfLifeDays: 3650 }, NOW);
    expect(ranked.map((group) => group.key)).toEqual(["two-hundred", "three-perfect"]);
    expect(ranked[0]?.view.mean).toBeCloseTo(4.5, 10);
    expect(ranked[0]?.view.confidence).toBeCloseTo(4.29, 2);
    expect(ranked[1]?.view.confidence).toBeCloseTo(2.75, 2);
    // And nothing divides by zero on the way in.
    expect(wilsonLowerBound(5, 0)).toBe(0);
    expect(Number.isFinite(wilsonLowerBound(0, 0))).toBe(true);
  });

  it("separates two groups the bound cannot tell apart by which has more evidence", () => {
    /**
     * Nothing but one star reviews puts the bound on its floor whatever the
     * sample size, so the count is the only thing left to order by. It used to
     * be ordered by floating point dust instead: the bound came back as
     * 1.0000000000000002 for three reviews and exactly 1 for thirty, so the
     * three review group sorted ABOVE the thirty review one. That is the
     * inversion this whole section exists to prevent, arriving past the tie
     * break that was meant to catch it.
     */
    const small = summarise(many(3, 1, "s"), { halfLifeDays: 3650 }, NOW);
    const large = summarise(many(30, 1, "l"), { halfLifeDays: 3650 }, NOW);
    expect(small.confidence).toBe(1);
    expect(large.confidence).toBe(small.confidence);

    // The bigger sample deliberately gets the later key, so the key tie break
    // cannot pass this test on the count tie break's behalf.
    const ranked = rankByConfidence(
      [
        { key: "aaa-three", reviews: many(3, 1, "a") },
        { key: "zzz-thirty", reviews: many(30, 1, "z") },
      ],
      { halfLifeDays: 3650 }, NOW);
    expect(ranked.map((group) => group.key)).toEqual(["zzz-thirty", "aaa-three"]);
  });

  it("breaks a tie on evidence, then on the key, so a list does not reshuffle itself", () => {
    const ranked = rankByConfidence(
      [
        { key: "zeta", reviews: many(10, 5, "z") },
        { key: "alpha", reviews: many(10, 5, "a") },
        { key: "beta", reviews: many(20, 5, "b") },
      ],
      { halfLifeDays: 3650 }, NOW);
    expect(ranked.map((group) => group.key)).toEqual(["beta", "alpha", "zeta"]);
  });
});

/* ================================================================== */

const RESPONSE: ResponsePolicy = {
  timeZone: "America/Chicago",
  businessDays: [1, 2, 3, 4, 5],
  openHour: 8,
  closeHour: 17,
  bands: DEFAULT_RESPONSE_BANDS,
};

describe("which reviews need a reply, and by when", () => {
  it("gives a one star posted on a Friday evening a Monday deadline, not a Saturday one", () => {
    /**
     * Posted at eight on a Friday evening in Chicago, which is already
     * Saturday in UTC. Four OPEN hours, so the clock does not start until the
     * office does on Monday. The naive answer, posted plus four hours, is a
     * deadline of midnight on Saturday: unmeetable, breached by Monday
     * morning, and a work list that is permanently red is one nobody reads.
     *
     * The weekend also contains a daylight saving change, so Monday noon in
     * Chicago is 17:00 UTC rather than 18:00.
     */
    const postedAt = new Date("2026-03-07T02:00:00Z");
    const band = bandFor(1, RESPONSE);
    expect(band?.withinHours).toBe(4);
    expect(band?.businessHoursOnly).toBe(true);

    const dueAt = respondBy(postedAt, band!, RESPONSE);
    expect(dueAt.toISOString()).toBe("2026-03-09T17:00:00.000Z");
    expect(dueAt.toISOString()).not.toBe("2026-03-07T06:00:00.000Z");
  });

  it("starts a Monday morning one star clock at opening, not at midnight", () => {
    const dueAt = respondBy(
      new Date("2026-03-09T09:00:00Z"), bandFor(1, RESPONSE)!, RESPONSE);
    // Four in the morning in Chicago, so the clock starts at eight.
    expect(dueAt.toISOString()).toBe("2026-03-09T17:00:00.000Z");
  });

  it("carries a clock longer than one working day into the next open day", () => {
    /**
     * Twenty four OPEN hours from Monday noon, in an office open eight to
     * five: five hours left on Monday, nine on Tuesday, nine on Wednesday,
     * and the last one at nine on Thursday morning. A calendar clock would
     * have said Tuesday noon, which is a day and a half of office time
     * earlier than the policy actually allows.
     */
    const dueAt = respondBy(
      new Date("2026-03-09T17:00:00Z"), bandFor(3, RESPONSE)!, RESPONSE);
    expect(dueAt.toISOString()).toBe("2026-03-12T14:00:00.000Z");
  });

  it("counts open days by the company's calendar, not the server's", () => {
    /**
     * Added after a deliberate break went green. Swapping the company zone
     * weekday for the server's `getUTCDay` broke nothing, because for a shop
     * in Chicago the local working day never crosses a UTC date boundary: 8am
     * to 5pm there is 1pm to 11pm UTC, same day, every day of the year.
     *
     * It breaks immediately for a company east of UTC. Eight in the morning
     * in Tokyo is eleven at night the PREVIOUS day in UTC, so a server that
     * answers "which day is it" hands back Sunday for a Monday morning,
     * decides the office is shut, and moves every deadline a day late for
     * the whole company, forever, in a way nobody would think to check.
     */
    const tokyo: ResponsePolicy = {
      timeZone: "Asia/Tokyo",
      businessDays: [1, 2, 3, 4, 5],
      openHour: 8,
      closeHour: 17,
      bands: DEFAULT_RESPONSE_BANDS,
    };
    // Posted midday on a Sunday in Tokyo. Four open hours, so midday Monday.
    const dueAt = respondBy(new Date("2026-03-08T03:00:00Z"), bandFor(1, tokyo)!, tokyo);
    expect(dueAt.toISOString()).toBe("2026-03-09T03:00:00.000Z");
    expect(dueAt.toISOString()).not.toBe("2026-03-10T03:00:00.000Z");
  });

  it("gives a five star a calendar week rather than four open hours", () => {
    const band = bandFor(5, RESPONSE);
    expect(band?.businessHoursOnly).toBe(false);
    const dueAt = respondBy(new Date("2026-03-07T02:00:00Z"), band!, RESPONSE);
    expect(dueAt.toISOString()).toBe("2026-03-14T02:00:00.000Z");
  });

  it("puts the most overdue at the top and the not yet due at the bottom", () => {
    const now = new Date("2026-03-16T15:00:00Z");
    const list = responseWorkList(
      [
        review({ id: "fresh-five", rating: 5, postedAt: new Date("2026-03-16T12:00:00Z") }),
        review({ id: "old-one", rating: 1, postedAt: new Date("2026-03-09T13:00:00Z") }),
        review({ id: "recent-three", rating: 3, postedAt: new Date("2026-03-16T13:00:00Z") }),
      ],
      RESPONSE, now);
    expect(list.map((item) => item.review.id)).toEqual(["old-one", "recent-three", "fresh-five"]);
    expect(list[0]?.overdueBy).toBeGreaterThan(0);
    expect(list[2]?.overdueBy).toBe(0);
  });

  it("leaves answered reviews off the list", () => {
    // A queue that keeps showing finished work is a queue people stop reading.
    const list = responseWorkList(
      [review({ id: "done", rating: 1, respondedAt: new Date("2026-03-09T14:00:00Z") })],
      RESPONSE, new Date("2026-03-16T15:00:00Z"));
    expect(list).toEqual([]);
  });

  it("carries the reason for the clock onto every item, because the screen shows it", () => {
    const list = responseWorkList(
      [review({ id: "one", rating: 1 })], RESPONSE, new Date("2026-06-16T15:00:00Z"));
    expect(list[0]?.reason.length).toBeGreaterThan(40);
    expect(list[0]?.reason).toBe(list[0]?.band.reason);
  });

  it("refuses a policy with no business days, rather than searching forever for one", () => {
    const verdict = checkResponsePolicy({ ...RESPONSE, businessDays: [] });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("business days");
  });

  it("refuses bands that stop below five, because that review would vanish", () => {
    const verdict = checkResponsePolicy({
      ...RESPONSE,
      bands: DEFAULT_RESPONSE_BANDS.filter((band) => band.upToRating < 5),
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("five star");
  });

  it("refuses bands that are out of order or allow no time at all", () => {
    expect(checkResponsePolicy({ ...RESPONSE, bands: [...DEFAULT_RESPONSE_BANDS].reverse() }).ok)
      .toBe(false);
    expect(checkResponsePolicy({
      ...RESPONSE,
      bands: [{ upToRating: 5, withinHours: 0, businessHoursOnly: false, priority: 1, reason: "x" }],
    }).ok).toBe(false);
  });

  it("refuses an office that closes before it opens, or at the same moment", () => {
    expect(checkResponsePolicy({ ...RESPONSE, openHour: 17, closeHour: 8 }).ok).toBe(false);
    expect(checkResponsePolicy({ ...RESPONSE, openHour: 9, closeHour: 9 }).ok).toBe(false);
  });

  it("refuses bands that are out of order even when they still reach five", () => {
    /**
     * The reversed band case passes for the wrong reason: reversed bands stop
     * at one, so the "stops below five" rule catches them and the ordering
     * rule is never reached. These reach five and are still out of order, and
     * `bandFor` walks the list in order, so an unordered list hands a one star
     * whatever band happens to sit first.
     */
    const verdict = checkResponsePolicy({
      ...RESPONSE,
      bands: [
        { upToRating: 3, withinHours: 24, businessHoursOnly: true, priority: 1, reason: "x" },
        { upToRating: 1, withinHours: 4, businessHoursOnly: true, priority: 2, reason: "y" },
        { upToRating: 5, withinHours: 168, businessHoursOnly: false, priority: 3, reason: "z" },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("out of order");
  });

  it("refuses a business day that is not a day of the week", () => {
    expect(checkResponsePolicy({ ...RESPONSE, businessDays: [1, 2, 7] }).ok).toBe(false);
    expect(checkResponsePolicy({ ...RESPONSE, businessDays: [-1, 3] }).ok).toBe(false);
    expect(checkResponsePolicy({ ...RESPONSE, businessDays: [1, 2.5] }).ok).toBe(false);
  });

  it("leaves a rating no band covers off the list rather than guessing a deadline", () => {
    expect(bandFor(6, RESPONSE)).toBeNull();
    const list = responseWorkList(
      [review({ id: "six", rating: 6 }), review({ id: "one", rating: 1 })],
      RESPONSE, new Date("2026-06-16T15:00:00Z"));
    expect(list.map((item) => item.review.id)).toEqual(["one"]);
  });

  it("breaks a tie on the band's priority when two reviews fall due together", () => {
    // The only comparator in the work list sort that separates anything the
    // next one would not: `now` is fixed, so most overdue first and earliest
    // deadline first are the same order, always.
    const flat: ResponsePolicy = {
      ...RESPONSE,
      bands: [
        { upToRating: 1, withinHours: 24, businessHoursOnly: false, priority: 1, reason: "the one star" },
        { upToRating: 5, withinHours: 24, businessHoursOnly: false, priority: 2, reason: "everything else" },
      ],
    };
    expect(checkResponsePolicy(flat).ok).toBe(true);
    const postedAt = new Date("2026-06-08T14:00:00Z");
    const list = responseWorkList(
      [review({ id: "five", rating: 5, postedAt }), review({ id: "one", rating: 1, postedAt })],
      flat, new Date("2026-06-16T15:00:00Z"));
    expect(list[0]?.dueAt.getTime()).toBe(list[1]?.dueAt.getTime());
    expect(list.map((item) => item.review.id)).toEqual(["one", "five"]);
  });

  it("builds a deadline across a clock change from the wall clock, not from milliseconds", () => {
    /**
     * A desk staffed round the clock, and four open hours from half past
     * midnight on the morning the clocks go back in Chicago. The office clock
     * reads half past four when the deadline lands. Adding four hours of
     * milliseconds to the posting instant reads half past three, because that
     * night has twenty five hours in it, and the deadline would then fall an
     * hour before the one the office recognises.
     */
    const desk: ResponsePolicy = {
      timeZone: "America/Chicago",
      businessDays: [0, 1, 2, 3, 4, 5, 6],
      openHour: 0,
      closeHour: 24,
      bands: [{ upToRating: 5, withinHours: 4, businessHoursOnly: true, priority: 1, reason: "round the clock" }],
    };
    expect(checkResponsePolicy(desk).ok).toBe(true);
    const dueAt = respondBy(new Date("2026-11-01T05:30:00Z"), bandFor(1, desk)!, desk);
    expect(dueAt.toISOString()).toBe("2026-11-01T10:30:00.000Z");
    expect(dueAt.toISOString()).not.toBe("2026-11-01T09:30:00.000Z");
  });

  it("opens an hour late rather than not at all when the opening hour never happened", () => {
    /**
     * An overnight desk that opens at two. On the morning the clocks go
     * forward in Chicago there is no two o'clock. Without the fallback the
     * opening instant resolves to one in the morning, which is before opening,
     * and the search walks in place until it hits its bound and hands back a
     * deadline hours out.
     */
    const night: ResponsePolicy = {
      timeZone: "America/Chicago",
      businessDays: [0, 1, 2, 3, 4, 5, 6],
      openHour: 2,
      closeHour: 10,
      bands: [{ upToRating: 5, withinHours: 4, businessHoursOnly: true, priority: 1, reason: "overnight" }],
    };
    // Posted on the Saturday afternoon, long after the desk shut. Sunday opens
    // at three, and four open hours later is seven in the morning.
    const dueAt = respondBy(new Date("2026-03-07T20:00:00Z"), bandFor(1, night)!, night);
    expect(dueAt.toISOString()).toBe("2026-03-08T12:00:00.000Z");
  });

  it("accepts the policy it ships with", () => {
    expect(checkResponsePolicy(RESPONSE).ok).toBe(true);
  });
});

/* ================================================================== */

const declared = (policies: PlatformPolicy[]) => {
  const verdict = checkPlatformPolicies(policies);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.byPlatform;
};

const plan = (over: Partial<Parameters<typeof checkPlannedRequest>[0]> = {}) => ({
  platform: "primary",
  offersIncentive: false,
  isBulkSend: false,
  askedOnSite: false,
  sentByThirdParty: false,
  ...over,
});

describe("what each platform forbids", () => {
  it("refuses to send to a platform nobody has declared anything about", () => {
    // The same default the telephony module takes for an undeclared
    // jurisdiction. Refusing costs a line of configuration. Allowing costs a
    // listing.
    const verdict = checkPlannedRequest(plan({ platform: "somewhere-new" }), declared([]));
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.prohibition).toBeNull();
    expect(!verdict.ok && verdict.reason).toContain("somewhere-new");
  });

  it("refuses an incentive where the operator declared it is not allowed, naming the rule", () => {
    const policies = declared([
      { platform: "primary", prohibits: ["incentives"], note: "Terms read 2026-05-01." },
    ]);
    const verdict = checkPlannedRequest(plan({ offersIncentive: true }), policies);
    expect(!verdict.ok && verdict.prohibition).toBe("incentives");
    expect(!verdict.ok && verdict.reason).toContain("removed");
  });

  it("allows the same request on a platform that declares no such rule", () => {
    /**
     * The point of taking the rules as configuration. This file has no
     * opinion about what any named company allows, and an operator who has
     * read the terms is the one who decides.
     */
    const policies = declared([
      { platform: "primary", prohibits: ["bulk_requests"], note: "Terms read 2026-05-01." },
    ]);
    expect(checkPlannedRequest(plan({ offersIncentive: true }), policies).ok).toBe(true);
    expect(checkPlannedRequest(plan({ isBulkSend: true }), policies).ok).toBe(false);
  });

  it("reports the most serious rule when a request breaks two", () => {
    const policies = declared([
      { platform: "primary", prohibits: [...PROHIBITIONS], note: "Terms read 2026-05-01." },
    ]);
    const verdict = checkPlannedRequest(
      plan({ offersIncentive: true, askedOnSite: true }), policies);
    expect(!verdict.ok && verdict.prohibition).toBe("incentives");
  });

  it("checks a reply as well as a request, because the rules differ", () => {
    const policies = declared([
      { platform: "primary", prohibits: ["templated_replies"], note: "Terms read 2026-05-01." },
    ]);
    expect(checkPlannedReply({ platform: "primary", isTemplated: true }, policies).ok).toBe(false);
    expect(checkPlannedReply({ platform: "primary", isTemplated: false }, policies).ok).toBe(true);
    expect(checkPlannedReply({ platform: "other", isTemplated: false }, policies).ok).toBe(false);
  });

  it("refuses two policies for the same platform", () => {
    // With both in place, which rules apply depends on the order the file
    // happened to be read in.
    const verdict = checkPlatformPolicies([
      { platform: "primary", prohibits: [], note: "One." },
      { platform: "primary", prohibits: ["incentives"], note: "Two." },
    ]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("two policies");
  });

  it("refuses a rule this build does not know, rather than ignoring it", () => {
    const verdict = checkPlatformPolicies([
      { platform: "primary", prohibits: ["no_reviews_on_tuesdays" as never], note: "Read." },
    ]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("no_reviews_on_tuesdays");
  });

  it("refuses a policy with no platform and one with no note", () => {
    expect(checkPlatformPolicies([{ platform: "  ", prohibits: [], note: "Read." }]).ok).toBe(false);
    expect(checkPlatformPolicies([{ platform: "primary", prohibits: [], note: " " }]).ok).toBe(false);
  });

  it("gives every rule a consequence, because that is what the settings screen shows", () => {
    for (const rule of PROHIBITIONS) {
      expect(PROHIBITION[rule].label.length, rule).toBeGreaterThan(0);
      expect(PROHIBITION[rule].description.length, rule).toBeGreaterThan(20);
      expect(PROHIBITION[rule].consequence.length, rule).toBeGreaterThan(40);
    }
  });

  it("offers no switch anywhere for asking only the customers expected to be kind", () => {
    /**
     * Everything in the prohibition table is something an operator can turn
     * off. The one rule that is not configurable at any setting is therefore
     * deliberately not in it, and this test is what stops it being added
     * there as a compromise.
     */
    for (const rule of PROHIBITIONS) {
      for (const word of wordsIn(rule)) {
        expect(BANNED.has(word), rule).toBe(false);
      }
    }
  });
});
