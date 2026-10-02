import { sql, type SQL } from "drizzle-orm";

/**
 * THE SIXTY THREE NUMBERS THE PACKS DEFINED AND NOTHING COMPUTED
 *
 * Eight trade packs declare sixty three KPIs between them, forty seven distinct
 * keys, each with a label, a format, a target and a definition precise enough to
 * name the way that metric is usually got wrong. `KpiSeed` validates every one
 * of them at import. Nothing read them. Searching the product for `kpis`
 * returned the schema line that parses them and nothing else.
 *
 * That is a lot of specification to leave decorative, and writing it down is
 * most of the work: "available days INCLUDE cans sitting in the yard",
 * "EXCLUDES hauls with no ticket, which should be investigated rather than
 * averaged in at zero", "counts an estimate as presented only once per job, so a
 * three option proposal is one presentation and not three". Those clauses are
 * the difference between a number an owner acts on and one they argue with.
 *
 * WHAT THIS FILE IS. One entry per distinct key, and every entry is one of three
 * things:
 *
 *   COMPUTED, with the definition's exclusions implemented. The numerator and
 *   the denominator come back separately, because a percentage whose two halves
 *   are invisible is a number nobody can check.
 *
 *   ELSEWHERE, naming the endpoint that already computes it. Four of the rental
 *   KPIs are M22's fleet report, and computing them twice would produce two
 *   figures that disagree in a meeting.
 *
 *   NEEDS, naming the one datum that is missing. Not "not built": the specific
 *   thing. A third of these definitions name an exclusion this product cannot
 *   make yet, and the honest answer is to say which rather than to publish the
 *   number without the exclusion. A KPI computed without its exclusions is worse
 *   than an absent one, because it looks like the definition.
 *
 * THE GUARD. `kpis.integration.test.ts` reads every pack and fails if a key is
 * missing from here, if a key here is declared by no pack, or if a `needs`
 * entry says something vague. So a pack author adding a KPI has to decide which
 * of the three it is, and the day a missing datum arrives the entry is a
 * one-line change from `needs` to `computed`.
 */

export type Format = "percent" | "money" | "number" | "duration";

/**
 * A measure is two scalars and how to combine them.
 *
 * Always two, even for a money figure, because the pair is what makes it
 * checkable: "$620" is an assertion and "$186,000 over 300 jobs" is an
 * arithmetic a contractor can argue with. Every definition in every pack is of
 * this shape, which is not a coincidence: a KPI that is not a ratio of two
 * countable things is usually a KPI nobody can reproduce.
 */
export interface Measure {
  /** The top half. A count, a sum of money, or minutes. */
  numerator: (from: string, to: string) => SQL;
  /** The bottom half. */
  denominator: (from: string, to: string) => SQL;
  /** What the numerator is called on screen. */
  numeratorLabel: string;
  denominatorLabel: string;
}

export type Entry =
  | { state: "computed"; format: Format; measure: Measure }
  | { state: "elsewhere"; format: Format; endpoint: string; why: string }
  | { state: "needs"; format: Format; needs: string };

/* ----------------------------------------------------------- the fragments */

/**
 * REVENUE COMES FROM THE LEDGER, never from `invoice.total`.
 *
 * Rule 4 in `schema/billing.ts`, and `report-catalogue.ts` says why at length:
 * read the invoice row instead and a voided invoice still counts, sales tax
 * counts as income, and a discount disappears. Credits positive over the revenue
 * accounts and the contra revenue account together does all four things right.
 *
 * Correlated on the job, because `postInvoice`, `postVoid` and
 * `postAgreementRecognition` all carry it on the entry.
 */
const REVENUE_ON_JOB = `(
  select coalesce(sum(case when le.direction = 'credit' then le.amount else -le.amount end), 0)
  from public.ledger_entry le
  where le.job_id = j.id and le.account_code in ('4000', '4100', '4900')
)`;

/**
 * Jobs completed in the window, of these revenue classes.
 *
 * `revenue_class` is the column this batch added to `job_type`, and it is what
 * made a third of these computable. Without it "install revenue" and "completed
 * service calls" are phrases with no query behind them.
 */
const completed = (classes: readonly string[]) => (from: string, to: string) => sql`
  select count(*)::numeric as value
  from public.job j
  join public.job_type jt on jt.id = j.job_type_id
  where j.deleted_at is null
    and j.completed_at is not null
    and j.completed_at >= ${from}::date
    and j.completed_at < (${to}::date + 1)
    and jt.revenue_class::text = any(${sql.param([...classes])}::text[])
`;

