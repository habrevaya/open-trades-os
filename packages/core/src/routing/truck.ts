/**
 * A ROLL OFF DRIVER'S DAY, ORDERED BY WHAT IS ON THE TRUCK
 *
 * The dumpster pack says it in its own job types: the order of a driver's
 * day is decided by what is on the truck and what has to come back on it.
 * A drop needs an empty container on the truck. A collection needs room on
 * it, and once the full can is hooked the truck goes to the yard to tip it
 * before it can take anything else. A swap needs an empty on the truck and
 * leaves with a full one. `optimise` knows none of that: it would happily
 * send a driver from a collection straight to a drop with a full can on the
 * hook and nothing to drop.
 *
 * THE MODEL, said plainly because a dispatcher will check it by hand:
 *
 *  - The truck carries `capacity` containers (one for nearly every roll off
 *    truck, two or three for a hook lift moving small cans).
 *  - At the yard everything full is tipped and the truck is loaded with as
 *    many empties as lets it work through the most of the stops that follow
 *    before it has to come back; the fewest that does so on a tie.
 *  - A stop the truck cannot serve as it is (a drop with no empty on board,
 *    a collection with no room) is reached by way of the yard, and the yard
 *    run's drive and its minutes there count like any other drive.
 *  - A dump and return needs room for the can and brings the same can back;
 *    its trip to the facility is inside the job's own length, as the pack's
 *    seventy five minutes are, and is not counted twice.
 *  - The day ends at the yard, so a full can on board at the end is tipped.
 *
 * THE FACILITY IS A PLACE. A full can is tipped at a disposal facility, not at
 * the yard, and a plan that is given one (`TruckPlan.facility`) sends the
 * truck there with any full can before it needs an empty or the day ends:
 * yard to customer to facility to the next stop. What it tips there comes
 * back as an empty on the same truck, so a drop straight after needs no run
 * to the yard; a collection still needs room, which only the yard gives. The
 * facility has hours: a truck that arrives before it opens waits at the gate,
 * and one that arrives after it closes is a run the plan REFUSES, counted
 * with the broken windows so the search drives further to avoid it, and named
 * on the proposal. With no facility, the yard tips, exactly as before.
 *
 * SEVERAL FACILITIES ARE CHOSEN AMONG, HAUL BY HAUL (`TruckPlan.facilities`).
 * A company with two transfer stations and a landfill does not send every
 * can to the default: each run goes to the nearest one that is open when the
 * truck gets there, by the same drive times the rest of the plan uses, from
 * wherever the truck is at that point of the day. One shut that day (its
 * hours, or a holiday it keeps) is skipped, and so is one the truck would
 * reach after it has closed. A gate that has not opened yet counts from when
 * it opens, so it wins only when waiting for it still gets the can tipped
 * sooner than driving to another. When none is open the nearest is still
 * chosen, and the run is refused and named exactly as a single facility is,
 * so the search drives further to avoid it. Each run says which it chose and
 * what it passed over, so the day's plan can say why.
 *
 * WHAT A FACILITY TAKES, AND WHAT IT CHARGES. A facility that lists the
 * materials it takes is left out of a run whose full cans hold one it does
 * not take (a facility whose list nobody recorded, and a can of no known
 * material, are never a reason to leave one out). When none takes everything
 * on the truck, the nearest is named and the run is refused, counted with the
 * closed gates. Among the ones open, the fee is weighed beside the time when
 * the company has said what an hour of the truck costs and every one of them
 * can say what it would charge for the load: the cost of a run is its fee
 * plus the minutes until the can is tipped at that hour's price, and the
 * cheapest all told wins. When any of that is missing the fee is not weighed
 * at all and the run says why, because comparing a known fee with an unknown
 * one would favour the facility that knows less. The fee moves which facility
 * a run goes to, never the order of the stops.
 *
 * EACH TRUCK IS ITS OWN KIND. A hook lift that carries two small cans and
 * a roll off truck that carries one big one are not the same truck, and a
 * company's one figure is only the default for a truck nobody has given a
 * kind. `truckFigures` says which figures a plan runs on and where they
 * came from; a stop whose container is a size the truck does not carry is
 * not served by it, and is left out of the truck's arithmetic and named on
 * the proposal rather than driven as if the truck could lift it.
 *
 * A KIND CAN CARRY A DIFFERENT NUMBER OF EACH SIZE. "Two 10 yard or one 30
 * yard" is the deck of a hook lift, and a load is checked by size: each can
 * takes its share of the deck (a 10 yard half of it, a 30 yard all of it),
 * and a load fits while the shares add up to the whole deck or less, so a
 * 10 yard and a 30 yard together do not. A can of a size not given its own
 * figure, or of no known size, takes the kind's one figure's share. A drop
 * needs an empty of its own size on board (an empty of no known size will
 * do), so a 30 yard tipped at the facility is not dropped as a 10 yard. A
 * kind with one figure and cans of no known size is exactly the counting
 * above.
 *
 * The search is `optimise`'s own (nearest neighbour in time, then 2-opt and
 * or-opt, windows first and driving second, deterministic), walking each
 * candidate order through this arithmetic instead of the plain one. Still a
 * proposal: applying it is the ordinary reorder, and the yard runs are said
 * on the proposal for the driver rather than written as stops.
 */

