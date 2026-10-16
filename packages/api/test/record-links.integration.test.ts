import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as objects from "../src/services/custom-objects";
import { dispatch } from "../src/http/dispatch";
import { memberActor } from "../src/services/session";
import { inTenant, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A RECORD'S LINKS CHANGE ON ITS PAGE, AND ONLY TO THINGS THE WRITER MAY OPEN
 *
 * A link was set when a record was made and never changed afterwards. Now it
 * changes, by `PATCH /v1/custom-records/{id}` and the record's page, and a
 * changeable link is a probe: point a permit at an id, and whether it is
 * refused says whether that job, customer or invoice exists. So every link
 * is checked as making the record with it is (and making one now checks every
 * link the same way): the permission that reads the thing and the writer's
 * scope on it, refused in words at its key, out of scope reading exactly as
 * not there.
 *
 * Refusals first: a technician allowed to file records, a branch manager
 * outside the branch and another company's owner each try to point a record
 * at something they cannot open, link by link, and the record is unchanged
 * after every one. The owner's moves after them are the control.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("record-links:org");
const OWNER = fixtureId("record-links:owner");
const TECH = fixtureId("record-links:tech");
const MANAGER = fixtureId("record-links:manager");
const OTHER = fixtureId("record-links:other-org");
const OTHER_OWNER = fixtureId("record-links:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const otherOwner = (): ServiceContext => ({
  actor: { userId: OTHER_OWNER, organizationId: OTHER, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let tech: ServiceContext;
let manager: ServiceContext;

/** One person's work: a customer, their address, a unit there, a job, an invoice. */
interface Work { customer: string; property: string; unit: string; job: string; invoice: string }
let ada: Work;
let bea: Work;
let theirs: Work;
let techMembership = "";
let managerMembership = "";
let austinPerson = "";
let theirPerson = "";

async function work(org: string, name: string, n: number, branch: string | null): Promise<Work> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${org}, ${name}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${org}, ${`${n} Link Lane`}, 'Austin', 'TX', '78701') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary) values (${org}, ${c!.id}, ${p!.id}, true)`;
  const [u] = await raw<{ id: string }[]>`insert into public.equipment (organization_id, property_id, category, manufacturer, model)
    values (${org}, ${p!.id}, 'Furnace', 'Acme', 'F1') returning id`;
  const [j] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${org}, ${n}, ${c!.id}, ${p!.id}, 'scheduled', ${`Job ${n}`}, ${branch}) returning id`;
  const [i] = await raw<{ id: string }[]>`insert into public.invoice
    (organization_id, number, customer_id, job_id, status, issued_on, due_on, total, balance)
    values (${org}, ${n}, ${c!.id}, ${j!.id}, 'open', current_date, current_date, 100, 100) returning id`;
  return { customer: c!.id, property: p!.id, unit: u!.id, job: j!.id, invoice: i!.id };
}

