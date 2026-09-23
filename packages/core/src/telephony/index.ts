import { dateIn, minutesInDay } from "../time/index.js";

/**
 * THE PHONE, WHICH IS STILL HOW WORK ARRIVES
 *
 * Every other module in this package deals with work that already exists. This
 * one deals with the moment before it exists, when somebody with a cold house
 * dials a number and finds out whether this company is a company that answers.
 * A missed call is not a missed message. It is the customer calling the next
 * name on the list, and the job going to them instead, and nobody at this end
 * ever knowing it happened. That asymmetry is the whole reason this file is
 * careful: a text that fails leaves a row saying it failed, and a call that was
 * never answered leaves nothing at all unless something like this writes it down.
 *
 * FOUR DECISIONS LIVE HERE, and they are the four that get argued about after
 * the fact:
 *
 *   WHAT STATE THE CALL IS IN, and whether the thing the telephony provider
 *   just told us could possibly have happened. Providers send events out of
 *   order and send events twice, and a state machine that accepts anything
 *   ends up with calls that were answered after they completed.
 *
 *   WHETHER WE MAY RECORD IT. The most important thing in this file, and the
 *   only one where getting it wrong is not a business problem but a legal one.
 *
 *   WHERE THE CALL GOES, and WHY it went there. The second half of that is not
 *   decoration. "Why did that customer get voicemail at two in the afternoon"
 *   is the question this feature is opened to answer, and a router that cannot
 *   answer it sends somebody to read the rules and guess.
 *
 *   WHAT THE CALL AMOUNTED TO. A two second answered call is not an answered
 *   call in any sense an owner cares about, and a report that counts it as one
 *   is a report that says the team is doing fine while the phone is being hung
 *   up on.
 *
 * Everything is pure. No provider, no database, and no clock: the current
 * instant arrives as a parameter, because a routing decision that depends on
 * the process's own idea of the time cannot be tested at eleven at night on a
 * Sunday, which is exactly when it matters.
 *
 * This file is the phone call half of the communications module. It does not
 * repeat the consent model in ../comms/index.js, which answers a different
 * question: whether we may send an outbound message to somebody. That question
 * is about marketing permission, and this one is about wiretapping law. They
 * look alike and they are not the same, so they are kept apart on purpose.
 */

/* -------------------------------------------------------------- the states */

/**
 * Every state a call passes through, in the order a person would list them.
 *
 * Declared as data rather than inferred from the transition table, because the
 * screen has to name them and a report has to group by them, and a state that
 * exists only as a key in a table is a state nobody can label.
 */
export const CALL_STATES = [
  "ringing",
  "answered",
  "in_progress",
  "on_hold",
  "transferred",
  "completed",
  "abandoned",
  "voicemail",
  "failed",
] as const;

export type CallState = (typeof CALL_STATES)[number];

/**
 * Whether an ending was a good ending.
 *
 * Three values rather than two, and the middle one is the point. A call that
 * ends in voicemail looks like a success in every count of "calls handled" and
 * is only actually a success if somebody rings back. The same is true of a
 * transfer: the first leg is over and whether the customer was helped depends
 * entirely on a second leg this record knows nothing about. Collapsing those
 * into "completed" is how a company with a 4% booking rate reports a 90%
 * handle rate and cannot work out why the two numbers disagree.
 */
export type EndingQuality = "reached_someone" | "only_if_followed_up" | "nobody_was_reached";

export interface CallStateProfile {
  label: string;
  /** One sentence a dispatcher would recognise on a call detail screen. */
  meaning: string;
  /** Whether the call is over. A terminal state has no legal transitions out. */
  terminal: boolean;
  /**
   * What this ending is worth, for terminal states. Non terminal states carry
   * the value they would have if the call stopped here, which is the honest
   * answer for a call the provider stopped telling us about.
   */
  ending: EndingQuality;
}

export const CALL_STATE: Record<CallState, CallStateProfile> = {
  ringing: {
    label: "Ringing",
    meaning: "The call has arrived and something is ringing. Nobody has picked up yet.",
    terminal: false,
    ending: "nobody_was_reached",
  },
  answered: {
    label: "Answered",
    meaning: "Somebody picked up. This says nothing about whether they said anything useful.",
    terminal: false,
    ending: "reached_someone",
  },
  in_progress: {
    label: "In progress",
    meaning: "A conversation is happening.",
    terminal: false,
    ending: "reached_someone",
  },
  on_hold: {
    label: "On hold",
    meaning: "Answered, then parked. The state callers give up in.",
    terminal: false,
    ending: "reached_someone",
  },
  transferred: {
    label: "Transferred",
    meaning: "Handed to somebody else. Not an ending: whether the customer was helped depends on the leg after this one.",
    terminal: false,
    ending: "only_if_followed_up",
  },
  completed: {
    label: "Completed",
    meaning: "The call ran its course and ended normally. Duration decides whether that means anything.",
    terminal: true,
    ending: "reached_someone",
  },
  abandoned: {
    label: "Abandoned",
    meaning: "It ended without the caller getting what they rang for. Usually they hung up first.",
    terminal: true,
    ending: "nobody_was_reached",
  },
  voicemail: {
    label: "Voicemail",
    meaning: "It went to a machine. A success only if somebody rings back, and that is not recorded here.",
    terminal: true,
    ending: "only_if_followed_up",
  },
  failed: {
    label: "Failed",
    meaning: "The network or the provider could not complete it. Nobody at either end chose this.",
    terminal: true,
    ending: "nobody_was_reached",
  },
};

/**
 * Which state may follow which.
 *
 * The entries worth defending:
 *
 *   RINGING GOES STRAIGHT TO VOICEMAIL. It never passes through answered,
 *   because a voicemail box is not a person picking up, and a machine that
 *   models it as an answer produces an answer rate of one hundred percent for
 *   a company nobody can get hold of.
 *
 *   ON HOLD MAY BE ABANDONED. Hold abandonment is the single most expensive
 *   thing a busy office does and the one nobody measures, because the call was
 *   answered and therefore counted. The transition is legal here and the
 *   outcome classifier separates it out further down, using the fact that
 *   somebody did speak first.
 *
 *   TRANSFERRED MAY GO TO VOICEMAIL. Transferring a customer into a colleague's
 *   voicemail is the commonest way a call that was genuinely answered ends with
 *   the customer no better off, and a table that forbade it would simply be
 *   wrong about what these systems do.
 *
 *   TRANSFERRED IS NOT TERMINAL. Every provider reports a transfer as the end
 *   of the first leg, and treating that as the end of the call is how a
 *   transferred call that was dropped on the second leg gets counted as handled.
 */
