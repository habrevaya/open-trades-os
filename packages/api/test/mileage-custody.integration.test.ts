import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as expenses from "../src/services/expenses";
import * as payExtras from "../src/services/pay-extras";
import * as mileageOverrides from "../src/services/mileage-overrides";
import * as fieldSales from "../src/services/field-sales";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * THE VEHICLE A PERSON HAD CHECKED OUT PICKS THE MILEAGE RATE
 *
 * A claim in miles that names no vehicle, for a day the person had a vehicle
 * with a rate of its own checked out to them (the fleet's custody record), is
 * worked out at that vehicle's rate and says so. Naming another vehicle, or
 * saying it was their own, overrides it, and the claim then says which vehicle
 * they had out that day so the office can see it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("mileage-custody:org");
const OWNER = fixtureId("mileage-custody:owner");
const RAY = fixtureId("mileage-custody:ray");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const ray = (): ServiceContext => ({
  actor: { userId: RAY, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: rayTech }, db: db(),
});

let rayTech = "";
let van = "";
let truck = "";
let plainVan = "";
const OLD = companyToday(-40);

/** Ray holds `asset` from `from` until `until` (handed back that day; null is still out). */
async function checkOut(asset: string, from: string, until: string | null = null): Promise<void> {
  await raw`insert into public.asset_custody (organization_id, asset_id, custodian_kind, custodian_id, held_from, held_until)
    values (${ORG}, ${asset}, 'technician', ${rayTech}, ${from}, ${until})`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Mileage Custody Co", slug: "mileage-custody-co" });
  const email = "ray@mileage-custody.test";
  await raw`delete from public."user" where id = ${RAY} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${RAY}, ${email}, 'Ray Nunez')`;
  const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${RAY}, 'technician'::member_role) returning id`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, 'Ray Nunez') returning id`;
  rayTech = t!.id as string;
  [{ id: van }] = await raw`insert into public.company_asset (organization_id, kind, label) values (${ORG}, 'vehicle', 'Van 14') returning id` as unknown as [{ id: string }];
  [{ id: truck }] = await raw`insert into public.company_asset (organization_id, kind, label) values (${ORG}, 'vehicle', 'Truck 2') returning id` as unknown as [{ id: string }];
  [{ id: plainVan }] = await raw`insert into public.company_asset (organization_id, kind, label) values (${ORG}, 'vehicle', 'Van 9') returning id` as unknown as [{ id: string }];
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.expense where organization_id = ${ORG}`;
  await raw`delete from public.asset_custody where organization_id = ${ORG}`;
  await raw`delete from public.mileage_rate_override where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'payExtras' where id = ${ORG}`;
  await payExtras.addMileageRate(owner(), { from: OLD, perMile: "0.700" });
  await mileageOverrides.add(owner(), { assetId: van, from: OLD, perMile: "0.400" });
  await mileageOverrides.add(owner(), { assetId: truck, from: OLD, perMile: "0.900" });
});

const claimOn = async (spentOn: string, extra: { vehicleId?: string; ownVehicle?: boolean } = {}) => {
  const { id } = await expenses.record(ray(), { miles: "100", spentOn, description: "Drive", ...extra });
  return (await expenses.mine(ray())).expenses.find((e) => e.id === id)!;
};

run("the vehicle checked out that day", () => {
  it("is the vehicle a claim with none named is worked out at, and the claim says so", async () => {
    await checkOut(van, companyToday(-5));
    const claim = await claimOn(companyToday(-2));
    expect(claim).toMatchObject({
      amount: "40.0000", mileageRate: "0.400", mileageRateSource: "vehicle",
      mileageVehicle: "Van 14", mileageVehicleFrom: "checked_out", mileageCheckedOut: null,
    });
    const [audit] = await raw`select after from public.audit_log where organization_id = ${ORG} and entity_id = ${claim.id}`;
    expect((audit as { after: Record<string, unknown> }).after).toMatchObject({ vehicle: "Van 14", vehicleFrom: "checked_out" });
  });

  it("is read for the day of the drive: not before it was handed over, not on the day it was handed back", async () => {
    await checkOut(van, companyToday(-10), companyToday(-5));
    expect(await claimOn(companyToday(-11))).toMatchObject({ mileageRateSource: "company", mileageVehicle: null, mileageVehicleFrom: null });
    expect(await claimOn(companyToday(-10))).toMatchObject({ mileageRateSource: "vehicle", mileageVehicle: "Van 14" });
    expect(await claimOn(companyToday(-6))).toMatchObject({ mileageRateSource: "vehicle" });
    expect(await claimOn(companyToday(-5))).toMatchObject({ mileageRateSource: "company", mileageVehicle: null });
  });

  it("is the one handed over most recently when two were out, and never one with no rate of its own", async () => {
    await checkOut(plainVan, companyToday(-3));
    expect(await claimOn(companyToday(-1))).toMatchObject({ mileageRateSource: "company", mileageVehicle: null });
    await checkOut(van, companyToday(-9));
    await checkOut(truck, companyToday(-4));
    expect(await claimOn(companyToday(-1))).toMatchObject({ mileageRate: "0.900", mileageVehicle: "Truck 2", mileageVehicleFrom: "checked_out" });
  });

  it("is overridden by a vehicle picked, or by saying it was their own, and the claim names the one they had out", async () => {
    await checkOut(van, companyToday(-5));
    expect(await claimOn(companyToday(-1), { vehicleId: truck })).toMatchObject({
      mileageRate: "0.900", mileageVehicle: "Truck 2", mileageVehicleFrom: "picked", mileageCheckedOut: "Van 14",
    });
    expect(await claimOn(companyToday(-1), { ownVehicle: true })).toMatchObject({
      mileageRate: "0.700", mileageRateSource: "company", mileageVehicle: null, mileageVehicleFrom: null, mileageCheckedOut: "Van 14",
    });
    expect(await claimOn(companyToday(-1), { vehicleId: van })).toMatchObject({
      mileageVehicle: "Van 14", mileageVehicleFrom: "picked", mileageCheckedOut: null,
    });
  });

  it("refuses a vehicle and their own together, and their own with an amount paid", async () => {
    await expect(expenses.record(ray(), { miles: "10", vehicleId: van, ownVehicle: true, spentOn: companyToday(-1), description: "Both" }))
      .rejects.toThrow(/not both/);
    await expect(expenses.record(ray(), { amount: "10", ownVehicle: true, spentOn: companyToday(-1), description: "Paid" }))
      .rejects.toThrow(/goes with miles/);
  });

  it("is told to the person and the phone as the vehicle they have out today", async () => {
    expect((await expenses.mine(ray())).checkedOutToday).toBeNull();
    await checkOut(van, companyToday(-1));
    expect((await expenses.mine(ray())).checkedOutToday).toMatchObject({ id: van, label: "Van 14", rateToday: "0.400" });
    const view = await inTenant(ray(), (tx) => fieldSales.abilitiesFor(tx, ray(), rayTech));
    expect(view.mileageCheckedOut).toEqual({ id: van, label: "Van 14" });
  });

  it("is used on the phone's path when nothing is named, and the phone can say it was their own", async () => {
    await checkOut(van, companyToday(-5));
    const day = companyToday(-1);
    const { id: first } = await inTenant(ray(), (tx) => expenses.recordWithin(tx, ray(), rayTech, {
      miles: "10.0", spentOn: day, description: "Phone, nothing named",
    }));
    const { id: second } = await inTenant(ray(), (tx) => expenses.recordWithin(tx, ray(), rayTech, {
      miles: "10.0", spentOn: day, description: "Phone, my own", ownVehicle: true,
    }));
    const mine = (await expenses.mine(ray())).expenses;
    expect(mine.find((e) => e.id === first)).toMatchObject({ mileageVehicle: "Van 14", mileageVehicleFrom: "checked_out" });
    expect(mine.find((e) => e.id === second)).toMatchObject({ mileageVehicle: null, mileageCheckedOut: "Van 14" });
  });
});
