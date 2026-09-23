import { describe, it, expect } from "vitest";
import { connectors as cat } from "@opentradesos/core";
import {
  registeredSpendSources, registeredLeadSources,
  csvSpendSource, webhookLeadSource, signLeadWebhook,
  SIGNATURE_HEADER, TIMESTAMP_HEADER, MAX_SKEW_MS,
} from "../src/marketing/index";

/**
 * THE CATALOGUE CANNOT CLAIM SOMETHING THAT IS NOT BUILT
 *
 * `CONNECTORS` in core lists every outside system marketing needs, each with
 * a `state` of `built` or `declared`. The whole value of that field is that
 * it is true, and nothing about a string in a data file makes it true.
 *
 * The failure it guards against is specific and silent. A catalogue that
 * lists Google Ads as built, with nothing importing Google spend, produces a
 * spend report showing a channel with leads and no cost. An owner reads that
 * as a free channel and moves budget onto it. The error points the wrong
 * way, nothing in the product contradicts it, and the first evidence is a
 * quarter of wasted spend.
 *
 * So this test is the thing that keeps the field honest: every `built` entry
 * must have an adapter registered under its own key.
 */
describe("the connector catalogue", () => {
  it("is internally usable", () => {
    const verdict = cat.checkCatalogue();
    expect(verdict.ok ? null : verdict.reason).toBeNull();
  });

  it("lists connectors at all, so the sweeps below are not vacuous", () => {
    expect(cat.CONNECTORS.length).toBeGreaterThan(5);
    expect(cat.builtConnectors().length).toBeGreaterThan(0);
    expect(cat.declaredConnectors().length).toBeGreaterThan(0);
  });

  it("has a registered adapter behind everything it calls built", () => {
    const registered = new Set([...registeredSpendSources(), ...registeredLeadSources()]);
    const lying = cat.builtConnectors()
      .map((c) => c.key)
      .filter((key) => !registered.has(key));

    expect(
      lying,
      "the catalogue says these are built and no adapter is registered for them, so connecting one would move no data while the screen said otherwise",
    ).toEqual([]);
  });

  it("does not register an adapter for something it calls declared", () => {
    /**
     * The other direction, and the less obvious one. An adapter that exists
     * while the catalogue says `declared` is a working connector nobody can
     * turn on, which is the same waste as the reverse with none of the
     * visibility.
     */
    const registered = [...registeredSpendSources(), ...registeredLeadSources()];
    const hidden = registered.filter((key) => cat.connector(key)?.state === "declared");
    expect(hidden, "built and unreachable").toEqual([]);
  });

  it("names every connector a marketing operation actually needs", () => {
    /**
     * Not an assertion about what is built. An assertion that the map is
     * complete enough to be worth reading: an owner should be able to look
     * for the thing they spend money on and find it, with an honest state
     * beside it, rather than conclude the product has never heard of it.
     */
    const keys = new Set(cat.CONNECTOR_KEYS);
    for (const needed of [
      "google_ads", "google_lsa", "meta_ads", "bing_ads",
      "ga4", "search_console", "google_business_profile",
      "angi", "thumbtack", "lead_webhook", "spend_csv",
    ]) {
      expect(keys.has(needed), `${needed} is not in the catalogue`).toBe(true);
    }
  });

  it("says what every connector is wrong about", () => {
    for (const spec of cat.CONNECTORS) {
      expect(spec.limitation.length, spec.key).toBeGreaterThan(20);
      expect(spec.setup.length, spec.key).toBeGreaterThan(20);
    }
  });

  it("refuses a catalogue with two entries under one key", () => {
    const verdict = cat.checkCatalogue([
      { ...cat.CONNECTORS[0]! },
      { ...cat.CONNECTORS[0]! },
    ]);
    expect(verdict.ok).toBe(false);
  });
});

/**
 * A REAL EXPORT FROM A CONTRACTOR IS NOT A CLEAN FILE
 *
 * Every case below is something an actual Google Ads or Meta export does,
 * and every one of them is a line somebody would otherwise clean by hand
 * every month until they stopped importing anything.
 */
