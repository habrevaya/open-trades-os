import { addDays, compareDates } from "../recurrence/index.js";
import { activeSuppression, inQuietHours, type SuppressionRecord } from "../comms/index.js";
import { dateIn, minutesInDay } from "../time/index.js";

/**
 * TELLING THE COMPANY'S OWN PEOPLE
 *
 * The product told staff things by email or not at all: an approver found an
 * order waiting by opening Purchasing, a technician found out their expense was
 * refused by looking, and a licence ran out on the day a dispatcher tried to
 * send somebody to a job that needed it. A notice is one sentence about one
 * record, for one person, through the places they choose: the bell in the app,
 * the phone app, and a text to their own mobile.
 *
 * The rules here are the ones the worker, the API and the screens must agree
 * on, kept pure so they are tested without a database or a clock:
 *
 *   Which kinds of notice there are, and what each one is switched to until
 *     the person changes it.
 *   Whether a text to a member of staff may go now, wait for the morning, or
 *     not go at all.
 *   When a certification or a skill running out is news.
 *   When an unsigned toolbox talk is worth a nudge.
 */

/* ------------------------------------------------------------------ kinds */

/**
 * What sends a notice. One switch per kind per channel per person, so a
 * technician who wants their expense decisions by text and nothing else can
 * have exactly that.
 */
export const NOTICE_KINDS = [
  "task_assigned",
  "task_escalated",
  "po_approval",
  "app_request",
  "talk_unsigned",
  "expense_decided",
  "qualification_expiry",
] as const;
export type NoticeKind = typeof NOTICE_KINDS[number];

export const isNoticeKind = (value: string): value is NoticeKind =>
  (NOTICE_KINDS as readonly string[]).includes(value);

/** The words on `/me` and in the bell. Plain, because a trades owner reads them, not a developer. */
export const NOTICE_KIND_WORDS: Record<NoticeKind, { label: string; description: string }> = {
  task_assigned: {
    label: "A task given to you",
    description: "Somebody, a rule or an automation put a task in your name.",
  },
  task_escalated: {
    label: "A late task",
    description: "A task is past its due time and a rule says you should know.",
  },
  po_approval: {
    label: "An order waiting for your approval",
    description: "A purchase order needs your yes before it goes to the vendor.",
  },
  app_request: {
    label: "An app asking to connect",
    description: "Another piece of software asked to connect to the company and waits for a yes.",
  },
  talk_unsigned: {
    label: "A toolbox talk to sign",
    description: "A talk you were on was held and your line is not signed.",
  },
  expense_decided: {
    label: "Your expense answered",
    description: "The office approved or refused something you paid for.",
  },
  qualification_expiry: {
    label: "A licence or skill running out",
    description: "Thirty days before a certification or a skill runs out, and on the day.",
  },
};

export interface NoticeSwitches {
  inApp: boolean;
  push: boolean;
  text: boolean;
}

/**
 * What a person gets before they have changed anything.
 *
 * In the app and on the phone, because those are the company's own channels
 * and cost nothing. Never a text: a text goes to the person's own mobile, on
 * their own bill and at their own dinner table, so it is only ever something
 * they turned on themselves (see `textDecision`).
 */
export const DEFAULT_SWITCHES: NoticeSwitches = { inApp: true, push: true, text: false };

/** A person's saved switches over the defaults, one row per kind they changed. */
export function switchesFor(
  saved: readonly ({ kind: string } & NoticeSwitches)[],
  kind: NoticeKind,
): NoticeSwitches {
  const row = saved.find((s) => s.kind === kind);
  return row ? { inApp: row.inApp, push: row.push, text: row.text } : { ...DEFAULT_SWITCHES };
}

/* ------------------------------------------------------------------ texts */

/**
 * A member of staff's own say so for texts, kept apart from customers' consent.
 *
 * SEPARATE ON PURPOSE. A customer's consent is about the company texting a
 * customer about their work; this is a person at the company asking to be
 * texted about their own. A technician who is also a customer at their own
 * address has given one and not the other, and neither may stand in for the
 * other in either direction.
 */
export interface StaffTextConsent {
  state: "granted" | "revoked";
  /** The number they gave, in E.164. */
  address: string;
}

export type TextRefusal = "suppressed" | "no_consent" | "channel_not_registered" | "number_changed";

export type TextDecision =
  | { action: "send" }
  /** Inside the company's quiet hours: kept, and sent when they end. */
  | { action: "hold"; until: Date }
  | { action: "refuse"; reason: TextRefusal };

/**
 * May this text go to this member of staff now.
 *
 * Asked when the text is SENT, not when the notice is raised, because a person
 * can turn texts off, reply STOP or change their number in between, and a text
 * held overnight for quiet hours must be asked again in the morning.
 *
 *   A STOP from that number wins over everything, as it does for a customer:
 *   the carrier has already stopped delivering, and their own switch on `/me`
 *   does not overrule what they told the carrier.
 *
 *   No consent of their own, or consent they withdrew, is no. Nothing is
 *   implied for staff, unlike a customer's appointment texts: the person
 *   turned this on or it does not happen.
 *
 *   A text raised for one number does not go to another. A person who changed
 *   their number gets the next notice at the new one.
 *
 *   No registered number to send from is a settings problem, said in words.
 *
 *   Quiet hours HOLD rather than refuse. A notice about a licence running out
 *   is still worth reading at eight in the morning, and losing it because it
 *   was raised at eleven at night would make the switch unreliable.
 */