async function person(org: string, userId: string, email: string, name: string, role: string, branch: string | null) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${org}, ${userId}, ${role}::public.member_role, ${branch}) returning id`;
  return m!.id;
}

async function resolve(userId: string): Promise<ServiceContext> {
  const actor = await inTenant(owner(), (tx) => memberActor(tx, ORG, userId));
  if (!actor) throw new Error("No active membership.");
  return { actor, db: db() };
}

let adaPermit = "";
let beaPermit = "";
let beaEarlier = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Record Links Co", slug: "record-links-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_OWNER, name: "Record Links Neighbour", slug: "record-links-neighbour" });
  const [austin] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [houston] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;

  ada = await work(ORG, "Ada Link", 8501, austin!.id);
  bea = await work(ORG, "Bea Link", 8502, houston!.id);
  theirs = await work(OTHER, "Cy Link", 8503, null);

  techMembership = await person(ORG, TECH, "record-links-tech@test.local", "Tia Tech", "technician", austin!.id);
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${techMembership}, 'Tia Tech') returning id`;
  /** The technician was sent to Ada's job, and only Ada's. */
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status) values (${ORG}, ${ada.job}, 'scheduled') returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${t!.id})`;
  managerMembership = await person(ORG, MANAGER, "record-links-manager@test.local", "Hana Houston", "branch_manager", houston!.id);
  austinPerson = await person(ORG, fixtureId("record-links:austin"), "record-links-austin@test.local", "Abe Austin", "csr", austin!.id);
  theirPerson = (await raw<{ id: string }[]>`select id from public.membership where organization_id = ${OTHER} limit 1`)[0]!.id;

  for (const ctx of [owner(), otherOwner()]) {
    await objects.defineKind(ctx, {
      key: "permit", label: "Permit", titleLabel: "Permit number", recordKind: "permit",
      links: ["customer", "property", "job", "equipment", "invoice", "membership", "record"],
    });
  }
  adaPermit = (await objects.createRecord(owner(), { type: "permit", title: "A-1", jobId: ada.job })).id;
  beaPermit = (await objects.createRecord(owner(), { type: "permit", title: "B-1", jobId: bea.job, invoiceId: bea.invoice })).id;
  beaEarlier = (await objects.createRecord(owner(), { type: "permit", title: "B-0", jobId: bea.job })).id;

  /** A technician whose company lets them file permits: the write is granted, the scope is still their own work. */
  const resolved = await resolve(TECH);
  tech = { ...resolved, actor: { ...resolved.actor, grants: [...(resolved.actor.grants ?? []), "record:write"] } };
  manager = await resolve(MANAGER);
});

afterAll(async () => { if (raw) await raw.end(); });

/** Each link to something outside one person's reach, with the key the refusal is at. */
const outside = (w: Work, person: string, record: string) => [
  { jobId: w.job }, { customerId: w.customer }, { propertyId: w.property },
  { equipmentId: w.unit }, { invoiceId: w.invoice }, { membershipId: person }, { linkedRecordId: record },
];

async function refused(ctx: ServiceContext, id: string, link: Record<string, string>) {
  const before = await objects.getRecord(owner(), { id });
  const error = await objects.updateRecord(ctx, { id, ...link }).then(() => null, (e: unknown) => e);
  expect(error, JSON.stringify(link)).toBeInstanceOf(UnprocessableError);
  expect((error as UnprocessableError).issues.map((i) => i.path)).toEqual(Object.keys(link));
  const after = await objects.getRecord(owner(), { id });
  expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
}

run("refusals: a link only ever goes to something the writer may open", () => {
  it("a technician cannot point their record at another job, its customer, address, unit, invoice, person or record", async () => {
    for (const link of outside(bea, managerMembership, beaPermit)) await refused(tech, adaPermit, link);
  });

  it("a technician cannot make a record pointing at any of them either", async () => {
    for (const link of outside(bea, managerMembership, beaPermit)) {
      await expect(objects.createRecord(tech, { type: "permit", title: "T-9", ...link })).rejects.toBeInstanceOf(UnprocessableError);
    }
  });

  it("a branch manager cannot point their branch's record at another branch's work or people", async () => {
    for (const link of outside(ada, austinPerson, adaPermit)) await refused(manager, beaPermit, link);
  });

  it("nobody can point a record at another company's, and the refusal reads as not there", async () => {
    const strangers = outside(theirs, theirPerson, fixtureId("record-links:nothing"));
    for (const link of strangers) await refused(owner(), adaPermit, link);
    const notThere = await objects.updateRecord(owner(), { id: adaPermit, jobId: fixtureId("record-links:no-job") }).catch((e: UnprocessableError) => e);
    const theirJob = await objects.updateRecord(owner(), { id: adaPermit, jobId: theirs.job }).catch((e: UnprocessableError) => e);
    expect((theirJob as UnprocessableError).issues).toEqual((notThere as UnprocessableError).issues);
  });

  it("another company cannot change this company's record at all", async () => {
    await expect(objects.updateRecord(otherOwner(), { id: adaPermit, jobId: theirs.job })).rejects.toThrow(/Record/);
  });

  it("somebody who may read records and not change them changes no link", async () => {
    const reader: ServiceContext = { ...manager, actor: { ...manager.actor, revocations: ["record:write"] } };
    await expect(objects.updateRecord(reader, { id: beaPermit, jobId: null })).rejects.toBeInstanceOf(PermissionError);
  });

  it("is refused over HTTP at the link's key", async () => {
    const response = await dispatch(new Request(`http://x/v1/custom-records/${beaPermit}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: ada.customer }),
    }), { db: db(), resolveSession: async () => manager });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("customerId");
  });
});

