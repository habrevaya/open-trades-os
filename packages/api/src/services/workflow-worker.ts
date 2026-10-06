import { and, asc, eq, gt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import { handleEvent, type RunSummary } from "./workflow-runner";
import { tick, resumeDue } from "./workflow-schedule";
import { sweep } from "./workflow-dwell";
import { clockPass } from "./contract-clocks";
import { geocodePending, type GeocodeDeps } from "./geocoding";
import { adsPass } from "./ads";
import type { AdsDeps } from "./ad-platforms";
import { mailPass, type MailDeps } from "./direct-mail";
import { deliverDue } from "./delivery-schedules";
import { agentPass } from "./agent-worker";
import { renewalsPass } from "./agreements";
import { sendDue } from "./campaigns";
import { taskPass } from "./task-rules";
import { expiryPass } from "./estimate-expiry";
import { purgePass } from "./retention";
import { deliverOwed, type Transport } from "./webhooks";
import { pushPass } from "./push";
import { purgePositions } from "./location";
import { purgeUnusedClients } from "./oauth";
import { collectionsPass } from "./rental-billing";
import { autopayPass } from "./card-on-file";
import type { PaymentDeps } from "./payments";
import { startBackups } from "./backups";
import { sweepPass } from "./file-storage";
import type { PushProvider } from "../push/provider";

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
} = {}): Promise<DrainResult[]> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.pending_event_organizations(
          ${CONSUMER}, ${options.organizations ?? 50})`,
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
   * The AI agents' own pass, inside the clock. On by default; a deployment
   * that wants no agent to run in the background turns it off here, and an
   * agent nobody turned on costs a single read either way.
   */
  agents?: boolean;
  /**
   * Whether this pass also puts a few addresses on the map, and with what.
   *
   * On by default, for companies that have connected a geocoder and nobody
   * else, and bounded by its own small time budget so a backfill of a large
   * customer list against a one-request-a-second service never holds up a
   * text. `false` turns it off; an object passes the geocoder's dependencies,
   * which is how a test supplies a fake one.
   */
  geocoding?: false | { deps?: GeocodeDeps; budgetMs?: number };
  /**
   * Whether this pass also visits the connected ad platforms, analytics and
   * review listings: spend every six hours, Local Services leads every ten
   * minutes, reviews hourly, conversions every quarter hour, each by its own
   * clock. On by default, for companies with one connected and nobody else.
   * `false` turns it off; an object passes the platforms' dependencies, which
   * is how a test supplies fakes.
   */
  ads?: false | { deps?: AdsDeps };
  /** Mailings left half sent, finished a batch at a time. False turns it off; deps point it at a fake mail house. */
  mail?: false | { deps?: MailDeps };
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
  /**
   * Whether this pass also delivers the webhooks owed in companies that had
   * no events: replays somebody asked for and retries a receiver is waiting
   * on. On by default; `false` turns it off, and an object passes the
   * transport, which is how a test keeps it off the network.
   */
  webhooks?: false | { send?: Transport };
  /**
   * Whether this pass also tells technicians' phones about changes to their
   * day. On by default, through Expo's push service; `false` turns it off,
   * and an object passes the provider, which is how a test keeps it off the
   * network.
   */
  push?: false | { provider?: PushProvider };
  /**
   * Whether this pass also deletes technicians' positions past their
   * company's retention, and drive times past their provider's expiry. At
   * most every ten minutes, because nothing about a three day retention
   * needs a delete every five seconds.
   */
  positions?: false;
  /**
   * Whether this pass also removes OAuth client registrations no company ever
   * approved, a week after they were made. At most hourly; `false` turns it
   * off.
   */
  oauthClients?: false;
  /**
   * Whether this pass also charges the bills of customers who pay
   * automatically, and follows up charges to saved cards. On by default, at
   * most once a minute; `false` turns it off, and an object passes the
   * processor, which is how a test keeps it off the network.
   */
  autopay?: false | { deps?: PaymentDeps };
  /**
   * Scheduled copies to each company's bucket. Started beside the pass rather
   * than inside it, because writing out a large company takes minutes and a
   * text waiting behind it must not. `false` in tests that are about something
   * else.
   */
  backups?: false;
}

let positionsPurgedAt = 0;
let filesSweptAt = 0;
const FILE_SWEEP_INTERVAL_MS = 10 * 60_000;
const POSITION_PURGE_INTERVAL_MS = 10 * 60_000;
let clientsPurgedAt = 0;
const CLIENT_PURGE_INTERVAL_MS = 60 * 60_000;

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
  /**
   * Companies whose scheduled reports, statements or campaign batches went into
   * the outbox on this pass. None of those writes an event, so a company whose
   * only activity was one of them has nothing in the drain results, and without
   * this its messages would sit queued until it next did something else.
   */
  const delivered = new Set<string>();

  if (options.schedules !== false) {
    try {
      await tick(options.db, stop ? { shouldStop: stop } : {});
      // And the runs that are partway through one, waiting on a clock.
      await resumeDue(options.db, stop ? { shouldStop: stop } : {});
      // And the records that have been sitting there too long.
      await sweep(options.db, stop ? { shouldStop: stop } : {});
      /**
       * And the agreements whose term is ending: renewed when the plan and the
       * member both said so, lapsed when they did not, and told beforehand
       * when the plan owes a notice. On the clock rather than on an event,
       * because the end of a term is a date arriving rather than anything
       * somebody did. Its texts go into the outbox like a workflow's, and each
       * renewal and notice writes an event, so the drain below sends them on
       * this pass.
       */
      await renewalsPass(options.db, stop ? { shouldStop: stop } : {});
      /**
       * And the campaign sends that are due: a scheduled one whose time has
       * come, or a staged one with a new day of its carrier's cap. Before the
       * drain, like the schedules, so the texts it queues leave on this pass.
       */
      for (const due of await sendDue(options.db, stop ? { shouldStop: stop } : {})) {
        if (due.action === "sent") delivered.add(due.organizationId);
      }
    } catch (error) {
      // Logged and retried on the next pass. A worker that exits here stops
      // every automation in the product.
      console.error("[worker] schedules:", (error as Error).message);
    }
    /**
     * The office queue's own clock: recurring tasks raised for the company's
     * day, and late tasks escalated. Its own try, so a broken template cannot
     * hold up a scheduled workflow or the other way round, and each company's
     * failure inside it is kept to that company. Both halves are idempotent on
     * a unique index, so a pass cut short and repeated raises and tells once.
     */
    try {
      for (const result of await taskPass(options.db, stop ? { shouldStop: stop } : {})) {
        if (result.escalated.length > 0) delivered.add(result.organizationId);
        for (const failure of result.failed) console.error(`[worker] tasks ${result.organizationId}: ${failure}`);
      }
    } catch (error) {
      console.error("[worker] tasks:", (error as Error).message);
    }
    /**
     * Estimates past their date, marked expired in each company's own
     * calendar. Its own try, for the reason the task pass has one. A pass
     * that has nothing to do is one cheap read, once a minute, and the unsold list and the
     * estimate screens read the date themselves, so nothing waits on it.
     */
    try {
      for (const result of await expiryPass(options.db, stop ? { shouldStop: stop } : {})) {
        if (result.failed) console.error(`[worker] estimate expiry ${result.organizationId}: ${result.failed}`);
      }
    } catch (error) {
      console.error("[worker] estimate expiry:", (error as Error).message);
    }
    /**
     * Contract clocks: SLA, invoicing and claim deadlines reconciled against
     * what has happened, and a task raised for any about to breach. Its own
     * try, for the reason the task pass has one. The tasks it raises go to
     * the queue, where the task pass above escalates them if nobody acts.
     */
    try {
      for (const result of await clockPass(options.db, stop ? { shouldStop: stop } : {})) {
        if (result.failed) console.error(`[worker] contract clocks ${result.organizationId}: ${result.failed}`);
      }
    } catch (error) {
      console.error("[worker] contract clocks:", (error as Error).message);
    }
    /**
     * Records past their retention, for the companies that switched purging
     * on for a rule, once a day each. Its own try, because a purge that
     * fails must not hold up anything else, and nothing else may hold it up
     * either: a hold placed this morning is read by this pass, not cached.
     */
    try {
      for (const result of await purgePass(options.db, stop ? { shouldStop: stop } : {})) {
        if (result.error) console.error(`[worker] retention ${result.organizationId}: ${result.error}`);
        else if (result.run && result.run.failed > 0) {
          console.warn(`[worker] retention ${result.organizationId}: ${result.run.failed} records could not be removed; the reasons are on the pass.`);
        }
      }
    } catch (error) {
      console.error("[worker] retention:", (error as Error).message);
    }
    /**
     * Containers due back, booked on the board as collections at the time
     * agreed with the customer or on the day the price runs out, for each
     * company that has not turned it off. Its own try, and each company's
     * failure is kept to that company: a hire not booked this pass is booked
     * on the next, and one already booked is never booked twice.
     */
    try {
      for (const result of await collectionsPass(options.db, stop ? { shouldStop: stop } : {})) {
        if (result.error) console.error(`[worker] collections ${result.organizationId}: ${result.error}`);
      }
    } catch (error) {
      console.error("[worker] collections:", (error as Error).message);
    }
    /**
     * Bills charged to the saved card of a customer who pays automatically,
     * the one next day try of a declined one, and charges the processor has
     * answered since. Its own try, and each company's failure is kept to
     * that company: an invoice is charged once whatever the worker does,
     * because the charge is keyed on it under a unique index.
     */
    if (options.autopay !== false) {
      try {
        for (const result of await autopayPass(options.db, {
          ...(stop ? { shouldStop: stop } : {}),
          ...(options.autopay?.deps ? { deps: options.autopay.deps } : {}),
        })) {
          if (result.error) console.error(`[worker] automatic payments ${result.organizationId}: ${result.error}`);
          if (result.failed > 0) delivered.add(result.organizationId);
        }
      } catch (error) {
        console.error("[worker] automatic payments:", (error as Error).message);
      }
    }
    /**
     * Reports and statements on a clock. Its own try, so a broken workflow
     * schedule cannot hold up the Monday reports, and the other way round.
     */
    try {
      for (const tick of await deliverDue(options.db, stop ? { shouldStop: stop } : {})) {
        if (tick.queued) delivered.add(tick.organizationId);
      }
    } catch (error) {
      console.error("[worker] deliveries:", (error as Error).message);
    }
    /**
     * The AI agents a company left running on their own (intake, text chat,
     * collections). Its own try, and each company's failure is kept to that
     * company inside it. A reply or reminder it queued goes out on this pass.
     */
    if (options.agents !== false) {
      try {
        for (const result of await agentPass(options.db, stop ? { shouldStop: stop } : {})) {
          if (result.queued) delivered.add(result.organizationId);
          for (const failure of result.failed) console.error(`[worker] agents ${result.organizationId}: ${failure}`);
        }
      } catch (error) {
        console.error("[worker] agents:", (error as Error).message);
      }
    }
  }

  /**
   * Where technicians were, deleted on time. Its own try, like everything
   * here: a purge that fails is tried again on a later pass, and must not
   * hold up a text. A worker that has not purged recently (a restart) purges
   * on its first pass.
   */
  if (options.positions !== false && Date.now() - positionsPurgedAt >= POSITION_PURGE_INTERVAL_MS) {
    try {
      await purgePositions(options.db);
      positionsPurgedAt = Date.now();
    } catch (error) {
      console.error("[worker] positions:", (error as Error).message);
    }
  }

  /**
   * Registrations by MCP clients that no company went on to approve. Its own
   * try and its own clock, like the positions: nothing about a week old
   * registration is urgent, and nothing else may wait on it.
   */
  if (options.oauthClients !== false && Date.now() - clientsPurgedAt >= CLIENT_PURGE_INTERVAL_MS) {
    try {
      await purgeUnusedClients(options.db);
      clientsPurgedAt = Date.now();
    } catch (error) {
      console.error("[worker] oauth registrations:", (error as Error).message);
    }
  }

  /**
   * Addresses, before the log, on a budget of their own. Not inside the
   * schedules block above: a geocoder that is down must not be the reason a
   * scheduled workflow is late, and the same try for both would make it so.
   */
  if (options.geocoding !== false) {
    try {
      const geocoding = options.geocoding ?? {};
      await geocodePending(options.db, {
        ...(stop ? { shouldStop: stop } : {}),
        ...(geocoding.deps ? { deps: geocoding.deps } : {}),
        ...(geocoding.budgetMs !== undefined ? { budgetMs: geocoding.budgetMs } : {}),
      });
    } catch (error) {
      console.error("[worker] geocoding:", (error as Error).message);
    }
  }

  /**
   * The ad platforms, before the log for the same reason: a pull that books a
   * Local Services lead writes its touch now and the drain carries it. Its
   * own try, because Google being down must not hold up a text.
   */
  if (options.ads !== false) {
    try {
      await adsPass(options.db, {
        ...(stop ? { shouldStop: stop } : {}),
        ...(options.ads?.deps ? { deps: options.ads.deps } : {}),
      });
    } catch (error) {
      console.error("[worker] ad platforms:", (error as Error).message);
    }
  }

  /**
   * Mailings larger than one send's batch, a batch per company per pass. Its
   * own try, because a mail house that is down must not hold up a text.
   */
  if (options.mail !== false) {
    try {
      await mailPass(options.db, {
        ...(stop ? { shouldStop: stop } : {}),
        ...(options.mail?.deps ? { deps: options.mail.deps } : {}),
      });
    } catch (error) {
      console.error("[worker] direct mail:", (error as Error).message);
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
  const sending = new Set([
    ...results.filter((result) => result.events > 0).map((result) => result.organizationId),
    ...delivered,
  ]);
  for (const organizationId of sending) {
    try {
      await options.afterDrain?.(organizationId);
    } catch (error) {
      // One organization's carrier being down must not stop the loop for
      // everybody else. The messages stay queued and go on the next pass.
      console.error(`[worker] outbox ${organizationId}:`, (error as Error).message);
    }
  }

  /**
   * Phones, after the drain, so a change the board made a moment ago is in
   * the log by now and goes out on this pass. Its own try, like everything
   * else here: a push service that is down must not hold up a webhook, and
   * the notices it could not send are tried again next pass.
   */
  if (options.push !== false) {
    try {
      await pushPass(options.db, {
        ...(stop ? { shouldStop: stop } : {}),
        ...(options.push?.provider ? { provider: options.push.provider } : {}),
      });
    } catch (error) {
      console.error("[worker] push:", (error as Error).message);
    }
  }

  /**
   * Webhooks owed where nothing happened this pass. After the hook above, so
   * a company that did have events is delivered to once, by it, and skipped
   * here.
   */
  if (options.webhooks !== false) {
    try {
      await deliverOwed(options.db, {
        /** Only when the hook ran: without one, nobody has delivered to them yet. */
        skip: options.afterDrain ? sending : new Set(),
        ...(stop ? { shouldStop: stop } : {}),
        ...(options.webhooks?.send ? { send: options.webhooks.send } : {}),
      });
    } catch (error) {
      console.error("[worker] webhooks:", (error as Error).message);
    }
  }

  /**
   * Copies due to buckets, and the objects of removed files still to delete.
   * Both their own try: a bucket that is down must not hold up anything else,
   * and both are picked up again on a later pass.
   */
  if (options.backups !== false) startBackups(options.db);
  if (Date.now() - filesSweptAt >= FILE_SWEEP_INTERVAL_MS) {
    try {
      await sweepPass(options.db);
      filesSweptAt = Date.now();
    } catch (error) {
      console.error("[worker] file sweep:", (error as Error).message);
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
