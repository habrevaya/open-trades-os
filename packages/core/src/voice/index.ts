import {
  WEEKDAYS, hoursAt, route, checkRoutingTable, mayRecord,
  type BusinessHours, type OpenWindow, type Weekday, type RoutingTable, type RoutingResult,
  type HoursVerdict, type CallParty, type JurisdictionPolicy, type RecordingDecision, type RoutingDestination,
} from "../telephony/index.js";
import { menuHoursTable, type PhoneMenu } from "./menus.js";
import { isClientAddress } from "./softphone.js";

/**
 * A TRACKING NUMBER THAT ANSWERS ITS OWN CALLS
 *
 * `telephony` decides the questions a call raises: may it be recorded, where
 * does it go, what did it amount to. Until now nothing asked them of a real
 * call, because every call arrived as a record from somebody else's system.
 * A number bought through the company's own carrier account rings HERE first,
 * and this module is what turns the answers into the instructions the carrier
 * follows: who to ring, what to say first, and whether recording may start.
 *
 * Everything is pure. The carrier's markup (TwiML) is built from a small list
 * of verbs this file knows, with every piece of text escaped, because the
 * channel and campaign names in a whisper are typed by the office and a name
 * with an angle bracket in it must not become an instruction to the carrier.
 *
 * WHAT IT REFUSES TO DO. It never records a call on its own say so. The plan
 * asks the caller first, and recording is only switched on in the dial after
 * `telephony.mayRecord` has said yes for the parties on the call, under the
 * operator's own declared policies.
 */

/* ------------------------------------------------------------------- TwiML */

export type Verb =
  | { verb: "say"; text: string }
  | { verb: "pause"; seconds: number }
  | { verb: "gather"; action: string; timeoutSeconds: number; numDigits: number; say: string }
  | {
      verb: "dial";
      /**
       * One number, or several rung at once. Several is a ring group's "all
       * at once": the carrier rings every phone and the first to pick up
       * gets the caller, which is the only way to do that without the
       * caller hearing a transfer.
       */
      to: string | readonly string[];
      action: string;
      timeoutSeconds: number;
      /** Played to the person answering before the two are connected. */
      whisperUrl?: string | undefined;
      /** Set only when the recording check said yes. Never defaulted. */
      recordingCallback?: string | undefined;
      callerId?: string | undefined;
    }
  | { verb: "record"; action: string; recordingCallback: string; maxSeconds: number }
  | { verb: "redirect"; url: string }
  | { verb: "hangup" }
  | { verb: "reject" }
  | { verb: "play"; url: string }
  /** Hold the caller in the carrier's queue, asking `waitUrl` what to play, and `action` when they leave it. */
  | { verb: "enqueue"; queue: string; waitUrl: string; action: string }
  /** Said from the wait instructions: leave the queue now, on to the enqueue's action. */
  | { verb: "leave" }
  /** Put whoever answered through to the caller at the front of a queue. */
  | { verb: "dialQueue"; queue: string; url: string }
  /**
   * Hand the call to the phone assistant: the carrier turns the caller's
   * speech into text, sends it over a WebSocket to `url`, and reads aloud the
   * text that comes back. `greeting` is said first, by the carrier, and may
   * not be talked over. When the assistant ends the session the carrier asks
   * `action` what happens next.
   */
  | { verb: "relay"; url: string; action: string; greeting: string; language: string };

