import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as expenses from "../src/services/expenses";
import * as payExtras from "../src/services/pay-extras";
import * as mileageOverrides from "../src/services/mileage-overrides";
import * as payroll from "../src/services/payroll";
import * as laborSettings from "../src/services/labor-settings";
import * as fieldSales from "../src/services/field-sales";
import { routes } from "../src/contracts";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * A MILEAGE RATE OF ONE PERSON'S OR ONE VEHICLE'S OWN
 *
 * A claim in miles is worked out at the named vehicle's line in force on the day driven, else the person's,
 * else the company's. The claim keeps the rate and where it came from, and no line added or taken off later
 * reprices it. Setting a line is payroll:configure's; reading one follows the timesheet scope.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("mileage-override:org");
const OWNER = fixtureId("mileage-override:owner");
const RAY = fixtureId("mileage-override:ray");
const SAM = fixtureId("mileage-override:sam");
const OFFICE = fixtureId("mileage-override:office");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const office = (): ServiceContext => ({
  actor: { userId: OFFICE, organizationId: ORG, roles: ["office_manager"] as Actor["roles"] }, db: db(),
});
const ray = (): ServiceContext => ({
  actor: { userId: RAY, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: rayTech }, db: db(),
});
const sam = (): ServiceContext => ({
  actor: { userId: SAM, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: samTech }, db: db(),
});

let rayTech = "";
let samTech = "";
let van = "";
let tool = "";
let retiredVan = "";
const OLD = companyToday(-40);
const MID = companyToday(-20);
const NEW = companyToday(-10);
const today = () => companyToday();

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Mileage Override Co", slug: "mileage-override-co" });
  for (const [id, name, role] of [[RAY, "Ray Nunez", "technician"], [SAM, "Sam Ortiz", "technician"], [OFFICE, "Olive Office", "office_manager"]] as const) {
    const email = `${name.split(" ")[0]!.toLowerCase()}@mileage-override.test`;
    await raw`delete from public."user" where id = ${id} or email = ${email}`;
    await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
    const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::member_role) returning id`;
    if (role === "technician") {
      const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
      if (id === RAY) rayTech = t!.id as string; else samTech = t!.id as string;
    }
  }
  [{ id: van }] = await raw`insert into public.company_asset (organization_id, kind, label) values (${ORG}, 'vehicle', 'Van 14') returning id` as unknown as [{ id: string }];
  [{ id: tool }] = await raw`insert into public.company_asset (organization_id, kind, label) values (${ORG}, 'powered_tool', 'Core drill') returning id` as unknown as [{ id: string }];
  [{ id: retiredVan }] = await raw`insert into public.company_asset (organization_id, kind, label, retired_on) values (${ORG}, 'vehicle', 'Old van', '2025-01-01') returning id` as unknown as [{ id: string }];
  await raw`update public.technician set wage_classification = 'Journeyman' where organization_id = ${ORG}`;
  await laborSettings.setScale(owner(), { classification: "Journeyman", baseRate: "40.00", fringeRate: "8.00", effectiveFrom: "2026-01-01" });
  await laborSettings.setPolicy(owner(), {
    label: "Federal", timeZone: "America/Chicago", weekStartsOn: 1, dayAttribution: "shift_start", weeklyThresholdMinutes: 2400,
    overtimeMultiplier: "1.5", doubleTimeMultiplier: "2", onCallTreatment: "separate_rate_not_hours_worked", note: "Forty hours a week.",
  });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.payroll_export where organization_id = ${ORG}`;
  await raw`delete from public.pay_period_close where organization_id = ${ORG}`;
  await raw`delete from public.pay_period where organization_id = ${ORG}`;
  await raw`delete from public.expense where organization_id = ${ORG}`;
  await raw`delete from public.mileage_rate_override where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'payExtras' where id = ${ORG}`;
});

