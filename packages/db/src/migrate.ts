import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";

/**
 * MIGRATION ORCHESTRATION
 *
 * Three phases, in order, every time:
 *
 *   before   schema and extensions the generated migrations assume exist
 *   drizzle  the generated table migrations, tracked in the journal
 *   after    row level security, the ledger guards, and the coverage assertion
 *
 * `after` runs on every migration rather than once, and that is the point.
 * Row level security is applied by walking the catalog, so a table added in
 * today's migration is protected by today's run without anyone remembering to
 * do it. Every statement in there is written to be idempotent, and the file
 * ends with an assertion that fails the whole run if any table carrying
 * organization_id ended up without a policy.
 *
 * Running `after` once, at setup time, is how a project like this ends up with
 * one unprotected table and a cross tenant leak eighteen months later.
 */
const here = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(connectionString = process.env.DATABASE_URL): Promise<void> {
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  // max: 1 because migrations must run on a single connection, in order.
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

  try {
    console.info("  before   schema and extensions");
    await sql.unsafe(await readFile(join(here, "../sql/before.sql"), "utf8"));

    console.info("  drizzle  generated table migrations");
    await drizzleMigrate(drizzle(sql), { migrationsFolder: join(here, "../migrations") });

    console.info("  after    row level security, ledger guards, coverage assertion");
    await sql.unsafe(await readFile(join(here, "../sql/after.sql"), "utf8"));

    console.info("  done");
  } finally {
    await sql.end();
  }
}

// Allow `tsx src/migrate.ts` as well as importing it from a worker.
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  runMigrations().catch((err) => {
    console.error("\nMigration failed:\n", err);
    process.exit(1);
  });
}