/** XML text and attribute escaping. Office typed names go through this, always. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const attr = (name: string, value: string | number) => ` ${name}="${escapeXml(String(value))}"`;

function verbXml(v: Verb): string {
  switch (v.verb) {
    case "say": return `<Say>${escapeXml(v.text)}</Say>`;
    case "pause": return `<Pause${attr("length", v.seconds)}/>`;
    case "gather":
      return `<Gather${attr("action", v.action)}${attr("method", "POST")}${attr("numDigits", v.numDigits)}`
        + `${attr("timeout", v.timeoutSeconds)}><Say>${escapeXml(v.say)}</Say></Gather>`;
    case "dial": {
      const recording = v.recordingCallback
        ? `${attr("record", "record-from-answer-dual")}${attr("recordingStatusCallback", v.recordingCallback)}`
          + `${attr("recordingStatusCallbackEvent", "completed")}`
        : "";
      /** A browser is a `Client` noun, named without its prefix; everything else is a number. */
      const numbers = (typeof v.to === "string" ? [v.to] : v.to).map((to) => {
        const noun = isClientAddress(to) ? "Client" : "Number";
        const name = isClientAddress(to) ? to.slice("client:".length) : to;
        return `<${noun}${v.whisperUrl ? attr("url", v.whisperUrl) : ""}>${escapeXml(name)}</${noun}>`;
      }).join("");
      return `<Dial${attr("action", v.action)}${attr("method", "POST")}${attr("timeout", v.timeoutSeconds)}`
        + `${attr("answerOnBridge", "true")}${v.callerId ? attr("callerId", v.callerId) : ""}${recording}>`
        + `${numbers}</Dial>`;
    }
    case "record":
      return `<Record${attr("action", v.action)}${attr("method", "POST")}${attr("maxLength", v.maxSeconds)}`
        + `${attr("playBeep", "true")}${attr("recordingStatusCallback", v.recordingCallback)}`
        + `${attr("recordingStatusCallbackEvent", "completed")}/>`;
    case "redirect": return `<Redirect${attr("method", "POST")}>${escapeXml(v.url)}</Redirect>`;
    case "hangup": return "<Hangup/>";
    case "reject": return "<Reject/>";
    case "play": return `<Play>${escapeXml(v.url)}</Play>`;
    case "enqueue":
      return `<Enqueue${attr("action", v.action)}${attr("method", "POST")}${attr("waitUrl", v.waitUrl)}`
        + `${attr("waitUrlMethod", "POST")}>${escapeXml(v.queue)}</Enqueue>`;
    case "leave": return "<Leave/>";
    case "dialQueue":
      return `<Dial><Queue${attr("url", v.url)}${attr("method", "POST")}>${escapeXml(v.queue)}</Queue></Dial>`;
    case "relay":
      return `<Connect${attr("action", v.action)}${attr("method", "POST")}>`
        + `<ConversationRelay${attr("url", v.url)}${attr("welcomeGreeting", v.greeting)}`
        + `${attr("welcomeGreetingInterruptible", "none")}${attr("language", v.language)}`
        + `${attr("dtmfDetection", "true")}${attr("interruptible", "speech")}/></Connect>`;
  }
}

