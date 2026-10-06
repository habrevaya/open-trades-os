import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { packs } from "@opentradesos/trade-packs";
import * as kpis from "../src/services/kpis";
import { CATALOGUE } from "../src/services/kpi-catalogue";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE TWO KPIS THAT MOVED, AND THE RECORDS BEHIND EVERY ONE
 *
 * `drive_time_pct` and `backflow_recert` were listed as needing a datum. The
 * first turned out not to (the commute leg is where the definition says it is,
 * before the first stop and after the last), and M33's inspections gave the
 * second its typed test date. Each is checked here against a fixture whose
 * answer was worked out by hand, one exclusion at a time.
 *
 * Then the drill: for every computed KPI of every trade, the records listed
 * add up to the half the scorecard shows, because both are the same query.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-drill:org");
const USER = fixtureId("kpi-drill:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (role: string, grants: string[] = []): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG, roles: [role] as Actor["roles"],
    grants: grants as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

let seq = 0;
let customerId = "";
let propertyId = "";

async function trade(id: string): Promise<void> {
  await raw`update public.organization set primary_trade = ${id} where id = ${ORG}`;
}

async function technician(name: string): Promise<string> {
  seq += 1;
  const [person] = await raw<{ id: string }[]>`
    insert into public."user" (email, name) values (${`drill-${seq}-${Date.now()}@kpi-drill.test`}, ${name})
    returning id`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${person!.id}, 'technician') returning id`;
  const [tech] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${membership!.id}, ${name}, true) returning id`;
  return tech!.id;
}

/** One punch, from a local wall clock time in Austin to another. */
async function punch(tech: string, kind: string, day: string, from: string, to: string): Promise<void> {
  await raw`
    insert into public.timeclock_entry (organization_id, technician_id, kind, started_at, ended_at, minutes)
    values (${ORG}, ${tech}, ${kind}::time_entry_kind,
            (${`${day} ${from}`}::timestamp at time zone 'America/Chicago'),
            (${`${day} ${to}`}::timestamp at time zone 'America/Chicago'),
            extract(epoch from ((${`${day} ${to}`}::timestamp) - (${`${day} ${from}`}::timestamp)))::int / 60)`;
}

const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where email like '%@kpi-drill.test'`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  jobNumber = 0;
  typesMade.clear();
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Drill Co", slug: "kpi-drill-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Elm', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
});

/* ============================================================ drive time */

run("drive time share of the day", () => {
  it("counts drives between stops and leaves out the way out and the way home", async () => {
    /**
     * Worked by hand. One technician's day:
     *
     *   07:00 to 07:30  travel   30   the way out: no stop before it, left out
     *   07:30 to 09:00  on site  90
     *   09:00 to 09:20  travel   20   between stops
     *   09:20 to 11:00  on site 100
     *   11:00 to 11:40  travel   40   to the shop for a part: still between stops
     *   11:40 to 12:00  shop     20
     *   12:00 to 12:15  travel   15   between stops
     *   12:15 to 14:00  on site 105
     *   14:00 to 14:45  travel   45   the way home: no stop after it, left out
     *
     * Drive between stops 20 + 40 + 15 = 75; the working day on the clock
     * 30 + 90 + 20 + 100 + 40 + 20 + 15 + 105 + 45 = 465. 75 / 465 = 16.13%.
     */
    await trade("cleaning");
    const ana = await technician("Ana");
    await punch(ana, "travel", "2026-06-10", "07:00", "07:30");
    await punch(ana, "on_site", "2026-06-10", "07:30", "09:00");
    await punch(ana, "travel", "2026-06-10", "09:00", "09:20");
    await punch(ana, "on_site", "2026-06-10", "09:20", "11:00");
    await punch(ana, "travel", "2026-06-10", "11:00", "11:40");
    await punch(ana, "shop", "2026-06-10", "11:40", "12:00");
    await punch(ana, "travel", "2026-06-10", "12:00", "12:15");
    await punch(ana, "on_site", "2026-06-10", "12:15", "14:00");
    await punch(ana, "travel", "2026-06-10", "14:00", "14:45");

    const card = await kpis.scorecard(owner(), WINDOW);
    const drive = card.computed.find((k) => k.key === "drive_time_pct")!;
    expect(drive.numerator).toBe("75");
    expect(drive.denominator).toBe("465");
    expect(drive.value).toBe("16.1");
  });

  it("leaves out a day that recorded no driving, rather than reading it as none", async () => {
    /**
     * A company whose people do not clock their driving would otherwise read
     * nought per cent drive time. Ben clocked only on site time; Cy spent the
     * day in the shop with a drive and no stop. Neither day is in either half.
     */
    await trade("cleaning");
    const ben = await technician("Ben");
    await punch(ben, "on_site", "2026-06-10", "08:00", "16:00");
    const cy = await technician("Cy");
    await punch(cy, "travel", "2026-06-10", "07:00", "07:30");
    await punch(cy, "shop", "2026-06-10", "07:30", "15:00");

    const card = await kpis.scorecard(owner(), WINDOW);
    const drive = card.computed.find((k) => k.key === "drive_time_pct")!;
    expect(drive.denominator).toBe("0");
    expect(drive.value).toBeNull();
  });

  it("keeps a shift that runs into the evening on one day in the company's calendar", async () => {
    /**
     * 18:00 to 21:00 in Austin is 23:00 to 02:00 UTC. Grouped by the UTC date,
     * the first stop is on the 11th and the drive and the second stop on the
     * 12th, so the drive would have no stop before it and be thrown out as a
     * commute. In the company's calendar it is plainly between two stops:
     * 30 / (60 + 30 + 90) = 16.7%.
     */
    await trade("cleaning");
    const dee = await technician("Dee");
    await punch(dee, "on_site", "2026-06-11", "18:00", "19:00");
    await punch(dee, "travel", "2026-06-11", "19:00", "19:30");
    await punch(dee, "on_site", "2026-06-11", "19:30", "21:00");

    const card = await kpis.scorecard(owner(), WINDOW);
    const drive = card.computed.find((k) => k.key === "drive_time_pct")!;
    expect(drive.numerator).toBe("30");
    expect(drive.denominator).toBe("180");
    expect(drive.value).toBe("16.7");
  });
});

/* ======================================================= backflow retests */

const BACKFLOW_CHECKPOINTS = [
  { key: "check1", label: "First check valve holds", assetCategory: "backflow-assembly", requiresReading: true, unit: "psid" },
  { key: "relief", label: "Relief valve opens", assetCategory: "backflow-assembly" },
];
const HEATER_CHECKPOINTS = [{ key: "tp", label: "T and P valve", assetCategory: "water-heater" }];

async function unit(tag: string, options: { retired?: boolean } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.equipment (organization_id, property_id, category, tag, serial_number, active, deleted_at)
    values (${ORG}, ${propertyId}, 'backflow-assembly', ${tag}, ${`SN-${tag}`},
            ${!options.retired}, ${options.retired ? new Date() : null})
    returning id`;
  return row!.id;
}

