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
