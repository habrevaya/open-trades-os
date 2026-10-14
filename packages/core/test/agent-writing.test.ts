import { describe, it, expect } from "vitest";
import { showAsWritten, shownText, SHOWN_START, type Shown } from "../src/agents/index.js";

/**
 * AN ANSWER SHOWN AS IT IS WRITTEN
 *
 * Whole sentences only, never half a price, and nothing from the first
 * sentence naming an amount the company did not publish onwards.
 */

/** Feed the words in as the model writes them, a few characters at a time. */
function feed(whole: string, allowed: readonly string[], step = 3): { state: Shown; shown: string[] } {
  let state = SHOWN_START;
  const shown: string[] = [];
  for (let at = step; at < whole.length + step; at += step) {
    const next = showAsWritten(state, whole.slice(0, at), allowed);
    state = next.state;
    if (next.changed) shown.push(shownText(state));
  }
  return { state, shown };
}

describe("showing an answer as it is written", () => {
  it("shows each sentence once it is finished, and nothing half written", () => {
    const { shown } = feed("We service furnaces. A tune up is $89. Book online any time", ["89"]);
    expect(shown).toEqual(["We service furnaces.", "We service furnaces. A tune up is $89."]);
  });

  it("treats the end of a line as the end of a sentence", () => {
    const first = showAsWritten(SHOWN_START, "Steps:\n1) Shut off the gas", []);
    expect(shownText(first.state)).toBe("Steps:");
  });

  it("never shows a sentence naming an amount nobody published, nor anything after it", () => {
    const { state, shown } = feed("We can help. That would be about $450 for the part. It takes an hour. ", ["89"]);
    expect(shown).toEqual(["We can help."]);
    expect(state.stopped).toBe(true);
    expect(showAsWritten(state, "We can help. That would be about $450 for the part. It takes an hour. More. ", []).changed).toBe(false);
  });

  it("stops showing at the longest an answer may be", () => {
    const long = "This is a sentence of some length. ".repeat(80);
    const { state } = feed(long, [], 50);
    expect(shownText(state).length).toBeLessThanOrEqual(1500);
    expect(shownText(state).endsWith(".")).toBe(true);
  });

  it("says nothing changed when no sentence has finished since", () => {
    const once = showAsWritten(SHOWN_START, "Hello there. How", []);
    expect(once.changed).toBe(true);
    expect(showAsWritten(once.state, "Hello there. How are", []).changed).toBe(false);
  });
});
