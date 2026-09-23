import { describe, it, expect } from "vitest";
import {
  LEAD_SOURCES, LEAD_SOURCE_KEYS, leadSource, leadSourceLabel, resolveSource,
  parseQuery, referrerHost, parseTouch,
  ATTRIBUTION_MODELS, ATTRIBUTION_MODEL_KEYS, attribute, creditRevenue,
  compareModels, modelsAgree, percentOf, ratio,
  checkForm, checkSubmission,
  summariseSpend,
  type Touch, type FormDefinition, type LeadSourceKey,
} from "../src/marketing/index.js";
import { money, toString as moneyString, add as addMoney } from "../src/money/index.js";

const usd = (v: string) => money(v, "USD");

/**
 * Touches are built by hand here rather than parsed, so an attribution test
 * fails for an attribution reason. A model test that goes red because a UTM
 * alias changed is a test that teaches people to ignore it.
 */
const touch = (source: LeadSourceKey, iso: string): Touch => ({
  at: new Date(iso),
  source,
  basis: "utm",
  utm: {},
  referrerHost: null,
  clickId: null,
  campaign: null,
});

/* ------------------------------------------------------------ 1. sources */

describe("the lead source catalogue", () => {
  it("collapses every spelling of one source onto one key", () => {
    /**
     * The failure this exists to prevent, and it is the whole reason the
     * catalogue is closed: three CSRs and two ad platforms produce "google
     * ads", "Google-Ads", "GoogleAds" and "adwords" within a month. Grouped
     * by raw text, the campaign that booked forty thousand dollars becomes
     * four rows of ten and ranks below the yard signs.
     */
    for (const spelling of ["google ads", "Google Ads", "Google-Ads", "GoogleAds", "  google_ads  ", "adwords"]) {
      const resolved = resolveSource(spelling);
      expect(resolved.ok, spelling).toBe(true);
      expect(resolved.ok && resolved.source, spelling).toBe("google_ads");
    }
  });

  it("refuses a source it does not know rather than inventing one", () => {
    // A resolver that quietly returned "unknown" would be the free text
    // column again with extra steps. The point is that somebody is told the
    // catalogue has a gap, so the alias gets added and every historical
    // report built on the raw text starts being right.
    const resolved = resolveSource("carrier pigeon");
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.reason).toBe("unrecognised");
    expect(!resolved.ok && resolved.detail.length).toBeGreaterThan(20);
  });

  it("offers near misses so the refusal is something a person can act on", () => {
    const resolved = resolveSource("yardsigns");
    expect(!resolved.ok && resolved.suggestions).toContain("yard_sign");
  });

  it("refuses a bare vendor name that could be paid or free", () => {
    /**
     * `utm_source=google` is the commonest tag in the wild and means nothing
     * alone. Guessing paid moves budget toward a channel that was working for
     * free; guessing organic hides the ad spend completely.
     */
    const resolved = resolveSource("google");
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.suggestions).toEqual(["google_ads", "organic_search"]);
  });

  it("reads the medium beside it to tell a paid click from a free one", () => {
    expect(resolveSource("google", "cpc").ok && resolveSource("google", "cpc")).toMatchObject({ source: "google_ads" });
    expect(resolveSource("google", "organic")).toMatchObject({ source: "organic_search" });
    expect(resolveSource("facebook", "paid_social")).toMatchObject({ source: "meta_ads" });
    expect(resolveSource("facebook", "social")).toMatchObject({ source: "organic_social" });
  });

  it("refuses an empty source instead of calling it direct", () => {
    // An empty source is a fact: nobody recorded one. Turning it into a
    // channel is how "direct" becomes the biggest line in the business.
    expect(resolveSource("   ").ok).toBe(false);
    expect(resolveSource("").ok).toBe(false);
  });

  it("describes every source, because the screen has to name them", () => {
    for (const spec of LEAD_SOURCES) {
      expect(spec.label.length, spec.key).toBeGreaterThan(0);
      expect(spec.meaning.length, spec.key).toBeGreaterThan(20);
      expect(leadSource(spec.key)).toBe(spec);
    }
    expect(new Set(LEAD_SOURCE_KEYS).size).toBe(LEAD_SOURCES.length);
  });

  it("keeps direct and unrecognised as two different answers", () => {
    /**
     * Collapsing them makes a data quality problem look like customer
     * loyalty, which is the most flattering possible way to be wrong.
     */
    expect(leadSource("direct").category).toBe("unattributed");
    expect(leadSource("unknown").category).toBe("unattributed");
    expect(leadSource("direct").meaning).not.toBe(leadSource("unknown").meaning);
  });

  it("marks the sources that can never carry a tag", () => {
    // A yard sign will never appear in the attribution numbers however good
    // the tracking gets. Saying so in the data beats every owner
    // rediscovering it on their own.
    for (const key of ["yard_sign", "vehicle_wrap", "direct_mail", "radio"] as LeadSourceKey[]) {
      expect(leadSource(key).taggable, key).toBe(false);
      expect(leadSource(key).paid, key).toBe(true);
    }
    expect(leadSource("google_ads").taggable).toBe(true);
  });

  it("shows a key from outside the catalogue rather than a blank", () => {
    // It arrived from an import, and a reader is better served by seeing it.
    expect(leadSourceLabel("some_old_import")).toBe("some old import");
    expect(leadSourceLabel("google_ads")).toBe("Google Ads");
  });
});

/* ------------------------------------------------------------ 2. touches */

