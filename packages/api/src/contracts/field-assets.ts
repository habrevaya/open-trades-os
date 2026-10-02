import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * THREE TABLES NOTHING WROTE, AND ONE THAT NOTHING TOUCHED AT ALL
 *
 * `visit_asset` was read by the equipment history, which has a section for
 * per-unit outcomes that was always empty, and `visitAsset.completedAt` sat
 * in `unwritten-columns.test.ts` as a known gap.
 *
 * `deficiency.equipment_id` was the second known gap: faults were written,
 * and none of them was attached to the machine it was found on.
 *
 * `delivery` was neither read nor written by any line of code. That is not a
 * gap in a feature, it is a whole way of taking money that was absent while
 * the table described it in enough detail to be unmistakable: a quantity off
 * a truck's meter, a tank percentage before and after, and a flag for the
 * trip where the tank would only take ninety gallons.
 */

const Quantity = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "A quantity is a decimal string");
const Percent = z.string().regex(/^\d+(\.\d{1,4})?$/, "A tank percentage is a decimal string");

/* ------------------------------------------- the units one visit covers */

export const Outcome = z.enum([
  "serviced", "faults_found", "no_access", "skipped", "out_of_service",
]);

export const VisitUnit = z.object({
  id: Uuid,
  visitId: Uuid,
  equipmentId: Uuid,
  /** The tag, the category and the model joined, so a list reads on a phone. */
  equipmentLabel: z.string().nullable(),
  sequence: z.number(),
  outcome: Outcome.nullable(),
  notes: z.string().nullable(),
  completedAt: z.string().nullable(),
  deficiencyCount: z.number(),
});

export const getVisitUnits = defineRoute({
  method: "get",
  path: "/v1/visits/{visitId}/units",
  summary: "The machines this visit covers, in the order to walk them",
  module: "M33",
  permissions: ["visit:read"],
  input: z.object({ visitId: Uuid }),
  output: z.object({ units: z.array(VisitUnit) }),
});

export const planVisitUnits = defineRoute({
  method: "put",
  path: "/v1/visits/{visitId}/units",
  summary: "Say which machines this visit covers",
  description:
    "A job names one unit: the one somebody rang about. A building with eight rooftop units has one maintenance job and eight machines, each with its own verdict. Replaces the list, in the order given, except that units already recorded as done are kept: a dispatcher tidying the list at eleven must not delete the morning's work.",
  module: "M33",
  permissions: ["visit:write"],
  idempotent: true,
  input: z.object({ visitId: Uuid, equipmentIds: z.array(Uuid) }),
  output: z.object({ planned: z.number(), kept: z.number() }),
});

export const recordUnitOutcome = defineRoute({
  method: "post",
  path: "/v1/visits/{visitId}/units/{equipmentId}/outcome",
  summary: "What happened to one machine",
  description:
    "The moment comes from the caller rather than the clock, because the field app records a round in a basement and syncs it an hour later: now() would stamp eight units with the moment the phone found signal and lose the order they were done in. Skipping a unit needs a note, because every other outcome says what happened and that one says somebody decided.",
  module: "M33",
  permissions: ["visit:write"],
  idempotent: true,
  input: z.object({
    visitId: Uuid,
    equipmentId: Uuid,
    outcome: Outcome,
    notes: z.string().max(2000).nullable().optional(),
    at: z.string().datetime().optional(),
  }),
  output: VisitUnit,
});

/* ----------------------------------------------------------- deliveries */

export const Delivery = z.object({
  id: Uuid,
  customerId: Uuid,
  propertyId: Uuid,
  equipmentId: Uuid.nullable(),
  jobId: Uuid.nullable(),
  visitId: Uuid.nullable(),
  product: z.string(),
  quantity: Quantity,
  unit: z.string(),
  unitPrice: MoneyString,
  /** quantity times unitPrice, computed rather than stored. */
  total: MoneyString,
  meterStart: Quantity.nullable(),
  meterStop: Quantity.nullable(),
  tankPercentBefore: Percent.nullable(),
  tankPercentAfter: Percent.nullable(),
  wasPartialFill: z.boolean(),
  deliveredAt: z.string(),
});

export const recordDelivery = defineRoute({
  method: "post",
  path: "/v1/deliveries",
  summary: "Record what came off the truck",
  description:
    "The meter is the authority: given both readings, the quantity is their difference. Given both readings AND a written quantity that disagrees, this refuses rather than quietly preferring one, because the disagreement is the thing somebody needs to look at and the customer is charged from this number.",
  module: "M33",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    propertyId: Uuid,
    product: z.string().min(1).max(100),
    unit: z.string().min(1).max(40),
    unitPrice: MoneyString,
    quantity: Quantity.optional(),
    meterStart: Quantity.nullable().optional(),
    meterStop: Quantity.nullable().optional(),
    tankPercentBefore: Percent.nullable().optional(),
    tankPercentAfter: Percent.nullable().optional(),
    wasPartialFill: z.boolean().optional(),
    jobId: Uuid.nullable().optional(),
    visitId: Uuid.nullable().optional(),
    equipmentId: Uuid.nullable().optional(),
    deliveredAt: z.string().datetime().optional(),
  }),
  output: Delivery,
});

export const listDeliveries = defineRoute({
  method: "get",
  path: "/v1/deliveries",
  summary: "What has been delivered, and what it was worth",
  description:
    "The quantity total is a count of units and only means one thing when a product was asked for: gallons of oil plus pounds of chemical is not a quantity of anything.",
  module: "M33",
  permissions: ["invoice:read"],
  input: z.object({
    customerId: Uuid.optional(),
    propertyId: Uuid.optional(),
    equipmentId: Uuid.optional(),
    product: z.string().max(100).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    partialOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({
    deliveries: z.array(Delivery),
    totals: z.object({
      quantity: Quantity, value: MoneyString, partialFills: z.number(),
    }),
  }),
});

export const getConsumption = defineRoute({
  method: "get",
  path: "/v1/deliveries/consumption",
  summary: "How fast this property gets through it",
  description:
    "The first delivery's quantity is excluded from the rate, and that is the one piece of arithmetic here that is expensive to get wrong: consumption is measured BETWEEN deliveries, so the first drop is what was burned over a period that started before any record exists. Including it divides a quantity spanning an unknown period by a known one, the answer is always too high, and the truck goes too early for every customer. The next-due figure is null below three deliveries, because one interval is not a rate and a cold fortnight would set the schedule for the year.",
  module: "M33",
  permissions: ["invoice:read"],
  input: z.object({ propertyId: Uuid, product: z.string().min(1).max(100) }),
  output: z.object({
    consumption: z.object({
      propertyId: Uuid,
      product: z.string(),
      from: z.string(),
      to: z.string(),
      days: z.number(),
      deliveries: z.number(),
      quantity: Quantity,
      perDay: Quantity,
      partialFills: z.number(),
      nextDueEstimate: z.string().nullable(),
    }).nullable(),
  }),
});

export const fieldAssetRoutes = {
  getVisitUnits,
  planVisitUnits,
  recordUnitOutcome,
  recordDelivery,
  listDeliveries,
  getConsumption,
} as const;
