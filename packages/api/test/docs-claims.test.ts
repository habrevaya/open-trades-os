import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../src/mcp/tools";
import { routes } from "../src/contracts";
import { PERMISSIONS } from "@opentradesos/core";

/**
 * THE DOCUMENTATION IS CHECKED AGAINST THE CODE
 *
 * A document asserting a property the code does not have is the second most
 * common defect in this repository, and a module doc is the worst place for
 * it: somebody reads it precisely because they do not yet know what is true.
 *
 * This does not check the prose. It checks the CONCRETE things a reader would
 * copy out of it: tool names they would paste into a client, and the endpoint
 * they would point it at. Those are the sentences that cost an afternoon when
 * they are wrong.
 */
const DOCS = join(__dirname, "../../../docs/modules");
const WEB_APP = join(__dirname, "../../../apps/web/src/app");

const doc = readFileSync(join(DOCS, "m28-developer-agent-platform.md"), "utf8");

/**
 * Every module doc, written, half written or still a template.
 *
 * ALL of them rather than only the finished ones, and the first version of this
 * filtered to the finished ones, which was wrong: M33 and M34 have real prose in
 * their first sections and template comments in the rest, so the half that makes
 * claims was being skipped. A template makes no claims and contributes nothing to
 * these checks anyway, so there is no reason to filter.
 */
function allDocs(): { file: string; text: string }[] {
  return readdirSync(DOCS)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => ({ file, text: readFileSync(join(DOCS, file), "utf8") }));
}

/** A section nobody has filled in yet. Several docs have some of each. */
const TEMPLATE_MARKERS = [
  "<!-- One paragraph a contractor would recognize",
  "<!-- The two or three ideas someone has to hold",
  "<!-- What an admin configures, in order",
  "<!-- Task-oriented. One heading per job to be done. -->",
  "<!-- owner / admin / manager / dispatcher / csr / technician / accountant -->",
  "<!-- Link to the generated reference",
  "<!-- Answer what support would otherwise answer twice a week. -->",
];

/** Every route the app serves, as a matchable pattern. Mirrors apps/web's own test. */
function servedRoutes(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) {
      if (entry === "page.tsx" || entry === "route.ts") found.push(prefix || "/");
      continue;
    }
    const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : `/${entry}`;
    found.push(...servedRoutes(full, prefix + segment));
  }
  return found;
}