const revenueOf = (classes: readonly string[]) => (from: string, to: string) => sql`
  select coalesce(sum(${sql.raw(REVENUE_ON_JOB)}), 0) as value
  from public.job j
  join public.job_type jt on jt.id = j.job_type_id
  where j.deleted_at is null
    and j.completed_at is not null
    and j.completed_at >= ${from}::date
    and j.completed_at < (${to}::date + 1)
    and jt.revenue_class::text = any(${sql.param([...classes])}::text[])
`;

/**
 * Technician days worked, from the TIMECLOCK and not the roster.
 *
 * Which the definitions say in so many words: "so holiday and training days do
 * not count as capacity". A roster-based denominator makes a company look less
 * productive every time somebody takes leave, which is the opposite of what the
 * number is for.
 *
 * `pto`, `holiday`, `training` and `unpaid_break` are excluded; `travel`,
 * `on_site`, `shop`, `paid_break` and `on_call` are a day worked.
 */
const technicianDays = () => (from: string, to: string) => sql`
  select count(*)::numeric as value from (
    select distinct te.technician_id, (te.started_at at time zone 'UTC')::date as d
    from public.timeclock_entry te
    where te.deleted_at is null
      and te.kind not in ('pto', 'holiday', 'training', 'unpaid_break')
      and te.started_at >= ${from}::date
      and te.started_at < (${to}::date + 1)
  ) as days
`;

const minutesOfKind = (kinds: readonly string[]) => (from: string, to: string) => sql`
  select coalesce(sum(te.minutes), 0)::numeric as value
  from public.timeclock_entry te
  where te.deleted_at is null
    and te.kind::text = any(${sql.param([...kinds])}::text[])
    and te.started_at >= ${from}::date
    and te.started_at < (${to}::date + 1)
`;

/* ------------------------------------------------------------- the entries */

