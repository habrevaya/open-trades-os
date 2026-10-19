import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import * as adPlatforms from "../src/services/ad-platforms";
import {
  fingerprintOf, seal, sealingKeys, unseal, SealedUnderAnotherKeyError, type SealingKeys,
} from "../src/ads/sealing";
import { preflight, resealAll, ResealRefusedError } from "../src/secrets/reseal";
import { AuthorizationLostError } from "../src/ads/index";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { readSecret } from "./ads-fakes";

/**
 * ROTATING THE KEY AN AD PLATFORM'S SIGN IN IS SEALED UNDER
 *
 * What has to hold, end to end against the real table:
 *   - a grant sealed under the old key opens under the new one after the
 *     command, and the app opens it with the new key alone;
 *   - while the command runs, and after it is stopped halfway, every grant
 *     opens with the two keys the app holds, and running it again finishes;
 *   - a wrong old key, or a new key the existing grants contradict, is
 *     refused before anything is written;
 *   - a grant altered in the database is left alone and counted, not
 *     "resealed" into something that opens as junk;
 *   - the command prints counts, never a token or a key.
 *
 * The command works across companies, and other files keep sealed grants in
 * the same database, so every run here is limited to this file's companies.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const A = fixtureId("reseal:org-a");
const A_USER = fixtureId("reseal:user-a");
const B = fixtureId("reseal:org-b");
const B_USER = fixtureId("reseal:user-b");
const ONLY = { organizationIds: [A, B] };

let raw: postgres.Sql;
const db = () => testDb(url!);

const newKey = () => randomBytes(32);
const keysOf = (current: Buffer, ...previous: Buffer[]): SealingKeys => ({ current, previous });
/** Made at runtime, so nothing in the repository reads as a credential. */
const token = (label: string) => `${label}_${randomBytes(24).toString("base64url")}`;

let OLD: Buffer;
let NEW: Buffer;
/** connection id to the token sealed on it. */
let tokens: Map<string, string>;

async function connection(org: string, provider: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${org}, 'ads', ${provider}, 'connected', ${raw.json({ oauthClientRef: "GOOGLE_OAUTH_CLIENT", customerId: "1234567890" })})
    returning id`;
  return row!.id;
}

async function sealOn(org: string, connectionId: string, key: Buffer, value = token("refresh")): Promise<void> {
  const sealed = seal(value, connectionId, key);
  await raw`
    insert into public.sealed_credential (organization_id, connection_id, sealed_token, key_fingerprint, granted_at)
    values (${org}, ${connectionId}, ${sealed.sealed}, ${sealed.fingerprint}, now())
    on conflict (connection_id) do update set sealed_token = excluded.sealed_token, key_fingerprint = excluded.key_fingerprint`;
  tokens.set(connectionId, value);
}

const grants = () => raw<{ connection_id: string; sealed_token: string; key_fingerprint: string }[]>`
  select connection_id, sealed_token, key_fingerprint from public.sealed_credential
   where organization_id in (${A}, ${B}) order by id`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id in (${A}, ${B})`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: A, userId: A_USER, name: "Reseal A Co", slug: "reseal-a" });
  await seedOrg(raw, { organizationId: B, userId: B_USER, name: "Reseal B Co", slug: "reseal-b" });
  OLD = newKey();
  NEW = newKey();
  tokens = new Map();
  await sealOn(A, await connection(A, "google_ads"), OLD);
  await sealOn(A, await connection(A, "google_lsa"), OLD);
  await sealOn(B, await connection(B, "google_ads"), OLD);
});

