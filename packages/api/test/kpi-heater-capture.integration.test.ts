import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import * as kpis from "../src/services/kpis";
import * as inspections from "../src/services/inspections";
import * as equipment from "../src/services/equipment";
import { HEATER_CATEGORIES } from "../src/services/kpi-catalogue";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WATER HEATER OPPORTUNITY CAPTURE, AND WHY THE CUSTOMER SAID NO
 *
 * Plumbing's "water heaters replaced divided by water heaters recorded as over
 * ten years old and inspected in the period. Excludes units the customer has
 * already scheduled with someone else, so the ones nobody followed up on stay
 * visible." A declined recommendation now says why as a code, and booked with
 * another company is the one the figure leaves out.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-heater:org");
const USER = fixtureId("kpi-heater:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let jobTypeId = "";
let seq = 0;

async function unit(tag: string, installedOn: string | null, category = "Water heater"): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.equipment (organization_id, property_id, tag, category, installed_on)
    values (${ORG}, ${propertyId}, ${tag}, ${category}, ${installedOn}::date) returning id`;
  return row!.id;
}

async function job(status = "completed"): Promise<string> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${jobTypeId}, ${status}::job_status, 'Water heater') returning id`;
  return row!.id;
}

/** Worked on a visit completed at two in the afternoon on `day`. */
async function workedOn(equipmentId: string, day: string): Promise<void> {
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, completed_at)
    values (${ORG}, ${await job()}, 'completed', (${`${day} 14:00`}::timestamp at time zone ${ZONE})) returning id`;
  await raw`
    insert into public.visit_asset (organization_id, visit_id, equipment_id, outcome, completed_at)
    values (${ORG}, ${visit!.id}, ${equipmentId}, 'pass', now())`;
}

/** Named in an inspection performed on `day`. */
async function inspectedOn(equipmentId: string, day: string): Promise<void> {
  await raw`
    insert into public.inspection (organization_id, property_id, customer_id, performed_on, result, answers)
    values (${ORG}, ${propertyId}, ${customerId}, ${day}::date, 'pass',
            ${raw.json([{ itemKey: "tpr", value: "pass", equipmentId }])})`;
}

async function replaced(equipmentId: string, on: string, jobId: string | null): Promise<void> {
  await raw`
    insert into public.equipment_move (organization_id, equipment_id, from_property_id, reason, moved_on, job_id)
    values (${ORG}, ${equipmentId}, ${propertyId}, 'replaced', ${on}::date, ${jobId})`;
}

async function declined(equipmentId: string, on: string, code: string | null): Promise<void> {
  await raw`
    insert into public.deficiency (organization_id, property_id, customer_id, equipment_id, status, severity,
                                   description, found_on, declined_on, decline_reason, decline_code)
    values (${ORG}, ${propertyId}, ${customerId}, ${equipmentId}, 'declined', 'advisory',
            'Past its life, recommend replacing', ${on}::date, ${on}::date, 'Said no', ${code}::deficiency_decline_code)`;
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Heater Plumbing", slug: "kpi-heater-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'plumbing' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Hal Heater', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Boiler Rd', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class) values (${ORG}, 'Water heater', 'wh', 'install') returning id`;
  jobTypeId = type!.id;
});

