import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as truckWater from "../src/services/truck-water";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * FRESH WATER PER STOP, PER TRUCK, AND THE READING IT WAITED ON
 *
 * The trash bin trade's "fresh water used divided by completed stops, per
 * truck". Nothing recorded water. A truck's day now has the fresh water its
 * driver read off the tank (`truck_water_day`), on the phone or typed by the
 * office, and its stops are the visits completed by whoever had it checked
 * out that day. A day with stops and no reading is out of both halves and
 * counted beside, never read as no water.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-water:org");
const OWNER = fixtureId("kpi-water:owner");
const ANA = fixtureId("kpi-water:ana");
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
let jobNumber = 0;
const tech: Record<string, string> = {};
const truck: Record<string, string> = {};

async function technician(name: string, userId: string | null = null): Promise<string> {
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId ?? (await newUser(name))}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

async function newUser(name: string): Promise<string> {
  const [u] = await raw<{ id: string }[]>`
    insert into public."user" (email, name) values (${`${name.toLowerCase()}-${crypto.randomUUID()}@kpi-water.test`}, ${name}) returning id`;
  return u!.id;
}

async function vehicle(label: string, over: { kind?: string; retiredOn?: string } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.company_asset (organization_id, kind, label, retired_on)
    values (${ORG}, ${over.kind ?? "vehicle"}::asset_kind, ${label}, ${over.retiredOn ?? null}) returning id`;
  return row!.id;
}

/** A truck checked out to a technician, half open. */
async function hand(assetId: string, technicianId: string, from: string, until: string | null = null): Promise<void> {
  await raw`
    insert into public.asset_custody (organization_id, asset_id, custodian_kind, custodian_id, held_from, held_until)
    values (${ORG}, ${assetId}, 'technician', ${technicianId}, ${from}, ${until})`;
}

/** A stop: a visit completed at four in the afternoon on a day, sent to a person or a crew. */
async function stop(day: string, to: { technician?: string; crew?: string }, status = "completed"): Promise<void> {
  jobNumber += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary, completed_at)
    values (${ORG}, ${jobNumber}, ${customerId}, ${propertyId}, 'completed', ${`Bins ${jobNumber}`},
            (${`${day} 16:00`}::timestamp at time zone ${ZONE})) returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, crew_id, completed_at)
    values (${ORG}, ${job!.id}, 1, ${status}::visit_status, ${to.crew ?? null},
            (${`${day} 16:00`}::timestamp at time zone ${ZONE})) returning id`;
  if (to.technician) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${visit!.id}, ${to.technician}, true)`;
  }
}

const read = (assetId: string, onDay: string, gallons: string) => truckWater.record(owner(), { assetId, onDay, gallons });

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
  jobNumber = 0;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Water Co", slug: "kpi-water-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'trash-bin-cleaning' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Bins') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Bin Row', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  await raw`delete from public."user" where id = ${ANA}`;
  await raw`insert into public."user" (id, email, name) values (${ANA}, 'ana@kpi-water.test', 'Ana')`;
  tech.ana = await technician("Ana", ANA);
  tech.ben = await technician("Ben");
  tech.cy = await technician("Cy");
  truck.t1 = await vehicle("Truck 1");
  truck.t2 = await vehicle("Truck 2");
});

/**
 * June, by hand.
 *
 *   Truck 1, Ana's all month:
 *     Jun 10  3 stops, 18 gallons                        counted
 *     Jun 11  2 stops (one a crew stop Ana is on), 12    counted
 *     Jun 12  4 stops, no reading                        not read, beside
 *     Jun 13  no stop, 30 gallons (tank flushed)          no stop, beside
 *     Jun 10  a cancelled visit                           no stop
 *   Truck 2, Ben's until Jun 11, then Cy's:
 *     Jun 10  Ben, 2 stops, 16 gallons                    counted
 *     Jun 11  Cy, 1 stop, 9 gallons                       counted
 *     Jun 11  Ben, 1 stop on no truck                     no truck's stop
 *   July 1, Truck 1, 2 stops and 10 gallons               another month
 *
 *   Truck 1: 30 gallons over 5 stops, 6.0 a stop. Truck 2: 25 over 3, 8.3.
 *   Together 55 / 8 = 6.88 a stop.
 */
async function june(): Promise<void> {
  await hand(truck.t1!, tech.ana!, "2026-05-20");
  await hand(truck.t2!, tech.ben!, "2026-06-01", "2026-06-11");
  await hand(truck.t2!, tech.cy!, "2026-06-11");
  const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name) values (${ORG}, 'Route A') returning id`;
  await raw`insert into public.crew_member (organization_id, crew_id, technician_id) values (${ORG}, ${crew!.id}, ${tech.ana!})`;

  for (let i = 0; i < 3; i++) await stop("2026-06-10", { technician: tech.ana! });
  await stop("2026-06-10", { technician: tech.ana! }, "cancelled");
  await stop("2026-06-11", { technician: tech.ana! });
  await stop("2026-06-11", { crew: crew!.id });
  for (let i = 0; i < 4; i++) await stop("2026-06-12", { technician: tech.ana! });
  for (let i = 0; i < 2; i++) await stop("2026-06-10", { technician: tech.ben! });
  await stop("2026-06-11", { technician: tech.cy! });
  await stop("2026-06-11", { technician: tech.ben! });
  for (let i = 0; i < 2; i++) await stop("2026-07-01", { technician: tech.ana! });

  await read(truck.t1!, "2026-06-10", "18");
  await read(truck.t1!, "2026-06-11", "12");
  await read(truck.t1!, "2026-06-13", "30");
  await read(truck.t2!, "2026-06-10", "16");
  await read(truck.t2!, "2026-06-11", "9");
  await read(truck.t1!, "2026-07-01", "10");
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "water_per_stop")!;

