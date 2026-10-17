import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as jobs from "../src/services/jobs";
import * as rentalBilling from "../src/services/rental-billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * REVENUE PER CONTAINER MONTH AND DISPOSAL COST PER HAUL, AND THE SHARE THEY
 * WAITED ON
 *
 * Both needed each container's share of what a job earned: a hire sold at a
 * flat price has its price on the job, and a swap chain puts several cans on
 * one job and one invoice. A hire's invoice now names the haul each of its
 * lines bills, and the office names the haul a job's own line bills. Revenue
 * is those lines on invoices issued and not voided, before tax, never a
 * permit. Disposal cost is the facility's fee on the haul over that revenue.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-container:org");
const USER = fixtureId("kpi-container:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as("owner");

let customerId = "";
const site: Record<string, string> = {};
let seq = 0;
const at = (day: string, time = "10:00") => raw.unsafe(`('${day} ${time}'::timestamp at time zone '${ZONE}')`);

async function container(identifier: string, size: string, over: { created?: string; retired?: string } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.rentable_asset (organization_id, asset_type, identifier, size, created_at, deleted_at, active)
    values (${ORG}, 'roll_off', ${identifier}, ${size}, ${at(over.created ?? "2026-01-01")},
            ${over.retired ? at(over.retired) : null}, ${!over.retired})
    returning id`;
  return row!.id;
}

async function haul(assetId: string, propertyId: string, delivered: string, picked: string | null,
  over: { fee?: string; facility?: string; ticket?: string; previous?: string } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.rental (organization_id, asset_id, property_id, delivered_at, picked_up_at, disposal_fee,
                               disposal_facility, disposal_ticket_number, previous_rental_id)
    values (${ORG}, ${assetId}, ${propertyId}, ${at(delivered)}, ${picked ? at(picked) : null}, ${over.fee ?? null},
            ${over.facility ?? null}, ${over.ticket ?? null}, ${over.previous ?? null})
    returning id`;
  return row!.id;
}

async function invoice(status: string, issuedOn: string): Promise<string> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.invoice (organization_id, number, customer_id, status, issued_on, due_on, total, balance)
    values (${ORG}, ${seq}, ${customerId}, ${status}::invoice_status, ${issuedOn}, ${issuedOn}, '0', '0') returning id`;
  return row!.id;
}

/** An invoice line, naming a haul itself (as a hire's invoice writes them) when given one. */
async function line(invoiceId: string, name: string, quantity: string, price: string,
  over: { rentalId?: string; discount?: string; tax?: string } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.invoice_line (organization_id, invoice_id, name, quantity, unit_price, discount_amount, tax_amount,
                                     line_total, rental_id)
    values (${ORG}, ${invoiceId}, ${name}, ${quantity}, ${price}, ${over.discount ?? "0"}, ${over.tax ?? "0"},
            (${quantity}::numeric * ${price}::numeric), ${over.rentalId ?? null})
    returning id`;
  return row!.id;
}

