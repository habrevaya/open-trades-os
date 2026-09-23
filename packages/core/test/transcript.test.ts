import { describe, it, expect } from "vitest";
import {
  normalizeSegments, describeDefect,
  luhn, redactText, redactTranscript, REDACTION_CATEGORIES, MASK_CHARACTER,
  resolveSpeakers, describeSpeakerRefusal,
  searchDocument, locate, formatTimestamp, fitToBudget, renderForSummary,
  weightedMeanConfidence, worstWindow, assessQuality, describeConcern, DEFAULT_QUALITY,
  type RawSegment, type Segment, type RedactionReport,
} from "../src/transcript/index.js";

/**
 * A transcript is the record of what somebody said. Everything in here is
 * about the two ways that record goes wrong: it is quietly untrue, or it
 * holds something that must not be in a database.
 */

const segment = (over: Partial<Segment> = {}): Segment => ({
  speaker: "Speaker 0",
  startMs: 0,
  endMs: 1_000,
  text: "Hello, my air conditioning is out.",
  confidence: 0.95,
  ...over,
});

/** A run of clean, non overlapping segments to build the other cases from. */
const run = (texts: readonly string[], confidence = 0.95): Segment[] =>
  texts.map((text, i) => segment({
    speaker: i % 2 === 0 ? "Speaker 0" : "Speaker 1",
    startMs: i * 5_000,
    endMs: i * 5_000 + 4_000,
    text,
    confidence,
  }));

const raw = (over: Partial<RawSegment> = {}): RawSegment => ({
  speaker: "Speaker 0", startMs: 0, endMs: 1_000, text: "Hello.", confidence: 0.9, ...over,
});

// ---------------------------------------------------------------------------

