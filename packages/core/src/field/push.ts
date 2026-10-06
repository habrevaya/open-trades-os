import { inQuietHours } from "../comms/index.js";

/**
 * TELLING A TECHNICIAN THEIR DAY CHANGED
 *
 * The phone already learns about a change the next time it syncs, and that is
 * the problem: the next sync is whenever the app is next opened, and a
 * technician driving to a job the office cancelled ten minutes ago opens it in
 * the customer's driveway. A push is how the change reaches the pocket it is
 * about while it can still matter.
 *
 * The words and the urgency are decided here, without a database or a
 * network, so they are tested as sentences and as rules rather than as
 * whatever a notification happened to show on one phone.
 */

export type VisitNoticeKind = "assigned" | "unassigned" | "rescheduled" | "cancelled";

/** Which event names become a notice, and as what. */
export const NOTICE_FOR_EVENT: Readonly<Record<string, VisitNoticeKind>> = {
  "visit.assigned": "assigned",
  "visit.unassigned": "unassigned",
  "visit.rescheduled": "rescheduled",
  "visit.cancelled": "cancelled",
};

export interface VisitNoticeFacts {
  kind: VisitNoticeKind;
  jobNumber: number;
  customerName: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  /** Where it was before a move, so the notice can say both. */
  previousWindowStart?: Date | null | undefined;
  /** The company's zone. A window is a promise made in it. */
  timezone: string;
}

/**
 * The title and the line under it, as a lock screen shows them.
 *
 * The customer's name and the time, and NOT the street address. A lock screen
 * is read by whoever is holding the phone, and the name and the hour are
 * enough for the technician to know which job it is; the address is one tap
 * away inside the app, behind the phone's own lock.
 */
export function visitNotice(facts: VisitNoticeFacts): { title: string; body: string } {
  const job = `Job ${facts.jobNumber}, ${facts.customerName}`;
  const when = windowWords(facts.windowStart, facts.windowEnd, facts.timezone);

  switch (facts.kind) {
    case "assigned":
      return {
        title: "New job on your day",
        body: when ? `${job}. ${capitalise(when)}.` : `${job}. No time set yet.`,
      };
    case "unassigned":
      return {
        title: "Job taken off your day",
        body: `${job}${when ? `, ${when}` : ""}, is no longer yours. Nothing to do.`,
      };
    case "rescheduled": {
      const was = facts.previousWindowStart
        ? windowWords(facts.previousWindowStart, null, facts.timezone)
        : null;
      return {
        title: "Job moved",
        body: `${job}: now ${when ?? "with no time set"}${was ? ` (was ${was})` : ""}.`,
      };
    }
    case "cancelled":
      return {
        title: "Job cancelled",
        body: `${job}${when ? `, ${when}` : ""}, is cancelled. Do not go.`,
      };
  }
}

/**
 * "Tue Oct 6, 1:00 PM to 4:00 PM", in the company's zone.
 *
 * The same zone the phone shows the window in, for the same reason: a window
 * is a promise made to a customer at an address, and a notice that quoted a
 * different hour than the card it opens would be one of them wrong.
 */
export function windowWords(start: Date | null, end: Date | null, timezone: string): string | null {
  if (!start) return null;
  const day = start.toLocaleDateString("en-US", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric",
  });
  const time = (d: Date) => d.toLocaleTimeString("en-US", {
    timeZone: timezone, hour: "numeric", minute: "2-digit",
  });
  return end ? `${day}, ${time(start)} to ${time(end)}` : `${day}, ${time(start)}`;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * QUIET HOURS, FOR STAFF.
 *
 * The company already declares the hours it will not text a customer in
 * (`organization.settings.quietHours`, nine at night to eight in the morning
 * unless it says otherwise). A technician is not a customer and the law that
 * window answers to does not apply to them, but the courtesy does: a job moved
 * on Thursday from next Tuesday should not buzz somebody awake at eleven.
 *
 * So inside the window a notice is still SENT, and sent quietly: no sound, no
 * lighting the screen, there on the lock screen when they next pick the phone
 * up. Holding it until morning instead was the alternative, and it is worse
 * for the case that matters, because "do not go, it is cancelled" for a seven
 * o'clock job is exactly the notice that must be on the phone before seven.
 *
 * And a change to work that happens INSIDE the quiet window is never quiet. An
 * emergency call put on the on call technician's day at ten at night for
 * eleven is the one notice that has to wake them, and a quiet window that
 * swallowed it would be a reason to turn the feature off.
 */
export type PushUrgency = "normal" | "quiet";

export function pushUrgency(input: {
  /** Minutes past midnight now, in the company's zone. */
  localMinutes: number;
  now: Date;
  /** Null when the company has turned quiet hours off. */
  window: { startHour: number; endHour: number } | null;
  /** When the work starts. Null for a visit with no time yet. */
  visitStartsAt: Date | null;
}): PushUrgency {
  if (!input.window) return "normal";
  if (!inQuietHours(Math.floor(input.localMinutes / 60), input.window)) return "normal";

  const minutesLeft = ((input.window.endHour * 60 - input.localMinutes) % 1440 + 1440) % 1440;
  const quietEndsAt = input.now.getTime() + minutesLeft * 60_000;
  if (input.visitStartsAt && input.visitStartsAt.getTime() <= quietEndsAt) return "normal";
  return "quiet";
}

/**
 * The shape of an Expo push token, checked before a phone's claim to have one
 * is stored. Anything else would be sent to Expo on every change and refused
 * every time, which is noise in the log and a request per technician per
 * change that can never work.
 */
export function isExpoPushToken(value: string): boolean {
  return /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{8,200}\]$/.test(value);
}
