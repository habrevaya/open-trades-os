import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadSourceSelect } from "@/components/LeadSourceSelect";
import { sourceFrom, sourceValue } from "@/lib/lead-source";
import { funnelQuery, rowsHref } from "@/app/(app)/marketing/funnel-params";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

/** A LEAD SOURCE IS PICKED FROM THE COMPANY'S LIST, NEVER TYPED */
describe("the lead source picker", () => {
  it("groups each channel's campaigns under it, and says what blank means", () => {
    const html = renderToStaticMarkup(<LeadSourceSelect options={[
      { id: CHANNEL, name: "Google Ads", campaigns: [{ id: CAMPAIGN, name: "Spring AC tune up" }] },
    ]} />);
    expect(html).toContain('label="Google Ads"');
    expect(html).toContain(`value="channel:${CHANNEL}"`);
    expect(html).toContain(`value="campaign:${CAMPAIGN}"`);
    expect(html).toContain("Google Ads: Spring AC tune up");
    expect(html).toContain("Not known yet");
    expect(renderToStaticMarkup(<LeadSourceSelect options={[]} required />)).toContain("Choose one");
  });

  it("reads back exactly one of a channel or a campaign, and nothing it does not recognise", () => {
    const form = (value: string) => { const f = new FormData(); f.set("source", value); return f; };
    expect(sourceFrom(form(`campaign:${CAMPAIGN}`))).toEqual({ campaignId: CAMPAIGN });
    expect(sourceFrom(form(`channel:${CHANNEL}`))).toEqual({ channelId: CHANNEL });
    expect(sourceFrom(form("google"))).toEqual({});
    expect(sourceFrom(form("channel:not-an-id"))).toEqual({});
    expect(sourceFrom(new FormData())).toEqual({});
    expect(sourceValue({ channelId: CHANNEL, acquisitionCampaignId: CAMPAIGN })).toBe(`campaign:${CAMPAIGN}`);
    expect(sourceValue({ channelId: CHANNEL })).toBe(`channel:${CHANNEL}`);
    expect(sourceValue({})).toBe("");
  });
});

/** THE FUNNEL AND ITS ROWS ARE PAGES OF THEIR URL, READ ONE WAY */
describe("the funnel's query string", () => {
  it("defaults to the last thirty days by channel under the company's model", () => {
    expect(funnelQuery({}, "2026-04-30")).toEqual({ from: "2026-04-01", to: "2026-04-30", by: "channel" });
  });

  it("keeps a chosen range, cut and model, and refuses a model it does not know", () => {
    expect(funnelQuery({ from: "2026-03-01", to: "2026-03-31", by: "number", model: "linear" }, "2026-04-30"))
      .toEqual({ from: "2026-03-01", to: "2026-03-31", by: "number", model: "linear" });
    expect(funnelQuery({ by: "everything", model: "magic" }, "2026-04-30").by).toBe("channel");
    expect(funnelQuery({ model: "magic" }, "2026-04-30")).not.toHaveProperty("model");
  });

  it("carries all of it into the rows behind a cell", () => {
    const href = rowsHref({ from: "2026-03-01", to: "2026-03-31", by: "campaign", model: "first_touch" }, CAMPAIGN, "booked");
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/marketing/rows");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: "2026-03-01", to: "2026-03-31", by: "campaign", key: CAMPAIGN, measure: "booked", model: "first_touch",
    });
  });
});
