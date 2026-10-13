import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Actor } from "@opentradesos/core";
import { dispatch } from "../src/http/dispatch";
import { authenticate } from "../src/http/authenticate";
import { routes } from "../src/contracts/index";
import { hashPassword } from "../src/services/passwords";
import { hashToken } from "../src/services/apps";
import { resolveSession } from "../src/services/session";
import * as fieldOps from "../src/services/field";
import * as fieldDevices from "../src/services/field-devices";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A REVOKED BROWSER STAYS REVOKED UNTIL ITS PERSON SIGNS IN AGAIN (M11)
 *
 * `/my-day` registers the browser each time the day is opened, and
 * registering used to lift a revocation, so the office taking a browser away
 * lasted until the technician next reloaded. Now the session's start is
 * resolved with the session, and only a sign in that began after the
 * revocation lifts it. The browser here signs in the way the sign in form
 * does (`app.create_session`) and is resolved the way every request is
 * (`app.resolve_session` through `authenticate`), so the moment compared is
 * the real one. The phone's token is driven over HTTP, as the phone app
 * drives it, to show it behaves as it did.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("browser-revocation:org");
const OWNER = fixtureId("browser-revocation:owner");
const TECH = fixtureId("browser-revocation:tech");
const TECH_EMAIL = "lena@browser-revocation.test";
const PASSWORD = "a long enough password for the truck";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** A browser signing in with the form: a new session row, and the cookie's token. */
async function signInBrowser(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();
  await db().execute(
    sql`select app.create_session(${TECH}::uuid, ${hashToken(token)}, ${ORG}::uuid, ${expires}::timestamptz)`,
  );
  return token;
}

const signOutBrowser = (token: string) => db().execute(sql`select app.revoke_session(${hashToken(token)})`);

/** The context a request carrying this cookie gets, through the real `authenticate`. */
async function asBrowser(token: string): Promise<ServiceContext> {
  const authed = await authenticate(new Request("https://ops.example.test/my-day"), {
    db: db(), session: () => resolveSession(db(), hashToken(token)),
  });
  if (!authed) throw new Error("the browser's session did not resolve");
  return authed.ctx;
}

/** Opening `/my-day`: the browser registers itself under the person's own installation id. */
const openDay = async (token: string) =>
  fieldOps.register(await asBrowser(token), { installationId: `web:${TECH}`, label: "Browser" });

const revokedAt = async (deviceId: string) =>
  (await raw<{ revoked_at: Date | null }[]>`select revoked_at from public.device where id = ${deviceId}`)[0]!.revoked_at;

async function call(
  method: string, path: string, options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  const response = await dispatch(new Request(`https://ops.example.test/api${path}`, {
    method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  }), {
    db: db(),
    basePath: "/api",
    resolveSession: async (req) => (await authenticate(req, { db: db(), session: async () => null }))?.ctx ?? null,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function phoneSignsIn(installationId: string) {
  const signed = await call("POST", "/v1/field/sign-in", { body: { email: TECH_EMAIL, password: PASSWORD } });
  expect(signed.status).toBe(201);
  const token = routes.signInDevice.output.parse(signed.body).token;
  const registered = await call("POST", "/v1/field/devices", {
    token, body: { installationId, platform: "android", label: "Lena's phone" },
  });
  expect(registered.status).toBe(201);
  return { token, ...routes.registerDevice.output.parse(registered.body) };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Browser Revocation Co", slug: "browser-revocation" });

  await raw`delete from public."user" where id = ${TECH} or email = ${TECH_EMAIL}`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, ${TECH_EMAIL}, 'Lena Ortiz')`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${TECH}, 'technician') returning id`;
  await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Lena Ortiz')`;
  await raw`insert into public.credential (user_id, password_hash) values (${TECH}, ${await hashPassword(PASSWORD)})`;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.device where organization_id = ${ORG}`;
  await raw`delete from public.session where user_id = ${TECH}`;
  await raw`delete from public."user" where id = ${TECH}`;
  await raw.end();
});

run("a browser the office revoked", () => {
  it("knows when the sign in began, from the session itself", async () => {
    const before = Date.now();
    const token = await signInBrowser();
    const resolved = await resolveSession(db(), hashToken(token));
    expect(resolved?.sessionStartedAt).toBeInstanceOf(Date);
    expect(Math.abs(resolved!.sessionStartedAt.getTime() - before)).toBeLessThan(60_000);
    expect((await asBrowser(token)).sessionStartedAt?.getTime()).toBe(resolved!.sessionStartedAt.getTime());
  });

  it("stays revoked when the day is opened again with the same sign in", async () => {
    const token = await signInBrowser();
    const { deviceId } = await openDay(token);
    await fieldDevices.revoke(owner(), { id: deviceId });

    // The technician reloads `/my-day`.
    const again = await openDay(token);
    expect(again).toMatchObject({ deviceId, revoked: true });
    expect(await revokedAt(deviceId)).not.toBeNull();

    // And its sync is refused, which is how the page hears.
    await expect(fieldOps.sync(await asBrowser(token), {
      deviceId,
      operations: [],
    })).rejects.toThrow("This device has been revoked.");
  });

  it("is lifted by signing out and signing in again", async () => {
    const first = await signInBrowser();
    const { deviceId } = await openDay(first);
    await fieldDevices.revoke(owner(), { id: deviceId });
    expect((await openDay(first)).revoked).toBe(true);

    await signOutBrowser(first);
    expect(await resolveSession(db(), hashToken(first))).toBeNull();
    const second = await signInBrowser();

    const opened = await openDay(second);
    expect(opened).toMatchObject({ deviceId, revoked: false });
    expect(await revokedAt(deviceId)).toBeNull();

    const [lifted] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and entity_id = ${deviceId} and action = 'device.revocation_lifted'`;
    expect(lifted!.n).toBeGreaterThan(0);
  });

  it("is not lifted by a context that does not say when its sign in began", async () => {
    const token = await signInBrowser();
    const { deviceId } = await openDay(token);
    await fieldDevices.revoke(owner(), { id: deviceId });

    // A caller with no session to speak of: unknown is treated as before.
    const { sessionStartedAt: _dropped, ...unknown } = await asBrowser(token);
    expect((await fieldOps.register(unknown, { installationId: `web:${TECH}` })).revoked).toBe(true);
    expect(await revokedAt(deviceId)).not.toBeNull();

    // Put right for whatever runs next.
    await raw`update public.device set revoked_at = null where id = ${deviceId}`;
  });
});

run("a phone's token, as before", () => {
  it("is ended by the revocation, and the next sign in on the phone lifts it", async () => {
    const installationId = `phone-${crypto.randomUUID()}`;
    const first = await phoneSignsIn(installationId);
    expect(first.revoked).toBe(false);

    await fieldDevices.revoke(owner(), { id: first.deviceId });
    const refused = await call("GET", "/v1/field/devices", { token: first.token });
    expect(refused.status).toBe(401);
    expect(await revokedAt(first.deviceId)).not.toBeNull();

    const second = await phoneSignsIn(installationId);
    expect(second).toMatchObject({ deviceId: first.deviceId, revoked: false });
    expect(await revokedAt(first.deviceId)).toBeNull();

    const listed = await fieldDevices.list(owner(), {});
    expect(listed.devices.find((d) => d.id === first.deviceId)).toMatchObject({ signedIn: true, revokedAt: null });
  });
});