describe("the ad spend CSV", () => {
  const parse = (text: string, source = "google_ads") =>
    csvSpendSource().parse({ text, settings: { source } });

  it("reads a plain export", () => {
    const result = parse(
      "Campaign,Date,Cost,Impressions,Clicks\n" +
      "AC Repair,2026-03-01,142.55,4210,96\n" +
      "Heating,2026-03-01,88.10,1900,41\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      source: "google_ads", campaign: "AC Repair",
      spentOn: "2026-03-01", amount: "142.55", impressions: 4210, clicks: 96,
    });
  });

  it("does not shift a row when a campaign name has a comma in it", () => {
    /**
     * "Austin, TX - AC Repair" is a completely ordinary campaign name.
     * Splitting on commas puts the date in the amount column and imports a
     * number under the wrong campaign rather than failing, which is the
     * worst available way for this to be wrong.
     */
    const result = parse(
      'Campaign,Date,Cost\n"Austin, TX - AC Repair",2026-03-01,200.00\n',
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.rows[0]!.campaign).toBe("Austin, TX - AC Repair");
    expect(result.rows[0]!.amount).toBe("200.00");
  });

  it("takes a currency symbol and thousands separators off", () => {
    const result = parse('Campaign,Date,Cost\nBrand,2026-03-01,"$1,234.56"\n');
    if (!result.ok) throw new Error(result.reason);
    expect(result.rows[0]!.amount).toBe("1234.56");
  });

  it("accepts the header spellings the platforms actually use", () => {
    const meta = parse(
      "Ad set name,Reporting starts,Amount spent (USD),Impressions,Link clicks\n" +
      "Spring,2026-03-01,45.20,900,18\n",
      "meta_ads",
    );
    if (!meta.ok) throw new Error(meta.reason);
    expect(meta.rows[0]).toMatchObject({ campaign: "Spring", amount: "45.20", clicks: 18 });
  });

  it("skips the totals row without reporting it", () => {
    /**
     * Every export has one. A skip list that is one entry long every single
     * month trains somebody to ignore the skip list.
     */
    const result = parse(
      "Campaign,Date,Cost\nAC Repair,2026-03-01,100.00\nTotal,,100.00\n",
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("refuses an ambiguous date rather than guessing the month", () => {
    /**
     * 03/04/2026 is two different days. A report silently off by a month is
     * worse than one that asks.
     */
    const result = parse("Campaign,Date,Cost\nAC Repair,03/04/2026,100.00\n");
    expect(result.ok).toBe(false);
  });

  it("reads an unambiguous slashed date either way round", () => {
    const american = parse("Campaign,Date,Cost\nA,3/17/2026,10.00\n");
    const european = parse("Campaign,Date,Cost\nA,17/3/2026,10.00\n");
    if (!american.ok || !european.ok) throw new Error("both were readable");
    expect(american.rows[0]!.spentOn).toBe("2026-03-17");
    expect(european.rows[0]!.spentOn).toBe("2026-03-17");
  });

  it("skips a bad line and imports the rest, naming the line number", () => {
    const result = parse(
      "Campaign,Date,Cost\n" +
      "Good,2026-03-01,10.00\n" +
      "Bad,2026-03-02,not-a-number\n" +
      "AlsoGood,2026-03-03,12.00\n",
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.line).toBe(3);
  });

  it("never turns an unreadable amount into a zero", () => {
    /**
     * A zero is a claim that a campaign cost nothing, which is the one
     * number in a marketing report nobody questions and the one that makes
     * a channel look free.
     */
    const result = parse("Campaign,Date,Cost\nBad,2026-03-01,\n");
    expect(result.ok).toBe(false);
  });

  it("refuses a file with no source declared for it", () => {
    /**
     * A Google Ads export does not say it is Google Ads anywhere in it.
     * Guessing from campaign names puts a whole Meta budget under Google
     * the first time somebody names a campaign "google retargeting test".
     */
    const result = parse("Campaign,Date,Cost\nA,2026-03-01,10.00\n", "");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("lead source");
  });

  it("refuses a file with no cost column and says what it found", () => {
    const result = parse("Campaign,Date,Conversions\nA,2026-03-01,3\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("campaign");
  });
});

/**
 * THE SIGNATURE IS WHAT MAKES THE LEAD URL SAFE TO HAND OUT
 *
 * Without it this endpoint is a job creation API open to the internet.
 * Anybody who learns the URL can put work on a contractor's board, consume
 * capacity a real customer would have booked, and send a van to an address
 * that never asked for one.
 */
describe("the lead webhook", () => {
  const SECRET = "shhh-a-signing-secret";
  const URL_ = "https://example.test/api/webhooks/leads/tok_123";
  const BODY = JSON.stringify({
    id: "angi-88123",
    name: "Priya Raman",
    phone: "+15125550123",
    address: "14 Elm St",
    city: "Austin",
    state: "TX",
    zip: "78702",
    service: "AC not cooling",
  });

  const signed = (over: { body?: string; url?: string; at?: number } = {}) => {
    const body = over.body ?? BODY;
    const url = over.url ?? URL_;
    const { signature, timestamp } = signLeadWebhook({
      secret: SECRET, url, body, timestamp: over.at ?? Date.now(),
    });
    return {
      url,
      body,
      headers: { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp },
    };
  };

  it("accepts a correctly signed request", () => {
    expect(webhookLeadSource().verify(signed(), SECRET)).toBe(true);
  });

  it("rejects a request signed with a different secret", () => {
    expect(webhookLeadSource().verify(signed(), "not-the-secret")).toBe(false);
  });

  /**
   * WHAT THESE TESTS CANNOT CHECK.
   *
   * `verify` compares the signature in constant time. Replacing that with
   * `===` leaves every test in this file green, and no test in any file
   * could catch it: a timing side channel is not observable from a unit
   * test, and asserting on elapsed time would be a flake generator on
   * shared CI.
   *
   * It is named here rather than left implicit, because the alternative is
   * somebody reading a green suite and concluding the comparison is
   * covered. It is not. It is covered by review, and by this paragraph
   * telling the next person that changing it is not a refactor.
   */


  it("rejects a body that changed after it was signed", () => {
    const request = signed();
    request.body = JSON.stringify({ ...JSON.parse(BODY), phone: "+15125559999" });
    expect(webhookLeadSource().verify(request, SECRET)).toBe(false);
  });

  it("rejects a signature made for a different company's endpoint", () => {
    /**
     * The URL is in the signed payload. Without it a partner sending to
     * several tenants could take a valid signature for one and aim the lead
     * at whichever of them they liked.
     */
    const forOther = signLeadWebhook({
      secret: SECRET,
      url: "https://example.test/api/webhooks/leads/tok_someone_else",
      body: BODY,
      timestamp: Date.now(),
    });
    const request = {
      url: URL_,
      body: BODY,
      headers: { [SIGNATURE_HEADER]: forOther.signature, [TIMESTAMP_HEADER]: forOther.timestamp },
    };
    expect(webhookLeadSource().verify(request, SECRET)).toBe(false);
  });

  it("rejects a replayed request once the window has passed", () => {
    /**
     * Without the window a signature captured once is valid forever, and the
     * same lead goes on the board every time somebody resends it.
     */
    const old = signed({ at: Date.now() - MAX_SKEW_MS - 1000 });
    expect(webhookLeadSource().verify(old, SECRET)).toBe(false);
  });

  it("accepts a request inside the window", () => {
    const recent = signed({ at: Date.now() - 60_000 });
    expect(webhookLeadSource().verify(recent, SECRET)).toBe(true);
  });

  it("rejects a request with no signature at all", () => {
    expect(webhookLeadSource().verify({ url: URL_, body: BODY, headers: {} }, SECRET)).toBe(false);
  });

  it("reads the fields a sender is likely to use without a mapping", () => {
    const lead = webhookLeadSource().parse(signed());
    expect(lead).toMatchObject({
      externalId: "angi-88123",
      contactName: "Priya Raman",
      contactPhone: "+15125550123",
      city: "Austin",
      postalCode: "78702",
      serviceRequested: "AC not cooling",
    });
  });

  it("reads a nested shape through a mapping", () => {
    const body = JSON.stringify({
      lead_id: "tt-1",
      contact: { name: "Dale Fisher", phone: "+15125550144" },
      location: { city: "Round Rock", zip: "78664" },
    });
    const lead = webhookLeadSource({
      fieldMap: { contactName: "contact.name", contactPhone: "contact.phone" },
    }).parse(signed({ body }));

    expect(lead?.contactName).toBe("Dale Fisher");
    expect(lead?.city).toBe("Round Rock");
  });

  it("refuses a lead with nobody to call", () => {
    /**
     * A CRM row with a name and no way to reach them reads to whoever opens
     * it as a lead somebody failed to call, and they will spend their
     * morning trying to find out who it was.
     */
    const body = JSON.stringify({ id: "x", name: "Anonymous" });
    expect(webhookLeadSource().parse(signed({ body }))).toBeNull();
  });

  it("refuses a lead with no name", () => {
    const body = JSON.stringify({ id: "x", phone: "+15125550123" });
    expect(webhookLeadSource().parse(signed({ body }))).toBeNull();
  });

  it("refuses a body that is not an object", () => {
    expect(webhookLeadSource().parse(signed({ body: '"just a string"' }))).toBeNull();
    expect(webhookLeadSource().parse(signed({ body: "[1,2,3]" }))).toBeNull();
    expect(webhookLeadSource().parse(signed({ body: "not json at all" }))).toBeNull();
  });

  it("keeps the whole body, because a field mapping is always wrong about something", () => {
    const lead = webhookLeadSource().parse(signed());
    expect(lead?.raw).toMatchObject({ service: "AC not cooling" });
  });

  it("falls back to the signature as an id, so a retry is idempotent", () => {
    /**
     * A sender that did not get a 200 sends the identical body again. With
     * no id in the payload, the signature of that identical body is the same
     * string, so the retry is recognised.
     */
    const body = JSON.stringify({ name: "Nina Volkov", phone: "+15125550155" });
    const request = signed({ body });
    const first = webhookLeadSource().parse(request);
    const second = webhookLeadSource().parse(request);
    expect(first?.externalId).toBe(second?.externalId);
    expect(first?.externalId.length).toBeGreaterThan(10);
  });
});
