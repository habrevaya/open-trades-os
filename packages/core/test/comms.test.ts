import { describe, it, expect } from "vitest";
import {
  canSend, currentConsent, activeSuppression, inQuietHours, inboundIntent,
  type ConsentRecord, type SendRequest,
} from "../src/comms/index";

const at = (iso: string) => new Date(iso);

const base = (over: Partial<SendRequest> = {}): SendRequest => ({
  channel: "sms",
  purpose: "transactional",
  consents: [],
  suppressions: [],
  channelRegistered: true,
  ...over,
});

const consent = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  channel: "sms",
  purpose: "transactional",
  state: "granted",
  capturedAt: at("2026-01-01T00:00:00Z"),
  ...over,
});

/**
 * The most ordinary thing a customer says is "text me when you're on the way,
 * but stop sending me offers". A boolean on the customer record cannot say
 * that, and the cost of getting it wrong is a blocked sending number, which
 * takes the arrival notices down with it.
 */
describe("the two purposes are independent", () => {
  it("sends the arrival notice and refuses the promotion", () => {
    const consents = [
      consent({ purpose: "transactional", state: "granted" }),
      consent({ purpose: "marketing", state: "revoked" }),
    ];
    expect(canSend(base({ purpose: "transactional", consents })).allowed).toBe(true);
    expect(canSend(base({ purpose: "marketing", consents })).allowed).toBe(false);
  });

  it("refuses marketing when only transactional was granted", () => {
    // Marketing is never implied. Nothing about booking a repair is an
    // invitation to advertise.
    const result = canSend(base({
      purpose: "marketing",
      consents: [consent({ purpose: "transactional" })],
    }));
    expect(result).toEqual({ allowed: false, reason: "no_consent" });
  });

  it("allows a transactional message with no consent row at all", () => {
    // The transaction implies it. This is the one place the system proceeds
    // without an explicit grant.
    const result = canSend(base({ purpose: "transactional" }));
    expect(result).toMatchObject({ allowed: true, reason: "transactional_implied" });
  });

  it("records that a transactional send had no consent row", () => {
    // Recorded rather than papered over: a send with no consent behind it is
    // exactly what an audit has to be able to find.
    const result = canSend(base({ purpose: "transactional" }));
    expect(result.allowed && result.consent).toBeNull();
  });
});

describe("stop beats everything", () => {
  it("refuses a message to a suppressed address", () => {
    const result = canSend(base({
      suppressions: [{ channel: "sms", purpose: null }],
      consents: [consent()],
    }));
    expect(result).toEqual({ allowed: false, reason: "suppressed" });
  });

  it("treats a blanket suppression as covering every purpose", () => {
    // A STOP reply is not a marketing preference.
    for (const purpose of ["transactional", "marketing"] as const) {
      expect(canSend(base({ purpose, suppressions: [{ channel: "sms", purpose: null }] })).allowed)
        .toBe(false);
    }
  });

  it("lets a purpose specific suppression leave the other purpose alone", () => {
    const suppressions = [{ channel: "sms" as const, purpose: "marketing" as const }];
    expect(canSend(base({ purpose: "marketing", suppressions })).allowed).toBe(false);
    expect(canSend(base({ purpose: "transactional", suppressions })).allowed).toBe(true);
  });

  it("ignores a suppression that has been lifted", () => {
    const result = canSend(base({
      suppressions: [{ channel: "sms", purpose: null, liftedAt: at("2026-02-01T00:00:00Z") }],
    }));
    expect(result.allowed).toBe(true);
  });

  it("does not let a suppression on one channel block another", () => {
    expect(canSend(base({ channel: "email", suppressions: [{ channel: "sms", purpose: null }] })).allowed)
      .toBe(true);
  });

  it("beats an explicit grant, rather than being weighed against it", () => {
    // The carrier has already stopped delivering. Retrying generates failures
    // against our own sending reputation.
    const result = canSend(base({
      consents: [consent({ state: "granted" })],
      suppressions: [{ channel: "sms", purpose: null }],
    }));
    expect(result).toEqual({ allowed: false, reason: "suppressed" });
  });
});

