import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * EVERY SOURCE FILE IS ACTUALLY IN THE REPOSITORY
 *
 * `.gitignore` had a bare `coverage/`, meant for test coverage reports. It
 * matches a directory of that name at ANY depth, so when a module called
 * coverage was written under packages/core/src it was silently not committed.
 *
 * Nothing noticed. Typecheck, lint, every test and the build all passed,
 * because the files were on disk. `git add -A` said nothing, because adding
 * an ignored file is not an error. `git ls-files --others --exclude-standard`
 * said nothing either, because that is what excluding standard ignores means.
 * Two commits later CI failed on "Does the file exist?" and the answer was
 * yes, locally, for the only person who could see it.
 *
 * So this asks git directly. It is the one question a file on disk cannot
 * answer about itself.
 */
const ROOT = join(import.meta.dirname, "../../..");

/** Every source file that ought to be committed. */
function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(ts|tsx|sql|css|json)$/.test(entry)) found.push(relative(ROOT, full));
    }
  };
  for (const area of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, area))) {
      const src = join(ROOT, area, pkg, "src");
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src */ }
    }
  }
  return found;
}

describe("the working tree and the repository agree", () => {
  it("finds source files at all", () => {
    // A walker that found none would make the check below pass by having
    // nothing to check, which is how this shape of test usually fails.
    expect(sources().length).toBeGreaterThan(50);
  });

  it("has nothing under src that git is ignoring", () => {
    const files = sources();
    /**
     * `--no-index`, which is the difference between a test and a shape that
     * looks like one. Without it `git check-ignore` skips anything already
     * tracked, so the guard only sees a file that has never been committed,
     * and a pattern that would swallow a module somebody commits tomorrow
     * reports nothing today.
     *
     * It exits 1 when nothing matches, which is the success case here, so a
     * non-zero exit is not an error to throw on.
     */
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
        cwd: ROOT, input: files.join("\n"), encoding: "utf8",
      });
    } catch (error) {
      const result = error as { status?: number; stdout?: string };
      if (result.status !== 1) throw error;
      ignored = result.stdout ?? "";
    }

    expect(
      ignored.split("\n").filter(Boolean),
      "these source files are gitignored and will not reach CI",
    ).toEqual([]);
  });
});
