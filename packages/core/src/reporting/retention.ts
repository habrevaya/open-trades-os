/**
 * RETENTION, RENEWAL AND CHURN, AS PURE RULES
 *
 * Four trade packs ask the same question four ways: of the customers on a
 * plan, how many stayed. Every one of the four definitions EXCLUDES the
 * customer who moved or sold the home, because that is not churn the owner
 * can do anything about, and a figure that counts it moves with the local
 * property market rather than with the service. The SQL in
 * `services/kpi-catalogue.ts` counts thousands of agreements; what each
 * figure MEANS is decided here, and the integration test puts the same
 * agreements through both and requires the same answer.
 *
 * WHAT SAYS A HOME WAS LEFT. Either the cancellation said so, with the coded
 * reason `moved` or `sold`, or the customer's link to the agreement's address
 * was ended (`customer_property.ended_on`) after the agreement started and by
 * the end of the window. The second is what catches a plan that simply lapsed
 * because the house was sold, which no cancellation ever recorded.
 *
 * WHAT IS UNKNOWN. A cancellation made before the reason was coded has only
 * free text, which is never read for a reason: "sold" might be the house or a
 * competitor's pitch. Such a loss is counted as the definition counts any
 * loss, and the figure says how many of them there are, rather than guessing
 * which way they went.
 *
 * WHEN AN AGREEMENT RUNS. From the day it started, until the day it was
 * cancelled (not running that day), or, for one that lapsed, until its end
 * date, which is the first day without cover. A pending agreement has not
 * started. One that is still active past its end date is awaiting the
 * worker's renewal and is running.
 */

export type CancellationCode = "moved" | "sold" | "price" | "service" | "switched" | "not_needed" | "other";

export interface AgreementFacts {
  id: string;
  customerId: string;
  propertyId: string | null;
  status: string;
  startedOn: string;
  /** The current term's end: the first day without cover. */
  endsOn: string | null;
  cancelledOn: string | null;
  cancellationCode: CancellationCode | null;
  renewalCount: number;
}

export interface TermFacts {
  agreementId: string;
  term: number;
  /** The first day without this term's cover. */
  endsOn: string;
}

export interface LinkFacts {
  customerId: string;
  propertyId: string;
  endedOn: string | null;
}

/** Whether an agreement was running on a day. */
export function runningOn(a: AgreementFacts, day: string): boolean {
  if (a.status === "pending" || a.startedOn > day) return false;
  if (a.cancelledOn !== null && a.cancelledOn <= day) return false;
  if ((a.status === "lapsed" || a.status === "completed") && a.endsOn !== null && a.endsOn <= day) return false;
  return true;
}

/** Whether an agreement ended because the home was left: said on the cancellation, or the link to the address ended. */
export function leftTheHome(a: AgreementFacts, links: readonly LinkFacts[], through: string): boolean {
  if (a.cancellationCode === "moved" || a.cancellationCode === "sold") return true;
  if (!a.propertyId) return false;
  return links.some((l) => l.customerId === a.customerId && l.propertyId === a.propertyId
    && l.endedOn !== null && l.endedOn >= a.startedOn && l.endedOn <= through);
}

/** A cancellation made before the reason was coded. */
export const reasonUnknown = (a: AgreementFacts): boolean => a.status === "cancelled" && a.cancellationCode === null;

export interface Outcome {
  numerator: string[];
  denominator: string[];
  /** Left out because the home was left, and counted here so the exclusion can be checked. */
  excluded: string[];
  /** Lost for a reason nobody coded, and counted in the figure as any loss is. */
  unknown: string[];
}

const sorted = (ids: Iterable<string>) => [...ids].sort();

/**
 * RECURRING CUSTOMER RETENTION (cleaning): accounts on a plan at the start of
 * the window still on one at the end, over accounts on a plan at the start,
 * leaving out of both the accounts lost because the home was left. An account
 * is a customer: one on two plans who keeps either is kept.
 */