describe("taking a provider's output as a transcript", () => {
  it("accepts a well formed pair of segments unchanged", () => {
    const result = normalizeSegments([
      raw({ startMs: 0, endMs: 1_000, text: "  Hello.  " }),
      raw({ speaker: "Speaker 1", startMs: 1_000, endMs: 2_500, text: "Hi." }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.segments).toHaveLength(2);
    // Trimmed, because leading whitespace from a provider is noise that ends
    // up in the middle of a rendered line.
    expect(result.ok && result.segments[0]!.text).toBe("Hello.");
  });

  it("reads a numeric field a provider sent as a string", () => {
    // Several of them do, and a caller who has to remember to coerce forgets
    // once.
    const result = normalizeSegments([raw({ startMs: "0", endMs: "1500", confidence: "0.91" })]);
    expect(result.ok && result.segments[0]!.endMs).toBe(1_500);
    expect(result.ok && result.segments[0]!.confidence).toBeCloseTo(0.91, 5);
  });

  it("refuses an empty offset instead of reading it as the start of the call", () => {
    /**
     * `Number("")` and `Number(null)` are both zero, which is how a missing
     * offset becomes a segment that claims to be the first thing said.
     */
    for (const value of ["", null, undefined, "about a minute"]) {
      const result = normalizeSegments([raw({ startMs: value as never })]);
      expect(result.ok, String(value)).toBe(false);
      expect(result.ok === false && result.defects[0]!.kind).toBe("unreadable_number");
    }
  });

  it("refuses an empty segment list rather than calling it a silent call", () => {
    /**
     * A provider returning nothing is a failed job, an unsupported codec or
     * an empty file. Stored as an empty transcript it is indistinguishable
     * from a customer who never spoke.
     */
    const result = normalizeSegments([]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.defects).toEqual([{ kind: "no_segments" }]);
  });

  it("refuses a segment that ends before it starts, rather than swapping them", () => {
    // Almost always a field mapping the wrong way round, and the refusal
    // says so, because silently swapping makes the bug permanent.
    const result = normalizeSegments([raw({ startMs: 4_000, endMs: 1_000 })]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.defects[0]!.kind).toBe("ends_before_start");
    expect(result.ok === false && describeDefect(result.defects[0]!)).toMatch(/swapped/);
  });

  it("refuses a confidence outside zero to one rather than clamping it", () => {
    /**
     * 1.4 is not a very confident segment. It is a field holding a
     * percentage or a log probability, and clamping it to 1 turns a units
     * bug into the transcript every quality check trusts most.
     */
    for (const confidence of [1.4, -0.2, 97]) {
      const result = normalizeSegments([raw({ confidence })]);
      expect(result.ok, String(confidence)).toBe(false);
      expect(result.ok === false && result.defects[0]!.kind).toBe("confidence_out_of_range");
    }
  });

  it("refuses a segment with no words and one with no speaker", () => {
    expect(normalizeSegments([raw({ text: "   " })]).ok).toBe(false);
    expect(normalizeSegments([raw({ speaker: null })]).ok).toBe(false);
  });

  it("refuses overlapping segments", () => {
    /**
     * THE ONE THAT CANNOT BE FIXED BY SORTING. People talk over each other
     * constantly, so this is not a claim that overlap does not happen: it is
     * a claim that a flat list of segments cannot represent it. Two segments
     * occupying the same instant have no reading order, and choosing one is
     * choosing what the transcript says happened.
     */
    const result = normalizeSegments([
      raw({ speaker: "Speaker 0", startMs: 0, endMs: 4_000, text: "So what I think is" }),
      raw({ speaker: "Speaker 1", startMs: 3_000, endMs: 6_000, text: "no, it was the capacitor" }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.defects[0]!.kind).toBe("overlapping_segments");
    // The refusal names the repair, because "invalid transcript" is not
    // something a person integrating a provider can act on.
    expect(result.ok === false && describeDefect(result.defects[0]!)).toMatch(/track per channel/);
  });

  it("allows one segment to end exactly where the next begins", () => {
    // Touching is not overlapping, and a provider that emits contiguous
    // segments is the normal case rather than an error.
    const result = normalizeSegments([
      raw({ startMs: 0, endMs: 4_000 }),
      raw({ speaker: "Speaker 1", startMs: 4_000, endMs: 8_000 }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("puts segments in time order without treating disorder as an error", () => {
    // Sorting chooses a reading order and changes no value, so a provider
    // that emits per speaker rather than in time order is harmless.
    const result = normalizeSegments([
      raw({ startMs: 5_000, endMs: 9_000, text: "Second." }),
      raw({ speaker: "Speaker 1", startMs: 0, endMs: 4_000, text: "First." }),
    ]);
    expect(result.ok && result.segments.map((s) => s.text)).toEqual(["First.", "Second."]);
  });

  it("reports every defect at once rather than one per attempt", () => {
    // Fixing a provider mapping one refusal at a time is a slow afternoon.
    const result = normalizeSegments([
      raw({ speaker: "", confidence: 3 }),
      raw({ startMs: 9_000, endMs: 1_000, text: "" }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.defects.length).toBeGreaterThanOrEqual(4);
  });

  it("gives a person something to do for every defect it can produce", () => {
    const every = normalizeSegments([
      raw({ speaker: "", text: "", startMs: -5, confidence: 9 }),
      raw({ startMs: "x" }),
    ]);
    expect(every.ok).toBe(false);
    if (every.ok) return;
    for (const defect of [...every.defects, { kind: "no_segments" } as const]) {
      expect(describeDefect(defect).length, defect.kind).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// Redaction. The part that matters.
// ---------------------------------------------------------------------------

/** A Visa test number. Luhn valid, which is the whole point of using it. */
const CARD = "4111 1111 1111 1111";
/** Sixteen digits that are not a card: this one fails the check digit. */
const INVOICE = "1234 5678 9012 3456";

describe("the check digit that decides what gets masked", () => {
  it("passes a real card number and fails a number that merely looks like one", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("378282246310005")).toBe(true);
    expect(luhn("1234567890123456")).toBe(false);
    expect(luhn("9876543210987654")).toBe(false);
  });

  it("is not fooled by something that is not digits at all", () => {
    expect(luhn("")).toBe(false);
    expect(luhn("4111-1111")).toBe(false);
  });
});

describe("removing what must not be in the database", () => {
  it("masks a card number that a customer read out over the phone", () => {
    /**
     * The reason this module exists. Contractors take cards over the phone
     * constantly, and a transcript of one of those calls is cardholder data
     * in a text column that was scoped, backed up, replicated and exported
     * to a warehouse on the assumption that it holds job notes.
     */
    const result = redactText(`Sure, it is ${CARD}, on a Visa.`);
    expect(result.text).not.toContain("4111");
    expect(result.text).toContain("#### #### #### ####");
    expect(result.found).toHaveLength(1);
    expect(result.found[0]!.category).toBe("card_number");
    expect(result.found[0]!.basis).toBe("checksum");
  });

  it("leaves a sixteen digit number alone when it fails the check digit", () => {
    /**
     * THE WHOLE REASON LUHN IS IN HERE. A rule that masks any sixteen digit
     * run also masks the equipment serial number, the model number, the
     * permit number and the invoice number, all of which get read aloud on
     * exactly these calls and all of which are the reason somebody opens the
     * transcript six months later. Masking the serial off a warranty call
     * destroys the only useful thing in it.
     */
    const result = redactText(`The invoice number is ${INVOICE}, if that helps.`);
    expect(result.text).toContain(INVOICE);
    expect(result.found).toHaveLength(0);
  });

  it("masks every separator style a person reads a card in", () => {
    for (const form of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1"]) {
      const result = redactText(`It is ${form}.`);
      expect(result.found.length, form).toBe(1);
      expect(result.text, form).not.toMatch(/4111/);
    }
  });

  it("masks a thirteen and a fifteen digit card, not only a sixteen", () => {
    // American Express is fifteen. A rule tuned to sixteen stores every
    // Amex number it sees.
    expect(redactText("378282246310005").found[0]!.category).toBe("card_number");
    expect(redactText("4222222222222").found[0]!.category).toBe("card_number");
  });

  it("finds a card that was read straight into the expiry with no pause", () => {
    /**
     * A run longer than any card cannot itself be a card, so the only
     * question left is whether one is embedded in it. This is the case where
     * a substring search is right, and the comment in the source says why it
     * is wrong everywhere else.
     */
    const result = redactText("4111 1111 1111 1111 12 26 and that is it");
    expect(result.text).not.toContain("4111");
    expect(result.found[0]!.category).toBe("card_number");
  });

  it("masks the security code when it arrives a turn after the question", () => {
    /**
     * The security code is almost never in the same breath as the card. It
     * is "and the three digits on the back?" followed by a segment
     * containing nothing but the number, so a detector that only sees one
     * segment never catches the one field PCI is most emphatic about.
     */
    const segments = run([
      `Right, the card is ${CARD}.`,
      "And the three digits on the back?",
      "It is 731.",
    ]);
    const { segments: clean, report } = redactTranscript(segments);
    expect(clean[2]!.text).toBe("It is ###.");
    expect(report.countsByCategory.card_security_code).toBe(1);
  });

  it("does not treat every three digit number as a security code", () => {
    /**
     * Three digits is the most ambiguous thing in a transcript: a house
     * number, a part number, a price, a temperature. The detector is armed
     * by card context rather than being always on, or half the addresses in
     * the company get masked.
     */
    const { segments: clean, report } = redactTranscript(run([
      "We will be there between 8 and 9.",
      "It is unit 412, the one behind the gate.",
    ]));
    expect(clean[1]!.text).toContain("412");
    expect(report.redacted).toBe(false);
  });

  it("masks a social security number from its shape alone", () => {
    // Nothing else in a trades conversation is written three, two, four.
    const result = redactText("He gave his social as 412-55-9981 for the permit.");
    expect(result.text).toContain("###-##-####");
    expect(result.found[0]!.category).toBe("ssn");
  });

  it("masks a routing number on its own checksum, and leaves a permit number alone", () => {
    /**
     * Nine digit numbers are far commoner in a trades conversation than
     * sixteen digit ones. Requiring the Federal Reserve prefix range as well
     * as the check digit is what keeps the permit number readable.
     */
    expect(redactText("021000021").found[0]!.category).toBe("bank_routing_number");
    expect(redactText("Permit 987654321 was issued in June.").found).toHaveLength(0);
  });

  it("masks a bank account number only when somebody says what it is", () => {
    // Account numbers have no checksum and no fixed length, so context is
    // all there is. Without it they are indistinguishable from a job number.
    expect(redactText("The account number is 000123456789.").found[0]!.category).toBe("bank_account_number");
    expect(redactText("Job 000123456789 is the one.").found).toHaveLength(0);
  });

  it("names every category it can produce, because a viewer has to label the mask", () => {
    for (const category of REDACTION_CATEGORIES) {
      expect(category.length).toBeGreaterThan(0);
    }
    expect(new Set(REDACTION_CATEGORIES).size).toBe(REDACTION_CATEGORIES.length);
  });
});

describe("what masking must not disturb", () => {
  const spoken = run([
    "Hi, the unit is dead again.",
    `Let me take payment, it is ${CARD} on a Visa.`,
    "Great, we will see you Tuesday.",
  ]);

  it("replaces rather than deletes, so every character offset survives", () => {
    /**
     * Deleting shifts every character after it, and character offsets are
     * how a search hit is pointed back at a segment and therefore at a
     * moment in the audio. A transcript whose offsets no longer agree with
     * the recording is one where clicking a result plays the wrong sentence,
     * and the person listening concludes it is a recording of another call.
     */
    const { segments: clean } = redactTranscript(spoken);
    for (let i = 0; i < spoken.length; i += 1) {
      expect(clean[i]!.text.length, `segment ${i}`).toBe(spoken[i]!.text.length);
    }
  });

  it("leaves the millisecond offsets exactly as they were", () => {
    const { segments: clean } = redactTranscript(spoken);
    for (let i = 0; i < spoken.length; i += 1) {
      expect(clean[i]!.startMs).toBe(spoken[i]!.startMs);
      expect(clean[i]!.endMs).toBe(spoken[i]!.endMs);
      expect(clean[i]!.speaker).toBe(spoken[i]!.speaker);
      expect(clean[i]!.confidence).toBe(spoken[i]!.confidence);
    }
  });

  it("points at exactly the characters it masked", () => {
    const { segments: clean, report } = redactTranscript(spoken);
    const site = report.sites[0]!;
    const masked = clean[site.segmentIndex]!.text.slice(site.start, site.start + site.length);
    expect(masked).toBe("#### #### #### ####");
    expect(masked.length).toBe(site.length);
    // And the original still had the value at that same position, which is
    // what "preserves the position" means.
    expect(spoken[site.segmentIndex]!.text.slice(site.start, site.start + site.length)).toBe(CARD);
  });

  it("does not touch the words around it", () => {
    const { segments: clean } = redactTranscript(spoken);
    expect(clean[1]!.text).toBe("Let me take payment, it is #### #### #### #### on a Visa.");
    expect(clean[0]!.text).toBe(spoken[0]!.text);
  });
});

/** Every string anywhere inside a value, however deeply nested. */
function stringLeaves(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringLeaves(item, into);
  return into;
}

describe("the report of what was removed", () => {
  const sensitive = run([
    `The card is ${CARD}.`,
    "And the code on the back?",
    "731. And my social is 412-55-9981 if you need it.",
  ]);

  it("never contains the value it redacted, anywhere, at any depth", () => {
    /**
     * THE TEST THIS SECTION EXISTS FOR. A redaction log that contains what
     * it redacted is strictly worse than no redaction: the transcript is now
     * clean so nobody worries about it, and the card number has been copied
     * into an audit table that is even less likely to be reviewed. So the
     * check is not "no card field", it is that no string anywhere in the
     * report carries a digit at all.
     */
    const { report } = redactTranscript(sensitive);
    expect(report.redacted).toBe(true);

    const serialised = JSON.stringify(report);
    for (const fragment of ["4111", "1111", "41115", "412-55-9981", "9981", "731"]) {
      expect(serialised, fragment).not.toContain(fragment);
    }
    for (const leaf of stringLeaves(report)) {
      expect(leaf, leaf).not.toMatch(/[0-9]/);
    }
  });

  it("says what kind of thing it was and where, which is all a viewer needs", () => {
    const { report } = redactTranscript(sensitive);
    const categories = report.sites.map((s) => s.category);
    expect(categories).toContain("card_number");
    expect(categories).toContain("ssn");
    for (const site of report.sites) {
      expect(site.segmentIndex).toBeGreaterThanOrEqual(0);
      expect(site.length).toBeGreaterThan(0);
      expect(Object.keys(site).sort()).toEqual(["basis", "category", "length", "segmentIndex", "start"]);
    }
  });

  it("counts every category, including the ones that did not fire", () => {
    // A dashboard that only shows categories with a hit cannot show a zero,
    // and a zero is the number somebody is looking for.
    const { report }: { report: RedactionReport } = redactTranscript(sensitive);
    for (const category of REDACTION_CATEGORIES) {
      expect(typeof report.countsByCategory[category], category).toBe("number");
    }
    expect(report.countsByCategory.bank_routing_number).toBe(0);
  });

  it("says nothing was removed when nothing was", () => {
    const { report } = redactTranscript(run(["The condenser fan is seized.", "We can be there Thursday."]));
    expect(report.redacted).toBe(false);
    expect(report.sites).toHaveLength(0);
  });
});

describe("what this redaction will miss, stated plainly", () => {
  it("does not catch a card number spoken as words", () => {
    /**
     * A real and common false negative, asserted rather than hidden so that
     * nobody reads this module as complete protection. "Four one one one,
     * one one one one" is how a nervous customer reads a card, and nothing
     * here matches a digit pattern in it. The answer is not a bigger regex,
     * it is not recording the payment portion of the call.
     */
    const result = redactText("It is four one one one, one one one one, one one one one, one one one one.");
    expect(result.found).toHaveLength(0);
  });

  it("does not catch a real card whose digits the provider misheard, unless the word card is nearby", () => {
    /**
     * Speech recognition confuses five and nine constantly, and a single
     * wrong digit breaks the check digit. With card context we mask it
     * anyway, on the context alone, because a mis-transcribed card is still
     * cardholder data. Without context it goes through, and that is the gap.
     */
    expect(redactText(`Here you go: ${INVOICE}.`).found).toHaveLength(0);
    const guarded = redactText(`My card number is ${INVOICE}.`);
    expect(guarded.found[0]!.category).toBe("card_number");
    expect(guarded.found[0]!.basis).toBe("context");
  });

  it("uses one mask character for everything, so a screenshot does not annotate the gap", () => {
    expect(MASK_CHARACTER).toBe("#");
    const result = redactText(`${CARD} and 412-55-9981`);
    expect(result.text).not.toMatch(/CARD|SSN|REDACTED/i);
  });
});

// ---------------------------------------------------------------------------

describe("deciding whose voice is whose", () => {
  const spoken = run(["Thanks for calling.", "Hi, my AC is out.", "Who is that in the background?"]);

  it("uses the mapping it was given and does not invent one", () => {
    /**
     * The tempting rule is "whoever spoke first answered the call". It is
     * right most of the time and wrong exactly when it matters: when the
     * customer talks over the greeting, when an auto attendant counts as a
     * speaker, when the call was transferred. A role is an assertion about
     * who said something.
     */
    const result = resolveSpeakers(spoken, { "Speaker 0": "answerer", "Speaker 1": "caller" });
    expect(result.ok && result.segments.map((s) => s.role)).toEqual(["answerer", "caller", "answerer"]);
  });

  it("refuses to proceed with no mapping at all", () => {
    const result = resolveSpeakers(spoken, {});
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.kind).toBe("no_mapping");
    expect(result.ok === false && describeSpeakerRefusal(result.refusal)).toMatch(/guess/);
  });

  it("refuses a mapping that makes two labels the same person", () => {
    // Exactly one person placed the call and one answered it. A mapping
    // that says otherwise came from a bad join or another call, and
    // everything downstream would be a confident statement built on it.
    const result = resolveSpeakers(spoken, { "Speaker 0": "caller", "Speaker 1": "caller" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.kind).toBe("duplicate_role");
    expect(result.ok === false && describeSpeakerRefusal(result.refusal)).toMatch(/Speaker 0, Speaker 1/);
  });

  it("allows two third parties, because two people in a room is ordinary", () => {
    const result = resolveSpeakers(spoken, {
      "Speaker 0": "answerer", "Speaker 1": "third_party", "Speaker 2": "third_party",
    });
    expect(result.ok).toBe(true);
  });

  it("marks a speaker nobody expected as unidentified rather than dropping the call", () => {
    /**
     * Diarisation finds a fourth voice when the radio is on in the truck.
     * Refusing loses the call over a cough; folding it into third party
     * asserts a person was there. Unidentified is honest, and the flag is
     * what a caller checks before quoting anything.
     */
    const extra = [...spoken, segment({ speaker: "Speaker 7", startMs: 20_000, endMs: 22_000, text: "Is that the dog?" })];
    const result = resolveSpeakers(extra, { "Speaker 0": "answerer", "Speaker 1": "caller" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.unexpectedLabels).toEqual(["Speaker 7"]);
    expect(result.ok && result.segments[3]!.role).toBe("unknown");
  });

  it("reports a mapping entry the call never used", () => {
    // Usually a stale mapping built for a different call, which is worth
    // seeing before anybody trusts the roles.
    const result = resolveSpeakers(spoken, {
      "Speaker 0": "answerer", "Speaker 1": "caller", "Speaker 4": "third_party",
    });
    expect(result.ok && result.unusedLabels).toEqual(["Speaker 4"]);
  });
});

// ---------------------------------------------------------------------------

describe("the form that goes into a search index", () => {
  const spoken = run(["The unit is at 214 Oak Street.", "Got it, unit 214."]);

  it("keeps timestamps out of the indexed text", () => {
    /**
     * Writing "[02:14]" into the indexed string is the obvious way to keep
     * the link to the audio and it quietly ruins search: every timestamp is
     * a token, so a query for a unit number like 214 matches the clock on a
     * hundred unrelated calls and the operator concludes search is broken.
     */
    const document = searchDocument(spoken);
    expect(document.text).toBe("The unit is at 214 Oak Street.\nGot it, unit 214.");
    expect(document.text).not.toMatch(/\[\d\d:\d\d\]/);
  });

  it("points a character offset back at the moment in the audio", () => {
    // The whole reason the span table exists: a result the operator clicks
    // to hear the sentence.
    const document = searchDocument(spoken);
    const hit = document.text.indexOf("Got it");
    expect(locate(document, hit)).toMatchObject({ segmentIndex: 1, startMs: 5_000 });
    expect(locate(document, 0)).toMatchObject({ segmentIndex: 0, startMs: 0 });
  });

  it("returns nothing for an offset between segments rather than snapping", () => {
    // Snapping would point at a sentence nobody matched.
    const document = searchDocument(spoken);
    expect(locate(document, document.text.indexOf("\n"))).toBeNull();
    expect(locate(document, 10_000)).toBeNull();
  });

  it("writes a timestamp a person can read", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(74_000)).toBe("01:14");
    expect(formatTimestamp(3_723_000)).toBe("1:02:03");
  });
});

describe("cutting a transcript down to fit a model", () => {
  const long = run(Array.from({ length: 40 }, (_, i) => `Segment number ${i} says something about the compressor.`));

  it("keeps everything when everything fits", () => {
    const result = fitToBudget(long, 100_000);
    expect(result.ok && result.kept).toHaveLength(40);
    expect(result.ok && result.elision).toBeNull();
  });

  it("never cuts in the middle of a segment", () => {
    /**
     * The default everywhere is to truncate at a character boundary, and it
     * is the worst available option, because a language model does not
     * notice that a sentence stopped. "The compressor is under warranty
     * until" becomes a summary that states the compressor is under warranty,
     * full stop, in a confident sentence an office manager repeats to a
     * customer. A half fact presented whole is worse than a missing fact,
     * because a missing fact gets looked up.
     */
    const result = fitToBudget(long, 800);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const kept of result.kept) {
      expect(long).toContainEqual(kept);
      expect(kept.text).toMatch(/\.$/);
    }
    expect(result.kept.length).toBeLessThan(40);
  });

  it("drops from the middle, keeping why they rang and what was agreed", () => {
    /**
     * The start of a service call is why they rang and where they are. The
     * end is what was agreed: the date, the price, the promise. The middle
     * is diagnosis and repetition, and dropping the tail to fit is how a
     * summary loses the appointment it was run to find.
     */
    const result = fitToBudget(long, 800);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kept[0]).toEqual(long[0]);
    expect(result.kept[result.kept.length - 1]).toEqual(long[39]);
    expect(result.elision).not.toBeNull();
    expect(result.elision!.droppedCount).toBe(40 - result.kept.length);
  });

  it("refuses when not one whole segment fits, rather than cutting a sentence", () => {
    // There is no budget so small that a confidently wrong summary becomes
    // acceptable. The caller raises the budget or summarises in pieces.
    const result = fitToBudget(long, 20);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.kind).toBe("budget_below_one_segment");
    expect(result.ok === false && result.refusal.smallestSegmentChars).toBeGreaterThan(20);
  });

  it("stays inside the budget it was given", () => {
    for (const budget of [400, 800, 1_500, 2_400]) {
      const result = fitToBudget(long, budget);
      expect(result.ok, String(budget)).toBe(true);
      if (!result.ok) continue;
      const rendered = renderForSummary(result.kept, result.elision);
      expect(rendered.length, String(budget)).toBeLessThanOrEqual(budget);
    }
  });
});

describe("the text handed to a summariser", () => {
  const spoken = run(["Hi, my AC is out.", "Since when?", "Since Friday."]);

  it("labels each line with a role and a timestamp", () => {
    const resolved = resolveSpeakers(spoken, { "Speaker 0": "caller", "Speaker 1": "answerer" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(renderForSummary(resolved.segments)).toBe(
      "[00:00] Caller: Hi, my AC is out.\n[00:05] Answerer: Since when?\n[00:10] Caller: Since Friday.",
    );
  });

  it("falls back to the provider label when no role was resolved", () => {
    // An unresolved transcript is still readable, and a line attributed to
    // "Speaker 1" is honest in a way that "Caller" would not be.
    expect(renderForSummary(spoken)).toContain("Speaker 0:");
  });

  it("tells the model that material is missing, and where", () => {
    /**
     * A model given a transcript with a silent gap narrates straight across
     * it, because nothing told it there was one. Told explicitly that
     * eleven minutes are missing it hedges, which is correct and is the only
     * behaviour available to it.
     */
    const long = run(Array.from({ length: 30 }, (_, i) => `Line ${i} about the condenser and the fan.`));
    const result = fitToBudget(long, 700);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.elision) return;
    const rendered = renderForSummary(result.kept, result.elision);
    expect(rendered).toMatch(/\[\.\.\. \d+ segments omitted, \d\d:\d\d to \d\d:\d\d \.\.\.\]/);
    // In the middle, so the model can tell which side of the gap a
    // statement came from.
    const lines = rendered.split("\n");
    const notice = lines.findIndex((line) => line.startsWith("[..."));
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(lines.length - 1);
  });
});

// ---------------------------------------------------------------------------

describe("whether a transcript is good enough to act on", () => {
  /** Ten good minutes, then a patch of noise. Offsets are contiguous. */
  const withBadPatch = (badConfidence: number): Segment[] => [
    ...Array.from({ length: 10 }, (_, i) => segment({
      startMs: i * 18_000, endMs: i * 18_000 + 18_000, text: `Good segment ${i}.`, confidence: 0.97,
    })),
    segment({ startMs: 180_000, endMs: 188_000, text: "It is on Manchaca, m a n c h", confidence: badConfidence }),
    segment({ startMs: 188_000, endMs: 196_000, text: "sorry, say again", confidence: badConfidence }),
  ];

  it("flags a transcript with one terrible patch even though the mean is fine", () => {
    /**
     * THE CASE A MEAN HIDES, AND IT IS NEVER RANDOM. A transcript that is
     * excellent for three minutes and garbage for thirty seconds has a mean
     * around 0.93 and gets acted on. The thirty seconds is the part where
     * somebody read out a street name the model has never heard, over a
     * speakerphone, in a truck, with the engine running. The mean is high
     * precisely because the rest of the call was pleasantries.
     */
    const assessment = assessQuality(withBadPatch(0.3));
    expect(assessment.meanConfidence).toBeGreaterThan(DEFAULT_QUALITY.meanFloor);
    expect(assessment.concerns.map((c) => c.kind)).toEqual(["low_patch"]);
    expect(assessment.actOnAutomatically).toBe(false);
    expect(assessment.worstWindow!.startMs).toBe(180_000);
  });

  it("acts on a transcript that is good all the way through", () => {
    const assessment = assessQuality(withBadPatch(0.95));
    expect(assessment.concerns).toHaveLength(0);
    expect(assessment.actOnAutomatically).toBe(true);
  });

  it("points a person at the stretch to listen to, not at the whole call", () => {
    const assessment = assessQuality(withBadPatch(0.3));
    const text = describeConcern(assessment.concerns[0]!);
    expect(text).toContain("03:00");
    expect(text).toMatch(/address or a phone number/);
  });

  it("weights confidence by how long somebody spoke", () => {
    /**
     * An unweighted mean treats "mm hm" and a thirty second explanation of
     * where the gate key is as equally informative. A call is full of short
     * acknowledgements and a provider is extremely confident about every one
     * of them, so an unweighted mean drifts upward with every "yeah" and
     * reports a healthy number for a transcript whose content is a mess.
     */
    const chatter: Segment[] = [
      ...Array.from({ length: 20 }, (_, i) => segment({
        startMs: i * 300, endMs: i * 300 + 300, text: "mm hm", confidence: 0.99,
      })),
      segment({ startMs: 6_000, endMs: 66_000, text: "a long, badly heard explanation", confidence: 0.5 }),
    ];
    const unweighted = chatter.reduce((sum, s) => sum + s.confidence, 0) / chatter.length;
    expect(unweighted).toBeGreaterThan(DEFAULT_QUALITY.meanFloor);
    expect(weightedMeanConfidence(chatter)).toBeLessThan(DEFAULT_QUALITY.meanFloor);
    expect(assessQuality(chatter).concerns.map((c) => c.kind)).toContain("low_mean");
  });

  it("flags a transcript that is bad everywhere on both counts", () => {
    const assessment = assessQuality(withBadPatch(0.3).map((s) => ({ ...s, confidence: 0.4 })));
    expect(assessment.concerns.map((c) => c.kind).sort()).toEqual(["low_mean", "low_patch"]);
  });

  it("does not manufacture a bad patch out of a silence", () => {
    // Windows are anchored at segment starts, so every window considered
    // contains speech. A gap between two calls-worth of talking is not a
    // stretch of unreliable transcription.
    const spaced: Segment[] = [
      segment({ startMs: 0, endMs: 5_000, confidence: 0.96 }),
      segment({ startMs: 600_000, endMs: 605_000, confidence: 0.96 }),
    ];
    expect(assessQuality(spaced).concerns).toHaveLength(0);
    expect(worstWindow(spaced, 15_000)!.confidence).toBeCloseTo(0.96, 5);
  });

  it("has nothing to say about no segments at all", () => {
    expect(worstWindow([], 15_000)).toBeNull();
    expect(weightedMeanConfidence([])).toBe(0);
  });

  it("takes a threshold rather than hiding one", () => {
    // The numbers are a policy, not a measurement: a confidence means
    // something slightly different for every engine.
    const relaxed = assessQuality(withBadPatch(0.3), { meanFloor: 0.5, windowMs: 15_000, windowFloor: 0.2 });
    expect(relaxed.actOnAutomatically).toBe(true);
  });
});

/**
 * A CARD NUMBER WITH AN EMOJI IN FRONT OF IT
 *
 * `redactTranscript` built its character array with `[...text]`, which splits
 * into CODE POINTS, while every index written into it comes from UTF-16
 * offsets: `match.index` from `matchAll`, and `i` from `charCodeAt`. One
 * astral character anywhere earlier in the segment, which is any emoji and
 * plenty of CJK, makes the two index spaces disagree by one per surrogate
 * pair.
 *
 * The measured output for "🙂 my card is 4111 1111 1111 1111 ok" was
 * "🙂 my card is 4####1####1####1####ok". Four digits of the card survived
 * into the string written to the database, the spaces this function's own
 * comment says are left alone were the characters that got masked instead,
 * and the recorded offset was one short, so a reviewer's highlight would sit
 * on the wrong character.
 *
 * Every existing test used plain ASCII, where the two index spaces coincide
 * exactly, which is why all of them passed.
 */
describe("redaction with characters outside the basic plane", () => {
  const spoken = (text: string) =>
    redactTranscript([{ speaker: "caller", startsAt: 0, endsAt: 5, text }] as never);

  const digitsIn = (text: string) => (text.match(/\d/g) ?? []).join("");

  it("destroys every digit of the card, emoji or no emoji", () => {
    for (const prefix of ["", "🙂 ", "🙂🙂 ", "𝕏 "]) {
      const out = spoken(`${prefix}my card is 4111 1111 1111 1111 ok`);
      const text = out.segments[0]!.text;
      // The surviving digits, not the literal string. A first attempt at this
      // asserted the output did not contain "4111", which passed against the
      // broken code: the survivors come back separated by mask characters, so
      // the substring never appears and the assertion measured nothing.
      expect([prefix, digitsIn(text)]).toEqual([prefix, ""]);
    }
  });

  it("keeps the words around it intact", () => {
    const out = spoken("🙂 my card is 4111 1111 1111 1111 ok");
    const text = out.segments[0]!.text;
    expect(text.startsWith("🙂 my card is ")).toBe(true);
    expect(text.endsWith(" ok")).toBe(true);
  });

  it("records an offset that lands on the masked run, not next to it", () => {
    /**
     * The offset is what a reviewer's highlight is drawn from, and it was one
     * short: the run it pointed at started on the space before the number.
     * Asserted against the ASCII answer for the same sentence, so the test
     * states the property rather than a number I read off a run.
     */
    const withEmoji = spoken("🙂 my card is 4111 1111 1111 1111 ok");
    const plain = spoken("my card is 4111 1111 1111 1111 ok");

    const a = withEmoji.report.sites[0];
    const b = plain.report.sites[0];
    expect([a, b].every(Boolean)).toBe(true);

    // The emoji is two UTF-16 units plus a space, so the offset moves by
    // exactly three and the length does not move at all.
    expect(a!.start - b!.start).toBe(3);
    expect(a!.length).toBe(b!.length);

    // And what sits at that offset is a mask rather than the space in front
    // of the number.
    const text = withEmoji.segments[0]!.text;
    expect(text[a!.start]).not.toBe(" ");
  });
});