describe("reading a query string", () => {
  it("does not throw on an escape sequence that will not decode", () => {
    /**
     * `decodeURIComponent("%E0%A4%A")` throws. A throw here is a lost lead:
     * somebody filled in a form, the parse blew up, and they never heard
     * back. The broken value is kept exactly as it arrived instead.
     */
    expect(() => parseQuery("?utm_source=%E0%A4%A&utm_medium=cpc")).not.toThrow();
    const parsed = parseQuery("?utm_source=%E0%A4%A&utm_medium=cpc");
    expect(parsed["utm_source"]).toBe("%E0%A4%A");
    expect(parsed["utm_medium"]).toBe("cpc");
  });

  it("decodes the ordinary escapes and reads a plus as a space", () => {
    expect(parseQuery("utm_campaign=spring%20tune%20up")["utm_campaign"]).toBe("spring tune up");
    expect(parseQuery("utm_campaign=spring+tune+up")["utm_campaign"]).toBe("spring tune up");
  });

  it("keeps the first of two copies of the same tag", () => {
    // A duplicated utm_source is a redirect chain appending a second one, and
    // the first is the one the click actually carried.
    expect(parseQuery("utm_source=google&utm_source=newsletter")["utm_source"]).toBe("google");
  });

  it("will not walk into the prototype", () => {
    // A query string is free to write and the damage is not. Same rule as the
    // workflow condition paths next door.
    const parsed = parseQuery("__proto__[x]=1&utm_source=google");
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("survives the shapes that are not really query strings", () => {
    expect(parseQuery("")).toEqual({});
    expect(parseQuery("?")).toEqual({});
    expect(parseQuery("&&&")).toEqual({});
    expect(parseQuery("utm_source")).toEqual({ utm_source: "" });
  });
});

describe("reading a referrer", () => {
  it("strips the scheme, the www and the port", () => {
    expect(referrerHost("https://WWW.Example.com:8443/pricing?x=1")).toBe("example.com");
    expect(referrerHost("example.com")).toBe("example.com");
  });

  it("does not throw on the referrers browsers actually send", () => {
    // An app referrer has no host at all in the usual sense, and a URL parser
    // throwing on it would take the whole lead with it.
    expect(() => referrerHost("android-app://com.google.android.gm")).not.toThrow();
    expect(referrerHost("")).toBeNull();
    expect(referrerHost("   ")).toBeNull();
  });
});

describe("turning a visit into a touch", () => {
  const at = new Date("2026-03-01T10:00:00Z");

  it("takes the tag when somebody tagged it on purpose", () => {
    const result = parseTouch({ at, query: "?utm_source=google&utm_medium=cpc&utm_campaign=spring" });
    expect(result.source).toBe("google_ads");
    expect(result.basis).toBe("utm");
    expect(result.campaign).toBe("spring");
  });

  it("settles a bare utm_source=google with the click id", () => {
    /**
     * The most common real tag in a contractor's account: auto-tagging adds a
     * gclid and somebody hand wrote utm_source=google with no medium. Without
     * the click id this is genuinely ambiguous, and calling it organic would
     * hide the entire ad spend.
     */
    const result = parseTouch({ at, query: "?utm_source=google&gclid=EAIaIQob" });
    expect(result.source).toBe("google_ads");
    expect(result.basis).toBe("click_id");
  });

  it("reads the click ids that replaced gclid on iPhones", () => {
    // A parser that only knows gclid loses most of the iOS traffic, which in
    // this trade is most of the homeowners.
    expect(parseTouch({ at, query: "?gbraid=abc" }).source).toBe("google_ads");
    expect(parseTouch({ at, query: "?wbraid=abc" }).source).toBe("google_ads");
    expect(parseTouch({ at, query: "?msclkid=abc" }).source).toBe("bing_ads");
    expect(parseTouch({ at, query: "?fbclid=abc" }).source).toBe("meta_ads");
  });

  it("calls a tag it cannot place unrecognised, never direct", () => {
    /**
     * THE ONE THAT MATTERS MOST in this section. Falling back to direct here
     * turns "our alias list has a gap" into "our brand is strong", which is
     * the version nobody investigates.
     */
    const result = parseTouch({ at, query: "?utm_source=wibble_media" });
    expect(result.source).toBe("unknown");
    expect(result.basis).toBe("utm");
    expect(result.unrecognised).toBe("wibble_media");
  });

  it("records a touch even when the tag was mangled in transit", () => {
    const result = parseTouch({ at, query: "?utm_source=%E0%A4%A" });
    expect(result.source).toBe("unknown");
    expect(result.unrecognised).toBe("%E0%A4%A");
  });

  it("credits the tracked number, which is the only way a yard sign is ever measured", () => {
    /**
     * Anything physical is invisible to UTMs forever. A number printed on the
     * sign is the entire measurement, and it has to survive being written
     * with brackets on one side and a country code on the other.
     */
    const result = parseTouch({
      at,
      trackedNumber: "(512) 555-0134",
      numberMap: { "+1 512-555-0134": "yard_sign" },
    });
    expect(result.source).toBe("yard_sign");
    expect(result.basis).toBe("tracked_number");
  });

  it("calls a number nobody mapped unrecognised rather than direct", () => {
    // A line somebody bought and forgot to record. The fix is a row in the
    // number map, which only happens if the report says so.
    const result = parseTouch({ at, trackedNumber: "512-555-9999", numberMap: {} });
    expect(result.source).toBe("unknown");
    expect(result.unrecognised).toBe("512-555-9999");
  });

  it("does not count our own page as a referral", () => {
    /**
     * Somebody moving from the pricing page to the booking page is one
     * session. Counting it makes "our own website" the top lead source, and
     * the real first touch disappears behind it.
     */
    const result = parseTouch({
      at, referrer: "https://www.acmeheating.com/pricing", ownHosts: ["acmeheating.com"],
    });
    expect(result.source).toBe("direct");
    expect(result.referrerHost).toBeNull();
  });

  it("places a referring host when there is no tag at all", () => {
    expect(parseTouch({ at, referrer: "https://www.google.com/" }).source).toBe("organic_search");
    expect(parseTouch({ at, referrer: "https://mail.google.com/mail/u/0" }).source).toBe("email");
    expect(parseTouch({ at, referrer: "https://nextdoor.com/p/abc" }).source).toBe("organic_social");
    expect(parseTouch({ at, referrer: "https://www.thumbtack.com/x" }).source).toBe("marketplace");
  });

  it("is direct only when there was genuinely nothing to read", () => {
    const result = parseTouch({ at });
    expect(result.source).toBe("direct");
    expect(result.basis).toBe("none");
    expect(result.unrecognised).toBeUndefined();
  });
});

/* -------------------------------------------------------- 3. attribution */

describe("attributing a lead", () => {
  it("refuses a lead with no touches rather than crediting anything", () => {
    /**
     * THE MOST IMPORTANT TEST IN THE FILE. In the trades this is the
     * commonest case by a distance: they rang the number on the van, or the
     * office typed the job straight in. Every instinct in a reporting system
     * is to hand it to direct so the pie chart adds to a hundred. Doing that
     * makes direct the largest source in the business, an owner concludes the
     * brand is carrying them, and the channel that actually books the work
     * gets cut.
     */
    for (const model of ATTRIBUTION_MODEL_KEYS) {
      const decision = attribute(model, []);
      expect(decision.ok, model).toBe(false);
      expect(!decision.ok && decision.reason, model).toBe("no_touches");
      expect(!decision.ok && decision.detail.length, model).toBeGreaterThan(40);
    }
  });

  it("has first touch and last touch disagree on the same list, which is the finding", () => {
    /**
     * The yard sign case, written out. Somebody sees the sign, searches the
     * company name three days later and books. Last touch gives the job to
     * the ad account; first touch gives it to the sign. Presenting either one
     * alone is how the sign budget gets cut.
     */
    const touches = [touch("yard_sign", "2026-03-01T10:00:00Z"), touch("google_ads", "2026-03-04T09:00:00Z")];
    const first = attribute("first_touch", touches);
    const last = attribute("last_touch", touches);
    expect(first.ok && first.primary).toBe("yard_sign");
    expect(last.ok && last.primary).toBe("google_ads");
    expect(modelsAgree(compareModels(["first_touch", "last_touch"], touches))).toBe(false);
  });

  it("agrees with itself when there is only one touch", () => {
    const touches = [touch("google_ads", "2026-03-01T10:00:00Z")];
    const results = compareModels(ATTRIBUTION_MODEL_KEYS, touches);
    expect(modelsAgree(results)).toBe(true);
    for (const { model, decision } of results) {
      expect(decision.ok && decision.credits.length, model).toBe(1);
      expect(decision.ok && decision.credits[0]!.percent, model).toBe("100.00");
    }
  });

  it("gives a source that touched twice twice the share under an even split", () => {
    // And that is the model's known flaw, not a bug: a channel that retargets
    // eleven times collects eleven shares of a job it did not win.
    const touches = [
      touch("meta_ads", "2026-03-01T10:00:00Z"),
      touch("organic_search", "2026-03-02T10:00:00Z"),
      touch("meta_ads", "2026-03-03T10:00:00Z"),
    ];
    const decision = attribute("linear", touches);
    expect(decision.ok && decision.credits[0]).toMatchObject({ source: "meta_ads", parts: 2, touches: 2, percent: "66.67" });
    expect(decision.ok && decision.credits[1]).toMatchObject({ source: "organic_search", parts: 1, percent: "33.33" });
  });

  it("splits two touches in half rather than quietly losing twenty per cent", () => {
    /**
     * Position based is 40 / 20 / 40. With two touches there is no middle for
     * the twenty to go to, and the obvious implementation leaves the job
     * eighty per cent credited and the report short.
     */
    const decision = attribute("position_based", [
      touch("yard_sign", "2026-03-01T10:00:00Z"),
      touch("google_ads", "2026-03-02T10:00:00Z"),
    ]);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    /**
     * The shares are checked against a WHOLE HUNDRED, not against each other.
     * Two touches at forty apiece also come out as fifty per cent each once
     * the percentages are normalised, so a test that only looked at percent
     * would pass while the job was eighty per cent credited. This exact hole
     * was found by breaking the source on purpose and watching the test stay
     * green.
     */
    expect(decision.totalParts).toBe(100);
    expect(decision.credits.map((c) => c.parts)).toEqual([50, 50]);
    expect(decision.credits.map((c) => c.percent)).toEqual(["50.00", "50.00"]);
  });

  it("gives whole number shares however many touches there are", () => {
    /**
     * Twenty per cent shared between three middle touches is not a whole
     * number of anything, and rounding it is how a report lands on 99.99 and
     * somebody spends an afternoon looking for the missing cent.
     */
    const touches = [
      touch("organic_search", "2026-03-01T10:00:00Z"),
      touch("meta_ads", "2026-03-02T10:00:00Z"),
      touch("email", "2026-03-03T10:00:00Z"),
      touch("marketplace", "2026-03-04T10:00:00Z"),
      touch("google_ads", "2026-03-05T10:00:00Z"),
    ];
    const decision = attribute("position_based", touches);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    for (const credit of decision.credits) {
      expect(Number.isInteger(credit.parts), credit.source).toBe(true);
    }
    expect(decision.credits.reduce((sum, c) => sum + c.parts, 0)).toBe(decision.totalParts);
    const first = decision.credits.find((c) => c.source === "organic_search")!;
    expect(first.percent).toBe("40.00");
  });

  it("skips a direct visit when a real channel is behind it", () => {
    const touches = [
      touch("google_ads", "2026-03-01T10:00:00Z"),
      touch("direct", "2026-03-05T10:00:00Z"),
    ];
    const decision = attribute("last_non_direct", touches);
    expect(decision.ok && decision.primary).toBe("google_ads");
    expect(decision.ok && decision.note).toBeUndefined();
  });

  it("says so when every touch was direct instead of pretending it measured something", () => {
    // Otherwise "last non direct" silently becomes "last touch" and direct
    // reads as a marketing result rather than as an absence of tracking.
    const decision = attribute("last_non_direct", [
      touch("direct", "2026-03-01T10:00:00Z"),
      touch("direct", "2026-03-02T10:00:00Z"),
    ]);
    expect(decision.ok && decision.primary).toBe("direct");
    expect(decision.ok && decision.note).toBeTruthy();
    expect(decision.ok && (decision.note ?? "")).toContain("untracked");
  });

  it("keeps the order of two touches recorded in the same millisecond", () => {
    /**
     * A page view and the form post that follows it routinely share a
     * timestamp. An unstable sort swaps them, which swaps first and last
     * touch, which changes the answer for no reason anybody can see.
     */
    const same = "2026-03-01T10:00:00.000Z";
    const touches = [touch("yard_sign", same), touch("google_ads", same)];
    expect(attribute("first_touch", touches).ok && attribute("first_touch", touches)).toMatchObject({ primary: "yard_sign" });
    expect(attribute("last_touch", touches)).toMatchObject({ primary: "google_ads" });
  });

  it("does not depend on the order the touches were handed to it", () => {
    // A report whose answer changes when rows come back in a different order
    // is one nobody can reconcile against anything.
    const ordered = [touch("meta_ads", "2026-03-01T10:00:00Z"), touch("google_ads", "2026-03-02T10:00:00Z")];
    const shuffled = [ordered[1]!, ordered[0]!];
    expect(attribute("first_touch", shuffled)).toMatchObject({ primary: "meta_ads" });
    expect(attribute("last_touch", shuffled)).toMatchObject({ primary: "google_ads" });
  });

  it("makes every model say what it is wrong about", () => {
    /**
     * Not decoration. A number shown without its caveat is the thing that
     * moves a budget onto the wrong channel, and the caveat has to travel
     * with the model rather than living in a help page.
     */
    for (const key of ATTRIBUTION_MODEL_KEYS) {
      const spec = ATTRIBUTION_MODELS[key];
      expect(spec.label.length, key).toBeGreaterThan(0);
      expect(spec.meaning.length, key).toBeGreaterThan(20);
      expect(spec.wrongAbout.length, key).toBeGreaterThan(80);
    }
    expect(ATTRIBUTION_MODELS.last_touch.wrongAbout).toContain("yard sign");
    expect(ATTRIBUTION_MODELS.first_touch.wrongAbout).toContain("forever");
  });
});

describe("splitting a job's value across the credited sources", () => {
  it("adds back up to the invoice exactly", () => {
    /**
     * Three ways on a hundred dollars is the case that catches it: 33.33
     * three times is 99.99, and a cent lost per job per source is a visible
     * discrepancy against the revenue report by the end of a quarter. That
     * gap costs more trust than the attribution report was ever worth.
     */
    const touches = [
      touch("google_ads", "2026-03-01T10:00:00Z"),
      touch("meta_ads", "2026-03-02T10:00:00Z"),
      touch("organic_search", "2026-03-03T10:00:00Z"),
    ];
    const decision = attribute("linear", touches);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const split = creditRevenue(decision.credits, usd("100.00"));
    expect(split.map((s) => moneyString(s.amount))).toEqual(["33.3400", "33.3300", "33.3300"]);
    const total = split.reduce((sum, s) => addMoney(sum, s.amount), usd("0.00"));
    expect(moneyString(total)).toBe("100.0000");
  });

  it("gives the whole job to the one source when only one is credited", () => {
    const decision = attribute("last_touch", [touch("google_ads", "2026-03-01T10:00:00Z")]);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const split = creditRevenue(decision.credits, usd("8250.00"));
    expect(split).toHaveLength(1);
    expect(moneyString(split[0]!.amount)).toBe("8250.0000");
  });

  it("splits nothing when nothing was credited", () => {
    expect(creditRevenue([], usd("100.00"))).toEqual([]);
  });
});

describe("percentages, computed without a float", () => {
  it("rounds half up at two places", () => {
    expect(percentOf(1, 3)).toBe("33.33");
    expect(percentOf(2, 3)).toBe("66.67");
    expect(percentOf(1, 8)).toBe("12.50");
  });

  it("is zero rather than an error when there is nothing to divide by", () => {
    // Reached through `bookingRate` on a source with no leads, and a thrown
    // error there would take the whole marketing screen down over a row.
    expect(percentOf(0, 0)).toBe("0.00");
  });
});

/* --------------------------------------------------------------- 4. form */

const serviceForm: FormDefinition = {
  key: "service_request",
  title: "Request a visit",
  minimumFillSeconds: 3,
  fields: [
    { key: "full_name", label: "Your name", type: "text", required: true, rules: [{ rule: "max_length", value: 80 }] },
    { key: "phone", label: "Phone", type: "phone", required: true },
    { key: "email", label: "Email", type: "email", required: false },
    { key: "service_address", label: "Where the work is", type: "service_address", required: true },
    { key: "problem", label: "What is wrong", type: "long_text", required: true, rules: [{ rule: "min_length", value: 10 }] },
    {
      key: "trade", label: "What needs doing", type: "choice", required: true,
      options: [{ value: "hvac", label: "Heating or cooling" }, { value: "plumbing", label: "Plumbing" }],
    },
    { key: "sms_consent", label: "Text me when the technician is on the way", type: "consent", required: false },
    { key: "utm_source", label: "", type: "hidden", required: false },
    { key: "company_website", label: "", type: "honeypot", required: false },
  ],
};

const goodValues = () => ({
  full_name: "  Dana Ruiz ",
  phone: "(512) 555-0134",
  email: "Dana.Ruiz@Example.COM",
  service_address: { line1: "1200 Oak St", line2: "Unit B", city: "Austin", state: "tx", postalCode: "78704" },
  problem: "The upstairs unit is blowing warm air and making a clicking noise.",
  trade: "hvac",
  sms_consent: true,
  utm_source: "google",
});

const opened = new Date("2026-03-01T10:00:00Z");
const later = new Date("2026-03-01T10:02:00Z");

describe("a lead form definition", () => {
  it("accepts a form a trades company would actually publish", () => {
    expect(checkForm(serviceForm).ok).toBe(true);
  });

  it("refuses a choice field with nothing to choose from", () => {
    // Four seconds to create in a builder, and silent until a homeowner with
    // a burst pipe meets a dropdown containing nothing.
    const verdict = checkForm({
      ...serviceForm,
      fields: [...serviceForm.fields.filter((f) => f.key !== "trade"), { key: "trade", label: "Trade", type: "choice", required: true, options: [] }],
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.problems.join(" ")).toContain("nothing to choose from");
  });

  it("refuses a form nobody can be rung back from", () => {
    /**
     * A description of a broken furnace with no phone number and no email is
     * not a lead. It is a note about somebody the company cannot contact, and
     * it is what you get by dragging fields onto a page and publishing.
     */
    const verdict = checkForm({
      key: "f", title: "Tell us",
      fields: [{ key: "problem", label: "What is wrong", type: "long_text", required: true }],
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.problems.join(" ")).toContain("not a lead");
  });

  it("refuses two fields that share a key", () => {
    // One silently overwrites the other in the submission, and which one wins
    // depends on the browser.
    const verdict = checkForm({
      key: "f", title: "Tell us",
      fields: [
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "phone", label: "Mobile", type: "phone", required: false },
      ],
    });
    expect(!verdict.ok && verdict.problems.join(" ")).toContain("Two fields");
  });

  it("refuses a hidden field marked required, which no person can satisfy", () => {
    const verdict = checkForm({
      key: "f", title: "Tell us",
      fields: [
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "utm_source", label: "", type: "hidden", required: true },
      ],
    });
    expect(!verdict.ok && verdict.problems.join(" ")).toContain("no person can satisfy");
  });

  it("refuses a rule that does nothing on the field it was put on", () => {
    // A max_length on a number field is a setting somebody saved, believed,
    // and is not protected by.
    const verdict = checkForm({
      key: "f", title: "Tell us",
      fields: [
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "age", label: "How old is the unit", type: "number", required: false, rules: [{ rule: "max_length", value: 2 }] },
      ],
    });
    expect(!verdict.ok && verdict.problems.join(" ")).toContain("does nothing");
  });
});

describe("checking a submission", () => {
  it("cleans up the values it accepts", () => {
    const decision = checkSubmission(serviceForm, { values: goodValues(), startedAt: opened }, later);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.values["full_name"]).toBe("Dana Ruiz");
    /**
     * Ten digits, never as typed. "(512) 555-0134" and "512.555.0134" are the
     * same person: keeping the punctuation makes them two customers, two
     * histories, and a technician ringing back the wrong one.
     */
    expect(decision.values["phone"]).toBe("5125550134");
    expect(decision.values["email"]).toBe("dana.ruiz@example.com");
    expect(decision.values["service_address"]).toEqual({
      line1: "1200 Oak St", line2: "Unit B", city: "Austin", state: "TX", postalCode: "78704",
    });
  });

  it("collects every refusal at once rather than one at a time", () => {
    /**
     * Returning the first refusal makes somebody fix their phone number,
     * submit, and be told about the address. That is the point at which a
     * homeowner with a leak rings the next company on the list instead.
     */
    const values = { ...goodValues(), phone: "555-0134", problem: "broken", trade: "roofing" };
    const decision = checkSubmission(serviceForm, { values, startedAt: opened }, later);
    expect(decision.ok).toBe(false);
    if (decision.ok || decision.reason !== "invalid") throw new Error("expected invalid");
    expect(decision.refusals.map((r) => r.field).sort()).toEqual(["phone", "problem", "trade"]);
    for (const refusal of decision.refusals) {
      // A refusal a homeowner cannot act on is the same as no refusal.
      expect(refusal.message.length, refusal.field).toBeGreaterThan(20);
    }
  });

  it("refuses a required field that was left out", () => {
    const values = { ...goodValues() } as Record<string, unknown>;
    delete values["problem"];
    const decision = checkSubmission(serviceForm, { values, startedAt: opened }, later);
    expect(decision.ok).toBe(false);
    if (decision.ok || decision.reason !== "invalid") throw new Error("expected invalid");
    expect(decision.refusals).toHaveLength(1);
    expect(decision.refusals[0]).toMatchObject({ field: "problem", reason: "required" });
  });

  it("treats whitespace in a required field as nothing", () => {
    // Otherwise a space bar gets somebody past the only question on the form
    // that tells a dispatcher what to send.
    const decision = checkSubmission(serviceForm, { values: { ...goodValues(), problem: "    " }, startedAt: opened }, later);
    expect(decision.ok).toBe(false);
  });

  it("names the missing parts of an address instead of calling it invalid", () => {
    /**
     * A service address is where a van has to go. "Austin" alone cannot be
     * dispatched, priced or assigned to a territory, and a message saying
     * "address is invalid" makes somebody retype the lot and guess which part
     * we did not like.
     */
    const values = { ...goodValues(), service_address: { city: "Austin", state: "TX" } };
    const decision = checkSubmission(serviceForm, { values, startedAt: opened }, later);
    if (decision.ok || decision.reason !== "invalid") throw new Error("expected invalid");
    const refusal = decision.refusals.find((r) => r.field === "service_address")!;
    expect(refusal.reason).toBe("incomplete_address");
    expect(refusal.message).toContain("a street address");
    expect(refusal.message).toContain("a ZIP");
  });

  it("refuses a ZIP that is not one", () => {
    const values = { ...goodValues(), service_address: { line1: "1200 Oak St", city: "Austin", state: "TX", postalCode: "787" } };
    const decision = checkSubmission(serviceForm, { values, startedAt: opened }, later);
    expect(decision.ok).toBe(false);
  });

  it("refuses a field the form does not have rather than dropping what somebody typed", () => {
    /**
     * It means the page they submitted and the definition we hold disagree,
     * which happens whenever a form is edited and a browser still has the old
     * one cached. Dropping it silently loses the customer's answer and the
     * customer never finds out.
     */
    const decision = checkSubmission(serviceForm, { values: { ...goodValues(), gate_code: "1234" }, startedAt: opened }, later);
    if (decision.ok || decision.reason !== "invalid") throw new Error("expected invalid");
    expect(decision.refusals.some((r) => r.reason === "unknown_field" && r.field === "gate_code")).toBe(true);
  });

  it("lets an optional field be left blank", () => {
    const values = { ...goodValues() } as Record<string, unknown>;
    delete values["email"];
    const decision = checkSubmission(serviceForm, { values, startedAt: opened }, later);
    expect(decision.ok).toBe(true);
    expect(decision.ok && "email" in decision.values).toBe(false);
  });

  it("refuses a choice that is not on the form", () => {
    // A value outside the declared options is how a lead ends up in a trade
    // the company does not do, and the options are data for exactly this.
    const decision = checkSubmission(serviceForm, { values: { ...goodValues(), trade: "roofing" }, startedAt: opened }, later);
    if (decision.ok || decision.reason !== "invalid") throw new Error("expected invalid");
    expect(decision.refusals[0]).toMatchObject({ field: "trade", reason: "not_an_option" });
  });

  it("asks for consent in words rather than calling it required", () => {
    // "Required" on a tick box reads as a bug. The honest sentence is that we
    // will not text somebody who did not say we could.
    const consentForm: FormDefinition = {
      key: "f", title: "Tell us",
      fields: [
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "sms_consent", label: "Text me updates", type: "consent", required: true },
      ],
    };
    const decision = checkSubmission(consentForm, { values: { phone: "5125550134", sms_consent: false } });
    if (decision.ok || decision.reason !== "invalid") throw new Error("expected invalid");
    expect(decision.refusals[0]!.reason).toBe("consent_required");
    expect(decision.refusals[0]!.message).not.toContain("required");
  });

  it("refuses a date that means two different days in two different countries", () => {
    /**
     * `new Date("03/04/2026")` is the fourth of March or the third of April
     * depending on where the person typing it lives, and a heating system
     * booked on the wrong day is a van, two hours and a customer.
     */
    const dateForm: FormDefinition = {
      key: "f", title: "When suits",
      fields: [
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "preferred", label: "Preferred day", type: "date", required: true },
      ],
    };
    const bad = checkSubmission(dateForm, { values: { phone: "5125550134", preferred: "03/04/2026" } });
    expect(bad.ok).toBe(false);
    // And a day that does not exist, which a Date would quietly roll forward
    // to the third of March.
    expect(checkSubmission(dateForm, { values: { phone: "5125550134", preferred: "2026-02-31" } }).ok).toBe(false);
    expect(checkSubmission(dateForm, { values: { phone: "5125550134", preferred: "2028-02-29" } }).ok).toBe(true);
  });

  it("applies a named pattern from the catalogue, never a regular expression somebody typed", () => {
    /**
     * The reason patterns are a closed list: a lead form is the one page in a
     * self hosted install open to the whole internet with no login in front
     * of it. A "pattern" box in a builder eventually holds something with
     * nested quantifiers, and then one ordinary looking form post pins a CPU
     * core until the contractor's whole system is killed.
     */
    const zipForm: FormDefinition = {
      key: "f", title: "Check your area",
      fields: [
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "zip", label: "ZIP", type: "text", required: true, rules: [{ rule: "pattern", value: "us_zip" }] },
      ],
    };
    expect(checkSubmission(zipForm, { values: { phone: "5125550134", zip: "78704" } }).ok).toBe(true);
    expect(checkSubmission(zipForm, { values: { phone: "5125550134", zip: "78704-1234" } }).ok).toBe(true);
    expect(checkSubmission(zipForm, { values: { phone: "5125550134", zip: "787" } }).ok).toBe(false);
  });

  it("keeps a tracking value it cannot place instead of refusing the lead", () => {
    // A hidden utm_source is stored as written and resolved later, so a tag
    // nobody has an alias for yet still arrives intact and can be fixed
    // retrospectively. Refusing a lead over its own tracking would be absurd.
    const decision = checkSubmission(serviceForm, { values: { ...goodValues(), utm_source: "wibble_media" }, startedAt: opened }, later);
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.values["utm_source"]).toBe("wibble_media");
  });
});