export function retention(input: {
  agreements: readonly AgreementFacts[]; links: readonly LinkFacts[]; from: string; to: string;
}): Outcome {
  const atStart = new Map<string, AgreementFacts[]>();
  for (const a of input.agreements) {
    if (!runningOn(a, input.from)) continue;
    atStart.set(a.customerId, [...(atStart.get(a.customerId) ?? []), a]);
  }
  const out: Outcome = { numerator: [], denominator: [], excluded: [], unknown: [] };
  for (const [customerId, held] of atStart) {
    const kept = input.agreements.some((a) => a.customerId === customerId && runningOn(a, input.to));
    if (kept) {
      out.numerator.push(customerId);
      out.denominator.push(customerId);
      continue;
    }
    if (held.some((a) => leftTheHome(a, input.links, input.to))) {
      out.excluded.push(customerId);
      continue;
    }
    out.denominator.push(customerId);
    if (held.some(reasonUnknown)) out.unknown.push(customerId);
  }
  return { numerator: sorted(out.numerator), denominator: sorted(out.denominator), excluded: sorted(out.excluded), unknown: sorted(out.unknown) };
}

/**
 * PROGRAMME RENEWAL (pest's `renewal_rate`, lawn's `programme_renewal`):
 * terms renewed over terms that reached their end in the window, leaving out
 * of both a term not renewed because the home was left.
 *
 * A term reaches its end on its end date, by today, on an agreement that was
 * not cancelled before it: one cancelled half way through never reached the
 * end of its term, and is churn, not a renewal decision. It was renewed when
 * the agreement went on to a later term. Each is keyed `agreement:term`.
 */
export function renewals(input: {
  agreements: readonly AgreementFacts[]; terms: readonly TermFacts[]; links: readonly LinkFacts[];
  from: string; to: string; today: string;
}): Outcome {
  const byId = new Map(input.agreements.map((a) => [a.id, a]));
  /** Recorded terms, and the current term of an agreement whose term was never written down. */
  const terms = [...input.terms];
  for (const a of input.agreements) {
    if (a.endsOn === null) continue;
    const current = a.renewalCount + 1;
    if (!terms.some((t) => t.agreementId === a.id && t.term === current)) {
      terms.push({ agreementId: a.id, term: current, endsOn: a.endsOn });
    }
  }
  const out: Outcome = { numerator: [], denominator: [], excluded: [], unknown: [] };
  for (const t of terms) {
    const a = byId.get(t.agreementId);
    if (!a || a.status === "pending") continue;
    if (t.endsOn < input.from || t.endsOn > input.to || t.endsOn > input.today) continue;
    if (a.cancelledOn !== null && a.cancelledOn < t.endsOn) continue;
    const key = `${a.id}:${t.term}`;
    if (a.renewalCount >= t.term) {
      out.numerator.push(key);
      out.denominator.push(key);
      continue;
    }
    if (leftTheHome(a, input.links, input.to)) {
      out.excluded.push(key);
      continue;
    }
    out.denominator.push(key);
    if (reasonUnknown(a)) out.unknown.push(key);
  }
  return { numerator: sorted(out.numerator), denominator: sorted(out.denominator), excluded: sorted(out.excluded), unknown: sorted(out.unknown) };
}

/**
 * MONTHLY SUBSCRIPTION CHURN (trash bins): subscriptions on at the start of
 * the window and lost by its end, leaving out the ones lost because the home
 * was left, over every subscription on at the start. The definition's
 * denominator is the plain count at the start, so the exclusion is taken off
 * the losses only; the ones taken off are counted beside it.
 */
export function churn(input: {
  agreements: readonly AgreementFacts[]; links: readonly LinkFacts[]; from: string; to: string;
}): Outcome {
  const out: Outcome = { numerator: [], denominator: [], excluded: [], unknown: [] };
  for (const a of input.agreements) {
    if (!runningOn(a, input.from)) continue;
    out.denominator.push(a.id);
    if (runningOn(a, input.to)) continue;
    if (leftTheHome(a, input.links, input.to)) {
      out.excluded.push(a.id);
      continue;
    }
    out.numerator.push(a.id);
    if (reasonUnknown(a)) out.unknown.push(a.id);
  }
  return { numerator: sorted(out.numerator), denominator: sorted(out.denominator), excluded: sorted(out.excluded), unknown: sorted(out.unknown) };
}
