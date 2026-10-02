import * as m from "../money/index.js";
import * as time from "../time/index.js";

/**
 * THE TRADE PACK SHIPPED AND THE THING IT RENTS DID NOT EXIST
 *
 * `packs/dumpster-rental.ts` is two hundred and seventy eight lines. It
 * declares six job types whose `capacityModel` is `asset_rental`, thirty eight
 * price book items built around container days and scale tickets, two
 * checklists written for a driver with a hook truck, and eight KPI definitions
 * precise enough to name the ways each one is usually computed wrongly. It is
 * one of eight packs a company can apply at setup, and it has been applied-able
 * since the packs shipped.
 *
 * `rentable_asset` had no reader and no writer. Neither did `rental`. So did
 * `visit.rental_id` and `visit.rental_event`, the two columns that say which
 * hire a stop belongs to and whether the driver is dropping or collecting.
 *
 * Which means: a dumpster company could apply the pack, get the price book and
 * the checklists and the job types, and could not record a single container.
 * The pack's own first paragraph says "the scarce resource is a can, not a
 * person", and there was nowhere to put a can.
 *
 * WHAT THIS FILE IS, AND IS NOT. It is the arithmetic the trade runs on, with
 * no database in it. Two of the four things here are billing meters that must
 * not be derived from each other, and the other two are the metric the business
 * turns on and the measure of how much of it goes unbilled.
 */

/* ------------------------------------------------------------ the container */

export type AssetStatus =
  /** In the yard, earning nothing, and IN the utilisation denominator. */
  | "available"
  /** On a customer site, on hire. */
  | "on_site"
  /**
   * Tagged out for repair. The ONLY status excluded from the denominator,
   * which the pack's KPI definition states and is the whole reason the
   * distinction between this and `available` exists.
   */
  | "out_of_service";

export const ASSET_STATUSES: readonly AssetStatus[] = [
  "available", "on_site", "out_of_service",
];

/**
 * There is no `in_transit`, and leaving it out is a decision rather than an
 * omission.
 *
 * A can on the back of a truck between a customer site and the facility is
 * either still on that rental or already back in the yard, and nothing in this
 * trade's billing or utilisation changes at the moment the wheels turn. A
 * fourth status would need a writer on every leg of every haul, would be wrong
 * for the hours nobody updated it, and would put a can in a state the
 * utilisation denominator has to make an arbitrary decision about.
 */
const TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  available: ["on_site", "out_of_service"],
  /**
   * A can can go straight from a customer site to the repair bay, and it is
   * the ordinary case rather than an edge one: the pickup checklist's last
   * line is "record the container condition and tag it out of service if it
   * needs repair".
   */
  on_site: ["available", "out_of_service"],
  out_of_service: ["available"],
};

