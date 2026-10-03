import {
  type Quantity, type StockLevel, ZERO_QUANTITY, available, emptyLevel, quantityLabel,
} from "./index.js";

/**
 * FILLING THE TRUCKS
 *
 * A truck is not bought for. It is filled from the shelf, and the reorder
 * point is the wrong tool for it twice over: it suggests a purchase order for
 * a van that should have been topped up from twenty capacitors sitting in the
 * warehouse, and a reorder point on every van per part is a number of
 * policies nobody maintains.
 *
 * So a truck has a MINIMUM and a TARGET per item. At or under the minimum,
 * the suggestion is a transfer from the warehouse holding the most of it, up
 * to the target. When the warehouse cannot cover it the suggestion says so
 * and by how much, and that shortfall is the warehouse's reorder point's
 * business, not this function's: buying is decided in one place.
 *
 * Compared against what the truck can PROMISE (on hand less reserved), for
 * the reason the warehouse uses available: two capacitors on a van that are
 * both set aside for tomorrow's jobs are not two capacitors for the call that
 * comes in at four.
 */

export interface TruckMinimum {
  readonly itemId: string;
  readonly locationId: string;
  readonly minimum: Quantity;
  readonly target: Quantity;
}

export interface RestockSuggestion {
  readonly itemId: string;
  readonly truckId: string;
  readonly onTruck: Quantity;
  readonly minimum: Quantity;
  readonly target: Quantity;
  /** What it would take to reach the target. */
  readonly wanted: Quantity;
  /** The warehouse to take it from, or null when no warehouse has any. */
  readonly fromLocationId: string | null;
  /** What that warehouse can give, never more than wanted. */
  readonly take: Quantity;
  /** What no warehouse can give. */
  readonly short: Quantity;
  readonly why: string;
}

export function suggestRestock(input: {
  minimums: readonly TruckMinimum[];
  levels: readonly StockLevel[];
  /** The locations stock is bought into: the only places a truck is filled from. */
  warehouses: readonly string[];
}): RestockSuggestion[] {
  const out: RestockSuggestion[] = [];
  for (const rule of input.minimums) {
    const level = input.levels.find((l) => l.itemId === rule.itemId && l.locationId === rule.locationId)
      ?? emptyLevel(rule.itemId, rule.locationId);
    const onTruck = available(level);
    if (onTruck > rule.minimum) continue;

    const wanted = rule.target - onTruck;
    if (wanted <= ZERO_QUANTITY) continue;

    const sources = input.warehouses
      .map((id) => ({
        id,
        free: available(input.levels.find((l) => l.itemId === rule.itemId && l.locationId === id) ?? emptyLevel(rule.itemId, id)),
      }))
      .filter((s) => s.free > ZERO_QUANTITY)
      .sort((a, b) => (b.free > a.free ? 1 : b.free < a.free ? -1 : 0));
    const best = sources[0];
    const take = best ? (best.free < wanted ? best.free : wanted) : ZERO_QUANTITY;
    const short = wanted - take;

    out.push({
      itemId: rule.itemId,
      truckId: rule.locationId,
      onTruck,
      minimum: rule.minimum,
      target: rule.target,
      wanted,
      fromLocationId: best?.id ?? null,
      take,
      short,
      why: short === ZERO_QUANTITY
        ? `${quantityLabel(onTruck)} on the truck against a minimum of ${quantityLabel(rule.minimum)}. Fill to ${quantityLabel(rule.target)}.`
        : take === ZERO_QUANTITY
          ? `${quantityLabel(onTruck)} on the truck against a minimum of ${quantityLabel(rule.minimum)}, and no warehouse has any to give. The warehouse needs to buy ${quantityLabel(short)}.`
          : `${quantityLabel(onTruck)} on the truck against a minimum of ${quantityLabel(rule.minimum)}. The warehouse can give ${quantityLabel(take)} and is ${quantityLabel(short)} short of the target.`,
    });
  }
  return out;
}
