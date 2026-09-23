import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * TIME, AND WHAT IT COST
 *
 * Timesheets were services and a screen with no contract, so payroll was the
 * one part of the product an integration could not read. That is backwards:
 * payroll is the thing every contractor already exports somewhere, and a
 * product that makes them do it by hand is one they will keep a spreadsheet
 * alongside.
 *
 * TWO NUMBERS, AND ONLY ONE OF THEM IS STORED. The weekly classification
 * into regular, overtime and double time is DERIVED from the entries every
 * time it is asked for, because a stored overtime total is a number somebody
 * can edit and a payroll figure nobody can explain is worse than a wrong
 * one. The APPLIED RATE is stored, frozen at close, from the scale that was
 * in effect on the day the work happened: a rate read live at report time
 * changes retroactively when somebody edits a scale, and last quarter's job
 * costing moves after the quarter closed.
 *
 * HOURS ARE STRINGS, to two places. Same reason quantities are.
 */

export const HoursString = z.string().regex(/^-?\d+\.\d{2}$/, "hours to two places");

export const WeekRow = z.object({
  technicianId: Uuid,
  technicianName: z.string(),
  /** Whatever the company calls this person's wage band. Free text, because nobody else's list matches theirs. */
  classification: z.string().nullable(),
  regularHours: HoursString,
  overtimeHours: HoursString,
  doubleTimeHours: HoursString,
  totalHours: HoursString,
  /** Null when no rate was ever frozen onto the entries. Not zero: zero is a claim, null is the absence of one. */
  cost: MoneyString.nullable(),
  /** Still running. These cannot be approved, and a week containing one is not final. */
  openEntries: z.number().int(),
  unapproved: z.number().int(),
});

export const OvertimePolicy = z.object({
  label: z.string(),
  timeZone: z.string(),
  weekStartsOn: z.number().int().min(0).max(6),
  dayAttribution: z.enum(["shift_start", "split_at_midnight"]),
  weeklyThresholdMinutes: z.number().int().nullable(),
  weeklyDoubleTimeThresholdMinutes: z.number().int().nullable(),
  dailyThresholdMinutes: z.number().int().nullable(),
  dailyDoubleTimeThresholdMinutes: z.number().int().nullable(),
  overtimeMultiplier: RateString,
  doubleTimeMultiplier: RateString,
  onCallTreatment: z.enum(["separate_rate_not_hours_worked", "hours_worked_at_base"]),
});

export const getTimesheetWeek = defineRoute({
  method: "get",
  path: "/v1/timesheets/week",
  summary: "A week, per person, classified",
  description:
    "Refuses when no overtime policy is set, rather than assuming one. Every plausible default is a legal position on somebody's wages: forty hours weekly at time and a half is the federal floor and is wrong in California, where a ninth hour in a day is already overtime. The policy that produced these numbers is returned with them.",
  module: "M17",
  permissions: ["timesheet:read"],
  input: z.object({
    /** Any date in the week. The week start is resolved from the policy, not assumed to be Monday. */
    weekOf: z.string().date(),
    technicianId: Uuid.optional(),
  }),
  output: z.object({
    weekStart: z.string().date(),
    policy: OvertimePolicy,
    rows: z.array(WeekRow),
  }),
});

export const TimeEntry = z.object({
  id: Uuid,
  technicianId: Uuid,
  kind: z.string(),
  jobId: Uuid.nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  minutes: z.number().int().nullable(),
  classification: z.string().nullable(),
  /** Frozen at close, from the scale in effect on the day worked. Never recomputed. */
  appliedBaseRate: MoneyString.nullable(),
  appliedFringeRate: MoneyString.nullable(),
  appliedLoadedRate: MoneyString.nullable(),
  wageScaleId: Uuid.nullable(),
  approvedAt: z.string().datetime().nullable(),
  approvedByUserId: Uuid.nullable(),
});

export const listTimeEntries = defineRoute({
  method: "get",
  path: "/v1/timesheets/entries",
  summary: "One person's entries for one week",
  module: "M17",
  permissions: ["timesheet:read"],
  input: z.object({
    technicianId: Uuid,
    weekOf: z.string().date(),
  }),
  output: z.object({
    weekStart: z.string().date(),
    entries: z.array(TimeEntry),
  }),
});

export const approveTimeEntries = defineRoute({
  method: "post",
  path: "/v1/timesheets/approvals",
  summary: "Approve entries",
  description:
    "An entry still running is refused, because approving one means signing off on hours that have not finished happening, at whatever number they had reached when somebody clicked. Already approved entries are skipped rather than re-stamped, so the count returned is what this call actually changed.",
  module: "M17",
  permissions: ["timesheet:approve"],
  idempotent: true,
  input: z.object({ entryIds: z.array(Uuid).min(1) }),
  output: z.object({ approved: z.number().int() }),
});

export const laborRoutes = {
  getTimesheetWeek, listTimeEntries, approveTimeEntries,
} as const;