export const CALL_TRANSITIONS: Record<CallState, readonly CallState[]> = {
  ringing: ["answered", "voicemail", "abandoned", "failed"],
  answered: ["in_progress", "on_hold", "transferred", "completed", "failed"],
  in_progress: ["on_hold", "transferred", "completed", "abandoned", "failed"],
  on_hold: ["in_progress", "transferred", "completed", "abandoned", "failed"],
  transferred: ["in_progress", "on_hold", "voicemail", "completed", "abandoned", "failed"],
  completed: [],
  abandoned: [],
  voicemail: [],
  failed: [],
};

export type TransitionVerdict =
  | { ok: true; from: CallState; to: CallState }
  | { ok: false; from: CallState; to: CallState; reason: string; allowed: readonly CallState[] };

const list = (states: readonly CallState[]): string =>
  states.length === 0 ? "nothing" : states.map((s) => CALL_STATE[s].label.toLowerCase()).join(", ");

/**
 * Whether a call may move from one state to another.
 *
 * Refuses with a sentence naming both states and what could have followed
 * instead, because the reader of this message is usually somebody staring at a
 * provider webhook log trying to work out which of the two systems is wrong.
 * "Invalid transition" sends them to read this file. Naming the legal next
 * states does not.
 *
 * A state moving to itself is refused. Providers repeat events, and a repeat is
 * not a transition: the caller should treat it as the duplicate it is rather
 * than writing a second row that makes one hold look like two.
 */
export function canTransition(from: CallState, to: CallState): TransitionVerdict {
  const allowed = CALL_TRANSITIONS[from];

  if (from === to) {
    return {
      ok: false, from, to, allowed,
      reason: `The call is already ${CALL_STATE[from].label.toLowerCase()}. A repeated event is a duplicate, not a transition, and recording it twice doubles this call in every count it appears in.`,
    };
  }

  if (CALL_STATE[from].terminal) {
    return {
      ok: false, from, to, allowed,
      reason: `This call already ended as ${CALL_STATE[from].label.toLowerCase()}, so it cannot become ${CALL_STATE[to].label.toLowerCase()}. If the customer rang again, that is a second call.`,
    };
  }

  if (!allowed.includes(to)) {
    return {
      ok: false, from, to, allowed,
      reason: `A call cannot go from ${CALL_STATE[from].label.toLowerCase()} to ${CALL_STATE[to].label.toLowerCase()}. From here it can only become: ${list(allowed)}.`,
    };
  }

  return { ok: true, from, to };
}

export const isTerminal = (state: CallState): boolean => CALL_STATE[state].terminal;

/**
 * Whether a whole sequence of states could have happened in that order.
 *
 * Exists because the interesting bug is never one bad transition in isolation,
 * it is a call whose recorded history skips a step: ringing straight to
 * in progress, which means the answer event was lost and every duration derived
 * from it is wrong. Replaying the sequence is the cheapest way to find that.
 */
