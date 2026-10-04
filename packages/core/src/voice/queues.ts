import type { RoutingDestination } from "../telephony/index.js";
import { destinationProblem, type Check, type Directory, type RingPlan, type RingStep } from "./menus.js";

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
  | { kind: "overflow"; why: string }
  | { kind: "gone"; why: string };

/** How a caller left the line, from the carrier's `QueueResult`. */
export function queueOutcome(result: string | undefined, waitedSeconds: number): QueueOutcome {
  switch (result) {
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
