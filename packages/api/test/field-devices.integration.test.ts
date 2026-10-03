import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { dispatch } from "../src/http/dispatch";
import { authenticate } from "../src/http/authenticate";
import { routes } from "../src/contracts/index";
import { hashPassword } from "../src/services/passwords";
import { hashToken } from "../src/services/apps";
import * as fieldDevices from "../src/services/field-devices";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * THE PHONE APP SIGNING IN, OVER HTTP
 *
 * Driven through the real dispatcher and the real `authenticate`, because the
 * properties that matter here live in the seams between them: that a token
 * from the sign in route is accepted by every other route, that registering
 * with it binds it to the device, and that revoking the device ends it on
 * every route at once rather than only on sync.
 *
 * Every response is parsed with the schema the OpenAPI document is generated
 * from, so the phone app's client and the contract cannot quietly disagree.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("field-devices:org");
const OWNER = fixtureId("field-devices:owner");
const TECH = fixtureId("field-devices:tech");
const TECH_EMAIL = "ray@field-devices.test";
const OWNER_EMAIL = "field-devices@test.local";
const PASSWORD = "a long enough password for the van";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** One request through the dispatcher, authenticated the way the web app mounts it. */
async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  const request = new Request(`https://ops.example.test/api${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const response = await dispatch(request, {
    db: db(),
    basePath: "/api",
    resolveSession: async (req) =>
      (await authenticate(req, { db: db(), session: async () => null }))?.ctx ?? null,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const signIn = (email = TECH_EMAIL, password = PASSWORD) =>
  call("POST", "/v1/field/sign-in", { body: { email, password } });

async function signedInPhone(installationId = `phone-${crypto.randomUUID()}`) {
  const signed = await signIn();
  expect(signed.status).toBe(201);
  const token = routes.signInDevice.output.parse(signed.body).token;
  const registered = await call("POST", "/v1/field/devices", {
    token, body: { installationId, platform: "ios", label: "Ray's phone" },
  });
  expect(registered.status).toBe(201);
  const { deviceId } = routes.registerDevice.output.parse(registered.body);
  return { token, deviceId, installationId };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Field Devices Co", slug: "field-devices" });

  await raw`delete from public."user" where id = ${TECH} or email = ${TECH_EMAIL}`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, ${TECH_EMAIL}, 'Ray Nunez')`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${TECH}, 'technician') returning id`;
  await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Nunez')`;

  const hash = await hashPassword(PASSWORD);
  await raw`insert into public.credential (user_id, password_hash) values (${TECH}, ${hash})`;
  await raw`insert into public.credential (user_id, password_hash) values (${OWNER}, ${hash})`;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.device where organization_id = ${ORG}`;
  await raw`delete from public."user" where id = ${TECH}`;
  await raw.end();
});

run("signing in from the phone", () => {
  it("hands a technician a device token and the company they are in", async () => {
    const result = await signIn();
    expect(result.status).toBe(201);
    const body = routes.signInDevice.output.parse(result.body);

    expect(body.token.startsWith("otd_")).toBe(true);
    expect(body.user.email).toBe(TECH_EMAIL);
    expect(body.organization).toEqual({ id: ORG, name: "Field Devices Co", timezone: expect.any(String) });
    /**
     * Ninety days, so a phone that spends a week without signal is not
     * signed out under a day of queued work.
     */
    const days = (new Date(body.expiresAt).getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(89);
  });

  it("keeps only the hash of the token", async () => {
    const { token } = routes.signInDevice.output.parse((await signIn()).body);
    const rows = await raw<{ token_hash: string }[]>`
      select token_hash from public.session where token_hash = ${hashToken(token)}`;
    expect(rows).toHaveLength(1);
    const plain = await raw`select 1 from public.session where token_hash = ${token}`;
    expect(plain).toHaveLength(0);
  });

  it("refuses a wrong password with the sign in form's own words, and counts it", async () => {
    await raw`update public.credential set failed_attempts = 0, locked_until = null where user_id = ${TECH}`;
    const result = await signIn(TECH_EMAIL, "not the password");
    expect(result.status).toBe(401);
    expect(result.body["error"]).toBe("That email and password do not match");

    const [row] = await raw<{ failed_attempts: number }[]>`
      select failed_attempts from public.credential where user_id = ${TECH}`;
    expect(row!.failed_attempts).toBe(1);
    await raw`update public.credential set failed_attempts = 0, locked_until = null where user_id = ${TECH}`;
  });

  it("says the same thing for an email nobody has", async () => {
    const result = await signIn("nobody@field-devices.test", PASSWORD);
    expect(result.status).toBe(401);
    expect(result.body["error"]).toBe("That email and password do not match");
  });

  it("refuses a locked account even with the right password", async () => {
    await raw`update public.credential set locked_until = now() + interval '10 minutes' where user_id = ${TECH}`;
    const result = await signIn();
    expect(result.status).toBe(401);
    expect(String(result.body["error"])).toMatch(/temporarily locked/);
    await raw`update public.credential set failed_attempts = 0, locked_until = null where user_id = ${TECH}`;
  });

  it("refuses somebody with no technician record, and leaves no live token behind", async () => {
    const before = await raw<{ n: number }[]>`
      select count(*)::int as n from public.session where user_id = ${OWNER} and revoked_at is null`;
    const result = await signIn(OWNER_EMAIL, PASSWORD);
    expect(result.status).toBe(401);
    expect(String(result.body["error"])).toMatch(/not set up as a technician/);

    const after = await raw<{ n: number }[]>`
      select count(*)::int as n from public.session where user_id = ${OWNER} and revoked_at is null`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

run("using the token", () => {
  it("is accepted by the field routes, as the technician", async () => {
    const { token, deviceId } = await signedInPhone();

    const snapshot = await call(
      "GET", `/v1/field/snapshot?deviceId=${deviceId}&from=2026-10-02&days=1`, { token },
    );
    expect(snapshot.status).toBe(200);
    routes.getFieldSnapshot.output.parse(snapshot.body);

    const sync = await call("POST", "/v1/field/sync", {
      token,
      body: {
        deviceId,
        operations: [{
          clientId: crypto.randomUUID(), sequence: 1, kind: "timeclock.punch_in",
          occurredAt: new Date().toISOString(), payload: {},
        }],
      },
    });
    expect(sync.status).toBe(201);
    const results = routes.syncOperations.output.parse(sync.body).results;
    expect(results[0]!.status).toBe("applied");
  });

  it("binds itself to the device it registered", async () => {
    const { token, deviceId } = await signedInPhone();
    const [row] = await raw<{ session_token_hash: string | null }[]>`
      select session_token_hash from public.device where id = ${deviceId}`;
    expect(row!.session_token_hash).toBe(hashToken(token));
  });

  it("is refused when it is not a token at all", async () => {
    const result = await call("GET", "/v1/field/devices", { token: "otd_made_up_entirely" });
    expect(result.status).toBe(401);
  });

  it("ends the previous token when the same phone signs in again", async () => {
    /**
     * A retry after a dropped response, or a second person on the same
     * handset. One working credential per phone, not a pile of them.
     */
    const first = await signedInPhone();
    const second = await signedInPhone(first.installationId);
    expect(second.deviceId).toBe(first.deviceId);

    const old = await call("GET", `/v1/field/uploads?deviceId=${first.deviceId}`, { token: first.token });
    expect(old.status).toBe(401);
    const current = await call("GET", `/v1/field/uploads?deviceId=${first.deviceId}`, { token: second.token });
    expect(current.status).toBe(200);
  });
});

run("signing out and taking a phone away", () => {
  it("signs the phone out, and the token stops working everywhere", async () => {
    const { token, deviceId } = await signedInPhone();
    const out = await call("POST", `/v1/field/devices/${deviceId}/sign-out`, { token, body: {} });
    expect(out.status).toBe(201);
    routes.signOutDevice.output.parse(out.body);

    const after = await call("GET", `/v1/field/uploads?deviceId=${deviceId}`, { token });
    expect(after.status).toBe(401);

    // The device keeps its sequence for the next sign in on this handset.
    const [row] = await raw<{ revoked_at: Date | null; session_token_hash: string | null }[]>`
      select revoked_at, session_token_hash from public.device where id = ${deviceId}`;
    expect(row!.revoked_at).toBeNull();
    expect(row!.session_token_hash).toBeNull();
  });

  it("will not sign out somebody else's phone", async () => {
    const mine = await signedInPhone();
    const [ownerMembership] = await raw`select id from public.membership
      where organization_id = ${ORG} and user_id = ${OWNER}`;
    const [ownerTech] = await raw`insert into public.technician (organization_id, membership_id, display_name)
      values (${ORG}, ${ownerMembership!.id}, 'Owner On Calls') returning id`;
    const [other] = await raw`insert into public.device (organization_id, technician_id, installation_id)
      values (${ORG}, ${ownerTech!.id}, ${`other-${crypto.randomUUID()}`}) returning id`;

    try {
      // Not found rather than forbidden, so it does not confirm whose phone it is.
      const result = await call("POST", `/v1/field/devices/${other!.id}/sign-out`, { token: mine.token, body: {} });
      expect(result.status).toBe(404);
    } finally {
      await raw`delete from public.device where id = ${other!.id}`;
      await raw`delete from public.technician where id = ${ownerTech!.id}`;
    }
  });

  it("lets the office revoke a phone, which ends its token and its sync", async () => {
    const { token, deviceId } = await signedInPhone();

    const listed = await fieldDevices.list(owner(), {});
    const entry = listed.devices.find((d) => d.id === deviceId);
    expect(entry?.signedIn).toBe(true);
    expect(entry?.technicianName).toBe("Ray Nunez");

    const revoked = await fieldDevices.revoke(owner(), { id: deviceId });
    expect(revoked.ok).toBe(true);

    const after = await call("GET", "/v1/field/snapshot?deviceId=" + deviceId + "&from=2026-10-02", { token });
    expect(after.status).toBe(401);

    const again = await fieldDevices.list(owner(), {});
    expect(again.devices.find((d) => d.id === deviceId)?.signedIn).toBe(false);
  });

  it("does not let a technician revoke phones", async () => {
    const { token, deviceId } = await signedInPhone();
    const result = await call("POST", `/v1/field/devices/${deviceId}/revoke`, { token, body: {} });
    expect(result.status).toBe(403);
  });

  it("is ended by deactivating the person, like any other sign in", async () => {
    const { token } = await signedInPhone();
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${TECH}`;
    try {
      const result = await call("GET", "/v1/field/devices", { token });
      expect(result.status).toBe(401);
    } finally {
      await raw`update public.membership set active = true where organization_id = ${ORG} and user_id = ${TECH}`;
    }
  });
});
