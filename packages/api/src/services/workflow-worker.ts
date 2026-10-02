import { and, asc, eq, gt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { handleEvent, type RunSummary } from "./workflow-runner";
import { tick, resumeDue } from "./workflow-schedule";
import { sweep } from "./workflow-dwell";

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
    userId: SYSTEM_USER_ID,
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
  shouldStop?: () => boolean,
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

  let handled = 0;
  for (const event of events) {
    /**
     * Out of time, between events. The cursor below only moves to the last
     * event actually handled, so the rest are still unread for the next pass.
     */
    if (shouldStop?.()) break;
    handled += 1;
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

  return { organizationId, events: handled, runs, cursor: reached };
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
  shouldStop?: () => boolean;
  /**
   * Only these companies, still discovered rather than assumed: the ones
   * named that have nothing unread are skipped exactly as they would be in a
   * full pass. The worker never sets it. It is for a pass that must not touch
   * tenants it was not asked about, which in practice is a test sharing its
   * database with every other test file.
   */
  only?: readonly string[];
} = {}): Promise<DrainResult[]> {
  const only = options.only ? sql`${`{${options.only.join(",")}}`}::uuid[]` : sql`null::uuid[]`;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.pending_event_organizations(
          ${CONSUMER}, ${options.organizations ?? 50}, ${only})`,
  );

  const results: DrainResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    results.push(await drainOrganization(
      db, row.organization_id, options.perOrganization ?? BATCH, options.shouldStop,
    ));
  }
  return results;
}

export interface PassOptions {
  db: Database;
  /**
   * Whether this pass also drives the clock.
   *
   * On by default, and the same pass rather than a second process, because a
   * scheduled workflow is a workflow: it queues messages into the same outbox
   * and writes into the same event log. A deployment that wants the clock
   * somewhere else turns it off here.
   */
  schedules?: boolean;
  /**
   * Runs after each drain, for the organizations that had events.
   *
   * The outbox is separate from the runner on purpose: a workflow queues a
   * message and stops, and something else hands it to a carrier. Passed in
   * rather than imported so a deployment with no messaging provider runs the
   * same worker with nothing to configure, and so the worker does not depend
   * on a carrier adapter to start. `backgroundHooks` in worker-hooks.ts is
   * the one both the process and the tick pass.
   */
  afterDrain?: (organizationId: string) => Promise<void>;
  /**
   * Asked between items (between events, schedules, parked runs and
   * organizations) and never in the middle of one. When it answers true the
   * pass stops where it is, and everything it did not reach is still due for
   * the next one: the cursor moves only past events that were handled, and
   * a schedule or a parked run keeps its due time until it is claimed.
   *
   * It is how the loop below stops on SIGTERM without abandoning a run with a
   * row saying it is still running, and how the tick stops inside a hosting
   * platform's time limit.
   */
  shouldStop?: () => boolean;
}

/**
 * ONE PASS: the clock, then the log, then whatever the drain left to send.
 *
 * The long running process and the serverless tick both call this and nothing
 * else, so the two cannot disagree about what a pass is. They differ only in
 * what surrounds it: the process goes round forever with a sleep when there
 * was nothing to do, the tick goes round until its time budget is spent.
 */
export async function runPass(options: PassOptions): Promise<DrainResult[]> {
  const stop = options.shouldStop;

  /**
   * The clock first, so anything it fires is in the log before this pass
   * reads it and goes out on the same pass rather than the next.
   */
  if (options.schedules !== false) {
    try {
      await tick(options.db, stop ? { shouldStop: stop } : {});
      // And the runs that are partway through one, waiting on a clock.
      await resumeDue(options.db, stop ? { shouldStop: stop } : {});
      // And the records that have been sitting there too long.
      await sweep(options.db, stop ? { shouldStop: stop } : {});
    } catch (error) {
      // Logged and retried on the next pass. A worker that exits here stops
      // every automation in the product.
      console.error("[worker] schedules:", (error as Error).message);
    }
  }

  const results = await drainAll(options.db, stop ? { shouldStop: stop } : {});

  /**
   * NOT cut short by `shouldStop`. The drain for these organizations has
   * already happened, and this hook only runs for organizations that had
   * events, so skipping it would leave a text a workflow just queued sitting
   * in the outbox until that company happens to produce another event, which
   * on a quiet afternoon is hours. The budget is set with room for it.
   */
  for (const result of results) {
    if (result.events === 0) continue;
    try {
      await options.afterDrain?.(result.organizationId);
    } catch (error) {
      // One organization's carrier being down must not stop the loop for
      // everybody else. The messages stay queued and go on the next pass.
      console.error(`[worker] outbox ${result.organizationId}:`, (error as Error).message);
    }
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
export async function runWorker(options: Omit<PassOptions, "shouldStop"> & {
  intervalMs?: number;
  signal?: AbortSignal;
  onPass?: (results: DrainResult[]) => void;
}): Promise<void> {
  const interval = options.intervalMs ?? 5_000;
  const { intervalMs: _i, signal, onPass: _o, ...pass } = options;

  while (!signal?.aborted) {
    try {
      const results = await runPass({ ...pass, shouldStop: () => signal?.aborted ?? false });
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
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

export interface TickSummary {
  passes: number;
  events: number;
  organizations: number;
  /** True when the budget ran out with work possibly still due. */
  stoppedForBudget: boolean;
  durationMs: number;
}

/**
 * A BOUNDED RUN, for a host with no long running processes.
 *
 * Netlify, and serverless hosting generally, can call a URL on a schedule and
 * cannot keep a loop alive. This is the loop's body with a deadline instead
 * of a signal: passes, back to back while the last one found events, until
 * there is nothing to do or the budget is spent. The budget is checked
 * between events, so the time limit it protects against is the platform's
 * and not a half handled event.
 *
 * Several of these overlapping, or one overlapping a worker process, is safe
 * for the same reasons two workers are: see "Running more than one" in
 * docs/self-hosting/worker.md.
 */
export async function runBounded(options: Omit<PassOptions, "shouldStop"> & {
  budgetMs: number;
  now?: () => number;
}): Promise<TickSummary> {
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + options.budgetMs;
  const shouldStop = () => now() >= deadline;
  const { budgetMs: _b, now: _n, ...pass } = options;

  const organizations = new Set<string>();
  let passes = 0;
  let events = 0;

  for (;;) {
    const results = await runPass({ ...pass, shouldStop });
    passes += 1;
    const handled = results.reduce((n, r) => n + r.events, 0);
    events += handled;
    for (const r of results) if (r.events > 0) organizations.add(r.organizationId);
    if (handled === 0 || shouldStop()) break;
  }

  return {
    passes,
    events,
    organizations: organizations.size,
    stoppedForBudget: shouldStop(),
    durationMs: now() - started,
  };
}