/**
 * The month, by hand. Each heater was worked on, on a visit on June 10th,
 * unless it says otherwise.
 *
 *   H1   put in 2012, replaced on our job on the 20th                     caught        in both
 *   H2   put in 2013, nothing since                                       not followed  in the bottom
 *   H3   put in 2010, declined as booked with another company             left out, counted beside
 *   H4   put in 2020                                                      ten or under
 *   H5   no install date                                                  left out, counted beside as not known
 *   H6   put in 2011, inspected on the 5th, replaced on our job July 2nd  caught        in both
 *   H7   put in 2012, recorded replaced with no job of ours named         not caught    in the bottom
 *   H8   put in 2012, declined as too dear                                not followed  in the bottom
 *   H9   put in 2012, worked on in May only                               another month
 *   H10  a furnace put in 2005                                            not a water heater
 *   H11  put in 2012, replaced on a job of ours that was cancelled        not caught    in the bottom
 *   H12  put in 2009, declined as booked elsewhere, then replaced by us   caught        in both
 *
 *   Caught: H1 H6 H12 = 3. Old heaters inspected: H1 H2 H6 H7 H8 H11 H12 = 7.   3 / 7 = 42.9%
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const day = "2026-06-10";
  ids.H1 = await unit("H1", "2012-04-01"); await workedOn(ids.H1, day); await replaced(ids.H1, "2026-06-20", await job());
  ids.H2 = await unit("H2", "2013-04-01"); await workedOn(ids.H2, day);
  ids.H3 = await unit("H3", "2010-04-01"); await workedOn(ids.H3, day); await declined(ids.H3, day, "booked_elsewhere");
  ids.H4 = await unit("H4", "2020-04-01"); await workedOn(ids.H4, day);
  ids.H5 = await unit("H5", null); await workedOn(ids.H5, day);
  ids.H6 = await unit("H6", "2011-04-01"); await inspectedOn(ids.H6, "2026-06-05"); await replaced(ids.H6, "2026-07-02", await job());
  ids.H7 = await unit("H7", "2012-04-01"); await workedOn(ids.H7, day); await replaced(ids.H7, "2026-06-15", null);
  ids.H8 = await unit("H8", "2012-04-01"); await workedOn(ids.H8, day); await declined(ids.H8, day, "price");
  ids.H9 = await unit("H9", "2012-04-01"); await workedOn(ids.H9, "2026-05-20");
  ids.H10 = await unit("H10", "2005-04-01", "Furnace"); await workedOn(ids.H10, day);
  ids.H11 = await unit("H11", "2012-04-01"); await workedOn(ids.H11, day); await replaced(ids.H11, "2026-06-18", await job("cancelled"));
  ids.H12 = await unit("H12", "2009-04-01"); await workedOn(ids.H12, day);
  await declined(ids.H12, day, "booked_elsewhere"); await replaced(ids.H12, "2026-06-25", await job());
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "wh_attach")!;

run("water heater opportunity capture", () => {
  it("counts old heaters we replaced over old heaters inspected, the ones booked elsewhere left out", async () => {
    const ids = await month();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["3", "7", "42.9"]);
    expect(kpi.besides).toEqual([
      expect.objectContaining({ key: "excluded", count: "1" }),
      expect.objectContaining({ key: "unknown", count: "1" }),
    ]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const drilled = async (half: "numerator" | "denominator" | "excluded" | "unknown") =>
      (await kpis.drill(owner(), { key: "wh_attach", half, ...WINDOW })).records.map((r) => name(r.id)).sort();
    expect(await drilled("numerator")).toEqual(["H1", "H12", "H6"]);
    expect(await drilled("denominator")).toEqual(["H1", "H11", "H12", "H2", "H6", "H7", "H8"]);
    expect(await drilled("excluded")).toEqual(["H3"]);
    expect(await drilled("unknown")).toEqual(["H5"]);

    const h6 = (await kpis.drill(owner(), { key: "wh_attach", half: "numerator", ...WINDOW })).records.find((r) => r.id === ids.H6)!;
    expect(h6).toMatchObject({ href: `/equipment/${ids.H6}`, label: "H6 Water heater, put in 2011" });
  });

  it("puts the same heaters through core's rule and gets the same answer", async () => {
    await month();
    const units = await raw<{ id: string; category: string; installed_on: string | null }[]>`
      select id, category, installed_on::text from public.equipment where organization_id = ${ORG}`;
    const seen = await raw<{ equipment_id: string; d: string }[]>`
      select va.equipment_id::text, ((v.completed_at at time zone ${ZONE})::date)::text as d
      from public.visit_asset va join public.visit v on v.id = va.visit_id where va.organization_id = ${ORG}
      union all
      select a->>'equipmentId', i.performed_on::text from public.inspection i, jsonb_array_elements(i.answers) a
      where i.organization_id = ${ORG}`;
    const moves = await raw<{ equipment_id: string; moved_on: string; ours: boolean }[]>`
      select m.equipment_id::text, m.moved_on::text,
             (j.id is not null and j.status <> 'cancelled') as ours
      from public.equipment_move m left join public.job j on j.id = m.job_id
      where m.organization_id = ${ORG} and m.reason = 'replaced'`;
    const declines = await raw<{ equipment_id: string; declined_on: string; decline_code: string | null }[]>`
      select equipment_id::text, declined_on::text, decline_code::text from public.deficiency
      where organization_id = ${ORG} and status = 'declined'`;
    const counts = { replaced: 0, open: 0, booked_elsewhere: 0, unknown_age: 0, young: 0 };
    for (const u of units) {
      if (!HEATER_CATEGORIES.includes(u.category.toLowerCase())) continue;
      const days = seen.filter((s) => s.equipment_id === u.id && s.d >= WINDOW.from && s.d <= WINDOW.to).map((s) => s.d).sort();
      if (days.length === 0) continue;
      counts[reporting.heaterCaptureOf({
        installedOn: u.installed_on, inspectedOn: days[0]!,
        replacements: moves.filter((m) => m.equipment_id === u.id).map((m) => ({ movedOn: m.moved_on, byUs: m.ours })),
        declines: declines.filter((d) => d.equipment_id === u.id).map((d) => ({ declinedOn: d.declined_on, code: d.decline_code })),
      })] += 1;
    }
    const kpi = await figure();
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([counts.replaced, counts.replaced + counts.open]);
    expect(kpi.besides!.map((b) => Number(b.count))).toEqual([counts.booked_elsewhere, counts.unknown_age]);
  });

  it("reads the water heater the plumbing pack declares, by code or by name", () => {
    const declared = packById("plumbing")!.equipmentCategories.find((c) => c.code === "water-heater");
    expect(declared).toBeDefined();
    expect(HEATER_CATEGORIES).toEqual(["water-heater", "water heater"]);
  });
});

run("declining a finding, saying why", () => {
  async function finding(): Promise<{ deficiencyId: string; equipmentId: string }> {
    const equipmentId = await unit("WH", "2012-01-01");
    const [row] = await raw<{ id: string }[]>`
      insert into public.deficiency (organization_id, property_id, customer_id, equipment_id, status, severity, description, found_on)
      values (${ORG}, ${propertyId}, ${customerId}, ${equipmentId}, 'open', 'advisory', 'Tank weeping at the base', '2026-06-10')
      returning id`;
    return { deficiencyId: row!.id, equipmentId };
  }

  it("keeps the code, uses its words when none are typed, shows it on the unit and audits it", async () => {
    const { deficiencyId, equipmentId } = await finding();
    await inspections.setDeficiencyStatus(owner(), { id: deficiencyId, status: "declined", declineCode: "booked_elsewhere" });
    const [row] = await raw<{ decline_code: string; decline_reason: string; declined_on: string | null }[]>`
      select decline_code::text, decline_reason, declined_on::text from public.deficiency where id = ${deficiencyId}`;
    expect(row).toMatchObject({ decline_code: "booked_elsewhere", decline_reason: "Already booked with another company" });
    expect(row!.declined_on).not.toBeNull();

    const history = await equipment.history(owner(), { id: equipmentId });
    expect(history.deficiencies[0]).toMatchObject({ declineCode: "booked_elsewhere", description: "Tank weeping at the base" });
    const audited = await raw`select after from public.audit_log where organization_id = ${ORG} and entity_id = ${deficiencyId} and action = 'deficiency.status'`;
    expect(audited.length).toBe(1);
  });

  it("keeps the customer's own words beside the code", async () => {
    const { deficiencyId } = await finding();
    await inspections.setDeficiencyStatus(owner(), { id: deficiencyId, status: "declined", declineCode: "price", reason: "Getting three quotes" });
    const [row] = await raw<{ decline_code: string; decline_reason: string }[]>`
      select decline_code::text, decline_reason from public.deficiency where id = ${deficiencyId}`;
    expect(row).toEqual({ decline_code: "price", decline_reason: "Getting three quotes" });
  });

  it("refuses a code on anything but a decline, a decline with neither words nor code, and somebody who may not change findings", async () => {
    const { deficiencyId } = await finding();
    await expect(inspections.setDeficiencyStatus(owner(), { id: deficiencyId, status: "deferred", declineCode: "price" }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(inspections.setDeficiencyStatus(owner(), { id: deficiencyId, status: "declined" }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(inspections.setDeficiencyStatus(as("technician"), { id: deficiencyId, status: "declined", declineCode: "price" }))
      .rejects.toThrow(/compliance:write/);
  });
});
