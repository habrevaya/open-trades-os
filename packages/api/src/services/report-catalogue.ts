import { work, type reporting } from "@opentradesos/core";

/**
 * JOB COSTING, AS SQL FRAGMENTS, WRITTEN ONCE
 *
 * Every number M15 produces is here, and both surfaces that produce one read
 * it from this object: the `profitability` dataset below, which rolls jobs up
 * through the ordinary report builder, and `services/profitability.ts`, which
 * states one job and shows the rows each number came from.
 *
 * They share these strings rather than each writing their own because the
 * failure otherwise is not a crash. It is a per-job margin and a rolled-up
 * margin that disagree by a few dollars, which an owner finds in a meeting
 * and never trusts either number again.
 *
 * Every fragment is correlated against `job`, which is both the table and its
 * own alias, exactly as `Dataset.from` requires. A statement for one job is
 * therefore the same expressions with `where job.id = $1` around them.
 *
 * RULE 4 IN packages/db/src/schema/billing.ts: every financial report reads
 * from the ledger. Revenue and processing fees below do, and they are the two
 * numbers that have a ledger posting behind them. Read instead from
 * `invoice.total`, which is the obvious shortcut, and three things break: a
 * voided invoice still counts as revenue, because the void is a reversing
 * posting and never touches the row; sales tax is counted as income, because
 * the total includes it and the ledger splits it out to a liability; and a
 * discount disappears, because the total is already net of it while the
 * ledger carries it as contra revenue somebody can see.
 *
 * Cost is the other half and it has NO ledger posting in this product.
 * `ACCOUNTS.COGS` is declared in packages/core/src/ledger and nothing debits
 * it: no code path anywhere writes a cost entry. So material cost reads from
 * `job_line.unit_cost` and labour cost from `timeclock_entry`, which are the
 * records of consumption this product actually keeps, and the statement says
 * so rather than implying a trial balance behind it. When something posts
 * COGS, these two fragments are where the reads move.
 */
