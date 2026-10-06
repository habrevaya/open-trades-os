import { type Money, allocate } from "../money/index.js";
import {
  type Movement, type MovementStamp, type Quantity,
  ZERO_QUANTITY, effectOf, orderedMovements, quantity as qty, quantityLabel, quantityToString,
} from "./index.js";

/**
 * SERIAL NUMBERS AND LOTS
 *
 * The question a contractor gets asked eighteen months after an install is
 * not "how many compressors did you have", it is "which compressor is in my
 * house, where did it come from and is it the one on the recall". A count
 * cannot answer that. A count also cannot answer the warranty clerk, whose
 * form wants the serial that left the shelf, or the technician who swears
 * the unit on the van is the one the office says went to a job last week.
 *
 * So an item can be TRACKED, by serial (every unit its own number) or by lot
 * (a batch shares one). A tracked item still has a level, folded from the
 * same movements as everything else, and on top of it each serial or lot has
 * a level of its own, folded from the movements that name it. Nothing new is
 * stored about where a unit is. That is the same decision `index.ts` makes
 * about stock levels, for the same reason: a stored location for a serial is
 * one somebody forgets to update, and then the trace lies.
 *
 * THE ONE RULE THIS FILE ENFORCES EVERYWHERE: a movement of a tracked item
 * says which units moved. Receiving four serialised compressors without their
 * numbers is four compressors nobody can ever trace, and the moment one goes
 * to a job unnamed the history of every other one becomes a guess.
 */

export type TrackingMode = "serial" | "lot";

export const TRACKING_MODES: Record<TrackingMode, { label: string; description: string }> = {
  serial: {
    label: "By serial number",
    description: "Every unit has its own number and moves on its own: a compressor, a furnace, a water heater.",
  },
  lot: {
    label: "By lot",
    description: "Units arrive in batches that share a number, and a recall names the batch: refrigerant, adhesive.",
  },
};

/** How much of one serial or lot is at one location. Folded, never stored. */
export interface UnitLevel {
  readonly lotId: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly onHand: Quantity;
}

/**
 * Fold the movements that name a serial or lot into a level per unit per
 * location. Movements with no unit are skipped, which is what lets a tracked
 * item's untracked history from before it was tracked still derive.
 */
export function deriveUnitLevels(movements: readonly Movement[]): UnitLevel[] {
  const levels = new Map<string, UnitLevel>();
  for (const movement of orderedMovements(movements)) {
    if (!movement.lotId) continue;
    const key = `${movement.lotId}@${movement.locationId}`;
    const current = levels.get(key) ?? {
      lotId: movement.lotId, itemId: movement.itemId, locationId: movement.locationId, onHand: ZERO_QUANTITY,
    };
    levels.set(key, { ...current, onHand: current.onHand + effectOf(movement.kind, movement.quantity).onHand });
  }
  return [...levels.values()];
}

/** Where one serial or lot is now: every location still holding any of it. */
export const unitWhereabouts = (levels: readonly UnitLevel[], lotId: string): UnitLevel[] =>
  levels.filter((level) => level.lotId === lotId && level.onHand > ZERO_QUANTITY);

/**
 * WHAT BECAME OF A SERIAL.
 *
 * `in_stock` at a location, `used` on a job (with the job), or `gone`: written
 * off, returned, or never received. Read from the unit's own last movement
 * that took it off a shelf, because a serial issued to a job leaves no level
 * anywhere and "nowhere" is not an answer anybody can act on.
 */
export type SerialState =
  | { state: "in_stock"; locationId: string }
  | { state: "used"; jobId: string | null; at: Date }
  | { state: "gone"; kind: Movement["kind"] | null; at: Date | null };

export function serialState(movements: readonly Movement[], lotId: string): SerialState {
  const mine = orderedMovements(movements.filter((m) => m.lotId === lotId));
  const here = deriveUnitLevels(mine).find((level) => level.onHand > ZERO_QUANTITY);
  if (here) return { state: "in_stock", locationId: here.locationId };
  const last = [...mine].reverse().find((m) => effectOf(m.kind, m.quantity).onHand < ZERO_QUANTITY);
  if (last?.kind === "issue") return { state: "used", jobId: last.jobId ?? null, at: last.occurredAt };
  return { state: "gone", kind: last?.kind ?? null, at: last?.occurredAt ?? null };
}

/** Which units, and how many of each, a person said moved. */
export interface UnitPick {
  readonly lotId: string;
  readonly quantity: Quantity;
}

export type UnitRefusal =
  | { ok: false; reason: "units_required"; mode: TrackingMode; itemLabel: string }
  | { ok: false; reason: "serial_not_one"; number: string }
  | { ok: false; reason: "unit_twice"; number: string }
  | { ok: false; reason: "units_do_not_add_up"; mode: TrackingMode; requested: Quantity; named: Quantity }
  | { ok: false; reason: "unit_not_here"; number: string; locationLabel: string; onHand: Quantity; wanted: Quantity }
  | { ok: false; reason: "untracked_given_units"; itemLabel: string };

