import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as trucks from "../src/services/trucks";
import * as assets from "../src/services/assets";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * HAULS PER TRUCK DAY
 *
 * "Completed haul events divided by truck days worked, taken from the driver
 * timeclock rather than the roster. Dry runs and blocked trips do NOT count as
 * hauls, but track them separately." It was missing one datum, who is a driver,
 * and that is now the custody of a vehicle with a kind of truck.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("hpt:org");
const USER = fixtureId("hpt:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

let customerId = "";
let propertyId = "";
let seq = 0;
const jobTypes: Record<string, string> = {};

async function person(name: string): Promise<string> {
  seq += 1;
  const [u] = await raw<{ id: string }[]>`insert into public."user" (email, name) values (${`hpt-${seq}-${Date.now()}@kpi.test`}, ${name}) returning id`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${u!.id}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, active) values (${ORG}, ${m!.id}, ${name}, true) returning id`;
  return t!.id;
}

async function clockedIn(technicianId: string, day: string, kind = "on_site") {
  await raw`insert into public.timeclock_entry (organization_id, technician_id, kind, started_at, ended_at, minutes)
    values (${ORG}, ${technicianId}, ${kind}::time_entry_kind, ${`${day}T13:00:00Z`}::timestamptz, ${`${day}T21:00:00Z`}::timestamptz, 480)`;
}

/** A haul visit by a technician, on a day, with this status. */
async function haul(technicianId: string, day: string, code: string, status = "completed", event: string | null = code) {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${jobTypes[code]!}, 'completed', 'Haul') returning id`;
  const at = `${day}T16:00:00Z`;
  const [v] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, arrived_at, completed_at, rental_event)
    values (${ORG}, ${job!.id}, ${status}::visit_status, ${at}::timestamptz, ${at}::timestamptz,
            ${at}::timestamptz, ${status === "completed" ? at : null}::timestamptz, ${event}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${technicianId}, true)`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Haul Count", slug: "hauls-per-truck-day-co" });
  await raw`update public.organization set timezone = 'America/Chicago', primary_trade = 'dumpster-rental' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name, type) values (${ORG}, 'Site Works', 'commercial') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code) values (${ORG}, '1 Pit Rd', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!.id;
  for (const code of ["delivery", "pickup", "swap", "dump-return", "relocate"]) {
    const [jt] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model) values (${ORG}, ${code}, ${code}, 'asset_rental') returning id`;
    jobTypes[code] = jt!.id;
  }
  const [jt] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model) values (${ORG}, 'Repair', 'yard-repair', 'technician_dispatch') returning id`;
  jobTypes["yard-repair"] = jt!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("hauls per truck day", () => {
  it("counts hauls by drivers on a truck over their truck days, and the dry runs beside it", async () => {
    const kind = await trucks.createKind(owner(), { name: "Roll off", containersCarried: 1, yardMinutes: 20 });
    const truck = await assets.registerAsset(owner(), { kind: "vehicle", label: "Truck 1" });
    await trucks.setTruckKind(owner(), { assetId: truck.id, truckKindId: kind.id });
    const driver = await person("Dee Driver");
    const office = await person("Olive Office");
    await assets.checkOut(owner(), { assetId: truck.id, custodianKind: "technician", custodianId: driver, on: "2026-06-01" });

    /** Two truck days, the second with a day off between them that is not clocked. */
    await clockedIn(driver, "2026-06-10");
    await clockedIn(driver, "2026-06-11");
    /** The office clocks in too, and is not a truck day. */
    await clockedIn(office, "2026-06-10");

    /** Five hauls by the driver across the two days. */
    for (const code of ["delivery", "delivery", "pickup", "swap", "dump-return"]) await haul(driver, code === "pickup" ? "2026-06-11" : "2026-06-10", code);
    /** A relocation with no rental leg on the visit counts by the job type. */
    await haul(driver, "2026-06-11", "relocate", "completed", null);
    /** A haul done by somebody with no truck is not a driver's haul. */
    await haul(office, "2026-06-10", "delivery");
    /** A repair is not a haul. */
    await haul(driver, "2026-06-10", "yard-repair", "completed", null);
    /** The truck arrived and the haul did not happen: a dry run, counted beside and not in the number. */
    await haul(driver, "2026-06-11", "delivery", "no_show");
    /** Outside the window. */
    await haul(driver, "2026-07-02", "delivery");

    const card = await kpis.scorecard(owner(), WINDOW);
    const row = card.computed.find((r) => r.key === "hauls_per_truck_day")!;
    expect(row.numerator).toBe("6");
    expect(row.denominator).toBe("2");
    expect(row.value).toBe("3.00");
    expect(row.besides).toEqual([expect.objectContaining({ key: "excluded", count: "1" })]);
    expect(card.unavailable.map((r) => r.key)).not.toContain("hauls_per_truck_day");
  });

  it("is not a truck day before the truck was handed over or after it was handed back or retired", async () => {
    const lateDriver = await person("Lee Late");
    const [truck] = await raw<{ id: string }[]>`select id from public.company_asset where organization_id = ${ORG} and label = 'Truck 1'`;
    /** Truck 1 is with Dee until Lee takes it on the 20th, so the 18th is Dee's and the 25th is Lee's. */
    await assets.handOver(owner(), { assetId: truck!.id, custodianKind: "technician", custodianId: lateDriver, on: "2026-06-20" });
    await clockedIn(lateDriver, "2026-06-18");
    await clockedIn(lateDriver, "2026-06-25");
    const card = await kpis.scorecard(owner(), WINDOW);
    const row = card.computed.find((r) => r.key === "hauls_per_truck_day")!;
    /** Dee's two days and Lee's one: the 18th, before Lee had the truck, is not a truck day. */
    expect(row.denominator).toBe("3");
  });

  it("reports nothing rather than nought for a window with no truck days", async () => {
    const card = await kpis.scorecard(owner(), { from: "2026-01-01", to: "2026-01-31" });
    const row = card.computed.find((r) => r.key === "hauls_per_truck_day")!;
    expect(row.denominator).toBe("0");
    expect(row.value).toBeNull();
  });
});
