import {
  type Money,
  type CurrencyCode,
  add,
  multiply,
  divide,
  allocate,
  zero,
  isZero,
  toString as moneyToString,
} from "../money/index.js";

/**
 * PURCHASING, VENDORS AND INVENTORY: THE DECISION LOGIC
 *
 * The problem this exists for, in the words a contractor uses: you order parts
 * for a job, they arrive two days late, the job is already done with a
 * workaround, and now there are parts in the warehouse nobody knows about. A
 * technician has two thousand dollars of material in their truck and nothing
 * is tracking it. When they leave, you lose the parts and you lose the cost.
 *
 * Everything below is a pure function. No database, no clock, no I/O. `now` is
 * a parameter wherever time matters, because a costing run that reads the wall
 * clock cannot be tested and cannot be replayed, and the first time somebody
 * needs to ask "what did this look like on the last day of the quarter" they
 * find out the answer is unobtainable.
 *
 * THE THREE IDEAS THAT CARRY THE FILE
 *
 *   1. There are THREE quantities, not one. On hand, committed, available.
 *      Available is derived and is never stored. A product that tracks only on
 *      hand dispatches two technicians to two jobs that both need the last
 *      compressor, and the second one finds out at the property.
 *
 *   2. A stock level is DERIVED FROM MOVEMENTS, never edited. This is the same
 *      argument the accounting ledger makes one directory over: a balance
 *      nobody can explain is worse than no balance. An editable on hand number
 *      is a number with no history, and when it is wrong, and it will be
 *      wrong, there is nothing to look at.
 *
 *   3. Money is ALLOCATED, never divided. A receipt of three parts for one
 *      hundred dollars has no unit cost. 33.33 three times is 99.99, and the
 *      penny that went missing is the reason the inventory account and the
 *      general ledger stop agreeing, every month, by a slightly larger amount.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not post to the ledger. An issue produces a COST, and the caller
 * hands that amount to `ledger.postInvoice` and friends so that there is
 * exactly one place in the codebase that knows how to build a balanced
 * posting. Two modules that both know how to write journal entries is two
 * truths, and the second one is always the one that drifts.
 */

// ---------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------

/**
 * A quantity is a bigint of units scaled by 10^4, for the same reason money is.
 *
 * Trades quantities are not whole numbers. A lineset is cut at 12.5 feet, a
 * system takes 2.75 pounds of refrigerant, wire comes off a spool. Holding
 * those as JS numbers means 0.1 + 0.2 arrives in a cycle count as
 * 0.30000000000000004, the count never reconciles, and after the third time
 * somebody stops doing cycle counts. Which is the real cost: not the rounding,
 * the abandoned process.
 *
 * Scale 4 matches numeric(14,4) in the database, so a value survives a round
 * trip through Postgres unchanged.
 */
export const QUANTITY_SCALE = 4;
const QUANTITY_FACTOR = 10_000n;

export type Quantity = bigint;

export const ZERO_QUANTITY: Quantity = 0n;

/**
 * Parse a decimal string. A decimal STRING, deliberately, and not a JS number,
 * because accepting a number is exactly how a float gets in and every
 * guarantee above quietly stops holding.
 */
export function quantity(value: string): Quantity {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Not a decimal quantity: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith("-");
  const [whole = "0", frac = ""] = trimmed.replace("-", "").split(".");
  if (frac.length > QUANTITY_SCALE) {
    throw new RangeError(`More than ${QUANTITY_SCALE} decimal places would lose precision: ${value}`);
  }
  const units = BigInt(whole) * QUANTITY_FACTOR + BigInt(frac.padEnd(QUANTITY_SCALE, "0") || "0");
  return negative ? -units : units;
}