export const JOB_COSTING_SQL = {
  /**
   * REVENUE RECOGNISED ON THE JOB, net of discount and excluding tax.
   *
   * Credits positive, debits negative, over the revenue accounts and the
   * contra revenue account together. That one sign convention does all four
   * things that are easy to get wrong: revenue counts, a void subtracts
   * because it debits the same account, a discount subtracts because it is a
   * debit to 4900, and tax never appears at all because it is credited to a
   * liability.
   *
   * `postInvoice`, `postVoid` and `postAgreementRecognition` all carry the
   * job on the entry, which is what makes this a filter rather than a join
   * through the invoice.
   */
  revenue: `(
    select coalesce(sum(case when le.direction = 'credit' then le.amount else -le.amount end), 0)
    from public.ledger_entry le
    where le.job_id = job.id
      and le.account_code in ('4000', '4100', '4900')
  )`,

  /**
   * What was consumed on the job, at cost.
   *
   * Lines of kind `labor` are EXCLUDED, deliberately. A labour line's cost
   * and the timeclock entry for the same hour are the same money recorded
   * twice, and adding both is the most flattering arithmetic error available
   * here: it doubles the cost and turns profitable work into a loss.
   *
   * A line with a null `unit_cost` contributes nothing and is counted by
   * `uncostedLines` below, so "we do not know" is visible rather than
   * arriving as zero.
   */
  materialCost: `(
    select coalesce(sum(jl.quantity * jl.unit_cost), 0)
    from public.job_line jl
    where jl.job_id = job.id and jl.kind <> 'labor' and jl.unit_cost is not null
  )`,

  /**
   * LABOUR AT THE RATE THAT WAS ACTUALLY APPLIED.
   *
   * Hours from the timeclock multiplied by `applied_loaded_rate`, which
   * `services/labor.ts` freezes onto the entry when the punch closes, from
   * the wage scale in effect on the day the work happened. Base plus fringe,
   * which is as much burden as this product honestly knows: it has never
   * asked the operator for a burden multiplier, and inventing one would put a
   * number into every margin that nobody chose.
   *
   * Not the price of a labour line, which is what the customer was charged
   * and tells you nothing about what the hour cost. Not a rate looked up now,
   * which would reprice last quarter the moment somebody loads a new union
   * scale.
   *
   * THE OVERTIME PREMIUM IS NOT HERE, and that is a decision rather than an
   * omission. Overtime is a property of a PERSON'S WEEK, not of a job: the
   * forty first hour is expensive because of the forty that came before it,
   * and those forty were worked on other jobs. Attributing the premium would
   * mean choosing which job caused it, and every rule for that (the last job
   * of the week, the longest job, pro rata) is an allocation this product
   * cannot defend. So a job carries its hours at straight loaded rate, and
   * the premium stays on the timesheet in `services/labor.ts`, which is the
   * one place that knows the week. An owner reading a margin here is reading
   * one that excludes the overtime premium, and the statement says so.
   *
   * `unpaid_break` is excluded because it is not paid, which is the single
   * thing that kind exists to say.
   */
  labourCost: `(
    select coalesce(sum(
      (tc.minutes::numeric / 60) * coalesce(tc.applied_loaded_rate, tc.applied_base_rate)
    ), 0)
    from public.timeclock_entry tc
    where tc.job_id = job.id
      and tc.ended_at is not null
      and tc.kind <> 'unpaid_break'
      and coalesce(tc.applied_loaded_rate, tc.applied_base_rate) is not null
  )`,

  /**
   * THE CARD FEE, WHICH IS A REAL COST OF THE JOB AND IS NEVER ON IT.
   *
   * `postPayment` debits 6100 and tags the entry with the customer and not
   * the job, because a payment can span invoices and therefore span jobs.
   * There is no job on the row to filter by, so this walks the allocations:
   * the fee is split across the invoices that payment cleared, in proportion
   * to what was applied to each.
   *
   * That proportion is the only basis this data supports and it is still an
   * allocation, so it is stated rather than hidden. A tip or a surcharge in
   * the same payment is not an invoice and takes no share, which means a
   * tipped card payment attributes slightly more of the fee to the work than
   * the processor charged for the work alone. Three percent of a tip is cents
   * and the alternative is leaving part of a real expense attributed to
   * nothing.
   *
   * `postDeposit` DOES carry the job on its fee entry, so a deposit's fee is
   * added directly below rather than allocated. The two cannot double count:
   * a payment's fee row has a null `job_id`.
   */
  processingFees: `(
    (
      select coalesce(sum(case when le.direction = 'debit' then le.amount else -le.amount end), 0)
      from public.ledger_entry le
      where le.job_id = job.id and le.account_code = '6100'
    ) + (
      select coalesce(sum(
        (pa.amount / nullif((
          select sum(x.amount) from public.payment_allocation x where x.payment_id = pa.payment_id
        ), 0))
        * (
          select coalesce(sum(case when le.direction = 'debit' then le.amount else -le.amount end), 0)
          from public.ledger_entry le
          where le.source_type = 'payment' and le.source_id = pa.payment_id
            and le.account_code = '6100'
        )
      ), 0)
      from public.payment_allocation pa
      join public.invoice i on i.id = pa.invoice_id
      where i.job_id = job.id
    )
  )`,

  /**
   * Hours the job was SCHEDULED to take, which is the only quoted duration
   * this schema records.
   *
   * `visit.estimated_duration_minutes` is what dispatch committed to and what
   * the capacity model planned against. There is no hours field on an
   * estimate: an estimate line carries a quantity and a price and nothing
   * says the quantity is hours, so reading one as hours would be a guess
   * presented as a measurement.
   *
   * Cancelled visits are excluded. A visit nobody attended was not time the
   * job was expected to take; leaving it in makes every rescheduled job look
   * like it came in under plan.
   */
  scheduledHours: `(
    select coalesce(sum(v.estimated_duration_minutes), 0)::numeric / 60
    from public.visit v
    where v.job_id = job.id and v.status <> 'cancelled'
  )`,

  /** Hours actually recorded against the job, paid kinds only. */
  actualHours: `(
    select coalesce(sum(tc.minutes), 0)::numeric / 60
    from public.timeclock_entry tc
    where tc.job_id = job.id and tc.ended_at is not null and tc.kind <> 'unpaid_break'
  )`,

  /**
   * Hours recorded on the job that nothing could price.
   *
   * A closed entry with no frozen rate costs nothing in `labourCost` above,
   * which understates the job by an unknown amount. Reporting the hours is
   * what turns that from a silently flattering margin into a number somebody
   * can go and fix, by setting a wage scale and re-punching.
   */
  unpricedLabourHours: `(
    select coalesce(sum(tc.minutes), 0)::numeric / 60
    from public.timeclock_entry tc
    where tc.job_id = job.id and tc.ended_at is not null and tc.kind <> 'unpaid_break'
      and coalesce(tc.applied_loaded_rate, tc.applied_base_rate) is null
  )`,

  /** Punches still running. Cost on this job is still going up. */
  openTimeEntries: `(
    select count(*) from public.timeclock_entry tc
    where tc.job_id = job.id and tc.ended_at is null
  )`,

  /**
   * Consumed, not billed, and not deliberately unbillable.
   *
   * `job_line.invoice_line_id` null means unbilled and `non_billable_reason`
   * is what says that was on purpose. A line that is neither is work nobody
   * has decided about, so revenue on this job may still be coming and the
   * margin is not final.
   */
  unbilledCost: `(
    select coalesce(sum(jl.quantity * jl.unit_cost), 0)
    from public.job_line jl
    where jl.job_id = job.id and jl.invoice_line_id is null
      and jl.non_billable_reason is null and jl.unit_cost is not null
  )`,

  /** Lines consumed with no cost recorded. The cost is unknown, not zero. */
  uncostedLines: `(
    select count(*) from public.job_line jl
    where jl.job_id = job.id and jl.kind <> 'labor' and jl.unit_cost is null
  )`,

  /**
   * Jobs with revenue and no hours at all.
   *
   * The quietest way for this report to lie. A job nobody clocked time
   * against has a labour cost of zero, and zero is a plausible number, so it
   * reads as the most profitable work in the company. Counting those jobs is
   * what stops a league table being topped by the work nobody recorded.
   */
  labourNotRecorded: `(case when not exists (
    select 1 from public.timeclock_entry tc
    where tc.job_id = job.id and tc.ended_at is not null and tc.kind <> 'unpaid_break'
  ) then 1 else 0 end)`,
} as const;

