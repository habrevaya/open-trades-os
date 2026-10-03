import { describe, it, expect } from "vitest";
import {
  replyAddress, replyTokenIn, checkReplyDomain, bareAddress, stripQuotedReply, textFromHtml,
  isAutomaticReply, checkPictures,
} from "../src/comms/index.js";

/**
 * REPLIES BY EMAIL, AND PICTURES BY TEXT
 *
 * What decides which thread an email lands in, what is kept of it, and what
 * a carrier will deliver as a picture. A reply in the wrong thread is a
 * customer's words shown on somebody else's account.
 */

const TOKEN = "Zq3k9W_x-7HgT2mP4sLbVa";

describe("the reply address", () => {
  it("carries the thread's token in the local part, on the reply domain", () => {
    expect(replyAddress(TOKEN, "Replies.Smith.example")).toBe(`reply+${TOKEN}@replies.smith.example`);
  });

  it("refuses a token short enough to guess", () => {
    expect(() => replyAddress("abc", "replies.smith.example")).toThrow();
  });

  it("finds the token among several recipients, keeping its case", () => {
    expect(replyTokenIn(["office@smith.example", `Smith Heating <reply+${TOKEN}@replies.smith.example>`],
      "replies.smith.example")).toBe(TOKEN);
  });

  it("ignores a lookalike on another domain, so nobody can claim a thread from Gmail", () => {
    expect(replyTokenIn([`reply+${TOKEN}@gmail.com`], "replies.smith.example")).toBeNull();
    expect(replyTokenIn(["somebody@replies.smith.example"], "replies.smith.example")).toBeNull();
  });

  it("checks a reply domain is a domain", () => {
    expect(checkReplyDomain(" Replies.Smith.Example ")).toEqual({ ok: true, domain: "replies.smith.example" });
    expect(checkReplyDomain("not a domain").ok).toBe(false);
    expect(checkReplyDomain("reply@smith.example").ok).toBe(false);
  });

  it("reads the bare address out of a display name", () => {
    expect(bareAddress("Jo Customer <Jo@Example.com>")).toBe("jo@example.com");
  });
});

describe("cutting the quoted history off a reply", () => {
  it("cuts at the line a mail client writes above its quote", () => {
    const { reply, quoted } = stripQuotedReply(
      "Tuesday works, thanks.\n\nOn Mon, 5 Oct 2026 at 09:00, Smith Heating <reply+x@r.example> wrote:\n> Your invoice is attached.",
    );
    expect(reply).toBe("Tuesday works, thanks.");
    expect(quoted).toBe(true);
  });

  it("cuts at an attribution line wrapped onto two lines", () => {
    expect(stripQuotedReply("Yes please.\n\nOn Mon, 5 Oct 2026 at 09:00, Smith Heating\n<office@smith.example> wrote:\n> hi").reply)
      .toBe("Yes please.");
  });

  it("cuts at Outlook's From block", () => {
    expect(stripQuotedReply("Paid it.\n\nFrom: Smith Heating\nSent: Monday\nSubject: Invoice").reply).toBe("Paid it.");
  });

  it("keeps a message whose first line is a quote whole, rather than storing nothing", () => {
    const text = "> what time?\n";
    expect(stripQuotedReply(text)).toEqual({ reply: "> what time?", quoted: false });
  });

  it("leaves a reply with nothing quoted alone", () => {
    expect(stripQuotedReply("Can you come Friday?")).toEqual({ reply: "Can you come Friday?", quoted: false });
  });

  it("reads the words out of an HTML only reply", () => {
    expect(textFromHtml("<style>p{}</style><p>Friday &amp; Saturday</p><p>are fine<br>thanks</p>"))
      .toBe("Friday & Saturday\nare fine\nthanks");
  });
});

describe("an automatic reply", () => {
  it("is recognised by the standard header and by the ones clients send instead", () => {
    expect(isAutomaticReply({ "Auto-Submitted": "auto-replied" })).toBe(true);
    expect(isAutomaticReply({ "auto-submitted": "no" })).toBe(false);
    expect(isAutomaticReply({ Precedence: "bulk" })).toBe(true);
    expect(isAutomaticReply({ "X-Autoreply": "yes" })).toBe(true);
    expect(isAutomaticReply({})).toBe(false);
  });
});

describe("pictures by text", () => {
  it("takes up to three ordinary pictures under five megabytes", () => {
    expect(checkPictures([{ contentType: "image/jpeg", sizeBytes: 900_000 }])).toEqual({ ok: true });
  });

  it("refuses what a carrier would accept and then drop", () => {
    expect(checkPictures([{ contentType: "image/jpeg", sizeBytes: 6 * 1024 * 1024 }]).ok).toBe(false);
    expect(checkPictures([{ contentType: "application/pdf", sizeBytes: 100 }]).ok).toBe(false);
    expect(checkPictures(Array.from({ length: 4 }, () => ({ contentType: "image/png", sizeBytes: 10 }))).ok).toBe(false);
  });
});
