import { describe, it, expect } from "vitest";
import {
  shareTouches, weightText, leadKey, callerKey, checkChannel, checkTrackingCampaign,
  proratedCost, daysBetween, funnelFigures, attribute, WEIGHT_SCALE, SEED_CHANNELS, creditAcross,
  LEAD_SOURCE_KEYS, DEFAULT_ATTRIBUTION_MODEL, ATTRIBUTION_MODEL_KEYS,
  type Touch, type LeadSourceKey,
} from "../src/marketing/index.js";
import { checkBody, firstNameOf, mergeScope, placeholdersIn, MERGE_FIELDS } from "../src/campaign/index.js";
import { money, toString as moneyString, add, zero } from "../src/money/index.js";

const usd = (v: string) => money(v, "USD");

const touch = (source: LeadSourceKey, iso: string): Touch => ({
  at: new Date(iso), source, basis: "utm", utm: {}, referrerHost: null, clickId: null, campaign: null,
});

/**
 * A REPORT BY CAMPAIGN NEEDS TO KNOW WHICH TOUCH EARNED THE CREDIT
 *
 * `attribute` answers per source. Two calls on two different tracking numbers
 * can both be Google Ads, and the campaign report has to split between them,
 * so these check the per touch answer against the per source one.
 */
describe("what each touch earns", () => {
  const touches = [
    touch("google_ads", "2026-04-03T10:00:00Z"),
    touch("direct", "2026-04-01T10:00:00Z"),
    touch("google_ads", "2026-04-05T10:00:00Z"),
  ];

  it("refuses with nothing recorded, in a sentence", () => {
    const decision = shareTouches("last_touch", []);
    expect(decision.ok).toBe(false);
  });

  it("points at the right touch by its position in the list as passed, not as sorted", () => {
    const first = shareTouches("first_touch", touches);
    expect(first.ok && first.shares).toEqual([{ index: 1, weight: WEIGHT_SCALE }]);
    const last = shareTouches("last_touch", touches);
    expect(last.ok && last.shares).toEqual([{ index: 2, weight: WEIGHT_SCALE }]);
  });

  it("sums to exactly one job under every model, including a three way split", () => {
    for (const model of ATTRIBUTION_MODEL_KEYS) {
      const decision = shareTouches(model, touches);
      expect(decision.ok).toBe(true);
      if (!decision.ok) continue;
      expect(decision.shares.reduce((sum, s) => sum + s.weight, 0)).toBe(WEIGHT_SCALE);
    }
    const even = shareTouches("linear", touches);
    expect(even.ok && even.shares.map((s) => s.weight)).toEqual([3334, 3333, 3333]);
  });

  it("agrees with the per source answer about who got what", () => {
    for (const model of ATTRIBUTION_MODEL_KEYS) {
      const perTouch = shareTouches(model, touches);
      const perSource = attribute(model, touches);
      if (!perTouch.ok || !perSource.ok) throw new Error("both should attribute");
      const bySource = new Map<string, number>();
      for (const share of perTouch.shares) {
        const source = touches[share.index]!.source;
        bySource.set(source, (bySource.get(source) ?? 0) + share.weight);
      }
      for (const credit of perSource.credits) {
        expect(bySource.get(credit.source)! / WEIGHT_SCALE)
          .toBeCloseTo(credit.parts / perSource.totalParts, 3);
      }
    }
  });

  it("skips the direct visit under last non direct, which is the default", () => {
    expect(DEFAULT_ATTRIBUTION_MODEL).toBe("last_non_direct");
    const decision = shareTouches("last_non_direct", [
      touch("google_ads", "2026-04-01T10:00:00Z"),
      touch("direct", "2026-04-02T10:00:00Z"),
    ]);
    expect(decision.ok && decision.shares).toEqual([{ index: 0, weight: WEIGHT_SCALE }]);
  });

  it("reads a weight the way a person would", () => {
    expect(weightText(WEIGHT_SCALE * 3)).toBe("3");
    expect(weightText(5000)).toBe("0.5");
    expect(weightText(13333)).toBe("1.33");
  });
});