/**
 * Gross margin: revenue less the three costs this product can trace.
 *
 * GROSS, and named gross everywhere it appears, because NO OVERHEAD IS
 * ALLOCATED. Not the truck, not the dispatcher, not the building, not the
 * software. This product has no overhead pool and no activity driver to
 * spread one with, and the usual stand-ins (a percentage of revenue, a rate
 * per billable hour) are both circular: allocate by revenue and every job
 * keeps the same margin percentage it already had, allocate by hours and the
 * job that ran long is punished twice for the same overrun.
 *
 * A margin that quietly included a rate nobody chose would be worse than this
 * one, because it would look like a net margin and be an opinion. So the
 * number excludes overhead, says it excludes overhead, and an owner comparing
 * jobs is comparing like with like.
 */
export const GROSS_MARGIN_SQL =
  `(${JOB_COSTING_SQL.revenue} - ${JOB_COSTING_SQL.materialCost}`
  + ` - ${JOB_COSTING_SQL.labourCost} - ${JOB_COSTING_SQL.processingFees})`;

/**
 * WHETHER THIS JOB'S MARGIN IS FINISHED BEING WRONG.
 *
 * Work in progress is the question that decides whether this report is honest
 * at all, and the answer here is: show it, and label it.
 *
 * Excluding unfinished jobs is the tempting option and it hides the jobs an
 * owner can still do something about. The one quoted at four hours that is
 * nine hours in is the single most actionable row this product can produce,
 * and a report that waits for it to be invoiced tells them on Friday what
 * they needed on Tuesday.
 *
 * Including it silently is worse. A job with all its revenue posted and half
 * its labour still unpunched has a margin that is simply too high, and it
 * will sit at the top of a "most profitable work" list on the strength of
 * being unfinished.
 *
 * So settlement is a DIMENSION, derived from evidence rather than from
 * `job.status`, which a person can set by hand. A job is settled when three
 * things are true: nothing is still clocked in, every closed punch has a rate
 * on it, and every line consumed has either been billed or been given a
 * reason it will not be. Status is deliberately not one of the tests, because
 * warranty work is completed and never invoiced and would otherwise read as
 * permanently in progress.
 */
