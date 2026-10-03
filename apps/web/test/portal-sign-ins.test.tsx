import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Attempts, type AttemptRow } from "../src/app/(app)/settings/portal/sign-ins/Attempts";

/**
 * THE OFFICE'S ANSWER TO "THE CODE NEVER CAME"
 *
 * Rendered from the shape the service returns: what happened to each code
 * in words, whether the message went or why not, and who it was for.
 */
const row = (over: Partial<AttemptRow> = {}): AttemptRow => ({
  id: "a1", at: "2026-10-01T15:00:00Z", channel: "sms", address: "+15125550142", outcome: "signed_in",
  wrongCodes: 0, delivery: "queued", requestedIp: "203.0.113.4", signedInIp: "203.0.113.4",
  customers: [{ id: "c1", name: "Dana Whitlock" }], contactName: null, ...over,
});

describe("sign in attempts", () => {
  it("says what happened, whether the message went, and who it was for", () => {
    const html = renderToStaticMarkup(<Attempts timezone="America/Chicago" attempts={[
      row(),
      row({ id: "a2", outcome: "too_many_attempts", wrongCodes: 5, delivery: "the number replied STOP" }),
      row({ id: "a3", outcome: "wrong_code", wrongCodes: 2, contactName: "Sam Whitlock" }),
    ]} />);
    expect(html).toContain("Signed in");
    expect(html).toContain("Stopped after five wrong codes");
    expect(html).toContain("Not sent: the number replied STOP");
    expect(html).toContain("2 wrong codes");
    expect(html).toContain('href="/customers/c1"');
    expect(html).toContain("as Sam Whitlock");
  });

  it("leaves the customer column off on the customer's own page", () => {
    const html = renderToStaticMarkup(<Attempts timezone="America/Chicago" showCustomer={false} attempts={[row()]} />);
    expect(html).not.toContain("/customers/c1");
    expect(html).toContain("Text");
  });
});