async function test(equipmentId: string, on: string, result: string, checkpoints = BACKFLOW_CHECKPOINTS): Promise<void> {
  const answers = [{
    itemKey: checkpoints[0]!.key, value: { kind: "pass" }, at: `${on}T15:00:00Z`, by: "Tester", equipmentId,
  }];
  await raw`
    insert into public.inspection (organization_id, property_id, customer_id, performed_on, result, checkpoints, answers)
    values (${ORG}, ${propertyId}, ${customerId}, ${on}::date, ${result}::inspection_result,
            ${raw.json(checkpoints)}, ${raw.json(answers)})`;
}

run("backflow retest capture", () => {
  it("divides assemblies retested by assemblies whose last test is a year old, as defined", async () => {
    /**
     * Worked by hand, for June 2026. Due means the last test before June is on
     * or before 30 June 2025.
     *
     *   U1  tested 2025-05-20, retested 2026-06-12 (it failed: still a test)  due, retested
     *   U2  tested 2025-06-25, not retested                                    due
     *   U3  tested 2025-09-01                                                   not due
     *   U4  tested 2024-06-01, taken off the register                           removed: out
     *   U5  first ever test 2026-06-05                                          no last test: out
     *   U6  only answered on a water heater checkpoint in 2025-03                not a backflow test: out
     *   U7  tested 2024-04-01, "not accessible" 2025-04-01, "not tested" in June  due, not retested
     *
     * Retested 1 (U1) over due 3 (U1, U2, U7): 33.3%.
     */
    await trade("plumbing");
    const u1 = await unit("U1");
    await test(u1, "2025-05-20", "pass");
    await test(u1, "2026-06-12", "fail");
    const u2 = await unit("U2");
    await test(u2, "2025-06-25", "pass");
    const u3 = await unit("U3");
    await test(u3, "2025-09-01", "pass");
    const u4 = await unit("U4", { retired: true });
    await test(u4, "2024-06-01", "pass");
    const u5 = await unit("U5");
    await test(u5, "2026-06-05", "pass");
    const u6 = await unit("U6");
    await test(u6, "2025-03-01", "pass", HEATER_CHECKPOINTS);
    const u7 = await unit("U7");
    await test(u7, "2024-04-01", "pass");
    await test(u7, "2025-04-01", "not_accessible");
    await test(u7, "2026-06-20", "not_tested");

    const card = await kpis.scorecard(owner(), WINDOW);
    const capture = card.computed.find((k) => k.key === "backflow_recert")!;
    expect(capture.numerator).toBe("1");
    expect(capture.denominator).toBe("3");
    expect(capture.value).toBe("33.3");

    const due = await kpis.drill(owner(), { key: "backflow_recert", half: "denominator", ...WINDOW });
    expect(due.records.map((r) => r.label).sort()).toEqual([
      "U1 backflow-assembly, serial SN-U1", "U2 backflow-assembly, serial SN-U2", "U7 backflow-assembly, serial SN-U7",
    ]);
    expect(due.records.find((r) => r.id === u7)!.onDay).toBe("2024-04-01");
    expect(due.records.find((r) => r.id === u1)!.href).toBe(`/equipment/${u1}`);
  });

  it("reads the programme's checkpoints for an inspection filed before they were copied onto it", async () => {
    await trade("plumbing");
    const [program] = await raw<{ id: string }[]>`
      insert into public.inspection_program (organization_id, name, checkpoints)
      values (${ORG}, 'Backflow', ${raw.json(BACKFLOW_CHECKPOINTS)}) returning id`;
    const u = await unit("Old");
    const answers = [{ itemKey: "check1", value: { kind: "pass" }, at: "2025-05-01T15:00:00Z", by: "Tester", equipmentId: u }];
    await raw`
      insert into public.inspection (organization_id, program_id, property_id, customer_id, performed_on, result, answers)
      values (${ORG}, ${program!.id}, ${propertyId}, ${customerId}, '2025-05-01', 'pass', ${raw.json(answers)})`;

    const card = await kpis.scorecard(owner(), WINDOW);
    expect(card.computed.find((k) => k.key === "backflow_recert")!.denominator).toBe("1");
  });
});

