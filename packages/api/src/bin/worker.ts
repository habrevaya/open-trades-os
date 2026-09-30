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
import { SYSTEM_USER_ID } from "@opentradesos/core";
import { runWorker } from "../services/workflow-worker";
import { flush, providerFor, recoverStuck } from "../services/comms-outbox";
import { deliver } from "../services/webhooks";
import { inTenant } from "../services/context";
import { ProviderNotConfiguredError } from "../comms/provider";
import * as accounting from "../services/accounting";
import { AccountingNotConfiguredError } from "../accounting/provider";
// Registers the carrier adapters. Drop this import and the worker still runs;
// the outbox simply finds no provider and leaves messages queued.
import "../comms";
// Same for the accounting adapters, and for the same reason.
import "../accounting";

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
    { actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] }, db },
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

/**
 * Push this tenant's new events at the URLs they registered.
 *
 * Same hook as the outbox and for the same reason: `afterDrain` fires for
 * each organization that had events, which is exactly the set with something
 * to deliver. Polling every tenant on a timer would do the same work and be
 * wrong about which ones need it.
 */
async function sendWebhooks(organizationId: string): Promise<void> {
  const pass = await deliver(db, organizationId);
  const failed = pass.attempts.filter((attempt) => !attempt.ok);
  if (failed.length > 0) {
    console.warn(
      `[worker] ${failed.length} webhook deliveries failed for ${organizationId}: `
      + failed.map((attempt) => `${attempt.eventName} -> ${attempt.endpointId}`).join(", "),
    );
  }
}

/**
 * Push this tenant's invoices and payments into its books, and read back what
 * moved over there.
 *
 * Hooked here rather than on a timer of its own, for the same reason as the
 * outbox: `afterDrain` fires for the organizations that had events, which is
 * exactly the set with something new to send. A company with a quiet day
 * costs nothing, and that matters more here than anywhere else in this file
 * because the accounting API is METERED ON READS and refuses the overage with
 * a 429. A poll would spend the budget on organizations with nothing to sync.
 *
 * A pass that cannot read is not a failure. `sync` records
 * `read_budget_exhausted` on the run, keeps the cursor where it was, and
 * still pushes, because the outbound half needs no reads at all.
 */
async function syncAccounting(organizationId: string): Promise<void> {
  const ctx = { actor: accounting.syncActor(organizationId), db };

  const resolved = await accounting.resolveProvider(ctx).catch((error: unknown) => {
    // No books connected is an ordinary state, exactly like no carrier.
    if (error instanceof AccountingNotConfiguredError) return null;
    throw error;
  });
  if (!resolved) return;

  const outcome = await accounting.sync(ctx, { provider: resolved.provider });

  if (outcome.error) {
    console.error(`[worker] accounting sync for ${organizationId}: ${outcome.error}`);
  }
  if (outcome.blockedReason) {
    console.warn(
      `[worker] accounting reads are spent for ${organizationId}; `
      + `${outcome.pushed} documents still went out and the cursor is held.`,
    );
  }
}

/**
 * BOTH RUN, AND NEITHER CAN STOP THE OTHER.
 *
 * `afterDrain` is awaited inside the worker's pass, so a throw from any of
 * these ends the pass and every tenant behind this one in it waits for the
 * next tick. A carrier outage should not hold up webhooks, a receiver's
 * expired certificate should not hold up text messages, and an accounting
 * connection that needs reauthorising should not hold up either, nor should
 * any of them stall a third company with nothing wrong with it at all.
 *
 * Logged rather than swallowed. A background failure nobody prints is the
 * same as one that did not happen until somebody asks why their integration
 * is quiet, and by then there is nothing to read.
 */
async function afterDrain(organizationId: string): Promise<void> {
  for (const step of [sendQueued, sendWebhooks, syncAccounting]) {
    try {
      await step(organizationId);
    } catch (error) {
      console.error(
        `[worker] ${step.name} failed for ${organizationId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

console.info(`[worker] draining every ${interval}ms`);
await runWorker({
  db,
  intervalMs: interval,
  signal: controller.signal,
  afterDrain,
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
