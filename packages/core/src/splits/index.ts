import {
  type Money, money, add, subtract, multiply, compare, isNegative, isPositive, isZero, zero, allocate, sum, abs,
  toString as moneyToString, round, edit,
} from "../money/index.js";

/** An amount as a person reads it on an invoice: 300.00, not 300.0000. */
const cents = (value: Money): string => edit(round(value, 2));
import { type ChargeKind, type Entitlement, split as coverageSplit } from "../coverage/index.js";

/**
 * ONE JOB, TWO PAYERS, AND THE CENT THAT HAS TO GO SOMEWHERE
 *
 * A home warranty job is billed twice: the warranty company pays the repair
 * less the deductible, and the homeowner pays the deductible and anything the
 * warranty does not cover. A property owner and a tenant split a repair
 * seventy thirty. Either way the two invoices have to add up to exactly what
 * the work was priced at, to the cent, because the first thing anybody does
 * with a split job is add the two invoices together and compare.
 *
 * So the split is done once, here, as arithmetic on the priced lines, and
 * both invoices are cut from the same answer. Two invoices computed
 * separately and then compared is how a cent appears on neither or on both.
 *
 * LINE BY LINE, NOT A LUMP. Each payer's invoice carries the lines they are
 * paying for, so a warranty administrator sees the repair they authorised
 * and a homeowner sees the deductible and the part the plan does not cover.
 * A line two payers share appears on both, each with their part of it and a
 * sentence saying what the other part is, which is what anybody reading
 * either invoice needs to agree it.
 */

export interface SplitLine {
  /** The line's total before tax, as priced. */
  amount: Money;
  /** What it is for coverage: only some kinds are ever a third party's. */
  kind: ChargeKind;
}

/**
 * Cut each line into one part per payer, so that every payer gets exactly
 * their target and every line is exactly used up.
 *
 * Payers are filled in the order given, each spread across the lines it may
 * pay for in proportion to what is left of them, and the LAST payer takes
 * whatever remains. That last step is what makes both directions exact: each
 * earlier payer's parts are allocated to the cent from their target, and the
 * remainder of every line is by construction what is left.
 *
 * `eligible[p][i]` says whether payer p may pay any of line i. A warranty
 * company may only pay for the kinds its coverage covers; the homeowner, who
 * comes last, may pay for anything.
 */
export function allocateAcross(
  lines: readonly Money[],
  targets: readonly Money[],
  eligible?: readonly (readonly boolean[])[],
): Money[][] {
  if (targets.length === 0) throw new RangeError("A split needs somebody to pay.");
  const currency = lines[0]?.currency ?? targets[0]!.currency;
  const remaining = lines.map((line) => line);
  const parts: Money[][] = targets.map(() => lines.map(() => zero(currency)));

  for (const [p, target] of targets.entries()) {
    const last = p === targets.length - 1;
    if (last) {
      for (const [i, left] of remaining.entries()) parts[p]![i] = left;
      continue;
    }
    if (isZero(target)) continue;
    const may = lines.map((_, i) => eligible?.[p]?.[i] ?? true);
    const weights = remaining.map((left, i) => (may[i] && isPositive(left) ? moneyToString(left) : "0"));
    const available = sum(remaining.filter((_, i) => may[i] && isPositive(remaining[i]!)), currency);
    if (compare(target, available) > 0) {
      throw new RangeError(
        `Payer ${p + 1} is to pay ${cents(target)} and only ${cents(available)} of the work is theirs to pay.`,
      );
    }
    if (isZero(available)) continue;
    const shares = allocate(target, weights, 2);
    for (const [i, share] of shares.entries()) {
      parts[p]![i] = share;
      remaining[i] = subtract(remaining[i]!, share);
    }
  }
  return parts;
}

/* ------------------------------------------------------ by coverage */

export interface CoverageTargets {
  /** What the third party pays: the covered work, after percentage, cap and deductible. */
  thirdParty: Money;
  /** What the customer pays: the deductible and everything not covered. */
  customer: Money;
  /** Which lines the third party may pay any of. */
  eligible: boolean[];
}