/* ===================================================== the records behind */

/** A spread of records across every kind the computed KPIs read. */
async function spread(): Promise<void> {
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, 'Service', 'svc', 'technician_dispatch', 'service'::job_revenue_class) returning id`;
  const [recurring] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, 'Route', 'route', 'technician_dispatch', 'recurring'::job_revenue_class) returning id`;
  for (const [n, typeId, revenue] of [[1, type!.id, "250.0000"], [2, type!.id, "125.5000"], [3, recurring!.id, "0"], [4, recurring!.id, "40.0000"]] as const) {
    const [job] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
      values (${ORG}, ${n}, ${customerId}, ${propertyId}, ${typeId}, 'completed', ${`Job ${n}`}, '2026-06-15T15:00:00Z')
      returning id`;
    await raw`
      insert into public.visit (organization_id, job_id, status, completed_at)
      values (${ORG}, ${job!.id}, 'completed', '2026-06-15T15:00:00Z')`;
    if (revenue !== "0") {
      await raw`
        insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, currency,
                                         amount, source_type, source_id, job_id)
        select ${ORG}, t.id, '2026-06-15T15:00:00Z', d.direction, d.code, 'USD', ${revenue}, 'manual', t.id, ${job!.id}
        from (select gen_random_uuid() as id) t,
             (values ('debit'::ledger_direction, '1100'), ('credit'::ledger_direction, '4000')) as d(direction, code)`;
    }
    await raw`
      insert into public.estimate (organization_id, number, customer_id, property_id, job_id, status, title, issued_on, currency)
      values (${ORG}, ${n}, ${customerId}, ${propertyId}, ${job!.id}, ${n % 2 ? "approved" : "declined"}::estimate_status,
              'Quote', '2026-06-10', 'USD')`;
  }
  const [plan] = await raw<{ id: string }[]>`
    insert into public.agreement_plan (organization_id, name, code, price, billing_frequency)
    values (${ORG}, 'Plan', 'plan', '199.0000', 'annual') returning id`;
  await raw`
    insert into public.agreement (organization_id, plan_id, customer_id, status, started_on, ends_on, price, billing_frequency)
    values (${ORG}, ${plan!.id}, ${customerId}, 'active', '2026-06-20', '2027-06-19', '199.0000', 'annual')`;
  const ana = await technician("Ana");
  await punch(ana, "travel", "2026-06-15", "08:00", "08:30");
  await punch(ana, "on_site", "2026-06-15", "08:30", "10:00");
  await punch(ana, "travel", "2026-06-15", "10:00", "10:20");
  await punch(ana, "on_site", "2026-06-15", "10:20", "12:00");
}

run("the records behind every computed KPI", () => {
  it("lists records that add up to both halves the scorecard shows, for every trade", async () => {
    await spread();
    const checked: string[] = [];
    for (const pack of packs) {
      await trade(pack.id);
      const card = await kpis.scorecard(owner(), WINDOW);
      for (const kpi of card.computed) {
        for (const half of ["numerator", "denominator"] as const) {
          const drilled = await kpis.drill(owner(), { key: kpi.key, half, ...WINDOW });
          const shown = half === "numerator" ? kpi.numerator : kpi.denominator;
          const where = `${pack.id}:${kpi.key}:${half}`;
          expect(Number(drilled.total), `${where} total`).toBeCloseTo(Number(shown), 6);
          expect(drilled.count, `${where} count`).toBe(drilled.records.length);
          const added = drilled.records.reduce((sum, r) => sum + Number(r.value), 0);
          expect(added, `${where} rows`).toBeCloseTo(Number(drilled.total), 6);
          for (const record of drilled.records) expect(record.href, where).toMatch(/^\/[a-z]/);
          checked.push(`${kpi.key}:${half}`);
        }
      }
    }
    /** Every computed KPI was drilled under at least one trade, both halves. */
    const computed = Object.entries(CATALOGUE).filter(([, e]) => e.state === "computed").map(([k]) => k);
    for (const key of computed) {
      expect(checked, key).toContain(`${key}:numerator`);
      expect(checked, key).toContain(`${key}:denominator`);
    }
  });

  it("opens each record on its own screen", async () => {
    await spread();
    await trade("hvac");
    const jobs = await kpis.drill(owner(), { key: "avg_ticket", half: "numerator", ...WINDOW });
    expect(jobs.records.map((r) => r.value).sort()).toEqual(["125.5000", "250.0000", "40.0000"]);
    expect(jobs.records.every((r) => /^\/jobs\/[0-9a-f-]{36}$/.test(r.href))).toBe(true);

    await trade("cleaning");
    const visits = await kpis.drill(owner(), { key: "reclean_rate", half: "denominator", ...WINDOW });
    expect(visits.count).toBe(4);
    expect(visits.records.every((r) => /^\/visits\/[0-9a-f-]{36}$/.test(r.href))).toBe(true);
    const days = await kpis.drill(owner(), { key: "stops_per_day", half: "denominator", ...WINDOW });
    expect(days.records).toEqual([expect.objectContaining({
      kind: "technician_day", label: "Ana, Jun 15", href: "/timesheets?week=2026-06-15",
    })]);
  });

  it("refuses somebody who sees only part of the company's work, rather than listing a part", async () => {
    await spread();
    await trade("hvac");
    /** A technician given the reports permission still sees only their own work. */
    const refused = await kpis.drill(as("technician", ["report:read", "estimate:read"]), { key: "close_rate", half: "denominator", ...WINDOW })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as Error).message).toMatch(/whole company's/);
  });

  it("refuses revenue per job without the financial reports permission, and says which", async () => {
    await spread();
    await trade("hvac");
    const refused = await kpis.drill(as("dispatcher"), { key: "avg_ticket", half: "numerator", ...WINDOW })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as Error).message).toMatch(/report\.financial:read/);
  });

  it("refuses a KPI the company's trade does not declare, and one it cannot compute", async () => {
    await trade("hvac");
    await expect(kpis.drill(owner(), { key: "stops_per_day", half: "numerator", ...WINDOW }))
      .rejects.toBeInstanceOf(NotFoundError);
    await expect(kpis.drill(owner(), { key: "first_time_fix", half: "numerator", ...WINDOW }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

/* ==================================================== crew days, install margin */

/** A job type of a revenue class, once per code. */
const typesMade = new Map<string, string>();
async function typeOf(revenueClass: string): Promise<string> {
  const found = typesMade.get(revenueClass);
  if (found) return found;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, ${revenueClass}, ${`code-${revenueClass}`}, 'crew_production', ${revenueClass}::job_revenue_class) returning id`;
  typesMade.set(revenueClass, row!.id);
  return row!.id;
}