import { better, improve, type DayPlan, type Evaluation, type PlanStop } from "./index.js";

/**
 * A disposal facility as the plan knows it: where it is (by the key `travel`
 * understands), how long a tip takes there and when it takes loads.
 */
export interface TruckFacility {
  key: string;
  /** Minutes for the queue, the scale and the tip. */
  minutes: number;
  /**
   * When it takes loads on the plan's day, in the same minutes as the windows.
   * "closed" for a day it is shut all day; null when its hours are not known,
   * which is never a reason to refuse a trip.
   */
  hours: { opensAt: number; closesAt: number } | "closed" | null;
  /** What to call it, for the sentence that says why a run went there. */
  name?: string | undefined;
  /** Why it is shut all day, when it is ("Thanksgiving"), for the same sentence. */
  closedWhy?: string | undefined;
  /** The company's default: it wins a tie on drive time. */
  preferred?: boolean | undefined;
  /**
   * The materials it takes, as `rental.materialKey` writes them. Absent or
   * empty when nobody recorded them, which never turns a load away.
   */
  takes?: readonly string[] | undefined;
  /** What it would charge to tip these cans, in cents, or null when that cannot be worked out. */
  fee?: ((cargo: readonly Cargo[]) => number | null) | undefined;
}

/** Where a facility stands for a truck that would reach it at a given minute. */
export type FacilityStanding = "open" | "opens_later" | "closed_by_then" | "closed_all_day" | "does_not_take";

/**
 * WHICH FACILITY A RUN WENT TO AND WHY. `basis` says how the one chosen was
 * picked: `only_one` when it was the only one the plan knew, `nearest_open`
 * when it was open when the truck got there and no open one was sooner,
 * `opens_soonest` when none was open yet and its gate opens first,
 * `cheapest_open` when the fee weighed beside the time made a farther one
 * cheaper all told, and `none_open` when every one would be shut and the
 * nearest was taken anyway, the run refused.
 */
export interface FacilityChoice {
  basis: "only_one" | "nearest_open" | "opens_soonest" | "cheapest_open" | "none_open";
  /** Minutes by road from where the truck was. */
  driveMinutes: number;
  /**
   * Every other facility the plan knew, nearest first, with where it stood.
   * `refuses` names what on the truck it does not take, and `feeCents` what it
   * would have charged, each only when it is so.
   */
  others: {
    key: string; driveMinutes: number; standing: FacilityStanding; opensAt: number | null; closesAt: number | null;
    refuses?: string[]; feeCents?: number;
  }[];
  /** What the one chosen charges for the load, in cents, when known. */
  feeCents?: number;
  /**
   * Whether the fee was weighed beside the time, among facilities open that
   * could take the load, or why not: no hour cost for the truck, or a
   * facility that cannot say what it would charge (named by key). Absent when
   * there was nothing to weigh: one facility open, or no fee known anywhere.
   */
  fees?: { weighed: true; hourCents: number } | { weighed: false; why: "no_hour_cost" } | { weighed: false; why: "fee_unknown"; unknown: string[] };
  /** What on the truck the one chosen does not take, when no facility takes it all: the run is refused. */
  notTaken?: string[];
}

/** What a stop does to the truck. `none` is any other work on the day. */
export type TruckWork = "drop" | "pickup" | "swap" | "dump_return" | "none";

export interface TruckStop extends PlanStop {
  work: TruckWork;
  /**
   * The container's size in cubic yards, when the stop is about a particular
   * can and its size is known. Null or left out when it is not: a drop booked
   * before a can is chosen has no size, and is not refused for it.
   */
  size?: number | null | undefined;
  /**
   * What the full can a collection or a swap takes on holds, and how much it
   * is expected to weigh, for which facility takes it and what it would
   * charge. Absent when nothing is known, which turns no facility away.
   */
  load?: Cargo | undefined;
}

/** A full container on the truck: its material and expected tons, each null when not known. */
export interface Cargo {
  material: string | null;
  /** Tons as a decimal string, the hire's weight or the tonnage its price includes. */
  tons: string | null;
}

export interface TruckLoad {
  /** Empty containers on the truck, ready to drop. */
  empties: number;
  /** Full containers on the truck, to tip at the yard. */
  fulls: number;
}

/** A container's size in cubic yards, or null when it is not known. */
export type CanSize = number | null;

/** What is on the truck, can by can, with each one's size. */
export interface Deck {
  empties: CanSize[];
  fulls: CanSize[];
}

/** How many containers of one size a kind carries at once: "two 10 yard". */
export interface SizeCapacity {
  size: number;
  carried: number;
}

/** What the deck arithmetic needs of a truck: its one figure, and its figure per size. */
export interface Deckload {
  capacity: number;
  perSize?: readonly SizeCapacity[] | undefined;
}

/** The deck in shares: twelve is every whole number of cans from one to four. */
const DECK = 12;
const clampCarried = (n: number) => Math.min(4, Math.max(1, Math.floor(n)));

/** The share of the deck one can of a size takes on this truck. */
export function shareOf(size: CanSize, truck: Deckload): number {
  const own = size === null ? undefined : truck.perSize?.find((p) => p.size === size);
  return DECK / clampCarried(own?.carried ?? truck.capacity);
}

