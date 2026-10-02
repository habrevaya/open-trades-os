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
import { backgroundHooks } from "../services/worker-hooks";
import { secretStore } from "../secrets/store";

// `||`, not `??`: an env file with `WORKER_DATABASE_URL=` and nothing after it sets
// an empty string, and that should mean "unset" rather than "connect to nothing".
const url = process.env["WORKER_DATABASE_URL"] || process.env["DATABASE_URL"];
if (!url) {
  console.error("Set WORKER_DATABASE_URL or DATABASE_URL.");
  process.exit(1);
}

/**
 * The secret store, checked before the first pass rather than at the first
 * text it fails to send: SECRET_STORE=database with no master key, or a
 * malformed one, stops the worker here with the sentence that fixes it.
 */
secretStore();

const db = createClient(url);
const controller = new AbortController();

/**
 * Stop between events rather than mid-event.
 *
 * A worker killed halfway through a step leaves a run marked `running` that
 * nothing will finish. Aborting lets the event in flight complete, and the
 * deployment's own timeout is the backstop if a step hangs.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`[worker] ${signal}, finishing the current event`);
    controller.abort();
  });
}

const interval = Number(process.env["WORKER_INTERVAL_MS"] ?? 5_000);

/**
 * The pass itself is `runPass` in services/workflow-worker.ts, and the hooks
 * after it are in services/worker-hooks.ts. The serverless tick calls the
 * same two, so this file is only the part that is genuinely about being a
 * long running process: signals, an interval, and closing the pool.
 */
console.info(`[worker] draining every ${interval}ms`);
await runWorker({
  db,
  intervalMs: interval,
  signal: controller.signal,
  afterDrain: backgroundHooks(db),
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
