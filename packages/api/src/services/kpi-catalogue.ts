import { sql, type SQL } from "drizzle-orm";
import { reporting, type Permission } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import { JOB_COSTING_SQL, SETTLEMENT_SQL } from "./report-catalogue";

/**
 * THE SIXTY THREE NUMBERS THE PACKS DEFINED AND NOTHING COMPUTED
 *
 * (They are read now. Thirty six of the forty seven are computed here, four are
 * M22's, and the seven that are not each name what they still lack.)
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
 * ONE HALF OF A KPI IS A LIST OF RECORDS, AND THE NUMBER IS THEIR SUM.
 *
 * Each half is written as the records it counts, one row each, with what that
 * record adds: a completed job adds one to a count, or its ledger revenue to a
 * sum; a technician day adds one; a drive adds its minutes. The scorecard's
 * number is the sum of the rows, and the drill under it lists the same rows.
 * So "$186,000 over 300 jobs" opens onto three hundred jobs whose revenue adds
 * up to $186,000, by construction rather than by a second query somebody has to
 * keep in step with the first. This is the report drill's rule, "every number
 * opens onto the records behind it and they add up to it", applied here.
 *
 * Every records query returns the same six columns:
 *
 *   kind     job, estimate, agreement, visit, customer, technician_day,
 *            crew_day, time, deficiency, equipment, route_day, street, truck,
 *            truck_day, container or haul: what the row is, which decides who
 *            may see it listed
 *   id       the record's id, as text
 *   label    what to call it on a list
 *   on_day   the date it falls on in the window, as YYYY-MM-DD
 *   value    what it adds to the half
 *   href     the screen it opens
 *
 * Written by us and never assembled from input, like every SQL fragment in the
 * reporting code. The window and the company's timezone are parameters, and so
 * is the company's trade, for the one key whose packs define it differently
 * (`first_time_fix`, whose exclusions differ by trade); every other query
 * ignores it.
 */
export type Records = (from: string, to: string, zone: string, trade: string) => SQL;

export interface Half {
  /** What the half is called on screen. */
  label: string;
  records: Records;
  /**
   * The half is dollars, whatever the KPI's own format. Left out, only the
   * numerator of a money KPI is: revenue over a count of jobs. Install margin
   * is a percentage of two dollar figures, so both its halves say so, and the
   * screen shows each as money rather than as a bare number.
   */
  money?: boolean;
}

/**
 * A measure is two halves and how to combine them.
 *
 * Always two, even for a money figure, because the pair is what makes it
 * checkable: "$620" is an assertion and "$186,000 over 300 jobs" is an
 * arithmetic a contractor can argue with. Every definition in every pack is of
 * this shape, which is not a coincidence: a KPI that is not a ratio of two
 * countable things is usually a KPI nobody can reproduce.
 */
export interface Measure {
  numerator: Half;
  denominator: Half;
  /**
   * Counts shown BESIDE the number rather than in it, each a list of records
   * like a half: the records a definition excludes, when it says to "count
   * them separately so the exclusion cannot be abused", and the records the
   * figure counts for a reason nobody recorded, so an owner is told how many
   * of the losses are unknown rather than having them guessed at.
   */
  besides?: Partial<Record<BesideKey, Half>>;
}

/** What a count beside the number is. */
export type BesideKey = "excluded" | "unknown";

export type Entry =
  /**
   * `permissions` is what reading the number needs BEYOND `report:read`, for a
   * figure built from what work costs. A KPI that discloses a margin to
   * somebody who may not read a margin is the report builder's cost column
   * one click away, so a reader without them is told which they lack instead
   * of being shown the number.
   */
  | { state: "computed"; format: Format; measure: Measure; permissions?: Permission[] }
  | { state: "elsewhere"; format: Format; endpoint: string; why: string }
  | { state: "needs"; format: Format; needs: string };

/** The half as one number: the sum of what its records add. */
export const total = (records: SQL): SQL => sql`
  select coalesce(sum(r.value), 0)::numeric as value from (${records}) as r
`;

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

/** A job as a row of a records query, adding `value`, dated by the company's calendar. */
const jobRow = (value: string, zone: string) => sql`
  'job'::text as kind, j.id::text as id, concat('#', j.number, ' ', j.summary) as label,
  to_char(j.completed_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
  (${sql.raw(value)})::numeric as value, '/jobs/' || j.id as href`;

/**
 * THE WINDOW'S EDGES, IN THE COMPANY'S CALENDAR.
 *
 * A window is whole days where the company is, so a job finished at eight in
 * the evening in Chicago on the 31st, which is 01:00 UTC on the 1st, belongs
 * to the 31st. Compared against `${from}::date` it fell into the next day, the
 * next month and the next scorecard, which is how a good month ended a job
 * short. Instants are compared with the instants these return, so an index on
 * the column still serves the comparison; a date column needs neither and
 * keeps comparing with the date.
 */
const dayStart = (day: string, zone: string) => sql`((${day}::date)::timestamp at time zone ${zone})`;
const dayAfter = (day: string, zone: string) => sql`((${day}::date + 1)::timestamp at time zone ${zone})`;

/**
 * Jobs completed in the window, of these revenue classes.
 *
 * `revenue_class` is the column this batch added to `job_type`, and it is what
 * made a third of these computable. Without it "install revenue" and "completed
 * service calls" are phrases with no query behind them.
 */
const completed = (classes: readonly string[]): Records => (from, to, zone) => sql`
  select ${jobRow("1", zone)}
  from public.job j
  join public.job_type jt on jt.id = j.job_type_id
  where j.deleted_at is null
    and j.completed_at is not null
    and j.completed_at >= ${dayStart(from, zone)}
    and j.completed_at < ${dayAfter(to, zone)}
    and jt.revenue_class::text = any(${sql.param([...classes])}::text[])
`;

const revenueOf = (classes: readonly string[]): Records => (from, to, zone) => sql`
  select ${jobRow(REVENUE_ON_JOB, zone)}
  from public.job j
  join public.job_type jt on jt.id = j.job_type_id
  where j.deleted_at is null
    and j.completed_at is not null
    and j.completed_at >= ${dayStart(from, zone)}
    and j.completed_at < ${dayAfter(to, zone)}
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
 * `pto`, `holiday`, `training` and `unpaid_break` are excluded (the list is
 * core's `NOT_A_DAY_WORKED`, which a crew's day shares); `travel`, `on_site`,
 * `shop`, `paid_break` and `on_call` are a day worked. One row per person per
 * day, which opens on that week's timesheets.
 */
const technicianDays = (): Records => (from, to, zone) => sql`
  select 'technician_day'::text as kind,
         concat(days.technician_id, ':', days.d) as id,
         concat(t.display_name, ', ', to_char(days.d, 'Mon FMDD')) as label,
         to_char(days.d, 'YYYY-MM-DD') as on_day,
         1::numeric as value,
         '/timesheets?week=' || to_char(days.d, 'YYYY-MM-DD') as href
  from (
    select distinct te.technician_id, (te.started_at at time zone ${zone})::date as d
    from public.timeclock_entry te
    where te.deleted_at is null
      and te.kind::text <> all(${sql.param([...reporting.NOT_A_DAY_WORKED])}::text[])
      and te.started_at >= ${dayStart(from, zone)}
      and te.started_at < ${dayAfter(to, zone)}
  ) as days
  join public.technician t on t.id = days.technician_id
`;

/**
 * A DRIVER'S DAY ON A TRUCK: the person was holding a truck on that day, and
 * their timeclock says they worked it.
 *
 * Who is a driver is not a flag on the person. It is that a vehicle with a kind
 * of truck (M22) was checked out to them that day, the same custody record that
 * already says who has the van, and half open like every custody period, so on
 * the day a truck is handed back it is the next driver's. A retired truck is no
 * truck a day after its retirement. The day worked is the timeclock's, by the
 * same rule `technicianDays` uses, because a roster would count the days off.
 */
const onATruck = (technician: SQL, day: SQL) => sql`
  exists (
    select 1 from public.asset_custody ac
    join public.company_asset ca on ca.id = ac.asset_id
    where ac.custodian_kind = 'technician' and ac.custodian_id = ${technician}
      and ca.truck_kind_id is not null
      and ac.held_from <= ${day}
      and (ac.held_until is null or ac.held_until > ${day})
      and (ca.retired_on is null or ca.retired_on > ${day})
  )`;

const truckDays = (): Records => (from, to, zone) => sql`
  select 'technician_day'::text as kind,
         concat(days.technician_id, ':', days.d) as id,
         concat(t.display_name, ', ', to_char(days.d, 'Mon FMDD')) as label,
         to_char(days.d, 'YYYY-MM-DD') as on_day,
         1::numeric as value,
         '/timesheets?week=' || to_char(days.d, 'YYYY-MM-DD') as href
  from (
    select distinct te.technician_id, (te.started_at at time zone ${zone})::date as d
    from public.timeclock_entry te
    where te.deleted_at is null
      and te.kind::text <> all(${sql.param([...reporting.NOT_A_DAY_WORKED])}::text[])
      and te.started_at >= ${dayStart(from, zone)}
      and te.started_at < ${dayAfter(to, zone)}
  ) as days
  join public.technician t on t.id = days.technician_id
  where ${onATruck(sql`days.technician_id`, sql`days.d`)}
`;

/**
 * A TRUCK'S DAYS, for fresh water per stop: each company vehicle and day in
 * the window with the stops completed that day by whoever had it checked out,
 * and the water its driver read (`truck_water_day`), a day with either.
 *
 * Who had a truck is the custody record, half open like every custody period,
 * so on the day it is handed over it is the next driver's. A stop is a visit
 * completed that day in the company's calendar that the holder was sent on by
 * name or with a crew they are on, which is how a route day reads "their
 * visits", and a multi bin stop is one visit. A retired truck has no day after
 * its retirement. Core's `reporting.waterPerStopOf` is the rule these days are
 * put through, and `kpi-water-per-stop.integration.test.ts` holds the two
 * together. Exported, because the office's water screen lists the same days.
 */
export const truckDaysSql = (from: string, to: string, zone: string) => sql`
  with held as (
    select distinct ca.id as asset_id, ac.custodian_id as technician_id, d.day::date as day
    from public.asset_custody ac
    join public.company_asset ca on ca.id = ac.asset_id
    cross join lateral generate_series(
      greatest(ac.held_from, ${from}::date)::timestamp,
      least(coalesce(ac.held_until - 1, ${to}::date), ${to}::date)::timestamp,
      interval '1 day') as d(day)
    where ac.custodian_kind = 'technician' and ca.kind = 'vehicle'
      and (ca.retired_on is null or ca.retired_on > d.day::date)
  ),
  stops as (
    select h.asset_id, h.day, count(distinct v.id)::int as stops
    from held h
    join public.visit v on v.deleted_at is null and v.status = 'completed'
      and v.completed_at >= ${dayStart(from, zone)} and v.completed_at < ${dayAfter(to, zone)}
      and (v.completed_at at time zone ${zone})::date = h.day
    where exists (select 1 from public.visit_assignment va where va.visit_id = v.id and va.technician_id = h.technician_id)
       or exists (select 1 from public.crew_member cm where cm.crew_id = v.crew_id and cm.technician_id = h.technician_id)
    group by h.asset_id, h.day
  ),
  read as (
    select w.id, w.asset_id, w.on_day, w.gallons, w.source
    from public.truck_water_day w
    where w.on_day >= ${from}::date and w.on_day <= ${to}::date
  )
  select coalesce(s.asset_id, r.asset_id) as asset_id, ca.label,
         to_char(coalesce(s.day, r.on_day), 'YYYY-MM-DD') as day,
         coalesce(s.stops, 0) as stops, r.gallons::text as gallons, r.source, r.id as reading_id
  from stops s
  full join read r on r.asset_id = s.asset_id and r.on_day = s.day
  join public.company_asset ca on ca.id = coalesce(s.asset_id, r.asset_id)
  order by ca.label, day
