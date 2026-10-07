import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { connectors, SYSTEM_USER_ID } from "@opentradesos/core";
import { ConflictError, inTenant } from "../services/context";
import { assertSecretName, SecretNotSetError, type SecretStatus, type SecretStore } from "./store";

/**
 * THE DATABASE STORE: A COMPANY'S OWN SECRETS, ENCRYPTED, IN POSTGRES
 *
 * For a deployment that serves several companies. There the environment is
 * the operator's, so the environment store gives a company nowhere to put
 * its own Stripe key, and OAuth refresh tokens rotate into process memory and
 * are gone at the next restart. Here each company pastes its secret once, it
 * is encrypted before it leaves this process, and a rotated token is written
 * back durably.
 *
 * WHY THE APPLICATION ENCRYPTS, RATHER THAN POSTGRES.
 *
 * The key never reaches the database. pgcrypto or a SECURITY DEFINER
 * decrypt function would need the key in a SQL statement or a server
 * setting, which puts it in `pg_stat_statements`, in a log line at
 * `log_min_duration_statement`, and in every backup of a setting table.
 * Here a database dump, a replica, a support engineer's `select *` and a SQL
 * injection all see ciphertext, and decrypting needs both the row and
 * `SECRETS_MASTER_KEY`, which only the application processes hold.
 *
 * THE ENVELOPE. AES-256-GCM, a fresh 96 bit nonce per write, and a text
 * envelope that carries its own format version and key id:
 *
 *   ots1.<key id>.<nonce>.<ciphertext>.<tag>          (base64url parts)
 *
 * The key id is a fingerprint of the key rather than a name somebody
 * chooses, so two keys can never share one, and a server handed the wrong
 * key says so rather than reporting tampering.
 *
 * BOUND TO ITS ROW. The additional authenticated data is the format version,
 * the organization and the name. A row copied into another company, or
 * renamed to stand in for a different secret, fails authentication instead
 * of decrypting: isolation does not rest on row level security alone.
 *
 * ROTATING THE KEY. Set the new key as SECRETS_MASTER_KEY and the old one in
 * SECRETS_MASTER_KEY_PREVIOUS (comma separated, newest first). Both decrypt;
 * only the current one encrypts. Then `pnpm --filter @opentradesos/api
 * secrets:rotate` re-encrypts every row under the current key, after which
 * the previous key can be removed. docs/self-hosting/secrets.md.
 */

const VERSION = "ots1";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export interface MasterKey {
  id: string;
  key: Buffer;
}

const b64u = (bytes: Buffer) => bytes.toString("base64url");
const unb64u = (text: string) => Buffer.from(text, "base64url");

/** A short fingerprint, so an envelope says which key made it without saying anything about the key. */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update("opentradesos:secret-key-id:").update(key).digest("hex").slice(0, 16);
}

