import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as contacts from "../src/services/contacts";
import * as notes from "../src/services/customer-notes";
import * as jobs from "../src/services/jobs";
import * as lifecycle from "../src/services/customer-lifecycle";
import * as duplicates from "../src/services/customer-duplicates";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * AN ADDRESS'S OWN PEOPLE, A CUSTOMER LIST THAT READS NOTES, AND AN UNDONE
 * MERGE THAT SAYS THE TWO ARE DIFFERENT PEOPLE
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("crmx:org");
const OWNER = fixtureId("crmx:owner");
const RAY = fixtureId("crmx:ray");

let raw: postgres.Sql;
let rayTech = "";
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const ray = (): ServiceContext => ({
  actor: { userId: RAY, organizationId: ORG, roles: ["technician"], technicianId: rayTech }, db: db(),
});

const make = async (name: string, over: Record<string, unknown> = {}) => (await customers.create(owner(), {
  type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {}, ...over,
})).id as string;
const place = (line1: string, customerId?: string) => properties.create(owner(), {
  address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
  hasDog: false, customFields: {},
  ...(customerId ? { customerId, customerRole: "owner" as const } : {}),
} as Parameters<typeof properties.create>[1]).then((p) => p.id as string);

let visited = "";
let unvisited = "";
let visitedPlace = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Crm Extras Co", slug: "crm-extras-co" });
  await raw`delete from public."user" where id = ${RAY} or email = 'crmx-ray@test.local'`;
  await raw`insert into public."user" (id, email, name) values (${RAY}, 'crmx-ray@test.local', 'Ray Field')`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${RAY}, 'technician') returning id`;
  const [tech] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${membership!.id}, 'Ray Field') returning id`;
  rayTech = tech!.id;

  visited = await make("Visited Vera");
  unvisited = await make("Unvisited Una");
  visitedPlace = await place("1 Sent St", visited);
  const job = (await jobs.create(owner(), {
    customerId: visited, propertyId: visitedPlace, summary: "Furnace", tags: [], customFields: {},
  })).id as string;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end)
    values (${ORG}, ${job}, 1, 'dispatched', ${new Date(Date.now() + 3600_000)}, ${new Date(Date.now() + 7200_000)}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${visit!.id}, ${rayTech}, true)`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("the customer list reads notes", () => {
  it("finds a customer by a word in one of their notes, among the customers the caller may see", async () => {
    await notes.add(owner(), { id: visited, body: "The gate code is swordfish." });
    await notes.add(owner(), { id: visited, body: "Beware the parrot.", forField: true });
    await notes.add(owner(), { id: unvisited, body: "Swordfish for dinner." });

    const found = await customers.list(owner(), { q: "swordfish", limit: 20, includeInactive: false });
    expect(found.data.map((c) => c.id).sort()).toEqual([visited, unvisited].sort());
    // Every word has to be somewhere: a name word and a note word together.
    expect((await customers.list(owner(), { q: "vera swordfish", limit: 20, includeInactive: false })).data.map((c) => c.id)).toEqual([visited]);
    expect((await customers.list(owner(), { q: "swordfish parrot", limit: 20, includeInactive: false })).data.map((c) => c.id)).toEqual([visited]);
    expect((await customers.list(owner(), { q: "nothingwritten", limit: 20, includeInactive: false })).data).toEqual([]);
  });

  it("shows a technician only the notes marked for the field, and only their own customers", async () => {
    expect((await customers.list(ray(), { q: "swordfish", limit: 20, includeInactive: false })).data).toEqual([]);
    expect((await customers.list(ray(), { q: "parrot", limit: 20, includeInactive: false })).data.map((c) => c.id)).toEqual([visited]);
    // A note on a customer they were not sent to is not found by it, marked for the field or not.
    await notes.add(owner(), { id: unvisited, body: "Parrot on the porch.", forField: true });
    expect((await customers.list(ray(), { q: "parrot", limit: 20, includeInactive: false })).data.map((c) => c.id)).toEqual([visited]);
  });
});

run("the people at an address with no customer", () => {
  let lonely = "";

  it("adds, lists, changes, makes primary and removes somebody at an address nobody owns yet", async () => {
    lonely = await place("7 Nobody Ln");
    expect((await contacts.listForProperty(owner(), { id: lonely })).contacts).toEqual([]);

    const tess = await contacts.addForProperty(owner("addr-1"), { id: lonely, name: "Tess Tenant", phone: "+15125550911", title: "Tenant" });
    expect(tess).toMatchObject({ customerId: null, propertyId: lonely, name: "Tess Tenant", isPrimary: false });
    // A retry is the first person, not a second.
    expect((await contacts.addForProperty(owner("addr-1"), { id: lonely, name: "Tess Tenant", phone: "+15125550911", title: "Tenant" })).id).toBe(tess.id);
    const sam = await contacts.addForProperty(owner(), { id: lonely, name: "Sam Site", email: "sam@example.test", preferredChannel: "email", isPrimary: true });
    expect(sam.isPrimary).toBe(true);

    const listed = (await contacts.listForProperty(owner(), { id: lonely })).contacts;
    expect(listed.map((c) => [c.name, c.isPrimary, c.customerName])).toEqual([["Sam Site", true, null], ["Tess Tenant", false, null]]);

    const changed = await contacts.edit(owner(), { id: tess.id, phone: "+15125550922" });
    expect(changed.phone).toBe("+15125550922");
    await contacts.makePrimary(owner(), { id: tess.id });
    const after = (await contacts.listForProperty(owner(), { id: lonely })).contacts;
    expect(after.map((c) => [c.name, c.isPrimary])).toEqual([["Tess Tenant", true], ["Sam Site", false]]);

    await contacts.removeOnce(owner(), { id: sam.id });
    expect((await contacts.listForProperty(owner(), { id: lonely })).contacts.map((c) => c.name)).toEqual(["Tess Tenant"]);
  });

  it("refuses a person who cannot be reached, an address that does not exist, and a caller who may not write", async () => {
    await expect(contacts.addForProperty(owner(), { id: lonely, name: "No Way" })).rejects.toThrow(/phone number or an email/);
    await expect(contacts.addForProperty(owner(), { id: lonely, name: "Text Only", email: "t@example.test", preferredChannel: "sms" }))
      .rejects.toThrow(/prefer texts/);
    await expect(contacts.listForProperty(owner(), { id: "00000000-0000-0000-0000-00000000dead" })).rejects.toThrow(NotFoundError);
    await expect(contacts.addForProperty(ray(), { id: visitedPlace, name: "Ray Adds", phone: "+15125550933" })).rejects.toThrow(PermissionError);
  });

  it("lists the people at an address also on a customer, naming the account, and hides an address a technician was not sent to", async () => {
    await contacts.create(owner(), { name: "Mona Manager", customerId: visited, propertyId: visitedPlace, phone: "+15125550944" });
    const seen = (await contacts.listForProperty(ray(), { id: visitedPlace })).contacts;
    expect(seen.map((c) => [c.name, c.customerName])).toEqual([["Mona Manager", "Visited Vera"]]);
    await expect(contacts.listForProperty(ray(), { id: lonely })).rejects.toThrow(NotFoundError);
  });
});

run("taking a merge back and saying they are two people", () => {
  const pair = async (tag: string) => {
    const keep = await make(`Pat ${tag} One`, { phone: `+1512555${tag}` });
    const dupe = await make(`Pat ${tag} Two`, { phone: `+1512555${tag}` });
    return { keep, dupe };
  };
  const offered = async (a: string, b: string) => {
    const all = await duplicates.sweep(owner(), { limit: 200 });
    return all.data.some((p) => [p.a.id, p.b.id].sort().join() === [a, b].sort().join());
  };

  it("leaves the pair offered when only the merge is undone", async () => {
    const { keep, dupe } = await pair("1001");
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    const undone = await lifecycle.undoMerge(owner(), { id: merged.mergeRecordId });
    expect(undone.markedNotSame).toBe(false);
    expect(await offered(keep, dupe)).toBe(true);
  });

  it("marks the two as different people when asked, once, with the reason, and the matcher stops offering them", async () => {
    const { keep, dupe } = await pair("1002");
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    const undone = await lifecycle.undoMerge(owner("undo-1"), { id: merged.mergeRecordId, reason: "Father and son", markNotSame: true });
    expect(undone).toMatchObject({ restoredId: dupe, markedNotSame: true });
    expect(await offered(keep, dupe)).toBe(false);
    const set = await duplicates.setAside(owner(), {});
    expect(set.data.find((p) => [p.a.id, p.b.id].includes(dupe))).toMatchObject({ reason: "Father and son" });
    // A retry is the first answer, and the mark is not doubled.
    expect(await lifecycle.undoMerge(owner("undo-1"), { id: merged.mergeRecordId, reason: "Father and son", markNotSame: true })).toEqual(undone);
    const [marks] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.customer_not_duplicate where organization_id = ${ORG}
        and customer_a_id in (${keep}, ${dupe}) and customer_b_id in (${keep}, ${dupe})`;
    expect(marks!.n).toBe(1);
    const [audited] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log where organization_id = ${ORG} and action = 'customer.not_duplicate' and entity_id in (${keep}, ${dupe})`;
    expect(audited!.n).toBe(1);
  });

  it("is not blocked or doubled when the pair was already marked", async () => {
    const { keep, dupe } = await pair("1003");
    await duplicates.dismiss(owner(), { customerId: keep, otherId: dupe, reason: "Said so earlier" });
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    expect((await lifecycle.undoMerge(owner(), { id: merged.mergeRecordId, markNotSame: true })).markedNotSame).toBe(true);
    const [marks] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.customer_not_duplicate where organization_id = ${ORG}
        and customer_a_id in (${keep}, ${dupe}) and customer_b_id in (${keep}, ${dupe})`;
    expect(marks!.n).toBe(1);
  });
});