`;

/** Fresh water per stop's records: each truck's counted days added up, or a day left out. See `water_per_stop`. */
const waterPerStop = (pick: "numerator" | "denominator" | "excluded" | "unknown"): Records => (from, to, zone) => pick === "numerator" || pick === "denominator"
  ? sql`
    select 'truck'::text as kind, x.asset_id::text as id,
           concat(x.label, ': ', trim_scale(sum(x.gallons::numeric)), ' gallons over ', sum(x.stops),
                  case when sum(x.stops) = 1 then ' stop, ' else ' stops, ' end,
                  round(sum(x.gallons::numeric) / sum(x.stops), 1), ' a stop') as label,
           max(x.day) as on_day,
           ${pick === "numerator" ? sql`sum(x.gallons::numeric)` : sql`sum(x.stops)::numeric`} as value,
           '/fleet/water?truck=' || x.asset_id as href
    from (${truckDaysSql(from, to, zone)}) as x
    where x.gallons is not null and x.stops > 0
    group by x.asset_id, x.label`
  : sql`
    select 'truck_day'::text as kind, concat(x.asset_id, ':', x.day) as id,
           ${pick === "unknown"
             ? sql`concat(x.label, ', ', to_char(x.day::date, 'Mon FMDD'), ': ', x.stops, case when x.stops = 1 then ' stop' else ' stops' end, ', no water read')`
             : sql`concat(x.label, ', ', to_char(x.day::date, 'Mon FMDD'), ': ', trim_scale(x.gallons::numeric), ' gallons and no stop')`} as label,
           x.day as on_day, 1::numeric as value,
           '/fleet/water?truck=' || x.asset_id as href
    from (${truckDaysSql(from, to, zone)}) as x
    where ${pick === "unknown" ? sql`x.gallons is null and x.stops > 0` : sql`x.gallons is not null and x.stops = 0`}`;

/**
 * WHAT EACH HAUL WAS INVOICED, line by line: every invoice line that names the
 * haul it bills (a rental row: one can's time on a site), its own name when a
 * hire's invoice wrote it, or the name on the job line it billed. On invoices
 * issued and not voided, before tax (tax is held apart on the line), net of
 * discounts, and never a permit line, which the dumpster pack calls a pass
 * through and not revenue. Core's `reporting.haulRevenue` is the same rule.
 */
const haulLines = () => sql`
  select coalesce(il.rental_id, jl.rental_id) as rental_id, il.id as line_id, i.issued_on,
         (il.quantity * il.unit_price - il.discount_amount - il.member_discount_amount)::numeric as amount
  from public.invoice_line il
  join public.invoice i on i.id = il.invoice_id
  left join public.job_line jl on jl.invoice_line_id = il.id
  where coalesce(il.rental_id, jl.rental_id) is not null
    and i.deleted_at is null
    and i.status::text = any(${sql.param([...reporting.INVOICE_ISSUED])}::text[])
    and coalesce(jl.kind::text, '') <> 'permit'
