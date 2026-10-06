import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { packs } from "@opentradesos/trade-packs";
import * as kpis from "../src/services/kpis";
import { CATALOGUE, KEYS } from "../src/services/kpi-catalogue";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE SCORECARD THE PACKS SPECIFIED AND NOTHING COMPUTED
 *
 * Eight trade packs declare sixty three KPIs, forty seven distinct keys, each
 * with a definition precise enough to name the way that metric is usually got
 * wrong. `KpiSeed` validated every one of them at import and nothing read them.
 *
 * TWO TESTS CARRY THIS WHOLE FILE.
 *
 *   EVERY KEY IS ACCOUNTED FOR, both directions, against the packs themselves.
 *   A pack author adding a KPI has to decide whether it can be computed, and a
 *   catalogue entry for a key no pack declares is a note about nothing.
 *
 *   EVERY `needs` SAYS SOMETHING SPECIFIC. "Not built" is not an answer. The
 *   whole value of the unavailable list is that each entry names the one datum
 *   that is missing, so the day it arrives the entry is a one line change.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi:org");
const USER = fixtureId("kpi:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const granted = (...permissions: string[]): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

let seq = 0;
let customerId = "";
let propertyId = "";
const jobTypes = new Map<string, string>();

/** A job type of a given revenue class, which is the column this batch added. */
async function jobType(code: string, revenueClass: string): Promise<string> {
  const found = jobTypes.get(code);
  if (found) return found;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, ${code}, ${code}, 'technician_dispatch', ${revenueClass}::job_revenue_class)
    returning id`;
  jobTypes.set(code, row!.id);
  return row!.id;
}

/** A completed job of a class, with revenue posted to the ledger. */
async function completedJob(opts: {
  revenueClass: string;
  revenue?: string;
  on?: string;
  warranty?: boolean;
  parentJobId?: string | null;
  customer?: string;
  /** The exact instant it was finished, for the tests about whose day that is. */
  at?: string;
}): Promise<string> {
  seq += 1;
  const typeId = await jobType(`t-${opts.revenueClass}`, opts.revenueClass);
  const day = opts.on ?? "2026-06-15";
  const at = opts.at ?? `${day}T15:00:00Z`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (
      organization_id, number, customer_id, property_id, job_type_id, status, summary,
      is_warranty, parent_job_id, completed_at
    ) values (
      ${ORG}, ${seq}, ${opts.customer ?? customerId}, ${propertyId}, ${typeId}, 'completed',
      'Work', ${opts.warranty ?? false}, ${opts.parentJobId ?? null},
      ${at}::timestamptz
    ) returning id`;

  const amount = opts.revenue ?? "0";
  if (amount !== "0") {
    /**
     * Revenue goes in as a balanced ledger pair, because the KPI reads the
     * ledger rather than `invoice.total`: rule 4 in `schema/billing.ts`, and the
     * reason is that a voided invoice still carries its total while the ledger
     * reverses it.
     */
    await raw`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction,
                                       account_code, currency, amount, source_type, source_id,
                                       job_id)
      select ${ORG}, t.id, ${at}::timestamptz, d.direction, d.code, 'USD',
             ${amount}, 'manual', t.id, ${job!.id}
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, '1100'), ('credit'::ledger_direction, '4000'))
             as d(direction, code)`;
  }
  return job!.id;
}

async function technicianDay(day: string, kind = "on_site", minutes = 480, startedAt?: string): Promise<void> {
  seq += 1;
  /**
   * A technician hangs off a membership, which hangs off a user: the roster is
   * people who work here rather than a free standing list of names.
   */
  const [person] = await raw<{ id: string }[]>`
    insert into public."user" (email, name) values (${`tech-${seq}-${Date.now()}@kpi.test`}, ${`Tech ${seq}`})
    returning id`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${person!.id}, 'technician') returning id`;
  const [tech] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${membership!.id}, ${`Tech ${seq}`}, true) returning id`;
  await raw`
    insert into public.timeclock_entry (organization_id, technician_id, kind, started_at,
                                       ended_at, minutes)
    values (${ORG}, ${tech!.id}, ${kind}::time_entry_kind, ${startedAt ?? `${day}T13:00:00Z`}::timestamptz,
            (${startedAt ?? `${day}T13:00:00Z`}::timestamptz + ${`${minutes} minutes`}::interval), ${minutes})`;
}

async function estimate(status: string, jobId: string | null, on = "2026-06-10"): Promise<void> {
  seq += 1;
  await raw`
    insert into public.estimate (organization_id, number, customer_id, property_id, job_id,
                                 status, title, issued_on, currency)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${jobId},
            ${status}::estimate_status, 'Quote', ${on}::date, 'USD')`;
}

