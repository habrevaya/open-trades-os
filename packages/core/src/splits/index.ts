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

/* ------------------------------------------------------------ the tax */

export interface TaxedLine {
  /** The rate AS APPLIED to this line, as a decimal string: 0.0825. */
  rate: string;
  taxable: boolean;
}

export interface TaxSplit {
  /** Per payer, per line: the tax each payer's invoice states on its part of each line. Whole cents. */
  lines: Money[][];
  /** Per payer: what their invoice charges in tax. Whole cents, and the lines above add up to it. */
  payers: Money[];
  /** What the work would be taxed if one invoice billed it all to the payers who pay tax. */
  total: Money;
}

/**
 * THE TAX FOLLOWS THE LINE TO WHOEVER PAYS IT, AND STILL ADDS UP.
 *
 * Each payer is taxed on their part of each line at that line's own rate:
 * the warranty company on the covered repair, the homeowner on the
 * deductible and the parts the plan left out, an exempt payer on nothing.
 * The obvious way to do that, each invoice working its own tax out and
 * rounding once, is right on each invoice and wrong across them: half a cent
 * of tax on each of two parts rounds to a cent on each, and the two invoices
 * then charge two cents of tax on work that, billed whole, carries one. The
 * customer and the warranty company each check their own invoice, the
 * company remits what it collected, and the extra cent is tax nobody owed.
 *
 * So the tax is worked out once, on the whole, and shared:
 *
 *   1. Each payer's exact tax on each part, at four places, from `basis`,
 *      which is the amount each invoice line will itself compute tax on.
 *   2. The total: the whole of each line that taxable payers pay, times the
 *      line's rate, summed and rounded once to the cent. With nobody exempt
 *      that is exactly the tax one invoice for the whole job would charge.
 *   3. The total shared between payers by largest remainder: each payer gets
 *      their exact tax rounded down, and the cents left over go one each to
 *      the payers with the largest fraction left, earliest payer first on a
 *      tie, so the same split is always cut the same way.
 *   4. Each payer's share shared between their lines the same way.
 *
 * Every figure is then within a cent of its exact tax, never a cent or more
 * away, which is the test an invoice applies to a tax it is told
 * (`ledger.computeInvoice`): each invoice is still its own lines at their
 * own rates, and the invoices add up to the whole.
 */
export function taxAcross(
  lines: readonly TaxedLine[],
  basis: readonly (readonly Money[])[],
  exempt: readonly boolean[] = [],
): TaxSplit {
  const currency = basis[0]?.[0]?.currency ?? "USD";
  const cent = money("0.01", currency).amount;
  const taxes = (p: number) => !exempt[p];

  const exact = basis.map((parts, p) => lines.map((line, i) =>
    line.taxable && taxes(p) ? multiply(parts[i] ?? zero(currency), line.rate) : zero(currency)));

  const wholes = lines.map((line, i) => {
    if (!line.taxable) return zero(currency);
    const paid = sum(basis.flatMap((parts, p) => (taxes(p) ? [parts[i] ?? zero(currency)] : [])), currency);
    return multiply(paid, line.rate);
  });
  const total = round(sum(wholes, currency), 2);

  const share = (target: bigint, parts: Money[]): bigint[] => {
    const floors = parts.map((x) => floorTo(x.amount, cent));
    let left = target - floors.reduce((a, b) => a + b, 0n);
    const order = parts
      .map((x, i) => ({ i, rest: x.amount - floors[i]! }))
      .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.i - b.i));
    const out = [...floors];
    /**
     * Up, a cent at a time, to the largest remainders. Down only if the four
     * place products ever sum past the rounded total, which takes thousands
     * of lines, and then from the smallest remainders that still have a cent.
     */
    const owing = order.filter((x) => x.rest > 0n);
    const fallback = order.filter((x) => parts[x.i]!.amount > 0n);
    const up = owing.length > 0 ? owing : fallback;
    for (let k = 0; left > 0n && up.length > 0; k += 1) {
      out[up[k % up.length]!.i]! += cent;
      left -= cent;
    }
    for (let k = order.length - 1; left < 0n && k >= 0; k -= 1) {
      const i = order[k]!.i;
      if (out[i]! >= cent) { out[i]! -= cent; left += cent; }
    }
    return out;
  };

  const perPayer = share(total.amount, exact.map((parts) => sum(parts, currency)));
  const perLine = exact.map((parts, p) => share(perPayer[p]!, parts));
  return {
    lines: perLine.map((row) => row.map((amount) => ({ amount, currency }))),
    payers: perPayer.map((amount) => ({ amount, currency })),
    total,
  };
}

/** Down to a whole step, for positive and negative amounts alike. */
function floorTo(amount: bigint, step: bigint): bigint {
  const rest = ((amount % step) + step) % step;
  return amount - rest;
}

/** Whether a set of invoices adds up to the work, which is the question a split has to answer. */
export function reconciles(job: Money, invoices: readonly Money[]): { ok: boolean; difference: Money } {
  const difference = subtract(job, sum([...invoices], job.currency));
  return { ok: isZero(difference), difference };
}
