/**
 * MOVE EVERY SEALED SIGN IN ONTO THE CURRENT SEALING KEY
 *
 *   CREDENTIAL_SEALING_KEY=<new> CREDENTIAL_SEALING_KEY_PREVIOUS=<old> \
 *   pnpm --filter @opentradesos/api credentials:reseal [--check] [--batch-size=100] [--skip-unknown]
 *     [--company=<organization id>]...
 *
 * Run it after the web app and the worker have been restarted with the same
 * two variables, so both keys open while it works. It refuses to start when
 * the new key cannot open a test seal, when a grant already under the new
 * key does not open with it, or when a grant is under a key it was not given
 * (unless `--skip-unknown`). `--check` runs those checks and says what is
 * left, and changes nothing.
 *
 * Safe to stop and run again, and while the app is serving: each batch is
 * its own transaction, and what is already under the current key is left
 * alone. `--company` (more than once for several) limits it, checks and all,
 * to those companies. When it reports nothing left, the old key can be removed from
 * CREDENTIAL_SEALING_KEY_PREVIOUS.
 *
 * Connects as WORKER_DATABASE_URL (the `background` role, which may list
 * the companies holding sealed grants) or DATABASE_URL. Prints counts and
 * key fingerprints, never a token, a key or a company's name.
 */
import { createClient } from "@opentradesos/db";
import { sealingKeys, SEALING_KEY_ENV } from "../ads/sealing";
import { preflight, resealAll, ResealRefusedError } from "../secrets/reseal";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const batchArg = args.find((a) => a.startsWith("--batch-size="))?.split("=")[1];
const batchSize = batchArg ? Number(batchArg) : 100;
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
  console.error("--batch-size must be a whole number from 1 to 10000.");
  process.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const companies = args.filter((a) => a.startsWith("--company=")).map((a) => a.slice("--company=".length));
if (companies.some((id) => !UUID.test(id))) {
  console.error("--company takes a company's id.");
  process.exit(1);
}
const scope = companies.length > 0 ? { organizationIds: companies } : {};

const url = process.env["WORKER_DATABASE_URL"] || process.env["DATABASE_URL"];
if (!url) {
  console.error("Set WORKER_DATABASE_URL or DATABASE_URL.");
  process.exit(1);
}

let keys;
try {
  keys = sealingKeys();
} catch (error) {
  // The message names the variable and the length, never the value.
  console.error((error as Error).message);
  process.exit(1);
}
if (!keys) {
  console.error(`Set ${SEALING_KEY_ENV} to the new key, and the old one in CREDENTIAL_SEALING_KEY_PREVIOUS.`);
  process.exit(1);
}

const db = createClient(url);
let code = 0;
try {
  if (flag("check")) {
    const found = await preflight(db, keys, { skipUnknown: flag("skip-unknown"), ...scope });
    const pending = found.pending.reduce((n, row) => n + row.sealed, 0);
    const unknown = found.unknown.reduce((n, row) => n + row.sealed, 0);
    console.info(
      `[credentials] the checks pass for key ${found.currentFingerprint}: ${pending} sign ins to reseal`
      + (unknown > 0 ? `, ${unknown} under a key not given that would be left alone` : ""),
    );
  } else {
    const outcome = await resealAll(db, keys, {
      batchSize,
      skipUnknown: flag("skip-unknown"),
      ...scope,
      onBatch: ({ resealed }) => {
        if (resealed > 0) console.info(`[credentials] resealed ${resealed}`);
      },
    });
    console.info(
      `[credentials] resealed ${outcome.resealed} sign ins for ${outcome.organizations} companies under key `
      + `${outcome.currentFingerprint}; ${outcome.remaining} left under an older key`,
    );
    if (outcome.skippedUnknown > 0) console.warn(`[credentials] ${outcome.skippedUnknown} under a key not given were left alone`);
    if (outcome.changedMeanwhile > 0) console.warn(`[credentials] ${outcome.changedMeanwhile} changed while this ran; run it again`);
    if (outcome.failed > 0) {
      console.error(`[credentials] ${outcome.failed} did not open under the key they name and were left alone; they need a new sign in`);
      code = 1;
    }
    if (outcome.remaining === 0) console.info("[credentials] nothing left: CREDENTIAL_SEALING_KEY_PREVIOUS can be removed");
  }
} catch (error) {
  if (error instanceof ResealRefusedError) console.error(`[credentials] ${error.message}`);
  else console.error(`[credentials] stopped: ${(error as Error).message}`);
  code = 1;
} finally {
  await db.$close();
}
process.exit(code);
