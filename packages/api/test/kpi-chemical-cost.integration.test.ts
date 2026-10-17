import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as priceBook from "../src/services/pricebook";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import * as productsApplied from "../src/services/products-applied";
import { type ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * CHEMICAL COST PER STOP, AND THE REGISTER IT WAITED ON
 *
 * Pest control's "cost of product applied, valued from the product register,
 * divided by completed stops", leaving out devices, bait stations and
 * monitors. An application was a product typed by name, which nothing could
 * value. The company now marks the materials that are chemicals in its price
 * book, with the unit their cost is per and their EPA number, and the phone,
 * "My day" and the office choose the product applied from them. A typed
 * product is counted beside the figure, never valued from its name.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-chemical:org");
const OWNER = fixtureId("kpi-chemical:owner");
const ANA = fixtureId("kpi-chemical:ana");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

let customerId = "";
let propertyId = "";
let jobTypeId = "";
let internalTypeId = "";
let anaTech = "";
let seq = 0;
const item = { bifen: "", gel: "", nocost: "", station: "" };

/** The pest pack's product questions, as the job type's template asks them. */
const FIELDS = [
  { key: "product_applied", label: "Product applied, brand or product name", kind: "chemical", regulated: true, required: true },
  { key: "epa_reg_no", label: "EPA registration number of the product applied", kind: "chemical", regulated: true },
  { key: "stations_serviced", label: "Stations and devices serviced", kind: "numeric" },
];

const instant = (local: string) => raw.unsafe(`('${local}'::timestamp at time zone '${ZONE}')`);

/** A price book item with versions: each a cost in force from a local time. */
async function bookItem(code: string, name: string, kind: string, versions: Array<{ from: string; cost: string | null }>): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, ${kind}::item_kind, ${code}) returning id`;
  for (const [i, v] of versions.entries()) {
    const next = versions[i + 1];
    await raw`
      insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from, effective_to)
      values (${ORG}, ${row!.id}, ${i + 1}, ${name}, '20', ${v.cost}, ${instant(v.from)}, ${next ? instant(next.from) : null})`;
  }
  return row!.id;
}

/** A stop: a visit completed at two in the afternoon on a day, on its own job. */
async function stop(day: string, over: { status?: string; typeId?: string } = {}): Promise<string> {
  seq += 1;
  const at = instant(`${day} 14:00`);
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${over.typeId ?? jobTypeId}, 'completed', ${`Quarterly ${seq}`}, ${at}) returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, completed_at)
    values (${ORG}, ${job!.id}, 1, ${over.status ?? "completed"}::visit_status, ${at}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
            values (${ORG}, ${visit!.id}, ${anaTech}, true)`;
  return visit!.id;
}

/** An older record, or a product the book does not hold: a product typed by name on the visit's report. */
async function typed(visitId: string, product: string, quantity: string): Promise<void> {
  const [report] = await raw<{ id: string }[]>`
    insert into public.service_report (organization_id, visit_id, job_id, customer_id, property_id)
    select ${ORG}, v.id, v.job_id, ${customerId}, ${propertyId} from public.visit v where v.id = ${visitId} returning id`;
  await raw`
    insert into public.service_report_field (organization_id, report_id, property_id, key, label, kind,
                                             value_text, product_name, quantity_applied, application_unit)
    values (${ORG}, ${report!.id}, ${propertyId}, 'product_applied', 'Product applied', 'chemical',
            ${product}, ${product}, ${quantity}, 'gal')`;
}

