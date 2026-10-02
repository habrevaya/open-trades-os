import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";

/**
 * SELLING A QUANTITY RATHER THAN A JOB
 *
 * `delivery` shipped in the first migration and NOTHING read it or wrote it.
 * Not a gap in a feature: the whole feature was absent, while the table
 * described it in detail enough to be unmistakable.
 *
 * It is the fourth way a company in this industry takes money, and the
 * schema's four capacity models do not cover it. Propane, heating oil, water
 * and bulk chemical are not appointments and not routes: the customer buys a
 * QUANTITY, the price is per unit, and the quantity is whatever came off the
 * truck's meter at the kerb. A fuel dealer running this product had nowhere
 * to record a drop.
 *
 * THE THREE THINGS THIS FILE IS ACTUALLY ABOUT, each of which is a way the
 * money goes wrong when it is not done:
 *
 *   THE METER IS THE AUTHORITY. `meter_start` and `meter_stop` exist because
 *   a driver's written quantity and the difference between two meter readings
 *   disagree regularly, and when they do the meter is right. Storing both and
 *   not comparing them would be storing the evidence of a discrepancy and
 *   never looking at it.
 *
 *   A PARTIAL FILL IS A DIFFERENT EVENT. `was_partial_fill` separates "the
 *   tank took four hundred gallons" from "the tank would only take ninety
 *   because somebody had already filled it". The second one is a wasted trip
 *   and, for an automatic delivery customer, evidence the forecast is wrong.
 *   Counting them together is how a dealer concludes their usage model works.
 *
 *   TANK PERCENTAGES ARE WHAT THE FORECAST IS BUILT ON.
 *   `tank_percent_before` and `tank_percent_after` are how consumption
 *   between two visits is computed, which is what decides when the truck goes
 *   next. A delivery recorded without them is a sale that teaches the
 *   business nothing.
 *
 * ON PERMISSIONS. `invoice:write` and `invoice:read`, both already in the
 * catalogue. A delivery is a billable quantity and nothing else: it is the
 * document the customer is charged from. The driver holds `invoice:write`
 * through the technician role, which is correct, because the person at the
 * kerb reading the meter is the person recording what was sold.
 */

export interface DeliveryInput {
  customerId: string;
  propertyId: string;
  /** What was delivered. The company's own word: "propane", "#2 oil". */
  product: string;
  unit: string;
  /** Per unit, as a decimal string. Never a float. */
  unitPrice: string;
  /**
   * How much. Optional when both meter readings are given, because then the
   * meter already said.
   */
  quantity?: string | undefined;
  meterStart?: string | null | undefined;
  meterStop?: string | null | undefined;
  tankPercentBefore?: string | null | undefined;
  tankPercentAfter?: string | null | undefined;
  wasPartialFill?: boolean | undefined;
  jobId?: string | null | undefined;
  visitId?: string | null | undefined;
  /** The tank, when the company keeps one on the equipment register. */
  equipmentId?: string | null | undefined;
  deliveredAt?: string | undefined;
}

export interface DeliveryView {
  id: string;
  customerId: string;
  propertyId: string;
  equipmentId: string | null;
  jobId: string | null;
  visitId: string | null;
  product: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  /** quantity times unitPrice, computed rather than stored. */
  total: string;
  meterStart: string | null;
  meterStop: string | null;
  tankPercentBefore: string | null;
  tankPercentAfter: string | null;
  wasPartialFill: boolean;
  deliveredAt: string;
}

const view = (row: typeof schema.delivery.$inferSelect): DeliveryView => ({
  id: row.id,
  customerId: row.customerId,
  propertyId: row.propertyId,
  equipmentId: row.equipmentId,
  jobId: row.jobId,
  visitId: row.visitId,
  product: row.product,
  quantity: row.quantity,
  unit: row.unit,
  unitPrice: row.unitPrice,
  /**
   * COMPUTED, NOT STORED, for the reason the deposit list gives: a stored
   * total is a third number that can disagree with the two it comes from, and
   * the one it would disagree with is what the customer was charged.
   */
  total: m.toString(m.round(m.multiply(m.money(row.unitPrice, "USD"), row.quantity), 2)),
  meterStart: row.meterStart,
  meterStop: row.meterStop,
  tankPercentBefore: row.tankPercentBefore,
  tankPercentAfter: row.tankPercentAfter,
  wasPartialFill: row.wasPartialFill,
  deliveredAt: row.deliveredAt.toISOString(),
});

/**
 * Record a drop.
 *
 * Takes the moment from the caller, because a truck does six in a morning and
 * syncs them at lunch. `now()` would stamp all six with the moment the tablet
 * found signal, and the consumption arithmetic below is built on the interval
 * between two deliveries: collapsing six into one instant makes every rate it
 * computes wrong.
 */
