import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * SEALING A GRANT UNDER A KEY THE DATABASE NEVER SEES
 *
 * A refresh token handed to this product at the end of a consent screen has
 * to be kept by this product; see `sealed_credential` for why that is the one
 * exception to "the database holds names, not secrets". It is kept as
 * AES-256-GCM ciphertext under `CREDENTIAL_SEALING_KEY`, which lives in the
 * deployment's environment beside its other secrets.
 *
 * GCM rather than a plain cipher because it is AUTHENTICATED: a sealed value
 * edited in the database, or moved onto another company's connection, fails
 * to open rather than opening as something else. The connection id is bound
 * in as additional data for exactly that second case.
 *
 * The key's fingerprint travels with every sealed value, so a deployment
 * that rotated its key is told "sealed under a key this deployment no longer
 * has, sign in again" instead of an authentication tag error.
 */

const VERSION = "v1";
export const SEALING_KEY_ENV = "CREDENTIAL_SEALING_KEY";

export class SealingKeyMissingError extends Error {
  constructor() {
    super(
      `This deployment has no ${SEALING_KEY_ENV}, so there is nowhere safe to keep what the platform hands back `
      + "after you sign in. Set it to 32 random bytes (openssl rand -base64 32) in the environment of both the "
      + "web app and the worker, or put a refresh token in your own secret store and enter its name as the "
      + "connection's credential instead.",
    );
    this.name = "SealingKeyMissingError";
  }
}

export class SealedUnderAnotherKeyError extends Error {
  constructor() {
    super(
      "The saved sign in was sealed under a key this deployment no longer has, which is what rotating "
      + `${SEALING_KEY_ENV} does. Sign in again to seal a new one.`,
    );
    this.name = "SealedUnderAnotherKeyError";
  }
}

/** The key from the environment: base64 or hex, and exactly 32 bytes either way. */
export function sealingKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env[SEALING_KEY_ENV]?.trim();
  if (!raw) return null;
  const bytes = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error(`${SEALING_KEY_ENV} must be 32 bytes, as 64 hex characters or base64. It is ${bytes.length}.`);
  }
  return bytes;
}

export const fingerprintOf = (key: Buffer): string => createHash("sha256").update(key).digest("hex").slice(0, 12);

export function seal(plaintext: string, binding: string, key: Buffer): { sealed: string; fingerprint: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(binding, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const fingerprint = fingerprintOf(key);
  return {
    sealed: [VERSION, fingerprint, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(":"),
    fingerprint,
  };
}

export function unseal(sealed: string, binding: string, key: Buffer): string {
  const [version, fingerprint, iv, tag, body] = sealed.split(":");
  if (version !== VERSION || !fingerprint || !iv || !tag || body === undefined) {
    throw new Error("A sealed credential is not in a shape this version can read.");
  }
  if (fingerprint !== fingerprintOf(key)) throw new SealedUnderAnotherKeyError();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(binding, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
