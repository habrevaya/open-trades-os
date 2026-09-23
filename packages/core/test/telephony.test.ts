import { describe, it, expect } from "vitest";
import {
  CALL_STATES, CALL_STATE, CALL_TRANSITIONS, canTransition, checkSequence, isTerminal,
  CONSENT_RULES, CONSENT_RULE, checkRecordingPolicies, governingPolicy, mayRecord,
  WEEKDAYS, checkBusinessHours, hoursAt, weekdayOf, withinWindow,
  CONDITION_KINDS, checkRoutingTable, route,
  CALL_OUTCOMES, CALL_OUTCOME, classify, DEFAULT_OUTCOME_THRESHOLDS,
  type CallParty, type JurisdictionPolicy, type BusinessHours, type OpenWindow,
  type Weekday, type RoutingTable, type RoutingCondition, type CallRecord, type CallFacts,
} from "../src/telephony/index.js";

/**
 * THE PHONE, WHICH IS STILL HOW WORK ARRIVES
 *
 * A missed call is not a missed message. It is the customer ringing the next
 * name on the list, and nobody at this end ever knowing it happened.
 *
 * The cases worth writing down are the ugly ones: the same instant on either
 * side of a daylight saving change, a caller whose location nobody captured, a
 * rule set that matches nothing on a Saturday, and a two second call that every
 * phone system on the market counts as answered.
 */

/* -------------------------------------------------------------- the states */