run("fresh water per stop", () => {
  it("is each truck's water over its own stops, on the days that have both, worked by hand", async () => {
    await june();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["55", "8", "6.88"]);
    expect(kpi.besides).toEqual([
      expect.objectContaining({ key: "unknown", count: "1" }),
      expect.objectContaining({ key: "excluded", count: "1" }),
    ]);

    const water = await kpis.drill(owner(), { key: "water_per_stop", half: "numerator", ...WINDOW });
    expect(water.records.map((r) => [r.label, Number(r.value)]).sort()).toEqual([
      ["Truck 1: 30 gallons over 5 stops, 6.0 a stop", 30],
      ["Truck 2: 25 gallons over 3 stops, 8.3 a stop", 25],
    ]);
    expect(water.records.every((r) => r.kind === "truck" && r.href === `/fleet/water?truck=${r.id}`)).toBe(true);
    const stops = await kpis.drill(owner(), { key: "water_per_stop", half: "denominator", ...WINDOW });
    expect(stops.total).toBe("8");

    const unread = await kpis.drill(owner(), { key: "water_per_stop", half: "unknown", ...WINDOW });
    expect(unread.records.map((r) => r.label)).toEqual(["Truck 1, Jun 12: 4 stops, no water read"]);
    const idle = await kpis.drill(owner(), { key: "water_per_stop", half: "excluded", ...WINDOW });
    expect(idle.records.map((r) => r.label)).toEqual(["Truck 1, Jun 13: 30 gallons and no stop"]);
  });

  it("puts the same truck days through core's rule and gets the same answer", async () => {
    await june();
    const { days } = await truckWater.days(owner(), WINDOW);
    const verdict = reporting.waterPerStopOf(days.map((d) => ({
      truck: d.assetId, gallons: d.gallons === null ? null : Number(d.gallons), stops: d.stops,
    })));
    const kpi = await figure();
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([verdict.gallons, verdict.stops]);
    expect(kpi.besides!.map((b) => Number(b.count))).toEqual([verdict.notRead, verdict.noStops]);
    expect(verdict.byTruck.get(truck.t2!)).toEqual({ gallons: 25, stops: 3 });
  });
});