let jobNumber = 0;
/** A completed job, with its revenue posted to the ledger as the ledger records it. */
async function finishedJob(revenueClass: string, on: string, revenue = "0", over: { warranty?: boolean } = {}): Promise<string> {
  jobNumber += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, is_warranty, completed_at)
    values (${ORG}, ${jobNumber}, ${customerId}, ${propertyId}, ${await typeOf(revenueClass)}, 'completed',
            ${`${revenueClass} ${jobNumber}`}, ${over.warranty ?? false}, ${`${on}T15:00:00Z`}::timestamptz)
    returning id`;
  if (revenue !== "0") {
    await raw`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, currency,
                                       amount, source_type, source_id, job_id)
      select ${ORG}, t.id, ${`${on}T15:00:00Z`}::timestamptz, d.direction, d.code, 'USD', ${revenue}, 'manual', t.id, ${job!.id}
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, '1200'), ('credit'::ledger_direction, '4000')) as d(direction, code)`;
  }
  return job!.id;
}

async function crewNamed(name: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.crew (organization_id, name) values (${ORG}, ${name}) returning id`;
  return row!.id;
}

/** A visit on a job, sent to a crew or to nobody, done on a day or still to do. */
async function visitOn(jobId: string, crewId: string | null, day: string, status: "completed" | "scheduled" = "completed"): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, crew_id, completed_at)
    values (${ORG}, ${jobId}, (select coalesce(max(sequence), 0) + 1 from public.visit where job_id = ${jobId}), ${status}::visit_status,
            ${crewId}, ${status === "completed" ? `${day} 16:00` : null}::timestamp at time zone 'America/Chicago')
    returning id`;
  return row!.id;
}

/** A punch on a visit, in local wall clock time. */
async function punchOn(tech: string, visitId: string | null, kind: string, day: string, from: string, to: string): Promise<void> {
  await raw`
    insert into public.timeclock_entry (organization_id, technician_id, visit_id, kind, started_at, ended_at, minutes)
    values (${ORG}, ${tech}, ${visitId}, ${kind}::time_entry_kind,
            (${`${day} ${from}`}::timestamp at time zone 'America/Chicago'),
            (${`${day} ${to}`}::timestamp at time zone 'America/Chicago'),
            extract(epoch from ((${`${day} ${to}`}::timestamp) - (${`${day} ${from}`}::timestamp)))::int / 60)`;
}

run("revenue per crew day", () => {
  it("divides the revenue of crew work by crew days from the crew's own clock, one a day however many people are on it", async () => {
    /**
     * Worked by hand, for June 2026.
     *
     *   North, four people, the 10th   a completed stop, four people on site     ONE crew day
     *   North, the 11th                a completed stop, travel then on site      one more
     *   North, the 12th (rain)         the stop was never done, two people on site   not a day
     *   North, the 13th                a stop completed but only shop time clocked   not a day (the yard)
     *   South, the 14th                a completed stop, one person on site       a day
     *   Ana, on no visit, the 10th     a punch that belongs to no crew             not a day
     *   a crew's stop on 1 July, after the window                                  not in the window
     *
     * Three crew days. The revenue is the ledger's on completed jobs a crew
     * worked, of every class but internal: install 1000, recurring 400,
     * service 200 (the 13th's stop, whose day is not a crew day but whose job
     * is crew work) and service 600 (South's) is 2200, and the technician's
     * own 5000 service call and the 100 internal job are not crew work.
     * 2200 over 3 is 733.3333.
     */
    await trade("lawn-and-landscape");
    const north = await crewNamed("North");
    const south = await crewNamed("South");
    const [ana, ben, cy, dee, eli] = await Promise.all(["Ana", "Ben", "Cy", "Dee", "Eli"].map(technician));

    const j1 = await finishedJob("install", "2026-06-10", "1000.0000");
    const v1 = await visitOn(j1, north, "2026-06-10");
    for (const who of [ana, ben, cy, dee]) await punchOn(who!, v1, "on_site", "2026-06-10", "08:00", "16:00");

    const j2 = await finishedJob("recurring", "2026-06-11", "400.0000");
    const v2 = await visitOn(j2, north, "2026-06-11");
    await punchOn(ana!, v2, "travel", "2026-06-11", "07:30", "08:00");
    await punchOn(ana!, v2, "on_site", "2026-06-11", "08:00", "15:00");

    const rained = await finishedJob("recurring", "2026-06-15", "0");
    await raw`update public.job set completed_at = null, status = 'scheduled' where id = ${rained}`;
    const v3 = await visitOn(rained, north, "2026-06-12", "scheduled");
    await punchOn(ana!, v3, "on_site", "2026-06-12", "08:00", "09:00");
    await punchOn(ben!, v3, "on_site", "2026-06-12", "08:00", "09:00");

    const j3 = await finishedJob("service", "2026-06-13", "200.0000");
    const v4 = await visitOn(j3, north, "2026-06-13");
    await punchOn(ana!, v4, "shop", "2026-06-13", "08:00", "12:00");

    const j4 = await finishedJob("service", "2026-06-14", "600.0000");
    const v5 = await visitOn(j4, south, "2026-06-14");
    await punchOn(eli!, v5, "on_site", "2026-06-14", "08:00", "16:00");

    await punchOn(ana!, null, "travel", "2026-06-10", "06:00", "07:00");

    const own = await finishedJob("service", "2026-06-10", "5000.0000");
    await visitOn(own, null, "2026-06-10");
    const internal = await finishedJob("internal", "2026-06-10", "100.0000");
    const vi = await visitOn(internal, north, "2026-06-10");
    await punchOn(ben!, vi, "on_site", "2026-06-10", "16:30", "17:00");

    const after = await finishedJob("install", "2026-07-01", "900.0000");
    const v6 = await visitOn(after, north, "2026-07-01");
    await punchOn(ana!, v6, "on_site", "2026-07-01", "08:00", "16:00");

    const card = await kpis.scorecard(owner(), WINDOW);
    const row = card.computed.find((k) => k.key === "revenue_per_crew_day")!;
    expect(row.numerator).toBe("2200.0000");
    expect(row.denominator).toBe("3");
    expect(row.value).toBe("733.3333");
    expect(row.numeratorMoney).toBe(true);
    expect(row.denominatorMoney).toBe(false);

    // The same rule, in core, over the same rows, says three days: the SQL is held to the definition.
    const visits = await raw<{ id: string; crew_id: string | null; status: string; completed_at: Date | null }[]>`
      select id, crew_id, status::text as status, completed_at from public.visit where organization_id = ${ORG}`;
    const punches = await raw<{ visit_id: string | null; kind: string; started_at: Date }[]>`
      select visit_id, kind::text as kind, started_at from public.timeclock_entry where organization_id = ${ORG}`;
    const oracle = (await import("@opentradesos/core")).reporting.crewDays({
      zone: "America/Chicago",
      visits: visits.map((v) => ({ id: v.id, crewId: v.crew_id, status: v.status, completedAt: v.completed_at })),
      punches: punches.map((p) => ({ visitId: p.visit_id, kind: p.kind, startedAt: p.started_at })),
    }).filter((d) => d.day >= "2026-06-01" && d.day <= "2026-06-30");
    expect(oracle).toEqual([
      { crewId: north, day: "2026-06-10" }, { crewId: north, day: "2026-06-11" }, { crewId: south, day: "2026-06-14" },
    ].sort((a, b) => (`${a.crewId}|${a.day}` < `${b.crewId}|${b.day}` ? -1 : 1)));
    expect(oracle).toHaveLength(Number(row.denominator));

    // Each half opens on the records it counts, and they add up.
    const days = await kpis.drill(owner(), { key: "revenue_per_crew_day", half: "denominator", ...WINDOW });
    expect(days.records.map((r) => r.label).sort()).toEqual(["North, Jun 10", "North, Jun 11", "South, Jun 14"]);
    expect(days.records.every((r) => r.kind === "crew_day" && r.href.startsWith("/timesheets?week="))).toBe(true);
    expect(Number(days.total)).toBe(3);
    const jobs = await kpis.drill(owner(), { key: "revenue_per_crew_day", half: "numerator", ...WINDOW });
    expect(jobs.records.map((r) => r.value).sort()).toEqual(["1000.0000", "200.0000", "400.0000", "600.0000"]);
    expect(Number(jobs.total)).toBe(2200);
    expect(jobs.money).toBe(true);
  });

  it("is nothing rather than nought when no crew worked a day", async () => {
    await trade("lawn-and-landscape");
    const card = await kpis.scorecard(owner(), WINDOW);
    const row = card.computed.find((k) => k.key === "revenue_per_crew_day")!;
    expect(row.value).toBeNull();
    expect(row.denominator).toBe("0");
  });

  it("counts a crew day where the company is: a stop and a punch in the evening are the same local day", async () => {
    await trade("lawn-and-landscape");
    const north = await crewNamed("North");
    const [ana] = await Promise.all([technician("Ana")]);
    const j = await finishedJob("install", "2026-06-11", "100.0000");
    // 18:00 to 21:00 on the 30th in Chicago is the 1st in UTC: still the 30th, still June.
    const v = await visitOn(j, north, "2026-06-30");
    await punchOn(ana!, v, "on_site", "2026-06-30", "18:00", "21:00");
    const days = await kpis.drill(owner(), { key: "revenue_per_crew_day", half: "denominator", ...WINDOW });
    expect(days.records.map((r) => r.onDay)).toEqual(["2026-06-30"]);
  });
});

run("install gross margin", () => {
  /** A costing line on a job, billed or excused so the job is settled, with a cost or without. */
  const line = (jobId: string, kind: string, name: string, cost: string | null, over: { billed?: boolean } = {}) => raw`
    insert into public.job_line (organization_id, job_id, kind, source, name, quantity, unit_price, unit_cost, non_billable_reason)
    values (${ORG}, ${jobId}, ${kind}::job_line_kind, 'office', ${name}, '1', '0', ${cost}, ${over.billed ? null : "included_in_the_price"})`;

  /** Hours at a frozen loaded rate and base rate, which is how a punch is costed once it closes. */
  const hours = async (jobId: string, tech: string, day: string, from: string, to: string, rates: { loaded: string; base: string } | null) => {
    await raw`
      insert into public.timeclock_entry (organization_id, technician_id, job_id, kind, started_at, ended_at, minutes,
                                          applied_loaded_rate, applied_base_rate)
      values (${ORG}, ${tech}, ${jobId}, 'on_site', (${`${day} ${from}`}::timestamp at time zone 'America/Chicago'),
              (${`${day} ${to}`}::timestamp at time zone 'America/Chicago'),
              extract(epoch from ((${`${day} ${to}`}::timestamp) - (${`${day} ${from}`}::timestamp)))::int / 60,
              ${rates?.loaded ?? null}, ${rates?.base ?? null})`;
  };

  it("takes install revenue less material, subcontract, disposal and burdened labour, over only the installs whose costs are all in", async () => {
    /**
     * Worked by hand, for June 2026, with payroll taxes at ten per cent of the
     * base wage.
     *
     *   J1  install, revenue 10000   parts 2000, subcontractor 1500, disposal 300,
     *       500 journalled to the job, eight hours at a loaded 40 on a base of 30
     *       material 4300, labour 320, burden 24                  earned 5356
     *   J2  install, revenue 6000    a part 1000, four hours      earned 6000 - 1000 - 160 - 12 = 4828
     *   J3  install, revenue 5000    no hours ever recorded        left out
     *   J4  install, revenue 4000    hours with no wage scale      left out
     *   J5  install, revenue 3000    a line with no cost recorded  left out
     *   J6  install, revenue 2000    a line nobody has billed or excused   left out
     *   J7  install, revenue 7000    a punch still running          left out
     *   J8  SERVICE, revenue 9000, with hours                       not an install
     *   J9  install finished 2 July                                 outside the window
     *   J10 a warranty install, no revenue, a part 300 and two hours: earned -386
     *
     * Earned 5356 + 4828 - 386 = 9798 over revenue 10000 + 6000 + 0 = 16000,
     * which is 61.2%. Without the exclusions the same six installs read 79%.
     */
    await trade("lawn-and-landscape");
    await raw`insert into public.costing_rate (organization_id, component, basis, rate, effective_from)
              values (${ORG}, 'payroll_taxes', 'percent_of_wages', '10', '2026-01-01')`;
    const ana = await technician("Ana");
    const rates = { loaded: "40", base: "30" };

    const j1 = await finishedJob("install", "2026-06-05", "10000.0000");
    await line(j1, "part", "Pavers", "2000");
    await line(j1, "subcontractor", "Electrician", "1500");
    await line(j1, "disposal", "Spoil haul", "300");
    await raw`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, currency, amount, source_type, source_id, job_id)
      select ${ORG}, t.id, '2026-06-05T15:00:00Z', d.direction, d.code, 'USD', '500', 'manual', t.id, case when d.code = '5000' then ${j1}::uuid end
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, '5000'), ('credit'::ledger_direction, '1000')) as d(direction, code)`;
    await hours(j1, ana, "2026-06-05", "08:00", "16:00", rates);

    const j2 = await finishedJob("install", "2026-06-20", "6000.0000");
    await line(j2, "part", "Sod", "1000");
    await hours(j2, ana, "2026-06-20", "08:00", "12:00", rates);

    const j3 = await finishedJob("install", "2026-06-21", "5000.0000");
    await line(j3, "part", "Block", "100");

    const j4 = await finishedJob("install", "2026-06-22", "4000.0000");
    await hours(j4, ana, "2026-06-22", "08:00", "12:00", null);

    const j5 = await finishedJob("install", "2026-06-23", "3000.0000");
    await line(j5, "part", "Unpriced part", null);
    await hours(j5, ana, "2026-06-23", "08:00", "12:00", rates);

    const j6 = await finishedJob("install", "2026-06-24", "2000.0000");
    await line(j6, "part", "Nobody decided", "50", { billed: true });
    await hours(j6, ana, "2026-06-24", "08:00", "12:00", rates);

    const j7 = await finishedJob("install", "2026-06-25", "7000.0000");
    await hours(j7, ana, "2026-06-25", "08:00", "12:00", rates);
    await raw`insert into public.timeclock_entry (organization_id, technician_id, job_id, kind, started_at)
              values (${ORG}, ${ana}, ${j7}, 'on_site', '2026-06-25T20:00:00Z')`;

    const j8 = await finishedJob("service", "2026-06-26", "9000.0000");
    await hours(j8, ana, "2026-06-26", "08:00", "12:00", rates);

    const j9 = await finishedJob("install", "2026-07-02", "8000.0000");
    await hours(j9, ana, "2026-07-02", "08:00", "12:00", rates);

    const j10 = await finishedJob("install", "2026-06-27", "0", { warranty: true });
    await line(j10, "part", "Replacement", "300");
    await hours(j10, ana, "2026-06-27", "08:00", "10:00", rates);

    const card = await kpis.scorecard(owner(), WINDOW);
    const margin = card.computed.find((k) => k.key === "install_gross_margin")!;
    expect(margin.numerator).toBe("9798.0000");
    expect(margin.denominator).toBe("16000.0000");
    expect(margin.value).toBe("61.2");
    expect(margin.numeratorMoney).toBe(true);
    expect(margin.denominatorMoney).toBe(true);

    // The pure definition, over the facts the fixture was built from, gives the same two halves.
    const usd = (v: string) => ({ revenue: v });
    void usd;
    const { reporting, money: m } = await import("@opentradesos/core");
    const job = (revenue: string, material: string, labour: string, burden: string, over: Partial<import("@opentradesos/core").reporting.InstallJob> = {}) => ({
      revenue: m.money(revenue), material: m.money(material), labour: m.money(labour), burden: m.money(burden),
      openPunches: 0, unpricedLabourHours: 0, undecidedLines: 0, uncostedLines: 0, labourRecorded: true, ...over,
    });
    const oracle = reporting.installMargin([
      job("10000", "4300", "320", "24"),
      job("6000", "1000", "160", "12"),
      job("5000", "100", "0", "0", { labourRecorded: false }),
      job("4000", "0", "0", "0", { unpricedLabourHours: 4 }),
      job("3000", "0", "160", "12", { uncostedLines: 1 }),
      job("2000", "50", "160", "12", { undecidedLines: 1 }),
      job("7000", "0", "160", "12", { openPunches: 1 }),
      job("0", "300", "80", "6"),
    ]);
    expect(m.toString(oracle.earned)).toBe("9798.0000");
    expect(m.toString(oracle.revenue)).toBe("16000.0000");
    expect(oracle.percent).toBe(margin.value);

    // The records behind each half are exactly the jobs counted, and add up.
    const earned = await kpis.drill(owner(), { key: "install_gross_margin", half: "numerator", ...WINDOW });
    expect(earned.count).toBe(3);
    expect(Number(earned.total)).toBe(9798);
    expect(earned.records.map((r) => r.value).sort()).toEqual(["-386.0000", "4828.0000", "5356.0000"]);
    expect(earned.money).toBe(true);
    const revenue = await kpis.drill(owner(), { key: "install_gross_margin", half: "denominator", ...WINDOW });
    expect(revenue.records.map((r) => r.value).sort()).toEqual(["0.0000", "10000.0000", "6000.0000"]);
    expect(Number(revenue.total)).toBe(16000);
  });

  it("says nothing rather than a margin when no install has its costs in", async () => {
    await trade("lawn-and-landscape");
    const j = await finishedJob("install", "2026-06-05", "10000.0000");
    await line(j, "part", "Pavers", "2000");
    const card = await kpis.scorecard(owner(), WINDOW);
    const margin = card.computed.find((k) => k.key === "install_gross_margin")!;
    expect(margin.value).toBeNull();
    expect(margin.denominator).toBe("0.0000");
  });

  it("is a margin, so it takes what a job's margin takes, and says which permission is missing", async () => {
    await trade("lawn-and-landscape");
    const dispatcher = await kpis.scorecard(as("dispatcher"), WINDOW);
    expect(dispatcher.computed.map((k) => k.key)).not.toContain("install_gross_margin");
    const refused = dispatcher.unavailable.find((k) => k.key === "install_gross_margin")!;
    expect(refused.value).toBeNull();
    expect(refused.needs).toMatch(/See job cost, gross margin and profitability/);
    expect(refused.needs).toMatch(/View financial reports and P and L/);

    const only = as("dispatcher", ["job.cost:read"]);
    expect((await kpis.scorecard(only, WINDOW)).unavailable.find((k) => k.key === "install_gross_margin")!.needs)
      .not.toMatch(/See job cost/);

    await expect(kpis.drill(as("dispatcher"), { key: "install_gross_margin", half: "numerator", ...WINDOW }))
      .rejects.toThrow(/what each job cost and earned/);

    const accountant = await kpis.scorecard(as("accountant"), WINDOW);
    expect(accountant.computed.map((k) => k.key)).toContain("install_gross_margin");
  });

  it("counts a journal line a bookkeeper put on the job, and not the labour one", async () => {
    await trade("lawn-and-landscape");
    const ana = await technician("Ana");
    const j = await finishedJob("install", "2026-06-05", "1000.0000");
    await hours(j, ana, "2026-06-05", "08:00", "10:00", { loaded: "40", base: "30" });
    const book = (account: string, amount: string) => raw`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, currency, amount, source_type, source_id, job_id)
      select ${ORG}, t.id, '2026-06-05T15:00:00Z', d.direction, d.code, 'USD', ${amount}, 'journal', t.id, case when d.code = ${account} then ${j}::uuid end
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, ${account}), ('credit'::ledger_direction, '1000')) as d(direction, code)`;
    await book("5000", "100");
    // Hours are counted from the clock, so labour journalled to the job is not counted again.
    await book("5200", "900");
    const margin = (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "install_gross_margin")!;
    // 1000 less the 100 of subcontract, less two hours at 40: 820.
    expect(margin.numerator).toBe("820.0000");
    expect(margin.denominator).toBe("1000.0000");
  });
});