/** The whole response the carrier reads. */
export function twiml(verbs: readonly Verb[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.map(verbXml).join("")}</Response>`;
}

/* ------------------------------------------------------------ what is said */

/**
 * The recording notice, and the question.
 *
 * Asked rather than announced. `mayRecord` counts a party as agreeing only
 * when they affirmatively agreed on this call, and staying on the line after
 * a notice is silence, which core deliberately does not read as yes. So the
 * caller is asked to press 1, and anything else (including pressing nothing)
 * connects them without recording.
 */
export const RECORDING_QUESTION =
  "This call can be recorded so we can look after you properly. Press 1 if that is all right. "
  + "Otherwise stay on the line and you will be connected without recording.";

/**
 * The same question, put to somebody the office is ringing from the browser.
 *
 * Asked of the person picking up, before the two are connected, because on an
 * outbound call they are the party who has not agreed to anything yet: the
 * person in the office pressed Call. Said with the company's name first, so a
 * customer hearing a machine before a voice knows who is ringing.
 */
export function calleeRecordingQuestion(company: string): string {
  return `${company} is calling. This call can be recorded so we can look after you properly. `
    + "Press 1 if that is all right. Otherwise stay on the line and you will be connected without recording.";
}

export const VOICEMAIL_PROMPT =
  "Sorry we missed you. Please leave your name, number and what you need after the tone, and we will call you back.";

export const NOT_IN_SERVICE = "Sorry, this number is not in service.";

/**
 * What the person answering hears before the caller is put through.
 *
 * The channel and campaign, so the office knows the caller saw the spring
 * mailer before they say a word, and whether the call is being recorded,
 * because the person answering is a party to the call too. Short, because
 * the caller is waiting in silence while it plays.
 */
export function whisperText(input: {
  channelName?: string | null | undefined;
  campaignName?: string | null | undefined;
  recording: boolean;
  /**
   * What the caller pressed in a phone menu, by its label: "Billing". Said
   * first, because it is the thing the person answering needs before they
   * say hello: a billing question answered as a booking is a caller asked
   * to repeat themselves.
   */
  choice?: string | null | undefined;
}): string {
  const from = [input.channelName, input.campaignName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const choice = input.choice?.trim();
  const head = from.length > 0
    ? `Call from ${from.join(", ")}.`
    : choice ? "" : "Call from a tracking number.";
  const said = [choice ? `${choice} call.` : "", head].filter(Boolean).join(" ");
  return input.recording ? `${said} This call is being recorded.` : said;
}

/* ---------------------------------------------------------- business hours */

export interface HoursRow {
  /** 0 is Sunday, as `business_hours.day_of_week` stores it. */
  dayOfWeek: number;
  opensAt: string | null;
  closesAt: string | null;
  closed: boolean;
}

const minutesOf = (clock: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})/.exec(clock);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
};

/**
 * The company's opening hours, from the rows online booking already keeps.
 *
 * Null when nothing usable is declared, and that null is load bearing: a
 * company that never filled in its hours is not closed all week, and routing
 * by an empty schedule would send every call to voicemail. A number set to
 * route by hours with no hours declared is simply not routed by them.
 */
export function businessHoursFrom(rows: readonly HoursRow[], timeZone: string): BusinessHours | null {
  const weekly = Object.fromEntries(WEEKDAYS.map((day) => [day, [] as OpenWindow[]])) as
    Record<Weekday, OpenWindow[]>;
  let any = false;
  for (const row of rows) {
    if (row.closed || row.opensAt === null || row.closesAt === null) continue;
    const day = WEEKDAYS[row.dayOfWeek];
    const open = minutesOf(row.opensAt);
    const close = minutesOf(row.closesAt);
    if (!day || open === null || close === null || open === close) continue;
    weekly[day].push({ openMinute: open, closeMinute: close });
    any = true;
  }
  return any ? { timeZone, weekly, holidays: [] } : null;
}

/* ----------------------------------------------------------------- routing */

export interface NumberRouting {
  forwardsToE164: string | null;
  routeByHours: boolean;
  afterHoursForwardsToE164: string | null;
}

/**
 * The routing table a tracking number implies, in core's own shape.
 *
 * Two rules at most: in hours, ring the forwarding number; otherwise the after
 * hours number or voicemail. Built as a table rather than an if statement so
 * the call is routed by `telephony.route`, which is what writes the sentence
 * saying why it went where it went.
 */
export function routingTableFor(number: NumberRouting): RoutingTable {
  const afterHours = number.afterHoursForwardsToE164
    ? { kind: "forward" as const, e164: number.afterHoursForwardsToE164 }
    : { kind: "voicemail" as const, box: "main" };
  if (!number.forwardsToE164) return { rules: [], fallback: { kind: "voicemail", box: "main" } };
  if (!number.routeByHours) {
    return {
      rules: [{ id: "always", label: "Ring the office", all: [], to: { kind: "forward", e164: number.forwardsToE164 } }],
      fallback: afterHours,
    };
  }
  return {
    rules: [{
      id: "open", label: "Open hours", all: [{ kind: "during_business_hours" }],
      to: { kind: "forward", e164: number.forwardsToE164 },
    }],
    fallback: afterHours,
  };
}

export type NumberRoutingCheck = { ok: true } | { ok: false; reason: string };

/** Refused when the settings are saved, which is when somebody is looking. */
export function checkNumberRouting(number: NumberRouting): NumberRoutingCheck {
  const verdict = checkRoutingTable(routingTableFor(number));
  if (!verdict.ok) return verdict;
  if (number.afterHoursForwardsToE164 && !number.routeByHours) {
    return {
      ok: false,
      reason: "An after hours number only does anything when calls are routed by your business hours. Turn that on, or clear the number.",
    };
  }
  return { ok: true };
}

/** A clock that is always open, for a call with no hours to route by. */
function alwaysOpen(now: Date): HoursVerdict {
  return {
    state: "open", open: true, localDate: now.toISOString().slice(0, 10), localMinutes: 0,
    weekday: WEEKDAYS[now.getUTCDay()]!, holiday: null,
    why: "No business hours are declared, so the call is treated as inside them.",
  };
}

/**
 * Where this call goes, and the sentence that says why.
 *
 * Hours are consulted only when the number is set to route by them AND the
 * company has declared some; otherwise the clock is treated as open.
 */
export function routeCall(input: {
  number: NumberRouting;
  dialled: string;
  hours: BusinessHours | null;
  knownCustomer: boolean;
  now: Date;
}): RoutingResult {
  const verdict = input.number.routeByHours && input.hours ? hoursAt(input.hours, input.now) : alwaysOpen(input.now);
  return route(routingTableFor(input.number), {
    dialledNumber: input.dialled,
    knownCustomer: input.knownCustomer,
    hasOpenJob: false,
    emergencySelected: false,
    hours: verdict,
  });
}

/**
 * Where a call to a number answered by a phone menu goes: the menu in
 * business hours, and outside them wherever the menu says. A company with no
 * hours declared is treated as open, for the reason `businessHoursFrom`
 * gives: it is not closed all week.
 */
export function routeToMenu(input: {
  menu: Pick<PhoneMenu, "id" | "afterHoursTo">;
  dialled: string;
  hours: BusinessHours | null;
  knownCustomer: boolean;
  now: Date;
  describe?: ((destination: RoutingDestination) => string) | undefined;
}): RoutingResult {
  const verdict = input.hours ? hoursAt(input.hours, input.now) : alwaysOpen(input.now);
  return route(menuHoursTable(input.menu), {
    dialledNumber: input.dialled,
    knownCustomer: input.knownCustomer,
    hasOpenJob: false,
    emergencySelected: false,
    hours: verdict,
  }, input.describe);
}

/* --------------------------------------------------------------- recording */

/**
 * The recording question, put to core, for a call this product answered.
 *
 * The caller's place is never known. A number's area code says where the
 * phone was sold, and core's own comment says not to read it as where the
 * caller is standing, so the caller has no jurisdiction and the call resolves
 * to `unknown`: everybody must agree and the notice must have played. The
 * caller agrees by pressing 1. The person answering is the company's own
 * staff on the company's own line, told by the whisper that the call is
 * being recorded, and the company switched recording on for this number,
 * which is the company agreeing for its side of the call.
 */
export function recordingDecision(input: {
  callerPressedOne: boolean;
  policies: readonly JurisdictionPolicy[];
  /**
   * Who the person outside the company is on this call: the caller, or on a
   * call the office placed from the browser, the person called. Either way
   * they are asked the same question and agree the same way.
   */
  outside?: "caller" | "callee" | undefined;
}): { decision: RecordingDecision; parties: CallParty[] } {
  const parties: CallParty[] = [
    { role: input.outside ?? "caller", ...(input.callerPressedOne ? { consented: true } : {}) },
    { role: "agent", consented: true },
  ];
  return {
    parties,
    decision: mayRecord({ parties, policies: input.policies, announcementPlayed: true }),
  };
}

/* ------------------------------------------------------- what came back */

export type CallStatusValue =
  | "ringing" | "in_progress" | "completed" | "no_answer" | "busy" | "failed" | "voicemail" | "abandoned";

/**
 * What a dial ended as, from the carrier's `DialCallStatus`.
 *
 * `missed` is the fact a missed call text back runs on: nobody at the company
 * picked up. A busy line and a failed forward are missed calls as far as the
 * caller is concerned, which is the only point of view that matters here.
 */
export function dialOutcome(dialStatus: string | undefined): {
  answered: boolean; missed: boolean; status: CallStatusValue;
} {
  switch (dialStatus) {
    case "completed":
    case "answered":
      return { answered: true, missed: false, status: "completed" };
    case "busy":
      return { answered: false, missed: true, status: "busy" };
    case "failed":
      return { answered: false, missed: true, status: "failed" };
    case "canceled":
      return { answered: false, missed: true, status: "abandoned" };
    default:
      return { answered: false, missed: true, status: "no_answer" };
  }
}

/**
 * Whether a status callback can move a call to this state.
 *
 * Carriers send callbacks out of order and more than once. A final state
 * already recorded is never moved back to ringing, and a voicemail is never
 * downgraded to a bare no answer by a later, less specific callback.
 */
const RANK: Record<CallStatusValue, number> = {
  ringing: 0, in_progress: 1, busy: 2, failed: 2, no_answer: 2, abandoned: 2, completed: 3, voicemail: 4,
};

export function laterStatus(current: CallStatusValue, next: CallStatusValue): CallStatusValue {
  return RANK[next] > RANK[current] ? next : current;
}

/** The carrier's own call status, in this product's words. */
export function providerCallStatus(status: string | undefined): CallStatusValue | null {
  switch (status) {
    case "queued":
    case "ringing": return "ringing";
    case "in-progress": return "in_progress";
    case "completed": return "completed";
    case "busy": return "busy";
    case "no-answer": return "no_answer";
    case "failed": return "failed";
    case "canceled": return "abandoned";
    default: return null;
  }
}

/** Area code or a town, for searching numbers to buy. */
export type NumberSearch =
  | { ok: true; areaCode?: string | undefined; locality?: string | undefined; region?: string | undefined }
  | { ok: false; reason: string };

export function checkNumberSearch(input: {
  areaCode?: string | undefined; locality?: string | undefined; region?: string | undefined;
}): NumberSearch {
  const areaCode = input.areaCode?.trim() || undefined;
  const locality = input.locality?.trim() || undefined;
  const region = input.region?.trim().toUpperCase() || undefined;
  if (!areaCode && !locality) {
    return { ok: false, reason: "Give an area code, like 512, or a town, like Austin, to search for a number." };
  }
  if (areaCode && !/^[2-9]\d{2}$/.test(areaCode)) {
    return { ok: false, reason: `"${areaCode}" is not an area code. It is three digits and does not start with 0 or 1.` };
  }
  if (locality && !/^[\p{L}][\p{L} .'-]{1,60}$/u.test(locality)) {
    return { ok: false, reason: "A town is letters and spaces." };
  }
  if (region && !/^[A-Z]{2}$/.test(region)) {
    return { ok: false, reason: "A state is its two letter code, like TX." };
  }
  return { ok: true, areaCode, locality, region };
}

/**
 * Phone menus, ring groups and the on call week, which build the destinations
 * the router above can send a call to.
 */
export * from "./menus.js";
export * from "./queues.js";
export * from "./softphone.js";
