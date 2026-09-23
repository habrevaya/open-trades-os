import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * THE PARITY DOCUMENT NAMES MODULES THAT EXIST
 *
 * docs/project/servicetitan-parity.md maps every ServiceTitan surface onto a
 * module number, so "will it eventually do X" has an answer rather than a
 * shrug. A document like that becomes a wish list the moment it can name a
 * module nobody ever wrote, and nothing about a markdown table fails a build.
 *
 * The module list is content in the website repository, which is not a
 * dependency of this one, so this checks against the platform's own module
 * documentation instead: docs/modules holds a page per module and is the
 * thing a contributor here actually opens.
 */
const ROOT = join(import.meta.dirname, "../../..");
const PARITY = join(ROOT, "docs/project/servicetitan-parity.md");
const MODULE_DOCS = join(ROOT, "docs/modules");

/** Every module code the parity table points at. */
function cited(): string[] {
  const text = readFileSync(PARITY, "utf8");
  return [...new Set(text.match(/\bM\d\d\b/g) ?? [])].sort();
}

describe("the ServiceTitan parity map", () => {
  it("exists, because the rest of this file is about it", () => {
    expect(existsSync(PARITY)).toBe(true);
  });

  it("cites module codes at all", () => {
    // A table that named none would make the check below pass by having
    // nothing to check, which is how this shape of test usually fails.
    expect(cited().length).toBeGreaterThan(25);
  });

  it("names only modules that have a page", () => {
    /**
     * A surface mapped to a module number nobody wrote is the same as an
     * unmapped surface, except it reads as covered.
     */
    const pages = readFileSync(join(MODULE_DOCS, "README.md"), "utf8");
    const missing = cited().filter((code) => !pages.includes(code));
    expect(missing, "cited in the parity map with no module page").toEqual([]);
  });

  it("accounts for every module, so none is quietly dropped", () => {
    // The other direction. A module that exists and appears nowhere in the
    // map is a surface nobody checked against ServiceTitan at all.
    const pages = readFileSync(join(MODULE_DOCS, "README.md"), "utf8");
    const all = [...new Set(pages.match(/\bM\d\d\b/g) ?? [])];
    const unmapped = all.filter((code) => !cited().includes(code));
    expect(unmapped, "has a module page and is not in the parity map").toEqual([]);
  });
});