export const SETTLEMENT_SQL = `(case when
  not exists (
    select 1 from public.timeclock_entry tc where tc.job_id = job.id and tc.ended_at is null
  )
  and not exists (
    select 1 from public.timeclock_entry tc
    where tc.job_id = job.id and tc.ended_at is not null and tc.kind <> 'unpaid_break'
      and coalesce(tc.applied_loaded_rate, tc.applied_base_rate) is null
  )
  and not exists (
    select 1 from public.job_line jl
    where jl.job_id = job.id and jl.invoice_line_id is null and jl.non_billable_reason is null
  )
  then 'Settled' else 'In progress' end)`;

/**
 * A DATE ON A DRILLED RECORD, IN THE COMPANY'S CALENDAR.
 *
 * A timestamp rendered as a date in the database session's zone is the
 * evening of the day before for a company west of Greenwich, and a list of
 * jobs "created on the 30th" that opens from a report about the 1st reads as
 * the drill being wrong. The company's own timezone, with the same fallback
 * the session resolver uses.
 */
const localDate = (table: string, instant: string) =>
  `to_char(${instant} at time zone coalesce((select o.timezone from public.organization o `
  + `where o.id = ${table}.organization_id), 'America/Chicago'), 'YYYY-MM-DD')`;

/** The customer on a record, named and linked, because that is the next thing somebody opens. */
const customerColumn = (table: string, column = "customer_id"): reporting.RecordColumn => ({
  key: "customer", label: "Customer", type: "text",
  sql: `(select c.name from public.customer c where c.id = ${table}.${column})`,
  link: { id: `${table}.${column}`, href: "/customers/{id}" },
});

/**
 * PROFITABILITY, AS A DATASET RATHER THAN A SECOND REPORTING ENGINE.
 *
 * It is a row per job, so every question an owner asks about which work makes
 * money is a group by: job type, technician, customer, business unit, month,
 * day of the week. The builder already knows how to scope a job read, drop
 * soft deleted rows, bound a date range, refuse a field somebody may not see
 * and stop at a thousand rows, and none of that is worth writing twice.
 *
 * The permission is `report.financial:read`, like the other money datasets,
 * because reading one job's cost and reading the company's margin by
 * technician are different things to be trusted with. Every COST measure
 * additionally carries `job.cost:read`, so a dispatcher cannot reach a margin
 * by building their own report, and so the refusal names the permission
 * rather than returning a column of blanks that teaches the reader the cost
 * was nothing.
 *
 * The date is the WORK's date, not the invoice's. This dataset answers "which
 * work made money", so a job belongs to the month it was finished in, and the
 * month it was created in while it is still running. Revenue by calendar
 * month, which is a different and equally real question, is what the
 * `invoices` dataset answers from `issued_on`.
 */
