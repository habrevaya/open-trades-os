import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ONE POOL, NOT ONE PER REQUEST
 *
 * `createClient` opens ten connections every time it is called. That is right
 * for a migration or a test that wants isolation, and catastrophic on a
 * request path: Postgres starts refusing with "sorry, too many clients
 * already" from pages that have nothing to do with connections, which reads
 * as a database problem rather than a client one.
 *
 * lib/db.ts exists to prevent exactly this and carries a comment saying so.
 * It was called directly six times anyway: in session resolution, which runs
 * on every authenticated request, and in the sign in, sign up and setup
 * actions, which are the highest traffic paths in the product. One of those
 * six was added two lines from the comment explaining why not to.
 *
 * A comment is not a guard. This is.
 */
const SRC = join(import.meta.dirname, "../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walk(full)); continue; }
    if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the database pool", () => {
  it("is opened in one place and reused everywhere else", () => {
    const offenders = walk(SRC)
      // The one file allowed to call it. That is what it is for.
      .filter((file) => !file.endsWith("src/lib/db.ts"))
      .filter((file) => /createClient\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));

    expect(offenders, "opens its own connection pool instead of using getDb()").toEqual([]);
  });

  it("finds the files at all", () => {
    // A walk that returned nothing would make the check above pass by having
    // nothing to check.
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("src/lib/db.ts"))).toBe(true);
  });
});
