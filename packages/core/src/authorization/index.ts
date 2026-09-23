import { type Money, add, subtract, zero, compare, toString as moneyToString } from "../money/index.js";

/**
 * THE CEILING
 *
 * Not-to-exceed, coverage limit, approval limit and authorisation number are
 * all the same concept: a maximum we may not bill past without a separate
 * approval event.
 *
 * It is the invariant that decides whether a contractor gets paid for
 * commercial work. A facilities network authorises five hundred dollars, the
 * technician finds more wrong, the office invoices nine hundred, and the
 * network pays five hundred and disputes the rest. The four hundred is not a
 * receivable, it is a write-off, and nobody notices until the aging report
 * has a column of them.
 *
 * So the decision is a pure function, taken at the moment of invoicing rather
 * than reconstructed afterwards, and the refusal says what to do about it.
 */

export type AuthorizationState =
  | "requested" | "granted" | "exceeded" | "denied" | "expired" | "superseded";

export interface Authorization {
  state: AuthorizationState;
  /** The ceiling. Null means authorised with no stated limit. */
  amount?: Money | null;
  /** Consumed so far, so a second invoice on the same job knows. */
  consumed: Money;
  expiresAt?: Date | null;
  externalReference?: string | null;
}

export type Decision =
  | { ok: true; remaining: Money | null }
  | {
      ok: false;
      reason: "not_granted" | "expired" | "over_ceiling";
      /** Everything the refusal needs to be actionable rather than a no. */
      detail: string;
      ceiling?: Money;
      remaining?: Money;
      requested?: Money;
      over?: Money;
    };

/** What is left to bill under this authorisation. Null means no stated limit. */
export function remaining(auth: Authorization): Money | null {
  if (!auth.amount) return null;
  return subtract(auth.amount, auth.consumed);
}

/**
 * Whether this amount may be billed under this authorisation.
 *
 * An authorisation with no ceiling is a yes, deliberately: "approved, bill
 * what it costs" is a real answer a client gives, and treating a null as zero
 * would refuse every one of them.
 */
export function decide(
  auth: Authorization | null,
  amount: Money,
  now = new Date(),
): Decision {
  /**
   * No authorisation at all is a yes. This is a ceiling, not a permission
   * system: a residential job has nobody to authorise it, and refusing
   * everything without one would make the ordinary case impossible.
   */
  if (!auth) return { ok: true, remaining: null };

  if (auth.state !== "granted") {
    return {
      ok: false,
      reason: "not_granted",
      detail: auth.state === "denied"
        ? "This work was not authorised."
        : `The authorisation is ${auth.state.replace(/_/g, " ")}, not granted.`,
    };
  }

  if (auth.expiresAt && auth.expiresAt < now) {
    return {
      ok: false,
      reason: "expired",
      detail: "The authorisation has expired. Ask for a new one before billing.",
    };
  }

  const left = remaining(auth);
  if (!left) return { ok: true, remaining: null };

  if (compare(add(auth.consumed, amount), auth.amount!) > 0) {
    const over = subtract(amount, left);
    return {
      ok: false,
      reason: "over_ceiling",
      detail: `Authorised up to ${moneyToString(auth.amount!)}`
        + (compare(auth.consumed, zero(amount.currency)) > 0
          ? `, of which ${moneyToString(auth.consumed)} is already billed`
          : "")
        + `. This would go ${moneyToString(over)} over. Ask for a supplement, `
        + `or bill ${moneyToString(left)} now.`,
      ceiling: auth.amount!,
      remaining: left,
      requested: amount,
      over,
    };
  }

  return { ok: true, remaining: subtract(left, amount) };
}

/**
 * The state an authorisation lands in once an amount is billed against it.
 *
 * `exceeded` is a real state rather than a refusal, because some networks
 * allow the overage and chase it afterwards. Recording it is what makes "how
 * often do we go over, and with whom" a question with an answer.
 */
export function stateAfter(auth: Authorization, amount: Money): AuthorizationState {
  if (!auth.amount) return "granted";
  return compare(add(auth.consumed, amount), auth.amount) > 0 ? "exceeded" : "granted";
}