export const PROFITABILITY_DATASET: reporting.Dataset = {
  key: "profitability",
  label: "Job profitability",
  description: "Which work makes money. Revenue from the ledger, cost from the lines and the timeclock.",
  from: "public.job",
  permission: "report.financial:read",
  scope: "job",
  dateColumn: "coalesce(job.completed_at, job.created_at)",
  /**
   * A job, and the statement for it is on the job's own screen. The money
   * columns on the drilled list are the measures themselves, one job at a
   * time, which is what makes a margin by technician something an owner can
   * argue with: the jobs, and what each one added to the number.
   */
  records: {
    noun: "job", plural: "jobs",
    id: "job.id",
    label: "concat('#', job.number, ' ', job.summary)",
    href: "/jobs/{id}",
    orderBy: "coalesce(job.completed_at, job.created_at)",
    columns: [
      customerColumn("job"),
      { key: "status", label: "Status", type: "status", sql: "job.status::text" },
      { key: "settled", label: "Settled", type: "text", sql: SETTLEMENT_SQL },
      {
        key: "worked_on", label: "Finished, or started", type: "date",
        sql: localDate("job", "coalesce(job.completed_at, job.created_at)"),
      },
    ],
  },
  dimensions: [
    {
      key: "job", label: "Job", type: "text",
      sql: "concat('#', job.number, ' ', job.summary)",
    },
    {
      key: "month", label: "Month", type: "date",
      sql: "to_char(date_trunc('month', coalesce(job.completed_at, job.created_at)), 'YYYY-MM')",
    },
    {
      key: "day", label: "Day", type: "date",
      sql: "to_char(coalesce(job.completed_at, job.created_at), 'YYYY-MM-DD')",
    },
    {
      key: "weekday", label: "Day of week", type: "text", sortPrefix: true,
      /**
       * The dimension the brief for this module is written around: drain
       * cleaning that loses money on Saturdays. Prefixed with the ISO day
       * number for the same reason the aging buckets are, because
       * alphabetically Friday opens the week.
       */
      sql: "to_char(coalesce(job.completed_at, job.created_at), 'ID Dy')",
    },
    {
      key: "job_type", label: "Job type", type: "text",
      sql: "coalesce((select t.name from public.job_type t where t.id = job.job_type_id), 'None')",
    },
    {
      key: "customer", label: "Customer", type: "text",
      sql: "(select c.name from public.customer c where c.id = job.customer_id)",
    },
    {
      key: "business_unit", label: "Business unit", type: "text",
      sql: "coalesce((select b.name from public.business_unit b where b.id = job.business_unit_id), 'None')",
    },
    {
      key: "technician", label: "Technician (most hours)", type: "text",
      /**
       * Whoever spent the most recorded time on the job, falling back to the
       * lead on its first visit when the timeclock was not used.
       *
       * Hours rather than the assignment, because labour is the cost this
       * dimension exists to explain and the person who worked it is the
       * person it belongs to. The fallback keeps a company that dispatches
       * but does not punch from seeing one row called Unassigned.
       *
       * A job worked by three people lands entirely on one of them, and that
       * is a limitation rather than a rounding. Splitting a margin across a
       * crew needs a basis for splitting the REVENUE too, and hours is not
       * one: the revenue was earned by the work, not by the clock.
       */
      sql: `coalesce(
        (select t.display_name from public.timeclock_entry tc
          join public.technician t on t.id = tc.technician_id
          where tc.job_id = job.id and tc.ended_at is not null
          group by t.display_name
          order by sum(tc.minutes) desc nulls last, t.display_name
          limit 1),
        (select t.display_name from public.visit v
          join public.visit_assignment a on a.visit_id = v.id
          join public.technician t on t.id = a.technician_id
          where v.job_id = job.id and a.is_lead
          order by v.sequence
          limit 1),
        'Unassigned'
      )`,
    },
    { key: "status", label: "Status", sql: "job.status::text", type: "status" },
    {
      key: "settled", label: "Settled", type: "text",
      sql: SETTLEMENT_SQL,
    },
    {
      key: "warranty", label: "Warranty", type: "text",
      // Rework we are paying for ourselves is the work whose margin is most
      // worth looking at, and `is_warranty` is the only flag that finds it.
      sql: "case when job.is_warranty then 'Warranty' else 'Chargeable' end",
    },
  ],
  measures: [
    { key: "count", label: "Jobs", kind: "count", type: "number" },
    {
      key: "revenue", label: "Revenue", kind: "sum", type: "money",
      sql: JOB_COSTING_SQL.revenue,
    },
    {
      key: "material_cost", label: "Material cost", kind: "sum", type: "money",
      permission: "job.cost:read", sql: JOB_COSTING_SQL.materialCost,
    },
    {
      key: "labour_cost", label: "Labour cost", kind: "sum", type: "money",
      permission: "job.cost:read", sql: JOB_COSTING_SQL.labourCost,
    },
    {
      key: "processing_fees", label: "Processing fees", kind: "sum", type: "money",
      permission: "job.cost:read", sql: JOB_COSTING_SQL.processingFees,
    },
    {
      key: "gross_margin", label: "Gross margin (no overhead)", kind: "sum", type: "money",
      permission: "job.cost:read", sql: GROSS_MARGIN_SQL,
    },
    {
      key: "unbilled_cost", label: "Unbilled cost", kind: "sum", type: "money",
      permission: "job.cost:read", sql: JOB_COSTING_SQL.unbilledCost,
    },
    {
      key: "scheduled_hours", label: "Scheduled hours", kind: "sum", type: "number",
      sql: JOB_COSTING_SQL.scheduledHours,
    },
    {
      key: "actual_hours", label: "Actual hours", kind: "sum", type: "number",
      sql: JOB_COSTING_SQL.actualHours,
    },
    {
      key: "hours_over", label: "Hours over plan", kind: "sum", type: "number",
      /**
       * Where the money goes. A price list that is right at four hours
       * produces an unprofitable company at seven, and nothing else on this
       * dataset shows that while the job is still open.
       */
      sql: `(${JOB_COSTING_SQL.actualHours} - ${JOB_COSTING_SQL.scheduledHours})`,
    },
    {
      key: "unpriced_labour_hours", label: "Hours with no rate", kind: "sum", type: "number",
      permission: "job.cost:read", sql: JOB_COSTING_SQL.unpricedLabourHours,
    },
    {
      key: "labour_not_recorded", label: "Jobs with no hours recorded", kind: "sum", type: "number",
      permission: "job.cost:read", sql: JOB_COSTING_SQL.labourNotRecorded,
    },
  ],
};