/**
 * A LEAD IS CREDITED THE WAY A JOB IS
 *
 * The funnel used to count a person as a whole lead on every channel they
 * touched, so the rows added up to more people than there were. `creditAcross`
 * is the one function a job and a lead are both credited by, so these check it
 * the way the job's own credit is checked: the credit always adds back to one,
 * under every model, and nothing recorded is "not placed", never direct.
 */
describe("one person's credit across the rows of a report", () => {
  const touches = [
    touch("google_ads", "2026-04-03T10:00:00Z"),
    touch("direct", "2026-04-01T10:00:00Z"),
    touch("meta_ads", "2026-04-05T10:00:00Z"),
    touch("google_ads", "2026-04-06T10:00:00Z"),
  ];
  const rowOf = (i: number) => touches[i]!.source;

  it("adds back to exactly one person under every model", () => {
    for (const model of ATTRIBUTION_MODEL_KEYS) {
      const credit = creditAcross(model, touches, rowOf, "none");
      expect(credit.reduce((sum, c) => sum + c.weight, 0), model).toBe(WEIGHT_SCALE);
    }
  });

  it("gives a person to one row under a model that picks one touch", () => {
    expect(creditAcross("first_touch", touches, rowOf, "none")).toEqual([{ bucket: "direct", weight: WEIGHT_SCALE }]);
    expect(creditAcross("last_touch", touches, rowOf, "none")).toEqual([{ bucket: "google_ads", weight: WEIGHT_SCALE }]);
    expect(creditAcross("last_non_direct", touches, rowOf, "none")).toEqual([{ bucket: "google_ads", weight: WEIGHT_SCALE }]);
  });

  it("splits a person across rows under an even split, and two touches on one row add up on it", () => {
    expect(creditAcross("linear", touches, rowOf, "none")).toEqual([
      { bucket: "direct", weight: 2500 },
      { bucket: "google_ads", weight: 5000 },
      { bucket: "meta_ads", weight: 2500 },
    ]);
  });

  it("weights the first and the last under the weighted split", () => {
    /** In time order the four touches weigh 80, 20, 20 and 80 of 200: the first and the last two fifths each. */
    expect(creditAcross("position_based", touches, rowOf, "none")).toEqual([
      { bucket: "direct", weight: 4000 },
      { bucket: "google_ads", weight: 1000 + 4000 },
      { bucket: "meta_ads", weight: 1000 },
    ]);
  });

  it("says where a person with nothing recorded goes, and never to direct", () => {
    for (const model of ATTRIBUTION_MODEL_KEYS) {
      expect(creditAcross(model, [], () => "direct", "none"), model).toEqual([{ bucket: "none", weight: WEIGHT_SCALE }]);
    }
  });

  it("splits by the largest remainder, so three rows add back to one with the extra on the earlier row", () => {
    const three = [
      touch("google_ads", "2026-04-01T10:00:00Z"),
      touch("meta_ads", "2026-04-02T10:00:00Z"),
      touch("radio", "2026-04-03T10:00:00Z"),
    ];
    const credit = creditAcross("linear", three, (i) => three[i]!.source, "none");
    expect(credit.map((c) => c.weight).sort()).toEqual([3333, 3333, 3334]);
    expect(credit.reduce((sum, c) => sum + c.weight, 0)).toBe(WEIGHT_SCALE);
    expect(credit.find((c) => c.bucket === "google_ads")!.weight).toBe(3334);
  });

  it("does not depend on the order the touches were handed in, only on when they happened", () => {
    const shuffled = [touches[3]!, touches[0]!, touches[2]!, touches[1]!];
    for (const model of ATTRIBUTION_MODEL_KEYS) {
      expect(creditAcross(model, shuffled, (i) => shuffled[i]!.source, "none"), model)
        .toEqual(creditAcross(model, touches, rowOf, "none"));
    }
  });

  it("credits the same rows a job's touches would be credited, because it is the one function", () => {
    for (const model of ATTRIBUTION_MODEL_KEYS) {
      const decision = shareTouches(model, touches);
      if (!decision.ok) throw new Error("should credit");
      const byRow = new Map<string, number>();
      for (const share of decision.shares) byRow.set(rowOf(share.index), (byRow.get(rowOf(share.index)) ?? 0) + share.weight);
      expect(new Map(creditAcross(model, touches, rowOf, "none").map((c) => [c.bucket, c.weight])), model).toEqual(byRow);
    }
  });
});