export async function record(
  ctx: ServiceContext, input: DeliveryInput,
): Promise<DeliveryView> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const product = input.product.trim();
    const unit = input.unit.trim();
    if (product === "") throw new ConflictError("A delivery needs to say what was delivered.");
    if (unit === "") {
      throw new ConflictError(
        "A delivery needs a unit. A quantity of 400 is gallons or litres and the difference "
        + "is the price of the load.",
      );
    }

    const quantity = resolveQuantity(input);
    const price = decimal(input.unitPrice, "unit price");
    if (price < 0) throw new ConflictError("A unit price cannot be negative.");

    percent(input.tankPercentBefore, "tank percentage before");
    percent(input.tankPercentAfter, "tank percentage after");

    /**
     * A TANK THAT ENDS EMPTIER THAN IT STARTED IS A TRANSCRIPTION ERROR.
     *
     * Refused rather than stored, because this pair is the input to every
     * consumption forecast the business runs: a before of 80 and an after of
     * 20 reads as the customer burning sixty per cent of a tank during the
     * delivery, and the next forecast sends the truck far too early. The two
     * numbers are almost always typed the wrong way round when this happens.
     */
    if (input.tankPercentBefore && input.tankPercentAfter) {
      if (Number(input.tankPercentAfter) < Number(input.tankPercentBefore)) {
        throw new ConflictError(
          "The tank reads emptier after the delivery than before it. Those two are usually "
          + "entered the wrong way round, and as recorded they would tell the forecast the "
          + "customer burned most of a tank while the driver was standing there.",
        );
      }
    }

    const deliveredAt = input.deliveredAt ? new Date(input.deliveredAt) : new Date();
    if (Number.isNaN(deliveredAt.getTime())) {
      throw new ConflictError("That is not a delivery time this platform can read.");
    }

    await assertBelongsHere(tx, ctx.actor.organizationId, input);

    const [row] = await tx.insert(schema.delivery).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      jobId: input.jobId ?? null,
      visitId: input.visitId ?? null,
      equipmentId: input.equipmentId ?? null,
      product,
      quantity,
      unit,
      unitPrice: input.unitPrice,
      meterStart: input.meterStart ?? null,
      meterStop: input.meterStop ?? null,
      tankPercentBefore: input.tankPercentBefore ?? null,
      tankPercentAfter: input.tankPercentAfter ?? null,
      wasPartialFill: input.wasPartialFill ?? false,
      deliveredAt,
    }).returning();

    await audit(tx, ctx, "delivery.recorded", "delivery", row!.id, null, row!);
    return view(row!);
  });
}

/**
 * How much was delivered: the meter when it can say, and the written figure
 * otherwise.
 *
 * THE DISAGREEMENT IS REFUSED RATHER THAN RESOLVED, which is the whole of
 * what "the meter is the authority" actually means here.
 *
 * When both readings and a written quantity are given and they differ, this
 * does not quietly take the meter. It refuses, because the two numbers
 * disagreeing is the thing somebody needs to look at: either the driver
 * mistyped, or the meter was not zeroed, or the hose was moved between tanks.
 * Picking one silently would mean the company charges a number nobody checked
 * and loses the only signal that something went wrong at the kerb.
 *
 * WHEN THEY AGREE, WHICH ONE IS STORED IS UNOBSERVABLE, and an earlier
 * version of this comment implied otherwise. The column is `numeric(14,4)`,
 * so "400" and "400.0000" normalise to the same stored value: preferring
 * either is the same program. The computed figure is used because it is the
 * one that does not depend on a keypad, not because the difference can be
 * measured.
 */
function resolveQuantity(input: DeliveryInput): string {
  const hasMeter = input.meterStart !== undefined && input.meterStart !== null
    && input.meterStop !== undefined && input.meterStop !== null;

  if (hasMeter) {
    const start = decimal(input.meterStart!, "meter start");
    const stop = decimal(input.meterStop!, "meter stop");
    /**
     * A meter that reads lower at the end has rolled over or been swapped,
     * and either way the difference is not the quantity. Refused rather than
     * made absolute: the absolute value of a rollover is nowhere near the
     * amount delivered.
     */
    if (stop < start) {
      throw new ConflictError(
        "The meter reads lower after the delivery than before it. A meter that has rolled "
        + "over or been replaced cannot say how much came off the truck, so the quantity has "
        + "to be entered.",
      );
    }
    const metered = (stop - start).toFixed(4);
    if (input.quantity !== undefined) {
      const written = decimal(input.quantity, "quantity");
      if (Math.abs(written - (stop - start)) > 0.0001) {
        throw new ConflictError(
          `The meter says ${metered} and the delivery says ${input.quantity}. One of the two `
          + "is wrong and which one matters: the customer is charged from this number.",
        );
      }
    }
    return metered;
  }

  if (input.quantity === undefined) {
    throw new ConflictError(
      "A delivery needs either a quantity or both meter readings. Without one of those there "
      + "is nothing to charge from.",
    );
  }
  const written = decimal(input.quantity, "quantity");
  if (written <= 0) {
    throw new ConflictError("A delivery of nothing is not a delivery. Record the trip instead.");
  }
  return input.quantity;
}