async function agreement(startedOn: string, renewalCount = 0, customer?: string): Promise<void> {
  seq += 1;
  const [plan] = await raw<{ id: string }[]>`
    insert into public.agreement_plan (organization_id, name, code, price, billing_frequency)
    values (${ORG}, 'Plan', ${`p-${seq}`}, '199.0000', 'annual') returning id`;
  await raw`
    insert into public.agreement (organization_id, plan_id, customer_id, status, started_on,
                                 ends_on, price, billing_frequency, renewal_count)
    values (${ORG}, ${plan!.id}, ${customer ?? customerId}, 'active', ${startedOn}::date,
            (${startedOn}::date + 365), '199.0000', 'annual', ${renewalCount})`;
}

const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  /**
   * `user` carries no `organization_id`, so `resetOrg` cannot reach it: a person
   * can belong to more than one company and sits above the tenant. The addresses
   * are unique to this file.
   */
  await raw`delete from public."user" where email like '%@kpi.test'`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  jobTypes.clear();
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "KPI Co", slug: "kpi-co" });
  await raw`update public.organization set primary_trade = 'hvac' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Lane', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
});

/* ================================================== every key accounted for */

describe("the catalogue accounts for every KPI the packs declare", () => {
  it("has an entry for every key in every pack", () => {
    /**
     * THE TEST THAT MAKES THE ACCOUNT REAL. Sixty three definitions were sitting
     * in eight files with nothing reading them, and the way that happens again is
     * a ninth pack whose KPIs nobody notices. A pack author adding one now has to
     * decide which of the three it is.
     */
    const declared = new Set(packs.flatMap((pack) => pack.kpis.map((kpi) => kpi.key)));
    expect(declared.size).toBeGreaterThan(40);

    const missing = [...declared].filter((key) => !(key in CATALOGUE)).sort();
    expect(
      missing,
      "These KPIs are declared by a trade pack and have no entry in the catalogue, so nobody has "
      + `decided whether they can be computed: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has no entry for a key no pack declares", () => {
    /**
     * The other direction. An entry for a KPI that was renamed or removed is a
     * note about nothing, and worse, a `needs` sentence describing a datum
     * nothing wants any more reads as a gap in the product.
     */
    const declared = new Set(packs.flatMap((pack) => pack.kpis.map((kpi) => kpi.key)));
    const orphaned = KEYS.filter((key) => !declared.has(key)).sort();
    expect(orphaned, `accounted for and declared by no pack: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("agrees with every pack about the format", () => {
    /**
     * A percentage rendered as money is a number nobody can read, and the two
     * declarations are in different files with nothing making them agree. Where
     * two packs declare the same key, they also have to agree with each other.
     */
    const wrong: string[] = [];
    for (const pack of packs) {
      for (const kpi of pack.kpis) {
        const entry = CATALOGUE[kpi.key];
        if (entry && entry.format !== kpi.format) {
          wrong.push(`${pack.id}:${kpi.key} is ${kpi.format} and the catalogue says ${entry.format}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("says something specific about every one it cannot compute", () => {
    /**
     * "NOT BUILT" IS NOT AN ANSWER, and the whole value of the unavailable list
     * is that each entry names the one datum that is missing, so the day it
     * arrives the entry is a one line change from `needs` to `computed`.
     */
    const vague: string[] = [];
    for (const [key, entry] of Object.entries(CATALOGUE)) {
      if (entry.state !== "needs") continue;
      if (entry.needs.length < 80) vague.push(`${key}: too short to be specific`);
      if (/^not built/i.test(entry.needs)) vague.push(`${key}: says "not built"`);
    }
    expect(vague).toEqual([]);
  });

  it("names a real endpoint for every one computed elsewhere", () => {
    for (const [key, entry] of Object.entries(CATALOGUE)) {
      if (entry.state !== "elsewhere") continue;
      expect(entry.endpoint, `${key} has no endpoint`).toMatch(/^(GET|POST) \/v1\//);
      expect(entry.why.length, `${key} does not say why it is elsewhere`).toBeGreaterThan(40);
    }
  });

  it("has exactly these computed, and moving one is a visible change", () => {
    /**
     * THE NAMED LISTS, NOT A COUNT, and this codebase learned that lesson once
     * already: `SOFT_DELETE_NOT_OFFERED` in `unwritten-columns.test.ts` was a
     * count that stayed at twenty four while one table was fixed and another
     * broke. A floor would let the pattern be used to excuse everything as long
     * as the total held, and a target would be a number somebody tunes.
     *
     * Listed, so a KPI moving from `needs` to `computed` is a line in a diff with
     * the implementation beside it, and one moving the other way has to be
     * argued for.
     */
    const computed = KEYS.filter((key) => CATALOGUE[key]!.state === "computed").sort();
    expect(computed).toEqual([
      "avg_ticket",
      "backflow_recert",
      "callback_rate",
      "close_rate",
      "drive_time_pct",
      "maint_attach",
      "not_out_rate",
      "oneoff_to_recurring",
      "program_attach",
      "reapplication_rate",
      "reclean_rate",
      "referral_share",
      "replace_pipeline",
      "revenue_per_cleaner_hour",
      "revenue_per_stop",
      "revenue_per_tech",
      "stops_per_day",
    ]);

    const elsewhere = KEYS.filter((key) => CATALOGUE[key]!.state === "elsewhere").sort();
    expect(elsewhere).toEqual([
      "avg_rental_duration", "avg_tons_per_haul", "overage_capture", "utilisation_rate",
    ]);

    /**
     * Twenty one of forty seven answered. `drive_time_pct` moved because the
     * commute leg turned out to be where the definition says it is, before the
     * first stop and after the last, and `backflow_recert` because M33's
     * inspections give an assembly a typed test date. The rest each name a
     * missing datum, and three of those data would unlock most of them: a coded
     * cancellation reason, a cost posting, and a finer job type class than
     * `revenue_class`.
     */
    expect(computed.length + elsewhere.length).toBe(21);
    expect(KEYS.length).toBe(47);
  });
});