/** Whether these cans fit on the truck together. */
export function deckFits(cans: readonly CanSize[], truck: Deckload): boolean {
  return cans.reduce<number>((n, s) => n + shareOf(s, truck), 0) <= DECK;
}

/** Which empty on board a stop about a can of this size uses: its own size, else one of no known size; any, for a stop of no known size. */
function emptyFor(empties: readonly CanSize[], size: CanSize): number {
  if (size === null) {
    const unknown = empties.indexOf(null);
    return unknown >= 0 ? unknown : empties.length > 0 ? 0 : -1;
  }
  const exact = empties.indexOf(size);
  return exact >= 0 ? exact : empties.indexOf(null);
}

/** Whether the truck as it is can serve a stop, by the size of its can. */
export function canServeDeck(work: TruckWork, size: CanSize, deck: Deck, truck: Deckload): boolean {
  switch (work) {
    case "drop":
    case "swap":
      return emptyFor(deck.empties, size) >= 0;
    case "pickup":
    case "dump_return":
      return deckFits([...deck.empties, ...deck.fulls, size], truck);
    default:
      return true;
  }
}

/** The truck after a stop it could serve. A swap leaves with a full can of the size it dropped. */
export function afterStopDeck(work: TruckWork, size: CanSize, deck: Deck): Deck {
  const take = () => {
    const index = emptyFor(deck.empties, size);
    const empties = [...deck.empties];
    const [taken] = empties.splice(index, 1);
    return { empties, taken: taken ?? null };
  };
  switch (work) {
    case "drop": return { empties: take().empties, fulls: deck.fulls };
    case "swap": {
      const { empties, taken } = take();
      return { empties, fulls: [...deck.fulls, size ?? taken] };
    }
    case "pickup": return { empties: deck.empties, fulls: [...deck.fulls, size] };
    default: return deck;
  }
}

/**
 * Which empties to leave the yard with, can by can: the ones for the drops
 * that come next, as many as serves the most of the stops that follow
 * before the truck has to come back, and the fewest that does so. With one
 * figure and no sizes this is `loadFor`.
 */
export function loadDeckFor(steps: readonly { work: TruckWork; size: CanSize }[], truck: Deckload): CanSize[] {
  const drops = steps.filter((s) => s.work === "drop" || s.work === "swap").map((s) => s.size);
  let best = { empties: [] as CanSize[], served: -1 };
  for (let k = 0; k <= drops.length; k++) {
    const empties = drops.slice(0, k);
    if (!deckFits(empties, truck)) break;
    let deck: Deck = { empties, fulls: [] };
    let served = 0;
    for (const step of steps) {
      if (!canServeDeck(step.work, step.size, deck, truck)) break;
      deck = afterStopDeck(step.work, step.size, deck);
      served += 1;
    }
    if (served > best.served) best = { empties, served };
  }
  return best.empties;
}

/** The counts a proposal shows of a deck. */
export const countsOf = (deck: Deck): TruckLoad => ({ empties: deck.empties.length, fulls: deck.fulls.length });

export interface TruckPlan extends DayPlan {
  stops: readonly TruckStop[];
  /** The key of the yard: where empties are loaded and full cans tipped. */
  yard: string;
  /** Containers the truck carries at once. At least one. */
  capacity: number;
  /** Minutes at the yard to tip what is full and load what is needed. */
  yardMinutes: number;
  /**
   * The sizes, in cubic yards, this truck can lift. Empty or left out means
   * it is not limited to any, which is also what a truck with no kind is.
   */
  sizes?: readonly number[] | undefined;
  /**
   * How many of each size it carries at once, when its kind says ("two 10
   * yard or one 30 yard"). A size not here, or a can of no known size, is
   * counted against `capacity`.
   */
  perSize?: readonly SizeCapacity[] | undefined;
  /** Where a full can is tipped, when the plan knows a facility. Without one the yard tips. */
  facility?: TruckFacility | null | undefined;
  /**
   * Several facilities, each run going to the nearest that is open (see the
   * top of this file). Beats `facility` when it has any.
   */
  facilities?: readonly TruckFacility[] | undefined;
  /**
   * What a minute of the truck and its driver costs, in cents, for weighing a
   * facility's fee beside the time it takes. Null or absent when the company
   * has not said, and then the fee is not weighed.
   */
  minuteCost?: number | null | undefined;
  /**
   * What is on the truck as the plan starts. Null when the day starts at
   * the yard, where it is loaded for the stops that follow. A `Deck` says
   * each can's size; counts alone are cans of no known size.
   */
  load: TruckLoad | Deck | null;
}

export interface YardRun {
  /** The stop before the run, or null when the truck goes straight from where the plan starts. */
  afterId: string | null;
  /** The stop it is for, or null for the run at the end of the day. */
  beforeId: string | null;
  /** Full containers tipped. */
  tipped: number;
  /** Empties loaded, or left at the yard when negative. */
  loaded: number;
  arriveAt: number;
}

/**
 * What a truck carries and how long the yard takes it, and where those
 * figures came from.
 */