describe("the ratios when a person is split across rows", () => {
  it("divide by a fraction of a person as exactly as by a fraction of a job", () => {
    const figures = funnelFigures({
      spend: usd("100.00"), leads: 2.5, bookedWeight: 5_000, invoicedWeight: 5_000, revenue: usd("250.00"),
    });
    expect(figures.bookingRate).toBe("20.00");
    expect(moneyString(figures.costPerLead!)).toBe("40.0000");
  });

  it("still has no cost per lead with no leads, however small the share rounds", () => {
    const figures = funnelFigures({
      spend: usd("100.00"), leads: 0.00001, bookedWeight: 0, invoicedWeight: 0, revenue: zero("USD"),
    });
    expect(figures.costPerLead).toBeNull();
    expect(figures.bookingRate).toBeNull();
  });
});

describe("who a lead is", () => {
  it("is the customer, else the number that rang, else the browser", () => {
    expect(leadKey({ customerId: "c1", callerE164: "+15125550100", visitorId: "v" })).toBe("customer:c1");
    expect(leadKey({ callerE164: "+15125550100", visitorId: "v" })).toBe("caller:+15125550100");
    expect(leadKey({ visitorId: "v" })).toBe("visitor:v");
    expect(leadKey({})).toBeNull();
  });

  it("stitches a number however it was typed, and nothing that is not a number", () => {
    expect(callerKey("(512) 555-0134")).toBe("+15125550134");
    expect(callerKey("+1 512 555 0134")).toBe("+15125550134");
    expect(callerKey("15125550134")).toBe("+15125550134");
    expect(callerKey("Anonymous")).toBeNull();
    expect(callerKey("")).toBeNull();
  });
});

describe("a channel", () => {
  it("must map to a key every report knows", () => {
    expect(checkChannel({ name: " Angi ", sourceKey: "marketplace" })).toEqual({ ok: true, name: "Angi", sourceKey: "marketplace" });
    expect(checkChannel({ name: "Angi", sourceKey: "angi" }).ok).toBe(false);
    expect(checkChannel({ name: "  ", sourceKey: "marketplace" }).ok).toBe(false);
  });

  it("is seeded one per catalogue key, without the not recognised bucket", () => {
    expect(SEED_CHANNELS.map((c) => c.sourceKey)).toEqual(LEAD_SOURCE_KEYS.filter((k) => k !== "unknown"));
  });
});

describe("a tracking campaign", () => {
  it("normalises its utm tag and keeps what was given", () => {
    const verdict = checkTrackingCampaign({
      name: "Spring AC tune up", costModel: "recorded", utmCampaign: "Spring Tune Up", budget: "1500",
      startsOn: "2026-04-01", endsOn: "2026-04-30",
    });
    expect(verdict).toMatchObject({ ok: true, utmCampaign: "spring_tune_up", budget: "1500", costAmount: null });
  });

  it("refuses the campaigns that look fine on the form and are wrong in the report", () => {
    const fixed = checkTrackingCampaign({ name: "Radio", costModel: "fixed", costAmount: "900" });
    expect(fixed.ok).toBe(false);
    const perLead = checkTrackingCampaign({ name: "LSA", costModel: "per_lead" });
    expect(perLead.ok).toBe(false);
    const recordedWithPrice = checkTrackingCampaign({ name: "Ads", costModel: "recorded", costAmount: "10" });
    expect(recordedWithPrice.ok).toBe(false);
    const backwards = checkTrackingCampaign({
      name: "Backwards", costModel: "recorded", startsOn: "2026-05-01", endsOn: "2026-04-01",
    });
    expect(backwards.ok).toBe(false);
    const notADay = checkTrackingCampaign({ name: "Feb", costModel: "recorded", startsOn: "2026-02-31" });
    expect(notADay.ok).toBe(false);
  });
});