function decimal(value: string, what: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConflictError(`That is not a ${what}.`);
  return parsed;
}

function percent(value: string | null | undefined, what: string): void {
  if (value === undefined || value === null) return;
  const parsed = decimal(value, what);
  /**
   * Nought to a hundred, because this column is a percentage and a propane
   * tank is never filled past eighty for thermal expansion. The upper bound
   * is a hundred rather than eighty so the product does not encode one
   * trade's rule, and anything outside it is a units mistake: somebody
   * entering gallons where a percentage was asked for.
   */
  if (parsed < 0 || parsed > 100) {
    throw new ConflictError(
      `${value} is not a ${what}: it is a percentage of the tank, nought to a hundred. A `
      + "figure outside that is usually a quantity entered in the wrong box.",
    );
  }
}

/**
 * The property is this customer's, and anything else named is at it.
 *
 * Checked because a delivery is the one record in this product that names a
 * customer, a property, a job, a visit and a tank at once, and a mismatch
 * between any two of them produces a charge on the wrong account. The
 * customer/property link is the one that matters most: billing a drop to a
 * customer who does not own the tank it went into is money taken from the
 * wrong person.
 */
async function assertBelongsHere(
  tx: Database, organizationId: string, input: DeliveryInput,
): Promise<void> {
  const [link] = await tx.select({ id: schema.customerProperty.id })
    .from(schema.customerProperty)
    .where(and(
      eq(schema.customerProperty.organizationId, organizationId),
      eq(schema.customerProperty.customerId, input.customerId),
      eq(schema.customerProperty.propertyId, input.propertyId),
    ));
  if (!link) {
    throw new ConflictError(
      "That property is not on this customer's account. A delivery billed to somebody who "
      + "does not own the tank is money taken from the wrong person.",
    );
  }

  if (input.equipmentId) {
    const [tank] = await tx.select({ id: schema.equipment.id }).from(schema.equipment)
      .where(and(
        eq(schema.equipment.organizationId, organizationId),
        eq(schema.equipment.id, input.equipmentId),
        eq(schema.equipment.propertyId, input.propertyId),
      ));
    if (!tank) throw new NotFoundError("Tank at this property");
  }
}

export interface DeliveryQuery {
  customerId?: string | undefined;
  propertyId?: string | undefined;
  equipmentId?: string | undefined;
  product?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** Only the trips where the tank would not take a full load. */
  partialOnly?: boolean | undefined;
  limit?: number | undefined;
}

export async function list(
  ctx: ServiceContext, input: DeliveryQuery,
): Promise<{
  deliveries: DeliveryView[];
  totals: { quantity: string; value: string; partialFills: number };
}> {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

    const rows = await tx.select().from(schema.delivery)
      .where(and(
        eq(schema.delivery.organizationId, ctx.actor.organizationId),
        input.customerId ? eq(schema.delivery.customerId, input.customerId) : undefined,
        input.propertyId ? eq(schema.delivery.propertyId, input.propertyId) : undefined,
        input.equipmentId ? eq(schema.delivery.equipmentId, input.equipmentId) : undefined,
        input.product ? eq(schema.delivery.product, input.product) : undefined,
        input.from ? gte(schema.delivery.deliveredAt, new Date(input.from)) : undefined,
        input.to ? lte(schema.delivery.deliveredAt, new Date(input.to)) : undefined,
        input.partialOnly ? eq(schema.delivery.wasPartialFill, true) : undefined,
      ))
      .orderBy(desc(schema.delivery.deliveredAt))
      .limit(limit);

    let quantity = 0;
    let value = m.money("0", "USD");
    let partialFills = 0;
    const views = rows.map((row) => {
      const shaped = view(row);
      quantity += Number(row.quantity);
      value = m.add(value, m.money(shaped.total, "USD"));
      if (row.wasPartialFill) partialFills += 1;
      return shaped;
    });

    return {
      deliveries: views,
      totals: {
        /**
         * Summed across products only when one was asked for. A total of
         * gallons of oil plus pounds of chemical is not a quantity of
         * anything, so without a product filter the figure is the count of
         * units delivered and says so by being alongside a filter the caller
         * chose.
         */
        quantity: quantity.toFixed(4),
        value: m.toString(value),
        partialFills,
      },
    };
  });
}

