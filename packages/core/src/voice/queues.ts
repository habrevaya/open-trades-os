import type { RoutingDestination } from "../telephony/index.js";
import { destinationProblem, type Check, type Directory, type RingPlan, type RingStep } from "./menus.js";
import { dialable } from "./softphone.js";

/**
 * A WAITING LINE
 *
 * "All our team are on other calls. You are next in line." A caller held with
 * music while the people in a ring group finish what they are doing, put
 * through to the first one free, and sent to voicemail (or wherever the owner
 * says) when they have waited as long as the company is willing to let them.
 *
 * The carrier holds the caller: it has a queue of its own, plays what it is
 * told while the caller waits, and puts the caller at the front through to
 * whoever asks for them. What it does not do is decide who to ring, how often,
 * what to say about the caller's place, or when the wait has gone on too long.
 * Those are here, pure, so the rules a caller waits under can be tested with a
 * clock in a literal.
 */

export interface CallQueue {
  id: string;
  name: string;
  /** Whose phones ring while a caller waits. */
  ringGroupId: string;
  /** The longest a caller waits before going to `overflowTo`. */
  maxWaitSeconds: number;
  /** Whether the caller is told their place in line each time the music comes round. */
  announcePosition: boolean;
  /** An MP3 or WAV address the carrier can fetch, or null for the default music. */
  holdMusicUrl: string | null;
  /** Where a caller goes once they have waited the longest the company allows. Usually voicemail. */
  overflowTo: RoutingDestination;
  /**
   * Whether a caller is offered, by pressing 1, to be called back instead of
   * waiting, keeping their place. Off unless the owner turns it on, because
   * it is a promise the office then has to keep.
   */
  offerCallback?: boolean | undefined;
  /**
   * Whether a caller is told how long callers have recently waited, when
   * enough have been answered lately to say. Off unless the owner turns it on.
   */
  announceWait?: boolean | undefined;
}

export const MIN_WAIT_SECONDS = 30;
/**
 * Half an hour. A caller who has waited longer than that has hung up, and a
 * setting that suggests otherwise is a company telling itself a story.
 */
export const MAX_WAIT_SECONDS = 30 * 60;

/**
 * Twilio's own hold music, the track its documentation plays. Over plain http
 * because that is how the carrier serves it from that bucket; it is fetched
 * by the carrier, never by a browser.
 */
export const DEFAULT_HOLD_MUSIC = "http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3";

/**
 * How long a round of ringing is given before the group is rung again for a
 * caller still waiting. The group's own ring time plus a breath, so a phone
 * still ringing from the last round is not rung over the top of itself.
 */
export const RING_AGAIN_AFTER_EXTRA_SECONDS = 10;

/** The name the carrier knows the line by. One per waiting line, never shared between companies. */
export const carrierQueueName = (queueId: string): string => `ots-${queueId}`.slice(0, 64);

export function checkQueue(queue: CallQueue, directory: Directory): Check {
  const name = queue.name.trim();
  if (name === "" || name.length > 80) {
    return { ok: false, reason: "Give the waiting line a name of up to 80 characters, such as \"Service line\"." };
  }
  if (!directory.ringGroups.has(queue.ringGroupId)) {
    return { ok: false, reason: "Choose the ring group whose phones answer callers waiting in this line." };
  }
  if (!Number.isInteger(queue.maxWaitSeconds)
    || queue.maxWaitSeconds < MIN_WAIT_SECONDS || queue.maxWaitSeconds > MAX_WAIT_SECONDS) {
    return {
      ok: false,
      reason: `A caller can wait between ${MIN_WAIT_SECONDS} seconds and ${MAX_WAIT_SECONDS / 60} minutes before going to voicemail.`,
    };
  }
  if (queue.holdMusicUrl !== null) {
    let url: URL | null = null;
    try { url = new URL(queue.holdMusicUrl); } catch { url = null; }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !/\.(mp3|wav)$/i.test(url.pathname)) {
      return {
        ok: false,
        reason: "Hold music has to be the address of an MP3 or WAV file the phone company can fetch, starting with https://.",
      };
    }
  }
  const overflow = destinationProblem(queue.overflowTo, directory, "a caller who has waited too long");
  if (overflow) return { ok: false, reason: overflow };
  if (queue.overflowTo.kind === "queue" && queue.overflowTo.id === queue.id) {
    return {
      ok: false,
      reason: "A caller who has waited too long would be put back in this same line, forever. Send them to voicemail instead.",
    };
  }
  return { ok: true };
}

