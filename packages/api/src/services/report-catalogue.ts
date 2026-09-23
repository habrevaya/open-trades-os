import { work, type reporting } from "@opentradesos/core";

/**
 * THE CATALOGUE
 *
 * Every fragment of SQL a report can contain, written herestimate. Nothing a caller
 * sends reaches a query: they send a key, this file supplies the expression,
 * and a key that is not in here is refused rather than passed through.
 *
 * That is the entire injection story, and it is why the builder can be
 * exposed to anybody holding `report:build` without it becoming a database
 * consolestimate.
 *
 * Measures carrying a permission are the other half. `job.cost:read` and
 * `report.financial:read` are enforced here rather than by hiding a column in
 * the UI, because a report is a file somebody emails.
 */
export const CATALOGUE: reporting.Dataset[] = [
  {
    key: "jobs",
    label: "Jobs",
    description: "Work, by whatever you want to count it by. The operational report.",
    from: "public.job",
    permission: "job:read",
    scope: "job",
    dateColumn: "job.created_at",
    dimensions: [
      { key: "status", label: "Status", sql: "job.status::text", type: "text" },
      {
        key: "priority", label: "Priority", type: "text",
        /**
         * Labelled from the scale core declares, rather than grouped by the
         * raw integer. "Jobs by priority" answering with a bucket called "0"
         * is a report that looks broken.
         */
        sql: work.prioritySql("job.priority"),
      },
      {
        key: "month", label: "Month", type: "date",
        // Truncated in the database rather than grouped in JavaScript, which
        // would mean fetching every row to count them.
        sql: "to_char(date_trunc('month', job.created_at), 'YYYY-MM')",
      },
      { key: "day", label: "Day", sql: "to_char(job.created_at, 'YYYY-MM-DD')", type: "date" },
      {
        key: "customer", label: "Customer", type: "text",
        sql: "(select c.name from public.customer c where c.id = job.customer_id)",
      },
      {
        key: "job_type", label: "Job type", type: "text",
        sql: "coalesce((select t.name from public.job_type t where t.id = job.job_type_id), 'None')",
      },
    ],
    measures: [
      { key: "count", label: "Jobs", kind: "count", type: "number" },
    ],
  },
  {
    key: "invoices",
    label: "Invoices",
    description: "Revenue and receivables. What was billed, what is outstanding.",
    from: "public.invoice",
    // The money datasets need the financial permission on top of the record
    // one, because reading one invoice and reading the company's revenue are
    // different things to be trusted with.
    permission: "report.financial:read",
    scope: "invoice",
    dateColumn: "invoice.issued_on",
    dimensions: [
      { key: "status", label: "Status", sql: "invoice.status::text", type: "text" },
      {
        key: "month", label: "Month", type: "date",
        sql: "to_char(date_trunc('month', invoice.issued_on), 'YYYY-MM')",
      },
      {
        key: "customer", label: "Customer", type: "text",
        sql: "(select c.name from public.customer c where c.id = invoice.customer_id)",
      },
      {
        key: "aging", label: "Age", type: "text", sortPrefix: true,
        /**
         * The buckets an owner actually asks for, in an order that sorts.
         * Without the numeric prefix "Over 90" lands between "1 to 30" and
         * "31 to 60" alphabetically, which makes the report look wrong to
         * the person who needs it most.
         */
        sql: `case
          when invoice.balance = 0 then '0 Paid'
          when invoice.due_on >= current_date then '1 Current'
          when invoice.due_on >= current_date - 30 then '2 1 to 30 days'
          when invoice.due_on >= current_date - 60 then '3 31 to 60 days'
          when invoice.due_on >= current_date - 90 then '4 61 to 90 days'
          else '5 Over 90 days'
        end`,
      },
    ],
    measures: [
      { key: "count", label: "Invoices", kind: "count", type: "number" },
      { key: "total", label: "Invoiced", kind: "sum", sql: "invoice.total", type: "money" },
      { key: "balance", label: "Outstanding", kind: "sum", sql: "invoice.balance", type: "money" },
      { key: "average", label: "Average invoice", kind: "avg", sql: "invoice.total", type: "money" },
    ],
  },
  {
    key: "estimates",
    label: "Estimates",
    description: "What was quoted and what closed. The sell side.",
    from: "public.estimate",
    permission: "estimate:read",
    scope: "estimate",
    dateColumn: "estimate.created_at",
    dimensions: [
      { key: "status", label: "Status", sql: "estimate.status::text", type: "text" },
      {
        key: "month", label: "Month", type: "date",
        sql: "to_char(date_trunc('month', estimate.created_at), 'YYYY-MM')",
      },
      {
        key: "customer", label: "Customer", type: "text",
        sql: "(select c.name from public.customer c where c.id = estimate.customer_id)",
      },
    ],
    measures: [
      { key: "count", label: "Estimates", kind: "count", type: "number" },
      {
        /**
         * The value of an estimate lives on its OPTIONS, not on the estimate,
         * because good better best means there is no single number until
         * somebody picks one. The selected option when there is one, the
         * recommended option when there is not, which is what a contractor
         * means when they ask what a quote was worth.
         */
        key: "value", label: "Value", kind: "sum", type: "money",
        permission: "report.financial:read",
        sql: `coalesce(
          (select o.total from public.estimate_option o where o.id = estimate.selected_option_id),
          (select o.total from public.estimate_option o
            where o.estimate_id = estimate.id and o.is_recommended
            order by o.sort_order limit 1),
          0
        )`,
      },
    ],
  },
  {
    key: "visits",
    label: "Visits",
    description: "Where the time went. Completed, cancelled, and never attended.",
    from: "public.visit",
    permission: "visit:read",
    scope: "visit",
    dateColumn: "visit.window_start",
    dimensions: [
      { key: "status", label: "Status", sql: "visit.status::text", type: "text" },
      {
        key: "month", label: "Month", type: "date",
        sql: "to_char(date_trunc('month', visit.window_start), 'YYYY-MM')",
      },
      {
        key: "technician", label: "Technician", type: "text",
        sql: `coalesce((
          select t.display_name from public.visit_assignment a
          join public.technician t on t.id = a.technician_id
          where a.visit_id = visit.id and a.is_lead
          limit 1
        ), 'Unassigned')`,
      },
    ],
    measures: [
      { key: "count", label: "Visits", kind: "count", type: "number" },
    ],
  },
  {
    key: "tasks",
    label: "Tasks",
    description: "The office queue: what is raised, by whom, and how much of it gets donestimate.",
    from: "public.task",
    permission: "task:read",
    // Tasks are not scoped by work today, so the whole queue is the report.
    // Reads of the queue itself are already gated on `task:read`.
    scope: "job",
    dateColumn: "task.created_at",
    dimensions: [
      { key: "status", label: "Status", sql: "task.status::text", type: "text" },
      { key: "priority", label: "Priority", sql: "task.priority::text", type: "text" },
      { key: "queue", label: "Queue", sql: "coalesce(task.queue, 'None')", type: "text" },
      {
        key: "source", label: "Raised by", type: "text",
        // Whether automation is generating work people actually do is the
        // question worth asking about a queuestimate.
        sql: "case when task.raised_by_run_id is null then 'A person' else 'An automation' end",
      },
      {
        key: "month", label: "Month", type: "date",
        sql: "to_char(date_trunc('month', task.created_at), 'YYYY-MM')",
      },
    ],
    measures: [
      { key: "count", label: "Tasks", kind: "count", type: "number" },
    ],
  },
];