async function job(name: string, propertyId: string): Promise<string> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, 'completed', ${name}) returning id`;
  return row!.id;
}

/** A line on a job, billed on an invoice line when given one, naming a haul when given one. */
async function jobLine(jobId: string, name: string, price: string, over: { kind?: string; invoiceLineId?: string; rentalId?: string } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, invoice_line_id, rental_id)
    values (${ORG}, ${jobId}, ${over.kind ?? "other"}::job_line_kind, ${name}, '1', ${price}, ${over.invoiceLineId ?? null},
            ${over.rentalId ?? null})
    returning id`;
  return row!.id;
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Container Co", slug: "kpi-container-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'dumpster-rental' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'commercial', 'Builder Bob') returning id`;
  customerId = c!.id;
  for (const key of ["p1", "p2", "elsewhere"]) {
    const [p] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, ${`${key} Site Rd`}, 'Austin', 'TX', '78704') returning id`;
    site[key] = p!.id;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id, role, is_primary)
              values (${ORG}, ${customerId}, ${p!.id}, 'owner', true)`;
  }
});

/**
 * June, by hand.
 *
 * The fleet: C1, C2 and C3 all month (3 months), C4 joined on the 16th (half
 * a month), C5 retired on the 11th (ten days of thirty, a third). 3.8333
 * container months.
 *
 *   H1  C1 at P1, Jun 1 to Jun 8, fee 180 at Austin Transfer.
 *       Its hire invoice, issued Jun 9: the rental 475 less 10 off, extra days
 *       2 x 12, tax 40 held apart.                                        489
 *   H2  C2 swapped in at P1, Jun 8 to Jun 20, fee 220.
 *       Job J1's flat price 645 names it, invoiced Jun 21.                 645
 *       A permit on J1 names it, 35: passed through, not revenue.
 *       A trip fee on J1, 50, names no container: counted beside.
 *   H3  C3 at P2, Jun 2 to Jun 15, no fee recorded. 300 on a draft and 300
 *       on a voided invoice: not invoiced.
 *   H4  C4 at P2 from Jun 20, still on site; a standing month invoiced
 *       Jun 25.                                                             285
 *   H5  C1 at P2, Jun 22 to Jun 28, fee 150, nothing invoiced yet.
 *   H6  C2 collected Jul 2, fee 100, invoiced Jul 3: another month.
 *
 * Revenue per container month: 489 + 645 + 285 = 1419 over 3.8333 = 370.17.
 * Disposal cost: H1 and H2 count, 180 + 220 = 400 over 489 + 645 = 1134,
 * 35.3%. H3 is not known (no fee), H5 left out (not invoiced).
 */
async function june(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.C1 = await container("101", "20 yd");
  ids.C2 = await container("102", "30 yd");
  ids.C3 = await container("103", "10 yd");
  ids.C4 = await container("104", "20 yd", { created: "2026-06-16" });
  ids.C5 = await container("105", "15 yd", { retired: "2026-06-11" });

  ids.H1 = await haul(ids.C1, site.p1!, "2026-06-01", "2026-06-08", { fee: "180", facility: "Austin Transfer", ticket: "T-1" });
  ids.H2 = await haul(ids.C2, site.p1!, "2026-06-08", "2026-06-20", { fee: "220", previous: ids.H1 });
  ids.H3 = await haul(ids.C3, site.p2!, "2026-06-02", "2026-06-15");
  ids.H4 = await haul(ids.C4, site.p2!, "2026-06-20", null);
  ids.H5 = await haul(ids.C1, site.p2!, "2026-06-22", "2026-06-28", { fee: "150" });
  ids.H6 = await haul(ids.C2, site.p1!, "2026-06-25", "2026-07-02", { fee: "100" });

  const hire = await invoice("open", "2026-06-09");
  await line(hire, "Container 101, rental", "1", "475", { rentalId: ids.H1, discount: "10", tax: "40" });
  await line(hire, "Container 101, extra days", "2", "12", { rentalId: ids.H1 });

  ids.J1 = await job("Roll off for the remodel", site.p1!);
  await raw`insert into public.visit (organization_id, job_id, sequence, status, rental_id, rental_event)
            values (${ORG}, ${ids.J1}, 1, 'completed', ${ids.H1}, 'delivery')`;
  const jobInvoice = await invoice("paid", "2026-06-21");
  await jobLine(ids.J1, "30 yard, 28 day construction rate", "645", { invoiceLineId: await line(jobInvoice, "30 yard", "1", "645"), rentalId: ids.H2 });
  await jobLine(ids.J1, "Right of way permit", "35", { kind: "permit", invoiceLineId: await line(jobInvoice, "Permit", "1", "35"), rentalId: ids.H2 });
  await jobLine(ids.J1, "Trip fee", "50", { invoiceLineId: await line(jobInvoice, "Trip fee", "1", "50") });

  await line(await invoice("draft", "2026-06-16"), "Container 103", "1", "300", { rentalId: ids.H3 });
  await line(await invoice("void", "2026-06-16"), "Container 103", "1", "300", { rentalId: ids.H3 });
  await line(await invoice("open", "2026-06-25"), "Container 104, standing month", "1", "285", { rentalId: ids.H4 });
  await line(await invoice("open", "2026-07-03"), "Container 102", "1", "400", { rentalId: ids.H6 });
  return ids;
}

const card = async (key: string, ctx = owner()) => (await kpis.scorecard(ctx, WINDOW)).computed.find((k) => k.key === key)!;

run("revenue per container month", () => {
  it("is invoiced revenue naming a container over its months in the fleet, worked by hand", async () => {
    const ids = await june();
    const kpi = await card("revenue_per_container_month");
    expect(Number(kpi.numerator)).toBe(1419);
    expect(Number(kpi.denominator)).toBeCloseTo(3 + 0.5 + 1 / 3, 6);
    expect(kpi.value).toBe("370.1739");
    expect(kpi.besides).toEqual([expect.objectContaining({ key: "unknown", count: "1" })]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const revenue = await kpis.drill(owner(), { key: "revenue_per_container_month", half: "numerator", ...WINDOW });
    expect(Object.fromEntries(revenue.records.map((r) => [name(r.id), Number(r.value)]))).toEqual({ C1: 489, C2: 645, C4: 285 });
    expect(revenue.records.find((r) => name(r.id) === "C1")!.label).toBe("Container 101 (20 yd): 2 lines invoiced");
    const months = await kpis.drill(owner(), { key: "revenue_per_container_month", half: "denominator", ...WINDOW });
    expect(Object.fromEntries(months.records.map((r) => [name(r.id), Number(Number(r.value).toFixed(4))])))
      .toEqual({ C1: 1, C2: 1, C3: 1, C4: 0.5, C5: 0.3333 });
    expect(months.records.find((r) => name(r.id) === "C4")!.label).toBe("Container 104 (20 yd): 0.50 months in the fleet");
    const unnamed = await kpis.drill(owner(), { key: "revenue_per_container_month", half: "unknown", ...WINDOW });
    expect(unnamed.records.map((r) => r.href)).toEqual([`/jobs/${ids.J1}`]);
  });

  it("puts the same lines and containers through core's rule and gets the same answer", async () => {
    await june();
    const lines = await raw<{ rental_id: string; amount: string; status: string; permit: boolean; issued_on: string }[]>`
      select coalesce(il.rental_id, jl.rental_id) as rental_id,
             (il.quantity * il.unit_price - il.discount_amount - il.member_discount_amount)::text as amount,
             i.status::text as status, coalesce(jl.kind::text = 'permit', false) as permit, i.issued_on::text
      from public.invoice_line il join public.invoice i on i.id = il.invoice_id
      left join public.job_line jl on jl.invoice_line_id = il.id
      where il.organization_id = ${ORG} and coalesce(il.rental_id, jl.rental_id) is not null`;
    const revenue = reporting.haulRevenue(lines
      .filter((l) => l.issued_on >= WINDOW.from && l.issued_on <= WINDOW.to)
      .map((l) => ({ rentalId: l.rental_id, amount: Number(l.amount), invoiceStatus: l.status, permit: l.permit })));
    const fleet = await raw<{ joined: string; left_on: string | null }[]>`
      select least((ra.created_at at time zone ${ZONE})::date,
                   coalesce((select min((r.delivered_at at time zone ${ZONE})::date) from public.rental r where r.asset_id = ra.id), 'infinity'::date))::text as joined,
             ((ra.deleted_at at time zone ${ZONE})::date)::text as left_on
      from public.rentable_asset ra where ra.organization_id = ${ORG}`;
    const months = fleet.reduce((sum, c) => sum + reporting.containerMonths({ joined: c.joined, left: c.left_on }, WINDOW), 0);
    const kpi = await card("revenue_per_container_month");
    expect(Number(kpi.numerator)).toBeCloseTo([...revenue.values()].reduce((a, b) => a + b, 0), 4);
    expect(Number(kpi.denominator)).toBeCloseTo(months, 6);
  });
});

run("disposal cost as a percent of revenue", () => {
  it("is the facility's fee on each collected haul over what was invoiced on it, worked by hand", async () => {
    const ids = await june();
    const kpi = await card("disposal_cost_pct");
    expect([Number(kpi.numerator), Number(kpi.denominator), kpi.value]).toEqual([400, 1134, "35.3"]);
    expect(kpi.besides).toEqual([
      expect.objectContaining({ key: "unknown", count: "1" }),
      expect.objectContaining({ key: "excluded", count: "1" }),
    ]);
    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const fees = await kpis.drill(owner(), { key: "disposal_cost_pct", half: "numerator", ...WINDOW });
    expect(Object.fromEntries(fees.records.map((r) => [name(r.id), Number(r.value)]))).toEqual({ H1: 180, H2: 220 });
    expect(fees.records.find((r) => name(r.id) === "H1")!.label)
      .toBe("Container 101 (20 yd), collected Jun 8, Austin Transfer, ticket T-1");
    const revenue = await kpis.drill(owner(), { key: "disposal_cost_pct", half: "denominator", ...WINDOW });
    expect(Object.fromEntries(revenue.records.map((r) => [name(r.id), Number(r.value)]))).toEqual({ H1: 489, H2: 645 });
    expect((await kpis.drill(owner(), { key: "disposal_cost_pct", half: "unknown", ...WINDOW })).records.map((r) => name(r.id))).toEqual(["H3"]);
    expect((await kpis.drill(owner(), { key: "disposal_cost_pct", half: "excluded", ...WINDOW })).records.map((r) => name(r.id))).toEqual(["H5"]);
  });

  it("puts the same hauls through core's rule and gets the same answer", async () => {
    await june();
    const hauls = await raw<{ id: string; fee: string | null; picked: string }[]>`
      select id, disposal_fee::text as fee, ((picked_up_at at time zone ${ZONE})::date)::text as picked
      from public.rental where organization_id = ${ORG} and picked_up_at is not null`;
    const lines = await raw<{ rental_id: string; amount: string; status: string; permit: boolean }[]>`
      select coalesce(il.rental_id, jl.rental_id) as rental_id,
             (il.quantity * il.unit_price - il.discount_amount - il.member_discount_amount)::text as amount,
             i.status::text as status, coalesce(jl.kind::text = 'permit', false) as permit
      from public.invoice_line il join public.invoice i on i.id = il.invoice_id
      left join public.job_line jl on jl.invoice_line_id = il.id
      where il.organization_id = ${ORG} and coalesce(il.rental_id, jl.rental_id) is not null`;
    const revenue = reporting.haulRevenue(lines.map((l) => ({
      rentalId: l.rental_id, amount: Number(l.amount), invoiceStatus: l.status, permit: l.permit,
    })));
    let cost = 0;
    let earned = 0;
    for (const h of hauls.filter((x) => x.picked >= WINDOW.from && x.picked <= WINDOW.to)) {
      const verdict = reporting.disposalHaulOf({ fee: h.fee === null ? null : Number(h.fee), revenue: revenue.get(h.id) });
      if (!verdict.counted) continue;
      cost += verdict.cost;
      earned += verdict.revenue;
    }
    const kpi = await card("disposal_cost_pct");
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([cost, earned]);
  });

  it("is what a haul cost, so it takes what a job's margin takes", async () => {
    await june();
    const refused = (await kpis.scorecard(as("dispatcher"), WINDOW)).unavailable.find((k) => k.key === "disposal_cost_pct")!;
    expect(refused.needs).toMatch(/what jobs cost/);
  });
});

run("naming the container a line bills", () => {
  it("is done on the job by somebody who may change it, for a container at the job's own address, and audited", async () => {
    const c = await container("201", "20 yd");
    const here = await haul(c, site.p1!, "2026-06-01", "2026-06-08");
    const there = await haul(c, site.elsewhere!, "2026-06-10", null);
    const j = await job("Flat price hire", site.p1!);
    const l = await jobLine(j, "20 yard, 7 day", "475");

    const named = await jobs.nameHaul(owner(), { id: l, rentalId: here });
    expect(named.rentalId).toBe(here);
    expect((await jobs.lines(owner(), { id: j })).data[0]!.rentalId).toBe(here);
    expect((await jobs.haulsAt(owner(), { jobId: j })).map((h) => h.label))
      .toEqual(["Container 201 (20 yd), on site from 2026-06-01 to 2026-06-08"]);
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${l} and action = 'job_line.haul_named'`;
    expect(audited.length).toBe(1);
    /** Naming it again changes nothing and writes nothing. */
    await jobs.nameHaul(owner(), { id: l, rentalId: here });
    expect((await raw`select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${l} and action = 'job_line.haul_named'`).length).toBe(1);

    await expect(jobs.nameHaul(owner(), { id: l, rentalId: there })).rejects.toBeInstanceOf(ConflictError);
    await expect(jobs.nameHaul(as("technician"), { id: l, rentalId: null })).rejects.toThrow(/job:write/);
    expect((await jobs.nameHaul(owner(), { id: l, rentalId: null })).rentalId).toBeNull();
  });

  it("is written on every line of a hire's own invoice", async () => {
    const c = await container("301", "20 yd");
    const [hire] = await raw<{ id: string }[]>`
      insert into public.rental (organization_id, asset_id, property_id, delivered_at, picked_up_at, included_days, daily_rate, overage_rate)
      values (${ORG}, ${c}, ${site.p1!}, ${at("2026-06-01")}, ${at("2026-06-10")}, 7, '20', '12') returning id`;
    const raised = await rentalBilling.invoiceHire({ ...owner(), idempotencyKey: `hire-${crypto.randomUUID()}` }, { id: hire!.id });
    const lines = await raw<{ rental_id: string | null }[]>`
      select rental_id from public.invoice_line where invoice_id = ${raised.invoiceId}`;
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.rental_id === hire!.id)).toBe(true);
  });
});