/** One key from its base64 form, refusing anything that is not exactly 32 bytes. Never echoes the input. */
export function masterKeyFrom(encoded: string, variable: string): MasterKey {
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${variable} must be ${KEY_BYTES} random bytes, base64 encoded (it decoded to ${key.length}). `
      + "Generate one with: openssl rand -base64 32",
    );
  }
  return { id: keyIdOf(key), key };
}

export interface Keyring {
  current: MasterKey;
  /** Decrypt only. */
  previous: MasterKey[];
}

/** The keyring from SECRETS_MASTER_KEY and SECRETS_MASTER_KEY_PREVIOUS. */
export function keyringFromEnvironment(env: NodeJS.ProcessEnv = process.env): Keyring {
  const current = env["SECRETS_MASTER_KEY"];
  if (!current || current.trim() === "") {
    throw new Error(
      "SECRET_STORE=database needs SECRETS_MASTER_KEY: 32 random bytes, base64 encoded. "
      + "Generate one with: openssl rand -base64 32. Keep it out of the database and its backups; "
      + "every company's provider secrets are unreadable without it.",
    );
  }
  const previous = (env["SECRETS_MASTER_KEY_PREVIOUS"] ?? "")
    .split(",").map((part) => part.trim()).filter(Boolean)
    .map((part, i) => masterKeyFrom(part, `SECRETS_MASTER_KEY_PREVIOUS (entry ${i + 1})`));
  return { current: masterKeyFrom(current, "SECRETS_MASTER_KEY"), previous };
}

const aadFor = (organizationId: string, name: string) =>
  Buffer.from(`opentradesos:integration_secret:${VERSION}:${organizationId}:${name}`, "utf8");

export function seal(keyring: Keyring, organizationId: string, name: string, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyring.current.key, nonce);
  cipher.setAAD(aadFor(organizationId, name));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, keyring.current.id, b64u(nonce), b64u(body), b64u(cipher.getAuthTag())].join(".");
}

/**
 * The secret could not be decrypted.
 *
 * Says which of the two things went wrong and never anything about the
 * value. A ConflictError, so an admin sees the sentence; the fix is theirs.
 */
export class SecretUnreadableError extends ConflictError {
  constructor(readonly secretName: string, reason: "unknown_key" | "tampered") {
    super(
      reason === "unknown_key"
        ? `The secret "${secretName}" was encrypted with a key this server does not have. Put the key it `
          + "was written with in SECRETS_MASTER_KEY_PREVIOUS, or paste the secret again."
        : `The secret "${secretName}" failed its integrity check and was not used. It was altered or moved `
          + "in the database. Paste it again.",
    );
    this.name = "SecretUnreadableError";
  }
}

export function open(
  keyring: Keyring, organizationId: string, name: string, envelope: string,
): { plaintext: string; keyId: string } {
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new SecretUnreadableError(name, "tampered");
  const [, keyId, nonce, body, tag] = parts as [string, string, string, string, string];
  const key = [keyring.current, ...keyring.previous].find((k) => k.id === keyId);
  if (!key) throw new SecretUnreadableError(name, "unknown_key");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, unb64u(nonce));
    decipher.setAAD(aadFor(organizationId, name));
    decipher.setAuthTag(unb64u(tag));
    const plaintext = Buffer.concat([decipher.update(unb64u(body)), decipher.final()]).toString("utf8");
    return { plaintext, keyId };
  } catch {
    throw new SecretUnreadableError(name, "tampered");
  }
}

/** Shown so somebody can tell which key is in. Nothing for a value too short to spare four characters. */
const last4Of = (value: string) => (value.length >= 12 ? value.slice(-4) : null);

/**
 * Run inside this organization's tenant boundary.
 *
 * The table is under row level security like every tenant table, and forced,
 * so even the table's owner sees nothing outside a tenant context. A caller
 * already inside a transaction for this organization is used as it is; a
 * caller inside a DIFFERENT organization's transaction is refused, because
 * that is a bug that would otherwise read as "not set".
 */
async function scoped<T>(db: Database, organizationId: string, fn: (tx: Database) => Promise<T>): Promise<T> {
  const rows = await db.execute<{ org: string | null }>(
    sql`select nullif(current_setting('app.organization_id', true), '') as org`,
  );
  const current = rows[0]?.org ?? null;
  if (current === organizationId) return fn(db);
  if (current !== null) {
    throw new Error("A secret was asked for on behalf of one organization inside another's transaction.");
  }
  return inTenant({ actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] }, db }, fn);
}

export interface DatabaseSecretStore extends SecretStore {
  readonly kind: "database";
  /** Remove one. True when there was something to remove. */
  remove(db: Database, organizationId: string, name: string): Promise<boolean>;
  /** Every secret this organization has stored. Never a value. */
  list(db: Database, organizationId: string): Promise<SecretStatus[]>;
  /** Re-encrypt this organization's rows under the current key. Returns how many changed. */
  rotate(db: Database, organizationId: string): Promise<number>;
}

const statusOf = (row: { name: string; last4: string | null; updatedAt: Date }): SecretStatus => ({
  name: row.name,
  set: true,
  last4: row.last4,
  updatedAt: row.updatedAt.toISOString(),
  environmentVariable: null,
});

export function databaseSecretStore(keyring: Keyring): DatabaseSecretStore {
  const table = schema.integrationSecret;

  async function upsert(tx: Database, organizationId: string, name: string, value: string): Promise<void> {
    const envelope = seal(keyring, organizationId, name, value);
    const now = new Date();
    await tx.insert(table).values({
      organizationId, name, envelope, keyId: keyring.current.id, last4: last4Of(value), updatedAt: now,
    }).onConflictDoUpdate({
      target: [table.organizationId, table.name],
      set: { envelope, keyId: keyring.current.id, last4: last4Of(value), updatedAt: now },
    });
  }

  return {
    kind: "database",

    async read(db, organizationId, name) {
      assertSecretName(name);
      const row = await scoped(db, organizationId, async (tx) => {
        const [found] = await tx.select({ envelope: table.envelope }).from(table)
          .where(and(eq(table.organizationId, organizationId), eq(table.name, name))).limit(1);
        return found ?? null;
      });
      if (!row) {
        throw new SecretNotSetError(
          name,
          "Paste it on Settings → Integrations, or send it to PUT /v1/secrets/" + name + ".",
        );
      }
      return open(keyring, organizationId, name, row.envelope).plaintext;
    },

    async write(db, organizationId, name, value) {
      assertSecretName(name);
      if (value === "") throw new ConflictError("A secret cannot be empty. Clear it instead.");
      await scoped(db, organizationId, (tx) => upsert(tx, organizationId, name, value));
    },

    async status(db, organizationId, names) {
      const valid = names.filter((name) => connectors.SECRET_NAME_PATTERN.test(name));
      const rows = valid.length === 0 ? [] : await scoped(db, organizationId, (tx) =>
        tx.select({ name: table.name, last4: table.last4, updatedAt: table.updatedAt }).from(table)
          .where(and(eq(table.organizationId, organizationId), inArray(table.name, valid))));
      const byName = new Map(rows.map((row) => [row.name, row]));
      return names.map((name) => {
        const row = byName.get(name);
        return row
          ? statusOf(row)
          : { name, set: false, last4: null, updatedAt: null, environmentVariable: null };
      });
    },

    async remove(db, organizationId, name) {
      assertSecretName(name);
      const removed = await scoped(db, organizationId, (tx) =>
        tx.delete(table).where(and(eq(table.organizationId, organizationId), eq(table.name, name)))
          .returning({ id: table.id }));
      return removed.length > 0;
    },

    async list(db, organizationId) {
      const rows = await scoped(db, organizationId, (tx) =>
        tx.select({ name: table.name, last4: table.last4, updatedAt: table.updatedAt }).from(table)
          .where(eq(table.organizationId, organizationId)).orderBy(table.name));
      return rows.map(statusOf);
    },

    async rotate(db, organizationId) {
      return scoped(db, organizationId, async (tx) => {
        const rows = await tx.select({ name: table.name, envelope: table.envelope, keyId: table.keyId })
          .from(table).where(eq(table.organizationId, organizationId));
        let changed = 0;
        for (const row of rows) {
          if (row.keyId === keyring.current.id) continue;
          const { plaintext } = open(keyring, organizationId, row.name, row.envelope);
          const envelope = seal(keyring, organizationId, row.name, plaintext);
          await tx.update(table).set({ envelope, keyId: keyring.current.id })
            .where(and(eq(table.organizationId, organizationId), eq(table.name, row.name)));
          changed += 1;
        }
        return changed;
      });
    },
  };
}

/**
 * Re-encrypt every company's secrets that are not under the current key.
 *
 * Finds the companies through `app.secret_organizations`, which returns ids
 * and nothing else, then rotates each inside its own tenant context. Run it
 * after moving the old key to SECRETS_MASTER_KEY_PREVIOUS; when it reports
 * nothing left, the old key can go.
 */
export async function rotateAll(
  db: Database, store: DatabaseSecretStore, currentKeyId: string,
): Promise<{ organizations: number; secrets: number }> {
  const rows = await db.execute<{ id: string }>(
    sql`select app.secret_organizations(${currentKeyId}) as id`,
  );
  let secrets = 0;
  for (const row of rows) secrets += await store.rotate(db, row.id);
  return { organizations: rows.length, secrets };
}
