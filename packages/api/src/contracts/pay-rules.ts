import { z } from "zod";
import { defineRoute } from "../lib/define";
import { MoneyString, RateString, Uuid } from "./common";

/**
 * WHAT PEOPLE ARE PAID, DECLARED
 *
 * The overtime policy and the wage scales were written, refused the right
 * things through core, and reachable from nothing but a service call: the
 * module doc said they were declared through the API and there was no route.
 * These are the routes, and the payroll settings screen uses them.
 *
 * Both are SUPERSEDED, never edited. A new policy deactivates the old one,
 * and a changed rate closes the old scale the day before the new one starts,
 * because "what were we paying in March" is a question with an answer only
 * if March's declaration is still there.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date like 2026-11-01");

export const WageScale = z.object({
  id: Uuid,
  authority: z.string(),
  classification: z.string(),
  jurisdiction: z.string().nullable(),
  externalReference: z.string().nullable(),
  baseRate: z.string(),
  fringeRate: z.string().nullable(),
  /** The scale's own overtime multiplier, as its agreement states it. Recorded, not used by the pay calculation. */
  overtimeMultiplier: z.string().nullable(),
  /** The scale's own double time multiplier. Recorded, not used by the pay calculation. */
  doubleTimeMultiplier: z.string().nullable(),
  /** How many apprentices to journeymen the agreement allows, in its own words ("1:3"). Recorded only. */
  apprenticeRatio: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  /** False once retired or replaced by a change. The dates say what was in effect when. */
  active: z.boolean(),
});

export const listWageScales = defineRoute({
  method: "get",
  path: "/v1/payroll/wage-scales",
  summary: "The rates each classification is paid at, dated",
  description: "Every scale, current and past, by classification and newest first. Past ones are kept because entries worked under them were costed at them.",
  module: "M17",
  permissions: ["timesheet:read"],
  input: z.object({ classification: z.string().max(200).optional() }),
  output: z.object({ scales: z.array(WageScale) }),
});

export const loadWageScale = defineRoute({
  method: "post",
  path: "/v1/payroll/wage-scales",
  summary: "Load a wage scale",
  description: "A rate for a classification, optionally from and to a date. A prevailing wage determination or a collective agreement needs the reference it comes from, because without one the rate cannot be checked against anything.",
  module: "M17",
  permissions: ["payroll:configure"],
  idempotent: true,
  input: z.object({
    classification: z.string().min(1).max(200),
    baseRate: MoneyString,
    authority: z.enum([
      "employee_default", "collective_agreement", "wage_determination", "contract", "manual_override",
    ]).optional(),
    jurisdiction: z.string().max(200).nullable().optional(),
    externalReference: z.string().max(200).nullable().optional(),
    fringeRate: MoneyString.nullable().optional(),
    /** At least 1. Recorded with the scale: payroll still works overtime out from the company's overtime policy. */
    overtimeMultiplier: RateString.nullable().optional(),
    doubleTimeMultiplier: RateString.nullable().optional(),
    apprenticeRatio: z.string().max(50).nullable().optional(),
    effectiveFrom: IsoDate.nullable().optional(),
    effectiveTo: IsoDate.nullable().optional(),
  }),
  output: WageScale,
});

export const reviseWageScale = defineRoute({
  method: "post",
  path: "/v1/payroll/wage-scales/{id}/revisions",
  summary: "Change a scale's rate from a date",
  description: "Closes this scale the day before `effectiveFrom` and loads a new one from that day with everything else it said. Entries worked before keep the rate they were costed at. Refused when the change would start on or before the day this scale began: retire it and load the right one instead.",
  module: "M17",
  permissions: ["payroll:configure"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    baseRate: MoneyString,
    fringeRate: MoneyString.nullable().optional(),
    effectiveFrom: IsoDate,
  }),
  output: WageScale,
});

export const retireWageScale = defineRoute({
  method: "post",
  path: "/v1/payroll/wage-scales/{id}/retire",
  summary: "Stop a scale on a date",
  description: "The scale stays on the record and stops being the rate after that day. It is never deleted, because entries already approved and paid were costed against it.",
  module: "M17",
  permissions: ["payroll:configure"],
  idempotent: true,
  input: z.object({ id: Uuid, effectiveTo: IsoDate }),
  output: WageScale,
});