const covers = (terms: Entitlement, kind: ChargeKind): boolean => {
  switch (kind) {
    case "labour": return terms.coversLabour;
    case "parts": return terms.coversParts;
    case "trip": return terms.coversTrip;
    case "other": return false;
  }
};

/**
 * The two targets for a job split by its coverage.
 *
 * Read straight from `coverage.split`, which already applies the percentage,
 * the cap and the deductible in the right order and once per visit. This
 * function only says which lines the third party's part may come out of.
 */
export function coverageTargets(terms: Entitlement, lines: readonly SplitLine[]): CoverageTargets {
  const result = coverageSplit(terms, lines.map((l) => ({ kind: l.kind, amount: l.amount })));
  return {
    thirdParty: result.covered,
    customer: result.customer,
    eligible: lines.map((l) => covers(terms, l.kind)),
  };
}

/* ---------------------------------------------------------- by share */

export interface Share {
  /** A fraction of the job: 0.7 is seventy per cent. */
  percent?: string | null;
  /** A fixed amount: "the tenant pays the first 150". */
  amount?: Money | null;
}

/**
 * Targets for payers sharing a job by stated shares.
 *
 * Fixed amounts are taken first and percentages are of the whole job,
 * because that is how people say it: "the tenant pays the first hundred and
 * fifty, the owner seventy per cent". At most one payer may state no share,
 * and they pay whatever is left. With nobody to take the rest, the shares
 * have to add up to the job exactly, or a cent belongs to nobody.
 */
export function shareTargets(
  total: Money, shares: readonly Share[],
): { ok: true; targets: Money[] } | { ok: false; reason: string } {
  if (shares.length < 2) return { ok: false, reason: "A split needs at least two payers." };
  const open = shares.filter((s) => !s.amount && !s.percent);
  if (open.length > 1) {
    return { ok: false, reason: "Only one payer can pay what is left. Give the others a share." };
  }
  for (const share of shares) {
    if (share.amount && share.percent) {
      return { ok: false, reason: "A payer has an amount or a percentage, not both." };
    }
    if (share.amount && isNegative(share.amount)) return { ok: false, reason: "A share cannot be negative." };
    if (share.percent && !(Number(share.percent) > 0 && Number(share.percent) <= 1)) {
      return { ok: false, reason: `A share of ${share.percent} is not a fraction of the job. Write 0.7 for seventy per cent.` };
    }
  }

  const targets = shares.map((share) =>
    share.amount ? share.amount
      : share.percent ? round(multiply(total, share.percent), 2)
      : zero(total.currency));
  const stated = sum(targets, total.currency);

  if (open.length === 1) {
    const rest = subtract(total, stated);
    if (isNegative(rest)) {
      return {
        ok: false,
        reason: `The shares come to ${cents(stated)}, more than the job's ${cents(total)}.`,
      };
    }
    const index = shares.indexOf(open[0]!);
    targets[index] = rest;
    return { ok: true, targets };
  }

  /**
   * Percentages that each round to the cent can miss the total by a cent
   * between them. That cent goes to the largest share, deterministically,
   * rather than refusing a split of a third each that anybody would accept.
   */
  const gap = subtract(total, stated);
  const cent = money("0.01", total.currency);
  if (!isZero(gap) && compare(abs(gap), cent) <= 0
      && shares.every((s) => s.percent)) {
    let largest = 0;
    for (const [i, t] of targets.entries()) if (compare(t, targets[largest]!) > 0) largest = i;
    targets[largest] = add(targets[largest]!, gap);
    return { ok: true, targets };
  }
  if (!isZero(gap)) {
    return {
      ok: false,
      reason: `The shares come to ${cents(stated)} and the job to ${cents(total)}. `
        + "Make them add up, or leave one payer without a share to pay what is left.",
    };
  }
  return { ok: true, targets };
}

/** Whether a set of invoices adds up to the work, which is the question a split has to answer. */
export function reconciles(job: Money, invoices: readonly Money[]): { ok: boolean; difference: Money } {
  const difference = subtract(job, sum([...invoices], job.currency));
  return { ok: isZero(difference), difference };
}
