import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import * as kpis from "../src/services/kpis";
import * as tradePack from "../src/services/trade-pack";
import * as visits from "../src/services/visits";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TROUBLESHOOTING CONVERSION, AND WHERE THE FAULT WAS
 *
 * Electrical's "troubleshooting calls that produced approved repair work on
 * the same visit, divided by all troubleshooting calls. Excludes calls where
 * the fault was found in equipment another trade owns." The pack now marks its
 * troubleshooting call and the charges for finding a fault, and its service
 * report asks where the fault was; the figure reads both.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-diag:org");
const USER = fixtureId("kpi-diag:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
const types = new Map<string, string>();
const items = new Map<string, string>();
let seq = 0;

/** A local wall clock time in Austin. */
const local = (day: string, clock: string) => raw.unsafe(`('${day} ${clock}'::timestamp at time zone '${ZONE}')`);

async function item(code: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, code, kind) values (${ORG}, ${code}, 'service') returning id`;
  const [version] = await raw<{ id: string }[]>`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${row!.id}, 1, ${code}, '100', now() - interval '400 days') returning id`;
  return version!.id;
}

/**
 * A call of a job type, with one visit done on `day` from two to half past
 * three (no arrival when `untimed`), and what happened on it.
 */
async function call(name: string, opts: {
  type?: string; day?: string; untimed?: boolean;
  approvedAt?: string; lines?: (string | null)[]; fault?: string[];
} = {}): Promise<{ jobId: string; visitId: string }> {
  seq += 1;
  const day = opts.day ?? "2026-06-10";
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${types.get(opts.type ?? "diag")!}, 'completed', ${name}) returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, arrived_at, completed_at)
    values (${ORG}, ${job!.id}, 'completed', ${opts.untimed ? null : local(day, "14:00")}, ${local(day, "15:30")})
    returning id`;
  if (opts.approvedAt) {
    await raw`
      insert into public.estimate (organization_id, number, customer_id, property_id, job_id, status, title, currency, decided_at)
      values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${job!.id}, 'approved', 'Repair', 'USD', ${local(day, opts.approvedAt)})`;
  }
  for (const code of opts.lines ?? []) {
    await raw`
      insert into public.job_line (organization_id, job_id, visit_id, kind, name, quantity, unit_price, price_book_item_version_id)
      values (${ORG}, ${job!.id}, ${visit!.id}, 'labor', ${code ?? "Tightened the neutral"}, 1, 100, ${code ? items.get(code)! : null})`;
  }
  if (opts.fault?.length) {
    const [report] = await raw<{ id: string }[]>`
      insert into public.service_report (organization_id, visit_id, job_id, customer_id, property_id)
      values (${ORG}, ${visit!.id}, ${job!.id}, ${customerId}, ${propertyId}) returning id`;
    for (const [i, answer] of opts.fault.entries()) {
      await raw`
        insert into public.service_report_field (organization_id, report_id, property_id, key, label, kind, value_text, recorded_at)
        values (${ORG}, ${report!.id}, ${propertyId}, 'fault_location', 'Where the fault was', 'select', ${answer},
                ${local(day, "15:00")} + ${`${i} minutes`}::interval)`;
    }
  }
  return { jobId: job!.id, visitId: visit!.id };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  types.clear();
  items.clear();
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Diag Electric", slug: "kpi-diag-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'electrical' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Flick Ering', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '8 Volt Way', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  for (const code of ["diag", "repair"]) {
    const [row] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name, code, revenue_class) values (${ORG}, ${code}, ${code}, 'service') returning id`;
    types.set(code, row!.id);
  }
  for (const code of ["DIAG-STD", "BRK-20"]) items.set(code, await item(code));
});

const ELSEWHERE = reporting.FAULT_ELSEWHERE;
const OURS = "In our electrical work";

/**
 * The month, by hand. Each call's visit was on June 10th, arriving at two and
 * finished at half past three, unless it says otherwise.
 *
 *   T1   the customer signed for the repair at a quarter to three              converted
 *   T2   nothing                                                                not converted
 *   T3   signed at half past four, after the visit                              not converted
 *   T4   a breaker fitted on the visit                                          converted
 *   T5   only the troubleshooting charge on the visit                           not converted
 *   T6   the fault was in the furnace's board, and signed anyway                left out, counted beside
 *   T7   said another trade's at first, then ours, and signed on the visit     converted
 *   T8   finished from the office with no arrival, signed at three              not converted
 *   T9   a repair job, not a troubleshooting call                               not a call
 *   T10  done on July 2nd                                                       another month
 *   T11  signed during a second visit two days later                            not converted
 *   T12  a repair typed by hand on the visit                                    converted
 *
 *   Converted: T1 T4 T7 T12 = 4. Calls: T1 T2 T3 T4 T5 T7 T8 T11 T12 = 9.   4 / 9 = 44.4%
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.T1 = (await call("T1", { approvedAt: "14:45" })).jobId;
  ids.T2 = (await call("T2")).jobId;
  ids.T3 = (await call("T3", { approvedAt: "16:30" })).jobId;
  ids.T4 = (await call("T4", { lines: ["DIAG-STD", "BRK-20"] })).jobId;
  ids.T5 = (await call("T5", { lines: ["DIAG-STD"] })).jobId;
  ids.T6 = (await call("T6", { approvedAt: "14:45", fault: [ELSEWHERE] })).jobId;
  ids.T7 = (await call("T7", { approvedAt: "14:30", fault: [ELSEWHERE, OURS] })).jobId;
  ids.T8 = (await call("T8", { untimed: true, approvedAt: "15:00" })).jobId;
  ids.T9 = (await call("T9", { type: "repair", approvedAt: "14:45" })).jobId;
  ids.T10 = (await call("T10", { day: "2026-07-02", approvedAt: "14:45" })).jobId;
  const t11 = await call("T11");
  ids.T11 = t11.jobId;
  await raw`
    insert into public.visit (organization_id, job_id, sequence, status, arrived_at, completed_at)
    values (${ORG}, ${t11.jobId}, 2, 'completed', ${local("2026-06-12", "09:00")}, ${local("2026-06-12", "11:00")})`;
  await raw`
    insert into public.estimate (organization_id, number, customer_id, property_id, job_id, status, title, currency, decided_at)
    values (${ORG}, 911, ${customerId}, ${propertyId}, ${t11.jobId}, 'approved', 'Repair', 'USD', ${local("2026-06-12", "10:00")})`;
  ids.T12 = (await call("T12", { lines: [null] })).jobId;
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "diag_conversion")!;

run("troubleshooting conversion", () => {
  it("counts calls that turned into repair work on the visit that found the fault, another trade's faults left out", async () => {
    const ids = await month();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["4", "9", "44.4"]);
    expect(kpi.besides).toEqual([expect.objectContaining({ key: "excluded", count: "1" })]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const drilled = async (half: "numerator" | "denominator" | "excluded") =>
      (await kpis.drill(owner(), { key: "diag_conversion", half, ...WINDOW })).records.map((r) => name(r.id)).sort();
    expect(await drilled("numerator")).toEqual(["T1", "T12", "T4", "T7"]);
    expect(await drilled("denominator")).toEqual(["T1", "T11", "T12", "T2", "T3", "T4", "T5", "T7", "T8"]);
    expect(await drilled("excluded")).toEqual(["T6"]);
  });

  it("puts the same calls through core's rule and gets the same answer", async () => {
    await month();
    const jobs = await raw<{ id: string; code: string }[]>`
      select j.id, jt.code from public.job j join public.job_type jt on jt.id = j.job_type_id where j.organization_id = ${ORG}`;
    const marked = packById("electrical")!.jobTypes.filter((t) => (t.marks ?? []).includes("troubleshooting")).map((t) => t.code);
    const charges = packById("electrical")!.priceBook.filter((i) => (i.marks ?? []).includes("troubleshooting")).map((i) => i.code);
    const counts = { converted: 0, not_converted: 0, excluded: 0 };
    for (const job of jobs.filter((j) => marked.includes(j.code))) {
      const [first] = await raw<{ id: string; arrived_at: Date | null; completed_at: Date }[]>`
        select id, arrived_at, completed_at from public.visit where job_id = ${job.id} order by completed_at limit 1`;
      const day = first!.completed_at.toLocaleDateString("en-CA", { timeZone: ZONE });
      if (day < WINDOW.from || day > WINDOW.to) continue;
      const approvals = await raw<{ decided_at: Date }[]>`select decided_at from public.estimate where job_id = ${job.id}`;
      const lines = await raw<{ code: string | null }[]>`
        select pi.code from public.job_line jl
        left join public.price_book_item_version v on v.id = jl.price_book_item_version_id
        left join public.price_book_item pi on pi.id = v.item_id where jl.visit_id = ${first!.id}`;
      const [fault] = await raw<{ value_text: string }[]>`
        select f.value_text from public.service_report r join public.service_report_field f on f.report_id = r.id
        where r.job_id = ${job.id} and f.key = ${reporting.FAULT_LOCATION} order by f.recorded_at desc limit 1`;
      counts[reporting.troubleshootingOf({
        visit: { arrivedAt: first!.arrived_at, completedAt: first!.completed_at },
        approvedAt: approvals.map((a) => a.decided_at),
        repairOnVisit: lines.some((l) => l.code === null || !charges.includes(l.code)),
        faultLocation: fault?.value_text ?? null,
      })] += 1;
    }
    const kpi = await figure();
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([counts.converted, counts.converted + counts.not_converted]);
    expect(Number(kpi.besides![0]!.count)).toBe(counts.excluded);
  });

  it("shows the office the last answer to where the fault was, on the visit", async () => {
    const { visitId } = await call("Shown", { fault: [ELSEWHERE, OURS] });
    const page = await visits.get(owner(), { id: visitId });
    expect(page.reports[0]!.readings).toEqual([{ key: "fault_location", label: "Where the fault was", value: OURS }]);
  });

  it("asks where the fault was on every electrical company's service report, from the pack", async () => {
    await raw`delete from public.service_report_template where organization_id = ${ORG}`;
    await tradePack.applyTradePack(owner(), "electrical");
    const [template] = await raw<{ fields: { key: string; kind: string; options?: string[] }[] }[]>`
      select fields from public.service_report_template where organization_id = ${ORG} and trade_pack_id like 'electrical@%'`;
    const where = template!.fields.find((f) => f.key === reporting.FAULT_LOCATION);
    expect(where).toMatchObject({ kind: "select" });
    expect(where!.options).toContain(reporting.FAULT_ELSEWHERE);
  });
});