/**
 * WHERE THE WORK CAME FROM, as dimensions on any dataset with a job behind it.
 *
 * Read from the job's own columns, which `marketing.creditWork` writes when
 * the job is created from the company's chosen attribution model, or which a
 * person set by hand. These are the job's ONE answer; the funnel report at
 * `/marketing` weighs every touch under a model the reader picks, and the two
 * agree whenever the model is the company's own.
 *
 * Written as functions of the job's alias, so the invoices dataset can reach
 * them through `invoice.job_id` without a second copy of the SQL.
 */
const sourceDimensions = (jobId: string, prefix = ""): reporting.Dimension[] => [
  {
    key: `${prefix}channel`, label: "Channel", type: "text",
    sql: `coalesce((select ch.name from public.job j join public.marketing_channel ch on ch.id = j.channel_id
      where j.id = ${jobId}), 'Not attributed')`,
  },
  {
    key: `${prefix}tracking_campaign`, label: "Tracking campaign", type: "text",
    sql: `coalesce((select k.name from public.job j join public.acquisition_campaign k on k.id = j.acquisition_campaign_id
      where j.id = ${jobId}), 'No campaign')`,
  },
  {
    key: `${prefix}lead_source`, label: "Lead source", type: "text",
    /**
     * The catalogue key as its label would read, done in SQL so the group is
     * one row per source. A value nothing in the catalogue knows (a migration
     * keeps what its old system said) is shown as written rather than hidden.
     */
    sql: `coalesce((select initcap(replace(j.lead_source, '_', ' ')) from public.job j where j.id = ${jobId}), 'Not recorded')`,
  },
];

