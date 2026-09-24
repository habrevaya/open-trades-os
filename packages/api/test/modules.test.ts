import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { modules } from "@opentradesos/core";
import { routes } from "../src/contracts";

/**
 * A ROUTE'S MODULE CODE IS A CLAIM ABOUT WHERE TO READ ABOUT IT
 *
 * Every route carries one, and it was a free string until the registry
 * existed. The whole commercial contracts surface shipped tagged M12
 * (Projects and Multi-Phase Work) when it is M31, and nothing anywhere would
 * have said so: the code was real, the route worked, and the only symptom
 * was a reader opening the projects page and not finding rate cards.
 *
 * Misfiling is worse than omission. Somebody looking for a feature that is
 * absent asks a question. Somebody looking on the page it should be on and
 * not finding it concludes the product does not do it.
 *
 * The union type now catches a code that is not a module. This file catches
 * the two things a type cannot: a registry that has drifted from the module
 * documentation, and a route pointing at a module with no page to open.
 */
const ROOT = join(import.meta.dirname, "../../..");
const MODULE_DOCS = join(ROOT, "docs/modules");
const PARITY = join(ROOT, "docs/project/servicetitan-parity.md");

/** Every `| M12 Projects and Multi-Phase Work |` row in the module index. */
function documented(): Map<string, string> {
  const text = readFileSync(join(MODULE_DOCS, "README.md"), "utf8");
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\|\s*(M\d\d)\s+([^|]+?)\s*\|/.exec(line);
    if (match) found.set(match[1]!, match[2]!);
  }
  return found;
}

describe("the module registry", () => {
  it("reads the module index at all", () => {
    /**
     * The vacuous case. A parser that matched nothing would make every
     * comparison below pass by having nothing to compare, which is how this
     * shape of test usually fails silently.
     */
    expect(documented().size).toBeGreaterThan(30);
  });

  it("names the same modules the documentation does", () => {
    const docs = documented();
    const missing = [...docs.keys()].filter((code) => !modules.isModuleCode(code));
    const extra = modules.CODES.filter((code) => !docs.has(code));
    expect(missing, "documented and not in the registry").toEqual([]);
    expect(extra, "in the registry and not documented").toEqual([]);
  });

  it("gives each one the title its page gives it", () => {
    /**
     * Titles, not only codes. A registry that agreed on M31 and called it
     * something else would put a wrong name on every API tag in the
     * reference, and the code would still line up.
     */
    const docs = documented();
    const disagree: string[] = [];
    for (const [code, title] of docs) {
      if (!modules.isModuleCode(code)) continue;
      const registered = modules.titleOf(code);
      if (registered !== title) {
        disagree.push(`${code}: docs say "${title}", registry says "${registered}"`);
      }
    }
    expect(disagree).toEqual([]);
  });

  it("has a page on disk for every module", () => {
    const pages = readdirSync(MODULE_DOCS).filter((name) => /^m\d\d-/.test(name));
    const codes = new Set(pages.map((name) => name.slice(0, 3).toUpperCase()));
    const pageless = modules.CODES.filter((code) => !codes.has(code));
    expect(pageless, "in the registry with no page to open").toEqual([]);
  });

  it("appears in the parity map, so no module escapes the comparison", () => {
    /**
     * The parity map is where somebody asks "will it do X". A module absent
     * from it is a surface nobody ever checked against ServiceTitan, which
     * is the opposite of the claim that document makes.
     */
    const text = readFileSync(PARITY, "utf8");
    const uncited = modules.CODES.filter((code) => !text.includes(code));
    expect(uncited, "a module the parity map never mentions").toEqual([]);
  });
});

describe("every route's module", () => {
  const tagged = Object.values(routes).map((route) => ({
    id: `${route.method.toUpperCase()} ${route.path}`,
    module: route.module,
  }));

  it("covers every route, since an untagged one would pass everything below", () => {
    expect(tagged.length).toBeGreaterThan(100);
    expect(tagged.filter((r) => !r.module)).toEqual([]);
  });

  it("points at a module that exists", () => {
    const bad = tagged.filter((r) => !modules.isModuleCode(r.module));
    expect(bad.map((r) => `${r.id} -> ${r.module}`)).toEqual([]);
  });

  it("points at a module with a page a reader can open", () => {
    const missing = [...new Set(tagged.map((r) => r.module))]
      .filter((code) => !existsSync(join(MODULE_DOCS, pageFor(code))));
    expect(missing, "routes filed under a module with no page").toEqual([]);
  });
});

/** `M31` to `m31-commercial-parties-contracts.md`, by prefix rather than by guessing the slug. */
function pageFor(code: string): string {
  const prefix = code.toLowerCase();
  return readdirSync(MODULE_DOCS).find((name) => name.startsWith(`${prefix}-`)) ?? `${prefix}-missing.md`;
}
