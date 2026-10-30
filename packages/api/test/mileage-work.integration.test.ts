import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as expenses from "../src/services/expenses";
import * as payExtras from "../src/services/pay-extras";
import * as mileageOverrides from "../src/services/mileage-overrides";
import * as fieldSales from "../src/services/field-sales";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * A MILEAGE RATE FOR A KIND OF WORK, AND A VEHICLE NAMED FROM THE PHONE
 *
 * A claim in miles for a job is worked out at the line for the job's kind of work (its job type) when it has
 * one: after a vehicle the person named, before the person's own line and the company's. The claim keeps the
 * kind of work's name. And the phone is told the vehicles with a rate of their own, and a claim it sends with
 * one is worked out at that vehicle's rate.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("mileage-work:org");
const OWNER = fixtureId("mileage-work:owner");
const RAY = fixtureId("mileage-work:ray");
const OFFICE = fixtureId("mileage-work:office");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const office = (): ServiceContext => ({ actor: { userId: OFFICE, organizationId: ORG, roles: ["office_manager"] as Actor["roles"] }, db: db() });
const ray = (): ServiceContext => ({
  actor: { userId: RAY, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: rayTech }, db: db(),
});

let rayTech = "";
let van = "";
let install = "";
let repair = "";
let installJob = 0;
let repairJob = 0;
let device = "";
const FROM = companyToday(-30);
const today = () => companyToday();

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Mileage Work Co", slug: "mileage-work-co" });
  for (const [id, name, role] of [[RAY, "Ray Work", "technician"], [OFFICE, "Opal Office", "office_manager"]] as const) {
    const email = `${name.split(" ")[0]!.toLowerCase()}@mileage-work.test`;
    await raw`delete from public."user" where id = ${id} or email = ${email}`;
    await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
    const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::member_role) returning id`;
    if (role === "technician") {
      const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
      rayTech = t!.id as string;
    }
  }
  [{ id: van }] = await raw`insert into public.company_asset (organization_id, kind, label) values (${ORG}, 'vehicle', 'Van 9') returning id` as unknown as [{ id: string }];
  [{ id: install }] = await raw`insert into public.job_type (organization_id, name) values (${ORG}, 'Install') returning id` as unknown as [{ id: string }];
  [{ id: repair }] = await raw`insert into public.job_type (organization_id, name) values (${ORG}, 'Repair') returning id` as unknown as [{ id: string }];
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Mile Customer') returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Mile Rd', 'Austin', 'TX', '78701') returning id`;
  installJob = 9301;
  repairJob = 9302;
  await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary, job_type_id)
    values (${ORG}, ${installJob}, ${c!.id}, ${p!.id}, 'scheduled', 'New system', ${install}),
           (${ORG}, ${repairJob}, ${c!.id}, ${p!.id}, 'scheduled', 'No heat', ${repair})`;
  const [d] = await raw<{ id: string }[]>`insert into public.device (organization_id, technician_id, installation_id)
    values (${ORG}, ${rayTech}, ${`mileage-work-${Date.now()}`}) returning id`;
  device = d!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.expense where organization_id = ${ORG}`;
  await raw`delete from public.mileage_rate_override where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'payExtras' where id = ${ORG}`;
  await payExtras.addMileageRate(owner(), { from: FROM, perMile: "0.700" });
});

const claim = (over: { jobNumber?: number; vehicleId?: string; miles?: string } = {}) => expenses.record(ray(), {
  miles: over.miles ?? "10", spentOn: today(), description: `Drive ${crypto.randomUUID()}`,
  ...(over.jobNumber ? { jobNumber: over.jobNumber } : {}), ...(over.vehicleId ? { vehicleId: over.vehicleId } : {}),
});