run("resealing every sign in under a new key", () => {
  it("opens a grant sealed before the rotation after it, with the new key alone", async () => {
    // Before: the new key alone cannot open it, and says how to fix that.
    const [first] = await grants();
    expect(() => unseal(first!.sealed_token, first!.connection_id, NEW)).toThrow(SealedUnderAnotherKeyError);
    expect(() => unseal(first!.sealed_token, first!.connection_id, NEW)).toThrow(/CREDENTIAL_SEALING_KEY_PREVIOUS/);

    const outcome = await resealAll(db(), keysOf(NEW, OLD), ONLY);
    expect(outcome).toMatchObject({
      organizations: 2, resealed: 3, failed: 0, changedMeanwhile: 0, skippedUnknown: 0, remaining: 0,
      currentFingerprint: fingerprintOf(NEW),
    });

    for (const grant of await grants()) {
      expect(grant.key_fingerprint).toBe(fingerprintOf(NEW));
      expect(grant.sealed_token).not.toContain(tokens.get(grant.connection_id)!);
      expect(unseal(grant.sealed_token, grant.connection_id, NEW)).toBe(tokens.get(grant.connection_id));
      expect(() => unseal(grant.sealed_token, grant.connection_id, OLD)).toThrow(SealedUnderAnotherKeyError);
    }

    // The app, given only the new key, builds its adapter from the grant; given only the old one, it cannot.
    const connection = await adPlatforms.connectedRow(db(), A, "google_ads");
    const onlyNew = { CREDENTIAL_SEALING_KEY: NEW.toString("base64") };
    await expect(adPlatforms.adapterFor(db(), connection, { readSecret, env: onlyNew })).resolves.toBeTruthy();
    const onlyOld = { CREDENTIAL_SEALING_KEY: OLD.toString("base64") };
    await expect(adPlatforms.adapterFor(db(), connection, { readSecret, env: onlyOld }))
      .rejects.toBeInstanceOf(AuthorizationLostError);

    // Running it again finds nothing to do.
    expect(await resealAll(db(), keysOf(NEW, OLD), ONLY)).toMatchObject({ organizations: 0, resealed: 0, remaining: 0 });
  });

  it("leaves every grant readable when stopped halfway, and finishes when run again", async () => {
    const both = sealingKeys({ CREDENTIAL_SEALING_KEY: NEW.toString("base64"), CREDENTIAL_SEALING_KEY_PREVIOUS: OLD.toString("base64") })!;
    let batches = 0;
    await expect(resealAll(db(), both, {
      ...ONLY,
      batchSize: 1,
      onBatch: () => {
        batches += 1;
        // Every grant opens with the keys the app holds, at every batch boundary.
        return grants().then((rows) => {
          for (const g of rows) expect(unseal(g.sealed_token, g.connection_id, both)).toBe(tokens.get(g.connection_id));
          if (batches === 1) throw new Error("stopped");
        });
      },
    })).rejects.toThrow("stopped");

    const halfway = await grants();
    expect(halfway.filter((g) => g.key_fingerprint === fingerprintOf(NEW))).toHaveLength(1);
    expect(halfway.filter((g) => g.key_fingerprint === fingerprintOf(OLD))).toHaveLength(2);
    for (const g of halfway) expect(unseal(g.sealed_token, g.connection_id, both)).toBe(tokens.get(g.connection_id));

    const rest = await resealAll(db(), both, { ...ONLY, batchSize: 1 });
    expect(rest).toMatchObject({ resealed: 2, remaining: 0, failed: 0 });
    for (const g of await grants()) expect(unseal(g.sealed_token, g.connection_id, NEW)).toBe(tokens.get(g.connection_id));
  });

  it("refuses a wrong old key before writing anything", async () => {
    const before = await grants();
    const wrong = newKey();
    await expect(resealAll(db(), keysOf(NEW, wrong), ONLY)).rejects.toBeInstanceOf(ResealRefusedError);
    await expect(resealAll(db(), keysOf(NEW, wrong), ONLY)).rejects.toThrow(/under a key this was not given/);
    // And with no old key at all.
    await expect(preflight(db(), keysOf(NEW), ONLY)).rejects.toBeInstanceOf(ResealRefusedError);
    expect(await grants()).toEqual(before);
  });

  it("refuses a new key that a grant already under its fingerprint does not open with", async () => {
    // A grant the app sealed under NEW, then altered: the key this run holds is not the one that grant was sealed with.
    const id = await connection(B, "meta_ads");
    await sealOn(B, id, NEW);
    await raw`update public.sealed_credential set sealed_token = sealed_token || 'AA' where connection_id = ${id}`;
    const before = await grants();
    await expect(resealAll(db(), keysOf(NEW, OLD), ONLY)).rejects.toThrow(/does not open with it/);
    expect(await grants()).toEqual(before);
  });

  it("leaves a grant altered in the database alone and counts it, and moves the rest", async () => {
    const [victim] = await grants();
    const parts = victim!.sealed_token.split(":");
    parts[4] = Buffer.from(randomBytes(20)).toString("base64url");
    await raw`update public.sealed_credential set sealed_token = ${parts.join(":")} where connection_id = ${victim!.connection_id}`;

    const outcome = await resealAll(db(), keysOf(NEW, OLD), ONLY);
    expect(outcome).toMatchObject({ resealed: 2, failed: 1, remaining: 1 });
    const [after] = await raw<{ sealed_token: string }[]>`
      select sealed_token from public.sealed_credential where connection_id = ${victim!.connection_id}`;
    expect(after!.sealed_token).toBe(parts.join(":"));
  });

  it("leaves grants under a lost key alone only when told to", async () => {
    const lost = newKey();
    const id = await connection(B, "meta_ads");
    await sealOn(B, id, lost);
    await expect(resealAll(db(), keysOf(NEW, OLD), ONLY)).rejects.toBeInstanceOf(ResealRefusedError);
    const outcome = await resealAll(db(), keysOf(NEW, OLD), { ...ONLY, skipUnknown: true });
    expect(outcome).toMatchObject({ resealed: 3, skippedUnknown: 1, remaining: 1 });
    const [kept] = await raw<{ key_fingerprint: string }[]>`
      select key_fingerprint from public.sealed_credential where connection_id = ${id}`;
    expect(kept!.key_fingerprint).toBe(fingerprintOf(lost));
  });

  it("refuses a malformed old key by its position and never echoes it", () => {
    const short = randomBytes(16).toString("base64");
    let message = "";
    try {
      sealingKeys({ CREDENTIAL_SEALING_KEY: NEW.toString("base64"), CREDENTIAL_SEALING_KEY_PREVIOUS: `${OLD.toString("base64")},${short}` });
    } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/CREDENTIAL_SEALING_KEY_PREVIOUS \(entry 2\)/);
    expect(message).not.toContain(short);
  });

  it("runs as the command a self hoster types, printing counts and never a token or a key", async () => {
    const exec = promisify(execFile);
    const bin = join(import.meta.dirname, "..", "src", "bin", "reseal-credentials.ts");
    const tsx = join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");
    const env = {
      ...process.env,
      WORKER_DATABASE_URL: "",
      DATABASE_URL: url!,
      CREDENTIAL_SEALING_KEY: NEW.toString("base64"),
      CREDENTIAL_SEALING_KEY_PREVIOUS: OLD.toString("base64"),
    };
    const company = [`--company=${A}`, `--company=${B}`];

    // A wrong old key: refused, exit code 1, nothing changed.
    const before = await grants();
    const refused = await exec(tsx, [bin, ...company], {
      env: { ...env, CREDENTIAL_SEALING_KEY_PREVIOUS: newKey().toString("base64") },
    }).then(() => null, (e: { code: number; stdout: string; stderr: string }) => e);
    expect(refused?.code).toBe(1);
    expect(refused?.stderr).toMatch(/Nothing was changed/);
    expect(await grants()).toEqual(before);

    const checked = await exec(tsx, [bin, "--check", ...company], { env });
    expect(checked.stdout).toMatch(/3 sign ins to reseal/);
    expect(await grants()).toEqual(before);

    const done = await exec(tsx, [bin, "--batch-size=2", ...company], { env });
    expect(done.stdout).toMatch(/resealed 3 sign ins for 2 companies/);
    expect(done.stdout).toMatch(/nothing left/);
    const printed = done.stdout + done.stderr + checked.stdout + checked.stderr + refused!.stdout + refused!.stderr;
    for (const value of tokens.values()) expect(printed).not.toContain(value);
    for (const key of [NEW, OLD]) {
      expect(printed).not.toContain(key.toString("base64"));
      expect(printed).not.toContain(key.toString("hex"));
    }
    for (const g of await grants()) expect(g.key_fingerprint).toBe(fingerprintOf(NEW));
  }, 60_000);
});