run("a rate for one person or one vehicle is set from a day", () => {
  it("starts empty, takes lines for a person and for a vehicle, and says which is in force today", async () => {
    expect(await mileageOverrides.list(owner())).toEqual({ lines: [] });
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: NEW, perMile: "0.80" });
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: OLD, perMile: "0.75" });
    const view = await mileageOverrides.add(owner(), { assetId: van, from: companyToday(1), perMile: "0.4" });
    expect(view.lines.map((l) => [l.kind, l.subjectName, l.from, l.perMile, l.inForceToday])).toEqual([
      ["person", "Ray Nunez", OLD, "0.750", false],
      ["person", "Ray Nunez", NEW, "0.800", true],
      ["vehicle", "Van 14", companyToday(1), "0.400", false],
    ]);
    /** Anybody who reads the timesheet reads them. */
    expect((await mileageOverrides.list(office())).lines).toHaveLength(3);
    expect((await mileageOverrides.list(owner(), { assetId: van })).lines).toHaveLength(1);
  });

  it("is refused in words when it cannot be right, and a day cannot have two for the same person", async () => {
    await expect(mileageOverrides.add(owner(), { technicianId: rayTech, from: today(), perMile: "seventy cents" })).rejects.toThrow(/dollars/);
    await expect(mileageOverrides.add(owner(), { technicianId: rayTech, from: today(), perMile: "72" })).rejects.toThrow(/slip of the keys/);
    await expect(mileageOverrides.add(owner(), { from: today(), perMile: "0.70" })).rejects.toThrow(/one person or one vehicle/);
    await expect(mileageOverrides.add(owner(), { technicianId: rayTech, assetId: van, from: today(), perMile: "0.70" })).rejects.toThrow(/one person or one vehicle/);
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: OLD, perMile: "0.70" });
    await expect(mileageOverrides.add(owner(), { technicianId: rayTech, from: OLD, perMile: "0.80" })).rejects.toThrow(/There is already a rate from/);
    /** Another person, and a vehicle, may start the same day. */
    await mileageOverrides.add(owner(), { technicianId: samTech, from: OLD, perMile: "0.80" });
    await mileageOverrides.add(owner(), { assetId: van, from: OLD, perMile: "0.50" });
  });

  it("is for a vehicle in use only: a tool, a retired van and a stranger are refused", async () => {
    await expect(mileageOverrides.add(owner(), { assetId: tool, from: OLD, perMile: "0.5" })).rejects.toThrow(/not a vehicle/);
    await expect(mileageOverrides.add(owner(), { assetId: retiredVan, from: OLD, perMile: "0.5" })).rejects.toThrow(/retired/);
    await expect(mileageOverrides.add(owner(), { assetId: crypto.randomUUID(), from: OLD, perMile: "0.5" })).rejects.toThrow(/Vehicle/);
    await expect(mileageOverrides.add(owner(), { technicianId: crypto.randomUUID(), from: OLD, perMile: "0.5" })).rejects.toThrow(/Person/);
  });

  it("is the same line sent again, audited once, and taking one off twice changes nothing", async () => {
    const count = async (action: string) => (await raw`select count(*)::int as n from public.audit_log where organization_id = ${ORG} and action = ${action}`)[0]!.n as number;
    const addedBefore = await count("mileage_rate_override.added");
    const removedBefore = await count("mileage_rate_override.removed");
    const first = await mileageOverrides.add(owner(), { technicianId: rayTech, from: OLD, perMile: "0.70" });
    const again = await mileageOverrides.add(owner(), { technicianId: rayTech, from: OLD, perMile: "0.700" });
    expect(again.lines).toHaveLength(1);
    expect(await count("mileage_rate_override.added")).toBe(addedBefore + 1);
    const id = first.lines[0]!.id;
    expect((await mileageOverrides.remove(owner(), { id })).lines).toEqual([]);
    expect((await mileageOverrides.remove(owner(), { id })).lines).toEqual([]);
    expect(await count("mileage_rate_override.removed")).toBe(removedBefore + 1);
    const [audit] = await raw`select before from public.audit_log where organization_id = ${ORG} and action = 'mileage_rate_override.removed' order by created_at desc limit 1`;
    expect(audit!.before).toMatchObject({ perMile: "0.700", technicianId: rayTech });
  });

  it("is payroll:configure's to change, and the timesheet's to read", async () => {
    await expect(mileageOverrides.add(office(), { technicianId: rayTech, from: OLD, perMile: "0.70" })).rejects.toBeInstanceOf(PermissionError);
    await expect(mileageOverrides.remove(office(), { id: crypto.randomUUID() })).rejects.toBeInstanceOf(PermissionError);
    await expect(mileageOverrides.list(ray())).rejects.toBeInstanceOf(PermissionError);
    expect(routes.addMileageOverride.permissions).toEqual(["payroll:configure"]);
    expect(routes.removeMileageOverride.permissions).toEqual(["payroll:configure"]);
    expect(routes.listMileageOverrides.permissions).toEqual(["timesheet:read"]);
  });
});

