import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Campaigns, Audience, Recipients, Tally,
  type CampaignRow, type Preview, type RecipientRow,
} from "../src/app/(app)/marketing/campaigns/CampaignView";
import { RULES } from "../src/app/(app)/marketing/campaigns/rules";
import { campaign as cp } from "@opentradesos/core";
import { NAV } from "../src/lib/nav";

const campaign = (over: Partial<CampaignRow> = {}): CampaignRow => ({
  id: "c1", name: "Spring tune up", channel: "sms", state: "draft",
  audienceInWords: "were last served more than 540 days ago and have never held an agreement",
  utmCampaign: "spring-tune-up", scheduledFor: null, startedAt: null,
  cancelledAt: null, cancellationReason: null,
  result: { selected: 0, queued: 0, skipped: 0, skippedBy: {} },
  ...over,
});

const preview = (over: Partial<Preview> = {}): Preview => ({
  count: 412, overflow: false,
  inWords: "were last served more than 540 days ago",
  pace: { firstBatch: 412, days: 1, secondsBetween: null, staged: false },
  sample: [{ customerId: "k1", name: "Dana Whitfield", address: "+15125550161" }],
  ...over,
});

/** M19's SEND HALF ON A SCREEN: THE SENTENCE IS THE SAFETY */
describe("campaigns", () => {
  it("reads the audience back as a sentence, not as a rule count", () => {
    /**
     * The difference between two years and two months is one character in a form
     * and a factor of twelve in the bill. "3 rules" cannot be checked; a sentence
     * can, which is why core builds it and the screen does not rebuild it.
     */
    const html = renderToStaticMarkup(<Campaigns campaigns={[campaign()]} />);
    expect(html).toContain("were last served more than 540 days ago");
    expect(html).toContain("have never held an agreement");
  });

  it("shows the count and the sentence together before anything is sent", () => {
    const html = renderToStaticMarkup(<Audience preview={preview({
      inWords: "Customers who were last served more than 540 days ago.",
    })} />);
    expect(html).toContain("412");
    expect(html).toContain("were last served more than 540 days ago");
    expect(html).toContain("Dana Whitfield");
    /**
     * And not wrapped in a second sentence. `describeAudience` returns a whole
     * one, so the first version read "412 customers who Customers who were last
     * served", which is what a browser test found.
     */
    expect(html).not.toContain("who Customers who");
  });

  it("tells a campaign that has not gone apart from one that matched nobody", () => {
    /**
     * Three states, not two. A campaign with no recipients has either not gone or
     * has gone and matched nobody, and those are different facts: the first is a
     * thing to press, the second is a thing to fix in the rules. Showing both as
     * "Not sent yet" put a campaign marked `sent` beside a result saying it had
     * not been, which a browser test caught.
     */
    const waiting = renderToStaticMarkup(<Campaigns campaigns={[campaign()]} />);
    expect(waiting).toContain("Not sent yet");

    const empty = renderToStaticMarkup(<Campaigns campaigns={[campaign({
      state: "sent", startedAt: "2026-06-02T10:00:00.000Z",
    })]} />);
    expect(empty).toContain("Nobody matched the rules");
    expect(empty).not.toContain("Not sent yet");
  });

  it("says an overflow out loud rather than truncating quietly", () => {
    /**
     * Somebody who meant to reach thirty thousand people needs to know this
     * reaches the first twenty five thousand BY NAME ORDER, which is not a random
     * sample of their list and is therefore not a test of anything.
     */
    const html = renderToStaticMarkup(<Audience preview={preview({ count: 25_000, overflow: true })} />);
    expect(html).toContain("More than one campaign will take");
    expect(html).toContain("not a random sample");
  });

  it("puts a carrier's daily cap in days, not in batches", () => {
    /**
     * An owner reading "3 batches" does not know whether that is three minutes or
     * three days. Under a 10DLC daily cap it is days, and each day is another
     * press because there is no scheduler.
     */
    const html = renderToStaticMarkup(<Audience preview={preview({
      count: 3000, pace: { firstBatch: 1000, days: 3, secondsBetween: 0.1, staged: true },
    })} />);
    expect(html).toContain("over 3 days");
    expect(html).toContain("1,000 a day");
    expect(html).toContain("no scheduler");
  });

  it("calls a cap of zero a registration problem rather than an audience one", () => {
    /**
     * `pace` reports a cap of zero as staged with a first batch of nothing, which
     * is the one case where pressing send sends to nobody and the audience is
     * fine. Reading it as "0 a day" would send somebody to rewrite their rules.
     */
    const html = renderToStaticMarkup(<Audience preview={preview({
      count: 500, pace: { firstBatch: 0, days: 0, secondsBetween: null, staged: true },
    })} />);
    expect(html).toContain("daily cap is zero");
    expect(html).toContain("registration problem");
  });

  it("says nobody rather than showing an empty example list", () => {
    const html = renderToStaticMarkup(<Audience preview={preview({ count: 0, sample: [] })} />);
    expect(html).toContain("Nobody.");
    expect(html).toContain("nobody on this list has an address on this channel");
  });

  it("reports queued and not sent separately, with the reasons", () => {
    /**
     * The whole argument of the module. A screen reporting nine hundred sent is
     * the screen that hides that four hundred of them were never asked for
     * consent, which is a fact about the company's records rather than about the
     * send.
     */
    const html = renderToStaticMarkup(<Tally result={{
      selected: 900, queued: 500, skipped: 400,
      skippedBy: { no_consent: 380, suppressed: 20 },
    }} />);
    expect(html).toContain("500 queued");
    expect(html).toContain("400 not sent");
    expect(html).toContain("380 never asked for consent");
    expect(html).toContain("20 replied STOP");
  });

  it("tells a consent problem apart from somebody who said stop", () => {
    /**
     * Two different conversations: one the office can fix by asking, one they must
     * not touch. A single "skipped" would make them look the same.
     */
    const html = renderToStaticMarkup(<Recipients recipients={[
      { id: "r1", customerName: "Dana Whitfield", address: "+15125550161", state: "queued", skipReason: null },
      { id: "r2", customerName: "Sam Ortiz", address: "+15125550162", state: "skipped", skipReason: "no_consent" },
      { id: "r3", customerName: "Lee Park", address: "+15125550163", state: "skipped", skipReason: "suppressed" },
    ] satisfies RecipientRow[]} />);
    expect(html).toContain("never asked for consent");
    expect(html).toContain("replied STOP");
  });

  it("shows a reason it has no wording for rather than hiding it", () => {
    /**
     * A refusal reason added to core and not to this map has to be visible. The
     * alternative is a row reading "skipped", which is the thing this screen
     * exists to avoid.
     */
    const html = renderToStaticMarkup(<Recipients recipients={[
      { id: "r1", customerName: "Dana", address: "d@example.com", state: "skipped", skipReason: "some_new_reason" },
    ]} />);
    expect(html).toContain("some_new_reason");
  });

  it("says why a campaign was cancelled", () => {
    const html = renderToStaticMarkup(<Campaigns campaigns={[campaign({
      state: "cancelled", cancelledAt: "2026-06-02T10:00:00.000Z", cancellationReason: "Wrong list",
    })]} />);
    expect(html).toContain("Cancelled: Wrong list");
  });

  it("offers a box for every rule the audience union has", () => {
    /**
     * Both directions. A tenth rule added to core cannot ship without a box here,
     * and a box for a rule the union does not have would build a value the
     * service refuses.
     */
    const offered = RULES.map((rule) => rule.kind).sort();
    expect(offered).toEqual([...cp.RULE_KINDS].sort());
    /** And each one reads as a sentence rather than as a field name. */
    for (const rule of RULES) expect(rule.label).not.toContain("_");
  });

  it("is a child of Marketing", () => {
    const marketing = NAV.flatMap((g) => g.items).find((i) => i.href === "/marketing");
    expect(marketing?.children?.map((c) => c.href)).toContain("/marketing/campaigns");
  });
});