export interface TruckFigures {
  containers: number;
  yardMinutes: number;
  /** Cubic yards. Empty means any size. */
  sizes: readonly number[];
  /** How many of each size at once, when the kind says; absent when it has one figure. */
  perSize?: readonly SizeCapacity[] | undefined;
  /** The truck's own kind, or the company's figures for a truck with none. */
  source: "truck" | "company";
}

/**
 * The figures a driver's day is planned on: the truck's own kind when it has
 * one, otherwise the company's, which is the default and not a ceiling.
 * Clamped to what the planner can reason about (one to four containers), so
 * a figure typed wrongly cannot make the arithmetic loop or go negative.
 */
export function truckFigures(
  company: { containersPerTruck: number; yardMinutes: number },
  own: {
    containers: number; yardMinutes: number; sizes: readonly number[];
    perSize?: readonly SizeCapacity[] | undefined;
  } | null,
): TruckFigures {
  const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, Math.floor(n)));
  if (own) {
    /** A size given its own figure is a size the truck lifts, so it is among `sizes` too. */
    const perSize = (own.perSize ?? []).filter((p) => Number.isFinite(p.size) && p.size > 0)
      .map((p) => ({ size: p.size, carried: clamp(p.carried, 1, 4) }))
      .filter((p, i, all) => all.findIndex((q) => q.size === p.size) === i)
      .sort((a, b) => a.size - b.size);
    return {
      containers: clamp(own.containers, 1, 4), yardMinutes: clamp(own.yardMinutes, 0, 120),
      sizes: [...new Set([...own.sizes, ...perSize.map((p) => p.size)].filter((s) => Number.isFinite(s) && s > 0))].sort((a, b) => a - b),
      ...(perSize.length > 0 ? { perSize } : {}),
      source: "truck",
    };
  }
  return {
    containers: clamp(company.containersPerTruck, 1, 4), yardMinutes: clamp(company.yardMinutes, 0, 120),
    sizes: [], source: "company",
  };
}

/**
 * A container's size in cubic yards from the words a company wrote on it:
 * "20 yard", "20yd", "20 cubic yards", "30". Null when there is no number to
 * read, which is "not known", never "does not fit".
 */