run("a claim in miles is worked out at the narrowest rate in force that day", () => {
  it("is the company's with no line of their own, and the person's with one", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: MID, perMile: "0.80" });
    const before = await expenses.record(ray(), { miles: "100", spentOn: companyToday(-30), description: "Before Ray's rate" });
    expect(before).toMatchObject({ mileageRate: "0.700", amount: "70.0000", mileageRateSource: "company", mileageVehicle: null });
    const after = await expenses.record(ray(), { miles: "100", spentOn: today(), description: "After Ray's rate" });
    expect(after).toMatchObject({ mileageRate: "0.800", amount: "80.0000", mileageRateSource: "person", mileageVehicle: null });
    /** Somebody else is still on the company's. */
    expect(await expenses.record(sam(), { miles: "100", spentOn: today(), description: "Sam" }))
      .toMatchObject({ mileageRate: "0.700", mileageRateSource: "company" });
  });

  it("is the vehicle's first when the person names it, then the person's, then the company's", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: OLD, perMile: "0.80" });
    await mileageOverrides.add(owner(), { assetId: van, from: MID, perMile: "0.45" });
    const named = await expenses.record(ray(), { miles: "100", vehicleId: van, spentOn: today(), description: "In the van" });
    expect(named).toMatchObject({ mileageRate: "0.450", amount: "45.0000", mileageRateSource: "vehicle", mileageVehicle: "Van 14" });
    /** The van's line had not started on the day driven, so the person's applies, and the van is still on the claim. */
    const early = await expenses.record(ray(), { miles: "100", vehicleId: van, spentOn: companyToday(-30), description: "Earlier, in the van" });
    expect(early).toMatchObject({ mileageRate: "0.800", mileageRateSource: "person", mileageVehicle: "Van 14" });
    /** Not naming the van leaves the person's. */
    expect(await expenses.record(ray(), { miles: "100", spentOn: today(), description: "Own car" }))
      .toMatchObject({ mileageRate: "0.800", mileageRateSource: "person", mileageVehicle: null });
    /** A person with no rate of their own who names the van gets the van's. */
    expect(await expenses.record(sam(), { miles: "100", vehicleId: van, spentOn: today(), description: "Sam in the van" }))
      .toMatchObject({ mileageRate: "0.450", mileageRateSource: "vehicle" });
    const [stored] = await raw`select mileage_rate_source, mileage_asset_id, mileage_asset_label from public.expense where id = ${named.id}`;
    expect(stored).toEqual({ mileage_rate_source: "vehicle", mileage_asset_id: van, mileage_asset_label: "Van 14" });
  });

  it("lets a person with only their own rate claim miles though the company has none", async () => {
    await expect(expenses.record(ray(), { miles: "10", spentOn: today(), description: "No rate" })).rejects.toThrow(/no mileage rate for/);
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: OLD, perMile: "0.80" });
    expect(await expenses.record(ray(), { miles: "10", spentOn: today(), description: "Own rate" }))
      .toMatchObject({ mileageRate: "0.800", amount: "8.0000" });
    await expect(expenses.record(sam(), { miles: "10", spentOn: today(), description: "No rate for Sam" })).rejects.toThrow(/no mileage rate for/);
  });

  it("never reprices a claim already made when a line is added or taken off", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    const line = (await mileageOverrides.add(owner(), { technicianId: rayTech, from: MID, perMile: "0.80" })).lines[0]!;
    const made = await expenses.record(ray(), { miles: "12.5", spentOn: today(), description: "Drive" });
    expect(made).toMatchObject({ mileageRate: "0.800", amount: "10.0000" });
    await mileageOverrides.remove(owner(), { id: line.id });
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: NEW, perMile: "0.95" });
    const mine = (await expenses.mine(ray())).expenses.find((e) => e.id === made.id);
    expect(mine).toMatchObject({ mileageRate: "0.800", amount: "10.0000", mileageRateSource: "person" });
    const [stored] = await raw`select mileage_rate::text, amount::text from public.expense where id = ${made.id}`;
    expect(stored).toEqual({ mileage_rate: "0.800", amount: "10.0000" });
    /** The same claim sent again keeps the first rate, though the line has since changed. */
    const id = crypto.randomUUID();
    await expenses.record(ray(), { id, miles: "10", spentOn: today(), description: "Retry" });
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: today(), perMile: "1.10" });
    await expenses.record(ray(), { id, miles: "10", spentOn: today(), description: "Retry" });
    const [kept] = await raw`select mileage_rate::text from public.expense where id = ${id}`;
    expect(kept).toEqual({ mileage_rate: "0.950" });
  });

  it("refuses a vehicle that is not offered, and a vehicle given with an amount", async () => {
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    /** The van has no rate of its own yet, so it is not offered, and naming it would only read the fleet. */
    await expect(expenses.record(ray(), { miles: "10", vehicleId: van, spentOn: today(), description: "Van" })).rejects.toThrow(/not on the list/);
    await expect(expenses.record(ray(), { miles: "10", vehicleId: tool, spentOn: today(), description: "Tool" })).rejects.toThrow(/not on the list/);
    await mileageOverrides.add(owner(), { assetId: van, from: OLD, perMile: "0.45" });
    await expect(expenses.record(ray(), { amount: "10", vehicleId: van, spentOn: today(), description: "Van" })).rejects.toThrow(/goes with miles/);
    expect((await expenses.mine(ray())).expenses).toEqual([]);
  });

  it("offers the person their rate today and the vehicles with a rate of their own", async () => {
    expect(await expenses.mine(ray())).toMatchObject({ mileageRate: null, vehicles: [] });
    await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.70" });
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: NEW, perMile: "0.80" });
    await mileageOverrides.add(owner(), { assetId: van, from: companyToday(2), perMile: "0.45" });
    expect(await expenses.mine(ray())).toMatchObject({
      mileageRate: "0.800", vehicles: [{ id: van, label: "Van 14", rateToday: null }],
    });
    expect((await expenses.mine(sam())).mileageRate).toBe("0.700");
    /** The phone is told the person's rate, not the company's. */
    expect((await inTenant(ray(), (tx) => fieldSales.abilitiesFor(tx, ray(), rayTech))).mileageRate).toBe("0.800");
    expect((await inTenant(sam(), (tx) => fieldSales.abilitiesFor(tx, sam(), samTech))).mileageRate).toBe("0.700");
  });

  it("says whose rate it was on the payroll line the bureau gets, and on the office's list", async () => {
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: "2025-01-01", perMile: "0.80" });
    await mileageOverrides.add(owner(), { assetId: van, from: "2025-01-01", perMile: "0.45" });
    const own = await expenses.record(ray(), { miles: "10", spentOn: today(), description: "Own rate drive" });
    const inVan = await expenses.record(ray(), { miles: "10", vehicleId: van, spentOn: today(), description: "Van drive" });
    const listed = (await expenses.list(office(), { status: "pending" })).expenses;
    expect(listed.find((e) => e.id === own.id)).toMatchObject({ mileageRateSource: "person", mileageVehicle: null });
    expect(listed.find((e) => e.id === inVan.id)).toMatchObject({ mileageRateSource: "vehicle", mileageVehicle: "Van 14" });
    for (const id of [own.id, inVan.id]) await expenses.decide(office(), { id, decision: "approve" });
    await raw`update public.expense set decided_at = '2026-01-07T15:00:00Z' where organization_id = ${ORG}`;
    const period = await payroll.declarePeriod(owner(), { label: "Fortnight to 18 January", startDate: "2026-01-05", weeks: 2 });
    await payroll.closePeriod(owner(), { periodId: period.id });
    const register = await payroll.register(owner(), { periodId: period.id });
    const row = register.rows.find((r) => r.technicianId === rayTech)!;
    const labels = row.lines.filter((l) => l.kind === "reimbursement").map((l) => l.label).sort();
    expect(labels[0]).toContain("Own rate drive (10.0 miles at $0.800 a mile, this person's own rate)");
    expect(labels[1]).toContain("Van drive (10.0 miles at $0.450 a mile, the rate for Van 14)");
  });

  it("is on the contract: the claim takes a vehicle only beside miles", () => {
    const base = { spentOn: today(), description: "Drive" };
    const v = crypto.randomUUID();
    expect(routes.recordExpense.input.safeParse({ ...base, miles: "12.5", vehicleId: v }).success).toBe(true);
    expect(routes.recordExpense.input.safeParse({ ...base, miles: "12.5", vehicleId: "van" }).success).toBe(false);
  });
});
