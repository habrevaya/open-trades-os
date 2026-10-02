import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * M21. THE RECORDS BEHIND A NUMBER, AND REPORTS THAT ARRIVE ON THEIR OWN
 *
 * A report definition is data: a dataset, some dimensions, some measures, some
 * filters, all keys into a catalogue the product declares. A drill takes one,
 * plus the values on the row that was clicked, and returns the records that
 * row is made of, each with what it added to every measure, and the totals,
 * which are the number that was clicked.
 *
 * A schedule points at a report (one that ships, or one somebody saved) and
 * says when it goes and to whom. The worker sends it, once per occurrence, as
 * the person who set it up, to people who could open it themselves and to any
 * outside address the owner named.
 */

export const ReportFilter = z.object({
  dimension: z.string(),
  op: z.enum(["eq", "neq", "in"]),
  value: z.union([z.string(), z.array(z.string())]),
});

export const ReportDefinition = z.object({
  dataset: z.string(),
  dimensions: z.array(z.string()),
  measures: z.array(z.string()).min(1),
  filters: z.array(ReportFilter).optional(),
  /** Inclusive. */
  from: z.string().date().optional(),
  /** Exclusive, so a month does not include the first moment of the next. */
  to: z.string().date().optional(),
  orderBy: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const drillReport = defineRoute({
  method: "post",
  path: "/v1/reports/drill",
  summary: "The records behind one row of a report",
  description:
    "Takes a report definition and the values on the row that was clicked, one per grouped dimension (null for a group the report showed as Not set), and returns the records that row is made of: the definition's own scope, filters and date range, with each pinned dimension matched and the grouping taken off. Each record carries what it added to every measure, and the totals are over every record behind the row, which is the number that was clicked. Refused exactly where the report would be, in the report's words. Up to a thousand records are listed; the totals always cover all of them.",
  module: "M21",
  permissions: ["report:read"],
  /** A question, asked twice, with the same answer. Nothing is written. */
  idempotent: true,
  input: z.object({
    definition: ReportDefinition,
    match: z.record(z.string().nullable()),
  }),
  output: z.object({
    noun: z.string(),
    plural: z.string(),
    pinned: z.array(z.object({
      key: z.string(), label: z.string(), type: z.string(), value: z.string().nullable(),
      sortPrefix: z.boolean().optional(),
    })),
    columns: z.array(z.object({
      key: z.string(), label: z.string(), type: z.string(), role: z.enum(["record", "measure"]),
    })),
    rows: z.array(z.object({
      id: z.string(),
      label: z.string(),
      href: z.string(),
      values: z.record(z.union([z.string(), z.number(), z.null()])),
      links: z.record(z.string()),
    })),
    totals: z.record(z.string().nullable()),
    count: z.number().int(),
    truncated: z.boolean(),
  }),
});

const Recipient = z.object({
  address: z.string(),
  userId: z.string().optional(),
  messageId: z.string().optional(),
  /** Why this one was not sent: left the company, may not see the report, suppressed. */
  refused: z.string().optional(),
  /** The outbox's word for the message: queued, sent, delivered, bounced. */
  messageStatus: z.string().nullable(),
});

export const ReportDeliveryRecord = z.object({
  id: Uuid,
  at: z.string().datetime(),
  /** `queued`, `partly_queued`, `refused` or `failed`. */
  status: z.string(),
  error: z.string().nullable(),
  periodFrom: z.string().date().nullable(),
  periodTo: z.string().date().nullable(),
  rowCount: z.number().int().nullable(),
  recipients: z.array(Recipient),
});

const Cadence = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  /** ISO weekdays, Monday 1 to Sunday 7. Weekly only. */
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  /** 1 to 28. Monthly only. */
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  /** `HH:MM`, 24 hour, in the company's timezone. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

const Period = z.enum(["all", "yesterday", "last_7_days", "last_month", "month_to_date"]);

export const ReportScheduleInput = z.object({
  /** Exactly one of these: a report that ships, by slug, or a saved one. */
  builtIn: z.string().optional(),
  reportId: Uuid.optional(),
  name: z.string().max(200).optional(),
  ...Cadence.shape,
  /** Which days it covers. Defaults to the day, week or month before. */
  period: Period.optional(),
  /** People in the company. Each must be able to run the report themselves. */
  userIds: z.array(Uuid).optional(),
  /** Addresses outside the company: the accountant. */
  addresses: z.array(z.string()).optional(),
});

