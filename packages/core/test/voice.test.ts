import { describe, it, expect } from "vitest";
import {
  twiml, escapeXml, whisperText, businessHoursFrom, routingTableFor, checkNumberRouting, routeCall,
  recordingDecision, dialOutcome, laterStatus, providerCallStatus, checkNumberSearch, RECORDING_QUESTION,
} from "../src/voice/index.js";

/**
 * A TRACKING NUMBER THAT ANSWERS ITS OWN CALLS
 *
 * The cases worth writing down are the ones that cost somebody: a campaign
 * name with markup in it becoming an instruction to the carrier, a company
 * with no hours declared sending every call to voicemail, and above all a
 * call recorded because a caller said nothing.
 */

describe("the instructions handed to the carrier", () => {
  it("escapes office typed text so a name cannot become an instruction", () => {
    const xml = twiml([{ verb: "say", text: `Call from "Spring" <Hangup/> & more` }]);
    expect(xml).toContain("&quot;Spring&quot; &lt;Hangup/&gt; &amp; more");
    expect(xml).not.toContain("<Hangup/>");
    expect(escapeXml("a'b")).toBe("a&apos;b");
  });

  it("adds recording to a dial only when a callback is given, never by default", () => {
    const plain = twiml([{ verb: "dial", to: "+15125550100", action: "https://x/d", timeoutSeconds: 20 }]);
    expect(plain).not.toContain("record=");
    const recorded = twiml([{
      verb: "dial", to: "+15125550100", action: "https://x/d", timeoutSeconds: 20, recordingCallback: "https://x/r",
    }]);
    expect(recorded).toContain('record="record-from-answer-dual"');
    expect(recorded).toContain('recordingStatusCallback="https://x/r"');
  });

  it("whispers through the number's own url, played to the person answering", () => {
    const xml = twiml([{ verb: "dial", to: "+15125550100", action: "a", timeoutSeconds: 20, whisperUrl: "https://x/w" }]);
    expect(xml).toContain('<Number url="https://x/w">+15125550100</Number>');
  });

  it("asks the recording question inside a gather, so a key press reaches the next step", () => {
    const xml = twiml([{ verb: "gather", action: "https://x/c", numDigits: 1, timeoutSeconds: 6, say: RECORDING_QUESTION }]);
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toContain('<Gather action="https://x/c" method="POST" numDigits="1" timeout="6">');
  });
});

describe("the whisper", () => {
  it("names the channel and campaign, and says when the call is recorded", () => {
    expect(whisperText({ channelName: "Google Ads", campaignName: "Spring tune up", recording: true }))
      .toBe("Call from Google Ads, Spring tune up. This call is being recorded.");
  });

  it("says something honest when the number is credited to nothing", () => {
    expect(whisperText({ recording: false })).toBe("Call from a tracking number.");
  });
});

describe("business hours from the rows online booking keeps", () => {
  it("is nothing at all when nothing is declared, so calls are not sent to voicemail all week", () => {
    expect(businessHoursFrom([], "America/Chicago")).toBeNull();
    expect(businessHoursFrom([{ dayOfWeek: 1, opensAt: null, closesAt: null, closed: true }], "America/Chicago")).toBeNull();
  });

  it("reads open and close times into windows by weekday", () => {
    const hours = businessHoursFrom([{ dayOfWeek: 1, opensAt: "08:00:00", closesAt: "17:00:00", closed: false }], "America/Chicago");
    expect(hours?.weekly.monday).toEqual([{ openMinute: 480, closeMinute: 1020 }]);
    expect(hours?.weekly.tuesday).toEqual([]);
  });
});

