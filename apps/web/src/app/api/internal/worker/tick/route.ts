import { handleWorkerTick, configuredToken } from "@opentradesos/api/http";
import { getWorkerDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * THE WORKER, FOR A HOST WITH NO LONG RUNNING PROCESSES
 *
 * `POST /api/internal/worker/tick` runs the worker until there is nothing left
 * to do or WORKER_TICK_BUDGET_MS (twenty seconds by default) is spent, and
 * answers with what it did. A scheduler calls it every minute: the Netlify
 * template in deploy/templates/netlify does exactly that.
 *
 * Off unless WORKER_TICK_TOKEN is set to at least 32 characters, and then
 * only for a request carrying it as a bearer token. Everything else, including
 * the pass itself, lives in @opentradesos/api where a test reaches it.
 */
export async function POST(request: Request): Promise<Response> {
  return handleWorkerTick(request, {
    db: getWorkerDb(),
    token: configuredToken("WORKER_TICK_TOKEN"),
    budgetMs: Number(process.env["WORKER_TICK_BUDGET_MS"]) || undefined,
  });
}

/** Answered by the handler, so a GET gets the same 404 or 401 as anything else. */
export const GET = POST;
