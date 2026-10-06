import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as visits from "../src/services/visits";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A VISIT ON ITS OWN PAGE
 *
 * What the visit screen reads: the trip's times, who was on it, what it used,
 * which units it worked, its report and inspection, what the customer asked,
 * and the other visits on the job. Scoped by the job, so a technician cannot
 * open a visit on work they were never sent to by changing the address bar,
 * and a reader without timesheets sees no time.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("visit-page:org");
const USER = fixtureId("visit-page:owner");
const TECH_USER = fixtureId("visit-page:tech");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
let techId = "";
/** The technician as their session resolves them: the scope `own` reads the technician id. */
const tech = (): ServiceContext => ({
  actor: { userId: TECH_USER, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: techId }, db: db(),
});
const as = (roles: string[]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db() });

let firstId = "";
let secondId = "";
let elsewhereId = "";
let unitId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Visit Co", slug: "visit-page-co" });
  await raw`delete from public."user" where id = ${TECH_USER} or email = 'tess@visit-page.test'`;
  await raw`insert into public."user" (id, email, name) values (${TECH_USER}, 'tess@visit-page.test', 'Tess')`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${TECH_USER}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, 'Tess Tech') returning id`;
  techId = t!.id;
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Vera Visit') returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code, access_notes)
    values (${ORG}, '5 Gate Rd', 'Austin', 'TX', '78704', 'Code 4411 at the side gate') returning id`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 501, ${c!.id}, ${p!.id}, 'in_progress', 'Three day install') returning id`;
  const [first] = await raw<{ id: string }[]>`insert into public.visit
    (organization_id, job_id, sequence, status, window_start, window_end, arrived_at, completed_at, technician_notes)
    values (${ORG}, ${job!.id}, 1, 'completed', '2026-06-15T13:00:00Z', '2026-06-15T17:00:00Z',
            '2026-06-15T13:20:00Z', '2026-06-15T21:00:00Z', 'Old unit out, pad poured') returning id`;
  firstId = first!.id;
  const [second] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, sequence, status)
    values (${ORG}, ${job!.id}, 2, 'scheduled') returning id`;
  secondId = second!.id;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
    values (${ORG}, ${firstId}, ${t!.id}, true)`;
  await raw`insert into public.job_line (organization_id, job_id, visit_id, kind, name, quantity, unit_price, unit_cost)
    values (${ORG}, ${job!.id}, ${firstId}, 'part', 'Condenser pad', '1', '120.0000', '45.0000')`;
  await raw`insert into public.timeclock_entry (organization_id, technician_id, visit_id, kind, started_at, ended_at, minutes)
    values (${ORG}, ${t!.id}, ${firstId}, 'on_site', '2026-06-15T13:20:00Z', '2026-06-15T21:00:00Z', 460)`;
  const [unit] = await raw<{ id: string }[]>`insert into public.equipment (organization_id, property_id, category, tag, serial_number)
    values (${ORG}, ${p!.id}, 'condenser', 'C-1', 'SN-C1') returning id`;
  unitId = unit!.id;
  await raw`insert into public.visit_asset (organization_id, visit_id, equipment_id, outcome, notes)
    values (${ORG}, ${firstId}, ${unitId}, 'pass', 'Set and levelled')`;

  const [otherJob] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 502, ${c!.id}, ${p!.id}, 'scheduled', 'Somebody else''s call') returning id`;
  const [elsewhere] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status)
    values (${ORG}, ${otherJob!.id}, 'scheduled') returning id`;
  elsewhereId = elsewhere!.id;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where id = ${TECH_USER}`;
  await raw.end();
});

run("the visit page", () => {
  it("reads one trip of a job with everything that happened on it", async () => {
    const visit = await visits.get(owner(), { id: firstId });
    expect(visit).toMatchObject({
      sequence: 1, status: "completed", technicianNotes: "Old unit out, pad poured",
      job: { number: 501, summary: "Three day install" },
      customer: { name: "Vera Visit" },
      property: { address: "5 Gate Rd, Austin, TX", accessNotes: "Code 4411 at the side gate" },
      team: [{ name: "Tess Tech", isLead: true }],
    });
    expect(visit.used).toEqual([expect.objectContaining({ name: "Condenser pad", unitPrice: "120.0000", billed: false })]);
    // The cost is the job costing permission's, on the job's statement, and is not here.
    expect(JSON.stringify(visit.used)).not.toContain("45.0000");
    expect(visit.time).toEqual([expect.objectContaining({ technician: "Tess Tech", minutes: 460 })]);
    expect(visit.units).toEqual([expect.objectContaining({ equipmentId: unitId, outcome: "pass", tag: "C-1" })]);
    expect(visit.siblings.map((s) => s.id)).toEqual([firstId, secondId]);
  });

  it("opens a visit for the technician who was on it, and not one on work they were never sent to", async () => {
    await expect(visits.get(tech(), { id: firstId })).resolves.toMatchObject({ sequence: 1 });
    await expect(visits.get(tech(), { id: elsewhereId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("leaves time off the page for somebody who may not read timesheets", async () => {
    const visit = await visits.get(as(["csr"]), { id: firstId });
    expect(visit.time).toBeNull();
  });

  it("refuses somebody who may not read visits, and a visit that is not here", async () => {
    await expect(visits.get(as(["marketing"]), { id: firstId })).rejects.toBeInstanceOf(PermissionError);
    await expect(visits.get(owner(), { id: fixtureId("visit-page:missing") })).rejects.toBeInstanceOf(NotFoundError);
  });
});