describe("revocation", () => {
  it("stops even a transactional message when it was revoked explicitly", () => {
    // Somebody who said "stop texting me about my appointments" meant it.
    const result = canSend(base({
      purpose: "transactional",
      consents: [consent({ purpose: "transactional", state: "revoked" })],
    }));
    expect(result).toEqual({ allowed: false, reason: "consent_revoked" });
  });

  it("takes the most recent capture, not the most recent row", () => {
    // An import backfills old consent after new consent exists. "Last row
    // written" would let a 2019 paper form overrule last week's opt out.
    const consents = [
      consent({ state: "revoked", capturedAt: at("2026-03-01T00:00:00Z") }),
      consent({ state: "granted", capturedAt: at("2019-06-01T00:00:00Z") }),
    ];
    expect(currentConsent(consents, "sms", "transactional")?.state).toBe("revoked");
  });

  it("ignores a superseded row", () => {
    const consents = [
      consent({ state: "revoked", capturedAt: at("2026-03-01T00:00:00Z"), supersededAt: at("2026-04-01T00:00:00Z") }),
      consent({ state: "granted", capturedAt: at("2026-04-01T00:00:00Z") }),
    ];
    expect(currentConsent(consents, "sms", "transactional")?.state).toBe("granted");
  });

  it("returns nothing when no row matches the channel", () => {
    expect(currentConsent([consent({ channel: "email" })], "sms", "transactional")).toBeNull();
  });
});

describe("registration", () => {
  it("refuses to send before the sending identity is cleared", () => {
    // An unregistered send is not merely rejected. It counts against the
    // sender, so the system has to refuse it rather than try.
    const result = canSend(base({ channelRegistered: false, consents: [consent()] }));
    expect(result).toEqual({ allowed: false, reason: "channel_not_registered" });
  });

  it("still lets suppression report first, because it is the stronger fact", () => {
    const result = canSend(base({
      channelRegistered: false,
      suppressions: [{ channel: "sms", purpose: null }],
    }));
    expect(result).toEqual({ allowed: false, reason: "suppressed" });
  });
});

describe("quiet hours", () => {
  const window = { startHour: 21, endHour: 8 };

  it("wraps midnight, which every real window does", () => {
    expect(inQuietHours(22, window)).toBe(true);
    expect(inQuietHours(2, window)).toBe(true);
    expect(inQuietHours(7, window)).toBe(true);
    expect(inQuietHours(8, window)).toBe(false);
    expect(inQuietHours(14, window)).toBe(false);
  });

  it("handles a window that does not wrap", () => {
    expect(inQuietHours(13, { startHour: 12, endHour: 14 })).toBe(true);
    expect(inQuietHours(15, { startHour: 12, endHour: 14 })).toBe(false);
  });

  it("holds a promotion at 7am", () => {
    const result = canSend(base({
      purpose: "marketing",
      consents: [consent({ purpose: "marketing" })],
      localHour: 7,
      quietHours: window,
    }));
    expect(result).toEqual({ allowed: false, reason: "quiet_hours" });
  });

  it("sends the arrival notice at 7am anyway", () => {
    // The customer is waiting for this one.
    const result = canSend(base({ purpose: "transactional", localHour: 7, quietHours: window }));
    expect(result.allowed).toBe(true);
  });

  it("does not hold anything when the local hour is unknown", () => {
    // Guessing the recipient's hour is worse than not checking: the server's
    // hour is wrong the first time a company sells across a zone line.
    const result = canSend(base({
      purpose: "marketing",
      consents: [consent({ purpose: "marketing" })],
      quietHours: window,
    }));
    expect(result.allowed).toBe(true);
  });
});

describe("what an inbound message means", () => {
  it("recognises the stop words", () => {
    for (const word of ["STOP", "stop", "Stop.", "UNSUBSCRIBE", "cancel", "quit", "opt-out"]) {
      expect(inboundIntent(word), word).toBe("stop");
    }
  });

  it("recognises start and help", () => {
    expect(inboundIntent("START")).toBe("start");
    expect(inboundIntent("Yes")).toBe("start");
    expect(inboundIntent("HELP")).toBe("help");
  });

  it("strips punctuation and case, because people type Stop.", () => {
    // A system that only matches bare uppercase keeps texting somebody who
    // has plainly asked it not to.
    expect(inboundIntent("  Stop!  ")).toBe("stop");
  });

  it("leaves an ordinary message alone", () => {
    expect(inboundIntent("stop by whenever you can")).toBe("message");
    expect(inboundIntent("can you come Tuesday")).toBe("message");
  });

  it("does not treat an empty message as a command", () => {
    expect(inboundIntent("")).toBe("message");
    expect(inboundIntent("   ")).toBe("message");
  });
});

describe("finding a suppression", () => {
  it("matches a blanket row for any purpose", () => {
    expect(activeSuppression([{ channel: "sms", purpose: null }], "sms", "marketing")).not.toBeNull();
  });

  it("does not match a different channel", () => {
    expect(activeSuppression([{ channel: "email" }], "sms", "marketing")).toBeNull();
  });
});
