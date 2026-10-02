import "server-only";
import { createClient, type Database } from "@opentradesos/db";

/**
 * One pool for the whole server, not one per call.
 *
 * `createClient` opens a fresh pool of ten connections every time it is
 * invoked, which is right for a migration or a test that wants isolation and
 * catastrophic on a request path: a page that calls it per render exhausts
 * Postgres under any real traffic, and the failure arrives as connection
 * timeouts that look like a database problem rather than a client one.
 *
 * The `globalThis` stash is for development. Next.js hot reloads this module
 * on every edit, and without it each reload leaks another ten connections
 * until the database refuses new ones, which takes about twenty saves.
 */
const globalForDb = globalThis as unknown as { __otsDb?: Database };

export function getDb(): Database {
  globalForDb.__otsDb ??= createClient();
  return globalForDb.__otsDb;
}

const globalForWorkerDb = globalThis as unknown as { __otsWorkerDb?: Database };

/**
 * The connection the worker tick uses.
 *
 * The worker's own, when one is configured. Finding which companies have
 * unread events calls `app.pending_event_organizations`, which the role the
 * request path runs as deliberately may not call, so a deployment that
 * connects the web app as an ordinary role points WORKER_DATABASE_URL at the
 * `background` role exactly as it would for the worker container. Unset, the
 * web app's own pool is used, which is right in development and for anybody
 * whose DATABASE_URL can already do everything. See docs/self-hosting/worker.md.
 */
export function getWorkerDb(): Database {
  const url = process.env["WORKER_DATABASE_URL"];
  if (!url) return getDb();
  globalForWorkerDb.__otsWorkerDb ??= createClient(url);
  return globalForWorkerDb.__otsWorkerDb;
}
