import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NAV } from "../src/lib/nav";

/**
 * EVERY LINK GOES SOMEWHERE
 *
 * `AppShell` filters navigation by permission, with a comment explaining that
 * showing somebody a door they cannot walk through is how a product feels
 * like it is withholding. Six of those doors led nowhere at all: /jobs,
 * /customers, /pricebook, /invoices, /reports and /settings were in the
 * navigation and had no route. The empty state on the home page linked to
 * /customers/new, which did not exist either.
 *
 * A 404 from your own navigation is worse than a missing feature, because the
 * product looks broken rather than unfinished, and nothing in a typecheck or
 * a unit test notices: an href is a string.
 */

const APP = join(import.meta.dirname, "../src/app");

/** Every route this app serves, as a matchable pattern. */
function routes(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) {
      if (entry === "page.tsx" || entry === "route.ts") found.push(prefix || "/");
      continue;
    }
    // (group) folders do not appear in the URL.
    const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : `/${entry}`;
    found.push(...routes(full, prefix + segment));
  }
  return found;
}

const ALL = [...new Set(routes(APP))];

function matches(href: string): boolean {
  const path = href.split(/[?#]/)[0]!.replace(/\/$/, "") || "/";
  return ALL.some((route) => {
    const a = route.split("/").filter(Boolean);
    const b = path.split("/").filter(Boolean);
    if (a.length !== b.length) return false;
    // A [param] or [...catchAll] segment accepts anything.
    return a.every((seg, i) => seg.startsWith("[") || seg === b[i]);
  });
}

/** Every internal href written in a page or component. */
function links(): { file: string; href: string }[] {
  const out: { file: string; href: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry)) continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(/href[=:]\s*"(\/[^"]*)"/g)) {
        out.push({ file: relative(APP, full), href: match[1]! });
      }
      /**
       * Template literals too, with the interpolations stood in for.
       *
       * `href={`/customers/${id}`}` is how nearly every link to a detail page
       * is written, and the first version of this test skipped anything
       * containing `${`, which excluded exactly the links most likely to be
       * pointing at a page nobody has built. It passed while /customers/[id]
       * did not exist.
       */
      for (const match of source.matchAll(/href[=:]\s*\{?`(\/[^`]*)`/g)) {
        out.push({ file: relative(APP, full), href: match[1]!.replace(/\$\{[^}]*\}/g, "x") });
      }
      for (const match of source.matchAll(/redirect\(\s*[`"](\/[^`"?]*)/g)) {
        out.push({ file: relative(APP, full), href: match[1]!.replace(/\$\{[^}]*\}/g, "x") });
      }
    }
  };
  walk(join(import.meta.dirname, "../src"));

  /**
   * The navigation is data rather than markup now, so the href regexes above
   * do not see it. It is the list most likely to get ahead of the routes,
   * which is the failure this test exists for.
   */
  for (const group of NAV) {
    for (const item of group.items) {
      out.push({ file: "lib/nav.ts", href: item.href });
      // Children too. They are the newer half of that list and the half
      // nobody looks at, because a subsection only shows once you are
      // already inside its parent.
      for (const child of item.children ?? []) {
        out.push({ file: "lib/nav.ts", href: child.href });
      }
    }
  }
  return out;
}

describe("internal links", () => {
  it("all resolve to a route that exists", () => {
    const broken = links()
      .filter(({ href }) => !matches(href))
      .map(({ file, href }) => `${file} -> ${href}`);

    expect([...new Set(broken)]).toEqual([]);
  });

  it("finds the routes at all", () => {
    // A resolver that matched nothing would make the test above pass by
    // finding no links, and one that matched everything would make it pass by
    // approving all of them.
    expect(ALL).toContain("/schedule");
    expect(matches("/schedule")).toBe(true);
    expect(matches("/definitely-not-a-route")).toBe(false);
    // And that an interpolated link is actually checked, since skipping those
    // is how the first version of this test passed against six dead routes.
    expect(links().some(({ href }) => /\/customers\/x$/.test(href))).toBe(true);
    // And that the nav's children are in the set being checked at all.
    expect(links().some(({ file, href }) => file === "lib/nav.ts" && href === "/reports/new"))
      .toBe(true);
  });
});
