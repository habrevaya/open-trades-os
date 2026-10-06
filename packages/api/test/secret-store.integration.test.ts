import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import { routes } from "../src/contracts";
import { dispatch } from "../src/http/dispatch";
import * as accounting from "../src/services/accounting";
import * as leadConnectors from "../src/services/lead-connectors";
import * as secretService from "../src/secrets/service";
import {
  databaseSecretStore, keyIdOf, rotateAll, SecretUnreadableError, type Keyring,
} from "../src/secrets/database";
import { readerFor, secretStore, SecretNotSetError, useSecretStore, writerFor } from "../src/secrets/store";
import { ConflictError, type ServiceContext } from "../src/services/context";
import "../src/accounting";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A COMPANY'S OWN SECRETS, IN THE DATABASE, AND ONLY ITS OWN
 *
 * The database store exists so that companies on a shared deployment can
 * connect their own Stripe, Twilio or QuickBooks: the environment there is
 * the operator's. What it has to prove is the rest of this file:
 *
 *   - company A cannot read company B's secret, by name, by row, or by
 *     copying B's ciphertext into its own row;
 *   - a byte changed in the ciphertext is detected, not decrypted to junk;
 *   - the master key can be rotated without losing anything;
 *   - a value goes in and nothing about it comes out: not in an API answer,
 *     not in the audit log, not in a log line;
 *   - an OAuth token that rotates is written back durably.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const A = fixtureId("secretdb:org-a");
const A_USER = fixtureId("secretdb:user-a");
const B = fixtureId("secretdb:org-b");
const B_USER = fixtureId("secretdb:user-b");

/** Every value here is made at runtime, so nothing in the repository reads as a credential. */
const fresh = (label: string) => `${label}_${randomBytes(24).toString("base64url")}`;
const newKey = () => randomBytes(32);
const keyring = (current: Buffer, ...previous: Buffer[]): Keyring => ({
  current: { id: keyIdOf(current), key: current },
  previous: previous.map((key) => ({ id: keyIdOf(key), key })),
});

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (org = A, user = A_USER, roles: Actor["roles"] = ["owner"] as Actor["roles"]): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles }, db: db(),
});

let logged: string[];
const env: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in env)) env[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, A);
  await resetOrg(raw, B);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: A, userId: A_USER, name: "Secret A Co", slug: "secret-db-a" });
  await seedOrg(raw, { organizationId: B, userId: B_USER, name: "Secret B Co", slug: "secret-db-b" });
  // Every log line, so a test can say no value reached one.
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
    });
  }
  setEnv("SECRET_STORE", "database");
  setEnv("SECRETS_MASTER_KEY", newKey().toString("base64"));
  setEnv("SECRETS_MASTER_KEY_PREVIOUS", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useSecretStore(null);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete env[name];
  }
});

async function call(name: keyof typeof routes, path: string, init: { method: string; body?: unknown }, as = ctx()) {
  const response = await dispatch(
    new Request(`http://localhost${path}`, {
      method: init.method,
      ...(init.body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(init.body),
      }),
    }),
    { db: db(), resolveSession: async () => as },
  );
  return { status: response.status, text: await response.text(), route: routes[name] };
}