describe("where a call goes", () => {
  const hours = businessHoursFrom(
    [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opensAt: "08:00", closesAt: "17:00", closed: false })),
    "America/Chicago",
  );
  const number = { forwardsToE164: "+15125550100", routeByHours: true, afterHoursForwardsToE164: null };
  /** A Monday at 10am in Austin, and the same Monday at 9pm. */
  const open = new Date("2026-03-02T16:00:00Z");
  const shut = new Date("2026-03-03T03:00:00Z");

  it("rings the office inside hours", () => {
    const routed = routeCall({ number, dialled: "+15125550199", hours, knownCustomer: false, now: open });
    expect(routed.destination).toEqual({ kind: "forward", e164: "+15125550100" });
    expect(routed.why).toContain("Open hours");
  });

  it("goes to voicemail outside them, and says why", () => {
    const routed = routeCall({ number, dialled: "+15125550199", hours, knownCustomer: false, now: shut });
    expect(routed.destination.kind).toBe("voicemail");
    expect(routed.why).toContain("fallback");
  });

  it("rings the after hours number when there is one", () => {
    const routed = routeCall({
      number: { ...number, afterHoursForwardsToE164: "+15125550111" }, dialled: "x", hours, knownCustomer: false, now: shut,
    });
    expect(routed.destination).toEqual({ kind: "forward", e164: "+15125550111" });
  });

  it("ignores the clock when the company has declared no hours", () => {
    const routed = routeCall({ number, dialled: "x", hours: null, knownCustomer: false, now: shut });
    expect(routed.destination.kind).toBe("forward");
  });

  it("sends a number with nowhere to ring to voicemail rather than dead air", () => {
    expect(routingTableFor({ forwardsToE164: null, routeByHours: false, afterHoursForwardsToE164: null }).fallback.kind)
      .toBe("voicemail");
  });

  it("refuses an after hours number that nothing would ever use", () => {
    expect(checkNumberRouting({ forwardsToE164: "+15125550100", routeByHours: false, afterHoursForwardsToE164: "+15125550111" }).ok)
      .toBe(false);
    expect(checkNumberRouting(number).ok).toBe(true);
  });
});

describe("whether a native call may be recorded", () => {
  it("records nothing for a caller who said nothing, because silence is not agreement", () => {
    const { decision } = recordingDecision({ callerPressedOne: false, policies: [] });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toBe("consent_missing");
  });

  it("records a caller who pressed 1, under the all party treatment an unknown place gets", () => {
    const { decision, parties } = recordingDecision({ callerPressedOne: true, policies: [] });
    expect(decision.ok).toBe(true);
    expect(decision.governing).toBe("unknown");
    expect(parties).toEqual([{ role: "caller", consented: true }, { role: "agent", consented: true }]);
  });

  it("records nothing when the operator's own declarations are broken", () => {
    const { decision } = recordingDecision({
      callerPressedOne: true,
      policies: [
        { jurisdiction: "TX", rule: "one_party", announcementRequired: false, note: "a" },
        { jurisdiction: "TX", rule: "all_party", announcementRequired: true, note: "b" },
      ],
    });
    expect(!decision.ok && decision.reason).toBe("policy_rejected");
  });
});

describe("what came back from the carrier", () => {
  it("counts busy, failed, unanswered and hung up while ringing as missed", () => {
    for (const status of ["busy", "failed", "no-answer", "canceled", undefined]) {
      expect(dialOutcome(status).missed).toBe(true);
    }
    expect(dialOutcome("completed")).toEqual({ answered: true, missed: false, status: "completed" });
  });

  it("never moves a finished call backwards when callbacks arrive out of order", () => {
    expect(laterStatus("completed", "ringing")).toBe("completed");
    expect(laterStatus("voicemail", "no_answer")).toBe("voicemail");
    expect(laterStatus("ringing", "no_answer")).toBe("no_answer");
  });

  it("maps the carrier's status words and ignores ones it does not know", () => {
    expect(providerCallStatus("no-answer")).toBe("no_answer");
    expect(providerCallStatus("in-progress")).toBe("in_progress");
    expect(providerCallStatus("something-new")).toBeNull();
  });
});

describe("searching for a number to buy", () => {
  it("needs an area code or a town", () => {
    expect(checkNumberSearch({}).ok).toBe(false);
    expect(checkNumberSearch({ areaCode: "512" }).ok).toBe(true);
    expect(checkNumberSearch({ locality: "Austin", region: "tx" })).toEqual({ ok: true, areaCode: undefined, locality: "Austin", region: "TX" });
  });

  it("refuses an area code no number has", () => {
    expect(checkNumberSearch({ areaCode: "112" }).ok).toBe(false);
    expect(checkNumberSearch({ areaCode: "51" }).ok).toBe(false);
  });
});
