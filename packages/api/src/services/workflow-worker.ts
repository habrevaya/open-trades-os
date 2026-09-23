import { and, asc, eq, gt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { Actor } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { handleEvent, type RunSummary } from "./workflow-runner";

/**
 * THE WORKER
 *
 * `handleEvent` was written and then called by nothing but its own tests,
 * which is the same defect this codebase keeps finding in itself: a capability
 * that is declared, tested in isolation, and never reached from the outside.
 * Events were being written on every job update and nobody was reading them.
 *
 * What this adds is a position in the log and a loop over it. Deliberately
 * not a queue: the log already is one, it is durable, and a queue alongside it
 * would be a second source of truth about what happened.
 *
 * THE CURSOR IS A POSITION, NOT A LOCK. Two workers running means some events
 * are handled twice, and that is safe because a run is keyed on (version,
 * event) behind a unique index, so the second attempt inserts nothing. Taking
 * a lock instead would trade that harmless duplication for a worker that dies
 * holding one.
 */

const CONSUMER = "workflow";

/**
 * How many events one pass takes from a single organization.
 *
 * Bounded so one tenant with a backlog cannot hold the loop while every other
 * tenant's texts wait. The next pass picks the rest up, and
 * `pending_event_organizations` orders by the oldest unread event, so being
 * behind is what gets you served first.
 */
const BATCH = 100;

export interface DrainResult {
  organizationId: string;
  events: number;
  runs: RunSummary[];
  /** The sequence this pass reached. Unchanged when there was nothing to do. */
  cursor: number;
}

/** The actor a drain uses to enter a tenant. Holds nothing. */
function workerActor(organizationId: string): Actor {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    organizationId,
    roles: [],
    grants: [],
    agentId: "worker",
  };
}

async function cursorFor(tx: Database, organizationId: string): Promise<number> {
  const [row] = await tx.select({ last: schema.eventCursor.lastSequence })
    .from(schema.eventCursor)
    .where(and(
      eq(schema.eventCursor.organizationId, organizationId),
      eq(schema.eventCursor.consumer, CONSUMER),
    ))
    .limit(1);
  return row?.last ?? 0;
}

/**
 * Advance, never rewind.
 *
 * `greatest` rather than an assignment, because two workers finishing out of
 * order would otherwise let the slower one move the cursor backwards and hand
 * the same events out again forever.
 */
export async function advanceCursor(
  ctx: ServiceContext, organizationId: string, to: number,
): Promise<void> {
  await inTenant(ctx, async (tx) => {
    await tx.insert(schema.eventCursor)
      .values({ organizationId, consumer: CONSUMER, lastSequence: to, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.eventCursor.organizationId, schema.eventCursor.consumer],
        set: {
          lastSequence: sql`greatest(${schema.eventCursor.lastSequence}, excluded.last_sequence)`,
          updatedAt: new Date(),
        },
      });
  });
}

/**
 * Handle one organization's unread events, oldest first.
 *
 * Each event is handled in its own transaction, inside `handleEvent`, rather
 * than the whole batch in one. A batch transaction would mean one workflow
 * whose step throws rolls back ninety nine runs that succeeded, and the retry
 * would redo them.
 */
export async function drainOrganization(
  db: Database,
  organizationId: string,
  limit = BATCH,
): Promise<DrainResult> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };

  const events = await inTenant(ctx, async (tx) => {
    const from = await cursorFor(tx, organizationId);
    return tx.select({ id: schema.domainEvent.id, sequence: schema.domainEvent.sequence })
      .from(schema.domainEvent)
      .where(gt(schema.domainEvent.sequence, from))
      .orderBy(asc(schema.domainEvent.sequence))
      .limit(limit);
  });

  const runs: RunSummary[] = [];
  let reached = 0;

  for (const event of events) {
    /**
     * A workflow that throws must not stop the log.
     *
     * One tenant's broken step would otherwise wedge the cursor and every
     * event after it, including events belonging to workflows that work. The
     * run row records the failure either way, which is where an operator
     * looks; the log keeps moving.
     */
    try {
      runs.push(...await handleEvent(ctx, event.id));
    } catch (error) {
      runs.push({
        workflowId: "", runId: null, status: "failed",
        reason: `event ${event.id}: ${(error as Error).message}`, steps: 0,
      });
    }
    reached = event.sequence;
  }

  if (reached > 0) await advanceCursor(ctx, organizationId, reached);

  return { organizationId, events: events.length, runs, cursor: reached };
}

/**
 * One pass over every organization with unread events.
 *
 * Finding them is a cross tenant read, which row level security forbids and
 * should: it goes through `app.pending_event_organizations`, which returns
 * organization ids and nothing else and is not callable by the role the
 * request path uses.
 */
export async function drainAll(db: Database, options: {
  organizations?: number;
  perOrganization?: number;
} = {}): Promise<DrainResult[]> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.pending_event_organizations(
          ${CONSUMER}, ${options.organizations ?? 50})`,
  );

  const results: DrainResult[] = [];
  for (const row of rows) {
    results.push(await drainOrganization(db, row.organization_id, options.perOrganization ?? BATCH));
  }
  return results;
}

/**
 * Run until stopped.
 *
 * A poll rather than a listen, because LISTEN/NOTIFY does not survive a
 * connection drop and a missed notification is a text that never gets sent.
 * Polling a cursor recovers on its own: the worst case of a restart is one
 * interval of latency.
 */
export async function runWorker(options: {
  db: Database;
  intervalMs?: number;
  signal?: AbortSignal;
  onPass?: (results: DrainResult[]) => void;
}): Promise<void> {
  const interval = options.intervalMs ?? 5_000;

  while (!options.signal?.aborted) {
    try {
      const results = await drainAll(options.db);
      options.onPass?.(results);
      /**
       * A pass that did work goes straight round again. A backlog should
       * drain at the speed of the database, not at the speed of the timer.
       */
      if (results.some((r) => r.events > 0)) continue;
    } catch (error) {
      // Logged and retried. A worker that exits on a transient database error
      // stops every automation in the product until somebody notices.
      console.error("[worker] pass failed:", (error as Error).message);
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
