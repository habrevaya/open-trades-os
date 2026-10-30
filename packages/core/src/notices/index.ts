import { addDays, compareDates } from "../recurrence/index.js";
import { activeSuppression, inQuietHours, type SuppressionRecord } from "../comms/index.js";
import { dateIn, minutesInDay } from "../time/index.js";
import type { Permission } from "../access/permissions.js";

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
  "task_deadline",
  "visit_change_requested",
  "autopay_failed",
  "customer_file",
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
    description: "When a certification or a skill reaches its renewal period, and again on its last day.",
  },
  task_deadline: {
    label: "A deadline about to be missed",
    description: "A time promised to a client, or a filing, is close and nobody has dealt with it yet.",
  },
  visit_change_requested: {
    label: "A customer asking to change a visit",
    description: "A customer asked to move or cancel a visit and the office has not answered.",
  },
  autopay_failed: {
    label: "An automatic payment that failed",
    description: "A customer's saved card was charged for an invoice and the payment did not go through.",
  },
  customer_file: {
    label: "A photo or file from a customer",
    description: "A customer sent photos or a PDF to a job you are on. Once a day for each job.",
  },
};

/**
 * WHO HANDLES A KIND THE OFFICE QUEUE RAISES.
 *
 * Three kinds are not for one named person: a deadline about to be missed, a
 * customer asking to change a visit and a failed automatic payment land in
 * the office queue as a task nobody owns yet. Each goes to the people who can
 * DO something about it, which is whoever holds the permission that answers
 * it, and who may also open the record the notice is about (the task for a
 * deadline, the job for a visit change, the invoice for a failed payment).
 * Somebody who could read the record and not answer it is not told, because a
 * notice they cannot act on is the kind people switch off.
 */
