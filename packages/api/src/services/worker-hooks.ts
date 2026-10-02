import type { Database } from "@opentradesos/db";
import { SYSTEM_USER_ID } from "@opentradesos/core";
import { flush, providerFor, recoverStuck } from "./comms-outbox";
import { deliver } from "./webhooks";
import { inTenant } from "./context";
import { readerFor } from "../secrets/store";
import { ProviderNotConfiguredError } from "../comms/provider";
import * as accounting from "./accounting";
import { AccountingNotConfiguredError } from "../accounting/provider";
// Registers the carrier adapters. Drop this import and the worker still runs;
// the outbox simply finds no provider and leaves messages queued.
import "../comms";
// Same for the accounting adapters, and for the same reason.
import "../accounting";

/**
 * WHAT HAPPENS AFTER A DRAIN
 *
 * The outbox, webhook delivery and the accounting sync, for each organization
 * a pass found events for. These lived in bin/worker.ts, which was fine while
 * the long running process was the only thing that ran a pass. The
 * serverless tick runs one too, and a second copy of this file inside the web
 * app would have been a tick that drains the log, runs the workflows, and
 * never sends the texts they queued, which looks exactly like working until a
 * customer asks where their reminder went.
 *
 * So both build their hook here, from the database they were given.
 */

export type SecretReader = (ref: string) => Promise<string>;

async function sendQueued(
  db: Database, readSecret: SecretReader | undefined, organizationId: string,
): Promise<void> {
  const provider = await inTenant(
    { actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] }, db },
    /**
     * The carrier credential comes from THIS organization's secrets. The
     * store adds the organization itself, so a connection's credential name
     * can never reach the worker's own environment.
     */
    async (tx) => providerFor(tx, organizationId, readSecret ?? readerFor(tx, organizationId)),
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
async function sendWebhooks(db: Database, organizationId: string): Promise<void> {
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
async function syncAccounting(db: Database, organizationId: string): Promise<void> {
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
export function backgroundHooks(
  db: Database,
  /** For a test. A deployment leaves it out and each organization's own store is read. */
  readSecret?: SecretReader,
): (organizationId: string) => Promise<void> {
  const steps = [
    { name: "sendQueued", run: (org: string) => sendQueued(db, readSecret, org) },
    { name: "sendWebhooks", run: (org: string) => sendWebhooks(db, org) },
    { name: "syncAccounting", run: (org: string) => syncAccounting(db, org) },
  ];
  return async (organizationId: string) => {
    for (const step of steps) {
      try {
        await step.run(organizationId);
      } catch (error) {
        console.error(
          `[worker] ${step.name} failed for ${organizationId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  };
}