const ana = () => as(ANA, ["technician"], { technicianId: anaTech });
let device = "";
let sequence = 0;
/** The phone records a product: the report's id made on the phone, the visit in the payload. */
async function onThePhone(visitId: string, reportId: string, payload: Record<string, unknown>, at: string) {
  sequence += 1;
  const result = await fieldOps.sync(ana(), {
    deviceId: device,
    operations: [{
      clientId: crypto.randomUUID(), sequence, kind: "service_report.set_field", subjectId: reportId,
      occurredAt: at, payload: { visitId, kind: "chemical", ...payload },
    }],
  });
  return result.results[0]!;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  sequence = 0;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Chemical Co", slug: "kpi-chemical-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'pest-control' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Pests') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Ant Hill', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class)
    values (${ORG}, 'Quarterly', 'recurring', 'recurring') returning id`;
  jobTypeId = type!.id;
  const [internal] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class)
    values (${ORG}, 'Shop day', 'shop', 'internal') returning id`;
  internalTypeId = internal!.id;
  await raw`insert into public.service_report_template (organization_id, name, job_type_id, fields)
            values (${ORG}, 'Quarterly', ${jobTypeId}, ${raw.json(FIELDS)})`;

  await raw`delete from public."user" where id = ${ANA}`;
  await raw`insert into public."user" (id, email, name) values (${ANA}, 'ana@kpi-chemical.test', 'Ana')`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${ANA}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, 'Ana') returning id`;
  anaTech = t!.id;
  device = (await fieldOps.register(ana(), { installationId: `ana-${crypto.randomUUID()}` })).deviceId;

  /** Bifenthrin's cost went from $3 to $4 a gallon on June 15. */
  item.bifen = await bookItem("BIFEN", "Bifen IT", "material", [{ from: "2026-01-01 00:00", cost: "3" }, { from: "2026-06-15 00:00", cost: "4" }]);
  item.gel = await bookItem("GEL", "Advion gel", "material", [{ from: "2026-01-01 00:00", cost: "2.5" }]);
  item.nocost = await bookItem("DUST", "Delta dust", "material", [{ from: "2026-01-01 00:00", cost: null }]);
  item.station = await bookItem("STATION", "Rodent bait station", "equipment", [{ from: "2026-01-01 00:00", cost: "17" }]);
  await priceBook.updateItem(owner(), { id: item.bifen, chemical: { unit: "gal", epaRegistrationNumber: "279-3206" } });
  await priceBook.updateItem(owner(), { id: item.gel, chemical: { unit: "oz", epaRegistrationNumber: "352-746" } });
  await priceBook.updateItem(owner(), { id: item.nocost, chemical: { unit: "lb", epaRegistrationNumber: null } });
});

/**
 * June, by hand.
 *
 *   S1  Jun 10  phone: Bifen 2 gal at $3, and Advion 4 oz at $2.50 (epa field)  6 + 10 = 16
 *   S2  Jun 20  phone: Bifen 1.5 gal at $4 (the new cost)                        6
 *   S3  Jun 21  nothing applied                                                  0, counted
 *   S4  Jun 22  Termidor typed by name, 1 gal                                     left out, beside
 *   S5  Jun 23  Delta dust from the book, no cost recorded                        left out, beside
 *   S6  Jun 24  phone: Bifen 1 gal, then corrected to 3 gal                      12
 *   S7  Jun 25  internal work, Bifen 5 gal                                        not customer work
 *   S8  Jun 26  cancelled visit, Bifen 5 gal                                      not a stop
 *   S9  Jun 27  office: Advion 2 oz                                               5
 *   S10 Jul 1   Bifen 5 gal                                                       another month
 *
 *   16 + 6 + 0 + 12 + 5 = $39 over 5 stops = $7.80 a stop.
 */
async function june(): Promise<Record<string, string>> {
  const s: Record<string, string> = {};
  s.S1 = await stop("2026-06-10");
  const r1 = crypto.randomUUID();
  await onThePhone(s.S1, r1, {
    field: "product_applied", label: "Product applied", priceBookItemId: item.bifen,
    value: "bifen", productName: "bifen", epaRegistrationNumber: "wrong", quantityApplied: "2", applicationUnit: "quarts",
  }, "2026-06-10T18:00:00Z");
  await onThePhone(s.S1, r1, {
    field: "epa_reg_no", label: "EPA registration number", priceBookItemId: item.gel, quantityApplied: "4",
  }, "2026-06-10T18:05:00Z");

  s.S2 = await stop("2026-06-20");
  await onThePhone(s.S2, crypto.randomUUID(), { field: "product_applied", priceBookItemId: item.bifen, quantityApplied: "1.5" }, "2026-06-20T18:00:00Z");
  s.S3 = await stop("2026-06-21");
  await onThePhone(s.S3, crypto.randomUUID(), { field: "stations_serviced", kind: "numeric", value: 4 }, "2026-06-21T18:00:00Z");
  s.S4 = await stop("2026-06-22");
  await typed(s.S4, "Termidor SC", "1");
  s.S5 = await stop("2026-06-23");
  await onThePhone(s.S5, crypto.randomUUID(), { field: "product_applied", priceBookItemId: item.nocost, quantityApplied: "1" }, "2026-06-23T18:00:00Z");
  s.S6 = await stop("2026-06-24");
  const r6 = crypto.randomUUID();
  await onThePhone(s.S6, r6, { field: "product_applied", priceBookItemId: item.bifen, quantityApplied: "1" }, "2026-06-24T18:00:00Z");
  await onThePhone(s.S6, r6, { field: "product_applied", priceBookItemId: item.bifen, quantityApplied: "3" }, "2026-06-24T18:10:00Z");
  s.S7 = await stop("2026-06-25", { typeId: internalTypeId });
  await onThePhone(s.S7, crypto.randomUUID(), { field: "product_applied", priceBookItemId: item.bifen, quantityApplied: "5" }, "2026-06-25T18:00:00Z");
  s.S8 = await stop("2026-06-26", { status: "cancelled" });
  await onThePhone(s.S8, crypto.randomUUID(), { field: "product_applied", priceBookItemId: item.bifen, quantityApplied: "5" }, "2026-06-26T18:00:00Z");
  s.S9 = await stop("2026-06-27");
  await productsApplied.record(owner(), { id: s.S9, field: "product_applied", priceBookItemId: item.gel, quantity: "2" });
  s.S10 = await stop("2026-07-01");
  await onThePhone(s.S10, crypto.randomUUID(), { field: "product_applied", priceBookItemId: item.bifen, quantityApplied: "5" }, "2026-07-01T18:00:00Z");
  return s;
}

const figure = async (ctx = owner()) => (await kpis.scorecard(ctx, WINDOW)).computed.find((k) => k.key === "chemical_cost_per_stop");

run("chemical cost per stop", () => {
  it("is product chosen from the book at its cost on the day, over completed stops, worked by hand", async () => {
    await june();
    const kpi = (await figure())!;
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["39.0000", "5", "7.8000"]);
    expect(kpi.besides).toEqual([expect.objectContaining({ key: "unknown", count: "2" })]);

    const cost = await kpis.drill(owner(), { key: "chemical_cost_per_stop", half: "numerator", ...WINDOW });
    expect(cost.total).toBe("39.0000");
    expect(cost.records.map((r) => [r.label, Number(r.value)])).toEqual([
      ["Advion gel, 2 oz at $2.50, #9 visit 1, Quarterly 9", 5],
      ["Bifen IT, 3 gal at $4.00, #6 visit 1, Quarterly 6", 12],
      ["Bifen IT, 1.5 gal at $4.00, #2 visit 1, Quarterly 2", 6],
      ["Advion gel, 4 oz at $2.50, #1 visit 1, Quarterly 1", 10],
      ["Bifen IT, 2 gal at $3.00, #1 visit 1, Quarterly 1", 6],
    ]);
    expect(cost.records.every((r) => r.kind === "visit" && r.href.startsWith("/visits/"))).toBe(true);
    const stops = await kpis.drill(owner(), { key: "chemical_cost_per_stop", half: "denominator", ...WINDOW });
    expect(stops.total).toBe("5");
    const left = await kpis.drill(owner(), { key: "chemical_cost_per_stop", half: "unknown", ...WINDOW });
    expect(left.records.map((r) => r.label)).toEqual([
      "#5 visit 1, Quarterly 5: 1 product with no cost that day",
      "#4 visit 1, Quarterly 4: 1 product typed by name",
    ]);
  });

  it("puts the same stops through core's rule and gets the same answer", async () => {
    await june();
    const rows = await raw<{ visit_id: string; quantity: string | null; unit: string | null; item_id: string | null; item_unit: string | null; cost: string | null }[]>`
      select s.id as visit_id, a.quantity_applied as quantity, a.application_unit as unit, a.price_book_item_id as item_id,
             i.chemical_unit as item_unit,
             (select ver.cost from public.price_book_item_version ver where ver.item_id = a.price_book_item_id
                and ver.effective_from <= s.completed_at and (ver.effective_to is null or ver.effective_to > s.completed_at)) as cost
      from public.visit s
      join public.job j on j.id = s.job_id and j.job_type_id = ${jobTypeId}
      left join lateral (
        select distinct on (f.report_id, f.key) f.* from public.service_report_field f
        join public.service_report r on r.id = f.report_id
        where r.visit_id = s.id and f.kind = 'chemical'
        order by f.report_id, f.key, f.recorded_at desc, f.created_at desc
      ) a on true
      left join public.price_book_item i on i.id = a.price_book_item_id
      where s.organization_id = ${ORG} and s.status = 'completed'
        and s.completed_at >= ${instant("2026-06-01 00:00")} and s.completed_at < ${instant("2026-07-01 00:00")}`;
    const byStop = new Map<string, reporting.ChemicalApplication[]>();
    for (const row of rows) {
      const list = byStop.get(row.visit_id) ?? [];
      if (row.quantity !== null || row.item_id !== null) {
        list.push({
          quantity: row.quantity === null ? null : Number(row.quantity), unit: row.unit, itemId: row.item_id,
          itemUnit: row.item_unit, costPerUnit: row.cost === null ? null : Number(row.cost),
        });
      }
      byStop.set(row.visit_id, list);
    }
    const verdict = reporting.chemicalCostPerStop([...byStop.values()]);
    const kpi = (await figure())!;
    expect([Number(kpi.numerator), Number(kpi.denominator), Number(kpi.besides![0]!.count)])
      .toEqual([verdict.cost, verdict.stops, verdict.notValued]);
  });

  it("is a figure about what work costs, refused to a reader who may not see it", async () => {
    await june();
    const dispatcher = as(OWNER, ["dispatcher"]);
    expect(await figure(dispatcher)).toBeUndefined();
    const named = (await kpis.scorecard(dispatcher, WINDOW)).unavailable.find((k) => k.key === "chemical_cost_per_stop");
    expect(named?.needs).toMatch(/job cost/);
  });
});

run("a chemical in the price book", () => {
  it("is a material marked with the unit its cost is per and its EPA number, audited, and taken off", async () => {
    const detail = await priceBook.detail(owner(), { id: item.bifen });
    expect(detail.chemical).toEqual({ unit: "gal", epaRegistrationNumber: "279-3206" });
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'pricebook.item_updated' and entity_id = ${item.bifen}`;
    expect(audited.length).toBe(1);

    await expect(priceBook.updateItem(owner(), { id: item.station, chemical: { unit: "each", epaRegistrationNumber: null } }))
      .rejects.toThrow(/Only a material/);
    await expect(priceBook.updateItem(owner(), { id: item.bifen, kind: "equipment" })).rejects.toThrow(/Take the chemical mark off first/);
    await expect(priceBook.updateItem(owner(), { id: item.gel, chemical: { unit: "  ", epaRegistrationNumber: null } }))
      .rejects.toThrow(/unit its cost is per/);
    await expect(priceBook.updateItem(as(ANA, ["technician"], { technicianId: anaTech }), { id: item.gel, chemical: null }))
      .rejects.toThrow(/pricebook:write/);

    const off = await priceBook.updateItem(owner(), { id: item.gel, chemical: null });
    expect(off?.chemical).toBeNull();
  });

  it("is offered to the phone with its unit and EPA number, and an item chosen carries the book's words", async () => {
    const visitId = await stop("2026-06-10");
    const snapshot = await dispatch.snapshot(ana(), { deviceId: device, from: "2026-06-10", days: 1 });
    expect(snapshot.priceBook.find((p) => p.id === item.bifen)?.chemical).toEqual({ unit: "gal", epaRegistrationNumber: "279-3206" });
    expect(snapshot.priceBook.find((p) => p.id === item.station)?.chemical).toBeNull();

    const reportId = crypto.randomUUID();
    const landed = await onThePhone(visitId, reportId, {
      field: "product_applied", priceBookItemId: item.bifen, productName: "typed", epaRegistrationNumber: "nope",
      quantityApplied: "2", applicationUnit: "oz", targetPest: "Ants", applicatorLicense: "TX-123",
    }, "2026-06-10T18:00:00Z");
    expect(landed.status).toBe("applied");
    /** A station is not a chemical: the phone's record is kept as typed, and not valued. */
    await onThePhone(visitId, reportId, {
      field: "epa_reg_no", priceBookItemId: item.station, productName: "Station", quantityApplied: "1",
    }, "2026-06-10T18:01:00Z");
    const rows = await raw<{ key: string; product_name: string; epa_registration_number: string | null; application_unit: string | null; price_book_item_id: string | null; target_pest: string | null; applicator_license: string | null }[]>`
      select key, product_name, epa_registration_number, application_unit, price_book_item_id, target_pest, applicator_license
      from public.service_report_field where report_id = ${reportId} order by key desc`;
    expect(rows).toEqual([
      { key: "product_applied", product_name: "Bifen IT", epa_registration_number: "279-3206", application_unit: "gal",
        price_book_item_id: item.bifen, target_pest: "Ants", applicator_license: "TX-123" },
      { key: "epa_reg_no", product_name: "Station", epa_registration_number: null, application_unit: null,
        price_book_item_id: null, target_pest: null, applicator_license: null },
    ]);
  });
});

