import { type Money, add, allocate, isZero, isNegative, round, compare, zero } from "../money/index.js";
import {
  type CostRun, type LandedCostBasis, type Movement, type MovementStamp, type Quantity,
  ZERO_QUANTITY, allocateLandedCost, quantityLabel, quantityToString,
} from "./index.js";

/**
 * FREIGHT BILLED AFTER THE DELIVERY
 *
 * The carrier's invoice for a delivery arrives a week after the truck. By
 * then some of what it carried is still on the warehouse shelf, some has
 * moved to a van, some is in a customer's basement on a job that has already
 * been costed, and one was dropped and written off. Freight typed at the
 * receipt is spread over the delivery's lines and nothing else is needed;
 * freight that comes later has to follow each line's parts to wherever they
 * went, or it lands on the wrong thing.
 *
 * So the bill is spread twice, both times ALLOCATED to the cent so the parts
 * add back to the bill exactly:
 *
 *   1. Over the delivery's lines, by what each cost or by how many arrived,
 *      exactly as `allocateLandedCost` spreads freight on a receipt. A late
 *      bill and an on-time one for the same delivery land the same way.
 *
 *   2. Each line's share over what became of its parts, by how many: still
 *      on a shelf (raising that shelf's value), used on a job (that job's
 *      cost of goods sold, so job costing sees it), or gone some other way
 *      (scrapped, short on a count, sent back to the vendor), which is a cost
 *      with no job to carry it.
 *
 * Where the parts went is read from the costing replay, which follows each
 * part's receipt through every transfer by first in, first out. A use that a
 * return off the job has undone does not count: those parts are back on a
 * shelf, and the replay already has them there.
 *
 * Remainders. Each split places its leftover cents by `money.allocate`'s
 * rule, the largest weight first and then the earlier entry, over entries in
 * a fixed order (shelves by location, then uses, then losses, each by id), so
 * the same bill on the same history always lands on the same cents.
 */

export type LandedFate =
  | { kind: "shelf"; origin: string; locationId: string; quantity: Quantity }
  | { kind: "used"; origin: string; movementId: string; jobId: string | null; locationId: string; quantity: Quantity }
  | { kind: "gone"; origin: string; movementId: string; movementKind: string; locationId: string; quantity: Quantity };

type OkRun = CostRun & { ok: true };

const fateOrder = (fate: LandedFate): string =>
  fate.kind === "shelf" ? `0:${fate.locationId}` : fate.kind === "used" ? `1:${fate.movementId}` : `2:${fate.movementId}`;

/**
 * Where the parts of each receipt are now, from a costing replay run to the
 * present. Shelves are summed per location, because two layers of one
 * receipt on one van are the same place.
 */
export function fatesOf(run: OkRun, origins: readonly string[]): Map<string, LandedFate[]> {
  const wanted = new Set(origins);
  const out = new Map<string, LandedFate[]>(origins.map((origin) => [origin, []]));
  const shelves = new Map<string, LandedFate & { kind: "shelf" }>();

  for (const layer of run.layers) {
    if (!wanted.has(layer.origin) || layer.quantity <= ZERO_QUANTITY) continue;
    const key = `${layer.origin}@${layer.locationId}`;
    const seen = shelves.get(key);
    shelves.set(key, seen
      ? { ...seen, quantity: seen.quantity + layer.quantity }
      : { kind: "shelf", origin: layer.origin, locationId: layer.locationId, quantity: layer.quantity });
  }
  for (const shelf of shelves.values()) out.get(shelf.origin)!.push(shelf);

  for (const use of run.consumptions) {
    if (use.returned) continue;
    const byOrigin = new Map<string, Quantity>();
    for (const slice of use.slices) {
      if (!wanted.has(slice.origin)) continue;
      byOrigin.set(slice.origin, (byOrigin.get(slice.origin) ?? ZERO_QUANTITY) + slice.quantity);
    }
    for (const [origin, quantity] of byOrigin) {
      out.get(origin)!.push(use.kind === "issue"
        ? { kind: "used", origin, movementId: use.movementId, jobId: use.jobId ?? null, locationId: use.locationId, quantity }
        : { kind: "gone", origin, movementId: use.movementId, movementKind: use.kind, locationId: use.locationId, quantity });
    }
  }

  for (const [origin, fates] of out) out.set(origin, fates.sort((a, b) => (fateOrder(a) < fateOrder(b) ? -1 : 1)));
  return out;
}

export interface LateReceiptLine {
  /** The receipt movement. One per line of the delivery, or per unit of a tracked line. */
  readonly movementId: string;
  readonly itemId: string;
  /** What the goods on it cost, without any freight already on it. The weight by value. */
  readonly value: Money;
  readonly quantity: Quantity;
}

export interface LatePiece {
  readonly fate: LandedFate;
  readonly receiptMovementId: string;
  readonly itemId: string;
  readonly amount: Money;
}

export type LateLandedPlan =
  | {
    ok: true;
    pieces: LatePiece[];
    /** Each line's share, before it followed its parts. */
    lines: { movementId: string; share: Money }[];
    onShelf: Money;
    onJobs: Money;
    onGone: Money;
    /** Per job, for the ledger and the job's cost. */
    byJob: { jobId: string; amount: Money }[];
  }
  | { ok: false; reason: "not_cents" | "not_positive" | "nothing_received" | "unaccounted"; message: string };

