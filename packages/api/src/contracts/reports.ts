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
  /**
   * How the filters on the company's own custom fields are joined: `all` of
   * them (the default) or `any`. Filters on anything else always narrow.
   */
  fieldMatch: z.enum(["all", "any"]).optional(),
  /** Inclusive. */
  from: z.string().date().optional(),
  /** Exclusive, so a month does not include the first moment of the next. */
  to: z.string().date().optional(),
  orderBy: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  /**
   * One branch's records: its jobs and what hangs off them. Narrows what the
   * reader's own scope lets them see. Refused on a dataset whose records do
   * not belong to branches (tasks, calls).
   */
  branchId: Uuid.optional(),
});

export const drillReport = defineRoute({
  method: "post",
  path: "/v1/reports/drill",
  summary: "The records behind one row of a report",
  description:
    "Takes a report definition and the values on the row that was clicked, one per grouped dimension (null for a group the report showed as Not set), and returns the records that row is made of: the definition's own scope, filters and date range, with each pinned dimension matched and the grouping taken off. Each record carries what it added to every measure, and the totals are over every record behind the row, which is the number that was clicked. Refused exactly where the report would be, in the report's words. The records are listed a thousand to a page, newest first, or as many as `perPage` asks (one to a thousand), and `page` picks which (a page past the last is the last); the count and the totals are over every record on every page.",
  module: "M21",
  permissions: ["report:read"],
  /** A question, asked twice, with the same answer. Nothing is written. */
  idempotent: true,
  input: z.object({
    definition: ReportDefinition,
    match: z.record(z.string().nullable()),
    /** Which page of the records, from one. Left out, the first. */
    page: z.number().int().min(1).optional(),
    /** How many records to a page, from one to a thousand. Left out, a thousand. */
    perPage: z.number().int().min(1).max(1000).optional(),
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
    /** True when the records fill more than one page. */
    truncated: z.boolean(),
    page: z.number().int(),
    pages: z.number().int(),
    perPage: z.number().int(),
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
  /**
   * Exactly one of these: a report that ships, by slug, a saved one, a
   * dashboard that ships, by slug (`operations`, `money`), or a saved
   * dashboard, by id.
   */
  builtIn: z.string().optional(),
  reportId: Uuid.optional(),
  dashboard: z.string().optional(),
  dashboardId: Uuid.optional(),
  name: z.string().max(200).optional(),
  ...Cadence.shape,
  /**
   * Which days it covers. Defaults to the day, week or month before. A
   * dashboard is sent as it stands and takes only `all`, its default.
   */
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
  dashboard: z.string().nullable(),
  dashboardId: Uuid.nullable(),
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
  builtInDashboard: z.string().nullable(),
  dashboardId: Uuid.nullable(),
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
  summary: "Email a report or a dashboard on a schedule",
  description:
    "Daily, weekly on chosen days, or monthly on a day from 1 to 28, at a time in the company's timezone. It runs as the person who sets it up, re-checked on the day it runs, and goes to people in the company who could open it themselves and to any outside address named. Each delivery of a report is a readable summary with every row in a CSV and the same run as a PDF attached. A dashboard (`dashboard` or `dashboardId`) is sent as one PDF of every tile, drawn as each person in the company would see it, with the tiles they may not see left out and named; it is sent as it stands and takes no period but `all`, and a person who may see nothing on it is refused. The first one goes at the next occurrence, not now.",
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

export const sendReportScheduleNow = defineRoute({
  method: "post",
  path: "/v1/report-schedules/{id}/send",
  summary: "Send a scheduled report now",
  description:
    "The same delivery a scheduled occurrence makes, to the same people, covering the same days measured back from now, but run as the person sending it rather than whoever set the schedule up, and refused if they could not run the report themselves. Every recipient is checked and sent their own run as on a schedule. The schedule's clock does not move, and a paused schedule can still be sent by hand. The email goes out with the worker's next pass over the outbox.",
  module: "M21",
  permissions: ["report:build"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: ReportDeliveryRecord.extend({ scheduleId: Uuid }),
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

/* ---------------------------------------------------------- run and save */

const ResultColumn = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  /** What the report groups by, or what it counts. */
  role: z.enum(["dimension", "measure"]),
  /** The value starts with a number that only sorts it ("1 Over 90 days"): take it off to show it. */
  sortPrefix: z.boolean().optional(),
});

export const ReportResult = z.object({
  columns: z.array(ResultColumn),
  /** One per row, keyed by column. Money comes as text so no cent is lost. */
  rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
  /** True when the report stopped at a thousand rows. */
  truncated: z.boolean(),
});

export const SavedReport = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  definition: ReportDefinition,
  createdByUserId: Uuid.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const BuiltInReport = z.object({
  slug: z.string(),
  name: z.string(),
  /** The question it answers, in the words somebody would ask it. */
  question: z.string(),
  definition: ReportDefinition,
});

export const listReports = defineRoute({
  method: "get",
  path: "/v1/reports",
  summary: "The reports that ship and the ones the company saved",
  description:
    "The reports that ship with the product that the caller may run, each with the question it answers and its definition, and every report somebody in the company saved, by name. Run one with `POST /v1/reports/run` (a definition) or `POST /v1/reports/{id}/run` (a saved one). A saved report is listed to everybody who may run reports, the same as on the Reports screen, and running it is still checked against what the person running it may see.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({}),
  output: z.object({ builtIn: z.array(BuiltInReport), saved: z.array(SavedReport) }),
});

export const getReportCatalogue = defineRoute({
  method: "get",
  path: "/v1/reports/catalogue",
  summary: "What a report can be built from",
  description:
    "Every dataset the caller may report on, with the groupings and measures they may use in it, the company's own fields among them (`field: true`, which a report can join by any of them). Anything the caller does not hold the permission for is left out, so a definition built only from this list runs.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({}),
  output: z.object({
    datasets: z.array(z.object({
      key: z.string(),
      label: z.string(),
      description: z.string(),
      dimensions: z.array(z.object({ key: z.string(), label: z.string(), field: z.literal(true).optional() })),
      measures: z.array(z.object({ key: z.string(), label: z.string() })),
    })),
  }),
});

export const runReport = defineRoute({
  method: "post",
  path: "/v1/reports/run",
  summary: "Run a report",
  description:
    "Takes a report definition and returns its columns and rows, exactly as the Reports screen runs it: only the records the caller may see (a technician's own work, a branch manager's own branch), and refused in words where the caller may not run it. `branchId` narrows to one branch inside the caller's own scope and never widens it. Stops at a thousand rows, and says so with `truncated`.",
  module: "M21",
  permissions: ["report:read"],
  /** A question, asked twice, with the same answer. Nothing is written. */
  idempotent: true,
  input: z.object({ definition: ReportDefinition }),
  output: ReportResult,
});

const RunOverrides = {
  /** Replaces the saved report's own start date for this run. Inclusive. */
  from: z.string().date().optional(),
  /** Replaces the saved report's own end date for this run. Exclusive. */
  to: z.string().date().optional(),
  /** One branch, for this run, inside the caller's own scope. */
  branchId: Uuid.optional(),
};

export const runSavedReport = defineRoute({
  method: "post",
  path: "/v1/reports/{id}/run",
  summary: "Run a saved report",
  description:
    "Runs a report somebody saved, checked against the person running it and not the person who saved it, so a dispatcher running the owner's revenue report is refused. `from`, `to` and `branchId` change this run only, as the dates and branch boxes on its screen do; the saved report is not changed.",
  module: "M21",
  permissions: ["report:read"],
  idempotent: true,
  input: z.object({ id: Uuid, ...RunOverrides }),
  output: z.object({ report: SavedReport, result: ReportResult }),
});

const ReportInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  definition: ReportDefinition,
});

export const createReport = defineRoute({
  method: "post",
  path: "/v1/reports",
  summary: "Save a report",
  description:
    "Saves a definition under a name the company can find it by. Checked against what the person saving it may run, so a report they could not run themselves is refused rather than stored. Names are unique in the company, and a second report with a name already used is refused. A retry sent with the same `Idempotency-Key` gets the report the first one saved.",
  module: "M21",
  permissions: ["report:build"],
  idempotent: true,
  input: ReportInput,
  output: SavedReport,
});

export const updateReport = defineRoute({
  method: "patch",
  path: "/v1/reports/{id}",
  summary: "Change a saved report",
  description:
    "The whole report, as for a new one: its name, its description and its definition. Every dashboard tile showing it shows the new version, because a tile points at its report rather than keeping a copy.",
  module: "M21",
  permissions: ["report:build"],
  input: ReportInput.extend({ id: Uuid }),
  output: SavedReport,
});

export const deleteReport = defineRoute({
  method: "delete",
  path: "/v1/reports/{id}",
  summary: "Delete a saved report",
  description:
    "Gone from the list. A dashboard tile that showed it says the report was deleted, in its place, rather than disappearing.",
  module: "M21",
  permissions: ["report:build"],
  input: z.object({ id: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

/* ------------------------------------------------------------ dashboards */

const Axis = z.object({ key: z.string(), label: z.string(), type: z.string() });

export const DashboardTile = z.object({
  key: z.string(),
  title: z.string(),
  caption: z.string().optional(),
  kind: z.enum(["number", "bars", "trend"]),
  width: z.number().int(),
  /** The measure drawn. */
  measure: Axis.optional(),
  /** What it is drawn against, on anything but a number. */
  dimension: Axis.extend({ sortPrefix: z.boolean().optional() }).optional(),
  /** The second grouping each bar is cut by, and how the parts are set out. */
  breakdown: Axis.extend({
    sortPrefix: z.boolean().optional(),
    arrange: z.enum(["stacked", "grouped"]),
  }).optional(),
  /** Whether the measure adds up (a count or a sum). */
  additive: z.boolean().optional(),
  /** A second measure drawn beside the first. */
  second: Axis.optional(),
  /** The other measures this tile could draw beside the first. */
  alsoCanDraw: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
  /** Whether the tile takes the dates a schedule or an automation gives its dashboard. */
  followsDates: z.boolean().optional(),
  /** The groupings either of which can cut a tile that is broken down. */
  cuts: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
  /** What the tile drew. */
  result: ReportResult.optional(),
  /** The report it drew, so a number can be opened with `POST /v1/reports/drill`. */
  definition: ReportDefinition.optional(),
  /** Why the tile has nothing on it: its report was deleted or failed to run. */
  problem: z.string().optional(),
});

/** How a saved dashboard stores a tile: a pointer at one report, and how it is drawn. */
export const StoredDashboardTile = z.object({
  /** Names the tile on this dashboard. Unique on it. */
  key: z.string().min(1).max(100),
  kind: z.enum(["number", "bars", "trend"]),
  /** Columns out of twelve. */
  width: z.union([z.literal(3), z.literal(6), z.literal(12)]),
  /** A saved report, by id. Exactly one of this and `builtIn`. */
  reportId: Uuid.optional(),
  /** A report that ships, by slug. Exactly one of this and `reportId`. */
  builtIn: z.string().optional(),
  /** Shown in place of the report's own name, on this dashboard only. */
  title: z.string().max(200).optional(),
  caption: z.string().max(500).optional(),
  /** Cut each bar by the report's second grouping, stacked or side by side. */
  breakdown: z.enum(["stacked", "grouped"]).optional(),
  /** Which of the report's two groupings cuts it, by key. The second when left out. */
  splitBy: z.string().min(1).optional(),
  /** A second measure of the report, by key, drawn beside the first. */
  secondMeasure: z.string().min(1).optional(),
  /** Takes the dates a schedule or an automation gives the dashboard. */
  followsDates: z.boolean().optional(),
});

export const SavedDashboard = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  tiles: z.array(StoredDashboardTile),
  createdByUserId: Uuid.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const DrawnDashboard = {
  tiles: z.array(DashboardTile),
  /** The titles of tiles left out because the caller may not see them. */
  leftOut: z.array(z.string()),
};

export const listDashboards = defineRoute({
  method: "get",
  path: "/v1/dashboards",
  summary: "The dashboards that ship and the ones the company assembled",
  description:
    "The dashboards that ship (`operations`, `money`) that have at least one tile the caller may see, and every dashboard somebody in the company assembled, with its tiles as stored. Draw one with `GET /v1/dashboards/built-in/{slug}` or `GET /v1/dashboards/{id}`.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({}),
  output: z.object({
    builtIn: z.array(z.object({ slug: z.string(), title: z.string(), description: z.string() })),
    saved: z.array(SavedDashboard),
  }),
});

export const getBuiltInDashboard = defineRoute({
  method: "get",
  path: "/v1/dashboards/built-in/{slug}",
  summary: "Draw a dashboard that ships",
  description:
    "Every tile the caller may see, each run as its report would be for them, so a technician sees their own work and a branch manager their own branch. A tile the caller may not see is left out and named in `leftOut`. A dashboard with nothing on it the caller may see is not found.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({ slug: z.string() }),
  output: z.object({
    definition: z.object({ slug: z.string(), title: z.string(), description: z.string() }),
    ...DrawnDashboard,
  }),
});

export const getDashboard = defineRoute({
  method: "get",
  path: "/v1/dashboards/{id}",
  summary: "Draw a dashboard somebody assembled",
  description:
    "Its tiles in order, each run as the caller would see its report, with a tile whose report was deleted kept in its place and saying so. `stored` is the tiles as saved, which is what `PUT /v1/dashboards/{id}/tiles` takes back.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    definition: z.object({ id: Uuid, name: z.string(), description: z.string().nullable() }),
    stored: z.array(StoredDashboardTile),
    ...DrawnDashboard,
  }),
});

export const createDashboard = defineRoute({
  method: "post",
  path: "/v1/dashboards",
  summary: "Start a dashboard",
  description:
    "A name and an empty page. Add tiles with `PUT /v1/dashboards/{id}/tiles`. Names are unique in the company, and a second dashboard with a name already used is refused. A retry sent with the same `Idempotency-Key` gets the dashboard the first one made.",
  module: "M21",
  permissions: ["report:build"],
  idempotent: true,
  input: z.object({ name: z.string().min(1).max(200), description: z.string().max(2000).optional() }),
  output: SavedDashboard,
});

export const setDashboardTiles = defineRoute({
  method: "put",
  path: "/v1/dashboards/{id}/tiles",
  summary: "Set a dashboard's tiles",
  description:
    "The whole list, in the order they are drawn: adding, removing and moving a tile are each one write of every tile. Each tile points at one report, saved or shipped, and is refused if that report does not exist or cannot be drawn that way (a number from a grouped report, a tile cut by a grouping its report does not have). The same list sent twice leaves the same dashboard.",
  module: "M21",
  permissions: ["report:build"],
  /** Setting a state: the same list twice leaves the same dashboard. */
  idempotent: true,
  input: z.object({ id: Uuid, tiles: z.array(StoredDashboardTile).max(100) }),
  output: SavedDashboard,
});

export const deleteDashboard = defineRoute({
  method: "delete",
  path: "/v1/dashboards/{id}",
  summary: "Delete a dashboard",
  description: "Gone from the list. The reports its tiles showed are not touched.",
  module: "M21",
  permissions: ["report:build"],
  input: z.object({ id: Uuid }),
  output: z.object({ ok: z.literal(true) }),
});

export const reportRoutes = {
  listReports, getReportCatalogue, runReport, runSavedReport, createReport, updateReport, deleteReport,
  listDashboards, getBuiltInDashboard, getDashboard, createDashboard, setDashboardTiles, deleteDashboard,

  drillReport,
  listReportSchedules, createReportSchedule, updateReportSchedule,
  setReportSchedulePaused, sendReportScheduleNow, deleteReportSchedule, listReportDeliveries,
} as const;
