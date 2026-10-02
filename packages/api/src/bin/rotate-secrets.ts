/**
 * RE-ENCRYPT EVERY COMPANY'S SECRETS UNDER THE CURRENT KEY
 *
 *   SECRET_STORE=database \
 *   SECRETS_MASTER_KEY=<new> SECRETS_MASTER_KEY_PREVIOUS=<old> \
 *   pnpm --filter @opentradesos/api secrets:rotate
 *
 * Safe to run more than once and while the app is serving: a row already
 * under the current key is left alone, and a row the app rewrites meanwhile
 * is written under the current key anyway. When it reports nothing left, the
 * old key can be removed from SECRETS_MASTER_KEY_PREVIOUS.
 *
 * Connects as WORKER_DATABASE_URL (the `background` role, which may list the
 * companies that hold secrets) or DATABASE_URL. Prints counts, never a name
 * or a value.
 */
import { createClient } from "@opentradesos/db";
import { secretStore } from "../secrets/store";
import { rotateAll, keyringFromEnvironment, type DatabaseSecretStore } from "../secrets/database";

const url = process.env["WORKER_DATABASE_URL"] || process.env["DATABASE_URL"];
if (!url) {
  console.error("Set WORKER_DATABASE_URL or DATABASE_URL.");
  process.exit(1);
}
const store = secretStore();
if (store.kind !== "database") {
  console.error("SECRET_STORE is not database, so there is nothing stored to re-encrypt.");
  process.exit(1);
}

const db = createClient(url);
try {
  const current = keyringFromEnvironment().current.id;
  const outcome = await rotateAll(db, store as DatabaseSecretStore, current);
  console.info(
    `[secrets] re-encrypted ${outcome.secrets} secrets for ${outcome.organizations} companies under key ${current}`,
  );
} finally {
  await db.$close();
}
