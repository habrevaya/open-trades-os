/**
 * MAKE A COMPANY THE PUBLIC DEMO
 *
 *   DATABASE_URL=<session connection> \
 *   pnpm --filter @opentradesos/api demo:setup --organization <company id>
 *
 * Gives the company a dedicated, read only demo user and marks it the demo
 * (docs/self-hosting/demo.md). Safe to run again: it changes only what is not
 * already in place, and it deletes nothing, in that company or any other.
 * Then set DEMO_ORGANIZATION_ID to the same id on the site to turn on /demo.
 *
 * `pnpm --filter @opentradesos/api demo:seed` creates a sample company to use
 * and runs this for it.
 *
 * Connects as DATABASE_URL, the deployment's own account: marking a company
 * the demo is refused to any role that is not the operator's.
 */
import { createClient } from "@opentradesos/db";
import { setupDemo } from "../services/demo";

const flag = process.argv.indexOf("--organization");
const organizationId = flag === -1 ? undefined : process.argv[flag + 1];
const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("Set DATABASE_URL.");
  process.exit(1);
}
if (!organizationId) {
  console.error("Usage: pnpm --filter @opentradesos/api demo:setup --organization <company id>");
  process.exit(1);
}

const db = createClient(url);
try {
  const done = await setupDemo(db, organizationId);
  console.info(`[demo] ${done.organizationName} is the demo${done.changed ? "" : " (nothing to change)"}.`);
  console.info(`DEMO_ORGANIZATION_ID=${done.organizationId}`);
} catch (error) {
  console.error(`[demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await db.$close();
}
