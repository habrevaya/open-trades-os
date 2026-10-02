/**
 * THE WORKER'S CLOCK, ON NETLIFY
 *
 * Netlify runs no long lived processes, so the worker cannot loop. This
 * scheduled function calls the app's own tick endpoint once a minute, and the
 * endpoint runs the worker until there is nothing left or its budget is spent
 * (docs/self-hosting/worker.md, "On a host with no long running processes").
 *
 * It is a thin caller on purpose. The pass, the budget and the token check
 * all live in the app, where they are tested; a scheduled function that ran
 * the worker itself would be a second copy of it, bundled separately, that
 * nothing tests.
 *
 * Needs WORKER_TICK_TOKEN in the site's environment, scoped to Functions,
 * and the same value the app reads. `URL` is set by Netlify: the site's main
 * address. Scheduled functions only run on the published deploy, never on a
 * deploy preview or a branch deploy, which is the right way round: a preview
 * pointed at the production database must not also be running its worker.
 */

/**
 * Scheduled functions get thirty seconds. The tick's default budget is twenty
 * and its outbox runs after that, so this waits a little under the limit and
 * then lets go. Letting go does not stop the tick: it is its own request, with
 * its own sixty seconds, and it finishes what it started.
 */
const WAIT_MS = 28_000;

export default async (): Promise<void> => {
  const base = process.env["URL"];
  const token = process.env["WORKER_TICK_TOKEN"];
  if (!base || !token) {
    console.error("[worker-tick] URL or WORKER_TICK_TOKEN is not set; the worker is not running.");
    return;
  }

  try {
    const response = await fetch(`${base}/api/internal/worker/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(WAIT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      // A 404 here means the app has no WORKER_TICK_TOKEN, or a shorter one
      // than 32 characters. A 401 means the two values differ.
      console.error(`[worker-tick] ${response.status}: ${body}`);
      return;
    }
    console.info(`[worker-tick] ${body}`);
  } catch (error) {
    console.error("[worker-tick] did not answer in time:", error instanceof Error ? error.message : error);
  }
};

/** Every minute, which is the finest a Netlify schedule goes. */
export const config = { schedule: "* * * * *" };