export function sizeOf(label: string | null | undefined): number | null {
  const found = /(\d+(?:\.\d+)?)/.exec(label ?? "");
  if (!found) return null;
  const size = Number(found[1]);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/** Whether a truck lifts a container of this size. An unknown size is not refused. */
export function carries(sizes: readonly number[] | undefined, size: number | null | undefined): boolean {
  if (!sizes || sizes.length === 0 || size === null || size === undefined) return true;
  return sizes.includes(size);
}

/**
 * The plan as the truck can serve it: a stop whose can the truck does not
 * lift is plain driving (`none`) here, so the truck's load and the runs to
 * the yard are worked out only from the stops it can do. The ids of the
 * stops it cannot lift are returned beside it.
 */
export function servable(plan: TruckPlan): { plan: TruckPlan; notCarried: string[] } {
  const notCarried = plan.stops.filter((s) => s.work !== "none" && !carries(plan.sizes, s.size)).map((s) => s.id);
  if (notCarried.length === 0) return { plan, notCarried };
  const skip = new Set(notCarried);
  return { plan: { ...plan, stops: plan.stops.map((s) => (skip.has(s.id) ? { ...s, work: "none" as const } : s)) }, notCarried };
}

/** A run to the disposal facility to tip what is full. */
export interface FacilityRun {
  /** The stop before the run, or null when the truck goes straight from where the plan starts. */
  afterId: string | null;
  /** The stop it is for, or null for the run at the end of the day. */
  beforeId: string | null;
  /** Full containers tipped. */
  tipped: number;
  arriveAt: number;
  /** Minutes waiting at the gate for it to open. */
  waitMinutes: number;
  /** Minutes after it closed that the truck arrives. Zero when the gate is open; a whole day when it is shut all day. */
  closedBy: number;
  /** Which facility it went to, when the plan chose among several. Absent when it had one. */
  facilityKey?: string;
  /** Why that one, when the plan chose among several. */
  choice?: FacilityChoice;
  /** What on the truck the facility does not take, when none takes it all. The run is refused. */
  notTaken?: string[];
}

/** How a facility stands for a truck that reaches it at `arriveAt`. */
function standingAt(f: TruckFacility, arriveAt: number): FacilityStanding {
  if (f.hours === "closed") return "closed_all_day";
  if (f.hours === null) return "open";
  if (arriveAt < f.hours.opensAt) return "opens_later";
  return arriveAt > f.hours.closesAt ? "closed_by_then" : "open";
}

/** Whether the plan knows any facility, so a full can is tipped there and not at the yard. */
const hasFacility = (plan: Pick<TruckPlan, "facility" | "facilities">): boolean =>
  (plan.facilities !== undefined && plan.facilities.length > 0) || Boolean(plan.facility);

/** A material's name as it is compared, the same as `rental.materialKey`: case and spacing ignored. */
const keyOf = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** The materials on the truck a facility does not take, by name, once each. Never any for a facility whose list nobody recorded. */
function refusedBy(f: TruckFacility, cargo: readonly Cargo[]): string[] {
  if (!f.takes || f.takes.length === 0) return [];
  const takes = new Set(f.takes);
  const seen = new Set<string>();
  const refused: string[] = [];
  for (const can of cargo) {
    if (can.material === null || keyOf(can.material) === "") continue;
    const key = keyOf(can.material);
    if (takes.has(key) || seen.has(key)) continue;
    seen.add(key);
    refused.push(can.material.trim());
  }
  return refused;
}

/**
 * The facility a run goes to from `at` at minute `clock` with `cargo` on the
 * truck, and the reasoning. Deterministic: the same plan always picks the
 * same facility, ties going to the company's default and then to the key.
 */
export function pickFacility(
  plan: Pick<TruckPlan, "facility" | "facilities" | "travel" | "minuteCost">, at: string, clock: number,
  cargo: readonly Cargo[] = [],
): { facility: TruckFacility; choice: FacilityChoice | null } | null {
  const several = plan.facilities !== undefined && plan.facilities.length > 0;
  const list = several ? plan.facilities! : plan.facility ? [plan.facility] : [];
  if (list.length === 0) return null;
  if (!several) return { facility: list[0]!, choice: null };

  /**
   * Only the ones that take everything on the truck are chosen among. When
   * none does, all of them are, and the one chosen is refused for what it
   * does not take.
   */
  const refusals = new Map(list.map((f) => [f.key, refusedBy(f, cargo)]));
  const willing = list.filter((f) => refusals.get(f.key)!.length === 0);
  const pool = willing.length > 0 ? willing : list;

  const rows = pool.map((f) => {
    const drive = plan.travel(at, f.key);
    const standing = standingAt(f, clock + drive);
    /** When the can would be tipped: at once if open, when the gate opens if not yet. */
    const tippedAt = standing === "open" ? clock + drive
      : standing === "opens_later" && f.hours !== null && f.hours !== "closed" ? f.hours.opensAt : Number.POSITIVE_INFINITY;
    const tier = standing === "open" || standing === "opens_later" ? 0 : standing === "closed_by_then" ? 1 : 2;
    const fee = f.fee && cargo.length > 0 ? f.fee(cargo) : null;
    return { f, drive, standing: standing as FacilityStanding, tippedAt, tier, fee };
  });
  const byTime = (a: typeof rows[number], b: typeof rows[number]) =>
    a.tier - b.tier || a.tippedAt - b.tippedAt || a.drive - b.drive
    || Number(Boolean(b.f.preferred)) - Number(Boolean(a.f.preferred)) || a.f.key.localeCompare(b.f.key);
  rows.sort(byTime);

  /**
   * THE FEE BESIDE THE TIME, among the ones that would take the can now or
   * once their gate opens. Weighed only when there is a choice, the company
   * has priced a minute of the truck, and every one of them can say what it
   * would charge; otherwise the reason is kept and the order is by time.
   */
  const open = rows.filter((r) => r.tier === 0);
  let fees: FacilityChoice["fees"];
  /** Whether the fee chose a facility the time alone would not have. */
  let cheaper = false;
  if (open.length > 1 && open.some((r) => r.fee !== null)) {
    const unknown = open.filter((r) => r.fee === null).map((r) => r.f.key);
    const minute = plan.minuteCost ?? null;
    if (unknown.length > 0) fees = { weighed: false, why: "fee_unknown", unknown };
    else if (minute === null || !Number.isFinite(minute) || minute < 0) fees = { weighed: false, why: "no_hour_cost" };
    else {
      fees = { weighed: true, hourCents: Math.round(minute * 60) };
      const cost = (r: typeof rows[number]) => r.fee! + (r.tippedAt - clock) * minute;
      const soonest = open[0];
      open.sort((a, b) => cost(a) - cost(b) || byTime(a, b));
      rows.splice(0, open.length, ...open);
      cheaper = open[0] !== soonest;
    }
  }

  const chosen = rows[0]!;
  const notTaken = refusals.get(chosen.f.key)!;
  const basis: FacilityChoice["basis"] = list.length === 1 ? "only_one"
    : chosen.standing !== "open" && chosen.standing !== "opens_later" ? "none_open"
      : cheaper ? "cheapest_open"
        : chosen.standing === "open" ? "nearest_open" : "opens_soonest";
  const passedOver = list.filter((f) => !pool.includes(f)).map((f) => {
    const drive = plan.travel(at, f.key);
    return { f, drive, standing: "does_not_take" as FacilityStanding, fee: null as number | null };
  });
  const others = [...rows.slice(1), ...passedOver.sort((a, b) => a.drive - b.drive || a.f.key.localeCompare(b.f.key))];
  return {
    facility: chosen.f,
    choice: {
      basis,
      driveMinutes: chosen.drive,
      others: others.map((r) => ({
        key: r.f.key, driveMinutes: r.drive, standing: r.standing,
        opensAt: r.f.hours !== null && r.f.hours !== "closed" ? r.f.hours.opensAt : null,
        closesAt: r.f.hours !== null && r.f.hours !== "closed" ? r.f.hours.closesAt : null,
        ...(r.standing === "does_not_take" ? { refuses: refusals.get(r.f.key)! } : {}),
        ...(fees && r.fee !== null ? { feeCents: r.fee } : {}),
      })),
      ...(fees && chosen.fee !== null ? { feeCents: chosen.fee } : {}),
      ...(fees ? { fees } : {}),
      ...(notTaken.length > 0 ? { notTaken } : {}),
    },
  };
}

export interface TruckEvaluation extends Evaluation {
  yardRuns: YardRun[];
  /** Runs to the facility, empty when the plan has none. */
  facilityRuns: FacilityRun[];
  /** What the truck leaves with in the morning. */
  startLoad: TruckLoad;
  /** The same, can by can with each one's size. */
  startDeck: Deck;
}

/** Whether the truck as it is can serve a stop. */
export function canServe(work: TruckWork, load: TruckLoad, capacity: number): boolean {
  switch (work) {
    case "drop":
    case "swap":
      return load.empties >= 1;
    case "pickup":
    case "dump_return":
      return load.empties + load.fulls < capacity;
    default:
      return true;
  }
}

/** The truck after a stop it could serve. */
export function afterStop(work: TruckWork, load: TruckLoad): TruckLoad {
  switch (work) {
    case "drop": return { empties: load.empties - 1, fulls: load.fulls };
    case "swap": return { empties: load.empties - 1, fulls: load.fulls + 1 };
    case "pickup": return { empties: load.empties, fulls: load.fulls + 1 };
    default: return load;
  }
}

/**
 * How many empties to leave the yard with: the number that serves the most
 * of the stops that follow before the truck has to come back, and the
 * fewest that does so. Counting stops rather than looking further is enough
 * for a truck of one to four cans, and it is what a driver does.
 */
export function loadFor(works: readonly TruckWork[], capacity: number): number {
  let best = { empties: 0, served: -1 };
  for (let empties = 0; empties <= capacity; empties++) {
    let load: TruckLoad = { empties, fulls: 0 };
    let served = 0;
    for (const work of works) {
      if (!canServe(work, load, capacity)) break;
      load = afterStop(work, load);
      served += 1;
    }
    if (served > best.served) best = { empties, served };
  }
  return best.empties;
}

/** Walk a day in a given order with the truck, and say what it costs. */
/** A plan's starting load as a deck: counts alone are cans of no known size. */
function deckOf(load: TruckLoad | Deck): Deck {
  return Array.isArray(load.empties)
    ? { empties: [...(load as Deck).empties], fulls: [...(load as Deck).fulls] }
    : { empties: Array<CanSize>((load as TruckLoad).empties).fill(null), fulls: Array<CanSize>((load as TruckLoad).fulls).fill(null) };
}

const truckOf = (plan: TruckPlan): Deckload => ({ capacity: Math.max(1, Math.floor(plan.capacity)), perSize: plan.perSize });

export function evaluateTruck(given: TruckPlan, order: readonly string[]): TruckEvaluation {
  const plan = servable(given).plan;
  const facility = hasFacility(plan);
  const truck = truckOf(plan);
  const byId = new Map(plan.stops.map((s) => [s.id, s]));
  const steps = order.map((id) => {
    const stop = byId.get(id);
    if (!stop) throw new RangeError(`${id} is not a stop in this plan.`);
    return { work: stop.work, size: stop.size ?? null };
  });

  const startDeck: Deck = plan.load ? deckOf(plan.load) : { empties: loadDeckFor(steps, truck), fulls: [] };
  let load = startDeck;
  /** What each full can on the truck holds, in step with `load.fulls`; a can already on board at the start is not known. */
  let cargo: Cargo[] = startDeck.fulls.map(() => ({ material: null, tons: null }));
  let at = plan.start;
  let previous: string | null = null;
  let clock = plan.departAt;
  let drive = 0;
  let wait = 0;
  const arrivals: Evaluation["arrivals"] = [];
  const yardRuns: YardRun[] = [];
  const facilityRuns: FacilityRun[] = [];

  const toYard = (beforeId: string | null, upcoming: readonly { work: TruckWork; size: CanSize }[]) => {
    const leg = plan.travel(at, plan.yard);
    drive += leg;
    clock += leg;
    const arriveAt = clock;
    const empties = upcoming.length > 0 ? loadDeckFor(upcoming, truck) : [];
    yardRuns.push({ afterId: previous, beforeId, tipped: load.fulls.length, loaded: empties.length - load.empties.length, arriveAt });
    clock += plan.yardMinutes;
    load = { empties, fulls: [] };
    cargo = [];
    at = plan.yard;
  };

  /**
   * Tip what is full at the facility. A truck early for the gate waits for it;
   * one that arrives after it has closed is recorded as closed by that many
   * minutes and carries on as if it had been taken, so the rest of the day is
   * still measured and the closure is what the proposal names.
   */
  const toFacility = (beforeId: string | null) => {
    const picked = pickFacility(plan, at, clock, cargo)!;
    const f = picked.facility;
    const leg = plan.travel(at, f.key);
    drive += leg;
    clock += leg;
    const arriveAt = clock;
    let waited = 0;
    let closedBy = 0;
    if (f.hours === "closed") closedBy = 1440;
    else if (f.hours !== null) {
      if (arriveAt < f.hours.opensAt) { waited = f.hours.opensAt - arriveAt; clock = f.hours.opensAt; }
      else if (arriveAt > f.hours.closesAt) closedBy = arriveAt - f.hours.closesAt;
    }
    wait += waited;
    facilityRuns.push({
      afterId: previous, beforeId, tipped: load.fulls.length, arriveAt, waitMinutes: waited, closedBy,
      ...(picked.choice ? { facilityKey: f.key, choice: picked.choice } : {}),
      ...(picked.choice?.notTaken ? { notTaken: picked.choice.notTaken } : {}),
    });
    clock += f.minutes;
    /** What was full is empty now, and still on the truck, each can its own size. */
    load = { empties: [...load.empties, ...load.fulls], fulls: [] };
    cargo = [];
    at = f.key;
  };

  for (const [index, id] of order.entries()) {
    const stop = byId.get(id)!;
    const size = stop.size ?? null;
    if (!canServeDeck(stop.work, size, load, truck)) {
      if (facility && load.fulls.length > 0) toFacility(id);
      if (!canServeDeck(stop.work, size, load, truck)) toYard(id, steps.slice(index));
    }
    const leg = plan.travel(at, id);
    drive += leg;
    const arriveAt = clock + leg;
    const startAt = stop.windowStart !== null && arriveAt < stop.windowStart ? stop.windowStart : arriveAt;
    wait += startAt - arriveAt;
    const lateBy = stop.windowEnd !== null && arriveAt > stop.windowEnd ? arriveAt - stop.windowEnd : 0;
    const leaveAt = startAt + stop.serviceMinutes;
    arrivals.push({ id, arriveAt, startAt, leaveAt, lateBy });
    clock = leaveAt;
    at = id;
    previous = id;
    load = afterStopDeck(stop.work, size, load);
    if (stop.work === "pickup" || stop.work === "swap") cargo.push(stop.load ?? { material: null, tons: null });
  }

  /**
   * Home, and a full can still on the hook is tipped first: at the facility
   * when the plan has one, otherwise at the yard when the day ends there, by
   * way of it when it does not.
   */
  const tipAtEnd = order.length > 0 && load.fulls.length > 0;
  if (tipAtEnd && facility) toFacility(null);
  else if (tipAtEnd && plan.end !== plan.yard) toYard(null, []);
  const home = order.length === 0 ? 0 : plan.travel(at, plan.end);
  drive += home;
  if (tipAtEnd && !facility && plan.end === plan.yard) {
    yardRuns.push({ afterId: previous, beforeId: null, tipped: load.fulls.length, loaded: 0, arriveAt: clock + home });
    clock += plan.yardMinutes;
  }

  const late = arrivals.filter((a) => a.lateBy > 0).map((a) => ({ id: a.id, lateBy: a.lateBy }));
  return {
    order: [...order],
    driveMinutes: drive,
    waitMinutes: wait,
    finishAt: clock + home,
    arrivals,
    late,
    lateMinutes: late.reduce((n, l) => n + l.lateBy, 0),
    yardRuns,
    facilityRuns,
    startLoad: countsOf(startDeck),
    startDeck,
  };
}

/**
 * Better, for a truck's day: a broken promise to a customer, a facility
 * reached after it closed and one that does not take the load count the same, because both are a run the day
 * cannot do, and the search should drive further to avoid either. With no
 * facility this is `better`.
 */
export function betterTruck(a: TruckEvaluation, b: TruckEvaluation): boolean {
  /** A facility that turns the load away is a run the day cannot do, the same as a closed gate. */
  const broken = (e: TruckEvaluation) => e.late.length + e.facilityRuns.filter((r) => r.closedBy > 0 || (r.notTaken?.length ?? 0) > 0).length;
  const minutes = (e: TruckEvaluation) => e.lateMinutes + e.facilityRuns.reduce((n, r) => n + r.closedBy, 0);
  if (broken(a) !== broken(b)) return broken(a) < broken(b);
  if (minutes(a) !== minutes(b)) return minutes(a) < minutes(b);
  return better(a, b);
}

/**
 * Nearest neighbour in time, with the truck: of the stops still to do, the
 * one where work can start soonest, counting the run to the yard first when
 * the truck as it stands cannot serve it.
 */
export function constructTruck(given: TruckPlan): string[] {
  const plan = servable(given).plan;
  const facility = hasFacility(plan);
  const truck = truckOf(plan);
  const remaining = [...plan.stops].sort((a, b) => a.id.localeCompare(b.id));
  const order: string[] = [];
  let at = plan.start;
  let clock = plan.departAt;
  const stepOf = (s: TruckStop) => ({ work: s.work, size: s.size ?? null });
  let load: Deck = plan.load ? deckOf(plan.load) : { empties: loadDeckFor(remaining.map(stepOf), truck), fulls: [] };
  let cargo: Cargo[] = load.fulls.map(() => ({ material: null, tons: null }));

  /**
   * Where the truck is, when and with what, once it has done what the stop
   * needs first: a run to the facility to tip what is full, and then to the
   * yard when it still cannot serve it. The same arithmetic `evaluateTruck`
   * walks, so the order built is the order that is then measured.
   */
  const approach = (step: { work: TruckWork; size: CanSize }, upcoming: readonly { work: TruckWork; size: CanSize }[]) => {
    let place = at;
    let time = clock;
    let ld = load;
    let held = cargo;
    let viaYard = false;
    if (!canServeDeck(step.work, step.size, ld, truck)) {
      if (facility && ld.fulls.length > 0) {
        const f = pickFacility(plan, place, time, held)!.facility;
        time += plan.travel(place, f.key);
        if (f.hours !== null && f.hours !== "closed" && time < f.hours.opensAt) time = f.hours.opensAt;
        time += f.minutes;
        place = f.key;
        ld = { empties: [...ld.empties, ...ld.fulls], fulls: [] };
        held = [];
      }
      if (!canServeDeck(step.work, step.size, ld, truck)) {
        time += plan.travel(place, plan.yard) + plan.yardMinutes;
        place = plan.yard;
        ld = { empties: loadDeckFor(upcoming, truck), fulls: [] };
        held = [];
        viaYard = true;
      }
    }
    return { place, time, load: ld, cargo: held, viaYard };
  };

  while (remaining.length > 0) {
    let best: { index: number; begin: number; leg: number; closes: number } | null = null;
    let urgent: { index: number; closes: number } | null = null;
    for (const [index, stop] of remaining.entries()) {
      const there = approach(stepOf(stop), [stepOf(stop)]);
      const leg = there.time - clock + plan.travel(there.place, stop.id);
      const arrive = clock + leg;
      const closes = stop.windowEnd ?? Number.POSITIVE_INFINITY;
      if (arrive <= closes) {
        const begin = Math.max(arrive, stop.windowStart ?? arrive);
        if (!best || begin < best.begin || (begin === best.begin && leg < best.leg)
          || (begin === best.begin && leg === best.leg && closes < best.closes)) {
          best = { index, begin, leg, closes };
        }
      } else if (!urgent || closes < urgent.closes) {
        urgent = { index, closes };
      }
    }
    const pick = (best ?? urgent)!;
    const [stop] = remaining.splice(pick.index, 1);
    const there = approach(stepOf(stop!), [stepOf(stop!), ...remaining.map(stepOf)]);
    clock = there.time;
    at = there.place;
    load = there.load;
    cargo = there.cargo;
    const leg = plan.travel(at, stop!.id);
    const arrive = clock + leg;
    clock = Math.max(arrive, stop!.windowStart ?? arrive) + stop!.serviceMinutes;
    at = stop!.id;
    load = afterStopDeck(stop!.work, stop!.size ?? null, load);
    if (stop!.work === "pickup" || stop!.work === "swap") cargo = [...cargo, stop!.load ?? { material: null, tons: null }];
    order.push(stop!.id);
  }
  return order;
}

export interface TruckProposal {
  current: TruckEvaluation;
  proposed: TruckEvaluation;
  improved: boolean;
  missed: { id: string; lateBy: number; unreachable: boolean }[];
  /**
   * Runs to the facility the proposed day reaches after it has closed, each
   * the way the day was ordered at the time: refused, and named.
   */
  facilityClosed: FacilityRun[];
  /** Runs to a facility that does not take what is on the truck, because none on the map takes it all: refused, and named. */
  facilityRefused: FacilityRun[];
  /** Stops about a container of a size this truck does not lift, ordered as plain driving. */
  notCarried: string[];
}

/**
 * The best order this can find for a driver's day, with the yard runs it
 * needs, compared with the order the day has now. Never handed back worse:
 * when nothing beats the current order, the proposal is the current order.
 */
export function optimiseTruck(
  given: TruckPlan, current: readonly string[], options: { pinned?: ReadonlySet<string> } = {},
): TruckProposal {
  const { plan, notCarried } = servable(given);
  const pinned = options.pinned ?? new Set<string>();
  const ids = new Set(plan.stops.map((s) => s.id));
  if (current.length !== ids.size || new Set(current).size !== current.length || current.some((id) => !ids.has(id))) {
    throw new RangeError("The current order must name every stop in the plan exactly once.");
  }
  const now = evaluateTruck(plan, current);
  const fromCurrent = improve(plan, current, 200, pinned, evaluateTruck, betterTruck);
  const fromScratch = pinned.size === 0 ? improve(plan, constructTruck(plan), 200, new Set(), evaluateTruck, betterTruck) : fromCurrent;
  const chosen = betterTruck(fromScratch, fromCurrent) ? fromScratch : fromCurrent;
  const proposed = betterTruck(chosen, now) ? evaluateTruck(plan, chosen.order) : now;

  const byId = new Map(plan.stops.map((s) => [s.id, s]));
  const missed = proposed.late.map((l) => {
    const stop = byId.get(l.id)!;
    const direct = plan.departAt + plan.travel(plan.start, l.id);
    return { id: l.id, lateBy: l.lateBy, unreachable: stop.windowEnd !== null && direct > stop.windowEnd };
  });
  return {
    current: now, proposed, improved: proposed !== now, missed,
    facilityClosed: proposed.facilityRuns.filter((r) => r.closedBy > 0),
    facilityRefused: proposed.facilityRuns.filter((r) => (r.notTaken?.length ?? 0) > 0), notCarried,
  };
}