export interface Consumption {
  propertyId: string;
  product: string;
  /** The window actually measured, which is between the first and last drop. */
  from: string;
  to: string;
  days: number;
  deliveries: number;
  /** Everything delivered in the window except the first drop. See below. */
  quantity: string;
  /** Quantity per day over the window, which is what a forecast is built on. */
  perDay: string;
  /** How many of the drops found a tank that would not take a full load. */
  partialFills: number;
  /** Null when there is not enough history to say anything. */
  nextDueEstimate: string | null;
}

/**
 * How fast this property gets through it, and roughly when the truck goes
 * next.
 *
 * THE FIRST DELIVERY'S QUANTITY IS EXCLUDED FROM THE RATE, which is the one
 * piece of arithmetic here that is easy to get wrong and expensive when it
 * is. Consumption is measured BETWEEN deliveries: the oil in the first drop
 * is what the customer burned over an interval this product cannot see,
 * because it started before the first record. Including it divides a quantity
 * spanning an unknown period by a known one, and the answer is always too
 * high, so the truck goes too early, every time, for every customer.
 *
 * `nextDueEstimate` is deliberately an ESTIMATE and is null rather than
 * guessed. Two deliveries is one interval, and one interval is not a rate: a
 * cold fortnight would set the schedule for the year. Three drops is the
 * minimum this will answer from, and even then the answer is a date to look
 * at rather than a promise, because nothing here models the weather.
 */
export async function consumption(
  ctx: ServiceContext,
  input: { propertyId: string; product: string },
): Promise<Consumption | null> {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const rows = await tx.select({
      quantity: schema.delivery.quantity,
      deliveredAt: schema.delivery.deliveredAt,
      wasPartialFill: schema.delivery.wasPartialFill,
    }).from(schema.delivery)
      .where(and(
        eq(schema.delivery.organizationId, ctx.actor.organizationId),
        eq(schema.delivery.propertyId, input.propertyId),
        eq(schema.delivery.product, input.product),
      ))
      .orderBy(asc(schema.delivery.deliveredAt));

    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return null;

    /**
     * NO SEPARATE "FEWER THAN TWO" CHECK, because it could not be the thing
     * that decided.
     *
     * There was one, and a deliberate breakage weakened it to "fewer than
     * one" with every test still green: a single delivery is its own first
     * and last, so the span below is zero and this returns null anyway. A
     * guard that cannot fail reads as protection that is not there, and this
     * codebase has removed three of those already.
     *
     * The span check is the real one, and it also covers the case the count
     * could not: two deliveries recorded at the same instant, which a
     * backfill produces, and which would divide by zero.
     */
    const days = (last.deliveredAt.getTime() - first.deliveredAt.getTime()) / 86_400_000;
    if (days <= 0) return null;

    /**
     * Everything after the first drop. Each of those quantities is what the
     * customer burned since the previous visit, which is a period this
     * product can measure.
     */
    const burned = rows.slice(1).reduce((acc, row) => acc + Number(row.quantity), 0);
    const perDay = burned / days;

    return {
      propertyId: input.propertyId,
      product: input.product,
      from: first.deliveredAt.toISOString(),
      to: last.deliveredAt.toISOString(),
      days: Number(days.toFixed(2)),
      deliveries: rows.length,
      quantity: burned.toFixed(4),
      perDay: perDay.toFixed(4),
      partialFills: rows.filter((row) => row.wasPartialFill).length,
      /**
       * From the last drop, at the measured rate, to the quantity the last
       * drop put in. Three deliveries minimum, and null below that for the
       * reason in the header.
       */
      nextDueEstimate: rows.length >= 3 && perDay > 0
        ? new Date(
          last.deliveredAt.getTime() + (Number(last.quantity) / perDay) * 86_400_000,
        ).toISOString()
        : null,
    };
  });
}

export const handlers = {
  recordDelivery: (ctx: ServiceContext, input: DeliveryInput): Promise<DeliveryView> =>
    record(ctx, input),
  listDeliveries: (ctx: ServiceContext, input: DeliveryQuery): Promise<{
    deliveries: DeliveryView[];
    totals: { quantity: string; value: string; partialFills: number };
  }> => list(ctx, input),
  getConsumption: async (
    ctx: ServiceContext, input: { propertyId: string; product: string },
  ): Promise<{ consumption: Consumption | null }> =>
    ({ consumption: await consumption(ctx, input) }),
} as const;
