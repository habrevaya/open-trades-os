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

console.info(`[worker] draining every ${interval}ms`);
await runWorker({
  db,
  intervalMs: interval,
  signal: controller.signal,
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
