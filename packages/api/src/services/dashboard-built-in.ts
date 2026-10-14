import type { dashboard } from "@opentradesos/core";

/**
 * THE DASHBOARDS THAT SHIP WITH THE PRODUCT
 *
 * Same argument as the built-in reports: a builder opening on a blank page is
 * where most of these features die, because everybody agrees it is powerful
 * and nobody builds the first one.
 *
 * Two, and deliberately not eight. They are the two screens a contractor
 * opens for two different reasons, and a list of eight is a menu somebody
 * scrolls past on the way to the one they always use.
 *
 *   The morning one is about today and has no money on it at all, so a
 *   dispatcher sees the whole thing rather than a screen with holes.
 *
 *   The money one is about the month and is mostly invisible without
 *   `report.financial:read`, which is correct: reading one invoice and
 *   reading the company's revenue are different things to be trusted with.
 *
 * Every tile is a report definition. Not a widget with its own query: the
 * same shape somebody builds by hand, resolved by the same function, so a
 * tile and the report behind it cannot drift into disagreeing about what
 * revenue means.
 */
export interface BuiltInDashboard extends dashboard.DashboardDefinition {
  /** What it is called in a URL. */
  slug: string;
}

/** A job not yet finished or called off: the job statuses before `completed`, and on hold. */
const OPEN_JOB_STATUSES = ["lead", "estimating", "scheduled", "in_progress", "on_hold"];

export const BUILT_IN_DASHBOARDS: BuiltInDashboard[] = [
  {
    slug: "operations",
    key: "operations",
    title: "Operations",
    description: "What the shop is doing right now. No money on it, so everybody can see all of it.",
    tiles: [
      {
        key: "open-jobs",
        title: "Open jobs",
        caption: "Everything not finished or cancelled.",
        kind: "number",
        width: 3,
        definition: {
          dataset: "jobs",
          dimensions: [],
          measures: ["count"],
          /**
           * Every status short of finished or called off. This said `draft`,
           * which no job has ever been, and left out leads, estimates and jobs
           * on hold, so the number was smaller than its own caption.
           */
          filters: [{ dimension: "status", op: "in", value: OPEN_JOB_STATUSES }],
        },
      },
      {
        key: "open-tasks",
        title: "Open tasks",
        caption: "The office queue, whoever raised it.",
        kind: "number",
        width: 3,
        definition: {
          dataset: "tasks",
          dimensions: [],
          measures: ["count"],
          filters: [{ dimension: "status", op: "neq", value: "done" }],
        },
      },
      {
        key: "visits-by-technician",
        title: "Visits by technician",
        caption: "Who is carrying the day.",
        kind: "bars",
        width: 6,
        definition: {
          dataset: "visits",
          dimensions: ["technician"],
          measures: ["count"],
          orderBy: "count",
          limit: 8,
        },
      },
      {
        key: "jobs-by-status",
        title: "Jobs by status",
        kind: "bars",
        width: 6,
        definition: {
          dataset: "jobs", dimensions: ["status"], measures: ["count"], orderBy: "count",
        },
      },
      {
        key: "open-jobs-by-type",
        title: "Open jobs by type",
        caption: "Each kind of work, cut by where it stands.",
        kind: "bars",
        width: 6,
        /**
         * Broken down by the report's second grouping: one bar for each kind of
         * work, stacked by status, so a pile of installs waiting to be
         * scheduled shows as a bar mostly one colour. A count adds up, so the
         * parts stack to the bar.
         */
        breakdown: "stacked",
        definition: {
          dataset: "jobs",
          dimensions: ["job_type", "status"],
          measures: ["count"],
          filters: [{ dimension: "status", op: "in", value: OPEN_JOB_STATUSES }],
          orderBy: "count",
        },
      },
      {
        key: "tasks-by-source",
        title: "Task queue, by who raised it",
        caption: "Whether the automations are making work people actually do.",
        kind: "bars",
        width: 6,
        definition: {
          dataset: "tasks", dimensions: ["source"], measures: ["count"], orderBy: "count",
        },
      },
    ],
  },
  {
    slug: "money",
    key: "money",
    title: "Money",
    description: "What was billed, what is owed, and who owes it.",
    tiles: [
      {
        key: "outstanding",
        title: "Outstanding",
        caption: "Every unpaid balance on the book.",
        kind: "number",
        width: 3,
        definition: {
          dataset: "invoices",
          dimensions: [],
          measures: ["balance"],
          filters: [{ dimension: "status", op: "neq", value: "paid" }],
        },
      },
      {
        key: "invoiced",
        title: "Invoiced",
        caption: "Everything issued, whether or not it is paid.",
        kind: "number",
        width: 3,
        definition: { dataset: "invoices", dimensions: [], measures: ["total"] },
      },
      {
        key: "average-invoice",
        title: "Average invoice",
        kind: "number",
        width: 3,
        definition: { dataset: "invoices", dimensions: [], measures: ["average"] },
      },
      {
        key: "revenue-by-month",
        title: "Invoiced by month",
        kind: "trend",
        width: 12,
        definition: {
          dataset: "invoices",
          dimensions: ["month"],
          measures: ["total"],
          /**
           * No `orderBy`, which is what makes it chronological: a report
           * grouped by a single date orders by that date unless it is told
           * otherwise. Saying "total" here, as this did, keeps the eighteen
           * BIGGEST months rather than the last eighteen, on a tile whose
           * only job is the shape.
           */
          limit: 18,
        },
      },
      {
        key: "aging",
        title: "Receivables by age",
        caption: "In bucket order. The bottom row is the one that costs money.",
        kind: "bars",
        width: 6,
        definition: {
          // No `orderBy`, so it reads in bucket order rather than by size.
          dataset: "invoices", dimensions: ["aging"], measures: ["balance"],
        },
      },
      {
        key: "who-owes",
        title: "Who owes us",
        kind: "bars",
        width: 6,
        definition: {
          dataset: "invoices",
          dimensions: ["customer"],
          measures: ["balance"],
          // Paid invoices would otherwise fill a chasing list with people
          // who owe nothing.
          filters: [{ dimension: "status", op: "neq", value: "paid" }],
          orderBy: "balance",
          limit: 8,
        },
      },
    ],
  },
];