/** Exact decimal string with four places. What goes back to the database. */
export function quantityToString(q: Quantity): string {
  const negative = q < 0n;
  const absolute = negative ? -q : q;
  const whole = absolute / QUANTITY_FACTOR;
  const frac = (absolute % QUANTITY_FACTOR).toString().padStart(QUANTITY_SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * For a screen. "3" rather than "3.0000", because a parts list that reads
 * 3.0000 compressors teaches everyone reading it that the software was
 * written by somebody who has never seen a parts list.
 */
export function quantityLabel(q: Quantity): string {
  const text = quantityToString(q);
  if (!text.includes(".")) return text;
  return text.replace(/\.?0+$/, "") || "0";
}

const qtyMax = (a: Quantity, b: Quantity): Quantity => (a > b ? a : b);
const qtyMin = (a: Quantity, b: Quantity): Quantity => (a < b ? a : b);

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/**
 * A VAN IS A LOCATION.
 *
 * This is the decision the rest of the file hangs off. Most products model one
 * stock number per item and treat truck stock as an afterthought or not at
 * all. But "we have one in stock" is not a useful sentence: one in stock at
 * the warehouse, forty minutes away, does nothing for the technician standing
 * in the crawlspace at 4pm. The question is always "available WHERE", and a
 * data model that cannot ask it cannot answer it later by trying harder.
 *
 * Modelling the van as a first class location also makes truck stock
 * auditable, which is the two thousand dollars that walks out the door when a
 * technician leaves.
 */
export type LocationKind = "warehouse" | "van" | "job_site" | "staging";

export const LOCATION_KINDS: Record<LocationKind, { label: string; description: string }> = {
  warehouse: {
    label: "Warehouse",
    description: "A fixed building. Stock here is counted on a schedule and is not with anybody.",
  },
  van: {
    label: "Truck stock",
    description: "A technician's vehicle. Real inventory, assigned to a person, and the hardest to keep honest.",
  },
  job_site: {
    label: "Job site",
    description: "Material staged at a property for work that has not happened yet. It is ours until it is installed.",
  },
  staging: {
    label: "Staging",
    description: "Picked and set aside for a job but not yet loaded. A holding area, not a hiding place.",
  },
};

export interface StockLocation {
  readonly id: string;
  readonly kind: LocationKind;
  readonly name: string;
  /** Set for a van. This is how truck stock becomes somebody's responsibility. */
  readonly technicianId?: string | undefined;
}

// ---------------------------------------------------------------------------
// The three quantities
// ---------------------------------------------------------------------------

/**
 * THE CENTRAL IDEA OF THIS FILE.
 *
 * ON HAND is what is physically there. You could walk in and touch it.
 *
 * COMMITTED is what is physically there and already spoken for: reserved
 * against a job that is scheduled but not yet done. It has not moved. It is
 * still on the shelf. It is not yours to promise to anybody else.
 *
 * AVAILABLE is on hand minus committed, and it is the only one of the three a
 * dispatcher should ever be shown, because it is the only one that answers the
 * question they are actually asking: can I promise this part to this job.
 *
 * Available is NOT A FIELD. It is not on this interface, there is no column
 * for it, and nothing in this module returns a record with an `available`
 * property on it. That is a deliberate and slightly annoying constraint, and
 * the reason is that a stored derived value is a value that can be wrong. The
 * moment `available` is a column, some code path updates on hand without
 * updating available, and from then on the system reports stock it does not
 * have. It is always the same bug and it is always found by a customer.
 */
export interface StockLevel {
  readonly itemId: string;
  readonly locationId: string;
  readonly onHand: Quantity;
  readonly committed: Quantity;
}

/** On hand minus committed. Derived, every time, from the two stored numbers. */
export const available = (level: StockLevel): Quantity => level.onHand - level.committed;

export const emptyLevel = (itemId: string, locationId: string): StockLevel => ({
  itemId,
  locationId,
  onHand: ZERO_QUANTITY,
  committed: ZERO_QUANTITY,
});

// ---------------------------------------------------------------------------
// Movements: the append only stock ledger
// ---------------------------------------------------------------------------

/**
 * Every change to stock is a movement, and movements are APPEND ONLY.
 *
 * The same argument the accounting ledger makes. A posting is never edited; a
 * correction is another posting. Here: a movement is never edited, a
 * correction is another movement, and the level is a fold over the history.
 *
 * What this buys, concretely: when the warehouse manager says "the system says
 * four and there are two", the answer is a list of the eleven things that
 * happened to that part since the last count, with who and when on each one.
 * With an editable stock level the answer is "I do not know", and that is the
 * end of anybody trusting the number.
 */
export type MovementKind =
  | "receipt"
  | "issue"
  | "transfer_out"
  | "transfer_in"
  | "return_to_stock"
  | "return_to_vendor"
  | "adjustment_in"
  | "adjustment_out"
  | "scrap"
  | "commit"
  | "release";

/**
 * What each kind does to each of the three quantities, as data rather than as
 * a switch statement scattered through the file.
 *
 * `onHand` and `committed` are directions, not amounts: -1, 0 or +1. The
 * amount is always the movement's own quantity, which is always POSITIVE. A
 * signed quantity is how a receipt of minus three ends up in the history,
 * meaning either a return or a typo, and nobody can tell which.
 *
 * Note `commit` and `release`, which move committed and leave on hand alone.
 * They are in the same ledger as everything else on purpose: all three
 * quantities derive from one ordered list, so there is no second place where a
 * reservation could be recorded and then disagree.
 */
export const MOVEMENT_EFFECTS: Record<
  MovementKind,
  { label: string; description: string; onHand: -1 | 0 | 1; committed: -1 | 0 | 1 }
> = {
  receipt: {
    label: "Received",
    description: "Arrived from a vendor. This is the only movement that establishes what stock cost.",
    onHand: 1,
    committed: 0,
  },
  issue: {
    label: "Issued to a job",
    description: "Consumed on work. On hand goes down, and any reservation it was covering is released with it.",
    onHand: -1,
    committed: -1,
  },
  transfer_out: {
    label: "Transferred out",
    description: "Left this location. Half of a transfer, and meaningless without the other half.",
    onHand: -1,
    committed: 0,
  },
  transfer_in: {
    label: "Transferred in",
    description: "Arrived at this location from another one of ours. The other half of a transfer.",
    onHand: 1,
    committed: 0,
  },
  return_to_stock: {
    label: "Returned to stock",
    description: "Came back off a truck or a job unused. The part that most often never gets recorded at all.",
    onHand: 1,
    committed: 0,
  },
  return_to_vendor: {
    label: "Returned to vendor",
    description: "Went back to the supplier against a credit. Stock leaves and money is owed to us.",
    onHand: -1,
    committed: 0,
  },
  adjustment_in: {
    label: "Adjustment, found",
    description: "A count found more than the history says. The history was wrong and this says by how much.",
    onHand: 1,
    committed: 0,
  },
  adjustment_out: {
    label: "Adjustment, short",
    description: "A count found less than the history says. Usually shrinkage, sometimes an issue nobody recorded.",
    onHand: -1,
    committed: 0,
  },
  scrap: {
    label: "Scrapped",
    description: "Damaged or obsolete and written off deliberately. A decision, and reportable as one.",
    onHand: -1,
    committed: 0,
  },
  commit: {
    label: "Reserved for a job",
    description: "Set aside without moving. Still on the shelf, no longer available to promise to anyone else.",
    onHand: 0,
    committed: 1,
  },
  release: {
    label: "Reservation released",
    description: "The job was cancelled or changed. The part is available again without ever having moved.",
    onHand: 0,
    committed: -1,
  },
};

export const MOVEMENT_KINDS = Object.keys(MOVEMENT_EFFECTS) as MovementKind[];

/**
 * Identity and ordering for a movement, supplied by the caller.
 *
 * These functions do not generate ids and do not read a clock. An id minted in
 * here would make the same call return a different answer twice, which makes
 * the function untestable and makes a retry create a duplicate movement
 * instead of being caught by a unique index.
 */
export interface MovementStamp {
  readonly id: string;
  /** A total order assigned by the writer, typically a sequence from the database. */
  readonly sequence: number;
  readonly occurredAt: Date;
}

export interface Movement {
  readonly id: string;
  readonly sequence: number;
  readonly occurredAt: Date;
  readonly itemId: string;
  readonly locationId: string;
  readonly kind: MovementKind;
  /** Always positive. Direction comes from the kind, never from a sign. */
  readonly quantity: Quantity;
  /** What the whole of this movement cost. Required on anything that ADDS stock. */
  readonly totalCost?: Money | undefined;
  readonly jobId?: string | undefined;
  /** Shared by the two halves of a transfer, and the only thing that pairs them. */
  readonly transferId?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly purchaseOrderId?: string | undefined;
  readonly purchaseOrderLineId?: string | undefined;
}

/** The signed effect of one movement on the two STORED quantities. */
export function effectOf(kind: MovementKind, amount: Quantity): { onHand: Quantity; committed: Quantity } {
  const effect = MOVEMENT_EFFECTS[kind];
  return {
    onHand: BigInt(effect.onHand) * amount,
    committed: BigInt(effect.committed) * amount,
  };
}

/**
 * The order the ledger is read in.
 *
 * `occurredAt` first, because costing is a statement about the order things
 * HAPPENED, not the order somebody got round to typing them. A receipt entered
 * on Thursday for a delivery that arrived on Monday belongs before Tuesday's
 * issue, and putting it after produces a FIFO answer that is wrong about which
 * physical part was used.
 *
 * `sequence` breaks the tie, because two movements land in the same
 * millisecond constantly: a transfer is two of them, and a receipt of a
 * six line delivery is six. Without a tie break the answer depends on the
 * order the rows came back from the database, which is to say it is not an
 * answer.
 */
export function byLedgerOrder(a: Movement, b: Movement): number {
  const at = a.occurredAt.getTime();
  const bt = b.occurredAt.getTime();
  if (at !== bt) return at - bt;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const orderedMovements = (movements: readonly Movement[]): Movement[] =>
  [...movements].sort(byLedgerOrder);

const levelKey = (itemId: string, locationId: string) => `${itemId}@${locationId}`;

/**
 * Fold the history into levels. This is the only way a level is ever produced.
 *
 * Two rules that look inconsistent and are not:
 *
 *   COMMITTED IS CLAMPED AT ZERO. A negative reservation is not a fact about
 *   the world, it is an arithmetic artefact: it happens when a part is issued
 *   that nobody reserved, and if it were allowed through then available would
 *   read HIGHER than on hand and a dispatcher would be told there is stock
 *   that is not there. Clamping is the conservative direction.
 *
 *   ON HAND IS NOT CLAMPED. A negative on hand is real information. It means
 *   the history is broken: a receipt was never entered, or an issue was
 *   entered twice. Hiding it at zero destroys the only signal that anything is
 *   wrong, and the numbers then look fine and are not. So it is allowed to go
 *   negative here, the decision functions below refuse to CREATE a movement
 *   that would do it, and the costing refuses to put a price on it.
 */
export function deriveLevels(movements: readonly Movement[]): StockLevel[] {
  const levels = new Map<string, { itemId: string; locationId: string; onHand: Quantity; committed: Quantity }>();

  for (const movement of orderedMovements(movements)) {
    const key = levelKey(movement.itemId, movement.locationId);
    const current = levels.get(key) ?? {
      itemId: movement.itemId,
      locationId: movement.locationId,
      onHand: ZERO_QUANTITY,
      committed: ZERO_QUANTITY,
    };
    const effect = effectOf(movement.kind, movement.quantity);
    levels.set(key, {
      itemId: current.itemId,
      locationId: current.locationId,
      onHand: current.onHand + effect.onHand,
      committed: qtyMax(ZERO_QUANTITY, current.committed + effect.committed),
    });
  }

  return [...levels.values()];
}

export function deriveLevel(movements: readonly Movement[], itemId: string, locationId: string): StockLevel {
  const found = deriveLevels(movements).find((l) => l.itemId === itemId && l.locationId === locationId);
  return found ?? emptyLevel(itemId, locationId);
}

/**
 * Where can this part actually be had, right now.
 *
 * Sorted by available descending so the caller can offer the fullest location
 * first. The answer is a LIST because "is it in stock" has no single answer
 * once a van is a location, and flattening it to one number is what produces
 * the technician who was told yes and drives to a property without the part.
 */
export function locationsWithAvailable(
  levels: readonly StockLevel[],
  itemId: string,
  minimum: Quantity = ZERO_QUANTITY,
): StockLevel[] {
  return levels
    .filter((l) => l.itemId === itemId && available(l) > ZERO_QUANTITY && available(l) >= minimum)
    .sort((a, b) => (available(b) > available(a) ? 1 : available(b) < available(a) ? -1 : 0));
}

/** Available everywhere added up. Useful for purchasing. Useless for dispatch. */
export const totalAvailable = (levels: readonly StockLevel[], itemId: string): Quantity =>
  levels.filter((l) => l.itemId === itemId).reduce((total, l) => total + available(l), ZERO_QUANTITY);

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every decision below either succeeds or refuses, and a refusal carries the
 * numbers a person needs to do something about it. "Insufficient stock" on its
 * own sends somebody to go and look; "3 requested, 1 available at Warehouse, 2
 * on Van 4" tells them what to do next.
 */
export type InventoryRefusal =
  | { ok: false; reason: "not_positive"; detail: string }
  | { ok: false; reason: "insufficient_available"; itemId: string; locationId: string; requested: Quantity; availableNow: Quantity; shortfall: Quantity }
  | { ok: false; reason: "insufficient_on_hand"; itemId: string; locationId: string; requested: Quantity; onHand: Quantity; shortfall: Quantity }
  | { ok: false; reason: "would_strand_commitment"; itemId: string; locationId: string; requested: Quantity; onHand: Quantity; committed: Quantity }
  | { ok: false; reason: "same_location"; locationId: string }
  | { ok: false; reason: "missing_cost"; itemId: string; locationId: string; kind: MovementKind }
  | { ok: false; reason: "insufficient_layers"; itemId: string; locationId: string; requested: Quantity; costable: Quantity; movementId: string }
  | { ok: false; reason: "currency_mismatch"; itemId: string; expected: CurrencyCode; found: CurrencyCode }
  | { ok: false; reason: "unpaired_transfer"; transferId: string; half: "out" | "in" }
  | { ok: false; reason: "transfer_quantity_mismatch"; transferId: string; sent: Quantity; arrived: Quantity }
  | { ok: false; reason: "illegal_transition"; from: PurchaseOrderStatus; to: PurchaseOrderStatus }
  | { ok: false; reason: "not_receivable"; purchaseOrderId: string; status: PurchaseOrderStatus }
  | { ok: false; reason: "unknown_line"; purchaseOrderId: string; lineId: string }
  | { ok: false; reason: "over_receipt"; lineId: string; ordered: Quantity; alreadyReceived: Quantity; attempted: Quantity };

/** The refusal in words somebody can act on, in the sentence they would say. */
export function explainRefusal(refusal: InventoryRefusal): string {
  switch (refusal.reason) {
    case "not_positive":
      return refusal.detail;
    case "insufficient_available":
      return (
        `Only ${quantityLabel(refusal.availableNow)} of ${refusal.itemId} is available at ${refusal.locationId}, ` +
        `and ${quantityLabel(refusal.requested)} was asked for. Short by ${quantityLabel(refusal.shortfall)}. ` +
        `Some of what is on the shelf is already reserved for another job: release that reservation, take it from another location, or order more.`
      );
    case "insufficient_on_hand":
      return (
        `There is ${quantityLabel(refusal.onHand)} of ${refusal.itemId} at ${refusal.locationId} and ` +
        `${quantityLabel(refusal.requested)} was asked for. Short by ${quantityLabel(refusal.shortfall)}. ` +
        `If it is physically there, the count is wrong and wants an adjustment before this will go through.`
      );
    case "would_strand_commitment":
      return (
        `Moving ${quantityLabel(refusal.requested)} of ${refusal.itemId} off ${refusal.locationId} would leave ` +
        `${quantityLabel(refusal.onHand - refusal.requested)} behind against ${quantityLabel(refusal.committed)} already reserved for scheduled jobs. ` +
        `Release a reservation first, or move less.`
      );
    case "same_location":
      return `A transfer needs two different locations. Both ends are ${refusal.locationId}.`;
    case "missing_cost":
      return (
        `${MOVEMENT_EFFECTS[refusal.kind].label} of ${refusal.itemId} at ${refusal.locationId} arrived with no cost on it. ` +
        `Stock that comes in at no cost values itself at zero, and every job that uses it looks more profitable than it was. ` +
        `Enter what it cost, or what it would cost to replace.`
      );
    case "insufficient_layers":
      return (
        `Cannot put a cost on ${quantityLabel(refusal.requested)} of ${refusal.itemId} leaving ${refusal.locationId}: ` +
        `only ${quantityLabel(refusal.costable)} was ever received there. Movement ${refusal.movementId} is out of order or a receipt is missing. ` +
        `Costing it anyway would charge the job zero for a part that was not free.`
      );
    case "currency_mismatch":
      return `Stock of ${refusal.itemId} is held in ${refusal.expected} and a movement arrived in ${refusal.found}.`;
    case "unpaired_transfer":
      return refusal.half === "in"
        ? `Transfer ${refusal.transferId} has stock arriving that never left anywhere. A transfer is two movements and both must exist.`
        : `Transfer ${refusal.transferId} has stock leaving that never arrived. It is in a van somewhere, or it is in nobody's inventory at all.`;
    case "transfer_quantity_mismatch":
      return (
        `Transfer ${refusal.transferId} sent ${quantityLabel(refusal.sent)} and received ${quantityLabel(refusal.arrived)}. ` +
        `The difference has to be recorded as a loss on purpose, not absorbed by a transfer.`
      );
    case "illegal_transition":
      return `A purchase order cannot go from ${PURCHASE_ORDER_STATUS[refusal.from].label} to ${PURCHASE_ORDER_STATUS[refusal.to].label}.`;
    case "not_receivable":
      return (
        `Purchase order ${refusal.purchaseOrderId} is ${PURCHASE_ORDER_STATUS[refusal.status].label} and cannot receive stock. ` +
        `${PURCHASE_ORDER_STATUS[refusal.status].whyNotReceivable ?? ""}`.trim()
      );
    case "unknown_line":
      return `Purchase order ${refusal.purchaseOrderId} has no line ${refusal.lineId}. Receiving something that was never ordered is an adjustment, not a receipt.`;
    case "over_receipt":
      return (
        `Line ${refusal.lineId} is for ${quantityLabel(refusal.ordered)}, ${quantityLabel(refusal.alreadyReceived)} has already arrived, ` +
        `and ${quantityLabel(refusal.attempted)} more is being received. Either the purchase order is wrong and should be amended, ` +
        `or the extra is not ours and should not be in stock. Receiving it anyway creates stock that nobody has a bill for.`
      );
  }
}

// ---------------------------------------------------------------------------
// Decisions that produce movements
// ---------------------------------------------------------------------------

export type MovementDecision = { ok: true; movements: Movement[] } | InventoryRefusal;

const notPositive = (what: string): InventoryRefusal => ({
  ok: false,
  reason: "not_positive",
  detail: `${what} needs a quantity greater than zero. A zero movement is noise in a history somebody will have to read.`,
});

/**
 * Reserve stock for a job without moving it.
 *
 * Refused when it exceeds AVAILABLE, not when it exceeds on hand, and that
 * distinction is the entire point of the module. There are four compressors on
 * the shelf and three are already promised to Thursday's installs: the fourth
 * job gets told no now, in the office, where somebody can order one, instead
 * of at 4pm on Thursday at the property.
 *
 * The refusal carries the shortfall so the caller can turn it straight into a
 * purchase requisition, which is the thing that should happen next.
 */
export function planCommitment(input: {
  level: StockLevel;
  quantity: Quantity;
  jobId: string;
  stamp: MovementStamp;
}): MovementDecision {
  if (input.quantity <= ZERO_QUANTITY) return notPositive("A reservation");

  const availableNow = available(input.level);
  if (input.quantity > availableNow) {
    return {
      ok: false,
      reason: "insufficient_available",
      itemId: input.level.itemId,
      locationId: input.level.locationId,
      requested: input.quantity,
      availableNow,
      shortfall: input.quantity - availableNow,
    };
  }

  return {
    ok: true,
    movements: [
      {
        ...input.stamp,
        itemId: input.level.itemId,
        locationId: input.level.locationId,
        kind: "commit",
        quantity: input.quantity,
        jobId: input.jobId,
      },
    ],
  };
}

/** Give a reservation back. Never refused for quantity: the clamp handles an over release. */
export function planRelease(input: {
  level: StockLevel;
  quantity: Quantity;
  jobId: string;
  stamp: MovementStamp;
}): MovementDecision {
  if (input.quantity <= ZERO_QUANTITY) return notPositive("A release");
  return {
    ok: true,
    movements: [
      {
        ...input.stamp,
        itemId: input.level.itemId,
        locationId: input.level.locationId,
        kind: "release",
        quantity: input.quantity,
        jobId: input.jobId,
      },
    ],
  };
}

/**
 * Consume stock on a job.
 *
 * Checked against ON HAND rather than available, which looks like a hole and
 * is not. The job doing the issuing is almost always the job that holds the
 * reservation, so checking available would refuse a technician the very part
 * that was set aside for them. The protection against two jobs taking the same
 * part lives upstream in `planCommitment`, which is where it belongs: by the
 * time somebody is standing at the shelf with the part in their hand, refusing
 * is theatre.
 */
export function planIssue(input: {
  level: StockLevel;
  quantity: Quantity;
  jobId: string;
  stamp: MovementStamp;
}): MovementDecision {
  if (input.quantity <= ZERO_QUANTITY) return notPositive("An issue");

  if (input.quantity > input.level.onHand) {
    return {
      ok: false,
      reason: "insufficient_on_hand",
      itemId: input.level.itemId,
      locationId: input.level.locationId,
      requested: input.quantity,
      onHand: input.level.onHand,
      shortfall: input.quantity - input.level.onHand,
    };
  }

  return {
    ok: true,
    movements: [
      {
        ...input.stamp,
        itemId: input.level.itemId,
        locationId: input.level.locationId,
        kind: "issue",
        quantity: input.quantity,
        jobId: input.jobId,
      },
    ],
  };
}

/**
 * A TRANSFER IS TWO MOVEMENTS THAT MUST BOTH HAPPEN OR NEITHER.
 *
 * Concretely, for a contractor: three capacitors leave the warehouse and go on
 * Van 4. If only the out half is written, the warehouse is right, the van is
 * wrong, and three capacitors exist in no location at all. Nobody reorders
 * them because the total still looks fine, and they are found nine months
 * later in a door pocket. If only the in half is written, the same three
 * capacitors exist twice, the company believes it has six, and it promises one
 * to a customer it cannot supply.
 *
 * Two things enforce it here. First, this function returns BOTH movements in
 * one array, so there is no shape of the return value that lets a caller write
 * one and not the other: it is a single list to insert in a single
 * transaction. Second, both halves carry the same `transferId`, so the
 * database can carry a constraint that the pair exists and the costing below
 * refuses a history where one half is missing.
 *
 * Checked against AVAILABLE, not on hand, with its own refusal. Moving stock
 * that is reserved for a scheduled job strips the shelf of the part somebody
 * is expecting to find there on Thursday, and the transfer is not obviously to
 * blame when they do not.
 */
export function planTransfer(input: {
  from: StockLevel;
  toLocationId: string;
  quantity: Quantity;
  transferId: string;
  out: MovementStamp;
  in: MovementStamp;
}): MovementDecision {
  if (input.quantity <= ZERO_QUANTITY) return notPositive("A transfer");

  if (input.from.locationId === input.toLocationId) {
    return { ok: false, reason: "same_location", locationId: input.toLocationId };
  }

  if (input.quantity > input.from.onHand) {
    return {
      ok: false,
      reason: "insufficient_on_hand",
      itemId: input.from.itemId,
      locationId: input.from.locationId,
      requested: input.quantity,
      onHand: input.from.onHand,
      shortfall: input.quantity - input.from.onHand,
    };
  }

  if (input.quantity > available(input.from)) {
    return {
      ok: false,
      reason: "would_strand_commitment",
      itemId: input.from.itemId,
      locationId: input.from.locationId,
      requested: input.quantity,
      onHand: input.from.onHand,
      committed: input.from.committed,
    };
  }

  return {
    ok: true,
    movements: [
      {
        ...input.out,
        itemId: input.from.itemId,
        locationId: input.from.locationId,
        kind: "transfer_out",
        quantity: input.quantity,
        transferId: input.transferId,
      },
      {
        ...input.in,
        itemId: input.from.itemId,
        locationId: input.toLocationId,
        kind: "transfer_in",
        quantity: input.quantity,
        transferId: input.transferId,
      },
    ],
  };
}

/**
 * A cycle count. What the shelf says, against what the history says.
 *
 * A count that MATCHES produces no movement at all. That is not an
 * optimisation: a zero adjustment in the history is a line somebody has to
 * read and discount every time they are trying to work out where a part went,
 * and a history full of them is a history nobody reads.
 *
 * A count that found MORE needs a cost, because stock cannot enter the world
 * for free. See `missing_cost`: an adjustment that adds a part at zero makes
 * the next job that uses it look like it had no material cost, and that is a
 * margin number somebody will price against.
 */
export function reconcileCount(input: {
  level: StockLevel;
  counted: Quantity;
  stamp: MovementStamp;
  reasonCode: string;
  /** Required only when the count found more than the history expected. */
  foundAtCost?: Money | undefined;
}): MovementDecision {
  const difference = input.counted - input.level.onHand;
  if (difference === ZERO_QUANTITY) return { ok: true, movements: [] };

  if (difference > ZERO_QUANTITY) {
    if (!input.foundAtCost) {
      return {
        ok: false,
        reason: "missing_cost",
        itemId: input.level.itemId,
        locationId: input.level.locationId,
        kind: "adjustment_in",
      };
    }
    return {
      ok: true,
      movements: [
        {
          ...input.stamp,
          itemId: input.level.itemId,
          locationId: input.level.locationId,
          kind: "adjustment_in",
          quantity: difference,
          totalCost: input.foundAtCost,
          reasonCode: input.reasonCode,
        },
      ],
    };
  }

  return {
    ok: true,
    movements: [
      {
        ...input.stamp,
        itemId: input.level.itemId,
        locationId: input.level.locationId,
        kind: "adjustment_out",
        quantity: -difference,
        reasonCode: input.reasonCode,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Costing
// ---------------------------------------------------------------------------

export type CostingMethod = "average" | "fifo";

/**
 * Both methods are defensible, both are wrong about something, and a company
 * should be told which lie it is choosing rather than discovering it during an
 * audit. These strings are meant to be shown in the settings screen next to
 * the choice.
 */
export const COSTING_METHODS: Record<
  CostingMethod,
  { label: string; howItWorks: string; whatItIsWrongAbout: string }
> = {
  average: {
    label: "Average cost",
    howItWorks:
      "Everything received into a location goes into one pool. An issue takes its share of the pool, so every unit of a part costs the same at any moment.",
    whatItIsWrongAbout:
      "It smooths away a price spike. Buy a compressor at 900 in a shortage when you have four at 500, and the next job you do is costed at 580 whichever compressor physically went in the truck. The job that ate the expensive one looks fine and the four cheap jobs after it each look slightly worse than they were, so no single job ever shows you that your buying price moved.",
  },
  fifo: {
    label: "FIFO, first in first out",
    howItWorks:
      "Each receipt stays its own layer with its own cost. An issue consumes the oldest layer first, and spans into the next one when the oldest runs out.",
    whatItIsWrongAbout:
      "In a rising market it charges today's jobs last year's prices. Margin looks better than it is right now, the expensive stock sits on the balance sheet, and the correction lands in a later month with no job to attach it to. It also depends entirely on movements being in the right order, which is a real operational burden the average method does not have.",
  },
};

/**
 * A COST LAYER HOLDS A REMAINING TOTAL, NOT A UNIT COST.
 *
 * This is the most important line in the costing section and it is easy to
 * skim past. Three condensate pumps arrive on one line for 100.00. Their unit
 * cost is 33.3333..., which is not a number that exists at any precision. Any
 * system that stores a unit cost has already lost: issue the three pumps one
 * at a time at 33.33 and the job costs total 99.99, leaving a penny in the
 * inventory account attached to zero units of a part, forever, on every
 * receipt that does not divide. Multiply that by a year of deliveries and the
 * inventory account and the general ledger disagree by an amount nobody can
 * explain or write off cleanly.
 *
 * So the layer holds what is LEFT of the money and what is LEFT of the
 * quantity, and taking part of it ALLOCATES: `allocate(cost, [taken, kept])`
 * splits without inventing or losing a unit, by construction, at any split, to
 * any depth. Consume the whole layer in any sequence of partial takes and the
 * costs sum back to exactly what was paid.
 */
export interface CostLayer {
  /** The receipt that created it. For average costing this is the oldest receipt in the pool. */
  readonly receiptMovementId: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly sequence: number;
  readonly occurredAt: Date;
  /** What is left of it. */
  readonly quantity: Quantity;
  /** What is left of what it cost. Not a unit cost. Never a unit cost. */
  readonly cost: Money;
}

export const layerValue = (layers: readonly CostLayer[], currency: CurrencyCode = "USD"): Money =>
  layers.reduce((total, layer) => add(total, layer.cost), zero(layers[0]?.cost.currency ?? currency));

/**
 * For a screen only, and never fed back into a calculation.
 *
 * The same warning `money.format` carries. This is what a buyer wants to see
 * next to a part so they can tell whether today's quote is out of line. It is
 * a division and it is therefore approximate, and the cost of any actual issue
 * comes from `consumeLayers`, which does not divide.
 */
export function approximateUnitCost(layer: CostLayer): Money {
  if (layer.quantity === ZERO_QUANTITY) return zero(layer.cost.currency);
  return divide(layer.cost, quantityToString(layer.quantity));
}

const totalLayerQuantity = (layers: readonly CostLayer[]): Quantity =>
  layers.reduce((total, layer) => total + layer.quantity, ZERO_QUANTITY);

/**
 * Take a slice out of one layer without creating or destroying a unit of money.
 *
 * Taking the WHOLE layer takes the whole remaining cost with no arithmetic at
 * all, which matters: it means a layer can never leave a residue behind when
 * it empties.
 *
 * Taking PART of it allocates the remaining cost across [what leaves, what
 * stays]. Because the two parts always sum back to the layer's cost, the
 * invariant holds through any number of partial takes: consume three units
 * received for 100.00 one at a time and the three issue costs sum to exactly
 * 100.0000, not 99.9999.
 */
function takeFromLayer(layer: CostLayer, want: Quantity): { taken: Money; rest: CostLayer | null } {
  if (want >= layer.quantity) return { taken: layer.cost, rest: null };

  const parts = allocate(layer.cost, [quantityToString(want), quantityToString(layer.quantity - want)]);
  const taken = parts[0] ?? zero(layer.cost.currency);
  const kept = parts[1] ?? zero(layer.cost.currency);

  return {
    taken,
    rest: { ...layer, quantity: layer.quantity - want, cost: kept },
  };
}

/**
 * Collapse every layer at a location into one pool. Average costing, which is
 * FIFO with a single layer, and writing it that way rather than as a second
 * algorithm means there is one piece of allocation arithmetic in this file
 * instead of two that have to be kept in agreement.
 */
function poolLayers(layers: readonly CostLayer[]): CostLayer[] {
  const first = layers[0];
  if (!first || layers.length === 1) return [...layers];
  return [
    {
      ...first,
      quantity: totalLayerQuantity(layers),
      cost: layers.slice(1).reduce((total, layer) => add(total, layer.cost), first.cost),
    },
  ];
}

/**
 * Oldest layer first, by the same rule the movement ledger is read in.
 *
 * Sorting by sequence alone would be a quiet bug: a delivery entered on
 * Thursday for parts that arrived on Monday gets a LATER sequence and an
 * EARLIER date, and FIFO would then consume Tuesday's expensive layer before
 * Monday's cheap one. One comparator, one answer.
 */
const byLayerAge = (a: CostLayer, b: CostLayer): number => {
  const at = a.occurredAt.getTime();
  const bt = b.occurredAt.getTime();
  if (at !== bt) return at - bt;
  return a.sequence - b.sequence;
};

export interface LayerConsumption {
  readonly receiptMovementId: string;
  readonly quantity: Quantity;
  readonly cost: Money;
}

export type ConsumeResult =
  | { ok: true; cost: Money; consumed: LayerConsumption[]; layers: CostLayer[] }
  | InventoryRefusal;

/**
 * Take `want` units out of a location's layers and say what they cost.
 *
 * The refusal is the interesting part. If the layers do not hold enough, that
 * is not a rounding problem to paper over: either a receipt was never entered,
 * or a movement is being costed before the receipt that supplies it. Returning
 * zero, or a partial cost, or the average of what is left, all produce a job
 * that looks cheaper than it was, and a margin report built on it is worse
 * than no margin report because somebody will price against it.
 */
export function consumeLayers(
  layers: readonly CostLayer[],
  want: Quantity,
  method: CostingMethod,
  context: { itemId: string; locationId: string; movementId: string; currency: CurrencyCode },
): ConsumeResult {
  if (want <= ZERO_QUANTITY) return notPositive("Costing a movement");

  const costable = totalLayerQuantity(layers);
  if (want > costable) {
    return {
      ok: false,
      reason: "insufficient_layers",
      itemId: context.itemId,
      locationId: context.locationId,
      requested: want,
      costable,
      movementId: context.movementId,
    };
  }

  const ordered = method === "average" ? poolLayers(layers) : [...layers].sort(byLayerAge);

  const consumed: LayerConsumption[] = [];
  const remaining: CostLayer[] = [];
  let outstanding = want;
  let cost = zero(context.currency);

  for (const layer of ordered) {
    if (outstanding === ZERO_QUANTITY) {
      remaining.push(layer);
      continue;
    }
    if (layer.cost.currency !== context.currency) {
      return {
        ok: false,
        reason: "currency_mismatch",
        itemId: context.itemId,
        expected: context.currency,
        found: layer.cost.currency,
      };
    }
    const take = qtyMin(outstanding, layer.quantity);
    const { taken, rest } = takeFromLayer(layer, take);
    consumed.push({ receiptMovementId: layer.receiptMovementId, quantity: take, cost: taken });
    cost = add(cost, taken);
    outstanding -= take;
    if (rest) remaining.push(rest);
  }

  return { ok: true, cost, consumed, layers: remaining };
}

export interface CostedIssue {
  readonly movementId: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: Quantity;
  readonly cost: Money;
  readonly jobId?: string | undefined;
}

export type CostRun =
  | { ok: true; issues: CostedIssue[]; layers: CostLayer[]; value: Money }
  | InventoryRefusal;

/**
 * Walk the whole history in ledger order and cost it.
 *
 * Deliberately a REPLAY of everything rather than an incremental update to a
 * stored cost. A backdated receipt legitimately changes what a later issue
 * cost, and the only honest way to find that out is to run it again and
 * compare against what was posted. An incremental costing engine cannot even
 * detect the case, so it keeps the old answer and the inventory account drifts
 * away from the sum of its layers with nothing to point at.
 *
 * Transfers are costed as one thing across their two halves: the out leg
 * consumes layers at the source and hands the exact cost to the in leg, so
 * value moves with the parts. Valuing the in leg at the destination's average
 * instead would let a company manufacture or destroy inventory value by
 * shuffling parts between its own vans.
 */
export function costMovements(input: {
  movements: readonly Movement[];
  method: CostingMethod;
  currency?: CurrencyCode | undefined;
}): CostRun {
  const currency = input.currency ?? "USD";
  const byLocation = new Map<string, CostLayer[]>();
  const inFlight = new Map<string, { quantity: Quantity; cost: Money }>();
  const issues: CostedIssue[] = [];

  const push = (movement: Movement, cost: Money) => {
    const key = levelKey(movement.itemId, movement.locationId);
    const layers = byLocation.get(key) ?? [];
    layers.push({
      receiptMovementId: movement.id,
      itemId: movement.itemId,
      locationId: movement.locationId,
      sequence: movement.sequence,
      occurredAt: movement.occurredAt,
      quantity: movement.quantity,
      cost,
    });
    byLocation.set(key, layers);
  };

  const take = (movement: Movement): ConsumeResult => {
    const key = levelKey(movement.itemId, movement.locationId);
    const result = consumeLayers(byLocation.get(key) ?? [], movement.quantity, input.method, {
      itemId: movement.itemId,
      locationId: movement.locationId,
      movementId: movement.id,
      currency,
    });
    if (result.ok) byLocation.set(key, result.layers);
    return result;
  };

  for (const movement of orderedMovements(input.movements)) {
    switch (movement.kind) {
      // Reservations move no stock and therefore no money.
      case "commit":
      case "release":
        break;

      case "receipt":
      case "return_to_stock":
      case "adjustment_in": {
        const cost = movement.totalCost;
        if (!cost) {
          return { ok: false, reason: "missing_cost", itemId: movement.itemId, locationId: movement.locationId, kind: movement.kind };
        }
        if (cost.currency !== currency) {
          return { ok: false, reason: "currency_mismatch", itemId: movement.itemId, expected: currency, found: cost.currency };
        }
        push(movement, cost);
        break;
      }

      case "transfer_out": {
        if (!movement.transferId) {
          return { ok: false, reason: "unpaired_transfer", transferId: movement.id, half: "out" };
        }
        const result = take(movement);
        if (!result.ok) return result;
        inFlight.set(movement.transferId, { quantity: movement.quantity, cost: result.cost });
        break;
      }

      case "transfer_in": {
        if (!movement.transferId) {
          return { ok: false, reason: "unpaired_transfer", transferId: movement.id, half: "in" };
        }
        const sent = inFlight.get(movement.transferId);
        if (!sent) {
          return { ok: false, reason: "unpaired_transfer", transferId: movement.transferId, half: "in" };
        }
        if (sent.quantity !== movement.quantity) {
          return {
            ok: false,
            reason: "transfer_quantity_mismatch",
            transferId: movement.transferId,
            sent: sent.quantity,
            arrived: movement.quantity,
          };
        }
        inFlight.delete(movement.transferId);
        push(movement, sent.cost);
        break;
      }

      case "issue": {
        const result = take(movement);
        if (!result.ok) return result;
        issues.push({
          movementId: movement.id,
          itemId: movement.itemId,
          locationId: movement.locationId,
          quantity: movement.quantity,
          cost: result.cost,
          jobId: movement.jobId,
        });
        break;
      }

      case "scrap":
      case "return_to_vendor":
      case "adjustment_out": {
        const result = take(movement);
        if (!result.ok) return result;
        break;
      }
    }
  }

  /**
   * An out leg with no in leg. The parts left a location and arrived nowhere,
   * so they are in somebody's van and in nobody's inventory. Refused here
   * rather than tolerated, because the value has genuinely left the balance
   * sheet and the total will look plausible while being wrong.
   */
  const orphan = [...inFlight.keys()][0];
  if (orphan !== undefined) {
    return { ok: false, reason: "unpaired_transfer", transferId: orphan, half: "out" };
  }

  const layers = [...byLocation.values()].flat();
  return { ok: true, issues, layers, value: layerValue(layers, currency) };
}

/**
 * What material each job actually consumed, in money.
 *
 * This is the number that goes to the ledger as the COGS debit and the
 * inventory credit, and it is returned as an AMOUNT rather than as a posting
 * on purpose. `ledger.ts` is the only module that knows how to build a
 * balanced set of entries; a second one here would be a second truth, and
 * within a year the two would round differently.
 */
export function cogsByJob(issues: readonly CostedIssue[], currency: CurrencyCode = "USD"): Map<string, Money> {
  const byJob = new Map<string, Money>();
  for (const issue of issues) {
    if (!issue.jobId) continue;
    byJob.set(issue.jobId, add(byJob.get(issue.jobId) ?? zero(currency), issue.cost));
  }
  return byJob;
}

/**
 * Freight, fuel surcharge and handling, spread over what arrived.
 *
 * A company that books freight to an expense account believes its parts cost
 * less than they did, and prices off that belief. Fifty dollars of delivery on
 * a four hundred dollar order is twelve percent, and twelve percent is most of
 * a trade's net margin.
 *
 * Allocated by value, not by piece count, because a delivery of one furnace
 * and forty screws did not incur its freight equally. Allocated at cent
 * precision because these shares land on a vendor bill somebody reconciles
 * line by line. If every line is zero value, which happens on a warranty
 * replacement shipment, it falls back to an even split rather than throwing:
 * the freight is real and has to land somewhere.
 */
export function allocateLandedCost(
  extra: Money,
  lines: readonly { lineId: string; value: Money }[],
): { lineId: string; share: Money }[] {
  if (lines.length === 0) return [];
  if (isZero(extra)) return lines.map((line) => ({ lineId: line.lineId, share: zero(extra.currency) }));

  const anyValue = lines.some((line) => !isZero(line.value));
  const ratios = anyValue ? lines.map((line) => moneyToString(line.value)) : lines.map(() => "1");
  const shares = allocate(extra, ratios, 2);

  return lines.map((line, index) => ({
    lineId: line.lineId,
    share: shares[index] ?? zero(extra.currency),
  }));
}

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

/**
 * Reorder point and reorder quantity, PER ITEM PER LOCATION.
 *
 * Per location because the right answer differs: a warehouse holds two spare
 * blower motors, a van holds none and a van holds six of the capacitor that
 * fails on every third call. One company wide minimum forces the same policy
 * on both and is ignored within a month.
 */
export interface ReorderPolicy {
  readonly itemId: string;
  readonly locationId: string;
  /** At or below this, buy. */
  readonly reorderPoint: Quantity;
  /** The smallest sensible order. A vendor minimum, a case, a spool. */
  readonly reorderQuantity: Quantity;
  /** Optional ceiling. Set it and the suggestion tops up to here instead of buying one lot. */
  readonly maximumQuantity?: Quantity | undefined;
}

/** Ordered and not yet arrived. Derived from purchase orders by `onOrderFrom`. */
export interface OnOrderLine {
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: Quantity;
  readonly purchaseOrderId: string;
  readonly expectedAt?: Date | undefined;
}

export interface ReorderSuggestion {
  readonly itemId: string;
  readonly locationId: string;
  readonly availableNow: Quantity;
  readonly onOrder: Quantity;
  /** Available plus on order. The number the reorder point is actually compared against. */
  readonly position: Quantity;
  readonly reorderPoint: Quantity;
  readonly suggested: Quantity;
  readonly overdue: OnOrderLine[];
  readonly why: string;
}

/**
 * What to buy.
 *
 * THE FAILURE THIS PREVENTS, and it is a specific one that every contractor
 * who has used a replenishment feature has lived through: the system compares
 * stock on hand against the reorder point, sees it is low, and suggests an
 * order. Somebody places it. Tomorrow night nothing has arrived yet, stock is
 * still low, and it suggests the same order again. And again. Twelve days
 * later twelve blower motors arrive and the money is gone until they sell,
 * which for a slow part is never.
 *
 * The fix is one word: POSITION. Compare the reorder point against available
 * PLUS what is already on order, not against what is on the shelf. Everything
 * else here is detail.
 *
 * Two smaller decisions worth naming. Available rather than on hand, because
 * stock reserved for Thursday's job is not stock you have. And `now` is passed
 * in so a purchase order that is late can be flagged as late: a suggestion
 * that says "5 on order, expected nine days ago" prompts a phone call to the
 * vendor, which is nearly always the correct action and never the one an
 * automatic reorder takes.
 */
export function suggestReorders(input: {
  policies: readonly ReorderPolicy[];
  levels: readonly StockLevel[];
  onOrder: readonly OnOrderLine[];
  now: Date;
}): ReorderSuggestion[] {
  const suggestions: ReorderSuggestion[] = [];

  for (const policy of input.policies) {
    const level =
      input.levels.find((l) => l.itemId === policy.itemId && l.locationId === policy.locationId) ??
      emptyLevel(policy.itemId, policy.locationId);
    const availableNow = available(level);

    const openLines = input.onOrder.filter(
      (line) => line.itemId === policy.itemId && line.locationId === policy.locationId,
    );
    const onOrder = openLines.reduce((total, line) => total + line.quantity, ZERO_QUANTITY);
    const position = availableNow + onOrder;

    if (position > policy.reorderPoint) continue;

    /**
     * Top up to the maximum when there is one, otherwise buy one lot above the
     * reorder point. Never less than one reorder quantity: a vendor minimum
     * and a delivery charge make a two unit order cost more than a five unit
     * one, and a replenishment system that suggests dribbles gets switched off.
     */
    const target = policy.maximumQuantity ?? policy.reorderPoint + policy.reorderQuantity;
    const suggested = qtyMax(target - position, policy.reorderQuantity);

    const overdue = openLines.filter((line) => line.expectedAt !== undefined && line.expectedAt.getTime() < input.now.getTime());

    suggestions.push({
      itemId: policy.itemId,
      locationId: policy.locationId,
      availableNow,
      onOrder,
      position,
      reorderPoint: policy.reorderPoint,
      suggested,
      overdue,
      why:
        onOrder > ZERO_QUANTITY
          ? `${quantityLabel(availableNow)} available and ${quantityLabel(onOrder)} already on order is still at or below the reorder point of ${quantityLabel(policy.reorderPoint)}.`
          : `${quantityLabel(availableNow)} available against a reorder point of ${quantityLabel(policy.reorderPoint)}, with nothing on order.`,
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export type PurchaseOrderStatus =
  | "draft"
  | "submitted"
  | "acknowledged"
  | "partially_received"
  | "received"
  | "cancelled";

export const PURCHASE_ORDER_STATUS: Record<
  PurchaseOrderStatus,
  { label: string; meaning: string; countsAsOnOrder: boolean; whyNotReceivable?: string }
> = {
  draft: {
    label: "Draft",
    meaning: "Being written. The vendor has never seen it and owes us nothing.",
    countsAsOnOrder: false,
    whyNotReceivable: "It has not been sent to the vendor, so nothing can have arrived against it. Submit it first.",
  },
  submitted: {
    label: "Submitted",
    meaning: "Sent to the vendor. We are expecting it; they have not said so yet.",
    countsAsOnOrder: true,
  },
  acknowledged: {
    label: "Acknowledged",
    meaning: "The vendor confirmed it, usually with a promise date. The strongest signal before anything ships.",
    countsAsOnOrder: true,
  },
  partially_received: {
    label: "Partially received",
    meaning: "Some of it arrived. The rest is still owed to us and is still on order.",
    countsAsOnOrder: true,
  },
  received: {
    label: "Received",
    meaning: "All of it arrived. Nothing is outstanding and it no longer affects what to buy.",
    countsAsOnOrder: false,
    whyNotReceivable: "Everything on it has already arrived. More stock from this vendor is a new purchase order.",
  },
  cancelled: {
    label: "Cancelled",
    meaning: "Closed without the rest arriving, whether or not part of it did.",
    countsAsOnOrder: false,
    whyNotReceivable: "It was cancelled. Anything that turns up against it is either a new order or a vendor mistake.",
  },
};

/**
 * Which transitions are legal.
 *
 * Two that deserve their reasons written down.
 *
 * SUBMITTED CAN GO STRAIGHT TO RECEIVED. Plenty of vendors never acknowledge
 * anything; the parts simply show up on the truck. Forcing an acknowledgement
 * step means the receiving clerk has to click a lie before they can do their
 * job, and a workflow that makes people lie to proceed is a workflow that
 * stops being evidence of anything.
 *
 * PARTIALLY RECEIVED CAN GO TO CANCELLED. This is the short shipment: three of
 * five arrived, the vendor discontinued the part, and the remaining two are
 * never coming. Cancelling has to close out the REMAINDER while leaving the
 * three that arrived in stock and on the bill. If cancelling meant reversing
 * the whole order, the three would vanish from inventory while still sitting
 * on the shelf.
 *
 * RECEIVED IS TERMINAL. Parts going back are a return to vendor with a credit,
 * which is its own movement and its own money. Re-opening the purchase order
 * instead would rewrite history, and the vendor bill that was matched against
 * it would stop matching.
 */
export const LEGAL_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["acknowledged", "partially_received", "received", "cancelled"],
  acknowledged: ["partially_received", "received", "cancelled"],
  partially_received: ["partially_received", "received", "cancelled"],
  received: [],
  cancelled: [],
};

export const canTransition = (from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean =>
  LEGAL_TRANSITIONS[from].includes(to);

export interface PurchaseOrderLine {
  readonly id: string;
  readonly itemId: string;
  /** Where it is going. A purchase order can be delivered straight to a van. */
  readonly locationId: string;
  readonly quantityOrdered: Quantity;
  readonly quantityReceived: Quantity;
  readonly unitPrice: Money;
}

export interface PurchaseOrder {
  readonly id: string;
  readonly vendorId: string;
  readonly status: PurchaseOrderStatus;
  readonly lines: readonly PurchaseOrderLine[];
  readonly expectedAt?: Date | undefined;
  readonly submittedAt?: Date | undefined;
  readonly closedAt?: Date | undefined;
}

/**
 * What is still owed to us on a line. Ordered minus received, never negative.
 *
 * This one small function is the whole of partial receipt handling, and
 * getting it wrong goes wrong in both directions. Treat a partially received
 * purchase order as fully received and the remaining two are dropped: nobody
 * chases the vendor, and the reorder engine buys them again. Treat it as not
 * received at all and the three that did arrive are counted as still on order
 * as well as in stock, so the company thinks it has six.
 */
export const outstandingOf = (line: PurchaseOrderLine): Quantity =>
  qtyMax(ZERO_QUANTITY, line.quantityOrdered - line.quantityReceived);

/**
 * What is genuinely on order, for the reorder engine.
 *
 * Draft counts for nothing. A purchase order sitting in somebody's drafts is
 * not stock arriving, and counting it means the reorder engine goes quiet
 * about a part nobody ever actually ordered. Cancelled and received count for
 * nothing either, for the opposite reason, and forgetting to exclude received
 * is the other half of the twelve blower motors problem: the engine sees five
 * on order forever and never buys again.
 */
export function onOrderFrom(purchaseOrders: readonly PurchaseOrder[]): OnOrderLine[] {
  const lines: OnOrderLine[] = [];
  for (const po of purchaseOrders) {
    if (!PURCHASE_ORDER_STATUS[po.status].countsAsOnOrder) continue;
    for (const line of po.lines) {
      const outstanding = outstandingOf(line);
      if (outstanding === ZERO_QUANTITY) continue;
      lines.push({
        itemId: line.itemId,
        locationId: line.locationId,
        quantity: outstanding,
        purchaseOrderId: po.id,
        ...(po.expectedAt ? { expectedAt: po.expectedAt } : {}),
      });
    }
  }
  return lines;
}

export type PurchaseOrderDecision = { ok: true; purchaseOrder: PurchaseOrder } | InventoryRefusal;

export function transitionPurchaseOrder(
  purchaseOrder: PurchaseOrder,
  to: PurchaseOrderStatus,
  now: Date,
): PurchaseOrderDecision {
  if (!canTransition(purchaseOrder.status, to)) {
    return { ok: false, reason: "illegal_transition", from: purchaseOrder.status, to };
  }
  return {
    ok: true,
    purchaseOrder: {
      ...purchaseOrder,
      status: to,
      ...(to === "submitted" ? { submittedAt: now } : {}),
      ...(to === "cancelled" || to === "received" ? { closedAt: now } : {}),
    },
  };
}

export interface ReceiptLine {
  readonly lineId: string;
  readonly quantity: Quantity;
  readonly movement: MovementStamp;
}

export type ReceiveDecision =
  | { ok: true; purchaseOrder: PurchaseOrder; movements: Movement[] }
  | InventoryRefusal;

/**
 * Receive stock against a purchase order.
 *
 * THE PARTIAL RECEIPT, which is the case everything turns on. Five condensate
 * pumps are ordered and three arrive. After this call the line reads three
 * received and two outstanding, the purchase order reads partially received,
 * three pumps exist as stock with the cost they were bought at, and two pumps
 * are still counted as on order so the reorder engine leaves them alone. When
 * the last two turn up, the same function is called again, the line closes,
 * the order becomes received, and it stops counting as on order at all.
 *
 * Get this wrong in one direction and the stock is double counted. Get it
 * wrong in the other and the company loses track of what a vendor still owes
 * them, which is money, and nobody notices because there is nothing on a
 * report that says "two pumps we paid for and never got".
 *
 * Over receipt is REFUSED rather than absorbed. Six arriving against an order
 * for five is either a vendor error or an order that was amended by phone and
 * never amended in the system. Both want a human: absorbing it quietly creates
 * stock that no bill will ever match, and three way matching then fails a
 * month later with no clue as to why.
 */
export function receivePurchaseOrder(input: {
  purchaseOrder: PurchaseOrder;
  receipts: readonly ReceiptLine[];
  now: Date;
}): ReceiveDecision {
  const po = input.purchaseOrder;

  if (po.status === "draft" || po.status === "received" || po.status === "cancelled") {
    return { ok: false, reason: "not_receivable", purchaseOrderId: po.id, status: po.status };
  }

  const movements: Movement[] = [];
  const receivedNow = new Map<string, Quantity>();

  for (const receipt of input.receipts) {
    if (receipt.quantity <= ZERO_QUANTITY) return notPositive("A receipt");

    const line = po.lines.find((l) => l.id === receipt.lineId);
    if (!line) return { ok: false, reason: "unknown_line", purchaseOrderId: po.id, lineId: receipt.lineId };

    const already = line.quantityReceived + (receivedNow.get(line.id) ?? ZERO_QUANTITY);
    if (already + receipt.quantity > line.quantityOrdered) {
      return {
        ok: false,
        reason: "over_receipt",
        lineId: line.id,
        ordered: line.quantityOrdered,
        alreadyReceived: already,
        attempted: receipt.quantity,
      };
    }
    receivedNow.set(line.id, already - line.quantityReceived + receipt.quantity);

    movements.push({
      ...receipt.movement,
      itemId: line.itemId,
      locationId: line.locationId,
      kind: "receipt",
      quantity: receipt.quantity,
      /**
       * A TOTAL, not a unit price, even though this one came from a unit
       * price and divides perfectly. The layer downstream only ever holds
       * totals, and handing it a total here means there is one shape of
       * receipt rather than two, so the lot priced delivery and the unit
       * priced one go down the same path.
       */
      totalCost: multiply(line.unitPrice, quantityToString(receipt.quantity)),
      purchaseOrderId: po.id,
      purchaseOrderLineId: line.id,
    });
  }

  const lines = po.lines.map((line) => {
    const extra = receivedNow.get(line.id);
    return extra === undefined ? line : { ...line, quantityReceived: line.quantityReceived + extra };
  });

  const complete = lines.every((line) => outstandingOf(line) === ZERO_QUANTITY);
  const status: PurchaseOrderStatus = complete ? "received" : "partially_received";

  if (!canTransition(po.status, status)) {
    return { ok: false, reason: "illegal_transition", from: po.status, to: status };
  }

  return {
    ok: true,
    purchaseOrder: {
      ...po,
      lines,
      status,
      ...(complete ? { closedAt: input.now } : {}),
    },
    movements,
  };
}

/** Everything still owed by a vendor, for chasing. The other side of a partial receipt. */
export function outstandingValue(purchaseOrder: PurchaseOrder, currency: CurrencyCode = "USD"): Money {
  return purchaseOrder.lines.reduce((total, line) => {
    const outstanding = outstandingOf(line);
    if (outstanding === ZERO_QUANTITY) return total;
    return add(total, multiply(line.unitPrice, quantityToString(outstanding)));
  }, zero(currency));
}
