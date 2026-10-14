import { describe, it, expect } from "vitest";
import { agents } from "../src/index.js";

/**
 * THE PHONE ASSISTANT SPEAKS AS IT WRITES, AND CAN SEND A CALLER ON
 *
 * The words of a reply read out of JSON still being written, said a finished
 * sentence at a time, each held to the same price rule as a whole answer; and
 * the places a company lets the assistant send a caller, which are the only
 * places it may name.
 */

const LINE = "77777777-7777-4777-8777-777777777777";
const MENU = "88888888-8888-4888-8888-888888888888";

describe("reading a reply while it is written", () => {
  it("reads the text field as far as it has got, escapes and all", () => {
    expect(agents.partialString('{"te', "text")).toBeNull();
    expect(agents.partialString('{"text": "Hel', "text")).toBe("Hel");
    expect(agents.partialString('{"text":"Say \\"hi\\"\\nnow', "text")).toBe('Say "hi"\nnow');
    expect(agents.partialString('{"text":"cut \\', "text")).toBe("cut ");
    expect(agents.partialString('{"text":"caf\\u00e9 and \\u00', "text")).toBe("café and ");
    expect(agents.partialString('{"other":"text","text":"yes"}', "text")).toBe("yes");
    expect(agents.partialString('{"address":{"text":"inner"},"text":"outer', "text")).toBe("outer");
  });

  it("says each sentence once it is finished, and keeps the rest for the whole answer", () => {
    let state = agents.STREAM_START;
    let step = agents.streamReply(state, "A water heater visit is $149. Would you", ["149"]);
    expect(step.speak).toEqual(["A water heater visit is $149."]);
    state = step.state;
    step = agents.streamReply(state, "A water heater visit is $149. Would you like to book? We have", ["149"]);
    expect(step.speak).toEqual(["Would you like to book?"]);
    state = step.state;
    expect(state.said).toBe("A water heater visit is $149. Would you like to book?");
    expect(agents.restOfReply(state, "A water heater visit is $149. Would you like to book? We have Tuesday open.")).toBe("We have Tuesday open.");
  });

  it("never splits a price, and stops for good at a sentence with a price nobody published", () => {
    const half = agents.streamReply(agents.STREAM_START, "It is $1", ["149"]);
    expect(half.speak).toEqual([]);
    const step = agents.streamReply(agents.STREAM_START, "We can help. A new one is $1,400. It takes a day. ", ["149"]);
    expect(step.speak).toEqual(["We can help."]);
    expect(step.state.stopped).toBe(true);
    expect(agents.streamReply(step.state, "We can help. A new one is $1,400. It takes a day. More. ", ["149"]).speak).toEqual([]);
  });
});

describe("places the assistant may send a caller", () => {
  const places = [{ id: LINE, label: "Billing questions" }];
  const decide = (args: Record<string, unknown>) => agents.decideVoice({
    action: "transfer", args, allowedPrices: [], windows: [], callerNumber: null,
    bookingTaken: false, messageTaken: false, lookedUp: false, places,
  });

  it("sends the caller to a place on the list", () => {
    expect(decide({ reason: "A billing question.", place: LINE })).toEqual({
      kind: "transfer", reason: "A billing question.", text: "Of course. Let me send you to the right place. Please hold.",
      place: { id: LINE, label: "Billing questions" },
    });
  });

  it("refuses a place not on the list, and puts the caller through to a person", () => {
    const refused = decide({ reason: "Billing.", place: MENU });
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.then).toEqual({ kind: "transfer", reason: "Billing.", text: agents.PUTTING_THROUGH });
  });

  it("reads the list leniently from storage and checks it strictly on saving", () => {
    const read = agents.readSettings("voice", { voice: { places: [
      { kind: "queue", id: LINE, label: " Billing questions " }, { kind: "fax", id: MENU, label: "x" }, { kind: "menu", id: "nope", label: "y" },
    ] } });
    expect(read.voice.places).toEqual([{ kind: "queue", id: LINE, label: "Billing questions" }]);
    expect(agents.defaultSettings("voice").voice.places).toEqual([]);

    const base = agents.defaultSettings("voice");
    const withPlaces = (list: agents.VoicePlace[]) => agents.checkSettings("voice", { ...base, voice: { ...base.voice, places: list } });
    expect(withPlaces([{ kind: "queue", id: LINE, label: "Billing questions" }]).ok).toBe(true);
    expect(withPlaces([{ kind: "queue", id: LINE, label: "" }]).ok).toBe(false);
    expect(withPlaces([{ kind: "queue", id: LINE, label: "A" }, { kind: "queue", id: LINE, label: "B" }]).ok).toBe(false);
  });

  it("tells the model the places by id and what each is for, and nothing when there are none", () => {
    const input = {
      company: { name: "Acme", timezone: "America/Chicago", today: "2026-10-14" } as never, tone: "Plain.",
      facts: { hours: [], serviceArea: null, services: [], publicPrices: [], faq: [], windows: [] } as never,
      turns: [], caller: { number: null, candidates: [], lookedUp: false }, bookingTaken: false, messageTaken: false,
    };
    const told = agents.voicePrompt({ ...input, places });
    expect(told.user).toContain(LINE);
    expect(told.user).toContain("Billing questions");
    expect(told.system).toContain("as place");
    expect(agents.voicePrompt(input).system).not.toContain("as place");
  });
});
