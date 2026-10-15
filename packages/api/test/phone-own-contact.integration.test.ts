import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import { dispatch } from "../src/http/dispatch";
import { authenticate } from "../src/http/authenticate";
import { routes } from "../src/contracts/index";
import { hashPassword } from "../src/services/passwords";
import * as peopleRecords from "../src/services/people-records";
import type { ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * A TECHNICIAN CHANGES THEIR OWN PHONE AND ADDRESS FROM THE PHONE APP (M24, M11)
 *
 * The phone signs in with a device token, a bearer the dispatcher resolves to the
 * same person as a cookie. Through that token alone, the way the app sends it:
 * read the record, save a number and an address, be told in the server's own
 * words when it will not do, take the address off, and be unable to touch
 * anybody else's. The office reads what was saved, with each change, and can
 * not write it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("phone-contact:org");
const OWNER = fixtureId("phone-contact:owner");
const RAY = fixtureId("phone-contact:ray");
const SAM = fixtureId("phone-contact:sam");
const RAY_EMAIL = "ray@phone-contact.test";
const SAM_EMAIL = "sam@phone-contact.test";
const PASSWORD = "a long enough password for the van";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const resolve = async (req: Request) => (await authenticate(req, { db: db(), session: async () => null }))?.ctx ?? null;

async function call(method: string, path: string, token: string | null, body?: unknown, key?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (key) headers["idempotency-key"] = key;
  const response = await dispatch(new Request(`https://ops.example.test/api${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), { db: db(), basePath: "/api", resolveSession: resolve });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function phoneFor(userId: string, email: string): Promise<string> {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${email.split("@")[0]!})`;
  const [membership] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${email.split("@")[0]!})`;
  await raw`insert into public.credential (user_id, password_hash) values (${userId}, ${await hashPassword(PASSWORD)})`;
  const signed = await call("POST", "/v1/field/sign-in", null, { email, password: PASSWORD });
  expect(signed.status).toBeLessThan(300);
  return routes.signInDevice.output.parse(signed.body).token;
}

let rayToken = "";
let samToken = "";
let rayMembership = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Phone Contact Co", slug: "phone-contact-co" });
  rayToken = await phoneFor(RAY, RAY_EMAIL);
  samToken = await phoneFor(SAM, SAM_EMAIL);
  const [m] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${RAY}`;
  rayMembership = m!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in (${RAY}, ${SAM})`;
  await raw.end();
});

run("a technician keeps their own phone and address from the phone app", () => {
  it("reads an empty record before anything is saved", async () => {
    const read = await call("GET", "/v1/me", rayToken);
    expect(read.status).toBe(200);
    expect(routes.getMyRecord.output.parse(read.body).ownContact).toEqual({ contact: null, changes: [] });
  });

  it("saves the whole of it as the app sends it, and reads it back", async () => {
    const saved = await call("POST", "/v1/me/contact", rayToken, {
      phone: "(512) 555-0143", addressLine1: "12 Elm St", addressLine2: null, city: "Austin", state: "tx", postalCode: "78704",
    }, "save-1");
    expect(saved.status).toBeLessThan(300);
    const record = routes.setMyContact.output.parse(saved.body);
    expect(record.contact).toMatchObject({
      phone: "+15125550143", addressLine1: "12 Elm St", addressLine2: null, city: "Austin", state: "TX", postalCode: "78704",
    });
    const read = routes.getMyRecord.output.parse((await call("GET", "/v1/me", rayToken)).body);
    expect(read.ownContact.contact).toMatchObject({ phone: "+15125550143", state: "TX" });
    expect(read.ownContact.changes).toHaveLength(1);
  });

  it("sends the same again as no change, and a retry with its key as the same save", async () => {
    const body = { phone: "+15125550143", addressLine1: "12 Elm St", addressLine2: null, city: "Austin", state: "TX", postalCode: "78704" };
    await call("POST", "/v1/me/contact", rayToken, body, "save-2");
    await call("POST", "/v1/me/contact", rayToken, body, "save-2");
    const read = routes.getMyRecord.output.parse((await call("GET", "/v1/me", rayToken)).body);
    expect(read.ownContact.changes).toHaveLength(1);
  });

  it("is told in the server's own words when the number or the ZIP will not do, and nothing is kept", async () => {
    const number = await call("POST", "/v1/me/contact", rayToken, {
      phone: "call me", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null,
    }, "save-3");
    expect(number.status).toBe(409);
    expect(number.body["error"]).toMatch(/is not a phone number\. Type it as you would dial it/);

    const zip = await call("POST", "/v1/me/contact", rayToken, {
      phone: "(512) 555-0143", addressLine1: "12 Elm St", addressLine2: null, city: "Austin", state: "TX", postalCode: "787",
    }, "save-4");
    expect(zip.status).toBe(409);
    expect(zip.body["error"]).toMatch(/ZIP code is five digits/);

    const half = await call("POST", "/v1/me/contact", rayToken, {
      phone: "(512) 555-0143", addressLine1: "12 Elm St", addressLine2: null, city: null, state: null, postalCode: null,
    }, "save-5");
    expect(half.status).toBe(409);
    expect(half.body["error"]).toMatch(/needs the street, the town, the state and the ZIP code/);

    const read = routes.getMyRecord.output.parse((await call("GET", "/v1/me", rayToken)).body);
    expect(read.ownContact.contact).toMatchObject({ phone: "+15125550143", addressLine1: "12 Elm St", postalCode: "78704" });
  });

  it("takes the address off with empty boxes, keeping the number", async () => {
    const saved = await call("POST", "/v1/me/contact", rayToken, {
      phone: "(512) 555-0143", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null,
    }, "save-6");
    expect(saved.status).toBeLessThan(300);
    expect(routes.setMyContact.output.parse(saved.body).contact).toMatchObject({
      phone: "+15125550143", addressLine1: null, city: null, state: null, postalCode: null,
    });
  });

  it("is always the signed in person's own: one phone's save never reaches another person's record", async () => {
    await call("POST", "/v1/me/contact", samToken, {
      phone: "(713) 555-0188", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null,
    }, "sam-1");
    const sam = routes.getMyRecord.output.parse((await call("GET", "/v1/me", samToken)).body);
    const ray = routes.getMyRecord.output.parse((await call("GET", "/v1/me", rayToken)).body);
    expect(sam.ownContact.contact?.phone).toBe("+17135550188");
    expect(ray.ownContact.contact?.phone).toBe("+15125550143");
  });

  it("is refused without a sign in, and with a token that has ended", async () => {
    const none = await call("POST", "/v1/me/contact", null, { phone: "(512) 555-0100" }, "anon-1");
    expect(none.status).toBe(401);
    const bad = await call("POST", "/v1/me/contact", "otd_notatokennotatokennotatoken", { phone: "(512) 555-0100" }, "anon-2");
    expect(bad.status).toBe(401);
  });

  it("is read by the office with every change, and the office has no way to write it", async () => {
    const person = await peopleRecords.person(owner(), { membershipId: rayMembership });
    expect(person.ownContact.contact).toMatchObject({ phone: "+15125550143", addressLine1: null });
    expect(person.ownContact.changes.map((c) => c.changes.map((x) => x.field))).toEqual([["address"], ["phone", "address"]]);
    const writing = Object.values(routes).filter((r) => r.path.includes("/contact") && r.method !== "get");
    expect(writing.map((r) => `${r.method} ${r.path} ${r.permissions.join(",")}`)).toContain("post /v1/me/contact profile:own");
    expect(writing.every((r) => !r.path.includes("{membershipId}"))).toBe(true);
  });
});
