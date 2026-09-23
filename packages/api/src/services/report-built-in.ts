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
      orderBy: "total",
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
      orderBy: "balance",
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
];
