import { describe, it, expect } from "vitest";
import { comms } from "@opentradesos/core";
import { refusal } from "../src/services/comms-send";

/**
 * THE SENTENCE A TECHNICIAN READS WHEN A MESSAGE WILL NOT GO
 *
 * `refusal` turns a reason code into words somebody on a driveway can act on.
 * "They replied STOP" tells them what happened and that there is nothing to
 * fix; "Cannot send: consent_revoked" sends them to the office, and the
 * office to support.
 *
 * Two of its cases were dead for as long as it existed. It switched on
 * `"revoked"` and `"channel_unregistered"` while `canSend` answers
 * `"consent_revoked"` and `"channel_not_registered"`, so the two most common
 * refusals both fell through to the default and printed the identifier. A
 * third stale string, `"channel_unregistered"`, was manufactured at the call
 * site as a fallback and matched nothing either.
 *
 * Nothing caught any of it, because a `string` parameter makes every branch
 * look plausible and no test ever read the sentences. This file reads them,
 * and reads them against the union rather than against a list somebody typed
 * out here, so a reason added tomorrow with no sentence written for it fails
 * rather than quietly printing itself at a person.
 */

/**
 * Every refusal the decision function can actually return.
 *
 * Derived from the type through a value that has to name all of them, so
 * this list cannot fall behind the union the way the switch did. Adding a
 * member to `SendRefusal` and not to this object is a build error.
 */
const EVERY_REASON: Record<comms.SendRefusal, true> = {
  suppressed: true,
  consent_revoked: true,
  no_consent: true,
  channel_not_registered: true,
  quiet_hours: true,
};

const REASONS = Object.keys(EVERY_REASON) as comms.SendRefusal[];

describe("what an operator is told when a message is refused", () => {
  it("has real words for every reason, not the reason itself", () => {
    expect(REASONS.length).toBeGreaterThan(4);

    for (const reason of REASONS) {
      const words = refusal(reason);

      /**
       * The identifier must not appear in what a person reads. This is the
       * assertion that would have failed for two years: the default branch
       * produced "Cannot send: consent_revoked", which is a sentence
       * containing the code, and any check that only looked for a non empty
       * string would have passed it.
       */
      expect(words, reason).not.toContain(reason);
      expect(words, reason).not.toMatch(/_/);
      expect(words.length, reason).toBeGreaterThan(20);
      /** A sentence, because this is printed to a person and not logged. */
      expect(words, reason).toMatch(/\.$/);
    }
  });

  it("says the two that were dead, in the words they were always meant to have", () => {
    expect(refusal("consent_revoked")).toMatch(/withdrew consent/i);
    expect(refusal("channel_not_registered")).toMatch(/register/i);
  });

  it("answers something usable when there is no reason at all", () => {
    /**
     * Distinct from a reason nobody wrote words for. A caller with no reason
     * is an ordinary case; a reason with no sentence is a build error now.
     */
    expect(refusal(undefined)).toMatch(/cannot send/i);
    expect(refusal(undefined)).not.toMatch(/undefined/);
  });
});
