import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as notes from "../src/services/customer-notes";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as company from "../src/services/company";
import * as lifecycle from "../src/services/customer-lifecycle";
import * as fieldOps from "../src/services/field";
import * as dispatchSvc from "../src/services/dispatch";
import { inTenant, ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * NOTES ON A CUSTOMER
 *
 * The customer's `notes` column was one box nothing read. These are dated,
 * signed notes that are added to rather than rewritten: its author fixes one
 * for a few minutes, after which a correction is a new note naming the one it
 * corrects. Read through the customer under the caller's scope, so another
 * company's customer and a customer in another branch are not there; and a
 * technician reads, on the API and on the visit, only what the office marked
 * for the field.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cnotes:org");
const OWNER = fixtureId("cnotes:owner");
const CSR = fixtureId("cnotes:csr");
const HANA = fixtureId("cnotes:hana");
const RAY = fixtureId("cnotes:ray");
const OTHER_ORG = fixtureId("cnotes:other-org");
const OTHER_OWNER = fixtureId("cnotes:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] }, db: db() });
const csr = (): ServiceContext => ({ actor: { userId: CSR, organizationId: ORG, roles: ["csr"] as Actor["roles"] }, db: db() });
let austin = "";
let houston = "";
let rayTech = "";
const houstonManager = (): ServiceContext => ({
  actor: { userId: HANA, organizationId: ORG, roles: ["branch_manager"], businessUnitId: houston }, db: db(),
});
const ray = (): ServiceContext => ({
  actor: { userId: RAY, organizationId: ORG, roles: ["technician"], technicianId: rayTech }, db: db(),
});

let austinCustomer = "";
let houstonCustomer = "";
let strangerCustomer = "";

async function person(userId: string, email: string, name: string, role: string): Promise<string> {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}::public.member_role) returning id`;
  return row!.id;
}

const newCustomer = async (ctx: ServiceContext, name: string) => (await customers.create(ctx, {
  type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
})).id as string;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Notes Co", slug: "customer-notes-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_OWNER, name: "Other Notes Co", slug: "customer-notes-other" });
  await person(CSR, "cnotes-csr@test.local", "Cass Desk", "csr");
  await person(HANA, "cnotes-hana@test.local", "Hana Houston", "office_manager");
  const rayMembership = await person(RAY, "cnotes-ray@test.local", "Ray Field", "technician");
  const [tech] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${rayMembership}, 'Ray Field') returning id`;
  rayTech = tech!.id;

  austin = (await company.createBusinessUnit(owner(), { name: "Austin", code: "AUS" })).id;
  houston = (await company.createBusinessUnit(owner(), { name: "Houston", code: "HOU" })).id;

  austinCustomer = await newCustomer(owner(), "Austin Notes Owner");
  houstonCustomer = await newCustomer(owner(), "Houston Notes Owner");
  const place = async (customerId: string, line1: string) => (await properties.create(owner(), {
    address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  const austinPlace = await place(austinCustomer, "1 Note St");
  const houstonPlace = await place(houstonCustomer, "2 Note St");
  const austinJob = (await jobs.create(owner(), {
    customerId: austinCustomer, propertyId: austinPlace, summary: "Austin furnace", tags: [], customFields: {}, businessUnitId: austin,
  })).id as string;
  await jobs.create(owner(), {
    customerId: houstonCustomer, propertyId: houstonPlace, summary: "Houston condenser", tags: [], customFields: {}, businessUnitId: houston,
  });
  /** Ray is sent to the Austin customer and nobody else, an hour from now. */
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end)
    values (${ORG}, ${austinJob}, 1, 'dispatched', ${new Date(Date.now() + 3600_000)}, ${new Date(Date.now() + 7200_000)})
    returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
    values (${ORG}, ${visit!.id}, ${rayTech}, true)`;

  strangerCustomer = await newCustomer(
    { actor: { userId: OTHER_OWNER, organizationId: OTHER_ORG, roles: ["owner"] }, db: db() }, "Someone Else's Customer",
  );
});

afterAll(async () => { if (raw) await raw.end(); });

run("dated, signed notes on a customer", () => {
  it("writes, signs and lists them, pinned first and then newest first", async () => {
    const first = await notes.add(owner(), { id: austinCustomer, body: "  Prefers mornings.\nCall before coming.  " });
    expect(first).toMatchObject({
      body: "Prefers mornings.\nCall before coming.", origin: "typed", pinned: false, forField: false,
      author: { userId: OWNER },
    });
    expect(first.editableUntil).not.toBeNull();
    const second = await notes.add(csr(), { id: austinCustomer, body: "Disputed the March invoice." });
    const pinned = await notes.add(csr(), { id: austinCustomer, body: "Large dog in the yard.", pinned: true, forField: true });

    const listed = await notes.list(owner(), { id: austinCustomer });
    expect(listed.fieldOnly).toBe(false);
    expect(listed.pinned.map((n) => n.id)).toEqual([pinned.id]);
    expect(listed.data.map((n) => n.id).slice(0, 2)).toEqual([second.id, first.id]);
    expect(listed.data.find((n) => n.id === second.id)!.author).toEqual({ userId: CSR, name: "Cass Desk" });
    // Somebody else's note offers nobody else the pencil.
    expect(listed.data.find((n) => n.id === second.id)!.editableUntil).toBeNull();

    const unpinned = await notes.pin(owner(), { id: pinned.id, pinned: false });
    expect(unpinned.pinned).toBe(false);
    const again = await notes.pin(owner(), { id: pinned.id, pinned: false });
    expect(again.pinnedAt).toBeNull();
  });

  it("lets its author fix a note for a short while, and after that a correction is a new note", async () => {
    const note = await notes.add(csr(), { id: austinCustomer, body: "Gate code 1243." });
    const fixed = await notes.edit(csr(), { id: note.id, body: "Gate code 1234." });
    expect(fixed.body).toBe("Gate code 1234.");
    expect(fixed.editedAt).not.toBeNull();

    // Somebody else may not, however fresh it is.
    await expect(notes.edit(owner(), { id: note.id, body: "Gate code 9999." }))
      .rejects.toThrow(/Only the person who wrote a note/);

    // Twenty minutes on, not even its author.
    await raw`update public.customer_note set created_at = now() - interval '20 minutes' where id = ${note.id}`;
    await expect(notes.edit(csr(), { id: note.id, body: "Gate code 4321." }))
      .rejects.toThrow(ConflictError);

    const correction = await notes.add(csr(), {
      id: austinCustomer, body: "The gate code changed to 4321.", correctsNoteId: note.id,
    });
    expect(correction.correctsNoteId).toBe(note.id);
    const [kept] = await raw<{ body: string }[]>`select body from public.customer_note where id = ${note.id}`;
    expect(kept!.body).toBe("Gate code 1234.");

    // A correction names one of this customer's notes, not somebody else's.
    await expect(notes.add(csr(), { id: houstonCustomer, body: "Wrong one.", correctsNoteId: note.id }))
      .rejects.toThrow(/not one of this customer's notes/);
  });

  it("dates a note from another system on its day, and only with data:import past a week", async () => {
    const old = "2021-03-04T15:00:00.000Z";
    await expect(notes.add(csr(), { id: austinCustomer, body: "From the old system.", notedAt: old }))
      .rejects.toThrow(PermissionError);
    const brought = await notes.add(owner(), {
      id: austinCustomer, body: "From the old system.", notedAt: old, externalRef: { source: "jobber", id: "note-1" },
    });
    expect(brought).toMatchObject({ origin: "imported", author: null, notedAt: old, editableUntil: null });
    await expect(notes.edit(owner(), { id: brought.id, body: "Changed." })).rejects.toThrow(/came in from a file/);
    await expect(notes.add(owner(), {
      id: austinCustomer, body: "Again.", notedAt: old, externalRef: { source: "jobber", id: "note-1" },
    })).rejects.toThrow(/already here/);
    await expect(notes.add(owner(), {
      id: austinCustomer, body: "Tomorrow.", notedAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    })).rejects.toThrow(/has not happened yet|future/);
  });

  it("is another company's customer: not there", async () => {
    await expect(notes.list(owner(), { id: strangerCustomer })).rejects.toThrow(NotFoundError);
    await expect(notes.add(owner(), { id: strangerCustomer, body: "Hello." })).rejects.toThrow(NotFoundError);
  });

  it("is a customer in another branch: not there for a branch manager, and every note for one in theirs", async () => {
    const office = await notes.add(owner(), { id: houstonCustomer, body: "Pays late." });
    await expect(notes.list(houstonManager(), { id: austinCustomer })).rejects.toThrow(NotFoundError);
    await expect(notes.add(houstonManager(), { id: austinCustomer, body: "Not mine." })).rejects.toThrow(NotFoundError);
    const austinNote = (await notes.list(owner(), { id: austinCustomer })).data[0]!;
    await expect(notes.pin(houstonManager(), { id: austinNote.id, pinned: true })).rejects.toThrow(NotFoundError);

    const theirs = await notes.list(houstonManager(), { id: houstonCustomer });
    expect(theirs.fieldOnly).toBe(false);
    expect(theirs.data.map((n) => n.id)).toContain(office.id);
  });

  it("shows a technician only the notes marked for the field, on the API and on the visit", async () => {
    const office = await notes.add(owner(), { id: austinCustomer, body: "Asked about financing." });
    const field = await notes.add(owner(), { id: austinCustomer, body: "Shut the side gate, the dog gets out.", forField: true });

    const read = await notes.list(ray(), { id: austinCustomer });
    expect(read.fieldOnly).toBe(true);
    const seen = [...read.pinned, ...read.data].map((n) => n.id);
    expect(seen).toContain(field.id);
    expect(seen).not.toContain(office.id);
    expect([...read.pinned, ...read.data].every((n) => n.forField)).toBe(true);
    await expect(notes.list(ray(), { id: houstonCustomer })).rejects.toThrow(NotFoundError);
    // A note they may not read is not there to pin either.
    await expect(notes.pin(ray(), { id: office.id, pinned: true })).rejects.toThrow(PermissionError);

    const device = await fieldOps.register(ray(), { installationId: `cnotes-${crypto.randomUUID()}` });
    const day = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 2 });
    const visit = day.visits.find((v) => v.customer.id === austinCustomer)!;
    const onVisit = (visit.customerNotes ?? []).map((n) => n.body);
    expect(onVisit).toContain("Shut the side gate, the dog gets out.");
    expect(onVisit).not.toContain("Asked about financing.");

    // Marking one for the field afterwards reaches the phone on its next poll.
    const later = await notes.add(owner(), { id: austinCustomer, body: "Bring the long ladder.", forField: true });
    const again = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 2, sinceRevision: day.revision });
    expect(again.unchanged).toBe(false);
    expect(again.visits.find((v) => v.customer.id === austinCustomer)!.customerNotes!.map((n) => n.id)).toContain(later.id);
  });

  it("moves with a merge", async () => {
    const dupe = await newCustomer(owner(), "Austin Notes Owner Again");
    const moved = await notes.add(owner(), { id: dupe, body: "Written on the duplicate." });
    await lifecycle.merge(owner(), { keepId: austinCustomer, mergeId: dupe });
    const listed = await notes.list(owner(), { id: austinCustomer, limit: 200 });
    expect(listed.data.map((n) => n.id)).toContain(moved.id);
  });

  it("is the API's, under the route's permissions, and a retried add is the first answer", async () => {
    const call = async (method: string, path: string, body: unknown, ctx: ServiceContext, key: string) => {
      const response = await dispatch(new Request(`http://x${path}`, {
        method,
        headers: { "content-type": "application/json", "idempotency-key": key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { db: db(), resolveSession: async () => ctx });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const key = `cnotes-${Date.now()}`;
    const first = await call("POST", `/v1/customers/${houstonCustomer}/notes`, { body: "Once.", forField: true }, owner(), key);
    expect(first.status).toBe(201);
    const second = await call("POST", `/v1/customers/${houstonCustomer}/notes`, { body: "Once.", forField: true }, owner(), key);
    expect(second.body["id"]).toBe(first.body["id"]);

    const listed = await call("GET", `/v1/customers/${houstonCustomer}/notes?limit=1`, undefined, owner(), `${key}-l`);
    expect(listed.status).toBe(200);
    expect((listed.body["data"] as unknown[]).length).toBe(1);
    expect(listed.body["hasMore"]).toBe(true);
    const page2 = await call("GET", `/v1/customers/${houstonCustomer}/notes?limit=1&cursor=${String(listed.body["nextCursor"])}`, undefined, owner(), `${key}-l2`);
    expect((page2.body["data"] as { id: string }[])[0]!.id).not.toBe((listed.body["data"] as { id: string }[])[0]!.id);

    const edited = await call("PATCH", `/v1/customer-notes/${first.body["id"] as string}`, { forField: false }, owner(), `${key}-e`);
    expect(edited.status).toBe(200);
    expect(edited.body["forField"]).toBe(false);

    // A technician reads; they do not write.
    const refused = await call("POST", `/v1/customers/${austinCustomer}/notes`, { body: "Mine." }, ray(), `${key}-t`);
    expect(refused.status).toBe(403);
  });

  it("carries the old notes box into a first note and empties it", async () => {
    const boxed = await newCustomer(owner(), "Old Box Owner");
    await raw`update public.customer set notes = ${"  Called about a leak in 2019.  "} where id = ${boxed}`;
    const carried = await inTenant(owner(), (tx) => notes.carryOldBox(tx));
    expect(carried).toBe(1);
    const listed = await notes.list(owner(), { id: boxed });
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ body: "Called about a leak in 2019.", origin: "carried", author: null, editableUntil: null });
    const [row] = await raw<{ notes: string | null }[]>`select notes from public.customer where id = ${boxed}`;
    expect(row!.notes).toBeNull();
  });
});