export function checkSequence(states: readonly CallState[]):
  | { ok: true }
  | { ok: false; at: number; reason: string } {
  if (states.length === 0) {
    return { ok: false, at: 0, reason: "A call with no states never happened. Something upstream dropped every event." };
  }
  const first = states[0]!;
  if (first !== "ringing") {
    return {
      ok: false, at: 0,
      reason: `Every call starts ringing, and this one starts ${CALL_STATE[first].label.toLowerCase()}. The earlier events were lost.`,
    };
  }
  for (let i = 1; i < states.length; i += 1) {
    const verdict = canTransition(states[i - 1]!, states[i]!);
    if (!verdict.ok) return { ok: false, at: i, reason: verdict.reason };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- recording */

/**
 * WHETHER WE MAY RECORD THIS CALL.
 *
 * The most important decision in this file, and the one place where a wrong
 * answer is not an operational problem. Call recording law is not uniform:
 * some places are satisfied by one participant knowing, and some require every
 * participant to agree, and the rules turn on where each PERSON is rather than
 * on where the company is. A contractor whose office is in one state and whose
 * customers ring from three others is in several regimes at once on a single
 * call.
 *
 * THIS FILE CONTAINS NO CLAIM ABOUT ANY PARTICULAR PLACE, AND NONE OF IT IS
 * LEGAL ADVICE. There is no table of states in here, deliberately. Shipping a
 * list of which jurisdictions are one party and which are all party would be
 * shipping a legal opinion that goes stale without anybody noticing, into a
 * product that is self hosted and can therefore never be corrected in the
 * field. What is modelled is the MECHANISM. The operator declares a policy per
 * jurisdiction, in configuration, having taken their own advice, and this file
 * applies what they declared.
 *
 * THE DEFAULT WHEN WE DO NOT KNOW IS THE SAFE ONE. An unrecognised jurisdiction,
 * or a party whose location was never captured, is treated as though every
 * participant must consent and an announcement is required. That default costs
 * a recording nobody made. The other default costs a recording that should
 * never have existed, on a call that is now evidence, and that is not a
 * recoverable mistake.
 */
export const CONSENT_RULES = ["one_party", "all_party", "unknown"] as const;
export type ConsentRule = (typeof CONSENT_RULES)[number];

export interface ConsentRuleProfile {
  label: string;
  /** How many participants must have consented before recording may start. */
  partiesRequired: "one" | "all";
  /** What the operator is accepting by declaring a jurisdiction this way. */
  consequence: string;
}

export const CONSENT_RULE: Record<ConsentRule, ConsentRuleProfile> = {
  one_party: {
    label: "One party consent",
    partiesRequired: "one",
    consequence:
      "One participant's agreement is enough. The operator has decided this applies here, and has decided separately whether their own staff member counts as that participant.",
  },
  all_party: {
    label: "All party consent",
    partiesRequired: "all",
    consequence:
      "Every participant must have agreed before recording starts. A recording made without that is unusable at best, and an offence at worst.",
  },
  unknown: {
    label: "Not declared",
    partiesRequired: "all",
    consequence:
      "Nobody has told this system what the rule is here, so it is treated as all party and an announcement is required. The cost of that is a recording that was not made. The cost of guessing the other way is one that should not exist.",
  },
};

/** Whichever of the two is stricter, used to combine the parties' jurisdictions. */
const strictness: Record<ConsentRule, number> = { one_party: 0, all_party: 2, unknown: 2 };

export interface JurisdictionPolicy {
  /**
   * The operator's own identifier for a place: whatever their configuration
   * uses, matched exactly against what is recorded on a party. This file never
   * parses it, never infers a country from it and never falls back to a prefix
   * match, because a fuzzy match here silently applies one place's rule to
   * another place.
   */
  jurisdiction: string;
  rule: ConsentRule;
  /**
   * Whether the announcement must be played BEFORE recording starts.
   *
   * Separate from the rule rather than derived from it, because the two vary
   * independently: an operator may decide to announce everywhere as a matter of
   * policy, and an operator may have advice that a particular place requires
   * something more than the announcement.
   */
  announcementRequired: boolean;
  /** What the operator is claiming, in their words. Shown on the settings screen. */
  note: string;
}

export type PolicyCatalogueVerdict =
  | { ok: true; byJurisdiction: ReadonlyMap<string, JurisdictionPolicy> }
  | { ok: false; reason: string };

/**
 * Whether the operator's declared policies can be used at all.
 *
 * Rules are data loaded from configuration on a machine this project does not
 * run, so every field has to be checked rather than trusted. The two that
 * matter: a rule value outside the declared catalogue, which would otherwise
 * fall through every comparison and behave like one party consent, and a
 * duplicated jurisdiction, where the answer would depend on which row happened
 * to be read first.
 */
export function checkRecordingPolicies(
  policies: readonly JurisdictionPolicy[],
): PolicyCatalogueVerdict {
  const byJurisdiction = new Map<string, JurisdictionPolicy>();

  for (const policy of policies) {
    const id = policy.jurisdiction.trim();
    if (id === "") {
      return { ok: false, reason: "A recording policy has no jurisdiction on it. Every policy has to say where it applies." };
    }
    if (byJurisdiction.has(id)) {
      return {
        ok: false,
        reason: `There are two recording policies for ${id}. Delete one: with both in place the rule that applies depends on the order the file happened to be read in.`,
      };
    }
    if (!CONSENT_RULES.includes(policy.rule)) {
      return {
        ok: false,
        reason: `The policy for ${id} has a rule of "${String(policy.rule)}", which is not one of: ${CONSENT_RULES.join(", ")}.`,
      };
    }
    if (policy.note.trim() === "") {
      return {
        ok: false,
        reason: `The policy for ${id} has no note. The note is what the settings screen shows the person deciding whether to turn recording on, and a blank one tells them nothing.`,
      };
    }
    byJurisdiction.set(id, policy);
  }

  return { ok: true, byJurisdiction };
}

export type PartyRole = "caller" | "callee" | "agent" | "third_party";

export interface CallParty {
  role: PartyRole;
  /**
   * The jurisdiction this person is in, as the operator's policy table names
   * it. Undefined when it was never captured, which is common: a mobile number
   * says where a phone was sold, not where its owner is standing.
   */
  jurisdiction?: string | undefined;
  /**
   * Whether this person has affirmatively agreed on THIS call.
   *
   * Three values on purpose. True is agreement, false is a refusal, and
   * undefined is silence. Silence is not agreement, and folding it into false
   * would lose the difference between somebody who said no, which ends the
   * question, and somebody who has not been asked yet, which is a thing the
   * agent can still do.
   */
  consented?: boolean | undefined;
}

export interface PolicyResolution {
  /** The rule that governs the whole call: the strictest any party brings to it. */
  governing: ConsentRule;
  partiesRequired: "one" | "all";
  announcementRequired: boolean;
  /** Jurisdictions recorded on a party that the policy table does not cover. */
  unrecognised: readonly string[];
  /** How many parties have no jurisdiction recorded at all. */
  partiesWithoutJurisdiction: number;
}

/**
 * The rule that governs a call with participants in several places.
 *
 * The strictest wins. Not the company's, not the caller's, not the one on the
 * number that was dialled: a call is one conversation and it has to satisfy
 * everybody in it, so a single all party participant makes the whole call an
 * all party call.
 *
 * Anything unresolved reports as `unknown`, which requires all parties and an
 * announcement, and is reported distinctly from a declared all party rule so
 * the screen can say "we do not know where this caller is" rather than making
 * a claim about the law that nobody made.
 */
export function governingPolicy(
  parties: readonly CallParty[],
  byJurisdiction: ReadonlyMap<string, JurisdictionPolicy>,
): PolicyResolution {
  let strictest: ConsentRule = "one_party";
  let announcementRequired = false;
  let anyUnresolved = false;
  const unrecognised: string[] = [];
  let partiesWithoutJurisdiction = 0;

  for (const party of parties) {
    const id = party.jurisdiction?.trim();
    if (!id) {
      partiesWithoutJurisdiction += 1;
      anyUnresolved = true;
      continue;
    }
    const policy = byJurisdiction.get(id);
    if (!policy) {
      if (!unrecognised.includes(id)) unrecognised.push(id);
      anyUnresolved = true;
      continue;
    }
    if (strictness[policy.rule] > strictness[strictest]) strictest = policy.rule;
    if (policy.announcementRequired) announcementRequired = true;
  }

  /**
   * An unresolved party makes the whole call unknown even when every other
   * party is in a declared one party jurisdiction. The unknown one could be
   * anywhere, and "the places we happen to have policies for are all lenient"
   * is not evidence about the place we have no policy for.
   */
  const governing: ConsentRule = anyUnresolved ? "unknown" : strictest;

  return {
    governing,
    partiesRequired: CONSENT_RULE[governing].partiesRequired,
    announcementRequired: announcementRequired || anyUnresolved,
    unrecognised,
    partiesWithoutJurisdiction,
  };
}

export type RecordingRefusal =
  | "policy_rejected"
  | "no_parties"
  | "party_declined"
  | "announcement_not_played"
  | "consent_missing";

export interface RecordingRequest {
  parties: readonly CallParty[];
  policies: readonly JurisdictionPolicy[];
  /**
   * Whether the recording notice has already been played to everybody on the
   * call. Named for what it is rather than for what it implies: playing it is
   * the operator's job, and this function only asks whether it happened.
   */
  announcementPlayed: boolean;
}

export type RecordingDecision =
  | {
      ok: true;
      governing: ConsentRule;
      /** True when the announcement was required and has been played. */
      announcementRequired: boolean;
      why: string;
    }
  | {
      ok: false;
      reason: RecordingRefusal;
      message: string;
      governing: ConsentRule;
      /** What still has to happen before the answer could become yes. */
      announcementRequired: boolean;
    };

/**
 * Whether recording may START. Ask before the first byte, not after.
 *
 * The order of the checks is the order a person would work through them, which
 * makes the refusals into a sequence of things to do rather than a wall:
 *
 *   1. A policy table that cannot be trusted stops everything. A broken
 *      configuration must not be the thing that enables recording.
 *   2. Somebody who has said no ends it. Playing the announcement again at a
 *      person who declined is not a remedy, it is the same call being recorded
 *      over their objection.
 *   3. The announcement comes before consent, because on a real call the
 *      announcement is how consent is obtained.
 *   4. Then the count: one agreement, or everybody's.
 *
 * A call with no parties on it refuses. That is not a theoretical case: it is
 * what a provider webhook looks like when the leg has already collapsed, and
 * defaulting an empty list to one party consent would make the emptiest
 * possible input the most permissive one.
 */
export function mayRecord(request: RecordingRequest): RecordingDecision {
  const catalogue = checkRecordingPolicies(request.policies);
  if (!catalogue.ok) {
    return {
      ok: false,
      reason: "policy_rejected",
      message: `Recording is off until the policy configuration is fixed: ${catalogue.reason}`,
      governing: "unknown",
      announcementRequired: true,
    };
  }

  if (request.parties.length === 0) {
    return {
      ok: false,
      reason: "no_parties",
      message: "There is nobody on this call to consent. Recording cannot start until the parties are known.",
      governing: "unknown",
      announcementRequired: true,
    };
  }

  const resolution = governingPolicy(request.parties, catalogue.byJurisdiction);

  const declined = request.parties.filter((p) => p.consented === false);
  if (declined.length > 0) {
    return {
      ok: false,
      reason: "party_declined",
      message: `${declined.map((p) => p.role).join(" and ")} asked not to be recorded. Do not record this call.`,
      governing: resolution.governing,
      announcementRequired: resolution.announcementRequired,
    };
  }

  if (resolution.announcementRequired && !request.announcementPlayed) {
    const because = resolution.governing === "unknown"
      ? whyUnknown(resolution)
      : "the policy for this call requires it";
    return {
      ok: false,
      reason: "announcement_not_played",
      message: `Play the recording notice before recording starts, because ${because}.`,
      governing: resolution.governing,
      announcementRequired: true,
    };
  }

  const consenting = request.parties.filter((p) => p.consented === true);
  const enough = resolution.partiesRequired === "all"
    ? consenting.length === request.parties.length
    : consenting.length >= 1;

  if (!enough) {
    const missing = request.parties.filter((p) => p.consented !== true).map((p) => p.role);
    const rule = CONSENT_RULE[resolution.governing];
    const tail = resolution.governing === "unknown"
      ? ` ${whyUnknown(resolution)}, so this call is being treated as all party.`
      : "";
    return {
      ok: false,
      reason: "consent_missing",
      message: `${rule.label} applies and ${missing.join(", ")} has not agreed.${tail}`,
      governing: resolution.governing,
      announcementRequired: resolution.announcementRequired,
    };
  }

  return {
    ok: true,
    governing: resolution.governing,
    announcementRequired: resolution.announcementRequired,
    why: resolution.governing === "unknown"
      ? `Everybody on the call agreed, which satisfies the all party treatment used when a jurisdiction is unknown. ${capitalise(whyUnknown(resolution))}.`
      : `${CONSENT_RULE[resolution.governing].label} applies and it is satisfied.`,
  };
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function whyUnknown(resolution: PolicyResolution): string {
  const parts: string[] = [];
  if (resolution.partiesWithoutJurisdiction > 0) {
    parts.push(
      `${resolution.partiesWithoutJurisdiction} ${resolution.partiesWithoutJurisdiction === 1 ? "party has" : "parties have"} no location recorded`,
    );
  }
  if (resolution.unrecognised.length > 0) {
    parts.push(`there is no declared policy for ${resolution.unrecognised.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" and ") : "the jurisdiction is not known";
}

/* ----------------------------------------------------------- opening hours */

export const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * A stretch of the day the phones are answered, in minutes past local midnight.
 *
 * Half open, `[openMinute, closeMinute)`, for the same reason every interval in
 * this codebase is: closing at 17:00 means a call at exactly 17:00 is after
 * hours, and the alternative is arguing about one minute forever.
 *
 * A window whose close is before its open wraps past midnight, which is what an
 * after hours emergency line actually looks like: 17:00 to 08:00.
 */
export interface OpenWindow {
  openMinute: number;
  closeMinute: number;
}

export interface Holiday {
  /** `YYYY-MM-DD`, as the calendar date reads in the company's own zone. */
  date: string;
  label: string;
  /**
   * Hours kept on the holiday itself. Absent means closed all day; present and
   * empty means the same thing said explicitly. Christmas Eve until noon is the
   * case this exists for, and a holiday list that could only say "shut" makes
   * the office turn the whole feature off for the day.
   */
  windows?: readonly OpenWindow[] | undefined;
}

export interface BusinessHours {
  /**
   * The COMPANY's zone, not the server's and not the caller's. The server runs
   * in UTC in production and in whatever a contributor has locally, and neither
   * of those is where the phones are.
   */
  timeZone: string;
  weekly: Record<Weekday, readonly OpenWindow[]>;
  holidays: readonly Holiday[];
}

/**
 * The office overriding the schedule for a stretch of time.
 *
 * Two directions, and both are things that really happen. Forced open is the
 * ice storm: the schedule says Sunday and the owner wants every call answered.
 * Forced closed is the funeral, or the whole crew at a training day, where the
 * schedule says open and there is nobody in the building. An override that
 * could only force open would leave the second case to somebody editing the
 * weekly hours and forgetting to put them back.
 *
 * Note that this is not the same as the emergency ROUTING rule further down. An
 * override changes whether the company is open. A no heat call at eleven at
 * night does not change that: the company is shut, and the call still has to
 * reach the person on the rota. Conflating them makes an emergency call at
 * midnight look like normal business hours in every report that reads this.
 */
export interface EmergencyOverride {
  mode: "force_open" | "force_closed";
  label: string;
  /** Half open, `[from, until)`. */
  from: Date;
  until: Date;
}

export type HoursState = "open" | "closed" | "holiday" | "override_open" | "override_closed";

export interface HoursVerdict {
  state: HoursState;
  open: boolean;
  /** The calendar date in the company's zone, which is not always the UTC one. */
  localDate: string;
  localMinutes: number;
  weekday: Weekday;
  /** Set whenever the date is on the holiday list, even when an override reopened the day. */
  holiday: Holiday | null;
  /** The sentence the call detail screen shows. */
  why: string;
}

export type HoursCheck = { ok: true } | { ok: false; reason: string };

const MINUTES_IN_DAY = 24 * 60;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Whether a schedule can be used.
 *
 * Checked rather than trusted because this is configuration a person edits, and
 * the failure modes are all silent. A time zone with a typo in it throws from
 * inside `Intl` on the first call of the day rather than when it was saved. A
 * window whose open equals its close is either nothing or everything and
 * nobody can tell which, so it is refused instead of guessed: a zero length
 * window sends every call to voicemail, and a 24 hour one rings the office at
 * three in the morning, and both look identical in the settings screen.
 */
export function checkBusinessHours(hours: BusinessHours): HoursCheck {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: hours.timeZone });
  } catch {
    return {
      ok: false,
      reason: `"${hours.timeZone}" is not a time zone this system knows. Use an IANA name like America/Chicago.`,
    };
  }

  for (const day of WEEKDAYS) {
    for (const window of hours.weekly[day]) {
      const bad = windowProblem(window, `${day} hours`);
      if (bad) return { ok: false, reason: bad };
    }
  }

  const seen = new Set<string>();
  for (const holiday of hours.holidays) {
    if (!CALENDAR_DATE.test(holiday.date)) {
      return { ok: false, reason: `"${holiday.date}" is not a date. Holidays are written YYYY-MM-DD.` };
    }
    if (seen.has(holiday.date)) {
      return {
        ok: false,
        reason: `${holiday.date} is on the holiday list twice. With both there, the hours kept that day depend on which row was read first.`,
      };
    }
    seen.add(holiday.date);
    for (const window of holiday.windows ?? []) {
      const bad = windowProblem(window, `${holiday.label} hours`);
      if (bad) return { ok: false, reason: bad };
    }
  }

  return { ok: true };
}

function windowProblem(window: OpenWindow, where: string): string | null {
  for (const [name, value] of [["opens", window.openMinute], ["closes", window.closeMinute]] as const) {
    if (!Number.isInteger(value) || value < 0 || value >= MINUTES_IN_DAY) {
      return `The ${where} ${name} at minute ${value}, which is not a time of day. Use 0 to 1439, counted from midnight.`;
    }
  }
  if (window.openMinute === window.closeMinute) {
    return `The ${where} open and close at the same minute (${clock(window.openMinute)}), which is either no time at all or the whole day and nobody can tell which.`;
  }
  return null;
}

/** The day of the week a `YYYY-MM-DD` falls on. */
export function weekdayOf(date: string): Weekday {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`Not a calendar date: ${date}`);
  // getUTCDay is 0 to 6 by definition, so the table cannot miss.
  return WEEKDAYS[new Date(parsed).getUTCDay()]!;
}

/** Whether a local time of day falls inside a window, including one that wraps midnight. */
export function withinWindow(minutes: number, window: OpenWindow): boolean {
  return window.closeMinute > window.openMinute
    ? minutes >= window.openMinute && minutes < window.closeMinute
    : minutes >= window.openMinute || minutes < window.closeMinute;
}

/**
 * Whether the company is open at an instant.
 *
 * Every part of the answer is computed in the company's zone through
 * ../time/index.js rather than from the instant's own numbers, and that is the
 * entire difficulty. Twice a year the same UTC instant is a different local
 * hour, so a schedule stored as an offset is right for about five months and
 * then quietly answers the phones an hour early. Reading the wall clock back
 * out of `Intl` costs a few microseconds and is correct on both sides of the
 * change, in half hour zones, and in places that move their clocks by political
 * decision between releases of this software.
 *
 * `now` is a parameter. Nothing here calls the clock, so the eleven at night on
 * a Sunday case can be tested at eleven in the morning on a Tuesday.
 */
export function hoursAt(
  hours: BusinessHours,
  now: Date,
  override?: EmergencyOverride | undefined,
): HoursVerdict {
  const localDate = dateIn(now, hours.timeZone);
  const localMinutes = minutesInDay(now, hours.timeZone);
  const weekday = weekdayOf(localDate);
  const holiday = hours.holidays.find((h) => h.date === localDate) ?? null;

  const base = { localDate, localMinutes, weekday, holiday };
  const at = `It is ${clock(localMinutes)} on ${localDate} in ${hours.timeZone}`;

  /**
   * The override is checked first and wins outright. That is what an override
   * is: somebody looked at the schedule, decided it was wrong for today, and
   * said so. A version that let the holiday list veto it would need the owner
   * to edit two things during an ice storm.
   */
  if (override && now >= override.from && now < override.until) {
    const open = override.mode === "force_open";
    return {
      ...base,
      state: open ? "override_open" : "override_closed",
      open,
      why: `${at}, and the schedule is overridden: ${override.label}. The company is ${open ? "open" : "closed"} regardless of the usual hours.`,
    };
  }

  const windows = holiday ? (holiday.windows ?? []) : hours.weekly[weekday];
  const open = windows.some((w) => withinWindow(localMinutes, w));
  const described = windows.length === 0
    ? "no hours are kept"
    : windows.map((w) => `${clock(w.openMinute)} to ${clock(w.closeMinute)}`).join(" and ");

  if (holiday) {
    return {
      ...base,
      state: open ? "open" : "holiday",
      open,
      why: `${at}, which is ${holiday.label}, and on that day ${described}.`,
    };
  }

  return {
    ...base,
    state: open ? "open" : "closed",
    open,
    why: `${at}, a ${weekday}, and on a ${weekday} ${described}.`,
  };
}

/* -------------------------------------------------------------- the routing */

/**
 * WHERE THE CALL GOES, AND WHY IT WENT THERE.
 *
 * Routing rules are DATA, checked against a declared catalogue of condition
 * kinds, and they are never a string that becomes code. This product is self
 * hosted, which means the person editing the rules and the person running the
 * server are the same person right up until they are not: a shared office, a
 * bookkeeper with a login, a managed service provider. An expression language
 * in a routing table is remote code execution wearing a tie.
 *
 * First match wins, in the order the rules are written. Not priority numbers:
 * two rules at priority ten sort by whatever the sort happened to do, and the
 * answer to "which of these runs first" becomes a property of the runtime
 * instead of a property of the screen the owner is looking at.
 */
export const CONDITION_KINDS = [
  "during_business_hours",
  "after_hours",
  "on_holiday",
  "time_window",
  "known_customer",
  "has_open_job",
  "dialled_number",
  "emergency_selected",
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export type RoutingCondition =
  | { kind: "during_business_hours" }
  | { kind: "after_hours" }
  | { kind: "on_holiday" }
  /** A stretch of the company's own clock, for the lunch cover and the late shift. */
  | { kind: "time_window"; window: OpenWindow }
  | { kind: "known_customer"; is: boolean }
  | { kind: "has_open_job"; is: boolean }
  /** Which of the company's numbers was dialled: the yard sign number, the truck wrap number. */
  | { kind: "dialled_number"; oneOf: readonly string[] }
  | { kind: "emergency_selected"; is: boolean };

export const DESTINATION_KINDS = ["ring_group", "queue", "voicemail", "forward", "ivr", "on_call_rota"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export type RoutingDestination =
  | { kind: "ring_group"; id: string }
  | { kind: "queue"; id: string }
  | { kind: "voicemail"; box: string }
  /** An external number. The answering service, or the owner's mobile. */
  | { kind: "forward"; e164: string }
  | { kind: "ivr"; menu: string }
  | { kind: "on_call_rota"; id: string };

export interface RoutingRule {
  id: string;
  /** What the owner called it. This appears verbatim in the explanation. */
  label: string;
  /**
   * Every condition must hold. There is no "any" on a rule, deliberately: an
   * all and any tree is where routing tables become unreadable, and two rules
   * in the list say the same thing in a way somebody can follow a year later.
   */
  all: readonly RoutingCondition[];
  to: RoutingDestination;
}

export interface RoutingTable {
  rules: readonly RoutingRule[];
  /**
   * Where a call goes when nothing matched. Required, not optional.
   *
   * The failure this prevents is the one that ends the relationship: a rule set
   * somebody edited on a Friday matches nothing on Saturday, and a ringing
   * phone with no destination is dead air. Dead air is worse than voicemail,
   * because voicemail leaves a message and a record, and dead air leaves a
   * customer who believes the number is disconnected.
   */
  fallback: RoutingDestination;
}

export type RoutingTableVerdict =
  | {
      ok: true;
      /**
       * Rules that can never run because an earlier rule with no conditions
       * matches everything first. Reported rather than refused: an unconditional
       * last rule is a legitimate way to write a catch all, and only the ones
       * BELOW it are the mistake.
       */
      unreachable: readonly string[];
    }
  | { ok: false; reason: string };

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Whether a routing table can be used.
 *
 * The forward number check is the one that earns its place. A forward to a
 * number with a typo in it does not fail loudly: the carrier returns a generic
 * failure on each call, the office sees nothing, and every overflow call for a
 * week goes nowhere.
 */
export function checkRoutingTable(table: RoutingTable): RoutingTableVerdict {
  const ids = new Set<string>();
  const unreachable: string[] = [];
  let catchAllAt: string | null = null;

  for (const rule of table.rules) {
    if (rule.id.trim() === "") return { ok: false, reason: "A routing rule has no id. Every rule needs one so a call can name the rule that routed it." };
    if (ids.has(rule.id)) {
      return { ok: false, reason: `Two routing rules share the id "${rule.id}". A call that names one of them is ambiguous about which it meant.` };
    }
    ids.add(rule.id);

    if (rule.label.trim() === "") {
      return { ok: false, reason: `Rule "${rule.id}" has no label. The label is what the explanation on the call screen says, and a blank one explains nothing.` };
    }

    const bad = conditionProblem(rule);
    if (bad) return { ok: false, reason: bad };

    const badDestination = destinationProblem(rule.to, `rule "${rule.label}"`);
    if (badDestination) return { ok: false, reason: badDestination };

    if (catchAllAt !== null) unreachable.push(rule.id);
    if (rule.all.length === 0) catchAllAt = rule.label;
  }

  const badFallback = destinationProblem(table.fallback, "the fallback");
  if (badFallback) return { ok: false, reason: badFallback };

  return { ok: true, unreachable };
}

function conditionProblem(rule: RoutingRule): string | null {
  for (const condition of rule.all) {
    if (!CONDITION_KINDS.includes(condition.kind)) {
      return `Rule "${rule.label}" tests "${String(condition.kind)}", which is not something this system can check. It knows: ${CONDITION_KINDS.join(", ")}.`;
    }
    if (condition.kind === "time_window") {
      const bad = windowProblem(condition.window, `time window on rule "${rule.label}"`);
      if (bad) return bad;
    }
    if (condition.kind === "dialled_number" && condition.oneOf.length === 0) {
      return `Rule "${rule.label}" matches on the number dialled but lists no numbers, so it can never run.`;
    }
  }
  return null;
}

function destinationProblem(destination: RoutingDestination, where: string): string | null {
  if (!DESTINATION_KINDS.includes(destination.kind)) {
    return `${capitalise(where)} sends calls to "${String(destination.kind)}", which is not a destination this system has. It knows: ${DESTINATION_KINDS.join(", ")}.`;
  }
  if (destination.kind === "forward" && !E164.test(destination.e164)) {
    return `${capitalise(where)} forwards to "${destination.e164}", which is not a dialable number. Write it in full international form, like +15125550147.`;
  }
  return null;
}

/** Everything about a call that a routing rule is allowed to see. */
export interface CallFacts {
  /** Which of the company's numbers rang. */
  dialledNumber: string;
  /** Whether the calling number matched a customer record. */
  knownCustomer: boolean;
  /** Whether that customer has work open right now. */
  hasOpenJob: boolean;
  /** Whether the caller said this is an emergency, usually by pressing a key. */
  emergencySelected: boolean;
  /** The company's own clock and calendar, already resolved by `hoursAt`. */
  hours: HoursVerdict;
}

export interface RoutingStep {
  ruleId: string;
  label: string;
  matched: boolean;
  /** The first condition that did not hold, in words. Null when the rule matched. */
  failedOn: string | null;
}

export interface RoutingResult {
  destination: RoutingDestination;
  /** The rule that decided it, or null when the fallback did. */
  matchedRuleId: string | null;
  /** One sentence, for the call detail screen and for the person being asked about it. */
  why: string;
  /** Every rule considered and what happened to it. This is the audit. */
  trace: readonly RoutingStep[];
}

export function describeCondition(condition: RoutingCondition): string {
  switch (condition.kind) {
    case "during_business_hours": return "it is inside business hours";
    case "after_hours": return "it is outside business hours";
    case "on_holiday": return "it is a holiday";
    case "time_window":
      return `the local time is between ${clock(condition.window.openMinute)} and ${clock(condition.window.closeMinute)}`;
    case "known_customer":
      return condition.is ? "the caller is a known customer" : "the caller is not a known customer";
    case "has_open_job":
      return condition.is ? "the caller has a job open" : "the caller has no job open";
    case "dialled_number":
      return `the number dialled is ${condition.oneOf.join(" or ")}`;
    case "emergency_selected":
      return condition.is ? "the caller chose the emergency option" : "the caller did not choose the emergency option";
    default:
      return `an unrecognised condition (${String((condition as { kind: string }).kind)})`;
  }
}

export function describeDestination(destination: RoutingDestination): string {
  switch (destination.kind) {
    case "ring_group": return `the ${destination.id} ring group`;
    case "queue": return `the ${destination.id} queue`;
    case "voicemail": return `the ${destination.box} voicemail box`;
    case "forward": return `${destination.e164}`;
    case "ivr": return `the ${destination.menu} menu`;
    case "on_call_rota": return `whoever is on the ${destination.id} rota`;
    default: return "an unrecognised destination";
  }
}

/**
 * Whether one condition holds.
 *
 * The default case is load bearing rather than ceremonial. Rules come off disk
 * on somebody else's server, written by a version of this product that may be
 * newer than the one running, so a condition kind this build has never heard of
 * is a real runtime possibility. It does NOT match, and the trace says why. The
 * alternative, treating an unknown test as satisfied, routes calls using a rule
 * the running system cannot read.
 */
function conditionHolds(condition: RoutingCondition, facts: CallFacts): boolean {
  switch (condition.kind) {
    case "during_business_hours": return facts.hours.open;
    case "after_hours": return !facts.hours.open;
    /**
     * Read off the holiday itself rather than off the state, so a holiday the
     * owner forced open with an override is still a holiday for routing. The
     * day the company opens for emergencies on Christmas is exactly the day the
     * emergency rule has to fire.
     */
    case "on_holiday": return facts.hours.holiday !== null;
    case "time_window": return withinWindow(facts.hours.localMinutes, condition.window);
    case "known_customer": return facts.knownCustomer === condition.is;
    case "has_open_job": return facts.hasOpenJob === condition.is;
    case "dialled_number": return condition.oneOf.includes(facts.dialledNumber);
    case "emergency_selected": return facts.emergencySelected === condition.is;
    default: return false;
  }
}

/**
 * Where this call goes.
 *
 * Total by construction: it always returns a destination, because the table
 * carries a fallback and a ringing phone must never be handed nothing. That is
 * why this is not an ok-or-refuse decision like the others in this file. The
 * refusals for routing all happen earlier, in `checkRoutingTable`, when
 * somebody saves the rules, which is the moment a person is present to read
 * them.
 *
 * The trace is the feature. Somebody will ask why a good customer got voicemail
 * in the middle of the afternoon, and the answer is nearly always a rule three
 * rows above the one everybody is looking at. A router that returns only a
 * destination turns that into an afternoon of reading rules and guessing.
 */
export function route(table: RoutingTable, facts: CallFacts): RoutingResult {
  const trace: RoutingStep[] = [];

  for (const rule of table.rules) {
    const failed = rule.all.find((condition) => !conditionHolds(condition, facts));
    if (failed) {
      trace.push({ ruleId: rule.id, label: rule.label, matched: false, failedOn: describeCondition(failed) });
      continue;
    }
    trace.push({ ruleId: rule.id, label: rule.label, matched: true, failedOn: null });

    const because = rule.all.length === 0
      ? "it has no conditions, so it matches every call"
      : rule.all.map(describeCondition).join(", and ");

    return {
      destination: rule.to,
      matchedRuleId: rule.id,
      why: `"${rule.label}" matched because ${because}. Sent to ${describeDestination(rule.to)}.`,
      trace,
    };
  }

  const tried = table.rules.length === 0
    ? "There are no routing rules at all"
    : `None of the ${table.rules.length} routing rules matched`;

  return {
    destination: table.fallback,
    matchedRuleId: null,
    why: `${tried}, so this call went to the fallback: ${describeDestination(table.fallback)}. ${facts.hours.why}`,
    trace,
  };
}

/* --------------------------------------------------------- what it amounted to */

/**
 * WHAT THE CALL ACTUALLY WAS.
 *
 * Derived from the facts rather than typed in by whoever hung up, because the
 * disposition an agent selects is the one they select on the calls they
 * remember to, which is the calls that went well.
 *
 * Every classification below carries what it is USED for and where it is likely
 * to be WRONG, and the second half is not modesty. These numbers end up in a
 * conversation about whether somebody is answering the phone properly, and a
 * label whose failure modes are written down is one that conversation can
 * survive.
 */
export const CALL_OUTCOMES = [
  "booked",
  "reached_no_booking",
  "too_short_to_count",
  "voicemail_left",
  "voicemail_no_message",
  "missed",
  "abandoned_before_answer",
  "abandoned_on_hold",
  "wrong_number",
  "failed",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface OutcomeProfile {
  label: string;
  /** Which number this call feeds, in the words the report uses. */
  usedFor: string;
  /** Where this label lies, stated plainly, because it does lie sometimes. */
  likelyWrongWhen: string;
}

export const CALL_OUTCOME: Record<CallOutcome, OutcomeProfile> = {
  booked: {
    label: "Booked",
    usedFor: "The booking rate, and the only honest measure of whether answering the phone is turning into work.",
    likelyWrongWhen:
      "The job was created twenty minutes later from a callback and attributed to whichever call was open on the screen, or the customer rang to confirm work that was already booked and the link made it look like a fresh sale.",
  },
  reached_no_booking: {
    label: "Spoke, nothing booked",
    usedFor: "The gap between conversations and jobs, which is where coaching goes.",
    likelyWrongWhen:
      "Plenty of these were never bookable: a supplier, a recruiter, a customer asking where the technician is. Without a reason code this bucket flatters itself as lost sales.",
  },
  too_short_to_count: {
    label: "Answered, but barely",
    usedFor: "Finding calls that a handle rate counts as successes and a customer would not.",
    likelyWrongWhen:
      "A genuinely quick answer exists: confirming an arrival window takes eight seconds. The threshold is configuration for that reason, and a company that reads it as a discipline number will punish the fastest person in the office.",
  },
  voicemail_left: {
    label: "Voicemail, message left",
    usedFor: "The callback queue. This is work waiting, not work finished.",
    likelyWrongWhen:
      "Counted as handled in most phone system reports. Nothing here knows whether anybody rang back, and until something does, treating this as a completed call is the most expensive mistake on this list.",
  },
  voicemail_no_message: {
    label: "Voicemail, hung up",
    usedFor: "Missed opportunity. Somebody wanted something and would not say it to a machine.",
    likelyWrongWhen:
      "Indistinguishable from a wrong number that realised its mistake at the greeting, and from an automated dialler.",
  },
  missed: {
    label: "Missed",
    usedFor: "The missed call number, which is the one an owner asks for first.",
    likelyWrongWhen:
      "Separating this from an abandoned call turns on who hung up first, and a caller who gave up at twenty nine seconds of a thirty second ring lands in the other bucket while meaning exactly the same thing to the business.",
  },
  abandoned_before_answer: {
    label: "Caller gave up",
    usedFor: "Ring time and staffing. Long ring times show up here before they show up in revenue.",
    likelyWrongWhen:
      "Includes the caller who dialled and immediately thought better of it, which is why a short abandon threshold exists and why the raw count overstates the problem.",
  },
  abandoned_on_hold: {
    label: "Gave up on hold",
    usedFor:
      "The most expensive number nobody has. These calls were answered, so every handle rate counts them as wins, and the customer hung up unserved.",
    likelyWrongWhen:
      "A caller who got their answer and hung up while being parked for something optional looks identical to one who gave up waiting.",
  },
  wrong_number: {
    label: "Wrong number",
    usedFor: "Taking noise out of every other number on this list.",
    likelyWrongWhen:
      "It is a human judgement and it is the quickest button to press on a call somebody does not want to write up.",
  },
  failed: {
    label: "Failed",
    usedFor: "Carrier and configuration problems. A run of these is an outage, not a sales problem.",
    likelyWrongWhen:
      "Providers report a rejected call and a call to a mis-typed forwarding number the same way, so a routing mistake hides in here looking like weather.",
  },
};

export interface OutcomeThresholds {
  /**
   * Below this, an answered call was not a conversation.
   *
   * Configuration rather than a constant, because the right number depends on
   * what the company's calls are for. Somebody confirming an arrival window is
   * done in eight seconds and somebody diagnosing a boiler is not.
   */
  minimumTalkSeconds: number;
  /**
   * A caller who hangs up faster than this never gave anybody a chance to
   * answer, and counting it against the office produces a missed call number
   * they learn to ignore. Which is worse than not having one.
   */
  shortAbandonSeconds: number;
}

export const DEFAULT_OUTCOME_THRESHOLDS: OutcomeThresholds = {
  minimumTalkSeconds: 10,
  shortAbandonSeconds: 5,
};

export interface CallRecord {
  direction: "inbound" | "outbound";
  /** The state the call ended in. */
  state: CallState;
  /** How long it rang before anything happened to it. */
  ringSeconds: number;
  /** How long anybody was actually talking. Zero for a call nobody answered. */
  talkSeconds: number;
  endedBy: "caller" | "us" | "carrier" | "unknown";
  /** Whether a message was actually left, as opposed to the box being reached. */
  voicemailLeft: boolean;
  /** Set when work was created off the back of this call. */
  bookedJobId?: string | null | undefined;
  /** Somebody pressed the wrong number button. A human judgement, and it wins. */
  markedWrongNumber: boolean;
}

export interface OutcomeVerdict {
  outcome: CallOutcome;
  why: string;
  /**
   * Whether this counts in the missed call number. Separate from the outcome
   * because four different outcomes count towards it and an owner asks for one
   * number, not four.
   */
  countsAsMissed: boolean;
  /** Whether a human being spoke to the caller for long enough to matter. */
  reachedAPerson: boolean;
  /**
   * Something a person should look at, set when the facts disagree with each
   * other. Not an error: the call happened however the record reads, and the
   * disagreement is the thing worth surfacing.
   */
  caution: string | null;
}

/**
 * Classify a finished call.
 *
 * The order is deliberate and it is worth reading once:
 *
 *   A HUMAN JUDGEMENT BEATS DERIVED FACTS. If somebody marked it a wrong
 *   number, it is a wrong number, however long it lasted. They were there.
 *
 *   A FAILURE IS NOT AN ABANDONMENT. Nobody chose it, and a carrier problem
 *   sitting in the missed call number sends an owner to talk to the office
 *   about something the office cannot fix.
 *
 *   WHO HUNG UP DECIDES BETWEEN MISSED AND ABANDONED. The caller giving up and
 *   the system giving up are different facts about the business: the first is
 *   the ring being too long, the second is nobody being there at all. Both
 *   count as missed in the headline number, and only one of them is a staffing
 *   problem you can solve by answering faster.
 *
 *   A SHORT ANSWERED CALL IS NOT AN ANSWERED CALL. Last, after everything else,
 *   because it is the check that turns a good looking number into a true one.
 */
export function classify(
  call: CallRecord,
  thresholds: OutcomeThresholds = DEFAULT_OUTCOME_THRESHOLDS,
): OutcomeVerdict {
  const outbound = call.direction === "outbound"
    ? "These labels are written for inbound calls. On an outbound call read this as what we managed to do, not as something the caller did."
    : null;

  if (call.markedWrongNumber) {
    return {
      outcome: "wrong_number", countsAsMissed: false, reachedAPerson: call.talkSeconds > 0,
      why: "Somebody on the call marked it a wrong number, and a person who was there beats anything derived from the duration.",
      caution: outbound,
    };
  }

  if (call.state === "failed") {
    return {
      outcome: "failed", countsAsMissed: false, reachedAPerson: false,
      why: "The provider could not complete the call. Nobody at either end chose this, so it is not counted against the office.",
      caution: outbound ?? "A run of these is usually a forwarding number with a typo in it rather than the network.",
    };
  }

  if (call.state === "voicemail") {
    return call.voicemailLeft
      ? {
          outcome: "voicemail_left", countsAsMissed: true, reachedAPerson: false,
          why: "The call reached the voicemail box and a message was left. This is work waiting for a callback, not a call that was handled.",
          caution: outbound,
        }
      : {
          outcome: "voicemail_no_message", countsAsMissed: true, reachedAPerson: false,
          why: "The call reached the voicemail box and the caller hung up without leaving anything. Somebody wanted something and would not say it to a machine.",
          caution: outbound,
        };
  }

  if (call.state === "abandoned") {
    /**
     * Talk time is the only evidence that anybody picked up. A provider that
     * reports a hold abandonment reports it as abandoned like any other, and
     * without this the most expensive category on the list disappears into the
     * ordinary one.
     */
    if (call.talkSeconds > 0) {
      return {
        outcome: "abandoned_on_hold", countsAsMissed: true, reachedAPerson: true,
        why: `Somebody answered and talked for ${call.talkSeconds} seconds, and then the call ended without being completed. Almost always a caller giving up on hold.`,
        caution: outbound ?? "A caller who got what they needed and hung up while being parked looks the same as one who gave up waiting.",
      };
    }
    if (call.endedBy === "caller") {
      const short = call.ringSeconds < thresholds.shortAbandonSeconds;
      return {
        outcome: "abandoned_before_answer", countsAsMissed: !short, reachedAPerson: false,
        why: short
          ? `The caller hung up after ${call.ringSeconds} seconds, before anybody could realistically have answered. Not counted against the office.`
          : `The caller hung up after ${call.ringSeconds} seconds of ringing without anybody answering.`,
        caution: outbound,
      };
    }
    return {
      outcome: "missed", countsAsMissed: true, reachedAPerson: false,
      why: `It rang for ${call.ringSeconds} seconds and the ${call.endedBy === "us" ? "system" : "carrier"} gave up before anybody here answered.`,
      caution: outbound ?? "A caller who gave up one second before the ring timeout lands in the abandoned bucket instead, and means the same thing.",
    };
  }

  if (call.state === "ringing" || call.state === "answered" || call.state === "in_progress" ||
      call.state === "on_hold" || call.state === "transferred") {
    /**
     * A call classified while it is still open, or one whose ending event was
     * lost. Reported as missed rather than guessed at, because an unfinished
     * call sitting in the completed pile is a call nobody goes back to.
     */
    return {
      outcome: "missed", countsAsMissed: true, reachedAPerson: call.talkSeconds > 0,
      why: `This call is still recorded as ${CALL_STATE[call.state].label.toLowerCase()}, so it never reached an ending.`,
      caution: `The ending event never arrived. Until it does, this is a guess, and the call should be looked at rather than reported on.`,
    };
  }

  // completed.
  if (call.talkSeconds < thresholds.minimumTalkSeconds) {
    return {
      outcome: "too_short_to_count", countsAsMissed: true, reachedAPerson: false,
      why: `Answered, but the conversation lasted ${call.talkSeconds} seconds, under the ${thresholds.minimumTalkSeconds} second floor. A handle rate counts this as a success and the customer would not.`,
      caution: outbound ?? "A genuinely quick answer exists: confirming an arrival window takes seconds. The floor is configuration, not a discipline rule.",
    };
  }

  if (call.bookedJobId) {
    return {
      outcome: "booked", countsAsMissed: false, reachedAPerson: true,
      why: `Answered, ${call.talkSeconds} seconds of conversation, and work was booked off the back of it.`,
      caution: outbound,
    };
  }

  return {
    outcome: "reached_no_booking", countsAsMissed: false, reachedAPerson: true,
    why: `Answered, ${call.talkSeconds} seconds of conversation, and nothing was booked.`,
    caution: outbound ?? "Plenty of these were never bookable. Without a reason code this bucket reads as lost sales when much of it is a supplier ringing back.",
  };
}