export function textDecision(input: {
  consent: StaffTextConsent | null;
  /** The number the text was raised for. */
  address: string;
  suppressions: readonly SuppressionRecord[];
  channelRegistered: boolean;
  /** Null when the company has turned quiet hours off. */
  quietHours: { startHour: number; endHour: number } | null;
  /** Minutes past midnight now, in the company's zone. */
  localMinutes: number;
  now: Date;
}): TextDecision {
  if (activeSuppression(input.suppressions, "sms", "transactional")) return { action: "refuse", reason: "suppressed" };
  if (!input.consent || input.consent.state !== "granted") return { action: "refuse", reason: "no_consent" };
  if (input.consent.address !== input.address) return { action: "refuse", reason: "number_changed" };
  if (!input.channelRegistered) return { action: "refuse", reason: "channel_not_registered" };
  if (input.quietHours && inQuietHours(Math.floor(input.localMinutes / 60), input.quietHours)) {
    return { action: "hold", until: quietEndsAt(input.now, input.localMinutes, input.quietHours) };
  }
  return { action: "send" };
}

/** Why a text to a member of staff did not go, in words the office and the person can act on. */
export function textRefusalWords(reason: TextRefusal): string {
  switch (reason) {
    case "suppressed": return "They replied STOP to the company's number, so no text can go to it until they text START.";
    case "no_consent": return "They have not turned on texts on their own page, or they turned them off.";
    case "number_changed": return "They changed the number texts go to after this was raised, so it was not sent to the old one.";
    case "channel_not_registered": return "The company has no registered number that can send texts.";
    default: {
      const unwritten: never = reason;
      return `Not sent: ${String(unwritten)}`;
    }
  }
}

/**
 * When the quiet window that `localMinutes` is inside ends, as an instant.
 *
 * Counted forward in minutes from now rather than built from a calendar day,
 * so a window that wraps midnight (nine at night to eight in the morning) ends
 * at the next eight, whichever side of midnight now is.
 */
export function quietEndsAt(now: Date, localMinutes: number, window: { endHour: number }): Date {
  const minutesLeft = ((window.endHour * 60 - localMinutes) % 1440 + 1440) % 1440;
  return new Date(now.getTime() + minutesLeft * 60_000);
}

/**
 * An instant as the company reads it, for the words of a notice: "2026-10-06
 * at 14:30". In the company's zone, because a text saying a task is due at
 * 19:30 UTC is a riddle to somebody in Austin.
 */
export function localWhen(instant: Date, timeZone: string): string {
  const minutes = minutesInDay(instant, timeZone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${dateIn(instant, timeZone)} at ${hh}:${mm}`;
}

/* ------------------------------------------------------- running out */

/** How many days before the last day the first notice is raised. */
export const EXPIRY_NOTICE_DAYS = 30;
/**
 * How many days after the last day a notice for the day is still raised. A
 * worker that was down over a long weekend still says so on Tuesday; a record
 * that ran out last spring is on the person's page and the renewals list, and
 * a notice about it now, the day this was switched on, is noise.
 */
export const EXPIRY_LATE_DAYS = 6;

export type ExpiryNotice = "soon" | "today";

/**
 * Which notice a record that runs out on `expiresOn` is owed `today`, both
 * plain dates in the company's calendar. A record is good on its last day
 * and gone from the next, as a certification is read everywhere else.
 *
 *   "soon" from thirty days before up to the day before. One notice, raised
 *     the first time the worker looks inside that window, which is thirty
 *     days out unless the record was entered later than that.
 *   "today" on the last day, or within a few days after it for a worker
 *     that was not running on the day.
 *
 * Each is raised once per record (the service keys it), so the person hears
 * twice about one licence: a month ahead and on the day.
 */
export function expiryNoticeDue(expiresOn: string, today: string): ExpiryNotice | null {
  if (compareDates(today, expiresOn) >= 0) {
    return compareDates(today, addDays(expiresOn, EXPIRY_LATE_DAYS)) <= 0 ? "today" : null;
  }
  return compareDates(today, addDays(expiresOn, -EXPIRY_NOTICE_DAYS)) >= 0 ? "soon" : null;
}

/** Whole days from `today` to `expiresOn`, both plain dates. */
export function daysUntil(expiresOn: string, today: string): number {
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(+expiresOn.slice(0, 4), +expiresOn.slice(5, 7) - 1, +expiresOn.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** The sentence for one: "runs out in 12 days, on 2026-11-02", or "runs out today". */
export function expirySentence(what: string, expiresOn: string, today: string): string {
  const days = daysUntil(expiresOn, today);
  if (days > 1) return `${what} runs out in ${days} days, on ${expiresOn}.`;
  if (days === 1) return `${what} runs out tomorrow, ${expiresOn}.`;
  if (days === 0) return `${what} runs out today.`;
  return `${what} ran out on ${expiresOn}.`;
}

/* -------------------------------------------------------- toolbox talks */

/**
 * How long after a talk is held an unsigned line is worth a nudge. Not the
 * moment it starts, because people sign at the end of the talk, and a phone
 * buzzing "you have not signed" while the foreman is still talking teaches
 * everybody to ignore it.
 */
export const TALK_NUDGE_AFTER_MINUTES = 60;
/** A talk held longer ago than this is the office's to chase, not news. */
export const TALK_NUDGE_WITHIN_DAYS = 7;

/** Whether an unsigned line on a talk held at `heldAt` is owed a nudge `now`. */
export function talkNudgeDue(heldAt: Date, now: Date): boolean {
  const age = now.getTime() - heldAt.getTime();
  return age >= TALK_NUDGE_AFTER_MINUTES * 60_000 && age <= TALK_NUDGE_WITHIN_DAYS * 86_400_000;
}