run("a rate for a kind of work", () => {
  it("is set like a person's or a vehicle's, listed by name, and refused twice on one day", async () => {
    const view = await mileageOverrides.add(owner(), { jobTypeId: install, from: FROM, perMile: "0.90" });
    expect(view.lines.map((l) => [l.kind, l.subjectName, l.jobTypeId, l.perMile, l.inForceToday])).toEqual([
      ["work", "Install", install, "0.900", true],
    ]);
    expect((await mileageOverrides.list(owner(), { jobTypeId: install })).lines).toHaveLength(1);
    /** The same line again is the first answer. */
    expect((await mileageOverrides.add(owner(), { jobTypeId: install, from: FROM, perMile: "0.90" })).lines).toHaveLength(1);
    await expect(mileageOverrides.add(owner(), { jobTypeId: install, from: FROM, perMile: "0.95" }))
      .rejects.toThrow(/There is already a rate from/);
    await expect(mileageOverrides.add(owner(), { jobTypeId: install, technicianId: rayTech, from: FROM, perMile: "0.95" }))
      .rejects.toThrow(/only one of them/);
    await expect(mileageOverrides.add(office(), { jobTypeId: repair, from: FROM, perMile: "0.95" })).rejects.toThrow(PermissionError);

    const [line] = await raw<{ after: { kind: string; subjectName: string } }[]>`select "after" from public.audit_log
      where organization_id = ${ORG} and action = 'mileage_rate_override.added' order by created_at desc limit 1`;
    expect(line!.after).toMatchObject({ kind: "work", subjectName: "Install" });
  });

  it("prices a claim for a job of that kind, before the person's own line and after a vehicle's", async () => {
    await mileageOverrides.add(owner(), { jobTypeId: install, from: FROM, perMile: "0.90" });
    await mileageOverrides.add(owner(), { technicianId: rayTech, from: FROM, perMile: "0.80" });
    await mileageOverrides.add(owner(), { assetId: van, from: FROM, perMile: "0.50" });

    const forInstall = await claim({ jobNumber: installJob });
    expect(forInstall).toMatchObject({ amount: "9.0000", mileageRate: "0.900", mileageRateSource: "work", mileageWork: "Install" });

    /** Another kind with no line of its own falls to the person's. */
    expect(await claim({ jobNumber: repairJob })).toMatchObject({ mileageRate: "0.800", mileageRateSource: "person", mileageWork: null });
    /** No job: the person's. */
    expect(await claim()).toMatchObject({ mileageRateSource: "person" });
    /** A vehicle named comes first, whatever the job. */
    expect(await claim({ jobNumber: installJob, vehicleId: van }))
      .toMatchObject({ mileageRate: "0.500", mileageRateSource: "vehicle", mileageVehicle: "Van 9", mileageWork: null });
  });

  it("keeps the rate when the job later moves to another kind, or the line is taken off", async () => {
    const view = await mileageOverrides.add(owner(), { jobTypeId: install, from: FROM, perMile: "0.90" });
    const made = await claim({ jobNumber: installJob });
    await raw`update public.job set job_type_id = ${repair} where organization_id = ${ORG} and number = ${installJob}`;
    await mileageOverrides.remove(owner(), { id: view.lines[0]!.id });
    const [row] = await raw<{ mileage_rate: string; mileage_rate_source: string; mileage_job_type_label: string }[]>`
      select mileage_rate, mileage_rate_source, mileage_job_type_label from public.expense where id = ${made.id}`;
    expect(row).toEqual({ mileage_rate: "0.900", mileage_rate_source: "work", mileage_job_type_label: "Install" });
    await raw`update public.job set job_type_id = ${install} where organization_id = ${ORG} and number = ${installJob}`;
  });

  it("tells the person which kinds of work pay their own, and starts a line from a later day only from then", async () => {
    await mileageOverrides.add(owner(), { jobTypeId: install, from: companyToday(5), perMile: "0.90" });
    expect((await expenses.mine(ray())).work).toEqual([{ id: install, name: "Install", rateToday: null }]);
    expect(await claim({ jobNumber: installJob })).toMatchObject({ mileageRateSource: "company", mileageRate: "0.700" });
  });
});

run("a vehicle on a claim from the phone", () => {
  it("is offered to the phone, with what it pays today", async () => {
    await mileageOverrides.add(owner(), { assetId: van, from: FROM, perMile: "0.50" });
    await mileageOverrides.add(owner(), { jobTypeId: install, from: FROM, perMile: "0.90" });
    const abilities = await inTenant(ray(), (tx) => fieldSales.abilitiesFor(tx, ray(), rayTech));
    expect(abilities).toMatchObject({
      mileageRate: "0.700", mileageVehicles: [{ id: van, label: "Van 9", rateToday: "0.500" }], mileageWork: true,
    });
  });

  it("is worked out at the vehicle's rate when the phone names it", async () => {
    await mileageOverrides.add(owner(), { assetId: van, from: FROM, perMile: "0.50" });
    const id = crypto.randomUUID();
    const outcome = await inTenant(ray(), (tx) => fieldSales.recordExpense(tx, ray(), {
      id: crypto.randomUUID(), deviceId: device, kind: "expense.record", subjectId: id, occurredAt: new Date(),
      sequence: 1, payload: { miles: "12.0", vehicleId: van, spentOn: today(), description: "Van to the supply house" },
    } as never));
    expect(outcome).toBeNull();
    const [row] = await raw<{ amount: string; mileage_rate_source: string; mileage_asset_label: string }[]>`
      select amount, mileage_rate_source, mileage_asset_label from public.expense where id = ${id}`;
    expect(row).toEqual({ amount: "6.0000", mileage_rate_source: "vehicle", mileage_asset_label: "Van 9" });
  });
});