/**
 * THE CALLS, as a dataset, so "calls by campaign by week" is a report a
 * company can build rather than one it has to ask for.
 *
 * Inbound only. An outbound call is the company ringing out and has no
 * campaign. The channel and campaign are the ones the number belonged to AT
 * THE TIME, which the call row keeps for exactly this.
 */
export const CALLS_DATASET: reporting.Dataset = {
  key: "calls",
  label: "Calls",
  description: "Inbound calls by tracking number, campaign and channel, answered or missed, first time or not.",
  from: "public.call",
  permission: "adspend:read",
  scope: "job",
  dateColumn: "coalesce(call.started_at, call.created_at)",
  /**
   * One call, opened on the call log's own page, which is where the recording
   * policy, the disposition and "create customer and job from this call" live.
   */
  records: {
    noun: "call", plural: "calls",
    id: "call.id",
    label: "coalesce(call.from_e164, 'Unknown caller')",
    href: "/marketing/calls/{id}",
    orderBy: "coalesce(call.started_at, call.created_at)",
    columns: [
      customerColumn("call"),
      { key: "status", label: "Status", type: "status", sql: "call.status::text" },
      { key: "day", label: "Day", type: "date", sql: localDate("call", "coalesce(call.started_at, call.created_at)") },
    ],
  },
  dimensions: [
    {
      key: "day", label: "Day", type: "date",
      sql: "to_char(coalesce(call.started_at, call.created_at), 'YYYY-MM-DD')",
    },
    {
      key: "month", label: "Month", type: "date",
      sql: "to_char(date_trunc('month', coalesce(call.started_at, call.created_at)), 'YYYY-MM')",
    },
    {
      key: "channel", label: "Channel", type: "text",
      sql: "coalesce((select ch.name from public.marketing_channel ch where ch.id = call.channel_id), 'Not attributed')",
    },
    {
      key: "tracking_campaign", label: "Tracking campaign", type: "text",
      sql: "coalesce((select k.name from public.acquisition_campaign k where k.id = call.acquisition_campaign_id), 'No campaign')",
    },
    {
      key: "number", label: "Number dialled", type: "text",
      sql: "coalesce(call.received_on_e164, call.to_e164)",
    },
    { key: "status", label: "Status", sql: "call.status::text", type: "status" },
    {
      key: "first_time", label: "Caller", type: "text",
      sql: "case when call.first_time_caller then 'First time' when call.first_time_caller = false then 'Called before' else 'Not known' end",
    },
  ],
  measures: [
    { key: "count", label: "Calls", kind: "count", type: "number" },
    {
      key: "answered", label: "Answered", kind: "sum", type: "number",
      sql: "case when call.status = 'completed' then 1 else 0 end",
    },
    {
      key: "first_time", label: "First time callers", kind: "sum", type: "number",
      sql: "case when call.first_time_caller then 1 else 0 end",
    },
    {
      key: "booked", label: "Turned into a job", kind: "sum", type: "number",
      sql: "case when call.job_id is not null then 1 else 0 end",
    },
  ],
};

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
    records: {
      noun: "job", plural: "jobs",
      id: "job.id",
      label: "concat('#', job.number, ' ', job.summary)",
      href: "/jobs/{id}",
      orderBy: "job.created_at",
      columns: [
        customerColumn("job"),
        { key: "status", label: "Status", type: "status", sql: "job.status::text" },
        { key: "created", label: "Booked", type: "date", sql: localDate("job", "job.created_at") },
      ],
    },
    dimensions: [
      { key: "status", label: "Status", sql: "job.status::text", type: "status" },
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
      ...sourceDimensions("job.id"),
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
    /**
     * The invoices behind a receivables number. The payer is not a separate
     * column: the customer an invoice is grouped under is the one the report's
     * customer dimension reads, and the drill has to say the same thing the
     * row it opened from said.
     */
    records: {
      noun: "invoice", plural: "invoices",
      id: "invoice.id",
      label: "concat('Invoice ', invoice.number)",
      href: "/invoices/{id}",
      orderBy: "invoice.issued_on",
      columns: [
        customerColumn("invoice"),
        { key: "status", label: "Status", type: "status", sql: "invoice.status::text" },
        { key: "issued", label: "Issued", type: "date", sql: "invoice.issued_on::text" },
        { key: "due", label: "Due", type: "date", sql: "invoice.due_on::text" },
      ],
    },
    dimensions: [
      { key: "status", label: "Status", sql: "invoice.status::text", type: "status" },
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
      ...sourceDimensions("invoice.job_id"),
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
    records: {
      noun: "estimate", plural: "estimates",
      id: "estimate.id",
      label: "concat('Estimate ', estimate.number, coalesce(' ' || estimate.title, ''))",
      href: "/estimates/{id}",
      orderBy: "estimate.created_at",
      columns: [
        customerColumn("estimate"),
        { key: "status", label: "Status", type: "status", sql: "estimate.status::text" },
        { key: "created", label: "Written", type: "date", sql: localDate("estimate", "estimate.created_at") },
      ],
    },
    dimensions: [
      { key: "status", label: "Status", sql: "estimate.status::text", type: "status" },
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
    /**
     * A visit has no screen of its own: it is a line on its job, so the link
     * opens the job. The label still names the visit, because two visits on one
     * job are two rows here and they have to be told apart.
     */
    records: {
      noun: "visit", plural: "visits",
      id: "visit.id",
      linkId: "visit.job_id",
      label: `concat('#', (select j.number from public.job j where j.id = visit.job_id), ' visit ', visit.sequence)`,
      href: "/jobs/{id}",
      orderBy: "visit.window_start",
      columns: [
        { key: "status", label: "Status", type: "status", sql: "visit.status::text" },
        { key: "window", label: "Day", type: "date", sql: localDate("visit", "visit.window_start") },
        {
          key: "technician", label: "Lead", type: "text",
          sql: `coalesce((
            select t.display_name from public.visit_assignment a
            join public.technician t on t.id = a.technician_id
            where a.visit_id = visit.id and a.is_lead
            limit 1
          ), 'Unassigned')`,
        },
      ],
    },
    dimensions: [
      { key: "status", label: "Status", sql: "visit.status::text", type: "status" },
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
    description: "The office queue: what is raised, by whom, and how much of it gets done.",
    from: "public.task",
    permission: "task:read",
    // Tasks are not scoped by work today, so the whole queue is the report.
    // Reads of the queue itself are already gated on `task:read`.
    scope: "job",
    dateColumn: "task.created_at",
    /**
     * A task has no screen of its own either, and the queue is where one is
     * worked, so every task opens the queue. Said here rather than pretended:
     * the link is to the list, not to the task.
     */
    records: {
      noun: "task", plural: "tasks",
      id: "task.id",
      label: "task.title",
      href: "/tasks",
      orderBy: "task.created_at",
      columns: [
        { key: "status", label: "Status", type: "status", sql: "task.status::text" },
        { key: "priority", label: "Priority", type: "status", sql: "task.priority::text" },
        { key: "queue", label: "Queue", type: "text", sql: "coalesce(task.queue, 'None')" },
        { key: "created", label: "Raised", type: "date", sql: localDate("task", "task.created_at") },
      ],
    },
    dimensions: [
      { key: "status", label: "Status", sql: "task.status::text", type: "status" },
      { key: "priority", label: "Priority", sql: "task.priority::text", type: "status" },
      { key: "queue", label: "Queue", sql: "coalesce(task.queue, 'None')", type: "text" },
      {
        key: "source", label: "Raised by", type: "text",
        // Whether automation is generating work people actually do is the
        // question worth asking about a queue.
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
  PROFITABILITY_DATASET,
  CALLS_DATASET,
];
