import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import { applicationFromBook, chemicalsIn, type PriceBookEntry } from "@opentradesos/field-client";
import * as priceBook from "../src/services/pricebook";
import * as kpis from "../src/services/kpis";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import { type ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * THE UNIT FOR A CHEMICAL CHOSEN IN THE FIELD
 *
 * A concentrate bought by the gallon and used by the ounce could be recorded
 * in either unit from the office's visit page, and only in the chemical's own
 * unit from the phone, which had no place to pick the other. The day now
 * carries the two units; the phone sends the one picked; the server keeps it
 * when it is the buy or the use unit, spelt as the book spells it, and values
 * it at the cost or the cost over the ratio, exactly as for the office.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("field-chem-units:org");
const OWNER = fixtureId("field-chem-units:owner");
const TECH = fixtureId("field-chem-units:tech");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

let technicianId = "";
let device = "";
let customerId = "";
let propertyId = "";
let jobTypeId = "";
let concentrate = "";
let gel = "";
let seq = 0;
const tech = () => as(TECH, ["technician"], { technicianId });

async function stop(day: string): Promise<string> {
  seq += 1;
  const at = `${day}T19:00:00Z`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${jobTypeId}, 'completed', ${`Quarterly ${seq}`}, ${at}) returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, completed_at, window_start)
    values (${ORG}, ${job!.id}, 1, 'completed', ${at}, ${at}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
            values (${ORG}, ${visit!.id}, ${technicianId}, true)`;
  return visit!.id;
}

let sequence = 0;
async function onThePhone(visitId: string, payload: Record<string, unknown>, at: string) {
  sequence += 1;
  const result = await fieldOps.sync(tech(), {
    deviceId: device,
    operations: [{
      clientId: crypto.randomUUID(), sequence, kind: "service_report.set_field", subjectId: crypto.randomUUID(),
      occurredAt: at, payload: { visitId, ...payload },
    }],
  });
  return result.results[0]!;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Field Units Co", slug: "field-chem-units-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'pest-control' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Una Units') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Ant Hill', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class)
    values (${ORG}, 'Quarterly', 'recurring', 'recurring') returning id`;
  jobTypeId = type!.id;
  await raw`insert into public.service_report_template (organization_id, name, job_type_id, fields)
            values (${ORG}, 'Quarterly', ${jobTypeId}, ${raw.json([
              { key: "product_applied", label: "Product applied", kind: "chemical", regulated: true, required: true },
              { key: "second_product", label: "Second product applied", kind: "chemical", regulated: true },
            ])})`;
  const [item] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', 'CONC') returning id`;
  concentrate = item!.id;
  await raw`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, buy_unit, use_unit, use_per_buy, effective_from)
    values (${ORG}, ${concentrate}, 1, 'Concentrate', '1.50', '40', 'gal', 'oz', '128', '2026-01-01T06:00:00Z')`;
  await priceBook.updateItem(owner(), { id: concentrate, chemical: { unit: "oz", epaRegistrationNumber: "100-1" } });
  const [g] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', 'GEL') returning id`;
  gel = g!.id;
  await raw`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
    values (${ORG}, ${gel}, 1, 'Advion gel', '20', '2.5', '2026-01-01T06:00:00Z')`;
  await priceBook.updateItem(owner(), { id: gel, chemical: { unit: "oz", epaRegistrationNumber: "352-746" } });

  await raw`delete from public."user" where id = ${TECH}`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, 'tia@field-chem-units.test', 'Tia')`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${TECH}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, 'Tia') returning id`;
  technicianId = t!.id;
  device = (await fieldOps.register(tech(), { installationId: `tia-${crypto.randomUUID()}` })).deviceId;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("a chemical chosen on the phone, in either unit", () => {
  it("carries both units to the phone, keeps the unit picked, and values it as the office's would be", async () => {
    const day = await dispatch.snapshot(tech(), { deviceId: device, from: "2026-06-10", days: 1 });
    expect(day.priceBook.find((p) => p.id === concentrate)?.chemical)
      .toEqual({ unit: "oz", epaRegistrationNumber: "100-1", units: { buy: "gal", use: "oz" } });
    /** A chemical with one unit carries nothing to pick. */
    expect(day.priceBook.find((p) => p.id === gel)?.chemical).toEqual({ unit: "oz", epaRegistrationNumber: "352-746" });

    /** The phone builds the payload from what it was sent, as the app and /my-day do. */
    const chosen = chemicalsIn(day.priceBook as PriceBookEntry[]).find((c) => c.id === concentrate)!;
    const question = { key: "product_applied", label: "Product applied" };

    const s1 = await stop("2026-06-10");
    expect(await onThePhone(s1, applicationFromBook(question, chosen, "16", "oz"), "2026-06-10T18:00:00Z"))
      .toMatchObject({ status: "applied" });
    expect(await onThePhone(s1, applicationFromBook({ key: "second_product", label: "Second product applied" }, chosen, "0.5", "GAL"),
      "2026-06-10T18:05:00Z")).toMatchObject({ status: "applied" });
    const s2 = await stop("2026-06-12");
    /** A unit that is neither is recorded in the chemical's own, as from the office. */
    expect(await onThePhone(s2, { ...applicationFromBook(question, chosen, "32"), applicationUnit: "quart" }, "2026-06-12T18:00:00Z"))
      .toMatchObject({ status: "applied" });

    const kept = await raw<{ key: string; quantity_applied: string; application_unit: string }[]>`
      select f.key, f.quantity_applied, f.application_unit from public.service_report_field f
      where f.organization_id = ${ORG} order by f.recorded_at`;
    expect(kept.map((k) => [k.key, Number(k.quantity_applied), k.application_unit])).toEqual([
      ["product_applied", 16, "oz"], ["second_product", 0.5, "gal"], ["product_applied", 32, "oz"],
    ]);

    const [kpi] = (await kpis.scorecard(owner(), { from: "2026-06-01", to: "2026-06-30" })).computed
      .filter((k) => k.key === "chemical_cost_per_stop");
    /** Stop one: 16 oz at 0.3125 and half a gallon at 40, 25.00. Stop two: 32 oz, 10.00. */
    expect([kpi!.numerator, kpi!.denominator, kpi!.value]).toEqual(["35.0000", "2", "17.5000"]);
  });
});