run("changing a record's links", () => {
  it("moves a record to another job, which brings its customer and address, audited and announced", async () => {
    const moved = await objects.updateRecord(owner(), { id: adaPermit, jobId: bea.job });
    expect(moved).toMatchObject({ job: { id: bea.job }, customer: { id: bea.customer }, property: { id: bea.property } });
    const [line] = await raw<{ before: { jobId: string }; after: { jobId: string } }[]>`
      select before, after from public.audit_log
      where organization_id = ${ORG} and entity_id = ${adaPermit} and action = 'custom_object_record.updated'
      order by created_at desc limit 1`;
    expect(line!.before.jobId).toBe(ada.job);
    expect(line!.after.jobId).toBe(bea.job);
    const [event] = await raw<{ payload: { record: { jobId: string } } }[]>`
      select payload from public.domain_event
      where organization_id = ${ORG} and entity_id = ${adaPermit} and name = 'record.updated'
      order by sequence desc limit 1`;
    expect(event!.payload.record.jobId).toBe(bea.job);
    await objects.updateRecord(owner(), { id: adaPermit, jobId: ada.job, customerId: ada.customer, propertyId: ada.property });
  });

  it("takes a link off with null, and points at a unit, a person and an earlier record", async () => {
    const changed = await objects.updateRecord(owner(), {
      id: beaPermit, invoiceId: null, equipmentId: bea.unit, membershipId: managerMembership, linkedRecordId: beaEarlier,
    });
    expect(changed.invoice).toBeNull();
    expect(changed).toMatchObject({ equipment: { id: bea.unit }, membership: { id: managerMembership }, record: { id: beaEarlier } });
    await expect(objects.updateRecord(owner(), { id: beaPermit, linkedRecordId: beaPermit })).rejects.toBeInstanceOf(UnprocessableError);
    await objects.updateRecord(owner(), { id: beaPermit, equipmentId: null, membershipId: null, linkedRecordId: null, invoiceId: bea.invoice });
  });

  it("a technician points their record at their own job's unit and at themselves", async () => {
    const changed = await objects.updateRecord(tech, { id: adaPermit, equipmentId: ada.unit, membershipId: techMembership });
    expect(changed).toMatchObject({ equipment: { id: ada.unit }, membership: { id: techMembership } });
    await objects.updateRecord(owner(), { id: adaPermit, equipmentId: null, membershipId: null });
  });

  it("a branch manager changes their branch's record within it", async () => {
    const changed = await objects.updateRecord(manager, { id: beaEarlier, customerId: bea.customer, membershipId: managerMembership });
    expect(changed).toMatchObject({ customer: { id: bea.customer }, membership: { id: managerMembership } });
  });

  it("a link sent as it already was is not checked again, so a name can be corrected beside one the writer cannot see", async () => {
    await objects.updateRecord(owner(), { id: beaEarlier, membershipId: austinPerson });
    const renamed = await objects.updateRecord(manager, { id: beaEarlier, title: "B-0a", membershipId: austinPerson });
    expect(renamed).toMatchObject({ title: "B-0a", membership: { id: austinPerson } });
  });

  it("offers a branch manager only their branch's people to point at", async () => {
    const offered = (await objects.peopleToLink(manager)).map((p) => p.membershipId);
    expect(offered).toContain(managerMembership);
    expect(offered).not.toContain(austinPerson);
    expect(offered).not.toContain(techMembership);
  });
});
