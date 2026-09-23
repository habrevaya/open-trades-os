import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../src/mcp/tools";

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
const doc = readFileSync(
  join(__dirname, "../../../docs/modules/m28-developer-agent-platform.md"),
  "utf8",
);

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