/** A caller's place, as they hear it. */
export function placeInLine(position: number): string {
  if (!Number.isInteger(position) || position <= 1) return "You are next in line.";
  const ahead = position - 1;
  return ahead === 1 ? "There is one caller ahead of you." : `There are ${ahead} callers ahead of you.`;
}

export interface WaitInput {
  queue: Pick<CallQueue, "maxWaitSeconds" | "announcePosition">;
  /** The caller's place, 1 at the front, as the carrier reports it. */
  position: number;
  /** How long they have waited, as the carrier reports it. */
  waitedSeconds: number;
  /** When the group was last rung for this caller, or null when it has not been. */
  rungAt: Date | null;
  /** The group's own ring time. */
  ringSeconds: number;
  now: Date;
}

export type WaitStep =
  | { kind: "leave"; why: string }
  | { kind: "hold"; say: string | null; ring: boolean };

/**
 * What to do each time the music comes round.
 *
 * The carrier asks again whenever what it was told to play has finished, so
 * the longest wait is checked here rather than by a timer: a caller is sent
 * on at the first time it is asked after their wait has run out. A long track
 * makes that later, which is why the settings screen asks for short music.
 */
export function waitStep(input: WaitInput): WaitStep {
  const waited = Number.isFinite(input.waitedSeconds) && input.waitedSeconds > 0 ? input.waitedSeconds : 0;
  if (waited >= input.queue.maxWaitSeconds) {
    return {
      kind: "leave",
      why: `Waited ${minutes(waited)} in line, which is as long as this line keeps a caller.`,
    };
  }
  const due = input.rungAt === null
    || input.now.getTime() - input.rungAt.getTime() >= (input.ringSeconds + RING_AGAIN_AFTER_EXTRA_SECONDS) * 1000;
  return {
    kind: "hold",
    say: input.queue.announcePosition ? `${placeInLine(input.position)} Thanks for waiting.` : null,
    ring: due,
  };
}

/**
 * Who to ring on this round.
 *
 * All at once: the whole group, every round, so whoever finishes their call
 * first takes the caller. One after another: the next person each round,
 * round and round, so a caller waiting a while is offered to everybody in
 * turn rather than to the first person over and over.
 */
export function ringRound(plan: RingPlan, round: number): RingStep | null {
  if (plan.steps.length === 0) return null;
  return plan.steps[((round % plan.steps.length) + plan.steps.length) % plan.steps.length]!;
}

export type QueueOutcome =
  | { kind: "answered" }
  | { kind: "moved" }
  | { kind: "overflow"; why: string }
  | { kind: "gone"; why: string };

/** How a caller left the line, from the carrier's `QueueResult`. */
export function queueOutcome(result: string | undefined, waitedSeconds: number): QueueOutcome {
  switch (result) {
    /**
     * Taken out of the line by somebody in the office (put on hold, or
     * passed to a colleague, from the browser phone). The call goes on
     * wherever they sent it, so nothing more happens here.
     */
    case "redirected":
    case "redirected-from-bridged":
      return { kind: "moved" };
    case "bridged":
      return { kind: "answered" };
    case "hangup":
      return { kind: "gone", why: `Hung up after waiting ${minutes(waitedSeconds)} in line.` };
    case "leave":
      return { kind: "overflow", why: `Waited ${minutes(waitedSeconds)} in line, which is as long as this line keeps a caller.` };
    case "queue-full":
      return { kind: "overflow", why: "The line was full." };
    default:
      return { kind: "overflow", why: "The phone company could not keep the caller in line." };
  }
}

function minutes(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} second${whole === 1 ? "" : "s"}`;
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m} minute${m === 1 ? "" : "s"}${s > 0 ? ` ${s} second${s === 1 ? "" : "s"}` : ""}`;
}

/* --------------------------------------------- skipping people on a call */

/**
 * Who to ring on this round, leaving out anybody already on a call.
 *
 * `busy` is the numbers and browser addresses of people the company knows to
 * be talking to somebody right now. A number outside the company (an
 * answering service) is never known to be busy, so it is always rung.
 *
 * All at once: the round is everybody who is free. One after another: the
 * next person in turn who is free, starting where this round would have
 * started; `index` says which, so the next round starts after them. Null when
 * everybody is busy or there is nobody to ring, with the people left out.
 */
export function freeRound(
  plan: RingPlan, round: number, busy: ReadonlySet<string>,
): { step: RingStep; index: number; skipped: string[] } | { step: null; index: null; skipped: string[] } {
  const skipped: string[] = [];
  const count = plan.steps.length;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (((round + offset) % count) + count) % count;
    const step = plan.steps[index]!;
    const numbers: string[] = [];
    const labels: string[] = [];
    step.numbers.forEach((number, i) => {
      if (busy.has(number)) skipped.push(step.labels[i] ?? number);
      else {
        numbers.push(number);
        labels.push(step.labels[i] ?? number);
      }
    });
    if (numbers.length > 0) return { step: { numbers, labels }, index, skipped: [...new Set(skipped)] };
  }
  return { step: null, index: null, skipped: [...new Set(skipped)] };
}

