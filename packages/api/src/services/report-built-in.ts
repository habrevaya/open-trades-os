import type { reporting } from "@opentradesos/core";

/**
 * THE REPORTS THAT SHIP WITH THE PRODUCT
 *
 * A builder with an empty list is a blank page, and a blank page is where
 * most reporting features die: everybody agrees it is powerful and nobody
 * builds the first one.
 *
 * These are the questions a contractor actually asks, written as definitions
 * rather than as special cases. Each one is the same shape a person builds by
 * hand, so "edit a copy of this" is the obvious next step rather than a
 * different feature.
 *
 * They are filtered by what the reader holds, so an owner and a dispatcher
 * see different lists rather than the same list with half of it erroring.
 */
export interface BuiltInReport {
  slug: string;
  name: string;
  /** The question, in the words somebody would ask it. */
  question: string;
  definition: reporting.ReportDefinition;
}

export const BUILT_IN: BuiltInReport[] = [
  {
    slug: "revenue-by-month",
    name: "Revenue by month",
    question: "What did we invoice, month by month?",
    definition: {
      dataset: "invoices",
      dimensions: ["month"],
      measures: ["total", "count", "average"],
      /**
       * No `orderBy`, which now means chronological. It used to say "total",
       * so the months came back in order of size: the same twelve numbers
       * with the shape taken out, on the one report whose entire point is
       * the shape.
       */
    },
  },
  {
    slug: "ar-aging",
    name: "Receivables by age",
    question: "Who owes us money, and how long have they owed it?",
    definition: {
      dataset: "invoices",
      dimensions: ["aging"],
      measures: ["balance", "count"],
      /**
       * In bucket order, which is the whole reason the aging dimension
       * carries a sort prefix. Ordering by balance, as this did, defeated
       * the prefix on the one report it was written for: an owner reading
       * this wants current at the top and over ninety at the bottom, not
       * whichever bucket happens to be biggest this week.
       */
    },
  },
  {
    slug: "outstanding-by-customer",
    name: "Outstanding by customer",
    question: "Which customers are we chasing?",
    definition: {
      dataset: "invoices",
      dimensions: ["customer"],
      measures: ["balance", "count"],
      // Paid invoices would otherwise fill the top of a chasing list with
      // people who owe nothing.
      filters: [{ dimension: "status", op: "neq", value: "paid" }],
      orderBy: "balance",
      limit: 25,
    },
  },
  {
    slug: "jobs-by-status",
    name: "Jobs by status",
    question: "What is open, and what is stuck?",
    definition: {
      dataset: "jobs",
      dimensions: ["status"],
      measures: ["count"],
    },
  },
  {
    slug: "jobs-by-type",
    name: "Work by job type",
    question: "What kind of work do we actually do?",
    definition: {
      dataset: "jobs",
      dimensions: ["job_type"],
      measures: ["count"],
      limit: 25,
    },
  },
  {
    slug: "visits-by-technician",
    name: "Visits by technician",
    question: "Who did how much, and how much of it was completed?",
    definition: {
      dataset: "visits",
      dimensions: ["technician", "status"],
      measures: ["count"],
    },
  },
  {
    slug: "estimates-by-status",
    name: "Estimates by status",
    question: "What is sitting unanswered?",
    definition: {
      dataset: "estimates",
      dimensions: ["status"],
      measures: ["count", "value"],
    },
  },
  {
    slug: "queue-by-source",
    name: "Who is creating the work",
    question: "Is the automation generating work people actually do?",
    definition: {
      dataset: "tasks",
      dimensions: ["source", "status"],
      measures: ["count"],
    },
  },
  /**
   * M15. The four questions an owner asks about which work makes money, and
   * none of them is answerable from a revenue report.
   *
   * Each one is an ordinary definition over the `profitability` dataset, so
   * "edit a copy of this" is the next step rather than a different feature,
   * and each one is filtered to settled work, because a job still accruing
   * labour has a margin that is not finished being wrong. The in-progress
   * report below is the deliberate exception and says so in its question.
   */
  {
    slug: "job-costing",
    name: "Job costing",
    question: "What did each finished job cost us against what it brought in?",
    definition: {
      dataset: "profitability",
      dimensions: ["job"],
      /**
       * The fully loaded margin beside the gross one, never instead of it:
       * with no burden or overhead rates set they are the same number, and
       * once a company has set them the gap is what the rates say the work
       * really carries.
       */
      measures: [
        "revenue", "material_cost", "labour_cost", "processing_fees", "gross_margin",
        "labour_burden", "overhead", "fully_loaded_margin",
      ],
      filters: [{ dimension: "settled", op: "eq", value: "Settled" }],
      /**
       * By revenue, so the jobs that matter most are at the top with their
       * margin beside them. A ranking by margin would put a hundred small
       * service calls above the one install that lost money.
       */
      orderBy: "revenue",
      limit: 100,
    },
  },
  {
    slug: "margin-by-job-type",
    name: "Margin by job type",
    question: "Which kind of work actually makes money?",
    definition: {
      dataset: "profitability",
      dimensions: ["job_type"],
      measures: ["revenue", "material_cost", "labour_cost", "gross_margin", "fully_loaded_margin", "count"],
      filters: [{ dimension: "settled", op: "eq", value: "Settled" }],
      orderBy: "gross_margin",
      limit: 25,
    },
  },
  {
    slug: "margin-by-weekday",
    name: "Margin by day of the week",
    question: "Is there a day of the week we lose money on?",
    definition: {
      dataset: "profitability",
      dimensions: ["weekday"],
      measures: ["revenue", "gross_margin", "hours_over", "count"],
      filters: [{ dimension: "settled", op: "eq", value: "Settled" }],
      /**
       * No `orderBy`, which means the weekday's own prefix order. Sorted by
       * margin this is seven numbers with the week taken out of them, and the
       * week is the entire question.
       */
    },
  },
  {
    slug: "margin-by-technician",
    name: "Margin by technician",
    question: "Whose work earns, once their hours are costed?",
    definition: {
      dataset: "profitability",
      dimensions: ["technician"],
      measures: ["revenue", "labour_cost", "gross_margin", "hours_over", "labour_not_recorded"],
      filters: [{ dimension: "settled", op: "eq", value: "Settled" }],
      orderBy: "gross_margin",
      limit: 25,
    },
  },
  {
    slug: "jobs-running-over",
    name: "Jobs running over plan",
    question: "What is taking longer than we scheduled, while we can still act on it?",
    definition: {
      dataset: "profitability",
      dimensions: ["job"],
      /**
       * DELIBERATELY NOT filtered to settled work. This is the one report
       * whose value is entirely in the unfinished jobs: a job nine hours into
       * a four hour plan is the most actionable row this product produces,
       * and waiting for it to be invoiced tells somebody on Friday what they
       * needed on Tuesday.
       */
      measures: ["hours_over", "scheduled_hours", "actual_hours", "unbilled_cost"],
      orderBy: "hours_over",
      limit: 25,
    },
  },
];