describe("the states a call really passes through", () => {
  it("lets a call reach voicemail without ever being answered", () => {
    // A voicemail box is not a person picking up. A machine that models it as
    // an answer reports a company nobody can get hold of as answering
    // everything.
    expect(canTransition("ringing", "voicemail").ok).toBe(true);
    expect(canTransition("ringing", "answered").ok).toBe(true);
  });

  it("refuses a transition that skips the answer", () => {
    const verdict = canTransition("ringing", "in_progress");
    expect(verdict.ok).toBe(false);
    // The reader is usually staring at a provider webhook log trying to work
    // out which of the two systems is wrong, so the refusal names both states.
    expect(verdict.ok === false && verdict.reason).toContain("ringing");
    expect(verdict.ok === false && verdict.reason).toContain("in progress");
  });

  it("names the states that would have been legal instead", () => {
    // "Invalid transition" sends somebody to read the source. This does not.
    const verdict = canTransition("ringing", "on_hold");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("answered");
    expect(verdict.ok === false && verdict.allowed).toContain("voicemail");
  });

  it("refuses to move a call that has already ended, and says why", () => {
    /**
     * If the customer rang again, that is a second call, and merging the two
     * loses one of them from every count. The reason has to SAY that: an
     * ended call refuses every transition anyway, because a terminal state has
     * nowhere to go, so a test that only checked the refusal would pass with
     * the explanation gone and leave whoever reads the log no better off.
     */
    for (const from of ["completed", "abandoned", "voicemail", "failed"] as const) {
      const verdict = canTransition(from, "in_progress");
      expect(verdict.ok, from).toBe(false);
      expect(verdict.ok === false && verdict.reason, from).toContain("already ended");
      expect(verdict.ok === false && verdict.reason, from).toContain("second call");
      expect(isTerminal(from), from).toBe(true);
    }
  });

  it("treats a repeated event as a duplicate rather than a transition", () => {
    /**
     * Providers repeat events. Recording the repeat as a transition makes one
     * hold look like two, and doubles this call in every number it appears in.
     */
    const verdict = canTransition("on_hold", "on_hold");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("duplicate");
  });

  it("lets a transferred call end in voicemail, because that is what happens", () => {
    // Transferring a customer into a colleague's voicemail is the commonest
    // way a genuinely answered call ends with the customer no better off.
    expect(canTransition("transferred", "voicemail").ok).toBe(true);
  });

  it("does not treat a transfer as the end of the call", () => {
    /**
     * Every provider reports a transfer as the end of the first leg. Treating
     * that as the end of the call counts a transfer dropped on the second leg
     * as handled.
     */
    expect(isTerminal("transferred")).toBe(false);
    expect(CALL_TRANSITIONS.transferred.length).toBeGreaterThan(0);
  });

  it("lets a caller give up while they are on hold", () => {
    // Hold abandonment is the most expensive thing a busy office does and the
    // one nobody measures, because the call was answered and therefore counted.
    expect(canTransition("on_hold", "abandoned").ok).toBe(true);
  });

  it("is honest that more than one ending looks like success", () => {
    /**
     * Collapsing these into "completed" is how a company with a 4% booking
     * rate reports a 90% handle rate and cannot work out why the two numbers
     * disagree.
     */
    expect(CALL_STATE.voicemail.ending).toBe("only_if_followed_up");
    expect(CALL_STATE.transferred.ending).toBe("only_if_followed_up");
    expect(CALL_STATE.completed.ending).toBe("reached_someone");
    expect(CALL_STATE.abandoned.ending).toBe("nobody_was_reached");
  });

  it("describes every state, because the screen has to name them", () => {
    for (const state of CALL_STATES) {
      expect(CALL_STATE[state].label.length, state).toBeGreaterThan(0);
      expect(CALL_STATE[state].meaning.length, state).toBeGreaterThan(20);
    }
  });

  it("gives a terminal state nowhere to go and a live one somewhere", () => {
    for (const state of CALL_STATES) {
      expect(CALL_TRANSITIONS[state].length === 0, state).toBe(CALL_STATE[state].terminal);
    }
  });

  it("walks a whole history and says where it breaks", () => {
    const good = checkSequence(["ringing", "answered", "in_progress", "on_hold", "in_progress", "completed"]);
    expect(good.ok).toBe(true);

    // The answer event was lost, and every duration derived from it is wrong.
    const bad = checkSequence(["ringing", "in_progress", "completed"]);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.at).toBe(1);
  });

  it("refuses a history that does not start with the phone ringing", () => {
    const verdict = checkSequence(["answered", "completed"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("lost");
  });

  it("refuses a call with no states at all", () => {
    expect(checkSequence([]).ok).toBe(false);
  });
});

/* ----------------------------------------------------------- the recording */

const policies = (...rows: JurisdictionPolicy[]): JurisdictionPolicy[] => rows;

const policy = (
  jurisdiction: string,
  rule: "one_party" | "all_party" | "unknown",
  announcementRequired = false,
): JurisdictionPolicy => ({
  jurisdiction, rule, announcementRequired,
  note: "Declared by the operator on their own advice.",
});

const party = (
  role: CallParty["role"],
  jurisdiction?: string,
  consented?: boolean,
): CallParty => ({
  role,
  ...(jurisdiction !== undefined ? { jurisdiction } : {}),
  ...(consented !== undefined ? { consented } : {}),
});

describe("whether this call may be recorded", () => {
  it("refuses when nobody recorded where the caller is", () => {
    /**
     * THE DEFAULT THAT MATTERS. A mobile number says where a phone was sold,
     * not where its owner is standing, so an unknown location is the ordinary
     * case rather than an edge one. Treating it as permissive costs a recording
     * that should never have existed on a call that is now evidence, and that
     * is not a recoverable mistake.
     */
    const verdict = mayRecord({
      parties: [party("agent", "HOME", true), party("caller")],
      policies: policies(policy("HOME", "one_party")),
      announcementPlayed: true,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("consent_missing");
    expect(verdict.governing).toBe("unknown");
    // And says what would fix it, naming the party.
    expect(verdict.ok === false && verdict.message).toContain("caller");
  });

  it("treats an unknown place as all party even when everywhere else on the call is lenient", () => {
    // "The places we happen to have policies for are all lenient" is not
    // evidence about the place we have no policy for.
    const resolution = governingPolicy(
      [party("agent", "HOME"), party("caller", "SOMEWHERE_ELSE")],
      new Map([["HOME", policy("HOME", "one_party")]]),
    );
    expect(resolution.governing).toBe("unknown");
    expect(resolution.partiesRequired).toBe("all");
    expect(resolution.announcementRequired).toBe(true);
    expect(resolution.unrecognised).toEqual(["SOMEWHERE_ELSE"]);
  });

  it("requires an announcement whenever the jurisdiction is unknown, even if nobody declared one", () => {
    // Nothing in the configuration asked for an announcement. The unknown did.
    const verdict = mayRecord({
      parties: [party("agent", "HOME", true), party("caller", undefined, true)],
      policies: policies(policy("HOME", "one_party", false)),
      announcementPlayed: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("announcement_not_played");
    expect(verdict.announcementRequired).toBe(true);
  });

  it("records under a one party policy once one person has agreed", () => {
    const verdict = mayRecord({
      parties: [party("agent", "HOME", true), party("caller", "HOME")],
      policies: policies(policy("HOME", "one_party")),
      announcementPlayed: false,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.governing).toBe("one_party");
  });

  it("refuses under an all party policy while anybody has not agreed, and names them", () => {
    const verdict = mayRecord({
      parties: [party("agent", "STRICT", true), party("caller", "STRICT")],
      policies: policies(policy("STRICT", "all_party")),
      announcementPlayed: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("consent_missing");
    expect(verdict.ok === false && verdict.message).toContain("caller");
  });

  it("takes the strictest rule on a call that spans two places", () => {
    // A call is one conversation and it has to satisfy everybody in it.
    const verdict = mayRecord({
      parties: [party("agent", "LENIENT", true), party("caller", "STRICT")],
      policies: policies(policy("LENIENT", "one_party"), policy("STRICT", "all_party")),
      announcementPlayed: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.governing).toBe("all_party");
  });

  it("makes the announcement a precondition rather than a formality", () => {
    /**
     * Asked before the first byte, not after. On a real call the announcement
     * is how consent is obtained, so it is checked before the count of who has
     * agreed.
     */
    const everybody = [party("agent", "STRICT", true), party("caller", "STRICT", true)];
    const notPlayed = mayRecord({
      parties: everybody,
      policies: policies(policy("STRICT", "all_party", true)),
      announcementPlayed: false,
    });
    expect(notPlayed.ok).toBe(false);
    expect(notPlayed.ok === false && notPlayed.reason).toBe("announcement_not_played");

    const played = mayRecord({
      parties: everybody,
      policies: policies(policy("STRICT", "all_party", true)),
      announcementPlayed: true,
    });
    expect(played.ok).toBe(true);
  });

  it("stops outright when somebody says no, however lenient the rule is", () => {
    /**
     * Playing the announcement again at a person who declined is not a remedy.
     * It is the same call being recorded over their objection.
     */
    const verdict = mayRecord({
      parties: [party("agent", "LENIENT", true), party("caller", "LENIENT", false)],
      policies: policies(policy("LENIENT", "one_party")),
      announcementPlayed: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("party_declined");
    expect(verdict.ok === false && verdict.message).toContain("Do not record");
  });

  it("knows the difference between saying no and saying nothing", () => {
    // Silence is not agreement, and it is not a refusal either: one ends the
    // question and the other is a thing the agent can still do something about.
    const silent = mayRecord({
      parties: [party("agent", "STRICT", true), party("caller", "STRICT")],
      policies: policies(policy("STRICT", "all_party")),
      announcementPlayed: true,
    });
    expect(silent.ok === false && silent.reason).toBe("consent_missing");
  });

  it("allows recording in an unknown place when everybody actually agreed", () => {
    // The safe default is all party, and all party is satisfiable. Refusing
    // here would be a product that can never record a call from a mobile.
    const verdict = mayRecord({
      parties: [party("agent", "HOME", true), party("caller", undefined, true)],
      policies: policies(policy("HOME", "one_party")),
      announcementPlayed: true,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.governing).toBe("unknown");
    expect(verdict.ok && verdict.why).toContain("all party");
  });

  it("refuses to record at all when the policy file cannot be trusted", () => {
    // A broken configuration must not be the thing that enables recording.
    const verdict = mayRecord({
      parties: [party("agent", "HOME", true)],
      policies: policies(policy("HOME", "one_party"), policy("HOME", "all_party")),
      announcementPlayed: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("policy_rejected");
    expect(verdict.ok === false && verdict.message).toContain("HOME");
  });

  it("will not read a rule it does not recognise as permission", () => {
    /**
     * Rules are data off somebody else's disk. A value outside the catalogue
     * would otherwise fall through every comparison and behave like the most
     * permissive setting there is.
     */
    const broken = { jurisdiction: "HOME", rule: "single_party", announcementRequired: false, note: "typo" };
    const catalogue = checkRecordingPolicies([broken as unknown as JurisdictionPolicy]);
    expect(catalogue.ok).toBe(false);
    expect(catalogue.ok === false && catalogue.reason).toContain("single_party");

    const verdict = mayRecord({
      parties: [party("agent", "HOME", true), party("caller", "HOME", true)],
      policies: [broken as unknown as JurisdictionPolicy],
      announcementPlayed: true,
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses a policy with no note, because the settings screen shows the note", () => {
    const verdict = checkRecordingPolicies([
      { jurisdiction: "HOME", rule: "one_party", announcementRequired: false, note: "  " },
    ]);
    expect(verdict.ok).toBe(false);
  });

  it("refuses a call with nobody on it", () => {
    // What a provider webhook looks like when the leg has already collapsed.
    // Defaulting an empty list to one party consent would make the emptiest
    // possible input the most permissive one.
    const verdict = mayRecord({ parties: [], policies: policies(policy("HOME", "one_party")), announcementPlayed: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("no_parties");
  });

  it("never matches a jurisdiction loosely", () => {
    // A prefix match here silently applies one place's rule to another place.
    const verdict = mayRecord({
      parties: [party("agent", "HOME", true), party("caller", "HOME-NORTH", true)],
      policies: policies(policy("HOME", "one_party")),
      announcementPlayed: true,
    });
    expect(verdict.governing).toBe("unknown");
  });

  it("states the consequence of every rule it can apply", () => {
    // The operator is accepting the consequence. It has to be written down
    // where they can read it before they turn recording on.
    for (const rule of CONSENT_RULES) {
      expect(CONSENT_RULE[rule].label.length, rule).toBeGreaterThan(0);
      expect(CONSENT_RULE[rule].consequence.length, rule).toBeGreaterThan(40);
    }
    // And the undeclared case is the strict one, which is the whole default.
    expect(CONSENT_RULE.unknown.partiesRequired).toBe("all");
  });
});

/* --------------------------------------------------------- the opening hours */

const NO_HOURS: Record<Weekday, readonly OpenWindow[]> = {
  sunday: [], monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [],
};

const weekdaysOnly = (open: number, close: number): Record<Weekday, readonly OpenWindow[]> => ({
  ...NO_HOURS,
  monday: [{ openMinute: open, closeMinute: close }],
  tuesday: [{ openMinute: open, closeMinute: close }],
  wednesday: [{ openMinute: open, closeMinute: close }],
  thursday: [{ openMinute: open, closeMinute: close }],
  friday: [{ openMinute: open, closeMinute: close }],
});

const AUSTIN: BusinessHours = {
  timeZone: "America/Chicago",
  weekly: weekdaysOnly(8 * 60, 17 * 60),
  holidays: [
    { date: "2026-12-25", label: "Christmas Day" },
    { date: "2026-12-24", label: "Christmas Eve", windows: [{ openMinute: 8 * 60, closeMinute: 12 * 60 }] },
  ],
};

describe("whether the company is open", () => {
  it("answers in the company's zone rather than the server's", () => {
    /**
     * The server runs in UTC in production and in whatever a contributor has
     * locally, and neither of those is where the phones are. 2026-06-16T02:00Z
     * is a Tuesday in London and nine at night on Monday in Austin.
     */
    const verdict = hoursAt(AUSTIN, new Date("2026-06-16T02:00:00Z"));
    expect(verdict.localDate).toBe("2026-06-15");
    expect(verdict.weekday).toBe("monday");
    expect(verdict.open).toBe(false);
  });

  it("is open in the middle of a working day and shut in the evening", () => {
    expect(hoursAt(AUSTIN, new Date("2026-06-16T15:00:00Z")).open).toBe(true);
    expect(hoursAt(AUSTIN, new Date("2026-06-17T02:00:00Z")).open).toBe(false);
  });

  it("is shut at the closing minute, not a minute after", () => {
    // Closing at 17:00 means a call at exactly 17:00 is after hours, and the
    // alternative is arguing about one minute forever.
    const at1659 = hoursAt(AUSTIN, new Date("2026-06-16T21:59:00Z"));
    const at1700 = hoursAt(AUSTIN, new Date("2026-06-16T22:00:00Z"));
    expect(at1659.localMinutes).toBe(16 * 60 + 59);
    expect(at1659.open).toBe(true);
    expect(at1700.localMinutes).toBe(17 * 60);
    expect(at1700.open).toBe(false);
  });

  it("gets the same instant right on both sides of a daylight saving change", () => {
    /**
     * THE CASE A STORED OFFSET GETS WRONG, and it is wrong for five months
     * before anybody notices. Daylight saving starts on 8 March 2026 in
     * Chicago. 13:30Z is half past seven in the morning there before the
     * change, so the phones are still on the night rota, and half past eight
     * after it, so the office is open. Same instant, same schedule, opposite
     * answers, and a system that added a fixed six hours answers the phone an
     * hour early for a season.
     */
    const before = hoursAt(AUSTIN, new Date("2026-03-06T13:30:00Z"));
    expect(before.localMinutes).toBe(7 * 60 + 30);
    expect(before.open).toBe(false);

    const after = hoursAt(AUSTIN, new Date("2026-03-09T13:30:00Z"));
    expect(after.localMinutes).toBe(8 * 60 + 30);
    expect(after.open).toBe(true);
  });

  it("gets the same instant right when the clocks go back too", () => {
    // The other direction, on the hour that happens twice: 2026-11-01.
    // 13:30Z is half past eight before the change and half past seven after.
    expect(hoursAt(AUSTIN, new Date("2026-10-30T13:30:00Z")).localMinutes).toBe(8 * 60 + 30);
    expect(hoursAt(AUSTIN, new Date("2026-11-02T13:30:00Z")).localMinutes).toBe(7 * 60 + 30);
  });

  it("keeps the office shut on a holiday that falls on a working day", () => {
    const verdict = hoursAt(AUSTIN, new Date("2026-12-25T16:00:00Z"));
    expect(verdict.state).toBe("holiday");
    expect(verdict.open).toBe(false);
    expect(verdict.why).toContain("Christmas Day");
  });

  it("lets a holiday keep its own half day", () => {
    // A holiday list that could only say "shut" makes the office turn the
    // whole feature off for the day.
    expect(hoursAt(AUSTIN, new Date("2026-12-24T16:00:00Z")).open).toBe(true);
    expect(hoursAt(AUSTIN, new Date("2026-12-24T19:00:00Z")).open).toBe(false);
    // And it is still a holiday, whichever side of noon the call lands on.
    expect(hoursAt(AUSTIN, new Date("2026-12-24T16:00:00Z")).holiday?.label).toBe("Christmas Eve");
  });

  it("lets the owner force a Sunday open during an ice storm", () => {
    const override = {
      mode: "force_open" as const,
      label: "Freeze event, all hands",
      from: new Date("2026-01-11T06:00:00Z"),
      until: new Date("2026-01-13T06:00:00Z"),
    };
    const verdict = hoursAt(AUSTIN, new Date("2026-01-12T05:00:00Z"), override);
    expect(verdict.state).toBe("override_open");
    expect(verdict.open).toBe(true);
    expect(verdict.why).toContain("Freeze event");
  });

  it("lets the owner force a working day closed", () => {
    // The funeral, or the whole crew at a training day. An override that could
    // only force open leaves this to somebody editing the weekly hours and
    // forgetting to put them back.
    const verdict = hoursAt(AUSTIN, new Date("2026-06-16T15:00:00Z"), {
      mode: "force_closed", label: "Team at supplier training",
      from: new Date("2026-06-16T12:00:00Z"), until: new Date("2026-06-16T23:00:00Z"),
    });
    expect(verdict.open).toBe(false);
    expect(verdict.state).toBe("override_closed");
  });

  it("stops applying an override the moment it expires", () => {
    // Half open, like every other interval in this codebase.
    const override = {
      mode: "force_open" as const, label: "Freeze event",
      from: new Date("2026-01-11T06:00:00Z"), until: new Date("2026-01-12T06:00:00Z"),
    };
    expect(hoursAt(AUSTIN, new Date("2026-01-12T06:00:00Z"), override).state).toBe("closed");
  });

  it("handles an after hours line that wraps past midnight", () => {
    const emergency: BusinessHours = {
      timeZone: "America/Chicago",
      weekly: { ...NO_HOURS, sunday: [{ openMinute: 17 * 60, closeMinute: 8 * 60 }] },
      holidays: [],
    };
    // 23:00 on a Sunday in Austin is 05:00Z on the Monday.
    expect(hoursAt(emergency, new Date("2026-01-12T05:00:00Z")).open).toBe(true);
    expect(withinWindow(23 * 60, { openMinute: 17 * 60, closeMinute: 8 * 60 })).toBe(true);
    expect(withinWindow(2 * 60, { openMinute: 17 * 60, closeMinute: 8 * 60 })).toBe(true);
    expect(withinWindow(12 * 60, { openMinute: 17 * 60, closeMinute: 8 * 60 })).toBe(false);
  });

  it("explains itself in a sentence somebody can read on the call screen", () => {
    const verdict = hoursAt(AUSTIN, new Date("2026-06-16T15:00:00Z"));
    expect(verdict.why).toContain("America/Chicago");
    expect(verdict.why).toContain("tuesday");
    expect(verdict.why).toContain("08:00 to 17:00");
  });

  it("knows what day a date is", () => {
    expect(weekdayOf("2026-06-16")).toBe("tuesday");
    expect(WEEKDAYS).toHaveLength(7);
  });
});

describe("whether a schedule can be used at all", () => {
  it("accepts a real one", () => {
    expect(checkBusinessHours(AUSTIN).ok).toBe(true);
  });

  it("refuses a time zone that does not exist", () => {
    // A typo throws from inside Intl on the first call of the day rather than
    // when somebody saved it.
    const verdict = checkBusinessHours({ ...AUSTIN, timeZone: "America/Austin" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("IANA");
  });

  it("refuses a window that opens and closes at the same minute", () => {
    /**
     * Either nothing or the whole day, and nobody can tell which. One sends
     * every call to voicemail and the other rings the office at three in the
     * morning, and they look identical on the settings screen.
     */
    const verdict = checkBusinessHours({
      ...AUSTIN,
      weekly: { ...NO_HOURS, monday: [{ openMinute: 9 * 60, closeMinute: 9 * 60 }] },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("09:00");
  });

  it("refuses a time of day that is not one", () => {
    const verdict = checkBusinessHours({
      ...AUSTIN,
      weekly: { ...NO_HOURS, monday: [{ openMinute: 8 * 60, closeMinute: 1500 }] },
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses the same holiday listed twice", () => {
    // With both there, the hours kept that day depend on which row was read
    // first.
    const verdict = checkBusinessHours({
      ...AUSTIN,
      holidays: [{ date: "2026-12-25", label: "Christmas" }, { date: "2026-12-25", label: "Christmas Day" }],
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses a holiday that is not a date", () => {
    const verdict = checkBusinessHours({ ...AUSTIN, holidays: [{ date: "25 December", label: "Christmas" }] });
    expect(verdict.ok).toBe(false);
  });
});

/* -------------------------------------------------------------- the routing */

const MAIN = "+15125550100";
const YARD_SIGN = "+15125550199";

const table: RoutingTable = {
  rules: [
    {
      id: "emergency",
      label: "After hours emergency",
      all: [{ kind: "after_hours" }, { kind: "emergency_selected", is: true }],
      to: { kind: "on_call_rota", id: "hvac" },
    },
    {
      id: "after-hours",
      label: "After hours, everything else",
      all: [{ kind: "after_hours" }],
      to: { kind: "voicemail", box: "main" },
    },
    {
      id: "yard-sign",
      label: "Yard sign number",
      all: [{ kind: "dialled_number", oneOf: [YARD_SIGN] }],
      to: { kind: "ring_group", id: "new-business" },
    },
    {
      id: "existing-work",
      label: "Customer with work open",
      all: [{ kind: "known_customer", is: true }, { kind: "has_open_job", is: true }],
      to: { kind: "queue", id: "service" },
    },
  ],
  fallback: { kind: "ivr", menu: "main" },
};

const facts = (over: Partial<CallFacts> = {}): CallFacts => ({
  dialledNumber: MAIN,
  knownCustomer: false,
  hasOpenJob: false,
  emergencySelected: false,
  hours: hoursAt(AUSTIN, new Date("2026-06-16T15:00:00Z")),
  ...over,
});

const sundayNight = () => hoursAt(AUSTIN, new Date("2026-01-12T05:00:00Z"));

describe("where the call goes", () => {
  it("sends a no heat call at eleven on a Sunday to the person on the rota", () => {
    // The whole point of the module. A call at eleven at night on a Sunday for
    // a no heat job is not the same as one about an invoice.
    const result = route(table, facts({ hours: sundayNight(), emergencySelected: true }));
    expect(result.destination).toEqual({ kind: "on_call_rota", id: "hvac" });
    expect(result.matchedRuleId).toBe("emergency");
  });

  it("sends the same caller at the same hour about an invoice to voicemail", () => {
    const result = route(table, facts({ hours: sundayNight(), emergencySelected: false }));
    expect(result.destination).toEqual({ kind: "voicemail", box: "main" });
    expect(result.matchedRuleId).toBe("after-hours");
  });

  it("takes the first rule that matches, in the order they are written", () => {
    // Not priority numbers: two rules at priority ten sort by whatever the
    // sort happened to do, and the answer becomes a property of the runtime.
    const result = route(table, facts({
      hours: sundayNight(), emergencySelected: true, knownCustomer: true, hasOpenJob: true,
    }));
    expect(result.matchedRuleId).toBe("emergency");
  });

  it("routes by the number that was dialled", () => {
    const result = route(table, facts({ dialledNumber: YARD_SIGN }));
    expect(result.destination).toEqual({ kind: "ring_group", id: "new-business" });
  });

  it("falls back when nothing matches, rather than leaving a ringing phone with nowhere to go", () => {
    /**
     * THE REFUSAL THAT IS NOT ALLOWED TO EXIST. Dead air is worse than
     * voicemail: voicemail leaves a message and a record, and dead air leaves a
     * customer who believes the number is disconnected.
     */
    const result = route(table, facts({ knownCustomer: true, hasOpenJob: false }));
    expect(result.destination).toEqual({ kind: "ivr", menu: "main" });
    expect(result.matchedRuleId).toBeNull();
    expect(result.why).toContain("fallback");
  });

  it("still routes when there are no rules at all", () => {
    // A rule set somebody emptied on a Friday afternoon.
    const result = route({ rules: [], fallback: { kind: "voicemail", box: "main" } }, facts());
    expect(result.destination).toEqual({ kind: "voicemail", box: "main" });
    expect(result.why).toContain("no routing rules");
  });

  it("answers why that customer got voicemail at two in the afternoon", () => {
    /**
     * The question this feature is opened to answer, and the answer is nearly
     * always a rule three rows above the one everybody is looking at. Here it
     * is an override that closed the office, so the after hours rule fired
     * during business hours.
     */
    const shut = hoursAt(AUSTIN, new Date("2026-06-16T19:00:00Z"), {
      mode: "force_closed", label: "Team at supplier training",
      from: new Date("2026-06-16T12:00:00Z"), until: new Date("2026-06-16T23:00:00Z"),
    });
    const result = route(table, facts({ hours: shut, knownCustomer: true, hasOpenJob: true }));

    expect(result.destination).toEqual({ kind: "voicemail", box: "main" });
    expect(result.why).toContain("After hours, everything else");
    expect(result.why).toContain("outside business hours");
    // And the rule everybody expected to fire is in the trace, never reached.
    expect(result.trace.map((step) => step.ruleId)).toEqual(["emergency", "after-hours"]);
    expect(result.trace.some((step) => step.ruleId === "existing-work")).toBe(false);
  });

  it("shows every rule it considered and what failed on each", () => {
    const result = route(table, facts({ knownCustomer: true }));
    expect(result.trace).toHaveLength(4);
    expect(result.trace[0]).toEqual({
      ruleId: "emergency", label: "After hours emergency", matched: false,
      failedOn: "it is outside business hours",
    });
    expect(result.trace[3]?.failedOn).toBe("the caller has a job open");
  });

  it("treats a holiday the owner forced open as still a holiday for routing", () => {
    /**
     * The day the company opens for emergencies on Christmas is exactly the
     * day the holiday rule has to fire. Reading it off the state rather than
     * off the holiday itself loses that.
     */
    const christmas = hoursAt(AUSTIN, new Date("2026-12-25T16:00:00Z"), {
      mode: "force_open", label: "Emergency cover", from: new Date("2026-12-25T14:00:00Z"), until: new Date("2026-12-25T22:00:00Z"),
    });
    expect(christmas.open).toBe(true);
    const holidayTable: RoutingTable = {
      rules: [{ id: "xmas", label: "Holiday cover", all: [{ kind: "on_holiday" }], to: { kind: "on_call_rota", id: "holiday" } }],
      fallback: { kind: "voicemail", box: "main" },
    };
    expect(route(holidayTable, facts({ hours: christmas })).matchedRuleId).toBe("xmas");
  });

  it("does not match a condition it has never heard of, and keeps routing", () => {
    /**
     * Rules come off disk on somebody else's server, written by a version of
     * this product that may be newer than the one running. An unknown test
     * that counted as satisfied would route calls using a rule the running
     * system cannot read.
     */
    const future = { kind: "caller_sentiment_is_angry", threshold: 0.8 } as unknown as RoutingCondition;
    const result = route({
      rules: [{ id: "future", label: "From a newer release", all: [future], to: { kind: "queue", id: "retention" } }],
      fallback: { kind: "voicemail", box: "main" },
    }, facts());

    expect(result.matchedRuleId).toBeNull();
    expect(result.trace[0]?.failedOn).toContain("unrecognised");
  });

  it("routes by a stretch of the company's own clock", () => {
    const lunch: RoutingTable = {
      rules: [{
        id: "lunch", label: "Lunch cover",
        all: [{ kind: "time_window", window: { openMinute: 12 * 60, closeMinute: 13 * 60 } }],
        to: { kind: "forward", e164: "+15125550147" },
      }],
      fallback: { kind: "ring_group", id: "office" },
    };
    // 17:30Z is half twelve in Austin in June.
    expect(route(lunch, facts({ hours: hoursAt(AUSTIN, new Date("2026-06-16T17:30:00Z")) })).matchedRuleId).toBe("lunch");
    expect(route(lunch, facts()).matchedRuleId).toBeNull();
  });
});

describe("whether a routing table can be saved", () => {
  it("accepts a real one", () => {
    const verdict = checkRoutingTable(table);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.unreachable).toEqual([]);
  });

  it("refuses a forward to a number nobody can dial", () => {
    /**
     * The check that earns its place. A typo in a forwarding number does not
     * fail loudly: the carrier returns a generic failure on each call, the
     * office sees nothing, and every overflow call for a week goes nowhere.
     */
    const verdict = checkRoutingTable({
      rules: [{ id: "a", label: "Overflow", all: [], to: { kind: "forward", e164: "512 555 0147" } }],
      fallback: { kind: "voicemail", box: "main" },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("+15125550147");
  });

  it("checks the fallback as carefully as the rules", () => {
    // It is the destination that runs when everything else has failed to
    // match, so it is the last one that can afford a typo.
    const verdict = checkRoutingTable({ rules: [], fallback: { kind: "forward", e164: "5550147" } });
    expect(verdict.ok).toBe(false);
  });

  it("refuses two rules with the same id", () => {
    const verdict = checkRoutingTable({
      rules: [
        { id: "a", label: "One", all: [{ kind: "after_hours" }], to: { kind: "voicemail", box: "main" } },
        { id: "a", label: "Two", all: [{ kind: "on_holiday" }], to: { kind: "voicemail", box: "main" } },
      ],
      fallback: { kind: "voicemail", box: "main" },
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses a rule that tests something this build cannot check", () => {
    const verdict = checkRoutingTable({
      rules: [{
        id: "a", label: "From a newer release",
        all: [{ kind: "caller_sentiment_is_angry" } as unknown as RoutingCondition],
        to: { kind: "queue", id: "retention" },
      }],
      fallback: { kind: "voicemail", box: "main" },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(CONDITION_KINDS[0]);
  });

  it("refuses a rule that matches on the number dialled and lists no numbers", () => {
    const verdict = checkRoutingTable({
      rules: [{ id: "a", label: "Nothing", all: [{ kind: "dialled_number", oneOf: [] }], to: { kind: "queue", id: "q" } }],
      fallback: { kind: "voicemail", box: "main" },
    });
    expect(verdict.ok).toBe(false);
  });

  it("reports the rules that can never run, without refusing the catch all itself", () => {
    // An unconditional last rule is a legitimate way to write a catch all.
    // Only the ones below it are the mistake.
    const verdict = checkRoutingTable({
      rules: [
        { id: "catch-all", label: "Everything", all: [], to: { kind: "ring_group", id: "office" } },
        { id: "never", label: "Emergency", all: [{ kind: "emergency_selected", is: true }], to: { kind: "on_call_rota", id: "hvac" } },
      ],
      fallback: { kind: "voicemail", box: "main" },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.unreachable).toEqual(["never"]);
  });

  it("refuses a rule with no label, because the label is the explanation", () => {
    const verdict = checkRoutingTable({
      rules: [{ id: "a", label: "  ", all: [{ kind: "after_hours" }], to: { kind: "voicemail", box: "main" } }],
      fallback: { kind: "voicemail", box: "main" },
    });
    expect(verdict.ok).toBe(false);
  });
});

/* ---------------------------------------------------- what the call amounted to */

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  direction: "inbound",
  state: "completed",
  ringSeconds: 8,
  talkSeconds: 240,
  endedBy: "caller",
  voicemailLeft: false,
  markedWrongNumber: false,
  ...over,
});

describe("what the call actually was", () => {
  it("does not count a two second answered call as an answered call", () => {
    /**
     * The call every phone system on the market counts as handled. A report
     * that counts it as one is a report that says the team is doing fine while
     * the phone is being hung up on.
     */
    const verdict = classify(call({ talkSeconds: 2 }));
    expect(verdict.outcome).toBe("too_short_to_count");
    expect(verdict.reachedAPerson).toBe(false);
    expect(verdict.countsAsMissed).toBe(true);
  });

  it("uses the configured floor rather than a number baked into this file", () => {
    // Confirming an arrival window takes eight seconds, and diagnosing a boiler
    // does not. A company that reads the floor as a discipline number will
    // punish the fastest person in the office.
    expect(classify(call({ talkSeconds: 8 })).outcome).toBe("too_short_to_count");
    expect(classify(call({ talkSeconds: 8 }), { ...DEFAULT_OUTCOME_THRESHOLDS, minimumTalkSeconds: 5 }).outcome)
      .toBe("reached_no_booking");
  });

  it("counts a call that produced work", () => {
    const verdict = classify(call({ bookedJobId: "job_1" }));
    expect(verdict.outcome).toBe("booked");
    expect(verdict.countsAsMissed).toBe(false);
  });

  it("does not let a booking rescue a two second call", () => {
    // The booking was made twenty minutes later from a callback and attributed
    // to whichever call was open on the screen.
    expect(classify(call({ talkSeconds: 1, bookedJobId: "job_1" })).outcome).toBe("too_short_to_count");
  });

  it("separates the caller giving up from the system giving up", () => {
    /**
     * Both count as missed in the headline number, and only one of them is a
     * staffing problem you can solve by answering faster.
     */
    expect(classify(call({ state: "abandoned", talkSeconds: 0, ringSeconds: 22, endedBy: "caller" })).outcome)
      .toBe("abandoned_before_answer");
    expect(classify(call({ state: "abandoned", talkSeconds: 0, ringSeconds: 30, endedBy: "us" })).outcome)
      .toBe("missed");
  });

  it("does not count an instant hangup against the office", () => {
    // Somebody dialled and immediately thought better of it. Counting it
    // produces a missed call number they learn to ignore, which is worse than
    // not having one.
    const verdict = classify(call({ state: "abandoned", talkSeconds: 0, ringSeconds: 1, endedBy: "caller" }));
    expect(verdict.outcome).toBe("abandoned_before_answer");
    expect(verdict.countsAsMissed).toBe(false);
  });

  it("finds the calls that were answered and then given up on anyway", () => {
    /**
     * The most expensive number nobody has. These were answered, so every
     * handle rate counts them as wins, and the customer hung up unserved.
     */
    const verdict = classify(call({ state: "abandoned", talkSeconds: 45, ringSeconds: 4, endedBy: "caller" }));
    expect(verdict.outcome).toBe("abandoned_on_hold");
    expect(verdict.reachedAPerson).toBe(true);
    expect(verdict.countsAsMissed).toBe(true);
  });

  it("treats voicemail with a message as work waiting, not a call handled", () => {
    const verdict = classify(call({ state: "voicemail", talkSeconds: 0, voicemailLeft: true }));
    expect(verdict.outcome).toBe("voicemail_left");
    expect(verdict.countsAsMissed).toBe(true);
    expect(verdict.reachedAPerson).toBe(false);
  });

  it("separates a message left from a caller who would not talk to a machine", () => {
    expect(classify(call({ state: "voicemail", talkSeconds: 0, voicemailLeft: false })).outcome)
      .toBe("voicemail_no_message");
  });

  it("lets a human judgement beat anything derived from the duration", () => {
    // They were there.
    const verdict = classify(call({ talkSeconds: 300, markedWrongNumber: true }));
    expect(verdict.outcome).toBe("wrong_number");
    expect(verdict.countsAsMissed).toBe(false);
  });

  it("does not put a carrier failure in the missed call number", () => {
    // It sends an owner to talk to the office about something the office
    // cannot fix.
    const verdict = classify(call({ state: "failed", talkSeconds: 0 }));
    expect(verdict.outcome).toBe("failed");
    expect(verdict.countsAsMissed).toBe(false);
    expect(verdict.caution).toContain("forwarding number");
  });

  it("flags a call that never reached an ending instead of guessing at it", () => {
    // The ending event never arrived. An unfinished call sitting in the
    // completed pile is a call nobody goes back to.
    const verdict = classify(call({ state: "on_hold" }));
    expect(verdict.outcome).toBe("missed");
    expect(verdict.caution).toContain("never arrived");
  });

  it("warns that these labels are written for inbound calls", () => {
    const verdict = classify(call({ direction: "outbound" }));
    expect(verdict.caution).toContain("outbound");
  });

  it("says what every outcome is used for and where it is likely to be wrong", () => {
    /**
     * Not modesty. These numbers end up in a conversation about whether
     * somebody is answering the phone properly, and a label whose failure
     * modes are written down is one that conversation can survive.
     */
    for (const outcome of CALL_OUTCOMES) {
      expect(CALL_OUTCOME[outcome].label.length, outcome).toBeGreaterThan(0);
      expect(CALL_OUTCOME[outcome].usedFor.length, outcome).toBeGreaterThan(30);
      expect(CALL_OUTCOME[outcome].likelyWrongWhen.length, outcome).toBeGreaterThan(30);
    }
  });

  it("explains itself on every call it classifies", () => {
    // The why is what a person reads when they disagree with the label.
    for (const state of CALL_STATES) {
      const verdict = classify(call({ state, talkSeconds: state === "completed" ? 60 : 0 }));
      expect(verdict.why.length, state).toBeGreaterThan(20);
      expect(CALL_OUTCOMES, state).toContain(verdict.outcome);
    }
  });
});
