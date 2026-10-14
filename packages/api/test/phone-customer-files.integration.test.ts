import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import { dispatch } from "../src/http/dispatch";
import { authenticate, authenticateFileRead } from "../src/http/authenticate";
import { routes } from "../src/contracts/index";
import { hashPassword } from "../src/services/passwords";
import * as files from "../src/services/files";
import * as fieldDevices from "../src/services/field-devices";
import { inTenant, type ServiceContext } from "../src/services/context";
import { companyToday, fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * THE PHOTOGRAPH A CUSTOMER SENT, READ ON THE TECHNICIAN'S PHONE
 *
 * The day carries the files a customer sent to a visit or its job; the bytes are
 * read from `/files/{storageKey}` with the phone's own sign in as a bearer
 * header. What is pinned is the check on that read, because it is a customer's
 * document and the route used to know only a browser's cookie: the phone's
 * token reads it for the person it belongs to and nobody else, a token that has
 * ended reads nothing and never falls back to a cookie, an app's token is not a
 * way in, and a role that cannot read documents is sent no files and refused
 * the bytes.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("phone-files:org");
const OWNER = fixtureId("phone-files:owner");
const RAY = fixtureId("phone-files:ray");
const OTHER_ORG = fixtureId("phone-files:other-org");
const OTHER_OWNER = fixtureId("phone-files:other-owner");
const RAY_EMAIL = "ray@phone-files.test";
const PASSWORD = "a long enough password for the van";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const otherOwner = (): ServiceContext => ({
  actor: { userId: OTHER_OWNER, organizationId: OTHER_ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const photo = (marker: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, marker, 7]);

/** One request through the dispatcher, the way the web app mounts it. */
async function call(path: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const response = await dispatch(new Request(`https://ops.example.test/api${path}`, { method: "GET", headers }), {
    db: db(), basePath: "/api",
    resolveSession: async (req) => (await authenticate(req, { db: db(), session: async () => null }))?.ctx ?? null,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** What the `/files` route asks, with no browser cookie behind it. */
const reading = (storageKey: string, token?: string) => authenticateFileRead(
  new Request(`https://ops.example.test/files/${storageKey}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  { db: db(), session: async () => null },
);

let visitId = "";
let keyOfPhoto = "";
let keyOfOtherCompany = "";
let token = "";
let deviceId = "";

async function signedInPhone() {
  const signed = await dispatch(new Request("https://ops.example.test/api/v1/field/sign-in", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: RAY_EMAIL, password: PASSWORD }),
  }), { db: db(), basePath: "/api", resolveSession: async () => null });
  const { token: issued } = routes.signInDevice.output.parse(await signed.json());
  const registered = await dispatch(new Request("https://ops.example.test/api/v1/field/devices", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${issued}` },
    body: JSON.stringify({ installationId: `phone-${crypto.randomUUID()}`, platform: "android", label: "Ray's phone" }),
  }), {
    db: db(), basePath: "/api",
    resolveSession: async (req) => (await authenticate(req, { db: db(), session: async () => null }))?.ctx ?? null,
  });
  return { token: issued, deviceId: routes.registerDevice.output.parse(await registered.json()).deviceId };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Phone Files Co", slug: "phone-files-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_OWNER, name: "Somebody Else Co", slug: "phone-files-other" });
  await raw`delete from public."user" where id = ${RAY} or email = ${RAY_EMAIL}`;
  await raw`insert into public."user" (id, email, name) values (${RAY}, ${RAY_EMAIL}, 'Ray Nunez')`;
  const [membership] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${RAY}, 'technician') returning id`;
  const [tech] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
  await raw`insert into public.credential (user_id, password_hash) values (${RAY}, ${await hashPassword(PASSWORD)})`;

  const [customer] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name)
    values (${ORG}, 'Dana Cedar') returning id`;
  const [property] = await raw<{ id: string }[]>`insert into public.property
    (organization_id, address_line1, city, state, postal_code) values (${ORG}, '12 Cedar Ln', 'Austin', 'TX', '78704') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary)
    values (${ORG}, ${customer!.id}, ${property!.id}, true)`;
  const [job] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 7301, ${customer!.id}, ${property!.id}, 'scheduled', 'No hot water') returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit
    (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'dispatched', now(), now() + interval '2 hours') returning id`;
  visitId = visit!.id;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visitId}, ${tech!.id})`;

  /** What the customer sent: a photograph to the visit, kept the way the portal keeps it. */
  keyOfPhoto = await inTenant(owner(), async (tx) => {
    const { file } = await files.put(tx, ORG, { bytes: photo(1), claimedType: "image/jpeg" });
    await files.attach(tx, ORG, {
      entityType: "visit", entityId: visitId, storageKey: file.storageKey, kind: "customer_file",
      fileName: "boiler.jpg", contentType: file.contentType, sizeBytes: file.sizeBytes,
    });
    return file.storageKey;
  });
  /** Another company's file, which no sign in here may read. */
  keyOfOtherCompany = await inTenant(otherOwner(), async (tx) => {
    const { file } = await files.put(tx, OTHER_ORG, { bytes: photo(2), claimedType: "image/jpeg" });
    return file.storageKey;
  });

  ({ token, deviceId } = await signedInPhone());
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.device where organization_id = ${ORG}`;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw`delete from public."user" where id = ${RAY}`;
  await raw.end();
});

run("the day carries what the customer sent", () => {
  it("names each file with the key it is read by, newest first", async () => {
    const snapshot = await call(`/v1/field/snapshot?deviceId=${deviceId}&from=${companyToday()}&days=1`, token);
    expect(snapshot.status).toBe(200);
    const parsed = routes.getFieldSnapshot.output.parse(snapshot.body);
    const visit = parsed.visits.find((v) => v.id === visitId);
    expect(visit?.customerFiles).toEqual([expect.objectContaining({
      fileName: "boiler.jpg", contentType: "image/jpeg", storageKey: keyOfPhoto,
    })]);
  });

  it("sends none to a role that may not read documents, and refuses it the bytes", async () => {
    await raw`update public.membership set revocations = ${raw.json(["document:read"])} where organization_id = ${ORG} and user_id = ${RAY}`;
    try {
      const snapshot = await call(`/v1/field/snapshot?deviceId=${deviceId}&from=${companyToday()}&days=1`, token);
      const visit = routes.getFieldSnapshot.output.parse(snapshot.body).visits.find((v) => v.id === visitId);
      expect(visit?.customerFiles ?? []).toEqual([]);
      const session = await reading(keyOfPhoto, token);
      await expect(files.open({ actor: session!.actor, db: db() }, keyOfPhoto)).rejects.toThrow(PermissionError);
    } finally {
      await raw`update public.membership set revocations = '[]'::jsonb where organization_id = ${ORG} and user_id = ${RAY}`;
    }
  });
});

run("reading the bytes with the phone's sign in", () => {
  it("reads the file for the person the token belongs to", async () => {
    const session = await reading(keyOfPhoto, token);
    expect(session?.userId).toBe(RAY);
    const file = await files.open({ actor: session!.actor, db: db() }, keyOfPhoto);
    expect(file.contentType).toBe("image/jpeg");
    expect(Buffer.compare(file.bytes, photo(1))).toBe(0);
  });

  it("never reads another company's file, whatever the key", async () => {
    const session = await reading(keyOfOtherCompany, token);
    await expect(files.open({ actor: session!.actor, db: db() }, keyOfOtherCompany)).rejects.toThrow(/not found/i);
  });

  it("reads nothing without a sign in, and a made up token is a refusal, not a cookie", async () => {
    expect(await reading(keyOfPhoto)).toBeNull();
    expect(await reading(keyOfPhoto, "otd_notatokennotatokennotatoken")).toBeNull();
    // Even with a good cookie behind it: a presented and rejected token is never a fall back.
    const withCookie = await authenticateFileRead(
      new Request("https://ops.example.test/files/x", { headers: { authorization: "Bearer otd_notatokennotatokennotatoken" } }),
      { db: db(), session: async () => await reading(keyOfPhoto, token) },
    );
    expect(withCookie).toBeNull();
  });

  it("does not take an app's token for a way in", async () => {
    // Not a phone token, so it is read as a request with no cookie, which has no one behind it.
    expect(await reading(keyOfPhoto, "ots_anappstokenanappstokenanappstoken")).toBeNull();
  });

  it("stops when the phone is signed out or taken away", async () => {
    const second = await signedInPhone();
    expect((await reading(keyOfPhoto, second.token))?.userId).toBe(RAY);
    await fieldDevices.revoke(owner(), { id: second.deviceId });
    expect(await reading(keyOfPhoto, second.token)).toBeNull();
  });

  it("stops when the person is deactivated", async () => {
    const third = await signedInPhone();
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${RAY}`;
    try {
      expect(await reading(keyOfPhoto, third.token)).toBeNull();
    } finally {
      await raw`update public.membership set active = true where organization_id = ${ORG} and user_id = ${RAY}`;
    }
  });
});
