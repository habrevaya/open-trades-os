import { describe, it, expect } from "vitest";
import {
  freeRound, estimateWait, estimatedWaitWords, callbackNumber, spokenNumber, callbackConfirmation, nextInLine,
  queueOutcome, twiml, clientAddress, CALLBACK_OFFER,
  type RingPlan,
} from "../src/voice/index.js";

/**
 * A WAITING LINE THAT CALLS BACK, SAYS HOW LONG, AND RINGS ONLY THE FREE
 *
 * The rules behind the three: who is left out of a round for being on a call,
 * when a wait is estimated at all and how it is said, who may be rung back and
 * on what number, and who is next when a caller on hold and a caller waiting
 * to be called back both want the next person free.
 */

const SAM = "22222222-2222-4222-8222-222222222222";
const one = (n: string, label: string) => ({ numbers: [n], labels: [label] });

describe("leaving people on a call out of the round", () => {
  const inOrder: RingPlan = { steps: [one("+15125550101", "Sam"), one("+15125550102", "Lee"), one("+15125550103", "Kim")], skipped: [] };

  it("rings the next person in turn who is free, and says where the next round starts", () => {
    expect(freeRound(inOrder, 0, new Set())).toMatchObject({ index: 0, step: { numbers: ["+15125550101"] }, skipped: [] });
    const past = freeRound(inOrder, 0, new Set(["+15125550101"]));
    expect(past).toMatchObject({ index: 1, step: { numbers: ["+15125550102"] }, skipped: ["Sam"] });
    expect(freeRound(inOrder, 2, new Set(["+15125550103"])).index).toBe(0);
  });

  it("rings everybody free at once, a browser as well as a phone, and nobody when all are busy", () => {
    const all: RingPlan = { steps: [{ numbers: [clientAddress(SAM), "+15125550102"], labels: ["Sam", "Lee"] }], skipped: [] };
    expect(freeRound(all, 3, new Set([clientAddress(SAM)])).step).toEqual({ numbers: ["+15125550102"], labels: ["Lee"] });
    expect(freeRound(all, 0, new Set([clientAddress(SAM), "+15125550102"]))).toEqual({ step: null, index: null, skipped: ["Sam", "Lee"] });
    expect(freeRound({ steps: [], skipped: [] }, 0, new Set()).step).toBeNull();
  });
});

describe("the estimated wait", () => {
  it("says nothing from fewer than five answered callers", () => {
    expect(estimateWait([30, 40, 50, 60])).toBeNull();
    expect(estimateWait([])).toBeNull();
  });

  it("takes the longer end: three in four were answered within it", () => {
    expect(estimateWait([60, 90, 100, 120, 150, 170])).toBe(150);
    expect(estimateWait([10, 10, 10, 10, 600])).toBe(10);
    expect(estimateWait([10, 20, 30, 40, Number.NaN, -5, 50])).toBe(40);
  });

  it("is said in whole minutes, rounded up, as what happened lately rather than a promise", () => {
    expect(estimatedWaitWords(150)).toBe("Most callers lately have been answered within about 3 minutes.");
    expect(estimatedWaitWords(20)).toBe("Most callers lately have been answered within about a minute.");
    expect(estimatedWaitWords(60)).toBe("Most callers lately have been answered within about a minute.");
  });
});

describe("being called back", () => {
  it("rings back only a number a phone can dial, and never an emergency number or a withheld one", () => {
    expect(callbackNumber("+15125550177")).toBe("+15125550177");
    expect(callbackNumber("anonymous")).toBeNull();
    expect(callbackNumber("+266696687")).toBeNull();
    expect(callbackNumber("+86282452253")).toBeNull();
    expect(callbackNumber("911")).toBeNull();
    expect(callbackNumber("")).toBeNull();
    expect(callbackNumber(null)).toBeNull();
  });

  it("reads the number back a digit at a time", () => {
    expect(spokenNumber("+15125550177")).toBe("5 1 2, 5 5 5, 0 1 7 7");
    expect(callbackConfirmation("+15125550177")).toBe(
      "Thanks. We will call you back on 5 1 2, 5 5 5, 0 1 7 7 when it is your turn, so you can hang up now. Goodbye.",
    );
  });

  it("keeps a callback's place against a caller who joined after it", () => {
    const early = new Date("2026-10-05T15:00:00Z");
    const late = new Date("2026-10-05T15:02:00Z");
    expect(nextInLine(late, early)).toBe("callback");
    expect(nextInLine(early, late)).toBe("caller");
    expect(nextInLine(null, early)).toBe("callback");
    expect(nextInLine(early, null)).toBe("caller");
    expect(nextInLine(null, null)).toBeNull();
  });

  it("offers it inside the wait for a key, with the music, so it can be pressed at any moment", () => {
    const xml = twiml([{ verb: "gather", action: "https://x/cb?q=1&h=1", numDigits: 1, timeoutSeconds: 1, say: CALLBACK_OFFER, play: "https://x/m.mp3" }]);
    expect(xml).toContain(
      `<Gather action="https://x/cb?q=1&amp;h=1" method="POST" numDigits="1" timeout="1"><Say>${CALLBACK_OFFER}</Say><Play>https://x/m.mp3</Play></Gather>`,
    );
    expect(twiml([{ verb: "gather", action: "https://x/a", numDigits: 1, timeoutSeconds: 6, say: "Hi" }]))
      .toContain('<Gather action="https://x/a" method="POST" numDigits="1" timeout="6"><Say>Hi</Say></Gather>');
  });

  it("reads a caller taken out of the line by the office as moved, not as gone or overflowing", () => {
    expect(queueOutcome("redirected", 20)).toEqual({ kind: "moved" });
    expect(queueOutcome("redirected-from-bridged", 20)).toEqual({ kind: "moved" });
  });
});