describe("keeping the robots out without losing real people", () => {
  it("treats a filled honeypot as spam and does not say which field gave it away", () => {
    const decision = checkSubmission(serviceForm, {
      values: { ...goodValues(), company_website: "http://spam.example" }, startedAt: opened,
    }, later);
    expect(decision.ok).toBe(false);
    if (decision.ok || decision.reason !== "spam") throw new Error("expected spam");
    // Naming the field in the response is how the next version of the script
    // gets past it.
    expect(decision.detail).not.toContain("company_website");
  });

  it("refuses a submission sent faster than a person can type an address", () => {
    const decision = checkSubmission(serviceForm, {
      values: goodValues(), startedAt: new Date("2026-03-01T10:00:00Z"),
    }, new Date("2026-03-01T10:00:01Z"));
    if (decision.ok || decision.reason !== "spam") throw new Error("expected spam");
    expect(decision.detail).toContain("seconds");
  });

  it("does not refuse when the page could not say when it was opened", () => {
    /**
     * Some browsers and privacy tools block the script that records it. A
     * lost lead costs the contractor a job; a spam row costs somebody one
     * click, so the missing timestamp has to fail open.
     */
    const decision = checkSubmission(serviceForm, { values: goodValues() }, later);
    expect(decision.ok).toBe(true);
  });
});

