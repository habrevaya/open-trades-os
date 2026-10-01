import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadList } from "../src/app/(app)/inbox/ThreadList";
import { ConsentSummary, type ConsentEntry } from "../src/app/(app)/inbox/[id]/ConsentSummary";

/**
 * M18 ON A SCREEN: THREADS BY CUSTOMER, AND WHAT THE NUMBER AGREED TO
 *
 * The rows the inbox and a customer's page both draw, and the consent panel
 * beside a conversation. Rendered from the shapes the services return.
 */
describe("the thread list", () => {
  it("names the customer, marks what waits on us, and shows a stranger's number", () => {
    const html = renderToStaticMarkup(<ThreadList timezone="America/Chicago" threads={[
      { id: "t1", externalAddress: "+15125550120", customerName: "Ida Inbox",
        lastMessageAt: new Date("2026-09-30T15:00:00Z"), lastMessagePreview: "Thursday works",
        awaitingReply: true, unread: 2 },
      { id: "t2", externalAddress: "+15125550199", customerName: null,
        lastMessageAt: null, lastMessagePreview: null, awaitingReply: false, unread: 0 },
    ]} />);
    expect(html).toContain('href="/inbox/t1"');
    expect(html).toContain("Ida Inbox");
    expect(html).toContain("Needs a reply");
    expect(html).toContain("2 unread");
    expect(html).toContain("Thursday works");
    expect(html).toContain("Unknown number");
    expect(html).toMatch(/512.*555.*0199/);
    expect(html).toContain("No messages yet");
  });
});

const entry = (over: Partial<ConsentEntry>): ConsentEntry => ({
  purpose: "marketing", channel: "sms", state: "granted", method: "verbal",
  proofText: "Yes, text me offers", capturedAt: "2026-09-01T00:00:00Z", current: true, ...over,
});

describe("the consent panel", () => {
  it("says booked-work texts are allowed and offers are agreed, with the wording", () => {
    const html = renderToStaticMarkup(
      <ConsentSummary entries={[entry({})]} suppressed={false} customerId="c1" />,
    );
    expect(html).toContain("Allowed");
    expect(html).toContain("Agreed on a call");
    expect(html).toContain("Yes, text me offers");
    expect(html).toContain('href="/customers/c1"');
  });

  it("puts a STOP above everything", () => {
    const html = renderToStaticMarkup(
      <ConsentSummary entries={[entry({})]} suppressed customerId={null} />,
    );
    expect(html).toContain("Replied STOP");
    expect(html).not.toContain("Agreed");
  });

  it("does not read a superseded grant as current", () => {
    const html = renderToStaticMarkup(
      <ConsentSummary entries={[entry({ current: false }), entry({ state: "revoked", proofText: null })]}
        suppressed={false} customerId={null} />,
    );
    expect(html).toContain("Withdrawn");
  });
});