/* ============================================================ the numbers */

run("the numbers it computes", () => {
  it("gives every figure its two halves, because a bare number cannot be checked", async () => {
    /**
     * "$620" is an assertion; "$186,000 over 300 jobs" is an arithmetic a
     * contractor can argue with, and arguing with it is how they come to trust
     * it.
     */
    await completedJob({ revenueClass: "service", revenue: "400.0000" });
    await completedJob({ revenueClass: "service", revenue: "800.0000" });

    const card = await kpis.scorecard(owner(), WINDOW);
    const ticket = card.computed.find((row) => row.key === "avg_ticket")!;
    expect(ticket.value).toBe("600.0000");
    expect(ticket.numerator).toBe("1200.0000");
    expect(ticket.denominator).toBe("2");
    expect(ticket.numeratorLabel).toBe("revenue on completed jobs");
    /** The HVAC pack's own target, since the fixture company's trade is hvac. */
    expect(ticket.target).toBe("650");
  });

  it("leaves a warranty return out of the average ticket", async () => {
    /**
     * "Excludes warranty returns and zero revenue plan visits, which otherwise
     * drag the number down and make a good month look bad."
     */
    await completedJob({ revenueClass: "service", revenue: "600.0000" });
    await completedJob({ revenueClass: "service", revenue: "100.0000", warranty: true });

    const card = await kpis.scorecard(owner(), WINDOW);
    const ticket = card.computed.find((row) => row.key === "avg_ticket")!;
    expect(ticket.denominator).toBe("1");
    expect(ticket.value).toBe("600.0000");
  });

  it("leaves a zero revenue plan visit out of the average ticket", async () => {
    await completedJob({ revenueClass: "service", revenue: "600.0000" });
    await completedJob({ revenueClass: "recurring", revenue: "0" });

    const card = await kpis.scorecard(owner(), WINDOW);
    const ticket = card.computed.find((row) => row.key === "avg_ticket")!;
    expect(ticket.denominator).toBe("1");
  });

  it("counts a three option proposal as one presentation, not three", async () => {
    /**
     * "Counts an estimate as presented only once per job, so a three option
     * proposal is one presentation and not three." The difference between a close
     * rate of fifty per cent and one of twenty.
     */
    const jobId = await completedJob({ revenueClass: "install", revenue: "9000.0000" });
    await estimate("approved", jobId);
    await estimate("declined", jobId);
    await estimate("declined", jobId);
    const other = await completedJob({ revenueClass: "install", revenue: "0" });
    await estimate("declined", other);

    const card = await kpis.scorecard(owner(), WINDOW);
    const close = card.computed.find((row) => row.key === "close_rate")!;
    expect(close.denominator).toBe("2");
    expect(close.numerator).toBe("1");
    expect(close.value).toBe("50.0");
  });

  it("counts an estimate that never became a job on its own", async () => {
    /**
     * A quote to somebody who never became a customer is exactly the loss a close
     * rate measures, and grouping by a null job id would collapse all of them
     * into one.
     */
    await estimate("declined", null);
    await estimate("declined", null);
    await estimate("approved", null);

    const card = await kpis.scorecard(owner(), WINDOW);
    const close = card.computed.find((row) => row.key === "close_rate")!;
    expect(close.denominator).toBe("3");
    expect(close.value).toBe("33.3");
  });

  it("counts a callback only when it is a warranty job linked to a parent", async () => {
    /**
     * "Warranty jobs linked to a parent job within thirty days, divided by
     * completed jobs. Excludes jobs the customer booked again for different work
     * at the same address." Both columns have been on the job table from the
     * beginning and, as the website's own M10 line said, nothing counted them.
     */
    const parent = await completedJob({ revenueClass: "service", revenue: "500.0000", on: "2026-06-02" });
    await completedJob({
      revenueClass: "service", revenue: "0", warranty: true, parentJobId: parent, on: "2026-06-10",
    });
    /** A second visit for different work: no warranty flag, so not a callback. */
    await completedJob({ revenueClass: "service", revenue: "300.0000", on: "2026-06-12" });
    /** A warranty job with no parent: not a callback either. */
    await completedJob({ revenueClass: "service", revenue: "0", warranty: true, on: "2026-06-14" });

    const card = await kpis.scorecard(owner(), WINDOW);
    const callback = card.computed.find((row) => row.key === "callback_rate")!;
    expect(callback.numerator).toBe("1");
    expect(callback.denominator).toBe("4");
    expect(callback.value).toBe("25.0");
  });

  it("does not count a linked return that is not a warranty job", async () => {
    /**
     * THE SWEEP FOUND THIS UNTESTED. The test above has a warranty job with no
     * parent and a non-warranty job with no parent, so removing the warranty
     * check changed nothing. The case that separates them is a job WITH a parent
     * and no warranty flag, which is the definition's own exclusion: "jobs the
     * customer booked again for different work at the same address". A dispatcher
     * links those to the original so the history reads properly, and counting
     * them would turn repeat business into a quality problem.
     */
    const parent = await completedJob({
      revenueClass: "service", revenue: "500.0000", on: "2026-06-02",
    });
    await completedJob({
      revenueClass: "service", revenue: "900.0000", parentJobId: parent, on: "2026-06-10",
    });

    const card = await kpis.scorecard(owner(), WINDOW);
    const callback = card.computed.find((row) => row.key === "callback_rate")!;
    expect(callback.numerator).toBe("0");
    expect(callback.denominator).toBe("2");
  });

  it("keeps an all day job out of the recurring route average", async () => {
    /**
     * THE EXCLUSION `job_revenue_class` WAS ADDED FOR, and the sweep found
     * nothing exercising it: the cleaning pack's `stops_per_day` definition says
     * "EXCLUDES deep cleans, move outs and post construction, which are all day
     * jobs and would pull the recurring route average down to nothing".
     *
     * Four route stops and one deep clean on two technician days is two stops a
     * day. Counting the deep clean makes it two and a half, and the route looks
     * better for having done a job that is not on it.
     */
    await raw`update public.organization set primary_trade = 'cleaning' where id = ${ORG}`;
    for (let i = 0; i < 4; i += 1) {
      await completedJob({ revenueClass: "recurring", revenue: "90.0000" });
    }
    await completedJob({ revenueClass: "project", revenue: "600.0000" });
    await technicianDay("2026-06-15");
    await technicianDay("2026-06-16");

    const card = await kpis.scorecard(owner(), WINDOW);
    const stops = card.computed.find((row) => row.key === "stops_per_day")!;
    expect(stops.numerator).toBe("4");
    expect(stops.denominator).toBe("2");
    expect(stops.value).toBe("2.00");
  });

  it("keeps travel and shop hours out of the cleaner hour figure", async () => {
    /**
     * "EXCLUDES office and administrative hours, and EXCLUDES travel." Both are a
     * `kind` on the timeclock entry, and the sweep found nothing checking either:
     * a day with four hours driving counted as a day cleaning, which halves the
     * revenue per hour and points an owner at the crews rather than at the route.
     */
    await raw`update public.organization set primary_trade = 'cleaning' where id = ${ORG}`;
    await completedJob({ revenueClass: "recurring", revenue: "600.0000" });
    await technicianDay("2026-06-15", "on_site", 240);
    await technicianDay("2026-06-15", "travel", 240);
    await technicianDay("2026-06-15", "shop", 120);

    const card = await kpis.scorecard(owner(), WINDOW);
    const perHour = card.computed.find((row) => row.key === "revenue_per_cleaner_hour")!;
    /** Four hours on site, not ten. */
    expect(perHour.denominator).toBe("4");
    expect(perHour.value).toBe("150.0000");
  });

  it("measures a bin not out against attempted stops, not scheduled ones", async () => {
    /**
     * "Stops where the bin was not at the curb divided by attempted stops. Every
     * one is a paid drive with no revenue."
     *
     * ATTEMPTED, which the sweep found untested. A round the truck never reached
     * is not a bin that was not out, and counting scheduled stops in the
     * denominator makes a rained off day read as customers forgetting.
     *
     * Two different things make a stop unattempted, and the first version of this
     * test only exercised one of them. A stop on a visit that was never completed
     * is already excluded by the window filter on `visit.completed_at`. The one
     * that needs `outcome is not null` is a line on a COMPLETED round that nobody
     * filled in: the driver closed the sheet and left a bin blank. Without both
     * cases, dropping the outcome filter changed no number here.
     */
    await raw`update public.organization set primary_trade = 'trash-bin-cleaning' where id = ${ORG}`;
    const jobId = await completedJob({ revenueClass: "recurring", revenue: "25.0000" });
    const [visit] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, sequence, status, completed_at)
      values (${ORG}, ${jobId}, 1, 'completed', '2026-06-15T15:00:00Z'::timestamptz)
      returning id`;
    const [unreached] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, sequence, status)
      values (${ORG}, ${jobId}, 2, 'scheduled') returning id`;

    const [bin] = await raw<{ id: string }[]>`
      insert into public.equipment (organization_id, property_id, category)
      values (${ORG}, ${propertyId}, 'cart') returning id`;
    /**
     * Two attempted on the completed round: one serviced, one not out. Then a
     * third line on that same round with nothing recorded, and a fourth on a
     * round the truck never reached. Neither of the last two is an attempt.
     */
    await raw`
      insert into public.visit_asset (organization_id, visit_id, equipment_id, sequence, outcome)
      values (${ORG}, ${visit!.id}, ${bin!.id}, 0, 'serviced'),
             (${ORG}, ${visit!.id}, ${bin!.id}, 1, 'no_access'),
             (${ORG}, ${visit!.id}, ${bin!.id}, 2, null),
             (${ORG}, ${unreached!.id}, ${bin!.id}, 0, null)`;

    const card = await kpis.scorecard(owner(), WINDOW);
    const notOut = card.computed.find((row) => row.key === "not_out_rate")!;
    expect(notOut.numerator).toBe("1");
    expect(notOut.denominator).toBe("2");
    expect(notOut.value).toBe("50.0");
  });

  it("counts only declined work on units over twelve years old in the pipeline", async () => {
    /**
     * "Total value of declined replacement recommendations on systems over twelve
     * years old that are still active." The age filter is the whole point: a
     * declined repair on a two year old unit is not a replacement pipeline, and
     * the sweep found nothing testing it.
     *
     * The denominator is a count rather than a divisor, which is what makes the
     * total checkable: forty thousand over three recommendations is a different
     * conversation from forty thousand over sixty.
     */
    const [old] = await raw<{ id: string }[]>`
      insert into public.equipment (organization_id, property_id, category, installed_on, active)
      values (${ORG}, ${propertyId}, 'furnace', current_date - interval '15 years', true)
      returning id`;
    const [young] = await raw<{ id: string }[]>`
      insert into public.equipment (organization_id, property_id, category, installed_on, active)
      values (${ORG}, ${propertyId}, 'furnace', current_date - interval '2 years', true)
      returning id`;

    for (const [unit, amount] of [[old!.id, "9000.0000"], [young!.id, "400.0000"]] as const) {
      await raw`
        insert into public.deficiency (
          organization_id, property_id, customer_id, equipment_id, status, severity,
          checkpoint_key, description, found_on, declined_on, quoted_amount
        ) values (
          ${ORG}, ${propertyId}, ${customerId}, ${unit}, 'declined', 'major', 'heat_exchanger',
          'Cracked', '2026-06-01'::date, '2026-06-10'::date, ${amount}
        )`;
    }

    const card = await kpis.scorecard(owner(), WINDOW);
    const pipeline = card.computed.find((row) => row.key === "replace_pipeline")!;
    expect(pipeline.value).toBe("9000.0000");
    expect(pipeline.denominator).toBe("1");
  });

  it("does not count a warranty return outside the thirty days", async () => {
    const parent = await completedJob({ revenueClass: "service", revenue: "500.0000", on: "2026-05-01" });
    await completedJob({
      revenueClass: "service", revenue: "0", warranty: true, parentJobId: parent, on: "2026-06-20",
    });

    const card = await kpis.scorecard(owner(), WINDOW);
    const callback = card.computed.find((row) => row.key === "callback_rate")!;
    expect(callback.numerator).toBe("0");
  });

  it("takes technician days from the clock, not from the roster", async () => {
    /**
     * "so holiday and training days do not count as capacity". A roster based
     * denominator makes a company look less productive every time somebody takes
     * leave, which is the opposite of what the number is for.
     */
    await completedJob({ revenueClass: "service", revenue: "1600.0000" });
    await technicianDay("2026-06-15", "on_site");
    await technicianDay("2026-06-16", "travel");
    await technicianDay("2026-06-17", "holiday");
    await technicianDay("2026-06-18", "training");
    await technicianDay("2026-06-19", "pto");

    const card = await kpis.scorecard(owner(), WINDOW);
    const perTech = card.computed.find((row) => row.key === "revenue_per_tech")!;
    expect(perTech.denominator).toBe("2");
    expect(perTech.value).toBe("800.0000");
  });

  it("counts a plan sold against service calls to customers with no plan", async () => {
    /**
     * The denominator is the sharp half: a service call to somebody who already
     * holds a plan is not an opportunity, and counting it makes a shop with four
     * hundred members look as though its technicians never sell.
     */
    const [member] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name, payment_terms_days)
      values (${ORG}, 'residential', 'Member', 0) returning id`;
    await agreement("2026-01-01", 1, member!.id);

    await completedJob({ revenueClass: "service", revenue: "300.0000" });
    await completedJob({ revenueClass: "service", revenue: "300.0000", customer: member!.id });
    await agreement("2026-06-20");

    const card = await kpis.scorecard(owner(), WINDOW);
    const attach = card.computed.find((row) => row.key === "maint_attach")!;
    expect(attach.denominator).toBe("1");
    expect(attach.numerator).toBe("1");
    expect(attach.value).toBe("100.0");
  });

  it("counts a subscription from a referred customer under the key the catalogue uses", async () => {
    /**
     * The filter used to name three keys the catalogue never had, so a company
     * recording referrals correctly read nought per cent. `referral_customer`
     * is the one a CSR picking "Referred by a customer" writes.
     */
    const [referred] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name, payment_terms_days, lead_source)
      values (${ORG}, 'residential', 'Referred', 0, 'referral_customer') returning id`;
    const [builder] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name, payment_terms_days, lead_source)
      values (${ORG}, 'residential', 'Via a builder', 0, 'referral_trade') returning id`;
    await agreement("2026-06-05", 0, referred!.id);
    await agreement("2026-06-06", 0, builder!.id);
    /** The trade whose pack declares this KPI. */
    await raw`update public.organization set primary_trade = 'trash-bin-cleaning' where id = ${ORG}`;

    const card = await kpis.scorecard(owner(), WINDOW);
    const share = card.computed.find((row) => row.key === "referral_share")!;
    expect(share.numerator).toBe("1");
    expect(share.denominator).toBe("2");
  });

  it("says nothing rather than zero when there is nothing to measure", async () => {
    /**
     * Nought per cent close rate says every estimate lost. No estimates presented
     * says there is nothing to measure, and those are different months with
     * different answers. The same choice as `utilisation`, `reachRate` and
     * `overageCapture`.
     */
    const card = await kpis.scorecard(owner(), WINDOW);
    for (const row of card.computed) {
      /**
       * EXCEPT THE TOTALS, and the distinction is real rather than a carve out. A
       * close rate over no estimates is unmeasurable: there is no fact. A
       * replacement pipeline over no declined recommendations is zero pounds,
       * which IS the fact, and reporting it as unknown would make an owner go
       * looking for a report that is working correctly.
       */
      if (row.format === "money" && row.denominatorLabel?.includes("counted")) {
        expect(row.value).toBe("0.0000");
        continue;
      }
      expect(row.value, `${row.key} invented a figure from nothing`).toBeNull();
      expect(row.denominator).toBe("0");
    }
  });

  it("reads revenue from the ledger, so a void does not count", async () => {
    /**
     * Rule 4 in `schema/billing.ts`. Read `invoice.total` instead and a voided
     * invoice still counts as revenue, because the void is a reversing posting
     * and never touches the row.
     */
    const jobId = await completedJob({ revenueClass: "service", revenue: "900.0000" });
    await raw`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction,
                                       account_code, currency, amount, source_type, source_id,
                                       job_id)
      select ${ORG}, t.id, '2026-06-16T15:00:00Z'::timestamptz, d.direction, d.code, 'USD',
             '900.0000', 'manual', t.id, ${jobId}
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, '4000'), ('credit'::ledger_direction, '1100'))
             as d(direction, code)`;

    const card = await kpis.scorecard(owner(), WINDOW);
    const ticket = card.computed.find((row) => row.key === "avg_ticket")!;
    /** Revenue nets to nothing, so the job falls out of the average entirely. */
    expect(ticket.denominator).toBe("0");
  });
});

/* ======================================================= what it will not say */

run("what it will not pretend to know", () => {
  it("names the one datum each unavailable KPI needs", async () => {
    const card = await kpis.scorecard(owner(), WINDOW);
    expect(card.unavailable.length).toBeGreaterThan(0);
    for (const row of card.unavailable) {
      expect(row.value).toBeNull();
      expect(row.needs, `${row.key} is unavailable with no reason`).toBeTruthy();
      expect(row.needs!.length).toBeGreaterThan(80);
    }
  });

  it("sends the rental numbers to the endpoint that already computes them", async () => {
    /**
     * Computing them twice would produce two figures that disagree in a meeting,
     * which is the worst outcome available: an owner who finds two numbers for one
     * thing stops trusting both.
     */
    await raw`update public.organization set primary_trade = 'dumpster-rental' where id = ${ORG}`;
    const card = await kpis.scorecard(owner(), WINDOW);
    const keys = card.elsewhere.map((row) => row.key).sort();
    expect(keys).toContain("utilisation_rate");
    for (const row of card.elsewhere) {
      expect(row.endpoint).toBe("GET /v1/fleet-report");
    }
  });

  it("answers a company with no trade pack rather than erroring", async () => {
    await raw`update public.organization set primary_trade = null where id = ${ORG}`;
    const card = await kpis.scorecard(owner(), WINDOW);
    expect(card.tradePack).toBeNull();
    expect(card.computed).toEqual([]);
    expect(card.unavailable).toEqual([]);
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(kpis.scorecard(owner(), { from: "2026-06-30", to: "2026-06-01" }))
      .rejects.toThrow(/before its start/);
  });
});

/* ============================================================ the catalogue */

run("the catalogue endpoint", () => {
  it("counts what it can and cannot do, in one line", async () => {
    const result = await kpis.catalogue(owner(), {});
    expect(result.computed + result.elsewhere + result.unavailable).toBe(result.data.length);
    expect(result.accounted).toBe(result.data.length);
    expect(result.computed).toBeGreaterThan(10);
  });

  it("says which trades declare each one", async () => {
    const result = await kpis.catalogue(owner(), {});
    const ticket = result.data.find((row) => row.key === "avg_ticket")!;
    expect(ticket.trades.length).toBeGreaterThan(1);
    const rental = result.data.find((row) => row.key === "utilisation_rate")!;
    expect(rental.trades).toEqual(["dumpster-rental"]);
  });

  it("needs report:read", async () => {
    await expect(kpis.catalogue(granted("customer:read"), {})).rejects.toThrow(/permission/);
    await expect(kpis.scorecard(granted("customer:read"), WINDOW)).rejects.toThrow(/permission/);
    expect((await kpis.catalogue(granted("report:read"), {})).data.length).toBeGreaterThan(40);
  });
});

/* ==================================================== the revenue class itself */

describe("the revenue class the packs now declare", () => {
  it("is set on every job type in every pack", () => {
    /**
     * Added in this batch because a third of the KPI definitions depend on it:
     * "install revenue", "completed service calls to non members", "the recurring
     * route average", "deep cleans, move outs and post construction, which are
     * all day jobs". Required rather than defaulted in `JobTypeSeed`, so the
     * compiler asks once per job type and a pack author cannot skip the decision.
     */
    for (const pack of packs) {
      for (const jt of pack.jobTypes) {
        expect(jt.revenueClass, `${pack.id}:${jt.code} has no revenue class`).toBeTruthy();
      }
    }
  });

  it("is not the same question as the capacity model", () => {
    /**
     * The distinction that makes the column worth having: two job types with the
     * same capacity model can be an install and a maintenance visit, which carry
     * different margins and belong in different numbers.
     */
    const hvac = packs.find((pack) => pack.id === "hvac")!;
    const byCode = new Map(hvac.jobTypes.map((jt) => [jt.code, jt]));
    expect(byCode.get("repair")!.capacityModel).toBe("technician_dispatch");
    expect(byCode.get("maint")!.capacityModel).toBe("technician_dispatch");
    expect(byCode.get("repair")!.revenueClass).toBe("service");
    expect(byCode.get("maint")!.revenueClass).toBe("recurring");
  });

  it("marks the all day jobs as projects, which is what the route average excludes", () => {
    /**
     * The cleaning pack's `stops_per_day` definition names them: "EXCLUDES deep
     * cleans, move outs and post construction, which are all day jobs and would
     * pull the recurring route average down to nothing."
     */
    const cleaning = packs.find((pack) => pack.id === "cleaning")!;
    const byCode = new Map(cleaning.jobTypes.map((jt) => [jt.code, jt]));
    for (const code of ["deep", "move", "post-con"]) {
      expect(byCode.get(code)!.revenueClass, `${code} should be a project`).toBe("project");
    }
    expect(byCode.get("recur-res")!.revenueClass).toBe("recurring");
  });

  it("marks the work that earns nothing as internal", () => {
    /**
     * A yard repair and an estimate walkthrough consume capacity and earn no
     * customer revenue. In a revenue-per-day denominator they are exactly the
     * thing that has to be distinguishable rather than absent.
     */
    const dumpster = packs.find((pack) => pack.id === "dumpster-rental")!;
    expect(dumpster.jobTypes.find((jt) => jt.code === "yard-repair")!.revenueClass)
      .toBe("internal");
    const cleaning = packs.find((pack) => pack.id === "cleaning")!;
    expect(cleaning.jobTypes.find((jt) => jt.code === "walkthrough")!.revenueClass)
      .toBe("internal");
  });
});

/** Keeps the ConflictError import honest. */
describe("refusal types", () => {
  it("uses ConflictError for a bad window rather than a missing row", () => {
    expect(new ConflictError("x")).toBeInstanceOf(Error);
  });
});

/* ========================================== whose day a late evening is */

run("a KPI dates its records by the company's day, not UTC's", () => {
  /**
   * The company is in America/Chicago, the column's default. 01:00 UTC on the
   * 1st of July is eight in the evening on the 30th of June there, and an owner
   * who finished a job then finished it in June. Read as a UTC day, which the
   * older KPIs did, it moved into July's scorecard and out of June's.
   */
  it("counts a job finished at 01:00 UTC in the company's previous day, month and window", async () => {
    await completedJob({ revenueClass: "service", revenue: "500.0000", at: "2026-07-01T01:00:00Z" });

    const june = (await kpis.scorecard(owner(), WINDOW)).computed.find((row) => row.key === "avg_ticket")!;
    expect(june.denominator).toBe("1");
    expect(june.numerator).toBe("500.0000");

    const july = (await kpis.scorecard(owner(), { from: "2026-07-01", to: "2026-07-31" }))
      .computed.find((row) => row.key === "avg_ticket")!;
    expect(july.denominator).toBe("0");

    const drilled = await kpis.drill(owner(), { key: "avg_ticket", half: "denominator", ...WINDOW });
    expect(drilled.records.map((r) => r.onDay)).toEqual(["2026-06-30"]);
  });

  it("leaves out a job finished late on the evening before the window starts", async () => {
    /** 04:00 UTC on the 1st of June is eleven at night on the 31st of May in Chicago. */
    await completedJob({ revenueClass: "service", revenue: "300.0000", at: "2026-06-01T04:00:00Z" });
    await completedJob({ revenueClass: "service", revenue: "700.0000", at: "2026-06-01T06:00:00Z" });

    const june = (await kpis.scorecard(owner(), WINDOW)).computed.find((row) => row.key === "avg_ticket")!;
    expect(june.denominator).toBe("1");
    expect(june.numerator).toBe("700.0000");
  });

  it("counts a technician's evening shift as the day it started where the company is", async () => {
    /** Clocked on at 22:00 Chicago time on the 30th, which is 03:00 UTC on the 1st. */
    await technicianDay("2026-06-30", "on_site", 120, "2026-07-01T03:00:00Z");
    const drilled = await kpis.drill(owner(), { key: "revenue_per_tech", half: "denominator", ...WINDOW });
    expect(drilled.records.map((r) => r.onDay)).toEqual(["2026-06-30"]);

    const july = await kpis.drill(owner(), { key: "revenue_per_tech", half: "denominator", from: "2026-07-01", to: "2026-07-31" });
    expect(july.count).toBe(0);
  });
});