export const DeclaredOvertimePolicy = z.object({
  id: Uuid,
  label: z.string(),
  note: z.string().nullable(),
  timeZone: z.string(),
  weekStartsOn: z.number().int(),
  dayAttribution: z.string(),
  weeklyThresholdMinutes: z.number().int().nullable(),
  dailyThresholdMinutes: z.number().int().nullable(),
  overtimeMultiplier: z.string(),
  doubleTimeMultiplier: z.string(),
  onCallTreatment: z.string(),
  rounding: z.string().nullable(),
  active: z.boolean(),
  declaredOn: z.string(),
});

export const listOvertimePolicies = defineRoute({
  method: "get",
  path: "/v1/payroll/overtime-policies",
  summary: "The overtime policy, and every one before it",
  description: "Current first. A replaced policy is kept, because it is the answer to what the company was operating under on a past week.",
  module: "M17",
  permissions: ["timesheet:read"],
  input: z.object({}),
  output: z.object({ policies: z.array(DeclaredOvertimePolicy) }),
});

export const declareOvertimePolicy = defineRoute({
  method: "post",
  path: "/v1/payroll/overtime-policies",
  summary: "Declare the overtime policy",
  description: "Replaces the current one. Checked by the same rules a timesheet runs on: no rounding that only ever runs down, no double time below overtime, no multiplier under one, and on call time declared rather than guessed. Overtime is worked out when hours are read, so a new policy changes the overtime split on weeks already approved; the answer says when it does. Rates frozen on punches do not move.",
  module: "M17",
  permissions: ["payroll:configure"],
  idempotent: true,
  input: z.object({
    label: z.string().min(1).max(200),
    note: z.string().min(1).max(2000),
    timeZone: z.string().max(100).optional(),
    weekStartsOn: z.number().int().min(0).max(6).optional(),
    dayAttribution: z.enum(["shift_start", "split_at_midnight"]).optional(),
    weeklyThresholdMinutes: z.number().int().min(0).nullable().optional(),
    weeklyDoubleTimeThresholdMinutes: z.number().int().min(0).nullable().optional(),
    dailyThresholdMinutes: z.number().int().min(0).nullable().optional(),
    dailyDoubleTimeThresholdMinutes: z.number().int().min(0).nullable().optional(),
    overtimeMultiplier: RateString.optional(),
    doubleTimeMultiplier: RateString.optional(),
    onCallTreatment: z.enum(["separate_rate_not_hours_worked", "hours_worked_at_base"]),
    roundingMinutes: z.number().int().min(1).max(60).nullable().optional(),
    roundingMode: z.enum(["nearest", "up", "down"]).nullable().optional(),
  }),
  output: z.object({
    id: Uuid,
    label: z.string(),
    replaced: z.string().nullable(),
    reclassifiesApprovedTime: z.boolean(),
  }),
});

export const listCrewRates = defineRoute({
  method: "get",
  path: "/v1/payroll/crew-rates",
  summary: "Who would cost what today, and who would cost nothing",
  description: "Each person with their classification and the scale in effect today. A person with no classification, or one no scale covers, is named with the reason, because their time costs nothing and a job with no labour cost reads as a very profitable job.",
  module: "M17",
  permissions: ["timesheet:read"],
  input: z.object({}),
  output: z.object({
    people: z.array(z.object({
      id: Uuid,
      displayName: z.string(),
      active: z.boolean(),
      classification: z.string().nullable(),
      baseRate: z.string().nullable(),
      fringeRate: z.string().nullable(),
      unpricedBecause: z.string().nullable(),
    })),
  }),
});

export const setWageClassification = defineRoute({
  method: "post",
  path: "/v1/payroll/classifications",
  summary: "Set the classification a person is paid at",
  description: "Refused for a name no scale has ever carried, because a typo here is a person whose time costs nothing. Null clears it.",
  module: "M17",
  permissions: ["payroll:configure"],
  idempotent: true,
  input: z.object({ technicianId: Uuid, classification: z.string().max(200).nullable() }),
  output: z.object({ id: Uuid, displayName: z.string(), classification: z.string().nullable() }),
});

export const payRuleRoutes = {
  listWageScales, loadWageScale, reviseWageScale, retireWageScale,
  listOvertimePolicies, declareOvertimePolicy, listCrewRates, setWageClassification,
} as const;