export function canMove(from: AssetStatus, to: AssetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function moveRefusal(from: AssetStatus, to: AssetStatus): string {
  if (from === "on_site" && to === "on_site") {
    return "That container is already on a customer site. Pick it up, or swap it, before it can "
      + "go out again.";
  }
  if (from === "out_of_service" && to === "on_site") {
    return "That container is tagged out of service. Return it to the fleet before sending it out, "
      + "so the repair is recorded as finished rather than forgotten.";
  }
  return `A container that is ${from} cannot become ${to}.`;
}

/* ------------------------------------------------------- the container day */

/**
 * CONTAINER DAYS, AS THE PACK DEFINES THEM: "one container on a customer site
 * for ANY PART of a calendar day".
 *
 * Not elapsed hours divided by twenty four, and the difference is not small. A
 * can delivered at 4pm on Monday and collected at 9am on Tuesday is on site for
 * seventeen hours, which is 0.7 of a day by division and TWO container days by
 * the trade's own reckoning, because it occupied a space in the fleet on two
 * separate days and the customer had it on two separate days.
 *
 * Every operator in this trade counts it the second way, every competitor's
 * invoice counts it the second way, and a product that divides by twenty four
 * undercharges every short rental and reports a utilisation rate that is
 * quietly too low.
 *
 * IN THE COMPANY'S TIMEZONE, because a calendar day is a local thing. A
 * delivery at 7pm Central on the 3rd is the 4th in UTC, and counting in UTC
 * would start the rental a day late for every evening drop.
 */
export function containerDays(from: Date, to: Date, zone: string): number {
  const first = time.dateIn(from, zone);
  const last = time.dateIn(to, zone);
  if (last < first) return 0;
  const start = Date.parse(`${first}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * The days a still open rental has run, counted to the given instant.
 *
 * Separate from `containerDays` by name rather than by a nullable argument,
 * because a caller that passes an undefined end date to an arithmetic function
 * and gets a number back has no way to know whether it meant "zero days" or
 * "still running".
 */
export function daysSoFar(deliveredAt: Date, asOf: Date, zone: string): number {
  return containerDays(deliveredAt, asOf, zone);
}

/* ------------------------------------------------------------ the two meters */

export interface PeriodTerms {
  /** Days the quoted price covers. Null means an open ended standing rate. */
  includedDays: number | null;
  /** Per day beyond the included period. */
  overageRate: string | null;
}

export interface WeightTerms {
  /** Tons the quoted price covers. Null means disposal is billed in full. */
  includedTons: string | null;
  /** Per ton beyond the included tonnage. */
  perTonRate: string | null;
}

export interface MeterLine {
  /** `rental_days` or `disposal_tons`. Which meter produced it. */
  meter: "rental_days" | "disposal_tons";
  /** Days or tons over the included amount. A decimal string for tons. */
  overBy: string;
  rate: string;
  amount: string;
}

export interface BillRequest {
  deliveredAt: Date;
  pickedUpAt: Date;
  zone: string;
  period: PeriodTerms;
  weight: WeightTerms;
  /** Net tonnage from the scale ticket. Null when no ticket exists yet. */
  tons: string | null;
}

export type BillRefusal =
  /**
   * There is no `not_picked_up` reason, and there was one.
   *
   * It was never produced: `bill` takes two dates and an open hire has no second
   * one to hand it, so the caller refuses before it gets here. A declared
   * refusal reason nothing can return is a claim about behaviour that does not
   * exist, and the first reader to write a branch for it writes dead code.
   */
  | { reason: "backwards"; message: string }
  | { reason: "negative_tons"; message: string }
  | { reason: "no_rate"; message: string; meter: MeterLine["meter"] };

export type BillVerdict =
  | { ok: true; days: number; lines: MeterLine[]; total: string }
  | { ok: false; refusals: BillRefusal[] };

/**
 * What a finished rental has earned beyond its quoted price.
 *
 * TWO METERS, NEITHER DERIVED FROM THE OTHER, which is the pack's own wording
 * and the thing every spreadsheet version of this gets wrong. One runs on
 * elapsed calendar days against an included period. The other runs on weight
 * from the scale ticket against an included tonnage. A can that sat for three
 * weeks holding four hundred pounds owes days and no tons; a can collected on
 * day two holding six tons owes tons and no days. A single "overage" figure
 * cannot express either case, and a customer disputing one of them is entitled
 * to see which.
 *
 * A MISSING RATE IS A REFUSAL, NOT A ZERO. A rental that ran eleven days past
 * its included week with no overage rate on it is eleven days of work already
 * done that nobody can invoice, which is exactly what the pack's
 * `overage_capture` KPI calls billing leakage. Treating the absent rate as
 * nothing to charge would make the leak invisible and the KPI report one
 * hundred per cent.
 */
export function bill(request: BillRequest): BillVerdict {
  const refusals: BillRefusal[] = [];

  if (request.pickedUpAt.getTime() < request.deliveredAt.getTime()) {
    refusals.push({
      reason: "backwards",
      message: "That pickup is before the delivery. Check the dates: a rental cannot end before "
        + "it starts, and a negative period would bill as a credit.",
    });
    return { ok: false, refusals };
  }

  const days = containerDays(request.deliveredAt, request.pickedUpAt, request.zone);
  const lines: MeterLine[] = [];

  const includedDays = request.period.includedDays;
  if (includedDays !== null && days > includedDays) {
    const over = days - includedDays;
    const rate = request.period.overageRate;
    if (rate === null) {
      refusals.push({
        reason: "no_rate", meter: "rental_days",
        message: `This rental ran ${over} ${over === 1 ? "day" : "days"} past its included `
          + "period and carries no daily rate, so there is nothing to bill the extra days at. "
          + "Set the rate on the rental rather than letting the days go out free.",
      });
    } else {
      lines.push({
        meter: "rental_days",
        overBy: String(over),
        rate,
        amount: m.toString(m.multiply(m.money(rate), String(over))),
      });
    }
  }

  if (request.tons !== null) {
    const tons = Number(request.tons);
    if (!Number.isFinite(tons) || tons < 0) {
      refusals.push({
        reason: "negative_tons",
        message: `"${request.tons}" is not a weight. A scale ticket's net tonnage is the gross `
          + "less the tare and cannot be below zero.",
      });
    } else {
      const included = Number(request.weight.includedTons ?? "0");
      const over = tons - included;
      if (over > 0) {
        const rate = request.weight.perTonRate;
        if (rate === null) {
          refusals.push({
            reason: "no_rate", meter: "disposal_tons",
            message: `This load was ${over.toFixed(4)} tons over the included tonnage and the `
              + "rental carries no per ton rate. Disposal is the largest cost line in this trade; "
              + "unbilled tonnage comes straight off the margin.",
          });
        } else {
          /**
           * Rate times tons, rounded once at the end. Rounding the tonnage
           * first and multiplying loses up to half a cent per ton, which on a
           * fleet doing two thousand hauls a year is a real number and, worse,
           * does not reconcile against the facility's own invoice.
           */
          lines.push({
            meter: "disposal_tons",
            overBy: over.toFixed(4),
            rate,
            amount: m.toString(m.round(m.multiply(m.money(rate), over.toFixed(4)), 2)),
          });
        }
      }
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    days,
    lines,
    total: m.toString(m.sum(lines.map((line) => m.money(line.amount)))),
  };
}

