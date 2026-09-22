/**
 * MAY WE SEND THIS
 *
 * The one question every outbound message has to answer, and the place these
 * systems actually go wrong.
 *
 * The common implementation is a boolean on the customer. It cannot express
 * the most ordinary thing a customer says, which is "text me when you're on
 * the way, but stop sending me offers", and the cost of getting it wrong is
 * not a bad review. It is a sending number the carriers block, which takes
 * the arrival notices down with it.
 *
 * So the decision is a function of three things and it is pure, which means
 * it can be exhaustively tested without a database, a provider or a clock.
 */

export type Channel = "sms" | "mms" | "voice" | "email" | "webchat";
export type Purpose = "transactional" | "marketing";
export type ConsentState = "granted" | "revoked" | "pending";

export interface ConsentRecord {
  channel: Channel;
  purpose: Purpose;
  state: ConsentState;
  capturedAt: Date;
  supersededAt?: Date | null;
}

export interface SuppressionRecord {
  channel: Channel;
  /** Null means every purpose, which is what a STOP reply means. */
  purpose?: Purpose | null;
  liftedAt?: Date | null;
}

export type SendDecision =
  | { allowed: true; consent: ConsentRecord | null; reason: "consented" | "transactional_implied" }
  | { allowed: false; reason: SendRefusal };

export type SendRefusal =
  | "suppressed"
  | "consent_revoked"
  | "no_consent"
  | "channel_not_registered"
  | "quiet_hours";

export interface SendRequest {
  channel: Channel;
  purpose: Purpose;
  /** Live consent rows for this address and channel. Superseded ones included. */
  consents: readonly ConsentRecord[];
  suppressions: readonly SuppressionRecord[];
  /**
   * Whether the sending identity is cleared to send on this channel at all.
   * For SMS in the US that means a registered brand and campaign, and an
   * unregistered send is not merely rejected, it counts against the sender.
   */
  channelRegistered: boolean;
  /**
   * The recipient's local hour, 0 to 23, when it is known.
   *
   * Passed in rather than computed, because the correct zone is the
   * RECIPIENT's and only the caller knows it. A system that uses the server's
   * hour texts somebody at 6am the first time a company sells across a time
   * zone line.
   */
  localHour?: number | undefined;
  quietHours?: { startHour: number; endHour: number } | undefined;
}

/**
 * The current consent for a purpose: the most recent row that has not been
 * superseded.
 *
 * Most recent by capture time rather than insert order, because an import
 * backfills old consent after new consent already exists, and "last row
 * written" would let a 2019 paper form overrule last week's opt out.
 */
export function currentConsent(
  consents: readonly ConsentRecord[],
  channel: Channel,
  purpose: Purpose,
): ConsentRecord | null {
  const live = consents
    .filter((c) => c.channel === channel && c.purpose === purpose && !c.supersededAt)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  return live[0] ?? null;
}

/** A suppression that covers this channel and purpose and has not been lifted. */
export function activeSuppression(
  suppressions: readonly SuppressionRecord[],
  channel: Channel,
  purpose: Purpose,
): SuppressionRecord | null {
  return suppressions.find(
    (s) => s.channel === channel && !s.liftedAt &&
      // A null purpose is a blanket stop and covers everything.
      (s.purpose === null || s.purpose === undefined || s.purpose === purpose),
  ) ?? null;
}

export function inQuietHours(hour: number, window: { startHour: number; endHour: number }): boolean {
  const { startHour, endHour } = window;
  // A window that wraps midnight, which every real quiet hours window does.
  return startHour <= endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

export function canSend(request: SendRequest): SendDecision {
  const { channel, purpose } = request;

  /**
   * Suppression first, before anything else can override it. A STOP reply is
   * not a preference to be weighed against a consent row; the carrier has
   * already stopped delivering, and a system that keeps trying is a system
   * generating failures against its own sending reputation.
   */
  if (activeSuppression(request.suppressions, channel, purpose)) {
    return { allowed: false, reason: "suppressed" };
  }

  if (!request.channelRegistered) {
    return { allowed: false, reason: "channel_not_registered" };
  }

  const consent = currentConsent(request.consents, channel, purpose);

  /**
   * An explicit revocation beats everything below, including the implied
   * consent that transactional messages otherwise enjoy. Somebody who said
   * "stop texting me about my appointments" meant it.
   */
  if (consent?.state === "revoked") {
    return { allowed: false, reason: "consent_revoked" };
  }

  if (purpose === "marketing") {
    // Marketing needs a granted row. Nothing is implied, ever.
    if (consent?.state !== "granted") {
      return { allowed: false, reason: "no_consent" };
    }
    /**
     * Quiet hours apply to marketing only. An arrival notice at 7am is the
     * message the customer is waiting for; a promotion at 7am is the one that
     * gets a number reported.
     */
    if (request.quietHours && request.localHour !== undefined &&
        inQuietHours(request.localHour, request.quietHours)) {
      return { allowed: false, reason: "quiet_hours" };
    }
    return { allowed: true, consent, reason: "consented" };
  }

  /**
   * Transactional messages about work the customer asked for are implied by
   * the transaction itself, so a missing consent row does not block "your
   * technician is on the way". This is the one place the system proceeds
   * without an explicit grant, and it is bounded: explicit revocation and
   * suppression both still stop it, and the message is recorded with no
   * consent id, which is exactly what an audit needs to be able to find.
   */
  return {
    allowed: true,
    consent,
    reason: consent?.state === "granted" ? "consented" : "transactional_implied",
  };
}

/**
 * The replies a messaging system must honour itself rather than leaving to
 * the carrier.
 *
 * Carriers intercept these on most routes, but not all, and not for every
 * number type. Honouring them locally means the record agrees with reality
 * even when the interception does not happen.
 */
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt-out"]);
const START_WORDS = new Set(["start", "unstop", "yes", "optin", "opt-in"]);
const HELP_WORDS = new Set(["help", "info"]);

export type InboundIntent = "stop" | "start" | "help" | "message";

/**
 * Case and punctuation are stripped because people type "Stop." and "STOP!",
 * and a system that only matches the bare uppercase word keeps texting
 * somebody who has plainly asked it not to.
 */
export function inboundIntent(body: string): InboundIntent {
  const word = body.trim().toLowerCase().replace(/[^a-z-]/g, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (HELP_WORDS.has(word)) return "help";
  return "message";
}