/* ------------------------------------------------------ the estimated wait */

/** How many answered callers there have to have been lately before a wait is estimated at all. */
export const MIN_WAITS_TO_ESTIMATE = 5;
/** The most recent answered callers an estimate is made from. */
export const ESTIMATE_FROM_LAST = 20;
/** How far back "lately" reaches. A morning's waits say nothing about the evening. */
export const ESTIMATE_WITHIN_HOURS = 3;

/**
 * How long callers have lately waited before they were answered, in seconds,
 * or null when it cannot honestly be said.
 *
 * The longer end rather than the middle: three in four of the recent callers
 * were answered within it. A caller told three minutes who waits six has been
 * lied to; one told six who waits three has had a good day. Fewer than five
 * answered callers lately is not enough to say anything, so nothing is said.
 */
export function estimateWait(waits: readonly number[]): number | null {
  const usable = waits.filter((w) => Number.isFinite(w) && w >= 0).slice(0, ESTIMATE_FROM_LAST);
  if (usable.length < MIN_WAITS_TO_ESTIMATE) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1)]!;
}

/** The estimate, as a caller hears it: whole minutes, rounded up, and never a promise about this call. */
export function estimatedWaitWords(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1
    ? "Most callers lately have been answered within about a minute."
    : `Most callers lately have been answered within about ${minutes} minutes.`;
}

/* ------------------------------------------------------- being called back */

/** Said every time the music comes round on a line that offers it. */
export const CALLBACK_OFFER = "To be called back instead of waiting, keeping your place in line, press 1.";

/**
 * How many times the caller is rung back before the office is asked to do it
 * by hand, how long after a ring nobody answered the next try waits, and how
 * long a callback is kept waiting for somebody free before it, too, becomes a
 * task for the office. An hour of ringing the office's phones is a bill and a
 * nuisance, and a caller who asked at five to six should hear from a person
 * the next morning rather than from nobody.
 */
export const CALLBACK_ATTEMPTS = 2;
export const CALLBACK_RETRY_SECONDS = 5 * 60;
export const CALLBACK_EXPIRES_SECONDS = 60 * 60;
/**
 * The least time between two rounds of ringing for one callback. A carrier
 * that refuses every call at once would otherwise be asked again as fast as
 * it can answer.
 */
export const CALLBACK_MIN_ROUND_SECONDS = 15;

/**
 * The number a caller is rung back on: the one they called from, when it is
 * one a phone can dial. A withheld number, a short code or an emergency
 * number is null, and such a caller is never offered a callback, because
 * there would be nobody to ring.
 */
export function callbackNumber(from: string | null | undefined): string | null {
  const text = (from ?? "").trim();
  if (!/^\+[1-9]\d{7,14}$/.test(text) || WITHHELD.has(text)) return null;
  return dialable(text).ok ? text : null;
}

/**
 * What Twilio puts in the caller's number when it was withheld: anonymous,
 * restricted, unknown and blocked. Each looks like a foreign number, and
 * ringing one would ring a stranger abroad on the company's bill.
 */
const WITHHELD = new Set(["+266696687", "+86282452253", "+8656696", "+2562533"]);

/** A number read out a digit at a time, in the groups people write it in. */
export function spokenNumber(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const groups = local.length === 10 ? [local.slice(0, 3), local.slice(3, 6), local.slice(6)] : [local];
  return groups.map((g) => g.split("").join(" ")).join(", ");
}

/** What a caller hears once they have asked to be called back. */
export function callbackConfirmation(e164: string): string {
  return `Thanks. We will call you back on ${spokenNumber(e164)} when it is your turn, so you can hang up now. Goodbye.`;
}

/**
 * Who is next: the caller waiting longest on the line, or the one who asked
 * to be called back, whichever joined first. A callback keeps the place its
 * caller had, so somebody who joined after them does not go ahead of them for
 * having stayed on the line.
 */
export function nextInLine(
  waitingSince: Date | null, callbackSince: Date | null,
): "caller" | "callback" | null {
  if (!waitingSince && !callbackSince) return null;
  if (!callbackSince) return "caller";
  if (!waitingSince) return "callback";
  return callbackSince.getTime() <= waitingSince.getTime() ? "callback" : "caller";
}