describe("the M28 doc describes the MCP server that exists", () => {
  it("names only tools that are really offered", () => {
    const named = [...doc.matchAll(/`(otos_[a-z0-9_]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(2);

    const offered = new Set(allTools().map((t) => t.name));
    const wrong = named.filter((name) => !offered.has(name));
    expect(wrong).toEqual([]);
  });

  it("names a permission that some tool really requires", () => {
    const named = [...doc.matchAll(/`([a-z_]+:[a-z_]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);

    const required = new Set(allTools().flatMap((t) => t.permissions));
    for (const permission of named) expect(required.has(permission)).toBe(true);
  });

  it("gives the endpoint the app actually mounts", () => {
    const route = readFileSync(
      join(__dirname, "../../../apps/web/src/app/api/mcp/route.ts"),
      "utf8",
    );
    expect(doc).toContain("/api/mcp");
    // The file exists at app/api/mcp/route.ts, which is what serves that path.
    expect(route).toContain("handleMcp");
  });

  it("does not claim something is built when the doc's own list says it is not", () => {
    /**
     * The section that keeps this honest. If somebody deletes it while adding
     * a feature list, the doc becomes a brochure.
     */
    expect(doc).toMatch(/## What is not built/);
    expect(doc).toMatch(/status: partial/);
  });
});

/**
 * THE SAME CHECKS, OVER EVERY WRITTEN MODULE DOC
 *
 * The M28 suite above was written when one document made concrete claims. Twenty
 * six others were templates, so there was nothing in them to be wrong about. The
 * moment those are written, each one is a new place for a sentence the code does
 * not support, and a module doc is the worst place for one: somebody reads it
 * precisely because they do not yet know what is true.
 *
 * This checks the things a reader would COPY, which are the sentences that cost an
 * afternoon when they are wrong: a permission they would put on a role, a path
 * they would point a client at, a screen they would go looking for.
 *
 * It deliberately does not check prose. There is no way to test "this paragraph is
 * a fair description", and a test that tried would be a test of wording.
 */
describe("every module doc", () => {
  const written = allDocs();
  const served = [...new Set(servedRoutes(WEB_APP))];
  const apiPaths = new Set(Object.values(routes).map((route) => route.path));
  const permissions = new Set(Object.keys(PERMISSIONS));

  it("has some written docs to check, so a bug here is not silence", () => {
    /**
     * The failure this guards against is the whole suite passing because the
     * filter matched nothing. A guard that cannot tell "all clear" from "I did
     * not look" is the kind this repository has been bitten by before.
     */
    expect(written.length).toBeGreaterThan(0);
    expect(served.length).toBeGreaterThan(20);
    expect(apiPaths.size).toBeGreaterThan(100);
  });

  it("names only permissions that exist", () => {
    /**
     * A permission in a doc is a thing somebody types into a role. One that does
     * not exist is an afternoon spent looking for it, and worse, a role built
     * without the access the doc promised.
     */
    const wrong: string[] = [];
    for (const { file, text } of written) {
      for (const match of text.matchAll(/`([a-z][a-z_]*(?:\.[a-z_]+)?:[a-z_]+)`/g)) {
        const named = match[1]!;
        if (!permissions.has(named)) wrong.push(`${file}: ${named}`);
      }
    }
    expect(wrong, "permissions named in a doc that do not exist").toEqual([]);
  });

  it("names only API paths that are served", () => {
    /**
     * Matched on the literal path as the contract declares it, including its
     * `{braces}`, because that is what a reader copies. A doc writing
     * `/v1/jobs/{jobId}` for a route declared `{id}` is pointing somebody at a
     * 404, which is exactly the class of mistake this catches.
     *
     * The query string is cut off first. `GET /v1/rentals?open=true` is a correct
     * thing to write and a correct thing to copy; the route is `/v1/rentals` and
     * `open` is one of its declared inputs.
     */
    const wrong: string[] = [];
    let checked = 0;
    for (const { file, text } of written) {
      for (const match of text.matchAll(/`(?:GET|POST|PATCH|PUT|DELETE)\s+(\/v1\/[^`\s]+)`/g)) {
        const path = match[1]!.split("?")[0]!;
        checked += 1;
        if (!apiPaths.has(path)) wrong.push(`${file}: ${path}`);
      }
    }
    expect(wrong, "API paths named in a doc that the registry does not serve").toEqual([]);
    /** And it looked at something, so a broken regex is not a pass. */
    expect(checked).toBeGreaterThan(20);
  });

  it("names only screens the web app serves", () => {
    /**
     * A doc that sends somebody to a screen is a doc that can send them to a 404.
     * Written as `` `Settings > Take a copy` `` in prose, so the checkable form is
     * the explicit one: a backticked path beginning with a slash that is not an
     * API path and not a file.
     */
    const matches = (href: string): boolean => {
      const path = href.replace(/\/$/, "") || "/";
      return served.some((route) => {
        const a = route.split("/").filter(Boolean);
        const b = path.split("/").filter(Boolean);
        if (a.length !== b.length) return false;
        return a.every((seg, i) => seg.startsWith("[") || seg === b[i]);
      });
    };

    /**
     * Only paths whose first segment is one the app actually has. A doc writing
     * `` `/swap` `` as shorthand for the end of `POST /v1/rentals/{id}/swap` is
     * not claiming a screen, and the first version of this treated it as one.
     *
     * The cost of that narrowing is real and worth stating: a doc inventing a
     * whole new top level screen, `` `/containers` `` for what is actually
     * `/fleet/containers`, is not caught. What IS caught is the far commoner
     * mistake, a wrong path under a section that exists.
     */
    const topLevel = new Set(served.map((route) => route.split("/")[1]).filter(Boolean));
    const wrong: string[] = [];
    let checked = 0;
    for (const { file, text } of written) {
      for (const match of text.matchAll(/`(\/[a-z0-9][a-z0-9/-]*)`/g)) {
        const href = match[1]!;
        /** API paths are checked above; a path with a dot in it is a file. */
        if (href.startsWith("/v1/") || href.startsWith("/api/") || href.includes(".")) continue;
        if (!topLevel.has(href.split("/")[1] ?? "")) continue;
        checked += 1;
        if (!matches(href)) wrong.push(`${file}: ${href}`);
      }
    }
    expect(wrong, "screens named in a doc that the app does not serve").toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  it("has one top level heading, and the front matter agrees with it", () => {
    /**
     * Structure rather than prose, and it caught a real slip: a doc written with
     * `# What it does` instead of `##` has two top level headings, which in the
     * rendered site makes the second one a page title. Cheap to check and
     * invisible to read, which is the combination worth a test.
     *
     * The title is checked against the front matter too, because the front
     * matter is what the index renders and the heading is what the page shows,
     * and the two disagreeing means somebody renamed a module in one place.
     */
    const wrong: string[] = [];
    for (const { file, text } of written) {
      const h1 = [...text.matchAll(/^# (.+)$/gm)].map((m) => m[1]!.trim());
      if (h1.length !== 1) { wrong.push(`${file}: ${h1.length} top level headings`); continue; }
      const title = /^title: (.+)$/m.exec(text)?.[1]?.trim();
      if (title !== h1[0]) wrong.push(`${file}: front matter "${title}" against heading "${h1[0]}"`);
    }
    expect(wrong, "docs whose headings do not line up").toEqual([]);
  });

  it("names its own module in the front matter", () => {
    /**
     * `m13-...md` has to say `module: M13`. A doc that names another module's
     * number sorts into the wrong place in the index and is cited as the wrong
     * thing from everywhere else.
     */
    const wrong: string[] = [];
    for (const { file, text } of written) {
      const expected = `M${file.slice(1, 3)}`;
      const declared = /^module: (.+)$/m.exec(text)?.[1]?.trim();
      if (declared !== expected) wrong.push(`${file}: says ${declared}, should say ${expected}`);
    }
    expect(wrong, "docs whose module number does not match their filename").toEqual([]);
  });

  it("says what it does not do", () => {
    /**
     * THE HONESTY SECTION, MADE COMPULSORY.
     *
     * Every one of these documents has one, and it is the section that makes the
     * rest of the page trustworthy: a reader who finds the gaps named is a reader
     * who believes the capabilities. A doc written without one reads as a
     * brochure, and the direction of that failure is the bad one.
     *
     * Two spellings are accepted because two were already in use before this was
     * a rule, and renaming a section in thirty four files to satisfy a test is
     * the test deciding the prose.
     */
    const silent = written
      .filter(({ text }) => !/^## (What is not built|Not built)$/m.test(text))
      .map(({ file }) => file);
    expect(silent, "docs that never say what they cannot do").toEqual([]);
  });

  it("does not call a finished doc a stub", () => {
    /**
     * ONE DIRECTION, and the asymmetry is the point.
     *
     * A doc with no template section left in it must not say `status: stub`,
     * because that is a finished document describing itself as unwritten, and
     * anybody reading the index would skip it.
     *
     * The other direction is allowed: M33 and M34 say stub and have real prose in
     * their first sections, which is honest. Half written is closer to stub than
     * to done, and the claims they do make are checked above either way, because
     * these checks read every doc rather than only the finished ones.
     */
    const lying: string[] = [];
    for (const { file, text } of written) {
      if (!/^status: stub$/m.test(text)) continue;
      if (!TEMPLATE_MARKERS.some((marker) => text.includes(marker))) lying.push(file);
    }
    expect(lying, "docs calling themselves a stub with nothing left to fill in").toEqual([]);
  });
});