/* -------------------------------------------------- 5. spend and return */

describe("spend against return", () => {
  const spend = [
    { source: "google_ads" as const, spend: usd("4000.00") },
    { source: "meta_ads" as const, spend: usd("900.00") },
    { source: "direct_mail" as const, spend: usd("1500.00") },
  ];
  const results = [
    { source: "google_ads" as const, leads: 40, bookedJobs: 10, bookedValue: usd("20000.00") },
    { source: "meta_ads" as const, leads: 12, bookedJobs: 0, bookedValue: usd("0.00") },
    { source: "direct_mail" as const, leads: 0, bookedJobs: 0, bookedValue: usd("0.00") },
    { source: "referral_customer" as const, leads: 9, bookedJobs: 7, bookedValue: usd("31000.00") },
  ];

  const summary = () => {
    const decision = summariseSpend(spend, results);
    if (!decision.ok) throw new Error(`expected a summary, got ${decision.reason}`);
    return decision.summary;
  };

  const row = (source: LeadSourceKey) => summary().rows.find((r) => r.source === source)!;

  it("refuses to divide by zero and never calls a dead channel cheap", () => {
    /**
     * THE CASE THAT MATTERS MOST HERE. Direct mail took fifteen hundred
     * dollars and produced no leads. A cost per lead of zero sorts it to the
     * top of "cheapest channels" and presents the worst line in the account
     * as the best. Infinity poisons the sort, does not survive JSON, and
     * renders as the word "Infinity", which nobody reads as "we got nothing".
     */
    const mail = row("direct_mail");
    expect(mail.costPerLead).toBeNull();
    expect(mail.costPerBookedJob).toBeNull();
    expect(mail.bookingRate).toBeNull();
    expect(mail.verdict.kind).toBe("spend_no_leads");
    expect(mail.verdict.message).toContain("tracking");
  });

  it("separates leads that never booked from no leads at all", () => {
    /**
     * Meta produced twelve leads and booked none. That is a speed to lead
     * problem in the office, not a bad channel, and lumping it in with the
     * direct mail row sends the owner to cancel the wrong thing.
     */
    const meta = row("meta_ads");
    expect(meta.verdict.kind).toBe("leads_no_jobs");
    expect(moneyString(meta.costPerLead!)).toBe("75.0000");
    expect(meta.costPerBookedJob).toBeNull();
    expect(meta.roas).toBe("0.0000");
  });

  it("flags work that booked with no spend recorded against it", () => {
    /**
     * Either referrals genuinely cost nothing, or the spend is sitting in a
     * feed nobody connected. The second one makes every paid channel look
     * worse than it is, and a silent zero hides which it was.
     */
    const referral = row("referral_customer");
    expect(referral.verdict.kind).toBe("return_no_spend");
    // Return on ad spend is null because dividing by no spend has no answer.
    expect(referral.roas).toBeNull();
    /**
     * Cost per lead is genuinely zero here, and that is the one case where a
     * zero is honest: nothing recorded divided by nine leads really is
     * nothing each. The verdict beside it is what stops somebody reading it
     * as "referrals are free" when the truth may be "the spend feed was never
     * connected".
     */
    expect(moneyString(referral.costPerLead!)).toBe("0.0000");
    expect(summary().unpricedSources).toContain("referral_customer");
  });

  it("names the money that bought nothing, with the sources in it", () => {
    // The first number an owner should see, and the one a spreadsheet of
    // averages hides completely.
    const s = summary();
    expect(moneyString(s.wastedSpend)).toBe("2400.0000");
    expect(s.wastedSources.sort()).toEqual(["direct_mail", "meta_ads"]);
  });

  it("computes the ratios exactly, on integers", () => {
    const google = row("google_ads");
    expect(moneyString(google.costPerLead!)).toBe("100.0000");
    expect(moneyString(google.costPerBookedJob!)).toBe("400.0000");
    expect(google.roas).toBe("5.0000");
    expect(google.bookingRate).toBe("25.00");
    expect(google.verdict.kind).toBe("measured");
  });

  it("rounds a cost per lead that does not divide evenly rather than truncating", () => {
    // Compared against a target to two places by somebody who will notice.
    const decision = summariseSpend(
      [{ source: "google_ads", spend: usd("1000.00") }],
      [{ source: "google_ads", leads: 3, bookedJobs: 1, bookedValue: usd("1000.00") }],
    );
    if (!decision.ok) throw new Error("expected a summary");
    expect(moneyString(decision.summary.rows[0]!.costPerLead!)).toBe("333.3333");
  });

  it("adds two rows for the same source rather than letting the last one win", () => {
    /**
     * Two Google Ads accounts, or a manual entry beside an imported one, is
     * the ordinary state of a contractor's marketing. Taking the last row
     * halves the spend and doubles the measured return, which is the
     * direction of error nobody questions.
     */
    const decision = summariseSpend(
      [
        { source: "google_ads", spend: usd("1000.00") },
        { source: "google_ads", spend: usd("3000.00") },
      ],
      [
        { source: "google_ads", leads: 10, bookedJobs: 2, bookedValue: usd("4000.00") },
        { source: "google_ads", leads: 30, bookedJobs: 8, bookedValue: usd("16000.00") },
      ],
    );
    if (!decision.ok) throw new Error("expected a summary");
    expect(decision.summary.rows).toHaveLength(1);
    expect(moneyString(decision.summary.rows[0]!.spend)).toBe("4000.0000");
    expect(decision.summary.rows[0]!.leads).toBe(40);
    expect(decision.summary.rows[0]!.roas).toBe("5.0000");
  });

  it("blends the totals across every source, including the free ones", () => {
    const s = summary();
    expect(moneyString(s.totalSpend)).toBe("6400.0000");
    expect(s.totalLeads).toBe(61);
    expect(s.totalBookedJobs).toBe(17);
    expect(moneyString(s.totalBookedValue)).toBe("51000.0000");
    expect(s.blendedRoas).toBe("7.9688");
  });

  it("puts the biggest spend at the top, deterministically", () => {
    // The report is read to decide where money goes, and a row order that
    // depends on map insertion makes people distrust the whole screen.
    expect(summary().rows.map((r) => r.source)).toEqual([
      "google_ads", "direct_mail", "meta_ads", "referral_customer",
    ]);
  });

  it("refuses two currencies rather than throwing", () => {
    /**
     * A Canadian branch reporting in CAD is a real situation. A thrown error
     * takes down the whole marketing screen instead of naming the row that
     * needs converting, and a ratio across two currencies is a number with no
     * meaning at all.
     */
    const decision = summariseSpend(
      [{ source: "google_ads", spend: money("1000.00", "CAD") }],
      [{ source: "google_ads", leads: 10, bookedJobs: 2, bookedValue: usd("4000.00") }],
    );
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toBe("currency_mismatch");
    expect(!decision.ok && decision.detail).toContain("CAD");
  });

  it("refuses negative spend rather than reporting an infinite return", () => {
    // A refund belongs in the period it was refunded. As negative spend it
    // makes a dead channel look like the best performing one in the account.
    const decision = summariseSpend(
      [{ source: "google_ads", spend: usd("-500.00") }],
      [{ source: "google_ads", leads: 1, bookedJobs: 1, bookedValue: usd("900.00") }],
    );
    expect(!decision.ok && decision.reason).toBe("negative_input");
  });

  it("refuses more booked jobs than leads", () => {
    /**
     * Arithmetically impossible, and always the same bug: the two sides were
     * counted over different date ranges. A booking rate over a hundred per
     * cent on a screen destroys trust in every other number on it.
     */
    const decision = summariseSpend(
      [{ source: "google_ads", spend: usd("500.00") }],
      [{ source: "google_ads", leads: 3, bookedJobs: 5, bookedValue: usd("900.00") }],
    );
    expect(!decision.ok && decision.reason).toBe("negative_input");
    expect(!decision.ok && decision.detail).toContain("different periods");
  });

  it("refuses an empty period instead of reporting a confident zero", () => {
    // No spend and no results means nobody connected anything, which is a
    // different sentence from "you spent nothing and got nothing".
    const decision = summariseSpend([], []);
    expect(!decision.ok && decision.reason).toBe("nothing_to_report");
  });

  it("reports a source with no activity at all as dormant, not as a failure", () => {
    const decision = summariseSpend(
      [{ source: "radio", spend: usd("0.00") }],
      [{ source: "radio", leads: 0, bookedJobs: 0, bookedValue: usd("0.00") }],
    );
    if (!decision.ok) throw new Error("expected a summary");
    expect(decision.summary.rows[0]!.verdict.kind).toBe("dormant");
    expect(decision.summary.wastedSources).toEqual([]);
  });
});

describe("one money over another", () => {
  it("is null rather than infinite when the denominator is zero", () => {
    expect(ratio(usd("100.00"), usd("0.00"))).toBeNull();
  });

  it("is null across two currencies rather than a meaningless number", () => {
    expect(ratio(usd("100.00"), money("100.00", "CAD"))).toBeNull();
  });

  it("carries four places and no currency, so nobody adds it to a total", () => {
    expect(ratio(usd("3333.00"), usd("1000.00"))).toBe("3.3330");
  });
});