/**
 * Spread a late bill over a delivery and then over what became of it.
 *
 * Refused rather than guessed when the replay cannot account for every part
 * a line received: freight put on whatever happened to be found would be on
 * the wrong parts, and a history with a hole in it is a thing to fix first.
 */
export function planLateLandedCost(input: {
  amount: Money;
  basis: LandedCostBasis;
  lines: readonly LateReceiptLine[];
  fates: ReadonlyMap<string, readonly LandedFate[]>;
}): LateLandedPlan {
  const currency = input.amount.currency;
  if (compare(round(input.amount, 2), input.amount) !== 0) {
    return { ok: false, reason: "not_cents", message: "A bill is in dollars and cents. Give the amount to the cent, as the bill shows it." };
  }
  if (isNegative(input.amount) || isZero(input.amount)) {
    return { ok: false, reason: "not_positive", message: "A freight or duty bill has to be for more than nothing. A credit from the carrier is not freight." };
  }
  if (input.lines.length === 0) {
    return { ok: false, reason: "nothing_received", message: "Nothing was received on that delivery, so there is nothing to put the bill on." };
  }

  const shares = allocateLandedCost(
    input.amount,
    input.lines.map((line) => ({ lineId: line.movementId, value: line.value, quantity: line.quantity })),
    input.basis,
  );

  const pieces: LatePiece[] = [];
  for (const line of input.lines) {
    const share = shares.find((s) => s.lineId === line.movementId)?.share ?? zero(currency);
    if (isZero(share)) continue;
    const fates = input.fates.get(line.movementId) ?? [];
    const accounted = fates.reduce((total, fate) => total + fate.quantity, ZERO_QUANTITY);
    if (fates.length === 0 || accounted !== line.quantity) {
      return {
        ok: false, reason: "unaccounted",
        message: `${quantityLabel(line.quantity)} arrived on one line of that delivery and the history accounts for ${quantityLabel(accounted)} of them. `
          + "Put the history right before spreading a bill over it.",
      };
    }
    const amounts = allocate(share, fates.map((fate) => quantityToString(fate.quantity)), 2);
    fates.forEach((fate, i) => pieces.push({
      fate, receiptMovementId: line.movementId, itemId: line.itemId, amount: amounts[i] ?? zero(currency),
    }));
  }

  const sumOf = (kind: LandedFate["kind"]) => pieces
    .filter((p) => p.fate.kind === kind).reduce((total, p) => add(total, p.amount), zero(currency));
  const byJob = new Map<string, Money>();
  for (const piece of pieces) {
    if (piece.fate.kind !== "used" || !piece.fate.jobId) continue;
    byJob.set(piece.fate.jobId, add(byJob.get(piece.fate.jobId) ?? zero(currency), piece.amount));
  }
  /** A use with no job is a cost of nothing in particular, which is what "gone" means. */
  const jobless = pieces.filter((p) => p.fate.kind === "used" && !p.fate.jobId)
    .reduce((total, p) => add(total, p.amount), zero(currency));

  return {
    ok: true,
    pieces: pieces.filter((p) => !isZero(p.amount)),
    lines: shares.map((s) => ({ movementId: s.lineId, share: s.share })),
    onShelf: sumOf("shelf"),
    onJobs: [...byJob.values()].reduce((total, amount) => add(total, amount), zero(currency)),
    onGone: add(sumOf("gone"), jobless),
    byJob: [...byJob.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([jobId, amount]) => ({ jobId, amount })),
  };
}

/**
 * The revaluation movements a plan writes: one per piece, on the shelf it
 * sits on or on the use or loss that took its parts, so the costing replay
 * puts each cent where the plan said.
 */
export function lateLandedMovements(
  pieces: readonly LatePiece[], stamps: readonly MovementStamp[],
): Movement[] {
  if (stamps.length < pieces.length) throw new RangeError("One stamp is needed for each piece.");
  return pieces.map((piece, i) => ({
    ...stamps[i]!,
    itemId: piece.itemId,
    locationId: piece.fate.locationId,
    kind: "revaluation" as const,
    quantity: piece.fate.quantity,
    totalCost: piece.amount,
    lateCost: piece.amount,
    revaluesMovementId: piece.fate.kind === "shelf" ? piece.fate.origin : piece.fate.movementId,
    ...(piece.fate.kind === "used" && piece.fate.jobId ? { jobId: piece.fate.jobId } : {}),
  }));
}

/**
 * What a use, a loss or a return to the vendor takes out of the inventory
 * account: the late freight on the parts it took. Read from a replay that
 * includes the movements just written.
 */
export function lateRelief(run: OkRun, movementIds: readonly string[]): { movementId: string; jobId: string | null; amount: Money }[] {
  const ids = new Set(movementIds);
  return run.consumptions
    .filter((c) => ids.has(c.movementId) && !isZero(c.late))
    .map((c) => ({ movementId: c.movementId, jobId: c.kind === "issue" ? c.jobId ?? null : null, amount: c.late }));
}
