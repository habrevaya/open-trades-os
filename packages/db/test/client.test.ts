import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";

/**
 * CLOSING THE POOL
 *
 * A pooled connection keeps Node's event loop alive. A long running process
 * that finishes its work and returns therefore does not exit: the worker
 * handled its SIGTERM, stopped cleanly, printed that it had stopped, and then
 * hung until the orchestrator gave up and sent SIGKILL. Measured at ten
 * seconds and still running before this existed, and 106ms after.
 *
 * A graceful shutdown that ends in a kill is not a graceful shutdown, and
 * every deploy pays for it in restart time.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

run("a client", () => {
  it("can be closed, and stops accepting work once it is", async () => {
    const db = createClient(url!);
    expect(await db.execute(sql`select 1 as ok`)).toHaveLength(1);

    await db.$close();

    // The assertion that matters is not that `$close` resolves: it is that
    // the pool is actually gone afterwards. A no-op would resolve too.
    await expect(db.execute(sql`select 1 as ok`)).rejects.toThrow();
  });
});
