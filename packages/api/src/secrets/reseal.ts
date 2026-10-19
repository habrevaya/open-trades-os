import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID } from "@opentradesos/core";
import { inTenant } from "../services/context";
import { fingerprintIn, fingerprintOf, seal, unseal, type SealingKeys } from "../ads/sealing";

/**
 * MOVING EVERY SEALED SIGN IN ONTO A NEW SEALING KEY
 *
 * An ad platform's grant is the one credential this product keeps, sealed
 * under `CREDENTIAL_SEALING_KEY` (see `ads/sealing.ts`). Before this, the
 * only way to change that key was for every company to sign in to every
 * platform again. Now the operator puts the new key in place, keeps the old
 * one in `CREDENTIAL_SEALING_KEY_PREVIOUS`, restarts, and runs this.
 *
 * NOTHING IS EVER UNREADABLE. Each grant is opened and sealed again inside
 * one short transaction, so at every moment a row is either under the old
 * key or the new one, and the app opens both while the old key is still in
 * the previous list. A stop halfway (a crash, ^C, a lost connection) leaves
 * finished batches finished and the rest as they were; running it again
 * picks up whatever is not yet under the current key, which is what makes it
 * resumable without keeping any progress of its own.
 *
 * IT REFUSES TO START rather than half work:
 *   - when the current key cannot open a value it has just sealed, which is
 *     a key that would make every grant it touches unreadable;
 *   - when a grant already under the current key does not open with it,
 *     which means the app is sealing with a different key than this was
 *     given;
 *   - when a grant is under a key it was not given at all, unless it is told
 *     to leave those alone. Those are the connections a person has to sign
 *     in to again whatever happens, and the operator should decide that
 *     knowingly rather than find out afterwards.
 *
 * A grant the app rewrites while this runs (the platform handed back a new
 * token) is not overwritten: the write is conditional on the sealed value
 * being the one that was read, and the newer one is left for the next run
 * if it is still under the old key.
 *
 * It never prints, returns or logs a token. What comes back is counts and
 * key fingerprints, which the database already holds beside each row.
 */

/** Bound into the test seal so it can never be mistaken for, or swapped with, a real grant. */
const PROBE_BINDING = "opentradesos:sealing-key-probe";

export class ResealRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResealRefusedError";
  }
}

export interface ResealOptions {
  /** Grants per transaction. Small enough that a row is never locked for long. */
  batchSize?: number;
  /** Leave grants under a key this was not given, rather than refusing to start. */
  skipUnknown?: boolean;
  /**
   * Only these companies, every check included. For a careful first run on
   * one company before the rest, and for tests that share a database.
   */
  organizationIds?: readonly string[];
  /** Told after every batch, for progress. Counts only. Throwing stops the run where it is. */
  onBatch?: (progress: { organizationId: string; resealed: number }) => void | Promise<void>;
}

export interface ResealOutcome {
  /** The key everything is now under. */
  currentFingerprint: string;
  /** Companies that had anything to move. */
  organizations: number;
  resealed: number;
  /** Under a key this was not given, left as they are. Only with `skipUnknown`. */
  skippedUnknown: number;
  /** Changed by the app between being read and being written; the next run looks again. */
  changedMeanwhile: number;
  /** Failed to open under the key their fingerprint names: altered in the database. Left as they are. */
  failed: number;
  /** Still not under the current key after this run. Zero means the previous key can go. */
  remaining: number;
}

const systemCtx = (db: Database, organizationId: string) => ({
  actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] },
  db,
});

interface Survey { organizationId: string; fingerprint: string; sealed: number }

/** Every company's grants by the key they are under. Ids, fingerprints and counts only. */
async function survey(db: Database, only?: readonly string[]): Promise<Survey[]> {
  const rows = await db.execute<{ organization_id: string; key_fingerprint: string; sealed: number }>(
    sql`select organization_id, key_fingerprint, sealed from app.sealed_credential_keys()`,
  );
  return rows
    .map((r) => ({ organizationId: r.organization_id, fingerprint: r.key_fingerprint, sealed: Number(r.sealed) }))
    .filter((r) => !only || only.includes(r.organizationId));
}

/**
 * The checks that have to pass before anything is written. Exported so the
 * command can run them on their own (`--check`).
 */