run("a product recorded by the office", () => {
  it("is chosen from the book onto the visit's report, audited, and refused where it does not belong", async () => {
    const visitId = await stop("2026-06-12");
    const before = await productsApplied.forVisit(owner(), { id: visitId });
    expect(before.fields.map((f) => f.key)).toEqual(["product_applied", "epa_reg_no"]);
    expect(before.chemicals.map((c) => c.name)).toEqual(["Advion gel", "Bifen IT", "Delta dust"]);
    expect(before.reportId).toBeNull();

    const after = await productsApplied.record(owner(), {
      id: visitId, field: "product_applied", priceBookItemId: item.bifen, quantity: "1.25", targetPest: "Ants",
    });
    expect(after.applied).toEqual([expect.objectContaining({
      productName: "Bifen IT", epaRegistrationNumber: "279-3206", quantity: "1.2500", unit: "gal", targetPest: "Ants", fromBook: true,
    })]);
    const [report] = await raw<{ required_fields: unknown[] }[]>`select required_fields from public.service_report where id = ${after.reportId}`;
    expect(report!.required_fields).toEqual([{ key: "product_applied", label: FIELDS[0]!.label, kind: "chemical", regulated: true }]);
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'service_report.product_recorded'`;
    expect(audited.length).toBe(1);

    const record = (over: Partial<Parameters<typeof productsApplied.record>[1]>) => productsApplied.record(owner(), {
      id: visitId, field: "product_applied", priceBookItemId: item.bifen, quantity: "1", ...over,
    });
    await expect(record({ priceBookItemId: item.station })).rejects.toThrow(/not a chemical/);
    await expect(record({ quantity: "-2" })).rejects.toThrow(/more than nought/);
    await expect(record({ quantity: "lots" })).rejects.toThrow(/more than nought/);
    await expect(record({ field: "stations_serviced" })).rejects.toThrow(/does not ask/);
    await expect(productsApplied.record(as(OWNER, ["dispatcher"]), { id: visitId, field: "product_applied", priceBookItemId: item.bifen, quantity: "1" }))
      .rejects.toThrow(/servicereport:write/);

    await raw`update public.service_report set submitted_at = now(), published_at = now() where id = ${after.reportId}`;
    await expect(record({})).rejects.toThrow(/published/);

    const other = await stop("2026-06-12", { typeId: internalTypeId });
    await expect(productsApplied.record(owner(), { id: other, field: "product_applied", priceBookItemId: item.bifen, quantity: "1" }))
      .rejects.toThrow(/does not ask what product/);
  });
});