export const ReportSchedule = z.object({
  id: Uuid,
  name: z.string(),
  builtIn: z.string().nullable(),
  reportId: Uuid.nullable(),
  reportPath: z.string().nullable(),
  cadence: Cadence,
  cadenceText: z.string(),
  period: Period,
  periodText: z.string(),
  userIds: z.array(Uuid),
  people: z.array(z.object({ userId: Uuid, name: z.string() })),
  addresses: z.array(z.string()),
  paused: z.boolean(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  ownerUserId: Uuid.nullable(),
  lastDelivery: ReportDeliveryRecord.nullable(),
});

/** The row as stored, which is what a write answers with. */
const StoredSchedule = z.object({
  id: Uuid,
  name: z.string(),
  builtInReport: z.string().nullable(),
  reportId: Uuid.nullable(),
  frequency: z.string(),
  weekdays: z.array(z.number().int()),
  dayOfMonth: z.number().int().nullable(),
  timeOfDay: z.string(),
  period: z.string(),
  recipientUserIds: z.array(Uuid),
  externalAddresses: z.array(z.string()),
  pausedAt: z.string().datetime().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});

export const listReportSchedules = defineRoute({
  method: "get",
  path: "/v1/report-schedules",
  summary: "Reports that arrive on their own, and what each last did",
  description:
    "Every report schedule: which report, when it goes in words and as data, which days it covers, who it goes to, whether it is paused, when it is next due, and its last delivery with the outcome for each recipient.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({}),
  output: z.object({ schedules: z.array(ReportSchedule) }),
});

export const createReportSchedule = defineRoute({
  method: "post",
  path: "/v1/report-schedules",
  summary: "Email a report on a schedule",
  description:
    "Daily, weekly on chosen days, or monthly on a day from 1 to 28, at a time in the company's timezone. It runs as the person who sets it up, re-checked on the day it runs, and goes to people in the company who could open it themselves and to any outside address named. Each delivery is a readable summary with every row in a CSV attached. The first one goes at the next occurrence, not now.",
  module: "M21",
  permissions: ["report:build"],
  idempotent: true,
  input: ReportScheduleInput,
  output: StoredSchedule,
});

export const updateReportSchedule = defineRoute({
  method: "patch",
  path: "/v1/report-schedules/{id}",
  summary: "Change a report schedule",
  description:
    "The whole schedule, as for a new one. The person changing it becomes whose authority it runs under, because they are the one now vouching for who receives it.",
  module: "M21",
  permissions: ["report:build"],
  input: ReportScheduleInput.extend({ id: Uuid }),
  output: StoredSchedule,
});

export const setReportSchedulePaused = defineRoute({
  method: "post",
  path: "/v1/report-schedules/{id}/paused",
  summary: "Pause or resume a report schedule",
  description:
    "Paused, nothing is sent and nothing is owed. Resumed, it goes at the next occurrence from now: the ones missed while paused are not sent.",
  module: "M21",
  permissions: ["report:build"],
  /** Setting a state: the same request twice leaves the same state. */
  idempotent: true,
  input: z.object({ id: Uuid, paused: z.boolean() }),
  output: StoredSchedule,
});

export const deleteReportSchedule = defineRoute({
  method: "delete",
  path: "/v1/report-schedules/{id}",
  summary: "Stop a report schedule for good",
  description: "What it already sent stays in the delivery history, named as it was.",
  module: "M21",
  permissions: ["report:build"],
  input: z.object({ id: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

export const listReportDeliveries = defineRoute({
  method: "get",
  path: "/v1/report-deliveries",
  summary: "Every report emailed, by a schedule or an automation",
  description:
    "Newest first. Each says which report, the dates it covered, how many rows, and for each recipient the message it went as and that message's status, or why it was not sent. A delivery that could not run at all says why.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({
    scheduleId: Uuid.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({
    deliveries: z.array(ReportDeliveryRecord.extend({
      reportName: z.string(),
      scheduleId: Uuid.nullable(),
      workflowRunId: Uuid.nullable(),
    })),
  }),
});

export const reportRoutes = {
  drillReport,
  listReportSchedules, createReportSchedule, updateReportSchedule,
  setReportSchedulePaused, deleteReportSchedule, listReportDeliveries,
} as const;