run("isolation between companies", () => {
  it("reads a company's own secret back, and not another's under the same name", async () => {
    const value = fresh("a_stripe");
    await secretStore().write(db(), A, "STRIPE_SECRET_KEY", value);
    expect(await readerFor(db(), A)("STRIPE_SECRET_KEY")).toBe(value);
    await expect(readerFor(db(), B)("STRIPE_SECRET_KEY")).rejects.toBeInstanceOf(SecretNotSetError);
  });

  it("does not let a company's database session see another's row at all", async () => {
    await secretStore().write(db(), A, "STRIPE_SECRET_KEY", fresh("a_stripe"));
    // As B, inside B's tenant context, asking for A's row by every column.
    const seen = await raw.begin(async (sql) => {
      await sql`set local role authenticated`;
      await sql`select set_config('app.organization_id', ${B}, true)`;
      return sql`select * from public.integration_secret where organization_id = ${A}`;
    });
    expect(seen).toHaveLength(0);
  });

  it("refuses A's ciphertext copied into B's row, because the envelope is bound to its company", async () => {
    const value = fresh("a_stripe");
    await secretStore().write(db(), A, "STRIPE_SECRET_KEY", value);
    await secretStore().write(db(), B, "STRIPE_SECRET_KEY", fresh("b_stripe"));
    // What a database-level attacker or a bad restore could do: move A's envelope under B.
    await raw`
      update public.integration_secret b set sealed_secret = a.sealed_secret
        from public.integration_secret a
       where a.organization_id = ${A} and b.organization_id = ${B}
         and a.name = 'STRIPE_SECRET_KEY' and b.name = 'STRIPE_SECRET_KEY'`;
    const error = await readerFor(db(), B)("STRIPE_SECRET_KEY").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretUnreadableError);
    expect(String((error as Error).message)).not.toContain(value);
  });

  it("refuses a row renamed to stand in for a different secret", async () => {
    await secretStore().write(db(), A, "TWILIO_AUTH_TOKEN", fresh("a_twilio"));
    await raw`update public.integration_secret set name = 'STRIPE_SECRET_KEY' where organization_id = ${A}`;
    await expect(readerFor(db(), A)("STRIPE_SECRET_KEY")).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it("refuses a read for one company from inside another company's transaction", async () => {
    await secretStore().write(db(), A, "STRIPE_SECRET_KEY", fresh("a_stripe"));
    await expect(db().transaction(async (tx) => {
      await tx.execute(`select set_config('app.organization_id', '${B}', true)` as never);
      return readerFor(tx as never, A)("STRIPE_SECRET_KEY");
    })).rejects.toThrow(/inside another's transaction/);
  });
});

run("the ciphertext", () => {
  it("stores no plaintext anywhere in the row", async () => {
    const value = fresh("a_stripe");
    await secretStore().write(db(), A, "STRIPE_SECRET_KEY", value);
    const [row] = await raw`select * from public.integration_secret where organization_id = ${A}`;
    expect(JSON.stringify(row)).not.toContain(value);
    expect(JSON.stringify(row)).not.toContain(value.slice(0, 16));
    expect(String(row!["sealed_secret"]).startsWith("ots1.")).toBe(true);
    expect(row!["secret_last4"]).toBe(value.slice(-4));
  });

  it("detects a single changed byte, in the ciphertext, the nonce or the tag", async () => {
    await secretStore().write(db(), A, "STRIPE_SECRET_KEY", fresh("a_stripe"));
    const [row] = await raw<{ envelope: string }[]>`
      select sealed_secret as envelope from public.integration_secret where organization_id = ${A}`;
    const parts = row!.envelope.split(".");
    for (const index of [2, 3, 4]) {
      const flipped = [...parts];
      const bytes = Buffer.from(flipped[index]!, "base64url");
      bytes[0] = bytes[0]! ^ 0x01;
      flipped[index] = bytes.toString("base64url");
      await raw`update public.integration_secret set sealed_secret = ${flipped.join(".")} where organization_id = ${A}`;
      await expect(readerFor(db(), A)("STRIPE_SECRET_KEY")).rejects.toBeInstanceOf(SecretUnreadableError);
    }
  });

  it("uses a fresh nonce on every write, so the same value never makes the same envelope", async () => {
    const value = fresh("same");
    await secretStore().write(db(), A, "ONE", value);
    await secretStore().write(db(), A, "TWO", value);
    const rows = await raw<{ envelope: string }[]>`
      select sealed_secret as envelope from public.integration_secret where organization_id = ${A}`;
    expect(new Set(rows.map((r) => r.envelope.split(".")[2])).size).toBe(2);
  });
});

run("rotating the master key", () => {
  it("reads under the old key as a previous key, re-encrypts, and then needs only the new one", async () => {
    const oldKey = newKey();
    const nextKey = newKey();
    const value = fresh("a_stripe");
    const before = databaseSecretStore(keyring(oldKey));
    await before.write(db(), A, "STRIPE_SECRET_KEY", value);
    await before.write(db(), B, "STRIPE_SECRET_KEY", fresh("b_stripe"));

    // The new key alone cannot read it, and says why rather than calling it tampering.
    const onlyNext = databaseSecretStore(keyring(nextKey));
    await expect(onlyNext.read(db(), A, "STRIPE_SECRET_KEY")).rejects.toThrow(/SECRETS_MASTER_KEY_PREVIOUS/);

    const during = databaseSecretStore(keyring(nextKey, oldKey));
    expect(await during.read(db(), A, "STRIPE_SECRET_KEY")).toBe(value);

    const outcome = await rotateAll(db(), during, keyIdOf(nextKey));
    expect(outcome.secrets).toBeGreaterThanOrEqual(2);
    expect(outcome.organizations).toBeGreaterThanOrEqual(2);

    const keyIds = await raw<{ key_id: string }[]>`
      select key_id from public.integration_secret where organization_id in (${A}, ${B})`;
    expect(new Set(keyIds.map((r) => r.key_id))).toEqual(new Set([keyIdOf(nextKey)]));
    expect(await onlyNext.read(db(), A, "STRIPE_SECRET_KEY")).toBe(value);
    await expect(databaseSecretStore(keyring(oldKey)).read(db(), A, "STRIPE_SECRET_KEY"))
      .rejects.toBeInstanceOf(SecretUnreadableError);
    // Running it again finds nothing left.
    expect((await rotateAll(db(), during, keyIdOf(nextKey))).secrets).toBe(0);
  });

  it("refuses to start without a usable master key, and never prints the one it was given", () => {
    setEnv("SECRETS_MASTER_KEY", undefined);
    expect(() => secretStore()).toThrow(/SECRETS_MASTER_KEY/);
    const short = randomBytes(16).toString("base64");
    setEnv("SECRETS_MASTER_KEY", short);
    let message = "";
    try { secretStore(); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/32 random bytes/);
    expect(message).not.toContain(short);
  });
});

run("the write-only API", () => {
  it("takes a value and answers with set and the last four, never the value, and audits only the name", async () => {
    const value = fresh("pasted");
    const put = await call("putSecret", "/v1/secrets/STRIPE_SECRET_KEY", {
      method: "PUT", body: { value },
    });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(value);
    const body = JSON.parse(put.text) as { name: string; set: boolean; last4: string };
    expect(body).toMatchObject({ name: "STRIPE_SECRET_KEY", set: true, last4: value.slice(-4) });

    const list = await call("listSecrets", "/v1/secrets", { method: "GET" });
    expect(list.status).toBe(200);
    expect(list.text).toContain("STRIPE_SECRET_KEY");
    expect(list.text).not.toContain(value);
    expect(JSON.parse(list.text).store).toBe("database");

    // Replaced, then cleared.
    const second = fresh("pasted");
    await call("putSecret", "/v1/secrets/STRIPE_SECRET_KEY", { method: "PUT", body: { value: second } });
    expect(await readerFor(db(), A)("STRIPE_SECRET_KEY")).toBe(second);
    const cleared = await call("deleteSecret", "/v1/secrets/STRIPE_SECRET_KEY", { method: "DELETE" });
    expect(cleared.status).toBe(200);
    await expect(readerFor(db(), A)("STRIPE_SECRET_KEY")).rejects.toBeInstanceOf(SecretNotSetError);

    const audits = await raw<{ action: string; before: unknown; after: unknown }[]>`
      select action, before, after from public.audit_log
       where organization_id = ${A} and entity_type = 'integration_secret' order by created_at`;
    expect(audits.map((a) => a.action)).toEqual(["secret.set", "secret.replaced", "secret.cleared"]);
    const trail = JSON.stringify(audits);
    expect(trail).toContain("STRIPE_SECRET_KEY");
    for (const v of [value, second]) {
      expect(trail).not.toContain(v);
      expect(trail).not.toContain(v.slice(-4));
    }
    // And nothing logged anywhere carries either value.
    for (const line of logged) {
      expect(line).not.toContain(value);
      expect(line).not.toContain(second);
    }
  });

  it("refuses somebody without integration:write, before looking at the name", async () => {
    await expect(secretService.put(ctx(A, A_USER, ["technician"] as Actor["roles"]), {
      name: "STRIPE_SECRET_KEY", value: fresh("x"),
    })).rejects.toMatchObject({ name: "PermissionError" });
    await expect(secretService.put(ctx(A, A_USER, ["technician"] as Actor["roles"]), {
      name: "../nope", value: fresh("x"),
    })).rejects.toMatchObject({ name: "PermissionError" });
  });

  it("never reaches another company's secret through the API, whatever name is sent", async () => {
    const value = fresh("b_secret");
    await secretStore().write(db(), B, "STRIPE_SECRET_KEY", value);
    const list = await call("listSecrets", "/v1/secrets", { method: "GET" });
    expect(list.text).not.toContain(value.slice(-4));
    const cleared = await call("deleteSecret", "/v1/secrets/STRIPE_SECRET_KEY", { method: "DELETE" });
    expect(cleared.status).toBe(404);
    expect(await readerFor(db(), B)("STRIPE_SECRET_KEY")).toBe(value);
  });

  it("says which variable to set when the deployment keeps secrets in its environment", async () => {
    setEnv("SECRET_STORE", undefined);
    const value = fresh("pasted");
    await expect(secretService.put(ctx(), { name: "STRIPE_SECRET_KEY", value }))
      .rejects.toThrow(/OTS_SECRET__[0-9A-F]{32}__STRIPE_SECRET_KEY/);
    await expect(secretService.put(ctx(), { name: "STRIPE_SECRET_KEY", value })).rejects.toBeInstanceOf(ConflictError);
  });
});

run("a credential that rotates", () => {
  it("writes a rotated OAuth refresh token back to the store, durably", async () => {
    const original = fresh("refresh");
    const rotated = fresh("refresh");
    const credential = { refreshToken: original, clientId: fresh("client"), clientSecret: fresh("csecret") };
    await secretStore().write(db(), A, "QUICKBOOKS_CREDENTIAL", JSON.stringify(credential));
    await raw`
      insert into public.integration_connection
        (organization_id, capability, provider, status, credential_ref, settings)
      values (${A}, 'accounting', 'quickbooks', 'connected', 'QUICKBOOKS_CREDENTIAL', ${raw.json({ realmId: "9" } as never)})`;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (String(input).includes("oauth")) {
        return new Response(JSON.stringify({ access_token: fresh("access"), refresh_token: rotated, expires_in: 3600 }), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    }));

    const { provider } = await accounting.resolveProvider({ actor: accounting.syncActor(A), db: db() });
    await provider.pushCustomer({} as never).catch(() => null);

    // A different store instance, as a restarted process would have.
    const restarted = databaseSecretStore(keyring(Buffer.from(process.env["SECRETS_MASTER_KEY"]!, "base64")));
    const stored = JSON.parse(await restarted.read(db(), A, "QUICKBOOKS_CREDENTIAL")) as { refreshToken: string };
    expect(stored.refreshToken).toBe(rotated);
    for (const line of logged) expect(line).not.toContain(rotated);
  });

  it("is written through the root handle, so a rolled back transaction does not lose it", async () => {
    const value = fresh("rotated");
    await db().transaction(async () => {
      await writerFor(db(), A)("ROTATING", value);
    }).catch(() => null);
    await db().transaction(async (tx) => {
      await writerFor(db(), A)("ROTATING_TOO", value);
      tx.rollback();
    }).catch(() => null);
    expect(await readerFor(db(), A)("ROTATING")).toBe(value);
    expect(await readerFor(db(), A)("ROTATING_TOO")).toBe(value);
  });
});

run("a lead webhook's signing secret", () => {
  it("goes straight into the company's store when it is minted, and no variable is asked for", async () => {
    const created = await leadConnectors.create(ctx(), { source: "our_site", displayName: "Our site" });
    expect(created.secretEnvironmentVariable).toBeNull();
    expect(await readerFor(db(), A)(created.secretRef)).toBe(created.secret);
    const rotated = await leadConnectors.rotateSecret(ctx(), { id: created.id });
    expect(await readerFor(db(), A)(created.secretRef)).toBe(rotated.secret);
  });
});
