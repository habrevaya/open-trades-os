import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as objects from "../src/services/custom-objects";
import * as customFields from "../src/services/custom-fields";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import * as dispatch from "../src/services/dispatch";
import * as fieldOps from "../src/services/field";
import * as search from "../src/services/search";
import { inTenant, ConflictError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * WHERE A COMPANY'S OWN RECORDS REACH NOW
 *
 * A kind of record can point at an invoice, a person and a record of another
 * kind; its records are found by the search box, are on a technician's day
 * for a visit whose job or unit they point at, and, when the office turns it
 * on, on the customer's portal with only the fields marked for the customer.
 *
 * The portal is the part that matters most, so it is tested as a leak: a
 * field the office did not mark, and another customer's record, must not be
 * anywhere in what the portal is sent, not merely absent from the screen.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("reach:org");
const OWNER = fixtureId("reach:owner");
const TECH = fixtureId("reach:tech");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let techId = "";
let techMembership = "";
const tech = (): ServiceContext => ({
  actor: { userId: TECH, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: techId }, db: db(),
});

let ada = "";
let bea = "";
let adaProperty = "";
let adaJob = "";
let beaJob = "";
let adaInvoice = "";
let invoiceNumber = 7100;

async function customer(name: string): Promise<{ id: string; property: string }> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, ${name}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${`1 ${name} St`}, 'Austin', 'TX', '78701') returning id`;
  return { id: c!.id, property: p!.id };
}

async function job(customerId: string, propertyId: string, number: number): Promise<string> {
  const [j] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, 'scheduled', ${`Job ${number}`}) returning id`;
  return j!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Reach Co", slug: "record-reach-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`delete from public."user" where id = ${TECH}`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, 'tech@reach-co.test', 'Tia Tech')`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${TECH}, 'technician') returning id`;
  techMembership = m!.id;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${techMembership}, 'Tia Tech') returning id`;
  techId = t!.id;

  const a = await customer("Ada");
  const b = await customer("Bea");
  ada = a.id; adaProperty = a.property; bea = b.id;
  adaJob = await job(ada, a.property, 9101);
  beaJob = await job(bea, b.property, 9102);
  invoiceNumber += 1;
  const [inv] = await raw<{ id: string }[]>`insert into public.invoice
    (organization_id, number, customer_id, job_id, status, issued_on, due_on, total, balance)
    values (${ORG}, ${invoiceNumber}, ${ada}, ${adaJob}, 'open', current_date, current_date, 100, 100) returning id`;
  adaInvoice = inv!.id;
});

async function permitKind(over: Partial<Parameters<typeof objects.defineKind>[1]> = {}) {
  await objects.defineKind(owner(), {
    key: "permit", label: "Permit", titleLabel: "Permit number", links: ["customer", "job", "invoice"], ...over,
  });
  await customFields.define(owner(), {
    entityType: "object:permit", key: "status", label: "Status", dataType: "select", options: ["submitted", "approved"],
  });
  await customFields.define(owner(), { entityType: "object:permit", key: "inspector_notes", label: "Inspector notes" });
}

const fieldId = async (key: string) => {
  const [row] = await raw<{ id: string }[]>`select id from public.custom_field_definition
    where organization_id = ${ORG} and entity_type = 'object:permit' and key = ${key} and deleted_at is null`;
  return row!.id;
};

run("pointing at an invoice, a person and another kind of record", () => {
  it("carries an invoice's customer, and names the invoice on the record", async () => {
    await permitKind();
    const permit = await objects.createRecord(owner(), { type: "permit", title: "P-1", invoiceId: adaInvoice });
    expect(permit).toMatchObject({ invoice: { id: adaInvoice, name: `Invoice ${invoiceNumber}` }, customer: { id: ada } });
    await expect(objects.createRecord(owner(), { type: "permit", title: "P-2", invoiceId: fixtureId("no-invoice") }))
      .rejects.toThrow(UnprocessableError);
  });

  it("points at a person by membership, and refuses somebody outside the company", async () => {
    await objects.defineKind(owner(), { key: "van_check", label: "Van check", links: ["membership"] });
    const check = await objects.createRecord(owner(), { type: "van_check", title: "Monday", membershipId: techMembership });
    expect(check.membership).toEqual({ id: techMembership, name: "Tia Tech" });
    const onPage = await objects.recordsFor(owner(), { link: "membership", id: techMembership });
    expect(onPage.map((g) => g.records.map((r) => r.title))).toEqual([["Monday"]]);
    await expect(objects.createRecord(owner(), { type: "van_check", title: "X", membershipId: fixtureId("stranger") }))
      .rejects.toMatchObject({ issues: [{ path: "membershipId", message: "That is not somebody in this company." }] });
  });

  it("points at a record of the kind it names, never another kind or itself", async () => {
    await expect(objects.defineKind(owner(), { key: "inspection", label: "Inspection", links: ["record"] }))
      .rejects.toThrow(UnprocessableError);
    await expect(objects.defineKind(owner(), { key: "inspection", label: "Inspection", links: ["record"], recordKind: "truck" }))
      .rejects.toThrow(UnprocessableError);
    await objects.defineKind(owner(), { key: "truck", label: "Truck" });
    await permitKind();
    await objects.defineKind(owner(), { key: "inspection", label: "Inspection", links: ["record"], recordKind: "truck" });

    const truck = await objects.createRecord(owner(), { type: "truck", title: "Van 3" });
    const permit = await objects.createRecord(owner(), { type: "permit", title: "P-9", customerId: ada });
    const inspection = await objects.createRecord(owner(), { type: "inspection", title: "Monday", linkedRecordId: truck.id });
    expect(inspection.record).toEqual({ id: truck.id, name: "Van 3", type: "truck" });
    await expect(objects.createRecord(owner(), { type: "inspection", title: "Wrong", linkedRecordId: permit.id }))
      .rejects.toThrow(UnprocessableError);
    await expect(objects.updateRecord(owner(), { id: inspection.id, linkedRecordId: inspection.id }))
      .rejects.toThrow(UnprocessableError);

    // The truck's page lists its inspections, and only kinds that point at trucks.
    const onTruck = await objects.recordsFor(owner(), { link: "record", id: truck.id });
    expect(onTruck.map((g) => [g.kind.key, g.records.map((r) => r.title)])).toEqual([["inspection", ["Monday"]]]);
  });
});

run("the customer's portal", () => {
  async function accountOf(customerId: string) {
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId, scope: "customer", expiresInDays: 1,
    }));
    return portalAccount.viewAccount(db(), { token: link.token });
  }

  it("shows nothing until the office turns the kind on", async () => {
    await permitKind();
    await objects.createRecord(owner(), {
      type: "permit", title: "P-100", customerId: ada, customFields: { status: "approved", inspector_notes: "Grumpy" },
    });
    expect((await accountOf(ada)).records).toEqual([]);
  });

  it("shows only the marked fields, and never another customer's record", async () => {
    await permitKind({ customerVisible: true });
    await customFields.update(owner(), { id: await fieldId("status"), customerVisible: true });
    await objects.createRecord(owner(), {
      type: "permit", title: "P-ADA", jobId: adaJob,
      customFields: { status: "approved", inspector_notes: "SECRET-NOTE-ADA" },
    });
    await objects.createRecord(owner(), {
      type: "permit", title: "P-BEA", customerId: bea, customFields: { status: "submitted", inspector_notes: "SECRET-NOTE-BEA" },
    });
    // A record that names Ada and Bea's job disagrees with itself, and goes to neither.
    await objects.createRecord(owner(), { type: "permit", title: "P-MIXED", customerId: ada, jobId: beaJob });

    const account = await accountOf(ada);
    expect(account.records).toEqual([{
      heading: "Permits", type: "permit",
      records: [{ id: expect.any(String), title: "P-ADA", fields: [{ label: "Status", value: "approved" }] }],
    }]);
    const sent = JSON.stringify(account);
    expect(sent).not.toContain("SECRET-NOTE");
    expect(sent).not.toContain("Inspector notes");
    expect(sent).not.toContain("P-BEA");
    expect(sent).not.toContain("P-MIXED");

    const theirs = JSON.stringify(await accountOf(bea));
    expect(theirs).toContain("P-BEA");
    expect(theirs).not.toContain("P-ADA");
    expect(theirs).not.toContain("SECRET-NOTE");
  });

  it("does not show a field defined again under a retired key until it is marked again", async () => {
    await permitKind({ customerVisible: true });
    await customFields.update(owner(), { id: await fieldId("inspector_notes"), customerVisible: true });
    await objects.createRecord(owner(), { type: "permit", title: "P-1", customerId: ada, customFields: { inspector_notes: "Fine" } });
    expect(JSON.stringify((await accountOf(ada)).records)).toContain("Fine");

    await customFields.remove(owner(), { id: await fieldId("inspector_notes"), force: true });
    await customFields.define(owner(), { entityType: "object:permit", key: "inspector_notes", label: "Inspector notes" });
    expect(JSON.stringify((await accountOf(ada)).records)).not.toContain("Fine");
  });

  it("is refused for a kind that points at nothing of a customer's, and a field off a kind of record", async () => {
    await expect(objects.defineKind(owner(), { key: "truck", label: "Truck", customerVisible: true }))
      .rejects.toThrow(UnprocessableError);
    await expect(objects.defineKind(owner(), { key: "plate", label: "Plate", links: ["property"], customerVisible: true }))
      .rejects.toThrow(UnprocessableError);
    await expect(customFields.define(owner(), { entityType: "customer", key: "vip", label: "VIP", customerVisible: true }))
      .rejects.toThrow(ConflictError);
  });
});

run("on a technician's day", () => {
  it("shows the records on the visit's job and on a unit on the visit, of kinds they may read, and no other", async () => {
    await permitKind();
    await objects.defineKind(owner(), { key: "registration", label: "Registration", links: ["equipment"] });
    await objects.defineKind(owner(), {
      key: "rebate", label: "Rebate", links: ["job"], readPermission: "job.cost:read",
    });
    await customFields.define(owner(), { entityType: "object:registration", key: "code", label: "Code" });

    const start = time.instantOfLocal(companyToday(), 12 * 60, ZONE);
    const [visit] = await raw<{ id: string }[]>`insert into public.visit
      (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${adaJob}, 'scheduled', ${start}, ${new Date(start.getTime() + 3_600_000)}, 60) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
      values (${ORG}, ${visit!.id}, ${techId}, true)`;
    const [unit] = await raw<{ id: string }[]>`insert into public.equipment (organization_id, property_id, category)
      values (${ORG}, ${adaProperty}, 'furnace') returning id`;
    const [otherUnit] = await raw<{ id: string }[]>`insert into public.equipment (organization_id, property_id, category)
      values (${ORG}, ${adaProperty}, 'water heater') returning id`;
    await raw`insert into public.visit_asset (organization_id, visit_id, equipment_id) values (${ORG}, ${visit!.id}, ${unit!.id})`;

    await objects.createRecord(owner(), { type: "permit", title: "P-JOB", jobId: adaJob, customFields: { status: "approved" } });
    await objects.createRecord(owner(), { type: "permit", title: "P-OTHER", jobId: beaJob });
    await objects.createRecord(owner(), { type: "registration", title: "R-UNIT", equipmentId: unit!.id, customFields: { code: "AB12" } });
    await objects.createRecord(owner(), { type: "registration", title: "R-OTHER-UNIT", equipmentId: otherUnit!.id });
    await objects.createRecord(owner(), { type: "rebate", title: "REBATE", jobId: adaJob });

    const device = await fieldOps.register(tech(), { installationId: `reach-${crypto.randomUUID()}` });
    const day = await dispatch.snapshot(tech(), { deviceId: device.deviceId, from: companyToday(), days: 1 });
    const records = day.visits.find((v) => v.id === visit!.id)!.records!;
    expect(records.map((r) => r.title).sort()).toEqual(["P-JOB", "R-UNIT"]);
    expect(records.find((r) => r.title === "P-JOB")).toMatchObject({ kind: "Permit", fields: [{ label: "Status", value: "approved" }] });
    expect(records.find((r) => r.title === "R-UNIT")).toMatchObject({ kind: "Registration", fields: [{ label: "Code", value: "AB12" }] });

    // A change to one of them is a new revision, so the poll fetches it.
    const again = await dispatch.snapshot(tech(), { deviceId: device.deviceId, from: companyToday(), days: 1, sinceRevision: day.revision });
    expect(again.unchanged).toBe(true);
    await raw`update public.custom_object_record set updated_at = now() + interval '1 minute' where title = 'P-JOB' and organization_id = ${ORG}`;
    const moved = await dispatch.snapshot(tech(), { deviceId: device.deviceId, from: companyToday(), days: 1, sinceRevision: day.revision });
    expect(moved.unchanged).toBe(false);
  });
});

run("the search box", () => {
  it("finds a record by a value, a job by its number and a customer by name, within what the caller may read", async () => {
    await permitKind();
    await objects.defineKind(owner(), { key: "rebate", label: "Rebate", links: ["job"], readPermission: "job.cost:read" });
    await customFields.define(owner(), { entityType: "object:rebate", key: "ref", label: "Ref" });
    await objects.createRecord(owner(), { type: "permit", title: "P-777", jobId: adaJob, customFields: { inspector_notes: "zebra crossing" } });
    await objects.createRecord(owner(), { type: "permit", title: "P-778", jobId: beaJob, customFields: { inspector_notes: "zebra stripes" } });
    await objects.createRecord(owner(), { type: "rebate", title: "R-1", jobId: adaJob, customFields: { ref: "zebra rebate" } });

    const all = await search.everything(owner(), { q: "zebra" });
    expect(all.groups.map((g) => [g.key, g.hits.map((h) => h.title).sort()])).toEqual([
      ["record:permit", ["P-777", "P-778"]],
      ["record:rebate", ["R-1"]],
    ]);
    expect(all.groups[0]!.hits.find((h) => h.title === "P-777")!.href).toMatch(/^\/records\/permit\//);

    expect((await search.everything(owner(), { q: "9101" })).groups).toEqual([
      expect.objectContaining({ key: "jobs", hits: [expect.objectContaining({ title: "Job 9101: Job 9101" })] }),
    ]);
    expect((await search.everything(owner(), { q: "Ada" })).groups[0]).toMatchObject({ key: "customers" });
    expect((await search.everything(owner(), { q: "z" })).groups).toEqual([]);

    // A technician on no visit sees neither job's permits, and never the rebate kind.
    const theirs = await search.everything(tech(), { q: "zebra" });
    expect(theirs.groups).toEqual([]);
    expect((await search.everything(tech(), { q: "9101" })).groups).toEqual([]);
  });
});