export const QUEUE_KIND_HANDLER: Partial<Record<NoticeKind, Permission>> = {
  /** Satisfying or waiving a deadline is a task write. */
  task_deadline: "task:write",
  /** Approving, declining or offering another time. */
  visit_change_requested: "visit:reschedule",
  /** Charging the saved card again, or asking for another way to pay. */
  autopay_failed: "payment:charge_saved",
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

/* -------------------------------------------------- the company's defaults */

/**
 * WHAT A NEW PERSON STARTS WITH, AS THE COMPANY SETS IT.
 *
 * Until a company says otherwise a new person gets `DEFAULT_SWITCHES` for
 * every kind. A company can change that per kind (a field crew that lives on
 * the phone app, an office that wants the bell and nothing else), and what it
 * sets is COPIED onto each person as they are added, as their own switches.
 * It is never read later in place of their own: people who were here before
 * keep exactly what they had, and a change to the company's defaults reaches
 * only people added afterwards. A person changes theirs on `/me` as always.
 *
 * No default for texts, deliberately. A text goes to somebody's own mobile on
 * their own bill and only ever because they turned it on themselves, so a
 * company cannot start anybody with it.
 */
export interface NoticeDefault {
  inApp: boolean;
  push: boolean;
  /** Only for a kind that is emailed. Null for a kind that is not. */
  email: boolean | null;
}

/** The company's saved defaults over the product's, one row per kind it changed. */
export function defaultsFor(
  saved: readonly ({ kind: string; inApp: boolean; push: boolean; email: boolean | null })[],
  kind: NoticeKind,
): NoticeDefault {
  const row = saved.find((s) => s.kind === kind);
  const emailed = isEmailKind(kind);
  if (row) return { inApp: row.inApp, push: row.push, email: emailed ? row.email ?? true : null };
  return { inApp: DEFAULT_SWITCHES.inApp, push: DEFAULT_SWITCHES.push, email: emailed ? true : null };
}

/** Why a set of defaults cannot be saved, in words, or null. */
export function defaultsProblem(kinds: readonly { kind: string; email?: boolean | null | undefined }[]): string | null {
  const seen = new Set<string>();
  for (const k of kinds) {
    if (!isNoticeKind(k.kind)) return `There is no kind of notice called ${k.kind}.`;
    if (seen.has(k.kind)) return `${NOTICE_KIND_WORDS[k.kind].label} is listed twice.`;
    seen.add(k.kind);
    if (k.email && !isEmailKind(k.kind)) return `${NOTICE_KIND_WORDS[k.kind].label} does not come by email.`;
  }
  return null;
}

/* ----------------------------------------------------------------- email */

/**
 * The kinds that also come by email, to the person's address on the company's
 * own email. Only these: a kind nothing emails has no email box on `/me`, and
 * a box that did nothing would be a promise the product does not keep.
 *
 * A licence or skill running out is the first. It is the notice nobody can be
 * expected to be looking at the app for, and it is about a card that sits in a
 * wallet until a job needs it.
 */
export const EMAIL_KINDS: readonly NoticeKind[] = ["qualification_expiry"];

export const isEmailKind = (kind: NoticeKind): boolean => EMAIL_KINDS.includes(kind);

/**
 * Whether a person gets this kind by email: false for a kind that is never
 * emailed, what they chose where they chose, and on where they did not,
 * because the company's own address is the one place a notice to a person
 * costs nothing and needs no consent of theirs. They switch it off on `/me`.
 */
export function emailFor(
  saved: readonly { kind: string; email: boolean | null }[],
  kind: NoticeKind,
): boolean {
  if (!isEmailKind(kind)) return false;
  return saved.find((s) => s.kind === kind)?.email ?? true;
}

/**
 * The email for a notice: the notice's own title as the subject, its sentence,
 * and the page it opens. Plain text, so a phone, a watch and a mail scanner
 * all read the same thing, and no more than the notice itself says: the lock
 * screen and the email are the same words.
 */
export function noticeEmail(input: {
  companyName: string; title: string; body: string | null; link: string | null;
}): { subject: string; text: string } {
  const lines = [input.body?.trim() ?? "", input.link ? `Open it: ${input.link}` : "", `Sent by ${input.companyName}.`]
    .filter((line) => line !== "");
  return { subject: input.title.trim().slice(0, 200), text: lines.join("\n\n") };
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

/**
 * How many days before the last day the first notice is raised, for a record
 * that says nothing of its own. A certification's type and a skill's record
 * each carry their own renewal period, which is used instead.
 */
export const EXPIRY_NOTICE_DAYS = 30;
/** The longest renewal period a notice follows: a year, past which "soon" means nothing. */
export const MAX_EXPIRY_NOTICE_DAYS = 365;
/**
 * How many days after the last day a notice for the day is still raised. A
 * worker that was down over a long weekend still says so on Tuesday; a record
 * that ran out last spring is on the person's page and the renewals list, and
 * a notice about it now, the day this was switched on, is noise.
 */
export const EXPIRY_LATE_DAYS = 6;

/** The most people a company can name to keep the renewals list: past this, "told" has stopped meaning anything. */
export const MAX_RENEWALS_KEEPERS = 20;

export type ExpiryNotice = "soon" | "today";

/**
 * Which notice a record that runs out on `expiresOn` is owed `today`, both
 * plain dates in the company's calendar. A record is good on its last day
 * and gone from the next, as a certification is read everywhere else.
 *
 *   "soon" from `leadDays` before (the renewal period of the record's type,
 *     or the record's own) up to the day before. One notice, raised the
 *     first time the worker looks inside that window, which is that many
 *     days out unless the record was entered later than that. A licence
 *     with a six week renewal is on the person's phone six weeks out, the
 *     day it goes on the renewals list, not thirty days out.
 *   "today" on the last day, or within a few days after it for a worker
 *     that was not running on the day.
 *
 * Each is raised once per record (the service keys it), so the person hears
 * twice about one licence: when its renewal period starts and on the day. A
 * period of nothing says only the day; one past a year is read as a year.
 */
export function expiryNoticeDue(expiresOn: string, today: string, leadDays: number = EXPIRY_NOTICE_DAYS): ExpiryNotice | null {
  if (compareDates(today, expiresOn) >= 0) {
    return compareDates(today, addDays(expiresOn, EXPIRY_LATE_DAYS)) <= 0 ? "today" : null;
  }
  const lead = noticeLead(leadDays);
  if (lead === 0) return null;
  return compareDates(today, addDays(expiresOn, -lead)) >= 0 ? "soon" : null;
}

/** A renewal period as a notice reads it: whole days, from none to a year. */
export function noticeLead(leadDays: number): number {
  if (!Number.isFinite(leadDays)) return EXPIRY_NOTICE_DAYS;
  return Math.min(Math.max(Math.trunc(leadDays), 0), MAX_EXPIRY_NOTICE_DAYS);
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

/* ------------------------------------------------------- the daily digest */

/**
 * The hour a company's day starts, for a digest: when its quiet hours end,
 * which is when the company already starts texting customers, or eight in
 * the morning for a company that switched quiet hours off. Not a setting of
 * its own: a second "morning" that disagreed with the quiet hours would be
 * one more thing to get wrong.
 */
export const DIGEST_DEFAULT_HOUR = 8;

/** The most notices one digest lists; the rest are a count and the link to the bell. */
export const DIGEST_MOST = 20;

export function digestHour(quiet: { startHour: number; endHour: number } | null): number {
  return quiet ? quiet.endHour : DIGEST_DEFAULT_HOUR;
}

/**
 * Whether a person's digest is due now: not yet sent on the company's today,
 * the company's morning has come, and it is not inside its quiet hours. A
 * worker that was down at eight sends it when it is back the same day; a day
 * it never came back on is not sent late, the next morning's covers it.
 */
export function digestDue(input: {
  /** The company's today and hour now. */
  today: string;
  localHour: number;
  /** The company day the last digest was decided on, sent or not. */
  lastOn: string | null;
  quiet: { startHour: number; endHour: number } | null;
}): boolean {
  if (input.lastOn !== null && compareDates(input.lastOn, input.today) >= 0) return false;
  if (input.localHour < digestHour(input.quiet)) return false;
  return !(input.quiet && inQuietHours(input.localHour, input.quiet));
}

/**
 * The digest email: how many are waiting, then each notice as the bell shows
 * it (its kind, its title, its sentence and its page), then how to stop it.
 * Plain text, like a single notice's email, and nothing the bell does not show.
 */
export function digestEmail(input: {
  companyName: string;
  /** Every unread notice the person can still open, newest first. */
  notices: readonly { kindLabel: string; title: string; body: string | null; link: string | null }[];
  /** Where the bell is, and where the digest is switched off. */
  allLink: string | null;
  settingsLink: string | null;
}): { subject: string; text: string } {
  const count = input.notices.length;
  const listed = input.notices.slice(0, DIGEST_MOST);
  const subject = `${count} unread ${count === 1 ? "notice" : "notices"} at ${input.companyName}`.slice(0, 200);
  const blocks = listed.map((n) => [
    `${n.kindLabel}: ${n.title.trim()}`,
    n.body?.trim() ?? "",
    n.link ? `Open it: ${n.link}` : "",
  ].filter((line) => line !== "").join("\n"));
  const more = count > listed.length ? `And ${count - listed.length} more.` : "";
  const footer = [
    input.allLink ? `All your notices: ${input.allLink}` : "",
    `You get this each morning because you asked for it.${input.settingsLink ? ` Turn it off at ${input.settingsLink}` : " Turn it off on your own page."}`,
    `Sent by ${input.companyName}.`,
  ].filter((line) => line !== "").join("\n");
  return {
    subject,
    text: [`You have ${count} unread ${count === 1 ? "notice" : "notices"}.`, ...blocks, more, footer]
      .filter((part) => part !== "").join("\n\n"),
  };
}

/* ---------------------------------------------- how long read notices stay */

/** The shortest and longest a company can keep read notices, in days. Null keeps them for good. */
export const KEEP_READ_MIN_DAYS = 7;
export const KEEP_READ_MAX_DAYS = 3650;

/** What a company saved, as a number of days or null for "for good". Anything else reads as for good. */
export function keepReadDays(saved: unknown): number | null {
  return Number.isInteger(saved) && (saved as number) >= KEEP_READ_MIN_DAYS && (saved as number) <= KEEP_READ_MAX_DAYS
    ? saved as number
    : null;
}

export function keepReadProblem(days: number | null): string | null {
  if (days === null) return null;
  if (!Number.isInteger(days) || days < KEEP_READ_MIN_DAYS || days > KEEP_READ_MAX_DAYS) {
    return `Keep read notices from ${KEEP_READ_MIN_DAYS} to ${KEEP_READ_MAX_DAYS} days, or leave it empty to keep them for good.`;
  }
  return null;
}

/**
 * How long after it was raised a notice of this kind must stay, whatever the
 * company chose, because the row is also how the worker remembers it told
 * somebody. A licence notice is looked for again on every pass until its
 * card is a few days past its date, which can be a year and a few days after
 * the notice; a talk's nudge for a week. Removing either sooner would raise
 * it again. Every other kind is raised by something that happened once, and
 * goes on the company's own clock.
 */
export function raisedAgainWithinDays(kind: string): number {
  if (kind === "qualification_expiry") return MAX_EXPIRY_NOTICE_DAYS + EXPIRY_LATE_DAYS + 2;
  if (kind === "talk_unsigned") return TALK_NUDGE_WITHIN_DAYS + 2;
  /** Keyed on the job and the company's day, so one removed after that day cannot be raised again by it. */
  if (kind === "customer_file") return 2;
  return 0;
}

/**
 * Whether a notice may be removed now under a company keeping read ones
 * `keepDays`. Never an unread one on the bell. One the person switched off in
 * the app was never going to be read there, so it counts as read from the
 * moment it was raised.
 */
export function sweepable(
  notice: { kind: string; createdAt: Date; readAt: Date | null; inApp?: boolean | undefined },
  keepDays: number | null, now: Date,
): boolean {
  const readAt = notice.readAt ?? (notice.inApp === false ? notice.createdAt : null);
  if (keepDays === null || readAt === null) return false;
  const day = 86_400_000;
  if (now.getTime() - readAt.getTime() < keepDays * day) return false;
  return now.getTime() - notice.createdAt.getTime() >= raisedAgainWithinDays(notice.kind) * day;
}

/* ---------------------------------------------------------------- on call */

/**
 * WHO IS ON CALL FOR THE OFFICE QUEUE'S NOTICES.
 *
 * The three kinds the office queue raises (a deadline about to be missed, a
 * customer asking to change a visit, an automatic payment that failed) tell
 * everybody who holds the permission that answers them. A company with six
 * people in the office tells six, at night as well. A company can instead keep
 * an on call rota (a person and the days they cover) and switch any of these
 * three kinds to it, one by one. Off for every kind until the company switches
 * one on.
 *
 * NEVER NOBODY. When a kind goes to the rota and nobody on it today can be told
 * (nobody is on call, or the person on call cannot answer it or open the
 * record), it goes to everybody who could, as before. A rota with a gap in it
 * must not be how a failed payment goes unheard.
 */
export const ON_CALL_KINDS = ["task_deadline", "visit_change_requested", "autopay_failed"] as const;
export type OnCallKind = typeof ON_CALL_KINDS[number];

export const isOnCallKind = (value: string): value is OnCallKind =>
  (ON_CALL_KINDS as readonly string[]).includes(value);

/** The kinds a company sends to its rota, from what it saved. Anything that is not one of the three is ignored. */
export function onCallKinds(saved: unknown): OnCallKind[] {
  const kinds = (saved as { kinds?: unknown } | null | undefined)?.kinds;
  if (!Array.isArray(kinds)) return [];
  return ON_CALL_KINDS.filter((kind) => kinds.includes(kind));
}

/** The longest one turn on the rota can be, in days. A year, so a typo of a year is caught. */
export const ON_CALL_MOST_DAYS = 366;

/** Why a turn on the rota cannot be added, in words, or null. Dates are company days, YYYY-MM-DD. */
export function onCallShiftProblem(input: { startsOn: string; endsOn: string; today: string }): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(input.startsOn) || !iso.test(input.endsOn)) return "Give the first and last day as dates.";
  if (compareDates(input.endsOn, input.startsOn) < 0) return "The last day is before the first day.";
  if (compareDates(input.endsOn, input.today) < 0) return "That turn is over already. Give days from today on.";
  if (compareDates(addDays(input.startsOn, ON_CALL_MOST_DAYS), input.endsOn) <= 0) {
    return `One turn can be at most ${ON_CALL_MOST_DAYS} days. Add a longer stretch as two turns.`;
  }
  return null;
}

/** The people on call on a company day: every turn that covers it. Two turns on one day are two people on call. */
export function onCallOn(
  shifts: readonly { userId: string; startsOn: string; endsOn: string }[], day: string,
): string[] {
  const out: string[] = [];
  for (const s of shifts) {
    if (compareDates(s.startsOn, day) <= 0 && compareDates(day, s.endsOn) <= 0 && !out.includes(s.userId)) out.push(s.userId);
  }
  return out;
}

/**
 * Who a queue notice goes to: the people on call today where the company sends
 * this kind to its rota and somebody is on it, otherwise everybody who handles
 * it. The caller still holds each person to the permission and to opening the
 * record, and falls back to everybody when nobody on call could be told.
 */
export function onCallAudience(input: {
  kind: NoticeKind; routed: readonly OnCallKind[]; onCallToday: readonly string[];
}): { to: "on_call"; userIds: string[] } | { to: "everyone" } {
  if (!isOnCallKind(input.kind) || !input.routed.includes(input.kind)) return { to: "everyone" };
  if (input.onCallToday.length === 0) return { to: "everyone" };
  return { to: "on_call", userIds: [...input.onCallToday] };
}