export async function preflight(
  db: Database, keys: SealingKeys, options: Pick<ResealOptions, "skipUnknown" | "organizationIds"> = {},
): Promise<{ currentFingerprint: string; pending: Survey[]; unknown: Survey[] }> {
  const currentFingerprint = fingerprintOf(keys.current);

  // The test seal: a random value sealed under the new key must open again
  // through the same path the app reads grants with.
  const probe = randomBytes(24).toString("base64url");
  let opened: string | null = null;
  try {
    opened = unseal(seal(probe, PROBE_BINDING, keys.current).sealed, PROBE_BINDING, keys);
  } catch {
    opened = null;
  }
  if (opened !== probe) {
    throw new ResealRefusedError(
      "The new key in CREDENTIAL_SEALING_KEY could not open a test value it had just sealed. Nothing was changed.",
    );
  }

  const all = await survey(db, options.organizationIds);

  // A grant already under the current key (the app resealed it since the
  // restart, or an earlier run moved it) must open with it.
  const holder = all.find((row) => row.fingerprint === currentFingerprint);
  const already = holder ? await firstUnderCurrent(db, holder.organizationId, currentFingerprint) : null;
  if (already) {
    try {
      unseal(already.sealedToken, already.connectionId, keys.current);
    } catch {
      throw new ResealRefusedError(
        "A sign in already sealed under the current key's fingerprint does not open with it. Nothing was changed. "
        + "Check the web app, the worker and this command all have the same CREDENTIAL_SEALING_KEY.",
      );
    }
  }

  const known = new Set([keys.current, ...keys.previous].map(fingerprintOf));
  const old = all.filter((row) => row.fingerprint !== currentFingerprint);
  const unknown = old.filter((row) => !known.has(row.fingerprint));
  if (unknown.length > 0 && !options.skipUnknown) {
    const byKey = new Map<string, number>();
    for (const row of unknown) byKey.set(row.fingerprint, (byKey.get(row.fingerprint) ?? 0) + row.sealed);
    const list = [...byKey].map(([fingerprint, n]) => `${n} under key ${fingerprint}`).join(", ");
    throw new ResealRefusedError(
      `Some sign ins are sealed under a key this was not given (${list}). Nothing was changed. Put that key in `
      + "CREDENTIAL_SEALING_KEY_PREVIOUS, or, if it is lost for good, run again with --skip-unknown: those "
      + "connections then need somebody to sign in to them again.",
    );
  }
  return { currentFingerprint, pending: old.filter((row) => known.has(row.fingerprint)), unknown };
}

/** One of this company's grants under the current key, to try the key on. */
async function firstUnderCurrent(
  db: Database, organizationId: string, currentFingerprint: string,
): Promise<{ sealedToken: string; connectionId: string } | null> {
  return inTenant(systemCtx(db, organizationId), async (tx) => {
    const [row] = await tx.select({
      sealedToken: schema.sealedCredential.sealedToken, connectionId: schema.sealedCredential.connectionId,
    }).from(schema.sealedCredential)
      .where(eq(schema.sealedCredential.keyFingerprint, currentFingerprint))
      .orderBy(asc(schema.sealedCredential.id)).limit(1);
    return row ?? null;
  });
}

/** Reseal every grant not under the current key. Safe to run again, and while the app serves. */
export async function resealAll(db: Database, keys: SealingKeys, options: ResealOptions = {}): Promise<ResealOutcome> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const { currentFingerprint, pending, unknown } = await preflight(db, keys, options);
  const known = new Set([keys.current, ...keys.previous].map(fingerprintOf));
  const outcome: ResealOutcome = {
    currentFingerprint,
    organizations: 0,
    resealed: 0,
    skippedUnknown: unknown.reduce((n, row) => n + row.sealed, 0),
    changedMeanwhile: 0,
    failed: 0,
    remaining: 0,
  };

  const organizations = [...new Set(pending.map((row) => row.organizationId))];
  outcome.organizations = organizations.length;
  for (const organizationId of organizations) {
    // Walks by id so a row that cannot be moved (failed, changed, unknown)
    // is passed over rather than read again forever.
    let after: string | null = null;
    for (;;) {
      const batch: { resealed: number; last: string | null } = await inTenant(systemCtx(db, organizationId), async (tx) => {
        const table = schema.sealedCredential;
        const rows = await tx.select({
          id: table.id, connectionId: table.connectionId, sealedToken: table.sealedToken,
        }).from(table)
          .where(and(
            eq(table.organizationId, organizationId),
            ne(table.keyFingerprint, currentFingerprint),
            ...(after ? [gt(table.id, after)] : []),
          ))
          .orderBy(asc(table.id)).limit(batchSize);
        let resealed = 0;
        for (const row of rows) {
          const fingerprint = fingerprintIn(row.sealedToken);
          if (!fingerprint || !known.has(fingerprint)) continue;
          let plaintext: string;
          try {
            plaintext = unseal(row.sealedToken, row.connectionId, keys);
          } catch {
            outcome.failed += 1;
            continue;
          }
          const next = seal(plaintext, row.connectionId, keys.current);
          const written = await tx.update(table).set({
            sealedToken: next.sealed, keyFingerprint: next.fingerprint, updatedAt: new Date(),
          }).where(and(eq(table.id, row.id), eq(table.sealedToken, row.sealedToken))).returning({ id: table.id });
          if (written.length === 0) outcome.changedMeanwhile += 1;
          else resealed += 1;
        }
        return { resealed, last: rows.length === batchSize ? rows[rows.length - 1]!.id : null };
      });
      outcome.resealed += batch.resealed;
      await options.onBatch?.({ organizationId, resealed: batch.resealed });
      if (!batch.last) break;
      after = batch.last;
    }
  }

  outcome.remaining = (await survey(db, options.organizationIds))
    .filter((row) => row.fingerprint !== currentFingerprint)
    .reduce((n, row) => n + row.sealed, 0);
  return outcome;
}