run("a truck's water, typed by the office", () => {
  it("is one figure per truck per day, replaced by a later reading, audited, and taken off", async () => {
    const first = await read(truck.t1!, "2026-06-10", "400");
    expect(first).toMatchObject({ gallons: "400.0000", source: "office" });
    const second = await read(truck.t1!, "2026-06-10", "410.5");
    expect(second.gallons).toBe("410.5000");
    const rows = await raw`select 1 from public.truck_water_day where organization_id = ${ORG}`;
    expect(rows.length).toBe(1);
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'truck_water.recorded'`;
    expect(audited.length).toBe(2);

    await truckWater.remove(owner(), { assetId: truck.t1!, onDay: "2026-06-10" });
    expect((await raw`select 1 from public.truck_water_day where organization_id = ${ORG}`).length).toBe(0);
  });

  it("refuses what is not a reading of a truck's day", async () => {
    const drill = await vehicle("Core drill", { kind: "powered_tool" });
    const sold = await vehicle("Old truck", { retiredOn: "2026-06-05" });
    await expect(read(drill, "2026-06-10", "40")).rejects.toThrow(/not a vehicle/);
    await expect(read(sold, "2026-06-10", "40")).rejects.toThrow(/left the fleet/);
    await expect(read(truck.t1!, "2999-01-01", "40")).rejects.toThrow(/has not come yet/);
    await expect(read(truck.t1!, "2026-06-10", "4100000")).rejects.toThrow(/more than a truck uses/);
    await expect(read(truck.t1!, "2026-06-10", "-5")).rejects.toBeInstanceOf(ConflictError);
    await expect(read(truck.t1!, "2026-06-10", "lots")).rejects.toThrow(/as a number/);
    await expect(truckWater.record(as(ANA, ["technician"], { technicianId: tech.ana! }), { assetId: truck.t1!, onDay: "2026-06-10", gallons: "40" }))
      .rejects.toThrow(/asset:write/);
  });
});

run("a truck's water, read by its driver on the phone", () => {
  it("is recorded for the truck the driver had that day, the later of two readings stands, and the phone is told its trucks", async () => {
    await hand(truck.t1!, tech.ana!, "2026-06-01");
    const ana = () => as(ANA, ["technician"], { technicianId: tech.ana! });
    const device = (await fieldOps.register(ana(), { installationId: `ana-${crypto.randomUUID()}` })).deviceId;
    /** The browser's "My day" is a second device of Ana's, with its own clock and its own sequence. */
    const browser = (await fieldOps.register(ana(), { installationId: `ana-browser-${crypto.randomUUID()}` })).deviceId;
    const sequences = new Map<string, number>();
    const send = (assetId: string, onDay: string, gallons: string, at: string, from = device) => fieldOps.sync(ana(), {
      deviceId: from,
      operations: [{
        clientId: crypto.randomUUID(), sequence: sequences.set(from, (sequences.get(from) ?? 0) + 1).get(from)!,
        kind: "truck.water", subjectId: assetId,
        occurredAt: at, payload: { field: onDay, onDay, gallons },
      }],
    }).then((r) => r.results[0]!);

    expect(await send(truck.t1!, "2026-06-10", "380", "2026-06-10T23:00:00Z")).toMatchObject({ status: "applied" });
    expect(await send(truck.t1!, "2026-06-11", "300", "2026-06-11T23:00:00Z")).toMatchObject({ status: "applied" });
    /** An older reading of the 10th, sent late from the other device, does not undo the newer one. */
    expect(await send(truck.t1!, "2026-06-10", "999", "2026-06-10T22:00:00Z", browser)).toMatchObject({ status: "superseded" });
    const [row] = await raw<{ gallons: string; source: string; technician_id: string }[]>`
      select gallons, source, technician_id from public.truck_water_day where asset_id = ${truck.t1!} and on_day = '2026-06-10'`;
    expect(row).toMatchObject({ gallons: "380.0000", source: "phone", technician_id: tech.ana! });

    /** Somebody else's truck is the office's to record. */
    const refused = await send(truck.t2!, "2026-06-10", "200", "2026-06-10T23:30:00Z");
    expect(refused.status).toBe("rejected");
    expect(refused.rejection ?? refused.error).toMatch(/not checked out to you/);

    const snapshot = await dispatch.snapshot(ana(), { deviceId: device, from: "2026-06-11", days: 1 });
    expect(snapshot.trucks).toEqual([{
      assetId: truck.t1!, label: "Truck 1", days: ["2026-06-10", "2026-06-11"],
      water: [{ onDay: "2026-06-10", gallons: "380.0000" }, { onDay: "2026-06-11", gallons: "300.0000" }],
    }]);
  });
});
