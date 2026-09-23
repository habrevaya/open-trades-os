/**
 * THE WORKER PROCESS
 *
 * Runs beside the web app and drains the event log. Separate because the two
 * scale differently and fail differently: a serverless web deployment has no
 * place to run a loop, and a worker that dies must not take the UI with it.
 *
 *   pnpm --filter @opentradesos/api worker
 *
 * It needs a database role that may call `app.pending_event_organizations`,
 * which the request path's role deliberately cannot. `background` is created
 * by the migrations; point WORKER_DATABASE_URL at it, or leave it unset in
 * development and DATABASE_URL is used.
 */
import { createClient } from "@opentradesos/db";
import { runWorker } from "../services/workflow-worker";
import { flush, providerFor, recoverStuck } from "../services/comms-outbox";
import { inTenant } from "../services/context";
import { ProviderNotConfiguredError } from "../comms/provider";
// Registers the carrier adapters. Drop this import and the worker still runs;
// the outbox simply finds no provider and leaves messages queued.
import "../comms";

const url = process.env["WORKER_DATABASE_URL"] ?? process.env["DATABASE_URL"];
if (!url) {
  console.error("Set WORKER_DATABASE_URL or DATABASE_URL.");
  process.exit(1);
}

const db = createClient(url);
const controller = new AbortController();

/**
 * Stop between passes rather than mid-event.
 *
 * A worker killed halfway through a step leaves a run marked `running` that
 * nothing will finish. Aborting the loop lets the event in flight complete,
 * and the deployment's own timeout is the backstop if a step hangs.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`[worker] ${signal}, finishing the current event`);
    controller.abort();
  });
}

const interval = Number(process.env["WORKER_INTERVAL_MS"] ?? 5_000);

/**
 * Reading a carrier credential.
 *
 * A deployment stores these wherever it stores secrets: Supabase Vault, a
 * KMS, a file mounted by the orchestrator. The default reads an environment
 * variable named by the connection's `credentialRef`, which is the smallest
 * thing that works and keeps the secret out of the database.
 */
const readSecret = async (ref: string): Promise<string> => {
  const value = process.env[ref];
  if (!value) throw new Error(`No secret in the environment for "${ref}"`);
  return value;
};

async function sendQueued(organizationId: string): Promise<void> {
  const provider = await inTenant(
    { actor: { userId: "00000000-0000-0000-0000-000000000000", organizationId, roles: [] }, db },
    async (tx) => providerFor(tx, organizationId, readSecret),
  ).catch((error: unknown) => {
    // No carrier connected is an ordinary state, not an error. The messages
    // stay queued and go out when one is.
    if (error instanceof ProviderNotConfiguredError) return null;
    throw error;
  });
  if (!provider) return;

  await recoverStuck(db, organizationId);
  await flush(db, organizationId, { provider });
}

console.info(`[worker] draining every ${interval}ms`);
await runWorker({
  db,
  intervalMs: interval,
  signal: controller.signal,
  afterDrain: sendQueued,
  onPass: (results) => {
    const events = results.reduce((n, r) => n + r.events, 0);
    if (events > 0) {
      console.info(`[worker] ${events} events across ${results.length} organizations`);
    }
  },
});
/**
 * The pool keeps the event loop alive, so without this the process stops
 * doing work, says so, and then hangs until the orchestrator sends SIGKILL.
 */
await db.$close();
console.info("[worker] stopped");
