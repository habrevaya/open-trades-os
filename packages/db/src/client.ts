import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createClient>;

/**
 * Works against any Postgres 16+: local docker, a managed instance, or a
 * customer's own Supabase project. Supabase is the default recommendation, not
 * a requirement, and nothing in this package depends on a Supabase-only API.
 */
export function createClient(connectionString = process.env.DATABASE_URL!) {
  const client = postgres(connectionString, { max: 10, prepare: false });
  const db = drizzle(client, { schema });
  /**
   * The pool, reachable for the one caller that has to close it.
   *
   * A pooled connection keeps Node's event loop alive, so a long running
   * process that finishes its work and returns never exits: the worker
   * handled its SIGTERM, stopped cleanly, logged that it had stopped, and
   * then hung until the orchestrator gave up and sent SIGKILL. A graceful
   * shutdown that ends in a kill is not one.
   *
   * A request handler must not call this. Closing the shared pool from a
   * request would take out every other request using it.
   */
  Object.defineProperty(db, "$close", {
    value: () => client.end({ timeout: 5 }),
    enumerable: false,
  });
  return db as ReturnType<typeof drizzle<typeof schema>> & { $close: () => Promise<void> };
}

/**
 * Run a callback inside a transaction with the tenant context set, so every
 * row level security policy in the database resolves correctly.
 *
 * This is THE tenant boundary. Application code never filters by
 * organization_id by hand, because a forgotten WHERE clause is a cross-tenant
 * data leak and hand-written filters are forgotten eventually. The policies do
 * it, and they are tested in test/rls.sql.
 *
 * The service role connection bypasses RLS and must never be reachable from a
 * request path. It exists for migrations and the reconciliation worker only.
 */
export async function withTenant<T>(
  db: Database,
  ctx: { organizationId: string; userId?: string },
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${ctx.organizationId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${ctx.userId ?? ""}, true)`);
    return fn(tx as unknown as Database);
  });
}
