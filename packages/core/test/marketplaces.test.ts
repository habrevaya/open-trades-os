import { describe, it, expect } from "vitest";
import { marketplaces as mp } from "../src/index";

/**
 * READING A MARKETPLACE'S LEAD EMAIL BY ITS LABELS
 *
 * The platform is told from the sender, or from the forwarded message's own
 * From line; a lead is a name and a way to reach them, read from the words
 * beside the labels a platform uses, whether on one line or the next; the
 * platform's own lead number is taken from its links; and an email that is
 * not a lead says why rather than becoming one with nobody on it.
 */
describe("which marketplace sent it", () => {
  it("is the sender's domain, or the forwarded message's", () => {
    expect(mp.detectPlatform({ from: "Angi Leads <leads@angi.com>", text: "" })).toBe("angi");
    expect(mp.detectPlatform({ from: "noreply@mail.homeadvisor.com", text: "" })).toBe("angi");
    expect(mp.detectPlatform({ from: "Owner <me@company.com>", text: "---------- Forwarded message ---------\nFrom: Thumbtack <no-reply@thumbtack.com>\n" })).toBe("thumbtack");
    expect(mp.detectPlatform({ from: "reply@hello.nextdoor.com", text: "" })).toBe("nextdoor");
    expect(mp.detectPlatform({ from: "someone@notyelp.com", text: "" })).toBeNull();
  });

  it("says plainly which platforms need a partner approval and which take replies", () => {
    expect(mp.MARKETPLACES.thumbtack).toMatchObject({ needsApproval: true, replies: true, api: "push" });
    expect(mp.MARKETPLACES.yelp).toMatchObject({ needsApproval: true, replies: true, api: "notify_then_fetch" });
    expect(mp.MARKETPLACES.angi).toMatchObject({ needsApproval: true, replies: false });
    expect(mp.MARKETPLACES.nextdoor).toMatchObject({ needsApproval: false, replies: false, api: "none" });
  });
});

describe("the lead inbox address", () => {
  it("is leads plus a token on the receiving domain, found again among the recipients", () => {
    const address = mp.leadInboxAddress("abcdefghij0123456789", "Replies.Example.com");
    expect(address).toBe("leads+abcdefghij0123456789@replies.example.com");
    expect(mp.leadInboxTokenIn(["Office <office@company.com>", `Leads <${address}>`], "replies.example.com")).toBe("abcdefghij0123456789");
    expect(mp.leadInboxTokenIn([address], "other.example.com")).toBeNull();
    expect(mp.leadInboxTokenIn(["leads+short@replies.example.com"], "replies.example.com")).toBeNull();
  });
});

describe("reading a lead email", () => {
  it("reads labels on one line, or the label and the value on the next as a table comes out", () => {
    const verdict = mp.parseLeadEmail({
      from: "leads@angi.com", subject: "New lead",
      text: "Customer Name\nPriya Shah\nPhone\n(512) 555-0163\nAddress: 77 Bluebonnet Ln, Austin, TX 78745\nTask: Water heater\nhttps://pro.angi.com/x?leadOid=5550123",
      html: null,
    });
    expect(verdict).toEqual({
      ok: true, platform: "angi",
      lead: {
        externalId: "5550123", name: "Priya Shah", phone: "+15125550163", email: null,
        addressLine1: "77 Bluebonnet Ln", city: "Austin", state: "TX", postalCode: "78745",
        service: "Water heater", notes: null, kind: "lead",
      },
    });
  });

  it("reads the HTML when there is no text, and a name from the subject when no label gives one", () => {
    const verdict = mp.parseLeadEmail({
      from: "no-reply@thumbtack.com", subject: "New request from Marco Diaz", text: null,
      html: "<p>Phone: 512.555.0188</p><p>Zip code: 78704</p><a href=\"https://www.thumbtack.com/pro/leads/888123456\">Open</a>",
    });
    expect(verdict).toMatchObject({ ok: true, lead: { name: "Marco Diaz", phone: "+15125550188", postalCode: "78704", externalId: "888123456" } });
  });

  it("uses Yelp's relay as the way to reach somebody whose number Yelp withholds", () => {
    const verdict = mp.parseLeadEmail({
      from: "Yelp <no-reply@yelp.com>", subject: "Dana R. requested a quote", text: "Name: Dana R.\nProject details: Furnace will not light",
      html: null, replyTo: "Dana R. <dana.r.7f3@messaging.yelp.com>",
    });
    expect(verdict).toMatchObject({ ok: true, lead: { name: "Dana R.", email: "dana.r.7f3@messaging.yelp.com", notes: "Furnace will not light" } });
  });

  it("does not take the platform's own help line for the customer's number", () => {
    const verdict = mp.parseLeadEmail({
      from: "leads@angi.com", subject: "New lead", text: "Customer Name: Bo Li\nQuestions? Call our support line at (877) 555-0100",
      html: null,
    });
    expect(verdict).toMatchObject({ ok: false, platform: "angi" });
  });

  it("refuses a lead with nobody to call, and anything not from a marketplace, with the reason", () => {
    const none = mp.parseLeadEmail({ from: "reply@nextdoor.com", subject: "New message", text: "Name: Sam Lee\nMessage: hi", html: null });
    expect(none).toMatchObject({ ok: true, lead: { kind: "message", phone: null, email: null } });
    const lead = mp.parseLeadEmail({ from: "reply@nextdoor.com", subject: "Enquiry", text: "Name: Sam Lee", html: null });
    expect(lead).toMatchObject({ ok: false, reason: expect.stringContaining("no phone number or email") });
    expect(mp.parseLeadEmail({ from: "a@b.com", subject: "x", text: "Name: X\nPhone: 5125550100", html: null })).toMatchObject({ ok: false, platform: null });
  });
});