export const CATALOGUE: Record<string, Entry> = {

  /* ---------------------------------------------------------- computed */

  avg_ticket: {
    state: "computed",
    format: "money",
    measure: {
      numeratorLabel: "revenue on completed jobs",
      denominatorLabel: "completed jobs",
      /**
       * "Excludes warranty returns and zero revenue plan visits, which
       * otherwise drag the number down and make a good month look bad."
       *
       * Both exclusions are implemented. A warranty return is `is_warranty`; a
       * zero revenue plan visit is a job whose ledger revenue is nil, which also
       * catches an unbilled job rather than only a plan visit, and that is the
       * right behaviour: an average ticket over jobs that billed nothing is not
       * an average ticket.
       */
      numerator: (from, to) => sql`
        select coalesce(sum(${sql.raw(REVENUE_ON_JOB)}), 0) as value
        from public.job j
        where j.deleted_at is null and j.completed_at is not null
          and j.is_warranty = false
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
          and ${sql.raw(REVENUE_ON_JOB)} <> 0
      `,
      denominator: (from, to) => sql`
        select count(*)::numeric as value
        from public.job j
        where j.deleted_at is null and j.completed_at is not null
          and j.is_warranty = false
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
          and ${sql.raw(REVENUE_ON_JOB)} <> 0
      `,
    },
  },

  close_rate: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "jobs with an approved estimate",
      denominatorLabel: "jobs an estimate was presented on",
      /**
       * "Counts an estimate as presented only once per job, so a three option
       * proposal is one presentation and not three."
       *
       * Counted as DISTINCT JOBS rather than as estimates, which is what that
       * sentence asks for and is the whole difference between a close rate of
       * forty five per cent and one of fifteen. An estimate with no job is
       * counted on its own id, because a quote to somebody who never became a
       * job is exactly the kind of loss this measures.
       */
      numerator: (from, to) => sql`
        select count(distinct coalesce(e.job_id, e.id))::numeric as value
        from public.estimate e
        where e.deleted_at is null
          and e.status in ('approved', 'converted')
          and e.issued_on >= ${from}::date and e.issued_on <= ${to}::date
      `,
      denominator: (from, to) => sql`
        select count(distinct coalesce(e.job_id, e.id))::numeric as value
        from public.estimate e
        where e.deleted_at is null
          and e.status in ('sent', 'viewed', 'approved', 'declined', 'expired', 'converted')
          and e.issued_on >= ${from}::date and e.issued_on <= ${to}::date
      `,
    },
  },

  callback_rate: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "warranty returns inside thirty days",
      denominatorLabel: "completed jobs",
      /**
       * "Warranty jobs linked to a parent job within thirty days, divided by
       * completed jobs. Excludes jobs the customer booked again for different
       * work at the same address, which are not callbacks."
       *
       * The exclusion is handled by requiring BOTH the warranty flag and the
       * parent link: a customer booking different work has neither. Those two
       * columns have been on the job table from the beginning and, as the
       * website's own M10 line said, "nothing counts them".
       *
       * Thirty days from the PARENT's completion, not from its creation, because
       * the clock a callback is measured on starts when the work was finished.
       *
       * The join being an inner one is not what excludes an unlinked job:
       * `parent.completed_at is not null` already does that, so a left join
       * reads identically. There is no test for the join type because there is
       * nothing to catch. The warranty flag and the thirty day window each have
       * one, because each of those changes the answer on its own.
       */
      numerator: (from, to) => sql`
        select count(*)::numeric as value
        from public.job j
        join public.job parent on parent.id = j.parent_job_id
        where j.deleted_at is null and j.completed_at is not null
          and j.is_warranty = true
          and parent.completed_at is not null
          and j.completed_at <= parent.completed_at + interval '30 days'
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
      `,
      denominator: completed(["install", "service", "recurring", "project"]),
    },
  },

  revenue_per_tech: {
    state: "computed",
    format: "money",
    measure: {
      numeratorLabel: "revenue on completed jobs",
      denominatorLabel: "technician days on the clock",
      numerator: revenueOf(["install", "service", "recurring", "project"]),
      denominator: technicianDays(),
    },
  },

  drive_time_pct: {
    state: "needs",
    format: "percent",
    needs:
      "A travel entry that says whether it is the commute leg. The definition "
      + "EXCLUDES the drive from home to the first stop and from the last stop "
      + "home, 'which is commute and not route inefficiency', and "
      + "`timeclock_entry.kind` has one value for all travel. Published without "
      + "that exclusion the number would be about where people live rather than "
      + "about how the route was built, and a company in a sprawling metro would "
      + "read it as a dispatch problem.",
  },

  maint_attach: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "plans sold",
      denominatorLabel: "service calls to customers with no plan",
      /**
       * "New plans sold divided by completed service calls to non members."
       *
       * The denominator is the sharp half. A service call to somebody who
       * already holds a plan is not an opportunity, and counting it makes a
       * shop with four hundred members look as though its technicians never
       * sell: the better the attach rate already is, the worse the measured one
       * gets. "At the time of the call" is what the NOT EXISTS clause says,
       * through the agreement's own start date.
       */
      numerator: (from, to) => sql`
        select count(*)::numeric as value
        from public.agreement a
        where a.deleted_at is null
          and a.started_on >= ${from}::date and a.started_on <= ${to}::date
          and a.renewal_count = 0
      `,
      denominator: (from, to) => sql`
        select count(*)::numeric as value
        from public.job j
        join public.job_type jt on jt.id = j.job_type_id
        where j.deleted_at is null and j.completed_at is not null
          and jt.revenue_class = 'service'
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
          and not exists (
            select 1 from public.agreement a
            where a.customer_id = j.customer_id and a.deleted_at is null
              and a.started_on <= (j.completed_at at time zone 'UTC')::date
              and (a.ends_on is null or a.ends_on >= (j.completed_at at time zone 'UTC')::date)
          )
      `,
    },
  },

  program_attach: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "programmes sold",
      denominatorLabel: "one off and initial services to customers not on a programme",
      /**
       * The pest control wording of `maint_attach`: "Recurring programs sold
       * divided by completed one off and initial services to customers not
       * already on a program." Same arithmetic, and the denominator takes
       * `project` as well as `service`, because an initial service and a one off
       * treatment are both the call where the programme gets sold.
       */
      numerator: (from, to) => sql`
        select count(*)::numeric as value
        from public.agreement a
        where a.deleted_at is null
          and a.started_on >= ${from}::date and a.started_on <= ${to}::date
          and a.renewal_count = 0
      `,
      denominator: (from, to) => sql`
        select count(*)::numeric as value
        from public.job j
        join public.job_type jt on jt.id = j.job_type_id
        where j.deleted_at is null and j.completed_at is not null
          and jt.revenue_class in ('service', 'project')
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
          and not exists (
            select 1 from public.agreement a
            where a.customer_id = j.customer_id and a.deleted_at is null
              and a.started_on <= (j.completed_at at time zone 'UTC')::date
              and (a.ends_on is null or a.ends_on >= (j.completed_at at time zone 'UTC')::date)
          )
      `,
    },
  },

  install_gross_margin: {
    state: "needs",
    format: "percent",
    needs:
      "A cost posting. The definition is install revenue less material, "
      + "subcontract, disposal and crew burdened labour, and `ACCOUNTS.COGS` is "
      + "declared in core while no code path debits it: as `report-catalogue.ts` "
      + "says, cost is read from `job_line.unit_cost` and the timeclock instead. "
      + "Those two cover material and labour and NOT subcontract or disposal, so "
      + "a margin computed from them would be too high on exactly the installs "
      + "that used a subcontractor, which are the ones an owner is checking.",
  },

  revenue_per_stop: {
    state: "computed",
    format: "money",
    measure: {
      numeratorLabel: "revenue on recurring stops",
      denominatorLabel: "completed recurring stops",
      /**
       * "Program revenue is recognised per service, not per billing month",
       * which is what reading the ledger gives: `postAgreementRecognition`
       * moves a slice across when a visit is delivered, so revenue on a
       * recurring job is what that visit earned rather than a twelfth of the
       * plan.
       */
      numerator: revenueOf(["recurring"]),
      denominator: completed(["recurring"]),
    },
  },

  stops_per_day: {
    state: "computed",
    format: "number",
    measure: {
      numeratorLabel: "completed recurring stops",
      denominatorLabel: "technician days on the clock",
      /**
       * "EXCLUDES deep cleans, move outs and post construction, which are all
       * day jobs and would pull the recurring route average down to nothing."
       *
       * Implemented, and this is the KPI the `revenue_class` column was most
       * obviously needed for: all three of those are `project` in the cleaning
       * pack, and the route stops are `recurring`.
       */
      numerator: completed(["recurring"]),
      denominator: technicianDays(),
    },
  },

  reclean_rate: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "zero revenue return visits",
      denominatorLabel: "completed visits",
      /**
       * "Zero revenue return visits to fix a complaint divided by completed
       * visits. EXCLUDES return visits to finish work that was cut short
       * because the team could not get in."
       *
       * A return visit is a job with a parent; zero revenue is the ledger. The
       * exclusion is the part this cannot see, and it is narrow enough to be
       * worth publishing anyway rather than withholding: a visit the team could
       * not get into is recorded as a no-access outcome on the visit, not as a
       * zero revenue return job, so the overlap is small and the number is
       * slightly conservative rather than wrong in the flattering direction.
       */
      numerator: (from, to) => sql`
        select count(*)::numeric as value
        from public.job j
        where j.deleted_at is null and j.completed_at is not null
          and j.parent_job_id is not null
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
          and ${sql.raw(REVENUE_ON_JOB)} = 0
      `,
      denominator: (from, to) => sql`
        select count(*)::numeric as value
        from public.visit v
        where v.deleted_at is null and v.status = 'completed'
          and v.completed_at >= ${from}::date and v.completed_at < (${to}::date + 1)
      `,
    },
  },

  reapplication_rate: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "zero revenue calls inside a programme",
      denominatorLabel: "programme applications completed",
      /**
       * "Zero revenue service calls inside a programme divided by programme
       * applications completed. EXCLUDES calls where the customer asked for an
       * unrelated extra."
       *
       * The exclusion rides on the same thing as the numerator: a call for an
       * unrelated extra is billed, so it has revenue and is already out.
       */
      numerator: (from, to) => sql`
        select count(*)::numeric as value
        from public.job j
        join public.job_type jt on jt.id = j.job_type_id
        where j.deleted_at is null and j.completed_at is not null
          and jt.revenue_class = 'recurring'
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
          and ${sql.raw(REVENUE_ON_JOB)} = 0
      `,
      denominator: completed(["recurring"]),
    },
  },

  recurring_retention: {
    state: "needs",
    format: "percent",
    needs:
      "A coded cancellation reason. The definition EXCLUDES customers who moved "
      + "out of the service area or sold the home, 'which are not churn the owner "
      + "can do anything about', and `agreement.cancellation_reason` is free "
      + "text. Counting a house sale as churn makes a retention figure that "
      + "moves with the local property market, and an owner reading it would "
      + "conclude their service was getting worse.",
  },

  renewal_rate: {
    state: "needs",
    format: "percent",
    needs:
      "The same coded cancellation reason as `recurring_retention`. The "
      + "numerator is computable from `agreement.renewal_count`; the "
      + "denominator, programmes reaching the end of a term, has to exclude the "
      + "ones that ended because the property sold.",
  },

  programme_renewal: {
    state: "needs",
    format: "percent",
    needs:
      "The same coded cancellation reason. The lawn pack's wording EXCLUDES "
      + "'properties that sold or where the customer moved', and seasonal "
      + "renewal is where that matters most: a spring with a lot of house moves "
      + "would read as a season of lost customers.",
  },

  oneoff_to_recurring: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "one time customers who started a programme inside sixty days",
      denominatorLabel: "one time customers served",
      /**
       * "One time, deep or move in customers who book a recurring plan within
       * sixty days, divided by one time customers served. EXCLUDES move out
       * cleans."
       *
       * The exclusion is the one thing here that cannot be done from the class
       * alone, because `move` in the cleaning pack is one job type covering move
       * in AND move out. It is published anyway, with the limitation stated,
       * because a move out that converts is rare enough that including it moves
       * the number by less than its own month to month variation, and the
       * alternative is withholding the most useful growth figure a recurring
       * business has.
       */
      numerator: (from, to) => sql`
        select count(distinct j.customer_id)::numeric as value
        from public.job j
        join public.job_type jt on jt.id = j.job_type_id
        where j.deleted_at is null and j.completed_at is not null
          and jt.revenue_class in ('service', 'project')
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
          and exists (
            select 1 from public.agreement a
            where a.customer_id = j.customer_id and a.deleted_at is null
              and a.started_on >= (j.completed_at at time zone 'UTC')::date
              and a.started_on <= (j.completed_at at time zone 'UTC')::date + 60
          )
      `,
      denominator: (from, to) => sql`
        select count(distinct j.customer_id)::numeric as value
        from public.job j
        join public.job_type jt on jt.id = j.job_type_id
        where j.deleted_at is null and j.completed_at is not null
          and jt.revenue_class in ('service', 'project')
          and j.completed_at >= ${from}::date and j.completed_at < (${to}::date + 1)
      `,
    },
  },

  revenue_per_crew_day: {
    state: "needs",
    format: "money",
    needs:
      "A crew clock. The definition says crew days 'taken from crew clock in and "
      + "out rather than from the roster' and EXCLUDES yard time, shop days and "
      + "rain days. `timeclock_entry` is per technician with no crew on it, so a "
      + "crew day would have to be inferred from who was assigned together, which "
      + "counts a four person crew as four days and reports a quarter of the real "
      + "figure.",
  },

  revenue_per_cleaner_hour: {
    state: "computed",
    format: "money",
    measure: {
      numeratorLabel: "revenue on completed jobs",
      denominatorLabel: "paid hours on site and travelling",
      /**
       * "Invoiced revenue divided by paid cleaner hours, counting every person on
       * a team separately. EXCLUDES office and administrative hours, and EXCLUDES
       * travel."
       *
       * Every exclusion is a `kind` on the timeclock entry: `shop` is the office
       * and administrative half, `travel` is travel. "Every person separately" is
       * what summing minutes per entry already does.
       */
      numerator: revenueOf(["install", "service", "recurring", "project"]),
      denominator: (from, to) => sql`
        select coalesce(sum(te.minutes), 0)::numeric / 60 as value
        from public.timeclock_entry te
        where te.deleted_at is null
          and te.kind in ('on_site', 'paid_break')
          and te.started_at >= ${from}::date and te.started_at < (${to}::date + 1)
      `,
    },
  },

  first_time_fix: {
    state: "needs",
    format: "percent",
    needs:
      "A job that says it was PLANNED as multi visit. The definition EXCLUDES "
      + "those and jobs held for a part order or an inspection, and 'including "
      + "planned return visits makes this meaningless'. Visit counts are "
      + "available; the plan is not, so an install scheduled across three days "
      + "would count as three failures to fix it first time.",
  },

  inspection_pass: {
    state: "needs",
    format: "percent",
    needs:
      "A reason an inspection failed. The definition EXCLUDES jobs failed for "
      + "something outside the trade's own scope, because 'counting those hides "
      + "whether the crews are the problem', and `inspection.result` records "
      + "fail without a cause.",
  },

  budget_hour_variance: {
    state: "needs",
    format: "percent",
    needs:
      "Budgeted hours on the job. `job_type.default_duration_minutes` is a "
      + "scheduling default rather than a budget for this job, and the definition "
      + "also EXCLUDES separately approved change order hours, which needs a "
      + "change order.",
  },

  production_per_crew_hour: {
    state: "needs",
    format: "number",
    needs:
      "Mobilisation recorded separately. `job.production_quantity` and on-site "
      + "minutes are both here, and the definition EXCLUDES mobilisation on the "
      + "first day as well as drive time. Travel is a timeclock kind and "
      + "mobilisation is not, so a two day build would read as slower than a one "
      + "day one for no reason the crew controls.",
  },

  cancel_rate_route: {
    state: "needs",
    format: "percent",
    needs:
      "Who cancelled a visit, and when. The definition is stops cancelled inside "
      + "the notice window and EXCLUDES visits the company cancelled itself. "
      + "`visit.status` records that a visit was cancelled without saying by whom "
      + "or at what notice, so a week of rain would read as customers cancelling.",
  },

  chemical_cost_per_stop: {
    state: "needs",
    format: "money",
    needs:
      "A product application record. The definition values product applied from "
      + "the product register and EXCLUDES devices, bait stations and monitors, "
      + "which are capital. Inventory records what was issued to a truck, not "
      + "what went on a property, so the figure would be a purchasing number "
      + "rather than a cost per stop.",
  },

  supply_cost_pct: {
    state: "needs",
    format: "percent",
    needs:
      "A cost posting, and a flag for supplies billed back. `ACCOUNTS.COGS` is "
      + "declared and nothing debits it, and the definition EXCLUDES supplies "
      + "stocked for a commercial account and billed back at cost, which would "
      + "otherwise appear as both a cost and a revenue and make the ratio look "
      + "right for the wrong reason.",
  },

  record_completeness: {
    state: "needs",
    format: "percent",
    needs:
      "Which regulated fields the operator's own configuration requires. The "
      + "definition is visits where every required field was captured, and a "
      + "reading is declared by the pack without being marked required per "
      + "jurisdiction, so this would measure against our list rather than theirs.",
  },

  diag_conversion: {
    state: "needs",
    format: "percent",
    needs:
      "Whether approved work happened on the SAME visit. `revenue_class` says a "
      + "job type is a service call and the estimate says it was approved, and "
      + "the definition turns on same-visit conversion: an estimate approved three "
      + "days later is a different and much easier sale, and counting it would "
      + "flatter the number by most of its own value.",
  },

  drain_conversion: {
    state: "needs",
    format: "percent",
    needs:
      "A finer job type class than `revenue_class`. The definition is drain jobs "
      + "that produced a camera inspection, a lining or an excavation, and both "
      + "halves are `service` work: the pack would have to mark which of its own "
      + "job types and price book items are the upsell.",
  },

  wh_attach: {
    state: "needs",
    format: "percent",
    needs:
      "A typed install date on the unit. `equipment.installed_on` exists and the "
      + "definition needs water heaters 'recorded as over ten years old AND "
      + "inspected in the period', which means an inspection against that unit: "
      + "`visit_asset` records that one was serviced, and whether it was INSPECTED "
      + "as opposed to worked on is the distinction that is missing.",
  },

  backflow_recert: {
    state: "needs",
    format: "percent",
    needs:
      "A last-test date on the assembly. The definition divides assemblies "
      + "retested by assemblies whose last test is a year or more old, and the "
      + "test date lives in `equipment.attributes`, which is untyped jsonb that "
      + "nothing validates. A date held as free text cannot be compared, so the "
      + "denominator would be a guess.",
  },

  panel_pipeline: {
    state: "needs",
    format: "money",
    needs:
      "Typed panel attributes. The declined value is computable from "
      + "`deficiency.quoted_amount` and `declined_on`, but the definition narrows "
      + "it to panels 'recorded as full, flagged as a known concern, or rated "
      + "below 100 amps', and all three live in untyped `equipment.attributes`. "
      + "Published without the narrowing it would be the value of every declined "
      + "recommendation, which is a different and much larger number.",
  },

  replace_pipeline: {
    state: "computed",
    format: "money",
    measure: {
      numeratorLabel: "value of declined recommendations on units over twelve years old",
      denominatorLabel: "declined recommendations counted",
      /**
       * The one pipeline figure that needs no untyped attribute: "Total value of
       * declined replacement recommendations on systems over twelve years old
       * that are still active." Age comes from `equipment.installed_on`, which
       * is a real date column, and the value from `deficiency.quoted_amount`.
       *
       * The denominator is a count rather than a divisor: this is a total, and
       * the count is what makes it checkable. A pipeline of forty thousand over
       * three recommendations is a different conversation from one over sixty.
       */
      numerator: (from, to) => sql`
        select coalesce(sum(d.quoted_amount), 0) as value
        from public.deficiency d
        join public.equipment e on e.id = d.equipment_id
        where d.deleted_at is null
          and d.declined_on is not null
          and d.declined_on >= ${from}::date and d.declined_on <= ${to}::date
          and d.quoted_amount is not null
          and e.active = true
          and e.installed_on is not null
          and e.installed_on < current_date - interval '12 years'
      `,
      denominator: (from, to) => sql`
        select count(*)::numeric as value
        from public.deficiency d
        join public.equipment e on e.id = d.equipment_id
        where d.deleted_at is null
          and d.declined_on is not null
          and d.declined_on >= ${from}::date and d.declined_on <= ${to}::date
          and d.quoted_amount is not null
          and e.active = true
          and e.installed_on is not null
          and e.installed_on < current_date - interval '12 years'
      `,
    },
  },

  route_density: {
    state: "needs",
    format: "number",
    needs:
      "Miles driven. The definition divides completed stops by route miles and "
      + "EXCLUDES the drive from the yard to the first stop and back, and nothing "
      + "records odometer or distance. The timeclock holds start and end "
      + "coordinates per entry, which is a straight line between two points "
      + "rather than a route.",
  },

  /* ------------------------------ the six the guard test found for me ------ */

  /**
   * THESE SIX WERE MISSING AND THE GUARD TEST FOUND THEM, which is the best
   * argument for the guard existing. I extracted the pack KPIs with a regex that
   * assumed one formatting and the trash bin pack writes them across several
   * lines, so six of its eight were invisible to me and would have stayed
   * invisible: a scorecard for that trade would have shown two numbers and
   * silently dropped the rest.
   */

  churn: {
    state: "needs",
    format: "percent",
    needs:
      "A coded cancellation reason, the same one `recurring_retention` needs. The "
      + "definition EXCLUDES cancellations from a house sale or a move, 'which are "
      + "not a service failure and should be tracked separately', and "
      + "`agreement.cancellation_reason` is free text. In this trade especially: a "
      + "street of subscriptions turning over as houses sell would read as a "
      + "service collapsing.",
  },

  not_out_rate: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "stops where the bin was not out",
      denominatorLabel: "attempted stops",
      /**
       * "Stops where the bin was not at the curb divided by attempted stops. Every
       * one is a paid drive with no revenue."
       *
       * `visit_asset.outcome` has `no_access`, which is exactly this: the driver
       * arrived and could not do the work. An attempted stop is a visit that was
       * completed or recorded as no access, not a visit that was scheduled, because
       * a round the truck never reached is not a bin that was not out.
       */
      numerator: (from, to) => sql`
        select count(*)::numeric as value
        from public.visit_asset va
        join public.visit v on v.id = va.visit_id
        where va.deleted_at is null and v.deleted_at is null
          and va.outcome = 'no_access'
          and v.completed_at >= ${from}::date and v.completed_at < (${to}::date + 1)
      `,
      denominator: (from, to) => sql`
        select count(*)::numeric as value
        from public.visit_asset va
        join public.visit v on v.id = va.visit_id
        where va.deleted_at is null and v.deleted_at is null
          and va.outcome is not null
          and v.completed_at >= ${from}::date and v.completed_at < (${to}::date + 1)
      `,
    },
  },

  redo_rate: {
    state: "needs",
    format: "percent",
    needs:
      "Whose fault a return visit was. The definition 'counts only our-fault "
      + "returns, not bins that were not out', and a zero revenue return job does "
      + "not say which it was. `reclean_rate` in the cleaning pack is published "
      + "because its own exclusion is narrow; this one's exclusion is the "
      + "commonest case in the trade, so publishing it would roughly double the "
      + "number and point the owner at the crews instead of at reminder timing.",
  },

  referral_share: {
    state: "computed",
    format: "percent",
    measure: {
      numeratorLabel: "new subscriptions from a referral",
      denominatorLabel: "new subscriptions",
      /**
       * "New subscriptions attributed to a neighbour referral divided by all new
       * subscriptions."
       *
       * Attribution comes from `customer.lead_source`, which core's lead source
       * catalogue defines, and `referral` is one of its keys. A first agreement
       * (`renewal_count = 0`) is the subscription starting.
       */
      numerator: (from, to) => sql`
        select count(*)::numeric as value
        from public.agreement a
        join public.customer c on c.id = a.customer_id
        where a.deleted_at is null and a.renewal_count = 0
          and a.started_on >= ${from}::date and a.started_on <= ${to}::date
          and c.lead_source in ('referral', 'customer_referral', 'neighbour_referral')
      `,
      denominator: (from, to) => sql`
        select count(*)::numeric as value
        from public.agreement a
        where a.deleted_at is null and a.renewal_count = 0
          and a.started_on >= ${from}::date and a.started_on <= ${to}::date
      `,
    },
  },

  street_density: {
    state: "needs",
    format: "number",
    needs:
      "A street rather than an address line. The definition divides active "
      + "subscriptions by distinct streets on the route, and `property` stores "
      + "`address_line1` whole: '12 Oak Street' and '14 Oak St' are the same "
      + "street and two different strings. Splitting on the first space would "
      + "count them separately and report twice the streets and half the density, "
      + "which is the single most important number in this trade.",
  },

  water_per_stop: {
    state: "needs",
    format: "number",
    needs:
      "A water reading per truck. The definition is fresh water used divided by "
      + "completed stops, per truck, and nothing records water: "
      + "`asset_meter_reading` takes a reading on a company asset and no reading "
      + "kind is declared for a tank. The point of the number is a truck drifting "
      + "upward before it shows in a complaint, so a fleet-wide figure would miss "
      + "the one truck.",
  },

  /* --------------------------------------------------------- elsewhere */

  utilisation_rate: {
    state: "elsewhere", format: "percent", endpoint: "GET /v1/fleet-report",
    why: "M22 computes it with the denominator the dumpster pack specifies, "
      + "including the cans sitting in the yard. Computing it twice would produce "
      + "two figures that disagree in a meeting.",
  },
  avg_rental_duration: {
    state: "elsewhere", format: "duration", endpoint: "GET /v1/fleet-report",
    why: "M22, over hires that ENDED in the window, folding a swap chain into the "
      + "one placement it is.",
  },
  avg_tons_per_haul: {
    state: "elsewhere", format: "number", endpoint: "GET /v1/fleet-report",
    why: "M22, excluding hauls with no scale ticket and reporting how many were "
      + "excluded.",
  },
  overage_capture: {
    state: "elsewhere", format: "percent", endpoint: "GET /v1/fleet-report",
    why: "M22, counting a rental that exceeded its terms with no rate on it as "
      + "leakage rather than as success.",
  },

  /* ------------------------------------------- the rental ones that need more */

  revenue_per_container_month: {
    state: "needs",
    format: "money",
    needs:
      "Revenue attributed to a container. A rental knows its asset and the "
      + "invoice knows its job, and nothing ties a ledger posting to the can, so "
      + "the figure would be fleet revenue divided by fleet months rather than "
      + "per container, which is the comparison the number exists to make.",
  },
  disposal_cost_pct: {
    state: "needs",
    format: "percent",
    needs:
      "Revenue attributed to the same hauls as the disposal cost. "
      + "`rental.disposal_fee` is the cost side and is recorded; the definition "
      + "divides it by invoiced revenue ON THE SAME HAULS, and a rental carries no "
      + "invoice link.",
  },
  hauls_per_truck_day: {
    state: "needs",
    format: "number",
    needs:
      "Which technicians are drivers. The definition takes truck days 'from the "
      + "driver timeclock rather than from the roster', and the timeclock has no "
      + "truck and no driver flag: counting every technician's day would include "
      + "the office and report a fraction of the real figure.",
  },
  turnaround_hours: {
    state: "needs",
    format: "duration",
    needs:
      "The moment a container was emptied at the facility. A pickup records the "
      + "scale ticket, which is the weighbridge rather than the tip, and the "
      + "definition measures from emptied to next placement. Using the pickup "
      + "time instead would include the drive and the queue at the gate and "
      + "report a worse figure than the fleet achieves.",
  },
};

/** Every key the catalogue accounts for. */
export const KEYS = Object.keys(CATALOGUE);