`;

/** A container as it reads on a list: its number and its size. */
const containerName = (alias: string) => sql.raw(`concat('Container ', ${alias}.identifier, coalesce(' (' || ${alias}.size || ')', ''))`);

/** Revenue per container month's records. See `revenue_per_container_month`. */
const containerMonths = (pick: "numerator" | "denominator" | "unknown"): Records => (from, to, zone) => ({
  numerator: sql`
    select 'container'::text as kind, ra.id::text as id,
           concat(${containerName("ra")}, ': ', count(*), case when count(*) = 1 then ' line' else ' lines' end, ' invoiced') as label,
           max(hl.issued_on)::text as on_day, sum(hl.amount) as value, '/fleet/containers' as href
    from (${haulLines()}) as hl
    join public.rental r on r.id = hl.rental_id
    join public.rentable_asset ra on ra.id = r.asset_id
    where hl.issued_on >= ${from}::date and hl.issued_on <= ${to}::date
    group by ra.id, ra.identifier, ra.size`,
  denominator: sql`
    with fleet as (
      select ra.id, ra.identifier, ra.size,
             least((ra.created_at at time zone ${zone})::date,
                   coalesce((select min((r.delivered_at at time zone ${zone})::date) from public.rental r where r.asset_id = ra.id),
                            'infinity'::date)) as joined,
             (ra.deleted_at at time zone ${zone})::date as left_on
      from public.rentable_asset ra
    )
    select 'container'::text as kind, f.id::text as id,
           concat(${containerName("f")}, ': ',
                  to_char(sum(1.0 / extract(day from (date_trunc('month', d.day) + interval '1 month - 1 day'))), 'FM9990.00'),
                  ' months in the fleet') as label,
           ${to}::text as on_day,
           sum(1.0 / extract(day from (date_trunc('month', d.day) + interval '1 month - 1 day')))::numeric as value,
           '/fleet/containers' as href
    from fleet f
    cross join lateral generate_series(greatest(f.joined, ${from}::date)::timestamp, ${to}::date::timestamp, interval '1 day') as d(day)
    where f.left_on is null or d.day::date < f.left_on
    group by f.id, f.identifier, f.size`,
  unknown: sql`
    select 'job'::text as kind, j.id::text as id,
           concat('#', j.number, ' ', j.summary, ': ', count(*), case when count(*) = 1 then ' line' else ' lines' end,
                  ' naming no container') as label,
           max(i.issued_on)::text as on_day, 1::numeric as value, '/jobs/' || j.id as href
    from public.invoice_line il
    join public.invoice i on i.id = il.invoice_id
    join public.job_line jl on jl.invoice_line_id = il.id
    join public.job j on j.id = jl.job_id
    where il.rental_id is null and jl.rental_id is null and jl.kind::text <> 'permit'
      and i.deleted_at is null
      and i.status::text = any(${sql.param([...reporting.INVOICE_ISSUED])}::text[])
      and i.issued_on >= ${from}::date and i.issued_on <= ${to}::date
      and exists (select 1 from public.visit v where v.job_id = j.id and v.rental_id is not null)
    group by j.id, j.number, j.summary`,
}[pick]);

/**
 * Disposal cost's records: each haul collected in the window (the pickup or
 * swap that took the full can to the facility), with its facility fee and the
 * revenue invoiced on it. See `disposal_cost_pct`. Core's
 * `reporting.disposalHaulOf` is the rule.
 */
const disposalHauls = (pick: "numerator" | "denominator" | "unknown" | "excluded"): Records => (from, to, zone) => sql`
  select 'haul'::text as kind, r.id::text as id,
         concat(${containerName("ra")}, ', collected ', to_char(r.picked_up_at at time zone ${zone}, 'Mon FMDD'),
                coalesce(', ' || r.disposal_facility, ''), coalesce(', ticket ' || r.disposal_ticket_number, '')) as label,
         to_char(r.picked_up_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
         ${pick === "numerator" ? sql`r.disposal_fee::numeric` : pick === "denominator" ? sql`inv.revenue` : sql`1::numeric`} as value,
         '/fleet/containers' as href
  from public.rental r
  join public.rentable_asset ra on ra.id = r.asset_id
  left join lateral (
    select sum(hl.amount) as revenue, count(*) as lines from (${haulLines()}) as hl where hl.rental_id = r.id
  ) as inv on true
  where r.picked_up_at >= ${dayStart(from, zone)} and r.picked_up_at < ${dayAfter(to, zone)}
    and ${{
      numerator: sql`r.disposal_fee is not null and inv.lines > 0`,
      denominator: sql`r.disposal_fee is not null and inv.lines > 0`,
      unknown: sql`r.disposal_fee is null`,
      excluded: sql`r.disposal_fee is not null and inv.lines = 0`,
    }[pick]}
`;

/** The haul events of the pack: a delivery, a pickup, a swap, a dump and return, a relocation. */
const HAULS = ["delivery", "pickup", "swap", "dump-return", "relocate"];

/**
 * Haul visits done by a driver on a truck day. `completed` ones are the hauls;
 * the visits where the truck went and the haul did not happen (the customer was
 * not there, the way was blocked) are the dry runs the definition says to track
 * apart, because they use the same slot.
 */
const haulVisits = (done: boolean): Records => (from, to, zone) => sql`
  select 'visit'::text as kind, v.id::text as id,
         concat('#', j.number, ' ', coalesce(v.rental_event, jt.code), ', ', c.name) as label,
         to_char(${done ? sql`v.completed_at` : sql`coalesce(v.arrived_at, v.window_start)`} at time zone ${zone}, 'YYYY-MM-DD') as on_day,
         1::numeric as value, '/visits/' || v.id as href
  from public.visit v
  join public.job j on j.id = v.job_id
  join public.job_type jt on jt.id = j.job_type_id
  join public.customer c on c.id = j.customer_id
  where v.deleted_at is null
    and ${done ? sql`v.status = 'completed'
        and v.completed_at >= ${dayStart(from, zone)} and v.completed_at < ${dayAfter(to, zone)}`
      : sql`v.status = 'no_show' and v.arrived_at is not null
        and v.arrived_at >= ${dayStart(from, zone)} and v.arrived_at < ${dayAfter(to, zone)}`}
    and (v.rental_event is not null or jt.capacity_model = 'asset_rental')
    and coalesce(v.rental_event, jt.code) = any(${sql.param(HAULS)}::text[])
    and exists (
      select 1 from public.visit_assignment va
      where va.visit_id = v.id
        and ${onATruck(sql`va.technician_id`, sql`((${done ? sql`v.completed_at` : sql`v.arrived_at`}) at time zone ${zone})::date`)}
    )
`;

/** Visits completed in the window, one row each, which opens on the visit. */
const completedVisits = (): Records => (from, to, zone) => sql`
  select 'visit'::text as kind, v.id::text as id,
         concat('#', j.number, ' visit ', v.sequence) as label,
         to_char(v.completed_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
         1::numeric as value, '/visits/' || v.id as href
  from public.visit v
  join public.job j on j.id = v.job_id
  where v.deleted_at is null and v.status = 'completed'
    and v.completed_at >= ${dayStart(from, zone)} and v.completed_at < ${dayAfter(to, zone)}
`;

/** An agreement as a row: the plan, for whom, from when. */
const agreementRow = `
  'agreement'::text as kind, a.id::text as id,
  concat((select p.name from public.agreement_plan p where p.id = a.plan_id), ' for ',
         (select c.name from public.customer c where c.id = a.customer_id)) as label,
  a.started_on::text as on_day, 1::numeric as value, '/agreements/' || a.id as href`;

/** Plans sold in the window: a first term, not a renewal. */
const plansSold = (): Records => (from, to) => sql`
  select ${sql.raw(agreementRow)}
  from public.agreement a
  where a.deleted_at is null
    and a.started_on >= ${from}::date and a.started_on <= ${to}::date
    and a.renewal_count = 0
`;

/**
 * Presentations of an estimate, one per job (or per estimate with no job), in
 * these statuses. See `close_rate`.
 */
const presentations = (statuses: readonly string[]): Records => (from, to) => sql`
  select distinct on (coalesce(e.job_id, e.id))
         case when e.job_id is null then 'estimate' else 'job' end as kind,
         coalesce(e.job_id, e.id)::text as id,
         case when e.job_id is null then concat('Estimate ', e.number)
              else (select concat('#', j.number, ' ', j.summary) from public.job j where j.id = e.job_id) end as label,
         e.issued_on::text as on_day,
         1::numeric as value,
         case when e.job_id is null then '/estimates/' || e.id else '/jobs/' || e.job_id end as href
  from public.estimate e
  where e.deleted_at is null
    and e.status::text = any(${sql.param([...statuses])}::text[])
    and e.issued_on >= ${from}::date and e.issued_on <= ${to}::date
  order by coalesce(e.job_id, e.id), e.issued_on, e.number
`;

/**
 * Completed calls of these classes to customers holding no plan at the time
 * of the call, which is the opportunity a plan is sold on.
 */
const callsToNonMembers = (classes: readonly string[]): Records => (from, to, zone) => sql`
  select ${jobRow("1", zone)}
  from public.job j
  join public.job_type jt on jt.id = j.job_type_id
  where j.deleted_at is null and j.completed_at is not null
    and jt.revenue_class::text = any(${sql.param([...classes])}::text[])
    and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
    and not exists (
      select 1 from public.agreement a
      where a.customer_id = j.customer_id and a.deleted_at is null
        and a.started_on <= (j.completed_at at time zone ${zone})::date
        and (a.ends_on is null or a.ends_on >= (j.completed_at at time zone ${zone})::date)
    )
`;

/** Declined recommendations on live units over twelve years old. See `replace_pipeline`. */
const declinedOnOldUnits = (value: string): Records => (from, to, zone) => sql`
  select 'deficiency'::text as kind, d.id::text as id,
         concat(coalesce(e.tag || ' ', ''), e.category, ': ', d.description) as label,
         d.declined_on::text as on_day,
         (${sql.raw(value)})::numeric as value,
         '/equipment/' || e.id as href
  from public.deficiency d
  join public.equipment e on e.id = d.equipment_id
  where d.deleted_at is null
    and d.declined_on is not null
    and d.declined_on >= ${from}::date and d.declined_on <= ${to}::date
    and d.quoted_amount is not null
    and e.active = true
    and e.installed_on is not null
    and e.installed_on < (now() at time zone ${zone})::date - interval '12 years'
`;

/** Attempted bin stops, or only the ones where the bin was not out. See `not_out_rate`. */
const binStops = (notOutOnly: boolean): Records => (from, to, zone) => sql`
  select 'visit'::text as kind, va.id::text as id,
         concat('#', j.number, ' visit ', v.sequence, ', ', e.category, coalesce(' ' || e.tag, '')) as label,
         to_char(v.completed_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
         1::numeric as value, '/visits/' || v.id as href
  from public.visit_asset va
  join public.visit v on v.id = va.visit_id
  join public.job j on j.id = v.job_id
  join public.equipment e on e.id = va.equipment_id
  where va.deleted_at is null and v.deleted_at is null
    and ${notOutOnly ? sql`va.outcome = 'no_access'` : sql`va.outcome is not null`}
    and v.completed_at >= ${dayStart(from, zone)} and v.completed_at < ${dayAfter(to, zone)}
`;

/**
 * Backflow assemblies due a retest by the end of the window, or only those
 * retested in it. See `backflow_recert` for what counts as a test and as due.
 *
 * A test is found through the checkpoint it answered: the inspection's own
 * frozen copy of its checkpoints, or its programme's for an inspection filed
 * before the copy was kept, and the checkpoint has to be about a
 * `backflow-assembly`. An answer naming a unit on any other checkpoint (a
 * water heater checked on the same visit) is not a backflow test of it.
 */
const backflowDue = (retestedOnly: boolean): Records => (from, to) => sql`
  with tests as (
    select distinct a->>'equipmentId' as equipment_id, i.performed_on
    from public.inspection i
    cross join lateral jsonb_array_elements(i.answers) as a
    where i.performed_on is not null
      and i.result in ('pass', 'pass_with_deficiencies', 'fail')
      and a->>'equipmentId' is not null
      and exists (
        select 1
        from jsonb_array_elements(coalesce(
          i.checkpoints,
          (select p.checkpoints from public.inspection_program p where p.id = i.program_id),
          '[]'::jsonb
        )) as c
        where c->>'key' = a->>'itemKey' and c->>'assetCategory' = 'backflow-assembly'
      )
  ),
  due as (
    select t.equipment_id, max(t.performed_on) as last_test
    from tests t
    where t.performed_on < ${from}::date
    group by t.equipment_id
    having max(t.performed_on) <= (${to}::date - interval '1 year')::date
  )
  select 'equipment'::text as kind, e.id::text as id,
         concat(coalesce(e.tag || ' ', ''), e.category, coalesce(', serial ' || e.serial_number, '')) as label,
         d.last_test::text as on_day,
         1::numeric as value,
         '/equipment/' || e.id as href
  from due d
  join public.equipment e on e.id::text = d.equipment_id
  where e.deleted_at is null and e.active = true
    ${retestedOnly ? sql`and exists (
      select 1 from tests t where t.equipment_id = d.equipment_id
        and t.performed_on >= ${from}::date and t.performed_on <= ${to}::date
    )` : sql``}
`;


/**
 * CREW DAYS, from the crew's own clock.
 *
 * "Taken from crew clock in and out rather than from the roster, EXCLUDING yard
 * time, shop days and rain days where no stop was completed." A crew's clock is
 * what its members punched on the crew's own visits (`timeclock_entry.visit_id`
 * to `visit.crew_id`), so nothing is inferred from who was assigned together,
 * and the day is counted ONCE PER CREW however many people are on it. It has to
 * be a day the crew completed a stop, which is what leaves out the rain, and
 * the kinds of time are core's `NOT_A_CREW_DAY`, which leaves out the shop, the
 * yard and leave. The same rule in TypeScript is `reporting.crewDays`, which
 * the integration test holds this SQL to.
 */
const crewDays = (): Records => (from, to, zone) => sql`
  select 'crew_day'::text as kind,
         concat(d.crew_id, ':', d.day) as id,
         concat(c.name, ', ', to_char(d.day, 'Mon FMDD')) as label,
         to_char(d.day, 'YYYY-MM-DD') as on_day,
         1::numeric as value,
         '/timesheets?week=' || to_char(d.day, 'YYYY-MM-DD') as href
  from (
    select distinct v.crew_id, (te.started_at at time zone ${zone})::date as day
    from public.timeclock_entry te
    join public.visit v on v.id = te.visit_id
    where te.deleted_at is null and v.deleted_at is null
      and v.crew_id is not null
      and te.kind::text <> all(${sql.param([...reporting.NOT_A_CREW_DAY])}::text[])
      and te.started_at >= ${dayStart(from, zone)}
      and te.started_at < ${dayAfter(to, zone)}
      and exists (
        select 1 from public.visit done
        where done.crew_id = v.crew_id and done.deleted_at is null and done.status = 'completed'
          and (done.completed_at at time zone ${zone})::date = (te.started_at at time zone ${zone})::date
      )
  ) as d
  join public.crew c on c.id = d.crew_id
`;

/**
 * An install job as a row of a records query, written against the job's own
 * name (`job`) because the job costing fragments are correlated on it.
 */
const costedJobRow = (value: string, zone: string) => sql`
  'job'::text as kind, job.id::text as id, concat('#', job.number, ' ', job.summary) as label,
  to_char(job.completed_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
  (${sql.raw(value)})::numeric(14,4) as value, '/jobs/' || job.id as href`;

/**
 * Completed installs whose costs are all in. See `install_gross_margin` for why
 * the rest are left out of both halves; the test is the job statement's own
 * (`SETTLEMENT_SQL`: nothing clocked in, every punch priced, every line billed
 * or excused) plus hours recorded at all and no line without a cost, which is
 * core's `costsAreIn`.
 */
const costedInstalls = (value: string): Records => (from, to, zone) => sql`
  select ${costedJobRow(value, zone)}
  from public.job job
  join public.job_type jt on jt.id = job.job_type_id
  where job.deleted_at is null and job.completed_at is not null
    and jt.revenue_class = 'install'
    and job.completed_at >= ${dayStart(from, zone)} and job.completed_at < ${dayAfter(to, zone)}
    and ${sql.raw(SETTLEMENT_SQL)} = 'Settled'
    and ${sql.raw(JOB_COSTING_SQL.labourNotRecorded)} = 0
    and ${sql.raw(JOB_COSTING_SQL.uncostedLines)} = 0
`;

/**
 * WHO STAYED ON A PLAN: retention, renewal and churn.
 *
 * Each is core's rule (`reporting.retention`, `reporting.renewals`,
 * `reporting.churn`), written here as SQL, and the integration test puts the
 * same agreements through both. Read that file for what each figure means;
 * these are its three tests, as fragments over an agreement called `a`.
 *
 * RUNNING ON A DAY: started, not pending, not cancelled by that day, and not
 * past the end of a term it lapsed at.
 */
const runningOn = (alias: string, day: string) => sql`(
  ${sql.raw(alias)}.deleted_at is null and ${sql.raw(alias)}.status <> 'pending'
  and ${sql.raw(alias)}.started_on <= ${day}::date
  and (${sql.raw(alias)}.cancelled_on is null or ${sql.raw(alias)}.cancelled_on > ${day}::date)
  and not (${sql.raw(alias)}.status in ('lapsed', 'completed')
    and ${sql.raw(alias)}.ends_on is not null and ${sql.raw(alias)}.ends_on <= ${day}::date)
)`;

/**
 * THE HOME WAS LEFT: the cancellation said moved or sold, or the customer's
 * link to the agreement's address ended after it started and by the end of
 * the window, which catches a plan that lapsed because the house was sold.
 * Never null: a cancellation with no code is not a move, and a null here
 * would drop the agreement from both sides of every `not`.
 */
const leftTheHome = (to: string) => sql`(
  coalesce(a.cancellation_code in ('moved', 'sold'), false)
  or (a.property_id is not null and exists (
    select 1 from public.customer_property cp
    where cp.customer_id = a.customer_id and cp.property_id = a.property_id
      and cp.ended_on is not null and cp.ended_on >= a.started_on and cp.ended_on <= ${to}::date
  ))
)`;

/** Cancelled before the reason was chosen from a list. */
const REASON_UNKNOWN = sql`(a.status = 'cancelled' and a.cancellation_code is null)`;

const customerName = sql`(select c.name from public.customer c where c.id = x.customer_id)`;

/**
 * Accounts on a plan at the start of the window, one row per customer, with
 * whether they are on one at its end, whether a plan they held was lost
 * because the home was left, and whether one was cancelled for a reason
 * nobody coded. `retention` picks from these.
 */
const accounts = (from: string, to: string) => sql`
  select a.customer_id,
         exists (select 1 from public.agreement b where b.customer_id = a.customer_id and ${runningOn("b", to)}) as kept,
         bool_or(${leftTheHome(to)}) as left_home,
         bool_or(${REASON_UNKNOWN}) as unknown
  from public.agreement a
  where ${runningOn("a", from)}
  group by a.customer_id
`;

const accountRow = (day: string) => sql`
  'customer'::text as kind, x.customer_id::text as id, ${customerName} as label,
  ${day}::text as on_day, 1::numeric as value, '/customers/' || x.customer_id as href`;

/** Retention's records: which accounts, by which test. See `recurring_retention`. */
const retained = (pick: "numerator" | "denominator" | "excluded" | "unknown"): Records => (from, to) => sql`
  select ${accountRow(pick === "numerator" ? to : from)}
  from (${accounts(from, to)}) as x
  where ${{
    numerator: sql`x.kept`,
    denominator: sql`(x.kept or not x.left_home)`,
    excluded: sql`(not x.kept and x.left_home)`,
    unknown: sql`(not x.kept and not x.left_home and x.unknown)`,
  }[pick]}
`;

/**
 * Terms that reached their end in the window, by today, on an agreement not
 * cancelled before it: recorded terms, and the current term of an agreement
 * whose term was never written down. Renewed when the agreement went on to a
 * later term. One row per term, which opens on the agreement.
 */
const termsEnded = (from: string, to: string, zone: string) => sql`
  with terms as (
    select t.agreement_id, t.term, t.ends_on from public.agreement_term t
    union all
    select g.id, g.renewal_count + 1, g.ends_on from public.agreement g
    where g.ends_on is not null and not exists (
      select 1 from public.agreement_term t2 where t2.agreement_id = g.id and t2.term = g.renewal_count + 1
    )
  )
  select a.id as agreement_id, a.plan_id, a.customer_id, t.term, t.ends_on,
         a.renewal_count >= t.term as renewed,
         ${leftTheHome(to)} as left_home,
         ${REASON_UNKNOWN} as unknown
  from terms t
  join public.agreement a on a.id = t.agreement_id
  where a.deleted_at is null and a.status <> 'pending'
    and t.ends_on >= ${from}::date and t.ends_on <= ${to}::date
    and t.ends_on <= (now() at time zone ${zone})::date
    and (a.cancelled_on is null or a.cancelled_on >= t.ends_on)
`;

/** Renewal's records: which terms, by which test. See `renewal_rate`. */
const renewed = (pick: "numerator" | "denominator" | "excluded" | "unknown"): Records => (from, to, zone) => sql`
  select 'agreement'::text as kind, x.agreement_id::text as id,
         concat((select p.name from public.agreement_plan p where p.id = x.plan_id), ' for ', ${customerName},
                ', term ', x.term) as label,
         x.ends_on::text as on_day, 1::numeric as value, '/agreements/' || x.agreement_id as href
  from (${termsEnded(from, to, zone)}) as x
  where ${{
    numerator: sql`x.renewed`,
    denominator: sql`(x.renewed or not x.left_home)`,
    excluded: sql`(not x.renewed and x.left_home)`,
    unknown: sql`(not x.renewed and not x.left_home and x.unknown)`,
  }[pick]}
`;

/** Churn's records: subscriptions on at the start, by which test. See `churn`. */
const churned = (pick: "numerator" | "denominator" | "excluded" | "unknown"): Records => (from, to) => sql`
  select ${sql.raw(agreementRow)}
  from public.agreement a
  where ${runningOn("a", from)}
    ${{
      numerator: sql`and not ${runningOn("a", to)} and not ${leftTheHome(to)}`,
      denominator: sql``,
      excluded: sql`and not ${runningOn("a", to)} and ${leftTheHome(to)}`,
      unknown: sql`and not ${runningOn("a", to)} and not ${leftTheHome(to)} and ${REASON_UNKNOWN}`,
    }[pick]}
`;

/**
 * HOMES PER SERVED STREET: every subscription running on the window's last
 * day, with whether its customer is commercial and the street its address is
 * on, keyed as core's `geo.streetKey` keys it (the street, the town and the
 * state, trimmed, spaced once, in small letters). The street counts only when
 * it answers for the address as it is now (`street_for_address`), which is
 * `geo.streetOf`. `reporting.streetDensityOf` is the rule, and
 * `kpi-street-density.integration.test.ts` puts the same plans through both.
 */
const tidied = (column: string) => `lower(btrim(regexp_replace(coalesce(${column}, ''), '[[:space:]]+', ' ', 'g')))`;
const subscriptionsOnStreets = (to: string) => sql`
  select a.id as agreement_id, a.plan_id, a.customer_id, p.id as property_id,
         coalesce(c.type = 'commercial', false) as commercial,
         case when p.id is not null and p.street_for_address = p.address_key and ${sql.raw(tidied("p.street"))} <> ''
              then ${sql.raw(tidied("p.street"))} || '|' || ${sql.raw(tidied("p.city"))} || '|' || ${sql.raw(tidied("p.state"))}
         end as street_key,
         btrim(regexp_replace(p.street, '[[:space:]]+', ' ', 'g')) as street, p.city, p.state
  from public.agreement a
  join public.customer c on c.id = a.customer_id
  left join public.property p on p.id = a.property_id and p.deleted_at is null
  where ${runningOn("a", to)}
`;

const streetSubscriptionRow = (to: string) => sql`
  'agreement'::text as kind, x.agreement_id::text as id,
  concat((select pl.name from public.agreement_plan pl where pl.id = x.plan_id), ' for ', ${customerName},
         coalesce(', ' || x.street, '')) as label,
  ${to}::text as on_day, 1::numeric as value`;

/** Street density's records: which plans, and which streets, by which test. See `street_density`. */
const streetDensity = (pick: "numerator" | "denominator" | "excluded" | "unknown"): Records => (_from, to) => pick === "denominator"
  ? sql`
    select 'street'::text as kind, x.street_key as id,
           concat(min(x.street), ', ', min(x.city), ' ', min(x.state), ': ', count(*), case when count(*) = 1 then ' home' else ' homes' end) as label,
           ${to}::text as on_day, 1::numeric as value,
           '/properties/' || min(x.property_id::text) as href
    from (${subscriptionsOnStreets(to)}) as x
    where not x.commercial and x.street_key is not null
    group by x.street_key`
  : sql`
    select ${streetSubscriptionRow(to)},
           ${pick === "unknown" ? sql`coalesce('/properties/' || x.property_id, '/agreements/' || x.agreement_id)` : sql`'/agreements/' || x.agreement_id`} as href
    from (${subscriptionsOnStreets(to)}) as x
    where ${{
      numerator: sql`not x.commercial and x.street_key is not null`,
      excluded: sql`x.commercial`,
      unknown: sql`not x.commercial and x.street_key is null`,
    }[pick]}`;

/** The two counts every one of the four shows beside its number. */
const besidesOf = (records: (pick: "excluded" | "unknown") => Records, what: string): NonNullable<Measure["besides"]> => ({
  excluded: { label: `${what} left out because the customer moved or sold the home`, records: records("excluded") },
  unknown: { label: `${what} counted whose reason was never recorded`, records: records("unknown") },
});

/**
 * FIRST TIME FIX, per completed job: how many of its visits were done, and
 * whether the trade's definition leaves it out. The rule is core's
 * `reporting.firstTimeFixOf`, written here as SQL over a job called `j`, and
 * `kpi-first-time-fix.integration.test.ts` puts the same jobs through both.
 */
const VISITS_DONE = `(
  select count(*) from public.visit v
  where v.job_id = j.id and v.deleted_at is null
    and v.status::text = any(array['${reporting.VISIT_DONE.join("', '")}'])
)`;

/**
 * Planned as several visits no later than the first moment anybody arrived
 * at (or, with no arrival, finished) a visit on it; or held, before it was
 * finished, for a reason this trade's definition leaves out, a part hold
 * counting only once its order went to the supplier and was not cancelled.
 */
const fixLeftOut = (trade: string) => sql`(
  (j.multi_visit_planned_at is not null and j.multi_visit_planned_at <= coalesce((
    select min(coalesce(v.arrived_at, v.completed_at)) from public.visit v
    where v.job_id = j.id and v.deleted_at is null
  ), 'infinity'::timestamptz))
  or exists (
    select 1 from public.job_hold h
    left join public.purchase_order po on po.id = h.purchase_order_id
    where h.job_id = j.id
      and h.reason::text = any(${sql.param([...(reporting.FIRST_TIME_FIX_HOLDS[trade] ?? [])])}::text[])
      and h.placed_at <= j.completed_at
      and (h.reason <> 'part' or (po.id is not null and po.status not in ('draft', 'cancelled')))
  )
)`;

const firstTimeFixes = (pick: "numerator" | "denominator" | "excluded"): Records => (from, to, zone, trade) => sql`
  select ${jobRow("1", zone)}
  from public.job j
  join public.job_type jt on jt.id = j.job_type_id
  where j.deleted_at is null and j.completed_at is not null
    and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
    and jt.revenue_class::text = any(${sql.param(["install", "service", "recurring", "project"])}::text[])
    and ${sql.raw(VISITS_DONE)} >= 1
    and ${{
      numerator: sql`not ${fixLeftOut(trade)} and ${sql.raw(VISITS_DONE)} = 1`,
      denominator: sql`not ${fixLeftOut(trade)}`,
      excluded: sql`${fixLeftOut(trade)}`,
    }[pick]}
`;

/**
 * BUDGETED HOURS, per completed job with a budget whose hours are all in:
 * crew hours (every working punch on the job, each person separately) less the
 * crew hours of change orders approved for it, against the hours budgeted. The
 * rule is core's `reporting.budgetVarianceOf`, and
 * `kpi-budget-hours.integration.test.ts` puts the same jobs through both.
 */
const CREW_HOURS = `((
  select coalesce(sum(te.minutes), 0) from public.timeclock_entry te
  where te.job_id = j.id and te.deleted_at is null and te.ended_at is not null
    and te.kind::text <> all(array['${reporting.NOT_A_DAY_WORKED.join("', '")}'])
)::numeric / 60)`;

const CHANGE_HOURS = `(
  select coalesce(sum(co.crew_hours), 0) from public.project_change_order co
  where co.job_id = j.id and co.status = 'approved' and co.crew_hours is not null
)`;

const budgetedJobs = (value: string): Records => (from, to, zone) => sql`
  select ${jobRow(value, zone)}
  from public.job j
  join public.job_type jt on jt.id = j.job_type_id
  where j.deleted_at is null and j.completed_at is not null
    and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
    and jt.revenue_class::text = any(${sql.param(["install", "service", "recurring", "project"])}::text[])
    and j.budgeted_hours is not null and j.budgeted_hours > 0
    and not exists (
      select 1 from public.timeclock_entry running
      where running.job_id = j.id and running.deleted_at is null and running.ended_at is null
        and running.kind::text <> all(${sql.param([...reporting.NOT_A_DAY_WORKED])}::text[])
    )
    and ${sql.raw(CREW_HOURS)} > 0
`;

/**
 * SUPPLIES AGAINST REVENUE, per completed job. A supply is a `part` line; a
 * PASS THROUGH is one marked billed back at cost that is on an invoice issued
 * and not voided, and it leaves both halves: its cost from the top, what it
 * was billed at (net of discounts, before tax, as the ledger credits revenue)
 * from the bottom. The rule is core's `reporting.supplyCostOf`, and
 * `kpi-supply-cost.integration.test.ts` puts the same jobs through both.
 */
const PASSED_THROUGH = `(jl.billed_back_at is not null and exists (
  select 1 from public.invoice_line il join public.invoice i on i.id = il.invoice_id
  where il.id = jl.invoice_line_id and i.status not in ('draft', 'void')
))`;

const SUPPLY_COST = `(
  select coalesce(sum(jl.quantity * jl.unit_cost), 0) from public.job_line jl
  where jl.job_id = j.id and jl.kind = 'part' and not ${PASSED_THROUGH}
)`;

const PASSED_REVENUE = `(
  select coalesce(sum(il.quantity * il.unit_price - il.discount_amount - il.member_discount_amount), 0)
  from public.job_line jl join public.invoice_line il on il.id = jl.invoice_line_id
  where jl.job_id = j.id and jl.kind = 'part' and ${PASSED_THROUGH}
)`;

/** Completed customer jobs in the window with no supply whose cost is unknown. */
const suppliedJobs = (from: string, to: string, zone: string) => sql`
  from public.job j
  join public.job_type jt on jt.id = j.job_type_id
  where j.deleted_at is null and j.completed_at is not null
    and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
    and jt.revenue_class::text = any(${sql.param(["install", "service", "recurring", "project"])}::text[])
    and not exists (
      select 1 from public.job_line jl
      where jl.job_id = j.id and jl.kind = 'part' and jl.unit_cost is null and not ${sql.raw(PASSED_THROUGH)}
    )
`;

const supplyHalf = (value: string): Records => (from, to, zone) => sql`
  select ${jobRow(value, zone)} ${suppliedJobs(from, to, zone)}
`;

/** Each supply passed through on a counted job: one row, opening on the job. */
const passedThrough: Records = (from, to, zone) => sql`
  select 'job'::text as kind, jl.id::text as id,
         concat('#', j.number, ' ', j.summary, ': ', jl.name, ', billed back at cost') as label,
         to_char(j.completed_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
         1::numeric as value, '/jobs/' || j.id as href
  from public.job_line jl
  join (select j.* ${suppliedJobs(from, to, zone)}) as j on j.id = jl.job_id
  where jl.kind = 'part' and ${sql.raw(PASSED_THROUGH)}
`;

/**
 * APPLICATION RECORDS, per completed visit. A field is CAPTURED when its row
 * on the report holds a value: a number, a yes or no, words that are not only
 * spaces, or one of a chemical application's regulated columns. The rule is
 * core's `reporting.recordCompletenessOf`, and
 * `kpi-record-completeness.integration.test.ts` puts the same visits through
 * both.
 */
const captured = (key: string) => `exists (
  select 1 from public.service_report_field f
  where f.report_id = r.id and f.key = ${key}
    and (f.value_numeric is not null or f.value_boolean is not null
      or nullif(btrim(f.value_text), '') is not null or nullif(btrim(f.product_name), '') is not null
      or nullif(btrim(f.epa_registration_number), '') is not null or f.quantity_applied is not null
      or nullif(btrim(f.applicator_license), '') is not null or nullif(btrim(f.target_pest), '') is not null)
)`;

/** The report was held to at least one regulated field. */
const HELD_TO_REGULATED = `exists (
  select 1 from jsonb_array_elements(coalesce(r.required_fields, '[]'::jsonb)) q where (q->>'regulated')::boolean
)`;

const NO_PRODUCT = `exists (
  select 1 from public.service_report r where r.visit_id = v.id and ${captured(`'${reporting.NO_PRODUCT_REASON}'`)}
)`;
const ANY_REPORT = `exists (select 1 from public.service_report r where r.visit_id = v.id)`;
const ANY_JUDGED = `exists (select 1 from public.service_report r where r.visit_id = v.id and ${HELD_TO_REGULATED})`;
const RECORD_COMPLETE = `exists (
  select 1 from public.service_report r
  where r.visit_id = v.id and ${HELD_TO_REGULATED}
    and not exists (
      select 1 from jsonb_array_elements(r.required_fields) q
      where (q->>'regulated')::boolean and not ${captured("q->>'key'")}
    )
)`;

const applicationRecords = (pick: "numerator" | "denominator" | "excluded" | "unknown"): Records => (from, to, zone) => sql`
  select 'visit'::text as kind, v.id::text as id,
         concat('#', j.number, ' visit ', v.sequence, ', ', j.summary) as label,
         to_char(v.completed_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
         1::numeric as value, '/visits/' || v.id as href
  from public.visit v
  join public.job j on j.id = v.job_id
  join public.job_type jt on jt.id = j.job_type_id
  where v.deleted_at is null and j.deleted_at is null
    and v.status::text = any(${sql.param([...reporting.VISIT_DONE])}::text[])
    and v.completed_at >= ${dayStart(from, zone)} and v.completed_at < ${dayAfter(to, zone)}
    and jt.revenue_class::text = any(${sql.param(["install", "service", "recurring", "project"])}::text[])
    and ${sql.raw({
      numerator: `not ${NO_PRODUCT} and ${RECORD_COMPLETE}`,
      denominator: `not ${NO_PRODUCT} and (not ${ANY_REPORT} or ${ANY_JUDGED})`,
      excluded: NO_PRODUCT,
      unknown: `not ${NO_PRODUCT} and ${ANY_REPORT} and not ${ANY_JUDGED}`,
    }[pick])}
`;

/**
 * THE PANEL THE ELECTRICAL PACK DECLARES, read from the pack rather than typed
 * again here: the service panel's code and name (the register's category is
 * either, in any case) and the ratings its `service_amps` may hold.
 * `kpi-panel-pipeline.integration.test.ts` fails if the pack stops declaring
 * them.
 */
const SERVICE_PANEL = packById("electrical")?.equipmentCategories.find((c) => c.code === "service-panel");
export const PANEL_CATEGORIES = SERVICE_PANEL ? [SERVICE_PANEL.code.toLowerCase(), SERVICE_PANEL.name.toLowerCase()] : [];
export const PANEL_RATINGS: string[] = [
  ...(SERVICE_PANEL?.attributes.find((a) => a.key === "service_amps")?.options ?? []),
];

/**
 * Declared recommendations on a live service panel at a property still on the
 * customer list, declined in the window with a quoted value, which the panel
 * either qualifies for (`in`) or cannot be read for (`unknown`). Core's
 * `reporting.panelQualifies`, written again in SQL over the typed values only:
 * a number is a jsonb number, a yes is a jsonb true, a rating one of the
 * pack's options.
 */
const panelRecommendations = (value: string, pick: "in" | "unknown"): Records => (from, to) => {
  const amps = sql`(jsonb_typeof(e.attributes->'service_amps') = 'string' and e.attributes->>'service_amps' = any(${sql.param(PANEL_RATINGS)}::text[]))`;
  /**
   * Never null: a detail that is missing is not a reason, and a null here
   * would drop the row from both sides of a `not`. A cast happens only inside
   * a `case` that has checked the value is a number, because Postgres does not
   * promise to read an `and` left to right, and "100A" cast to a number fails
   * the whole query rather than the one row.
   */
  const qualifies = sql`(
    coalesce(e.attributes->'known_concern' = 'true'::jsonb, false)
    or (case when jsonb_typeof(e.attributes->'spaces_open') = 'number'
             then (e.attributes->>'spaces_open')::numeric <= 0 else false end)
    or coalesce(jsonb_typeof(e.attributes->'service_amps') = 'string'
                and e.attributes->>'service_amps' = any(${sql.param(PANEL_RATINGS.filter((r) => Number(r) < 100))}::text[]), false)
  )`;
  const untyped = sql`(
    coalesce(jsonb_typeof(e.attributes->'service_amps') <> 'null' and not ${amps}, false)
    or coalesce(jsonb_typeof(e.attributes->'spaces_open') not in ('number', 'null'), false)
    or coalesce(jsonb_typeof(e.attributes->'known_concern') not in ('boolean', 'null'), false)
  )`;
  return sql`
    select 'deficiency'::text as kind, d.id::text as id,
           concat(coalesce(e.tag || ' ', ''), e.category, ': ', d.description) as label,
           d.declined_on::text as on_day,
           (${sql.raw(value)})::numeric as value,
           '/equipment/' || e.id as href
    from public.deficiency d
    join public.equipment e on e.id = d.equipment_id
    where d.deleted_at is null and d.declined_on is not null
      and d.declined_on >= ${from}::date and d.declined_on <= ${to}::date
      and d.quoted_amount is not null
      and e.deleted_at is null and e.active = true
      and lower(btrim(e.category)) = any(${sql.param(PANEL_CATEGORIES)}::text[])
      and exists (
        select 1 from public.customer_property cp join public.customer c on c.id = cp.customer_id
        where cp.property_id = e.property_id and cp.ended_on is null and c.deleted_at is null
      )
      and ${pick === "in" ? qualifies : sql`not ${qualifies} and ${untyped}`}
  `;
};

/**
 * PERMITTED JOBS BY HOW THEIR INSPECTIONS WENT. Core's `inspectionPass`,
 * written as SQL: each job with an authority's inspection recorded on it
 * (`permit_inspection`, M23), ONCE, dated by its first inspection, with a
 * verdict over every inspection recorded on it by now. `failed` when one
 * failed for our work, `excluded` when one failed only for something outside
 * it, `passed` otherwise. One row per job, which opens on the job.
 */
const permittedJobs = (verdicts: readonly string[]): Records => (from, to) => sql`
  with jobs as (
    select pi.job_id, min(pi.inspected_on) as first_on,
           case when bool_or(pi.result = 'failed' and pi.failure_scope = 'our_work') then 'failed'
                when bool_or(pi.result = 'failed') then 'excluded'
                else 'passed' end as verdict
    from public.permit_inspection pi
    group by pi.job_id
  )
  select 'job'::text as kind, j.id::text as id, concat('#', j.number, ' ', j.summary) as label,
         x.first_on::text as on_day, 1::numeric as value, '/jobs/' || j.id as href
  from jobs x
  join public.job j on j.id = x.job_id
  where j.deleted_at is null
    and x.first_on >= ${from}::date and x.first_on <= ${to}::date
    and x.verdict = any(${sql.param([...verdicts])}::text[])
`;

/**
 * A PERSON'S ROUTE DAYS (`route_day`), summed by the worker from the phone's
 * positions before they are deleted: core's `routeDay`, the drives from each
 * stop's completion to the next stop's arrival, so the way out and the way
 * home are never in it. `value` is what the row adds: its stops, its miles,
 * or one. Each row is a person's day, and opens on that week's timesheets.
 */
const routeDays = (status: "counted" | "gap", value: "stops" | "miles" | "one"): Records => (from, to) => sql`
  select 'route_day'::text as kind, rd.id::text as id,
         concat(t.display_name, ', ', to_char(rd.day, 'Mon FMDD'), ': ', rd.stops, ' stops',
                ${status === "counted" ? sql`', ', rd.miles, ' miles between them'` : sql`', not counted: ', rd.note`}) as label,
         rd.day::text as on_day,
         ${value === "stops" ? sql`rd.stops::numeric` : value === "miles" ? sql`rd.miles::numeric` : sql`1::numeric`} as value,
         '/timesheets?week=' || rd.day::text as href
  from public.route_day rd
  join public.technician t on t.id = rd.technician_id
  where rd.status = ${status}
    and rd.day >= ${from}::date and rd.day <= ${to}::date
`;

/* ------------------------------------------------------------- the entries */

export const CATALOGUE: Record<string, Entry> = {

  /* ---------------------------------------------------------- computed */

  avg_ticket: {
    state: "computed",
    format: "money",
    measure: {
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
      numerator: {
        label: "revenue on completed jobs",
        records: (from, to, zone) => sql`
          select ${jobRow(REVENUE_ON_JOB, zone)}
          from public.job j
          where j.deleted_at is null and j.completed_at is not null
            and j.is_warranty = false
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
            and ${sql.raw(REVENUE_ON_JOB)} <> 0
        `,
      },
      denominator: {
        label: "completed jobs",
        records: (from, to, zone) => sql`
          select ${jobRow("1", zone)}
          from public.job j
          where j.deleted_at is null and j.completed_at is not null
            and j.is_warranty = false
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
            and ${sql.raw(REVENUE_ON_JOB)} <> 0
        `,
      },
    },
  },

  close_rate: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Counts an estimate as presented only once per job, so a three option
       * proposal is one presentation and not three."
       *
       * Counted as DISTINCT JOBS rather than as estimates, which is what that
       * sentence asks for and is the whole difference between a close rate of
       * forty five per cent and one of fifteen. An estimate with no job is
       * counted on its own id, because a quote to somebody who never became a
       * job is exactly the kind of loss this measures. One row per
       * presentation, which opens on the job, or on the estimate when there is
       * no job.
       */
      numerator: { label: "jobs with an approved estimate", records: presentations(["approved", "converted"]) },
      denominator: {
        label: "jobs an estimate was presented on",
        records: presentations(["sent", "viewed", "approved", "declined", "expired", "converted"]),
      },
    },
  },

  callback_rate: {
    state: "computed",
    format: "percent",
    measure: {
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
      numerator: {
        label: "warranty returns inside thirty days",
        records: (from, to, zone) => sql`
          select ${jobRow("1", zone)}
          from public.job j
          join public.job parent on parent.id = j.parent_job_id
          where j.deleted_at is null and j.completed_at is not null
            and j.is_warranty = true
            and parent.completed_at is not null
            and j.completed_at <= parent.completed_at + interval '30 days'
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
        `,
      },
      denominator: { label: "completed jobs", records: completed(["install", "service", "recurring", "project"]) },
    },
  },

  revenue_per_tech: {
    state: "computed",
    format: "money",
    measure: {
      numerator: { label: "revenue on completed jobs", records: revenueOf(["install", "service", "recurring", "project"]) },
      denominator: { label: "technician days on the clock", records: technicianDays() },
    },
  },

  drive_time_pct: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Drive minutes between stops divided by total clocked minutes.
       * EXCLUDES the drive from home or office to the first stop and from the
       * last stop home, which is commute and not route inefficiency."
       *
       * This was listed as needing a travel entry that says it is the commute
       * leg. It does not need one, because the definition says WHERE the
       * commute leg is: before the first stop of a person's day and after the
       * last. A drive is between stops when the same person has a stop
       * (`on_site` time) that ended before it started and another that started
       * after it ended, on the same day in the COMPANY's calendar; a drive with
       * no stop before it is the way out, and one with no stop after it is the
       * way home. Both are left out, exactly as defined, and a midday run back
       * to the shop for a part sits between two stops and counts, which is the
       * route inefficiency the number exists to show.
       *
       * The denominator is the working day on the clock: travel, on site, shop
       * and paid breaks. Leave, standby and unpaid breaks are not the day the
       * share is of.
       *
       * ONLY DAYS THAT RECORD BOTH A STOP AND A DRIVE COUNT, in both halves. A
       * company whose people do not clock their driving would otherwise read
       * nought per cent drive time, which is the most flattering possible
       * misreading of "we did not record it"; a day with no stop has no route
       * to be inefficient about. Those days are absent rather than zero, and a
       * month with none reads "not this window".
       */
      numerator: {
        label: "minutes driving between stops",
        records: (from, to, zone) => sql`
          with entries as (
            select te.*, (te.started_at at time zone ${zone})::date as day
            from public.timeclock_entry te
            where te.deleted_at is null
              and te.started_at >= ((${from}::date)::timestamp at time zone ${zone})
              and te.started_at < ((${to}::date + 1)::timestamp at time zone ${zone})
          )
          select 'time'::text as kind, d.id::text as id,
                 concat(t.display_name, ', driving between stops') as label,
                 to_char(d.day, 'YYYY-MM-DD') as on_day,
                 coalesce(d.minutes, 0)::numeric as value,
                 '/timesheets?week=' || to_char(d.day, 'YYYY-MM-DD') as href
          from entries d
          join public.technician t on t.id = d.technician_id
          where d.kind = 'travel' and d.ended_at is not null
            and exists (select 1 from entries s where s.technician_id = d.technician_id and s.day = d.day
                          and s.kind = 'on_site' and s.ended_at is not null and s.ended_at <= d.started_at)
            and exists (select 1 from entries s where s.technician_id = d.technician_id and s.day = d.day
                          and s.kind = 'on_site' and s.started_at >= d.ended_at)
        `,
      },
      denominator: {
        label: "minutes on the clock on days with a stop and a drive",
        records: (from, to, zone) => sql`
          with entries as (
            select te.*, (te.started_at at time zone ${zone})::date as day
            from public.timeclock_entry te
            where te.deleted_at is null
              and te.started_at >= ((${from}::date)::timestamp at time zone ${zone})
              and te.started_at < ((${to}::date + 1)::timestamp at time zone ${zone})
          )
          select 'time'::text as kind, e.id::text as id,
                 concat(t.display_name, ', ', replace(e.kind::text, '_', ' ')) as label,
                 to_char(e.day, 'YYYY-MM-DD') as on_day,
                 coalesce(e.minutes, 0)::numeric as value,
                 '/timesheets?week=' || to_char(e.day, 'YYYY-MM-DD') as href
          from entries e
          join public.technician t on t.id = e.technician_id
          where e.kind in ('travel', 'on_site', 'shop', 'paid_break')
            and e.ended_at is not null
            and exists (select 1 from entries s where s.technician_id = e.technician_id and s.day = e.day and s.kind = 'on_site')
            and exists (select 1 from entries s where s.technician_id = e.technician_id and s.day = e.day and s.kind = 'travel')
        `,
      },
    },
  },

  maint_attach: {
    state: "computed",
    format: "percent",
    measure: {
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
      numerator: { label: "plans sold", records: plansSold() },
      denominator: { label: "service calls to customers with no plan", records: callsToNonMembers(["service"]) },
    },
  },

  program_attach: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * The pest control wording of `maint_attach`: "Recurring programs sold
       * divided by completed one off and initial services to customers not
       * already on a program." Same arithmetic, and the denominator takes
       * `project` as well as `service`, because an initial service and a one off
       * treatment are both the call where the programme gets sold.
       */
      numerator: { label: "programmes sold", records: plansSold() },
      denominator: {
        label: "one off and initial services to customers not on a programme",
        records: callsToNonMembers(["service", "project"]),
      },
    },
  },

  install_gross_margin: {
    state: "computed",
    format: "percent",
    /**
     * A margin is what work cost, so reading one takes what reading a job's
     * margin takes: the job costing permission and the financial reports.
     */
    permissions: ["job.cost:read", "report.financial:read"],
    measure: {
      /**
       * "Install revenue less material, subcontract, disposal and crew
       * burdened labour, divided by install revenue. EXCLUDES maintenance and
       * programme revenue, which carries a different margin and hides a badly
       * estimated patio."
       *
       * Revenue is the ledger's, on completed jobs of the `install` class and
       * no other, which is the exclusion. The costs are the job costing ones,
       * from the same SQL a job's own statement reads (`JOB_COSTING_SQL`), so
       * this cannot disagree with it: material is the job's lines of every
       * kind but labour (subcontract and disposal among them) plus the cost of
       * goods sold posted to the job, a journalled subcontractor's bill or
       * disposal receipt included; labour is hours at the loaded rate frozen
       * on each punch; and the burden is payroll taxes, benefits and workers'
       * compensation at the company's own rates, which makes it crew BURDENED
       * labour. Card fees and overhead are not in the definition and are not
       * here: this is not the job's fully loaded margin.
       *
       * WHAT IT NEEDED, and what changed: a place to put a subcontractor's bill
       * or a tip receipt against a job, which an office did not have. A journal
       * line can now name a job (M14), and job costing reads it.
       *
       * ONLY INSTALLS WHOSE COSTS ARE ALL IN, left out of BOTH halves
       * otherwise. A job nobody clocked time against has a labour cost of zero
       * because nobody measured it, an hour with no wage scale costs nothing, a
       * line with no cost is unknown rather than free, and work nobody has
       * billed or excused may have revenue still to come. Counted, every one of
       * those reads as a better margin than the job earned, and the installs
       * where it is most likely are the ones an owner is checking. Left out, the
       * figure is over fewer jobs, and says which: the records behind each half
       * are exactly the jobs counted. An install that used a subcontractor
       * nobody has booked yet still reads high, because the datum is a thing a
       * person has to enter; the number is only as complete as the books.
       *
       * Every completed install counts, a warranty return included: its cost
       * is the cost of the install and it earned nothing against it.
       */
      numerator: {
        label: "dollars earned on installs whose costs are all in",
        money: true,
        records: costedInstalls(
          `${JOB_COSTING_SQL.revenue} - ${JOB_COSTING_SQL.materialCost} - ${JOB_COSTING_SQL.labourCost} - ${JOB_COSTING_SQL.labourBurden}`,
        ),
      },
      denominator: {
        label: "install revenue on those jobs",
        money: true,
        records: costedInstalls(JOB_COSTING_SQL.revenue),
      },
    },
  },

  revenue_per_stop: {
    state: "computed",
    format: "money",
    measure: {
      /**
       * "Program revenue is recognised per service, not per billing month",
       * which is what reading the ledger gives: `postAgreementRecognition`
       * moves a slice across when a visit is delivered, so revenue on a
       * recurring job is what that visit earned rather than a twelfth of the
       * plan.
       */
      numerator: { label: "revenue on recurring stops", records: revenueOf(["recurring"]) },
      denominator: { label: "completed recurring stops", records: completed(["recurring"]) },
    },
  },

  stops_per_day: {
    state: "computed",
    format: "number",
    measure: {
      /**
       * "EXCLUDES deep cleans, move outs and post construction, which are all
       * day jobs and would pull the recurring route average down to nothing."
       *
       * Implemented, and this is the KPI the `revenue_class` column was most
       * obviously needed for: all three of those are `project` in the cleaning
       * pack, and the route stops are `recurring`.
       */
      numerator: { label: "completed recurring stops", records: completed(["recurring"]) },
      denominator: { label: "technician days on the clock", records: technicianDays() },
    },
  },

  reclean_rate: {
    state: "computed",
    format: "percent",
    measure: {
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
      numerator: {
        label: "zero revenue return visits",
        records: (from, to, zone) => sql`
          select ${jobRow("1", zone)}
          from public.job j
          where j.deleted_at is null and j.completed_at is not null
            and j.parent_job_id is not null
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
            and ${sql.raw(REVENUE_ON_JOB)} = 0
        `,
      },
      denominator: { label: "completed visits", records: completedVisits() },
    },
  },

  reapplication_rate: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Zero revenue service calls inside a programme divided by programme
       * applications completed. EXCLUDES calls where the customer asked for an
       * unrelated extra."
       *
       * The exclusion rides on the same thing as the numerator: a call for an
       * unrelated extra is billed, so it has revenue and is already out.
       */
      numerator: {
        label: "zero revenue calls inside a programme",
        records: (from, to, zone) => sql`
          select ${jobRow("1", zone)}
          from public.job j
          join public.job_type jt on jt.id = j.job_type_id
          where j.deleted_at is null and j.completed_at is not null
            and jt.revenue_class = 'recurring'
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
            and ${sql.raw(REVENUE_ON_JOB)} = 0
        `,
      },
      denominator: { label: "programme applications completed", records: completed(["recurring"]) },
    },
  },

  recurring_retention: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Recurring accounts still active at the end of the period divided by
       * accounts active at the start. EXCLUDES customers who moved out of the
       * service area or sold the home, and EXCLUDES one time cleans entirely."
       *
       * An account is a customer on a plan, so a one time clean is never in
       * it. Active at the start is a plan running on the window's first day,
       * and still active is one running on its last, either plan if they hold
       * two. A customer lost because the home was left (a cancellation coded
       * moved or sold, or their link to the address ended) is out of both
       * halves and counted beside the figure. One lost to a cancellation made
       * before reasons were coded is counted as lost, and how many of those
       * there are is said beside it.
       */
      numerator: { label: "accounts on a plan at the start still on one at the end", records: retained("numerator") },
      denominator: { label: "accounts on a plan at the start", records: retained("denominator") },
      besides: besidesOf((pick) => retained(pick), "Accounts"),
    },
  },

  renewal_rate: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Programs renewed divided by programs reaching the end of a term in
       * the period. EXCLUDES customers who moved or sold the property, since
       * those are not a service failure, but count them separately so the
       * exclusion cannot be abused."
       *
       * A term reaches its end on its end date (`agreement_term`, or the
       * agreement's own end for a term never written down), by today, on an
       * agreement not cancelled before it: one cancelled half way through
       * never reached a renewal decision. Renewed is the agreement going on
       * to a later term. A term not renewed because the home was left is out
       * of both halves, and counted separately beside the figure, as the
       * definition asks.
       */
      numerator: { label: "terms renewed", records: renewed("numerator") },
      denominator: { label: "terms that reached their end", records: renewed("denominator") },
      besides: besidesOf((pick) => renewed(pick), "Terms"),
    },
  },

  programme_renewal: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Turf and maintenance agreements renewed for the next season divided
       * by agreements eligible to renew. EXCLUDES properties that sold or
       * where the customer moved."
       *
       * The same records as `renewal_rate`: eligible to renew is a term that
       * reached its end in the window on an agreement still running up to
       * it, and renewed is the agreement going on to the next season's term.
       * A sale or a move is out of both halves and counted beside the figure,
       * which in a spring with a lot of house moves is the number that says
       * why the rate held up.
       */
      numerator: { label: "programmes renewed for the next season", records: renewed("numerator") },
      denominator: { label: "programmes that reached the end of their season", records: renewed("denominator") },
      besides: besidesOf((pick) => renewed(pick), "Programmes"),
    },
  },

  oneoff_to_recurring: {
    state: "computed",
    format: "percent",
    measure: {
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
       * business has. One row per CUSTOMER, on their first one off job in the
       * window, which opens on the customer.
       */
      numerator: {
        label: "one time customers who started a programme inside sixty days",
        records: (from, to, zone) => sql`
          select distinct on (j.customer_id)
                 'customer'::text as kind, j.customer_id::text as id,
                 (select c.name from public.customer c where c.id = j.customer_id) as label,
                 to_char(j.completed_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
                 1::numeric as value, '/customers/' || j.customer_id as href
          from public.job j
          join public.job_type jt on jt.id = j.job_type_id
          where j.deleted_at is null and j.completed_at is not null
            and jt.revenue_class in ('service', 'project')
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
            and exists (
              select 1 from public.agreement a
              where a.customer_id = j.customer_id and a.deleted_at is null
                and a.started_on >= (j.completed_at at time zone ${zone})::date
                and a.started_on <= (j.completed_at at time zone ${zone})::date + 60
            )
          order by j.customer_id, j.completed_at
        `,
      },
      denominator: {
        label: "one time customers served",
        records: (from, to, zone) => sql`
          select distinct on (j.customer_id)
                 'customer'::text as kind, j.customer_id::text as id,
                 (select c.name from public.customer c where c.id = j.customer_id) as label,
                 to_char(j.completed_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
                 1::numeric as value, '/customers/' || j.customer_id as href
          from public.job j
          join public.job_type jt on jt.id = j.job_type_id
          where j.deleted_at is null and j.completed_at is not null
            and jt.revenue_class in ('service', 'project')
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
          order by j.customer_id, j.completed_at
        `,
      },
    },
  },

  revenue_per_crew_day: {
    state: "computed",
    format: "money",
    measure: {
      /**
       * "Invoiced revenue divided by crew days worked, taken from crew clock in
       * and out rather than from the roster. EXCLUDES yard time, shop days and
       * rain days where no stop was completed."
       *
       * The denominator is `crewDays`: one per crew per day, from what the
       * crew's members punched on the crew's own visits, on a day the crew
       * completed a stop. It used to be impossible because a day could only be
       * inferred from who was assigned together, which counts a four person
       * crew as four days and reports a quarter of the real figure.
       *
       * The numerator is the ledger's revenue on completed jobs a crew worked
       * (one with a completed visit sent to a crew), because a crew day is
       * divided into the revenue of crew work: a technician's service call on
       * the same books is not what a crew's day earned. Each half is dated by
       * its own record, the job by its completion and the day by the clock, so
       * a job that ran across a month end puts its revenue in one and some of
       * its days in the other, as revenue per technician does.
       */
      numerator: {
        label: "revenue on completed jobs a crew worked",
        records: (from, to, zone) => sql`
          select ${jobRow(REVENUE_ON_JOB, zone)}
          from public.job j
          join public.job_type jt on jt.id = j.job_type_id
          where j.deleted_at is null and j.completed_at is not null
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
            and jt.revenue_class::text = any(${sql.param(["install", "service", "recurring", "project"])}::text[])
            and exists (
              select 1 from public.visit v
              where v.job_id = j.id and v.deleted_at is null and v.crew_id is not null and v.status = 'completed'
            )
        `,
      },
      denominator: { label: "crew days on the clock", records: crewDays() },
    },
  },

  revenue_per_cleaner_hour: {
    state: "computed",
    format: "money",
    measure: {
      /**
       * "Invoiced revenue divided by paid cleaner hours, counting every person on
       * a team separately. EXCLUDES office and administrative hours, and EXCLUDES
       * travel."
       *
       * Every exclusion is a `kind` on the timeclock entry: `shop` is the office
       * and administrative half, `travel` is travel. "Every person separately" is
       * what summing minutes per entry already does. One row per entry, adding
       * its hours.
       */
      numerator: { label: "revenue on completed jobs", records: revenueOf(["install", "service", "recurring", "project"]) },
      denominator: {
        label: "paid hours on site and travelling",
        records: (from, to, zone) => sql`
          select 'time'::text as kind, te.id::text as id,
                 concat(t.display_name, ', ', replace(te.kind::text, '_', ' ')) as label,
                 to_char(te.started_at at time zone ${zone}, 'YYYY-MM-DD') as on_day,
                 (coalesce(te.minutes, 0)::numeric / 60) as value,
                 '/timesheets?week=' || to_char(te.started_at at time zone ${zone}, 'YYYY-MM-DD') as href
          from public.timeclock_entry te
          join public.technician t on t.id = te.technician_id
          where te.deleted_at is null
            and te.kind in ('on_site', 'paid_break')
            and te.started_at >= ${dayStart(from, zone)} and te.started_at < ${dayAfter(to, zone)}
        `,
      },
    },
  },

  first_time_fix: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Jobs completed in one visit divided by all completed jobs, EXCLUDING
       * jobs planned as multi visit" (HVAC), "and jobs held for a part order"
       * (plumbing), "or an inspection" (electrical). "Including planned return
       * visits makes this meaningless."
       *
       * WHAT IT NEEDED, and what changed: a job that says it was PLANNED as
       * several visits, and a hold that says why. A job can now be marked
       * planned for more than one visit (`job.multi_visit_planned_at`), when it
       * is booked or before any visit on it has started, and a hold has a
       * reason from a fixed list with a part hold naming the purchase order the
       * part is on (`job_hold`, M10 and M16).
       *
       * A visit counts when it was done: completed, or completed on a phone that
       * missed its cancellation. A completed job none of whose visits was done
       * (finished from the office, brought in from history) has no visit count
       * to judge and is out of both halves. The jobs left out by the
       * definition are counted beside the number, so the exclusion is visible
       * rather than a way to tidy the figure:
       *
       *   a plan counts only when it was written no later than the first
       *   arrival on the job, so a job that went badly cannot be relabelled;
       *   a hold counts only when it was placed before the job was finished,
       *   for a reason this trade leaves out (`reporting.FIRST_TIME_FIX_HOLDS`),
       *   and a part hold only once its order went to the supplier and was not
       *   cancelled: a draft order is a part nobody has ordered.
       *
       * Customer work only, every class but `internal`, as the callback rate
       * counts it.
       */
      numerator: { label: "completed jobs done in one visit", records: firstTimeFixes("numerator") },
      denominator: { label: "completed jobs, other than those left out", records: firstTimeFixes("denominator") },
      besides: {
        excluded: {
          label: "jobs left out: planned as more than one visit, or held for a reason the definition excludes",
          records: firstTimeFixes("excluded"),
        },
      },
    },
  },

  inspection_pass: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Permitted jobs signed off on the first inspection divided by all
       * permitted jobs inspected, EXCLUDING jobs failed for something outside
       * the electrical scope. Counting those hides whether the crews are the
       * problem."
       *
       * WHAT IT NEEDED: the authority's visits to a permitted job, and whose
       * work a fail was about. M33's `inspection` is the contractor's own
       * statutory inspection of a property and could not hold the city
       * signing off a panel change. `permit_inspection` does: the day, the
       * stage, pass or fail, and on a fail the inspector's words and whose
       * work it was, chosen from two and required, never read from the words.
       *
       * A PERMITTED JOB is one with a permit filed against it (a compliance
       * document of kind `permit`) and an inspection recorded under it. It is
       * counted ONCE, in the window of its FIRST inspection, and judged on
       * every inspection recorded on it since: a job is signed off first time
       * only when none failed for our work, the strict reading, so a rough in
       * that passed and a final that failed is not. One failed only for
       * somebody else's work (another trade, a site not ready) is out of both
       * halves and counted beside the figure, so the exclusion cannot quietly
       * grow. A failure recorded next month on a job first inspected this
       * month counts against this month, where the job is.
       */
      numerator: { label: "permitted jobs signed off with no fail for our work", records: permittedJobs(["passed"]) },
      denominator: { label: "permitted jobs inspected", records: permittedJobs(["passed", "failed"]) },
      besides: {
        excluded: {
          label: "Jobs left out because an inspector failed them only for something outside our work",
          records: permittedJobs(["excluded"]),
        },
      },
    },
  },

  budget_hour_variance: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Actual crew hours minus budgeted hours on completed jobs, as a
       * percentage of budgeted. EXCLUDES change order hours that were
       * separately approved, or every approved upsell reads as an overrun."
       *
       * WHAT IT NEEDED, and what changed: budgeted hours on the job, and hours
       * on a change order. A job now carries the crew hours it was budgeted
       * (`job.budgeted_hours`), fixed once the first hour is punched on it, and
       * a change order carries the crew hours it adds and the project job they
       * are worked on (`project_change_order.crew_hours`, `job_id`). When the
       * customer approves it, those hours come off the job's actual hours.
       *
       * Actual crew hours are every working punch on the job, each person
       * separately: on site and travelling to it, never leave or an unpaid
       * break. A job is LEFT OUT OF BOTH HALVES when it has no budget, a punch
       * still running, or no hours at all, because a job nobody clocked would
       * read as entirely under budget. Each half is the jobs counted, the first
       * adding its hours over budget (negative under), the second its budget.
       */
      numerator: { label: "crew hours over budget, less approved change order hours", records: budgetedJobs(`${CREW_HOURS} - ${CHANGE_HOURS} - j.budgeted_hours`) },
      denominator: { label: "crew hours budgeted on completed jobs", records: budgetedJobs("j.budgeted_hours") },
    },
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
      + "the notice window and EXCLUDES visits the company cancelled itself. A "
      + "customer cancelling from their portal link is now recorded "
      + "(`visit_change_request`, with when they asked), but a customer who rings "
      + "and asks the office to cancel is recorded exactly like the company "
      + "cancelling for rain: `visit.status` says cancelled and nothing says by "
      + "whom, nor when: a visit keeps no time it was cancelled (only a job "
      + "does). Counting only the portal's half would undercount, and counting "
      + "every cancellation would read a week of rain as customers leaving. "
      + "Recording it means every path that cancels a visit (the office, a job "
      + "cancelled with its visits, a portal request, a plan's skipped visit) "
      + "saying who asked and when, which none of them does yet.",
  },

  chemical_cost_per_stop: {
    state: "needs",
    format: "money",
    needs:
      "A product application tied to the product register. Service reports "
      + "record what was applied (`service_report_field.product_name`, quantity "
      + "and unit, the EPA number) but by name rather than as a price book item, "
      + "so nothing values it, and the definition values product from the "
      + "register and EXCLUDES devices, bait stations and monitors, which are "
      + "capital. Valuing it from what was issued to a truck instead would make "
      + "this a purchasing number rather than a cost per stop.",
  },

  supply_cost_pct: {
    state: "computed",
    format: "percent",
    /** What supplies cost is what jobs cost, so it takes what a job's margin takes. */
    permissions: ["job.cost:read", "report.financial:read"],
    measure: {
      /**
       * "Chemical, consumable and equipment consumable cost divided by
       * invoiced revenue. EXCLUDES supplies stocked for a commercial account
       * and billed back at cost, which are a pass through and not a margin
       * leak."
       *
       * WHAT IT NEEDED, and what changed: a flag for supplies billed back. A
       * supply used on a job (a `part` line, which is what a chemical, a
       * consumable and an equipment consumable are; equipment fitted is
       * capital and labour is hours) can now be marked billed back to the
       * customer at cost (`job_line.billed_back_at`, M10).
       *
       * Revenue is the ledger's, on completed customer jobs, as every revenue
       * figure here is. A supply marked billed back that is on an issued
       * invoice leaves BOTH halves, its cost and what it was billed at; one
       * marked and not billed yet counts as a cost, because nothing has come
       * back for it. A job with a supply whose cost nobody recorded is left
       * out of both halves, rather than read as free. The supplies passed
       * through are counted beside the number.
       */
      numerator: { label: "dollars of supplies used", money: true, records: supplyHalf(SUPPLY_COST) },
      denominator: { label: "revenue on those jobs, less supplies billed back at cost", money: true, records: supplyHalf(`${REVENUE_ON_JOB} - ${PASSED_REVENUE}`) },
      besides: {
        excluded: { label: "supplies billed back at cost, left out of both halves", records: passedThrough },
      },
    },
  },

  record_completeness: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Completed visits where every regulated field required by the
       * operator's configuration was captured, divided by completed visits.
       * EXCLUDES visits recorded with a no product applied reason, which have
       * their own required set."
       *
       * WHAT IT NEEDED, and what changed: which regulated fields the operator
       * required WHEN the visit was recorded. A report now keeps that list,
       * frozen from its template when it is written
       * (`service_report.required_fields`, each field with whether a regulator
       * asks for it), so a template edited today does not judge last spring's
       * visits. The operator sets what is required on Settings, Service
       * reports, and an edit keeps which fields are regulated, which it used to
       * drop.
       *
       * A completed visit with no report at all is not complete: it is the
       * most incomplete record there is. A visit whose reports were held to no
       * regulated field (written before the list was kept, or the operator
       * required none) is left out of both halves and counted beside as not
       * known, rather than read as complete for having been asked nothing. A
       * visit recorded with a no product applied reason is left out and counted
       * beside, as the definition says.
       */
      numerator: { label: "completed visits with every required regulated field captured", records: applicationRecords("numerator") },
      denominator: { label: "completed visits, other than those left out", records: applicationRecords("denominator") },
      besides: {
        excluded: { label: "visits with no product applied, left out", records: applicationRecords("excluded") },
        unknown: { label: "visits whose report was held to no regulated field, left out", records: applicationRecords("unknown") },
      },
    },
  },

  diag_conversion: {
    state: "needs",
    format: "percent",
    needs:
      "Which trade owned the fault. The same visit half is now measurable (an "
      + "estimate's signature has a time and the visit has its arrival and "
      + "completion), but the definition EXCLUDES calls where the fault was in "
      + "equipment another trade owns, 'which the electrician was never going to "
      + "close', and nothing on a job or a visit records that. Those calls are a "
      + "large share of troubleshooting, so the number would read low for a "
      + "reason the technicians do not control. Nor does the electrical pack mark "
      + "which of its job types is a troubleshooting call: `revenue_class` puts "
      + "it among all `service` work.",
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
      "Whether the customer has already booked the replacement with somebody "
      + "else. Both halves are now recorded: an inspection names the unit it "
      + "looked at, `installed_on` gives the age, and the register records a "
      + "replacement as a move with that reason. The definition EXCLUDES units "
      + "the customer has already scheduled with someone else, 'so the ones "
      + "nobody followed up on stay visible', and a declined recommendation "
      + "records why in free text (`deficiency.decline_reason`), so those units "
      + "cannot be told apart without reading words for a reason, which this "
      + "catalogue never does.",
  },

  backflow_recert: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Assemblies retested within the period divided by assemblies whose
       * last test is a year or more old. Excludes assemblies recorded as
       * removed or abandoned, which otherwise sit in the denominator forever."
       *
       * This needed a typed last test date on the assembly, and M33 gave it
       * one: a backflow test is an inspection whose checkpoints are about a
       * `backflow-assembly` and whose answers name the unit they were taken
       * on, on a real `performed_on` date. A date typed into the unit's
       * untyped attributes is still not read, because nothing validates it.
       *
       * A TEST is an inspection with a result: pass, pass with deficiencies or
       * fail. A failed test is still a test (the retest happened and found a
       * fault); "not tested", "not accessible" and "partial" are a visit, not
       * a retest.
       *
       * DUE means the assembly's last test BEFORE the window is a year or more
       * old by the window's last day, so a month's figure counts the
       * assemblies that came due in it as well as the ones already overdue.
       * An assembly never tested here has no last test and is not in either
       * half: the definition counts assemblies whose last test is old, and a
       * register imported without its test history would otherwise read as a
       * fleet nobody has ever retested.
       *
       * REMOVED OR ABANDONED is an assembly taken off the register (retired,
       * replaced or removed, which all mark it inactive) and it is out of both
       * halves.
       */
      numerator: { label: "assemblies retested in the window", records: backflowDue(true) },
      denominator: { label: "assemblies due for a retest", records: backflowDue(false) },
    },
  },

  panel_pipeline: {
    state: "computed",
    format: "money",
    measure: {
      /**
       * "Total value of declined panel and service upgrade recommendations on
       * panels recorded as full, flagged as a known concern, or rated below 100
       * amps, counting only properties still on the customer list."
       *
       * WHAT IT NEEDED, and what changed: typed panel attributes. The pack
       * declares a service panel's rating (one of its options), open spaces (a
       * number) and known concern (yes or no), and the register now holds a
       * unit's details to that declaration (`field.typedAttributes`): the
       * office and the API are refused a value that is not its kind, and the
       * phone's is stored typed when it can be. A recommendation is one
       * recorded against the panel itself, declined, with a quoted value.
       *
       * Full is no open spaces. "Still on the customer list" is a customer,
       * not merged away, whose link to the address has not ended. Like the
       * replacement pipeline it is a total over the recommendations counted,
       * declined in the window. A panel carrying one of the three as words
       * from before the register checked them, and nothing that qualifies it,
       * is counted beside the figure as not known and never in it.
       */
      numerator: { label: "value of declined recommendations on full, problem or under 100 amp panels", records: panelRecommendations("d.quoted_amount", "in") },
      denominator: { label: "declined recommendations counted", records: panelRecommendations("1", "in") },
      besides: {
        unknown: { label: "declined recommendations on panels whose details were never checked, left out", records: panelRecommendations("1", "unknown") },
      },
    },
  },

  replace_pipeline: {
    state: "computed",
    format: "money",
    measure: {
      /**
       * The one pipeline figure that needs no untyped attribute: "Total value of
       * declined replacement recommendations on systems over twelve years old
       * that are still active." Age comes from `equipment.installed_on`, which
       * is a real date column, and the value from `deficiency.quoted_amount`.
       *
       * The denominator is a count rather than a divisor: this is a total, and
       * the count is what makes it checkable. A pipeline of forty thousand over
       * three recommendations is a different conversation from one over sixty.
       * Each recommendation opens on the unit it is about.
       */
      numerator: { label: "value of declined recommendations on units over twelve years old", records: declinedOnOldUnits("d.quoted_amount") },
      denominator: { label: "declined recommendations counted", records: declinedOnOldUnits("1") },
    },
  },

  route_density: {
    state: "computed",
    format: "number",
    measure: {
      /**
       * Pest: "Completed stops divided by driving miles on the route ...
       * EXCLUDES the first leg from the yard and the last leg home." Lawn:
       * "Completed stops divided by route miles driven for the day. EXCLUDES
       * the drive from the yard to the first stop and back from the last."
       *
       * WHAT IT NEEDED: a month of miles between stops, when the positions
       * they come from are deleted after a few days by design. The worker now
       * reads each finished day before the purge and keeps a person's route
       * day (`route_day`): their completed stops, and the miles of the drives
       * from each stop's completion to the next stop's arrival, which is
       * exactly the exclusion, because the way out and the way home are not
       * between two stops. Odometer readings were never it: they are one a
       * vehicle a day and include both legs.
       *
       * PER PERSON. Each person's day counts their own stops over their own
       * miles, so a crew of three in one truck counts its stops three times
       * and its miles three times, and the ratio is the crew's. A stop
       * completed with no arrival time (closed from the office) is not one
       * of the day's stops, and the drive across it is still measured, which
       * reads lower, never higher.
       *
       * ONLY DAYS SEEN WHOLE COUNT, in both halves. A day whose positions
       * have a gap on a drive between stops (the phone off, no signal, no
       * position near one end of a drive) would read a straight line across
       * the gap and a tighter route than was driven, so it is left out and
       * counted beside the figure. A day with fewer than two stops is no
       * route. A company that does not share locations has no route days and
       * reads "not this window".
       */
      numerator: { label: "stops completed on route days seen whole", records: routeDays("counted", "stops") },
      denominator: { label: "miles driven between those stops", records: routeDays("counted", "miles") },
      besides: {
        excluded: {
          label: "Route days left out because the phone's positions have a gap on a drive between stops",
          records: routeDays("gap", "one"),
        },
      },
    },
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
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Subscriptions cancelled in the month divided by active subscriptions
       * at the start of it. Excludes cancellations from a house sale or a
       * move, which are not a service failure and should be tracked
       * separately."
       *
       * Active at the start is a subscription running on the window's first
       * day; cancelled in it is one of those no longer running on its last,
       * cancelled or lapsed. The exclusion is taken off the cancellations
       * only, because the definition's denominator is the plain count at the
       * start, and the ones taken off are counted beside it. One cancelled
       * before reasons were coded counts as churn, and how many did is said
       * beside it.
       */
      numerator: { label: "subscriptions lost, other than to a move or a sale", records: churned("numerator") },
      denominator: { label: "subscriptions active at the start", records: churned("denominator") },
      besides: besidesOf((pick) => churned(pick), "Subscriptions"),
    },
  },

  not_out_rate: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Stops where the bin was not at the curb divided by attempted stops. Every
       * one is a paid drive with no revenue."
       *
       * `visit_asset.outcome` has `no_access`, which is exactly this: the driver
       * arrived and could not do the work. An attempted stop is a visit that was
       * completed or recorded as no access, not a visit that was scheduled, because
       * a round the truck never reached is not a bin that was not out.
       */
      numerator: { label: "stops where the bin was not out", records: binStops(true) },
      denominator: { label: "attempted stops", records: binStops(false) },
    },
  },

  redo_rate: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "Free re-cleans divided by completed stops. Counts only our-fault
       * returns, not bins that were not out."
       *
       * This was listed as needing whose fault a return was, and the product
       * already records it: a job's coverage (M10, "Who is paying, and why")
       * says why it is free. `no_charge_callback` is "rework on our own work,
       * we are back because of something we did", and `our_warranty` is "we
       * stand behind our work, nobody is billed"; both are our fault, and both
       * are counted, which is the reading that reads higher. A bin that was not
       * out and was cleaned free on a second trip is `goodwill` (we chose to
       * absorb it) and is not counted, which is the definition's exclusion. A
       * job counts in the window it was completed.
       *
       * A FREE RETURN NOBODY GAVE A REASON FOR (a job back for a previous one,
       * no revenue, no coverage recorded) is not counted, because nothing says
       * it was our fault, and it is not hidden either: how many there are is
       * said beside the figure and opens on the jobs, so the office can say
       * which they were. The denominator is the window's completed visits, a
       * return's own visit among them.
       */
      numerator: {
        label: "free returns for our own work",
        records: (from, to, zone) => sql`
          select ${jobRow("1", zone)}
          from public.job j
          where j.deleted_at is null and j.completed_at is not null
            and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
            and exists (
              select 1 from public.entitlement en
              where en.job_id = j.id and en.source in ('no_charge_callback', 'our_warranty')
            )
        `,
      },
      denominator: { label: "completed stops", records: completedVisits() },
      besides: {
        unknown: {
          label: "Free return visits not counted because nobody said whose fault they were",
          records: (from, to, zone) => sql`
            select ${jobRow("1", zone)}
            from public.job j
            where j.deleted_at is null and j.completed_at is not null
              and j.parent_job_id is not null
              and j.completed_at >= ${dayStart(from, zone)} and j.completed_at < ${dayAfter(to, zone)}
              and ${sql.raw(REVENUE_ON_JOB)} = 0
              and not exists (select 1 from public.entitlement en where en.job_id = j.id)
          `,
        },
      },
    },
  },

  referral_share: {
    state: "computed",
    format: "percent",
    measure: {
      /**
       * "New subscriptions attributed to a neighbour referral divided by all new
       * subscriptions."
       *
       * Attribution comes from `customer.lead_source`, which holds a key from
       * core's lead source catalogue. A neighbour sending somebody is
       * `referral_customer`; `referral_trade` is a builder or a realtor, which
       * is a partnership rather than a neighbour and is left out. This used
       * to filter on 'referral', 'customer_referral' and 'neighbour_referral',
       * none of which the catalogue has ever had, so it read nought per cent
       * for every company that recorded referrals correctly. A first agreement
       * (`renewal_count = 0`) is the subscription starting.
       */
      numerator: {
        label: "new subscriptions from a referral",
        records: (from, to) => sql`
          select ${sql.raw(agreementRow)}
          from public.agreement a
          join public.customer c on c.id = a.customer_id
          where a.deleted_at is null and a.renewal_count = 0
            and a.started_on >= ${from}::date and a.started_on <= ${to}::date
            and c.lead_source = 'referral_customer'
        `,
      },
      denominator: { label: "new subscriptions", records: plansSold() },
    },
  },

  street_density: {
    state: "computed",
    format: "number",
    measure: {
      /**
       * "Active subscriptions divided by the number of distinct streets on the
       * route. ... Excludes commercial stops, which have their own economics."
       *
       * WHAT IT NEEDED: a street rather than an address line. `address_line1`
       * is the whole line, and "12 Oak Street" and "14 Oak St" are one street
       * and two strings, so splitting the line would count twice the streets
       * and report half the density. A property now keeps its street apart
       * (M03): the geocoder's own street component where it gives one, or
       * typed or picked from the streets already in the town by a person, and
       * never read out of the line.
       *
       * Active is running on the window's last day, as churn reads it. A
       * commercial customer's plan leaves both halves and is counted beside. A
       * home whose street is not recorded for its address as it is now (or a
       * plan with no address of its own) is LEFT OUT OF BOTH HALVES and
       * counted beside as not known, opening on the address so the office can
       * record it: counted on top and not underneath it would read as a denser
       * route than the one driven. Two spellings of one street typed by hand
       * count as two streets, which reads lower, never higher.
       */
      numerator: { label: "active subscriptions on a recorded street", records: streetDensity("numerator") },
      denominator: { label: "distinct streets they are on", records: streetDensity("denominator") },
      besides: {
        excluded: { label: "Commercial subscriptions, left out of both halves", records: streetDensity("excluded") },
        unknown: { label: "Subscriptions left out because the street of their address is not recorded", records: streetDensity("unknown") },
      },
    },
  },

  water_per_stop: {
    state: "computed",
    format: "number",
    measure: {
      /**
       * "Fresh water used divided by completed stops, per truck. A truck
       * drifting upward is usually a nozzle or a burner problem, and it shows
       * here before it shows in a complaint."
       *
       * WHAT IT NEEDED: a water reading per truck. Nothing recorded water: the
       * per stop "water used" reading on a report is a guess at one bin, and a
       * meter reading is a counter a machine wears out by. A truck's day now
       * has its fresh water (`truck_water_day`, M22), read off the tank by the
       * driver on the phone or typed by the office, and a truck's stops are the
       * visits completed by whoever had it checked out that day.
       *
       * PER TRUCK. Each record is one truck, its water over its own stops and
       * the truck's own gallons a stop in its words, so the one truck drifting
       * is a line of its own; the number is the trucks' together.
       *
       * ONLY DAYS WITH BOTH COUNT. A truck day with stops and no reading is
       * left out of both halves and counted beside as not read, never as no
       * water; a reading on a day the truck completed no stop is left out and
       * counted beside too.
       */
      numerator: { label: "gallons of fresh water used on truck days with a reading", records: waterPerStop("numerator") },
      denominator: { label: "stops completed on those truck days", records: waterPerStop("denominator") },
      besides: {
        unknown: { label: "Truck days with stops and no water read, left out of both halves", records: waterPerStop("unknown") },
        excluded: { label: "Water read on a day the truck completed no stop, left out of both halves", records: waterPerStop("excluded") },
      },
    },
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
    state: "computed",
    format: "money",
    measure: {
      /**
       * "Rental, overage, disposal and fee revenue attributed to a container
       * divided by the months that container was in the fleet, including
       * months it never left the yard. EXCLUDES taxes and permit amounts passed
       * through at cost, which are not revenue."
       *
       * WHAT IT NEEDED: each container's share of a job's revenue. A hire's
       * invoice now names the haul each of its lines bills (the period, the
       * meters, the charges found, the disposal fee passed on), so a swap chain
       * on one invoice still says which can earned what, and the office names
       * the haul a job's own line bills (a flat priced hire, a trip) on the
       * job's page. Nothing is read from a line's words.
       *
       * Revenue is those lines on invoices issued in the window and not
       * voided, before tax, never a permit. A container's months are its days
       * in the fleet in the window, each a share of its own month, from when it
       * joined the register (or its first hire, if earlier) until it was
       * retired, the yard and the repair shop included. Lines on a container
       * job that name no container are counted beside, not guessed.
       */
      numerator: { label: "invoiced revenue naming a container", records: containerMonths("numerator") },
      denominator: { label: "container months in the fleet", records: containerMonths("denominator") },
      besides: {
        unknown: { label: "Jobs with a container whose invoiced lines name none, left out", records: containerMonths("unknown") },
      },
    },
  },
  disposal_cost_pct: {
    state: "computed",
    format: "percent",
    /** What a facility charged against what a haul earned is what work costs. */
    permissions: ["job.cost:read", "report.financial:read"],
    measure: {
      /**
       * "Tipping and disposal cost taken from scale tickets divided by
       * invoiced revenue on the same hauls. EXCLUDES fuel, driver labour and
       * truck cost, which belong in cost per haul."
       *
       * WHAT IT NEEDED: revenue attributed to the same hauls as the cost. The
       * cost was always on the haul (`rental.disposal_fee`, what the facility
       * billed for the load); the revenue is now the invoice lines naming the
       * haul, as for revenue per container month. A haul counts in the window
       * it was collected (the pickup or swap that took the full can to the
       * facility).
       *
       * A haul with no disposal fee recorded is left out of both halves and
       * counted beside as not known, never read as a free tip; one with a fee
       * and nothing invoiced on it yet is left out and counted beside too,
       * because its cost over nothing would read as a facility several times
       * dearer. Fuel, labour and the truck are not in it.
       */
      numerator: { label: "facility fees on hauls collected and invoiced", records: disposalHauls("numerator"), money: true },
      denominator: { label: "invoiced revenue on those hauls", records: disposalHauls("denominator"), money: true },
      besides: {
        unknown: { label: "Hauls collected with no disposal fee recorded, left out of both halves", records: disposalHauls("unknown") },
        excluded: { label: "Hauls with a disposal fee and nothing invoiced on them yet, left out of both halves", records: disposalHauls("excluded") },
      },
    },
  },
  hauls_per_truck_day: {
    state: "computed",
    format: "number",
    measure: {
      /**
       * "Completed haul events, meaning deliveries, pickups, swaps, dump and
       * returns and relocations, divided by truck days worked taken from the driver
       * timeclock rather than the roster. Dry runs and blocked trips do NOT count as
       * hauls, but track them separately because they consume the same slot."
       *
       * All of it implemented. A DRIVER is a person with a vehicle that has a kind of
       * truck (M22) checked out to them that day, which is what was missing: the
       * timeclock has no truck and no driver flag, and counting every technician's
       * day would include the office. A truck day is such a person's day on the
       * timeclock. A haul counts only when it was completed by a driver on a truck
       * day, and the visits where the truck arrived and the haul did not happen (the
       * customer was not there, the way was blocked) are counted beside the number.
       */
      numerator: { label: "completed hauls by drivers on a truck", records: haulVisits(true) },
      denominator: { label: "truck days on the clock", records: truckDays() },
      besides: {
        excluded: { label: "dry runs and blocked trips, not counted as hauls, that used the same slot", records: haulVisits(false) },
      },
    },
  },
  turnaround_hours: {
    state: "needs",
    format: "duration",
    needs:
      "The moment a container was emptied at the facility. A pickup records the "
      + "scale ticket, which is the weighbridge rather than the tip, and the "
      + "definition measures from emptied to next placement. Using the pickup "
      + "time instead would include the drive and the queue at the gate and "
      + "report a worse figure than the fleet achieves. A haul now names the "
      + "facility it went to, but not the time it was tipped there, and nothing "
      + "records a can held at the customer's request, the other exclusion the "
      + "definition makes.",
  },
};

/** Every key the catalogue accounts for. */
export const KEYS = Object.keys(CATALOGUE);
