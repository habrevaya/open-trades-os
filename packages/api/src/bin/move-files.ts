/**
 * MOVING STORED FILES INTO A BUCKET, OR BACK OUT OF ONE
 *
 *   pnpm --filter @opentradesos/api move-files              to where FILE_STORAGE says new files go
 *   pnpm --filter @opentradesos/api move-files -- --to postgres
 *   pnpm --filter @opentradesos/api move-files -- --dry-run
 *
 * Run by whoever runs the deployment, with the same settings the app has, while
 * the app is in use: every file is moved in a transaction of its own, read back
 * from where it went and checked against the hash it was stored under before
 * its row changes, and the app reads each file from wherever its row says it
 * is. Stopping it halfway is safe, and running it again carries on.
 *
 * It needs a database role that may call `app.file_store_organizations`, as
 * the worker does: WORKER_DATABASE_URL, or DATABASE_URL in development.
 */
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { moveFiles } from "../services/file-storage";
import { fileStorage } from "../storage";

const url = process.env["WORKER_DATABASE_URL"] || process.env["DATABASE_URL"];
if (!url) {
  console.error("Set WORKER_DATABASE_URL or DATABASE_URL.");
  process.exit(1);
}

const flag = (name: string) => process.argv.indexOf(name);
const toArg = flag("--to") >= 0 ? process.argv[flag("--to") + 1] : undefined;
const dryRun = flag("--dry-run") >= 0;

let storage;
try {
  storage = fileStorage();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const to = (toArg ?? storage.writeTo) as "object" | "postgres";
if (to !== "object" && to !== "postgres") {
  console.error(`--to is object or postgres, not ${toArg}.`);
  process.exit(1);
}
if (!storage.bucket) {
  console.error("There is no bucket configured, so there is nowhere to move files to or from. Set the FILE_STORAGE_S3_ settings.");
  process.exit(1);
}
const from = to === "object" ? "postgres" : "object";

const db = createClient(url);
let moved = 0;
let bytes = 0;
const failed: { organizationId: string; storageKey: string; reason: string }[] = [];
const leftBehind: string[] = [];

try {
  const waiting = await db.execute<{ organization_id: string; files: string }>(
    sql`select organization_id, files::text from app.file_store_organizations(${from}, 100000)`,
  );
  const total = waiting.reduce((n, row) => n + Number(row.files), 0);
  console.info(`${total} files in ${from === "postgres" ? "Postgres" : "the bucket"} across ${waiting.length} companies, going to ${to === "postgres" ? "Postgres" : `${storage.bucket.client.bucket}`}.`);
  if (dryRun) {
    console.info("A dry run: nothing was moved.");
  } else {
    for (const row of waiting) {
      /**
       * A batch at a time, in id order, until there is nothing left to look
       * at. A file that fails is passed over and listed at the end rather than
       * tried forever.
       */
      let after: string | undefined;
      for (;;) {
        const result = await moveFiles(db, row.organization_id, { to, limit: 200, after });
        moved += result.moved;
        bytes += result.bytes;
        leftBehind.push(...result.leftBehind);
        for (const failure of result.failed) failed.push({ organizationId: row.organization_id, ...failure });
        if (!result.last) break;
        after = result.last;
        console.info(`${moved} of ${total} moved, ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
      }
    }
    console.info(`Done: ${moved} files moved and checked, ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
    if (leftBehind.length > 0) {
      console.warn(`${leftBehind.length} copies were left in the bucket after moving home, because deleting them failed. The files are safe in Postgres; the copies can be deleted by hand:`);
      for (const key of leftBehind) console.warn(`  ${key}`);
    }
    if (failed.length > 0) {
      console.error(`${failed.length} files were not moved and are still readable where they were:`);
      for (const failure of failed) console.error(`  ${failure.organizationId} ${failure.storageKey}: ${failure.reason}`);
      process.exitCode = 1;
    }
  }
} finally {
  await db.$close();
}