/**
 * Whether this rental went past either of its included amounts.
 *
 * The denominator of `overage_capture`, and deliberately separate from `bill`:
 * a rental that exceeded its period and could not be billed because no rate
 * was set has to count here. Asking `bill` would hide exactly the rentals the
 * metric exists to find.
 */
export function exceeded(request: {
  days: number;
  includedDays: number | null;
  tons: string | null;
  includedTons: string | null;
}): { days: boolean; tons: boolean; either: boolean } {
  const overDays = request.includedDays !== null && request.days > request.includedDays;
  const tons = request.tons === null ? null : Number(request.tons);
  const overTons = tons !== null && Number.isFinite(tons)
    && tons > Number(request.includedTons ?? "0");
  return { days: overDays, tons: overTons, either: overDays || overTons };
}

/* ------------------------------------------------------------ the metrics */

export interface UtilisationInput {
  /** Container days on a customer site in the window. */
  rentedDays: number;
  /** Container days in the fleet and not tagged out of service. */
  availableDays: number;
}

/**
 * The number the whole business turns on, as a percentage string.
 *
 * THE DENOMINATOR IS THE WHOLE POINT, and the pack says so: available days
 * INCLUDE cans sitting in the yard and EXCLUDE only cans tagged out of service.
 * Excluding yard cans is the usual mistake and it makes a bloated fleet look
 * fully booked, which is the one conclusion this metric exists to prevent. A
 * shop with forty cans and sixty per cent utilisation bought sixteen cans it
 * did not need, and a report that counts only the cans that went out tells it
 * utilisation is a hundred per cent.
 *
 * A string, like money, because this ends up on a screen and in a report and
 * two readings of it have to have been produced the same way.
 */
export function utilisation(input: UtilisationInput): string | null {
  if (input.availableDays <= 0) return null;
  return ((input.rentedDays / input.availableDays) * 100).toFixed(1);
}

/**
 * Average elapsed days, over rentals that ENDED in the window.
 *
 * Open rentals are excluded, which the pack states and which matters more than
 * it reads: a can that has been on a construction site for ninety days has run
 * longer than any finished rental, and including it at "ninety so far" while
 * excluding its eventual real duration drags the average in both directions at
 * different times. The same average computed twice a week apart would move for
 * no reason anybody could explain.
 */
export function averageDuration(finishedDays: readonly number[]): string | null {
  if (finishedDays.length === 0) return null;
  const total = finishedDays.reduce((sum, days) => sum + days, 0);
  return (total / finishedDays.length).toFixed(1);
}

/**
 * Average net tons per haul, over hauls that HAVE a ticket.
 *
 * A haul with no scale ticket is excluded rather than averaged in at zero,
 * which the pack says and gives the reason for: a missing ticket is something
 * to investigate, and folding it in as zero both understates the average and
 * removes the only signal that the ticket is missing. The count of hauls
 * without one comes back alongside, so the exclusion is visible rather than
 * silent.
 */
export function averageTons(tickets: readonly (string | null)[]): {
  average: string | null;
  withTicket: number;
  withoutTicket: number;
} {
  const weights = tickets
    .filter((t): t is string => t !== null)
    .map((t) => Number(t))
    .filter((n) => Number.isFinite(n));
  const withoutTicket = tickets.length - weights.length;
  if (weights.length === 0) return { average: null, withTicket: 0, withoutTicket };
  const total = weights.reduce((sum, tons) => sum + tons, 0);
  return {
    average: (total / weights.length).toFixed(2),
    withTicket: weights.length,
    withoutTicket,
  };
}

/**
 * How much of what was earned actually got invoiced.
 *
 * Billed over exceeded. The pack's own note is the reason to compute it at all:
 * "anything under one hundred percent is work already done and never
 * invoiced". It measures leakage, not pricing.
 */
export function overageCapture(input: { exceeded: number; billed: number }): string | null {
  if (input.exceeded <= 0) return null;
  return ((input.billed / input.exceeded) * 100).toFixed(1);
}