/** The refusal in the sentence somebody can act on. */
export function explainUnitRefusal(refusal: UnitRefusal): string {
  switch (refusal.reason) {
    case "units_required":
      return refusal.mode === "serial"
        ? `${refusal.itemLabel} is tracked by serial number, so say which ones. Moving them unnamed is how a unit stops being traceable to the customer it went to.`
        : `${refusal.itemLabel} is tracked by lot, so say which lot. A recall names a lot, and stock moved without one cannot be found when it does.`;
    case "serial_not_one":
      return `Serial ${refusal.number} is one unit. A serial number names exactly one of something.`;
    case "unit_twice":
      return `${refusal.number} is named twice. Each unit moves once.`;
    case "units_do_not_add_up":
      return refusal.mode === "serial"
        ? `${quantityLabel(refusal.requested)} were asked for and ${quantityLabel(refusal.named)} serial numbers were given. Name one for each unit.`
        : `${quantityLabel(refusal.requested)} were asked for and the lots named add up to ${quantityLabel(refusal.named)}.`;
    case "unit_not_here":
      return refusal.onHand > ZERO_QUANTITY
        ? `There is only ${quantityLabel(refusal.onHand)} of ${refusal.number} at ${refusal.locationLabel}, and ${quantityLabel(refusal.wanted)} was asked for.`
        : `${refusal.number} is not at ${refusal.locationLabel}. Look up where it is before moving it.`;
    case "untracked_given_units":
      return `${refusal.itemLabel} is not tracked by serial or lot, so there are no numbers to give for it.`;
  }
}

export type UnitCheck = { ok: true } | UnitRefusal;

/**
 * Do the units named account for exactly what is being moved, and is each of
 * them where it is being moved from?
 *
 * `levels` is null for a receipt, which brings units in rather than taking
 * them from anywhere. `numbers` names each lot for the sentence.
 */
export function checkUnitPicks(input: {
  mode: TrackingMode;
  itemLabel: string;
  quantity: Quantity;
  picks: readonly UnitPick[];
  numbers: ReadonlyMap<string, string>;
  from: { locationId: string; locationLabel: string; levels: readonly UnitLevel[] } | null;
}): UnitCheck {
  if (input.picks.length === 0) {
    return { ok: false, reason: "units_required", mode: input.mode, itemLabel: input.itemLabel };
  }
  const label = (lotId: string) => input.numbers.get(lotId) ?? lotId;
  const seen = new Set<string>();
  let named = ZERO_QUANTITY;
  for (const pick of input.picks) {
    if (seen.has(pick.lotId)) return { ok: false, reason: "unit_twice", number: label(pick.lotId) };
    seen.add(pick.lotId);
    if (input.mode === "serial" && pick.quantity !== qty("1")) {
      return { ok: false, reason: "serial_not_one", number: label(pick.lotId) };
    }
    if (pick.quantity <= ZERO_QUANTITY) {
      return { ok: false, reason: "units_do_not_add_up", mode: input.mode, requested: input.quantity, named: pick.quantity };
    }
    named += pick.quantity;
    if (input.from) {
      const here = input.from.levels
        .find((level) => level.lotId === pick.lotId && level.locationId === input.from!.locationId)?.onHand
        ?? ZERO_QUANTITY;
      if (here < pick.quantity) {
        return {
          ok: false, reason: "unit_not_here", number: label(pick.lotId),
          locationLabel: input.from.locationLabel, onHand: here, wanted: pick.quantity,
        };
      }
    }
  }
  if (named !== input.quantity) {
    return { ok: false, reason: "units_do_not_add_up", mode: input.mode, requested: input.quantity, named };
  }
  return { ok: true };
}

/**
 * ONE MOVEMENT BECOMES ONE PER UNIT.
 *
 * The decision about the item as a whole is still made by the planners in
 * `index.ts` (enough on the shelf, nobody else's reservation taken), and then
 * the movement it returned is cut into one per serial or lot. Each piece gets
 * its own stamp, because every movement needs its own place in the total
 * order, and a receipt's cost is ALLOCATED across the pieces rather than
 * divided, so three units bought for a hundred dollars cost 33.34, 33.33 and
 * 33.33 and still add up to the hundred.
 *
 * A transfer's two halves are split together by `splitTransfer`, so each unit
 * leaves and arrives under one transfer id of its own: the costing pairs
 * halves by that id and would refuse a pair whose quantities differ.
 */
export function splitAcrossUnits(
  movement: Movement,
  picks: readonly UnitPick[],
  stamps: readonly MovementStamp[],
): Movement[] {
  if (stamps.length < picks.length) throw new RangeError("One stamp is needed for each unit.");
  const costs: (Money | undefined)[] = movement.totalCost
    ? allocate(movement.totalCost, picks.map((pick) => quantityToString(pick.quantity)), 4)
    : picks.map(() => undefined);
  return picks.map((pick, index) => ({
    ...movement,
    ...stamps[index]!,
    quantity: pick.quantity,
    lotId: pick.lotId,
    totalCost: costs[index],
  }));
}

export function splitTransfer(input: {
  out: Movement;
  in: Movement;
  picks: readonly UnitPick[];
  stamps: readonly { out: MovementStamp; in: MovementStamp; transferId: string }[];
}): Movement[] {
  if (input.stamps.length < input.picks.length) throw new RangeError("One stamp pair is needed for each unit.");
  return input.picks.flatMap((pick, index) => {
    const stamp = input.stamps[index]!;
    return [
      { ...input.out, ...stamp.out, quantity: pick.quantity, lotId: pick.lotId, transferId: stamp.transferId },
      { ...input.in, ...stamp.in, quantity: pick.quantity, lotId: pick.lotId, transferId: stamp.transferId },
    ];
  });
}

/**
 * Serial numbers typed or scanned into one box: one per line, or separated by
 * commas or spaces. Trimmed, blanks dropped, and the order kept, because the
 * order is the order the boxes were opened in.
 */
export function parseSerialList(text: string): string[] {
  return text.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s !== "");
}

