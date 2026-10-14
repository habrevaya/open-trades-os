import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as me from "../src/services/me";
import * as peopleRecords from "../src/services/people-records";
import { routes } from "../src/contracts";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A PERSON KEEPS THEIR OWN ADDRESS AND PHONE NUMBER
 *
 * Changed from My record, checked, audited, and read by the office with what each save
 * changed and when. Nothing the office can write, and nothing one person can do to
 * another's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("owncontact:org");
const OWNER = fixtureId("owncontact:owner");
const RAY = fixtureId("owncontact:ray");
const DANA = fixtureId("owncontact:dana");
const OFFICE = fixtureId("owncontact:office");
const HANA = fixtureId("owncontact:hana");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, role: string, extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: [role] as Actor["roles"], ...extra }, db: db(),
});
const ray = () => as(RAY, "technician");
const dana = () => as(DANA, "technician");
const office = () => as(OFFICE, "office_manager");
let rayMember = "";
let danaMember = "";
let houston = "";
let austin = "";

async function person(userId: string, name: string, role: string, unit: string | null): Promise<string> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@owncontact.test`;
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${ORG}, ${userId}, ${role}::member_role, ${unit}) returning id`;
  return m!.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Own Contact Co", slug: "owncontact-co" });
  const [h] = await raw`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  const [a] = await raw`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  houston = h!.id as string;
  austin = a!.id as string;
  rayMember = await person(RAY, "Ray Nunez", "technician", houston);
  danaMember = await person(DANA, "Dana Pike", "technician", austin);
  await person(OFFICE, "Olive Office", "office_manager", null);
  await person(HANA, "Hana Branch", "branch_manager", houston);
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.person_contact where organization_id = ${ORG}`;
});

const mine = (ctx: ServiceContext) => me.record(ctx).then((r) => r.ownContact);
const home = { phone: "(512) 555-0143", addressLine1: "12 Oak St", city: "Austin", state: "tx", postalCode: "78701" };

run("a person keeps their own address and phone", () => {
  it("starts with nothing, and saves what they give with the phone made dialable", async () => {
    expect(await mine(ray())).toEqual({ contact: null, changes: [] });
    const saved = await me.setOwnContact(ray(), home);
    expect(saved.contact).toMatchObject({
      phone: "+15125550143", addressLine1: "12 Oak St", addressLine2: null, city: "Austin", state: "TX", postalCode: "78701",
    });
    expect(saved.changes).toEqual([{
      at: expect.any(String), by: "Ray Nunez",
      changes: [
        { field: "phone", before: "none", after: "(512) 555-0143" },
        { field: "address", before: "none", after: "12 Oak St, Austin, TX 78701" },
      ],
    }]);
    expect((await mine(ray())).contact?.phone).toBe("+15125550143");
  });

  it("refuses in words what cannot be right and saves nothing", async () => {
    await expect(me.setOwnContact(ray(), { ...home, phone: "call me" })).rejects.toThrow(/is not a phone number/);
    await expect(me.setOwnContact(ray(), { ...home, postalCode: "" })).rejects.toThrow(/street, the town, the state and the ZIP/);
    await expect(me.setOwnContact(ray(), { ...home, state: "Texas" })).rejects.toThrow(/two letters/);
    await expect(me.setOwnContact(ray(), { ...home, postalCode: "787" })).rejects.toThrow(/five digits/);
    expect(await mine(ray())).toEqual({ contact: null, changes: [] });
  });

  it("writes a new version only when something differs, and the same again is nothing, not even an audit line", async () => {
    await me.setOwnContact(ray(), home);
    const audits = async () => (await raw`select count(*)::int as n from public.audit_log where action = 'person.contact_changed' and entity_id = ${rayMember}`)[0]!.n as number;
    const before = await audits();
    const again = await me.setOwnContact(ray(), { ...home, phone: "512-555-0143", state: "TX" });
    expect(again.changes).toHaveLength(1);
    expect(await audits()).toBe(before);
    const [{ n }] = await raw`select count(*)::int as n from public.person_contact where membership_id = ${rayMember}` as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it("records each change with what it was and what it is, newest first, and audits it", async () => {
    await me.setOwnContact(ray(), home);
    await me.setOwnContact(ray(), { ...home, phone: "512-555-0199" });
    const moved = await me.setOwnContact(ray(), { ...home, phone: "512-555-0199", addressLine1: "9 Elm Ct", city: "Round Rock", postalCode: "78664" });
    expect(moved.changes.map((c) => c.changes)).toEqual([
      [{ field: "address", before: "12 Oak St, Austin, TX 78701", after: "9 Elm Ct, Round Rock, TX 78664" }],
      [{ field: "phone", before: "(512) 555-0143", after: "(512) 555-0199" }],
      [{ field: "phone", before: "none", after: "(512) 555-0143" }, { field: "address", before: "none", after: "12 Oak St, Austin, TX 78701" }],
    ]);
    const [entry] = await raw`select before, after, actor_user_id from public.audit_log
      where action = 'person.contact_changed' and entity_id = ${rayMember} order by created_at desc limit 1`;
    expect(entry).toMatchObject({ actor_user_id: RAY });
    expect((entry!.before as { city: string }).city).toBe("Austin");
    expect((entry!.after as { city: string; by: string })).toMatchObject({ city: "Round Rock", by: "themselves" });
  });

  it("clears a part when its box is emptied, and says so as a change to none", async () => {
    await me.setOwnContact(ray(), home);
    const cleared = await me.setOwnContact(ray(), { phone: "", addressLine1: "", city: "", state: "", postalCode: "" });
    expect(cleared.contact).toMatchObject({ phone: null, addressLine1: null });
    expect(cleared.changes[0]!.changes).toEqual([
      { field: "phone", before: "(512) 555-0143", after: "none" },
      { field: "address", before: "12 Oak St, Austin, TX 78701", after: "none" },
    ]);
  });
});

run("the office reads it and cannot write it", () => {
  it("sees the current phone and address and every change, with who and when", async () => {
    await me.setOwnContact(ray(), home);
    await me.setOwnContact(ray(), { ...home, phone: "512-555-0199" });
    const seen = await peopleRecords.person(office(), { membershipId: rayMember });
    expect(seen.ownContact.contact).toMatchObject({ phone: "+15125550199", city: "Austin" });
    expect(seen.ownContact.changes).toHaveLength(2);
    expect(seen.ownContact.changes[0]).toMatchObject({ by: "Ray Nunez", changes: [{ field: "phone", before: "(512) 555-0143", after: "(512) 555-0199" }] });
    expect(Date.parse(seen.ownContact.changes[0]!.at)).toBeGreaterThan(Date.parse(seen.ownContact.changes[1]!.at) - 1);
  });

  it("is for roster readers only: a technician cannot read a colleague's, and a branch manager reads their own branch's only", async () => {
    await me.setOwnContact(ray(), home);
    await me.setOwnContact(dana(), { phone: "512-555-0100" });
    await expect(peopleRecords.person(dana(), { membershipId: rayMember })).rejects.toBeInstanceOf(PermissionError);
    const hana = as(HANA, "branch_manager", { businessUnitId: houston });
    expect((await peopleRecords.person(hana, { membershipId: rayMember })).ownContact.contact?.city).toBe("Austin");
    await expect(peopleRecords.person(hana, { membershipId: danaMember })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("has no route for the office to write it, and the person's own takes no person", () => {
    expect(routes.setMyContact.path).toBe("/v1/me/contact");
    expect(routes.setMyContact.permissions).toEqual(["profile:own"]);
    expect(Object.keys(routes.setMyContact.input.shape)).not.toContain("membershipId");
    expect(Object.values(routes).filter((r) => r.path.includes("/contact") && r.permissions.includes("user:write"))).toEqual([]);
  });

  it("keeps each person's own: one saving theirs touches nobody else's", async () => {
    await me.setOwnContact(ray(), home);
    await me.setOwnContact(dana(), { phone: "512-555-0100" });
    expect((await mine(ray())).contact?.phone).toBe("+15125550143");
    expect((await mine(dana())).contact).toMatchObject({ phone: "+15125550100", addressLine1: null });
  });
});