describe("a fixed price over part of its days", () => {
  const campaign = { startsOn: "2026-04-01", endsOn: "2026-04-30" };

  it("counts the calendar", () => {
    expect(daysBetween("2026-04-01", "2026-04-30")).toBe(30);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(2);
  });

  it("carries part of the cost into part of the campaign, and adjacent ranges add back to the whole", () => {
    const total = usd("1000.00");
    const first = proratedCost(total, campaign, { from: "2026-03-15", to: "2026-04-10" });
    const second = proratedCost(total, campaign, { from: "2026-04-11", to: "2026-05-20" });
    expect(first.daysInRange).toBe(10);
    expect(second.daysInRange).toBe(20);
    expect(moneyString(add(first.amount, second.amount))).toBe("1000.0000");
    expect(moneyString(first.amount)).toBe("333.4000");
  });

  it("is nothing outside the campaign", () => {
    expect(proratedCost(usd("500"), campaign, { from: "2026-06-01", to: "2026-06-30" }).amount)
      .toEqual(zero("USD"));
  });
});

describe("the ratios on a funnel row", () => {
  it("are null rather than zero wherever the denominator is empty", () => {
    const figures = funnelFigures({
      spend: zero("USD"), leads: 0, bookedWeight: 0, invoicedWeight: 0, revenue: zero("USD"),
    });
    expect(figures).toEqual({
      bookingRate: null, averageTicket: null, costPerLead: null, costPerBookedJob: null, roas: null, roi: null,
    });
  });

  it("work in whole and split jobs without a float", () => {
    const figures = funnelFigures({
      spend: usd("300.00"), leads: 4, bookedWeight: 15_000, invoicedWeight: 15_000, revenue: usd("1200.00"),
    });
    expect(figures.bookingRate).toBe("37.50");
    expect(moneyString(figures.costPerLead!)).toBe("75.0000");
    expect(moneyString(figures.costPerBookedJob!)).toBe("200.0000");
    expect(moneyString(figures.averageTicket!)).toBe("800.0000");
    expect(figures.roas).toBe("4.0000");
    expect(figures.roi).toBe("300.00");
  });

  it("says a losing channel lost", () => {
    const figures = funnelFigures({
      spend: usd("500.00"), leads: 2, bookedWeight: WEIGHT_SCALE, invoicedWeight: WEIGHT_SCALE, revenue: usd("200.00"),
    });
    expect(figures.roi).toBe("-60.00");
    expect(figures.roas).toBe("0.4000");
  });

  it("does not refuse more booked jobs than leads, which a date range produces honestly", () => {
    const figures = funnelFigures({
      spend: usd("100"), leads: 1, bookedWeight: 2 * WEIGHT_SCALE, invoicedWeight: 0, revenue: zero("USD"),
    });
    expect(figures.bookingRate).toBe("200.00");
  });
});

describe("merge fields in a campaign body", () => {
  it("fills in only what the list says it can", () => {
    expect(MERGE_FIELDS.map((f) => f.key)).toContain("customer.firstName");
    expect(placeholdersIn("Hi {{ customer.firstName }}, {{company.name}} here")).toEqual(["customer.firstName", "company.name"]);
    expect(checkBody({ channel: "sms", body: "Hi {{ customer.firstName }}" })).toEqual({ ok: true });
    const typo = checkBody({ channel: "sms", body: "Hi {{ custmer.firstName }}" });
    expect(typo.ok).toBe(false);
    if (!typo.ok) expect(typo.refusals[0]!.reason).toBe("unknown_field");
  });

  it("calls a person by the first word of their name", () => {
    expect(firstNameOf("  Maria   Lopez ")).toBe("Maria");
    expect(mergeScope({ customerName: "Maria Lopez", companyName: "Hartley" })).toEqual({
      customer: { firstName: "Maria", name: "Maria Lopez" },
      company: { name: "Hartley", phone: "" },
    });
  });
});
