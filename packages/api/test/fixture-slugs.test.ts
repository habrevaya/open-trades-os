import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NO TWO TEST FILES SEED A COMPANY WITH THE SAME SLUG
 *
 * `seedOrg` frees the slug it wants by resetting whatever company holds it,
 * and the owner's address by deleting whoever has it, because a stale row
 * from an older run would otherwise block the insert. Two files asking for
 * the same slug therefore wipe each other: whichever starts second deletes
 * the first one's company and owner mid run. Four pairs did (asset-co,
 * field-co, number-co, report-co), and under the full suite the field tests
 * failed now and then with a technician id from a company that had been
 * replaced under them. Files run in parallel, so the slug has to be unique
 * across files, not within one.
 */
describe("integration fixtures", () => {
  it("seed every company under a slug no other file uses", () => {
    const owners = new Map<string, string[]>();
    for (const file of readdirSync(import.meta.dirname).filter((f) => f.endsWith(".test.ts"))) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const match of source.matchAll(/seedOrg\([^)]*slug:\s*"([^"]+)"/g)) {
        const slug = match[1]!;
        const files = owners.get(slug) ?? [];
        if (!files.includes(file)) files.push(file);
        owners.set(slug, files);
      }
    }
    expect(owners.size).toBeGreaterThan(50);
    const shared = [...owners].filter(([, files]) => files.length > 1).map(([slug, files]) => `${slug}: ${files.join(", ")}`);
    expect(shared).toEqual([]);
  });
});
