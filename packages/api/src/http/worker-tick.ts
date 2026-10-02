import type { Database } from "@opentradesos/db";
import { runBounded } from "../services/workflow-worker";
import { backgroundHooks } from "../services/worker-hooks";
import { presentsToken } from "./bearer";
import { problem, json } from "./problem";

/**
 * THE WORKER, ONE BOUNDED RUN AT A TIME, OVER HTTP
 *
 * For a host that cannot keep a process alive. Netlify and its peers will
 * call a URL on a schedule and will not run a loop, so the deployment points
 * a scheduled function at this and each call does what one turn of the
 * worker's loop does, until there is nothing left or the budget is spent.
 * The pass is `runPass`, the same function the long running worker calls,
 * and the hooks after it are the same ones, so the two cannot drift.
 *
 * Off unless WORKER_TICK_TOKEN is set, by the same rules as the operator API:
 * at least 32 characters, constant time comparison, the Authorization header
 * and nothing else, and a 404 indistinguishable from any unknown route when
 * it is off. It is a separate token from the operator's on purpose: the
 * thing that wakes the worker every minute lives in a scheduler's config, and
 * should not also be able to suspend a company.
 *
 * WHAT IT CANNOT DO is run longer than the platform allows. The budget is
 * checked between events, never inside one, so the default leaves room under
 * Netlify's sixty seconds for the event in flight and for the outbox, which
 * runs after the drain and is never skipped (see `runPass`).
 */

/** Twenty seconds, which leaves forty under a sixty second function limit. */
export const DEFAULT_TICK_BUDGET_MS = 20_000;

export interface WorkerTickDeps {
  db: Database;
  /** From `configuredToken("WORKER_TICK_TOKEN")`. Null means off. */
  token: string | null | undefined;
  budgetMs?: number | undefined;
  /** Defaults to the same hooks the worker process uses. */
  afterDrain?: ((organizationId: string) => Promise<void>) | undefined;
  /**
   * Only these companies. Never set by the route a deployment mounts, and not
   * readable from the request: it is for a test that shares its database.
   */
  only?: readonly string[] | undefined;
}

export async function handleWorkerTick(request: Request, deps: WorkerTickDeps): Promise<Response> {
  const url = new URL(request.url);
  if (!deps.token) return problem(404, `No route for ${url.pathname}`);

  if (!presentsToken(request, deps.token)) {
    return problem(401, "Worker tick token missing or wrong", {}, {
      "www-authenticate": 'Bearer realm="worker"',
    });
  }
  if (request.method !== "POST") {
    return problem(405, `${request.method} is not allowed on ${url.pathname}`,
      { allowed: ["POST"] }, { allow: "POST" });
  }

  const budgetMs = deps.budgetMs && deps.budgetMs > 0 ? deps.budgetMs : DEFAULT_TICK_BUDGET_MS;
  try {
    const summary = await runBounded({
      db: deps.db,
      budgetMs,
      afterDrain: deps.afterDrain ?? backgroundHooks(deps.db),
      ...(deps.only ? { only: deps.only } : {}),
    });
    if (summary.events > 0) {
      console.info(`[worker tick] ${summary.events} events across ${summary.organizations} organizations`);
    }
    return json({ ...summary, budgetMs }, 200);
  } catch (error) {
    // Nothing about the database goes back to the caller, which is a cron
    // job; the log is where somebody will look.
    console.error("[worker tick] failed:", error instanceof Error ? error.message : error);
    return problem(500, "Worker tick failed");
  }
}
