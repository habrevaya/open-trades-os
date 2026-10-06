import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { HYDRATE_AFTER_PARSE_SCRIPT } from "@/lib/hydrate-after-parse";

/**
 * The wait leans on how Next starts React, so Next's own bootstrap is read
 * here: an upgrade that changes it fails this test instead of quietly
 * bringing back error #418 on busy phones.
 */
describe("Next's bootstrap still starts React from the queue's reduce", () => {
  it("runs __next_s through loadScriptsInSequence, which reduces over it", () => {
    const require = createRequire(import.meta.url);
    const nextDir = dirname(require.resolve("next/package.json"));
    const source = readFileSync(join(nextDir, "dist/client/app-bootstrap.js"), "utf8");
    expect(source).toContain("loadScriptsInSequence(self.__next_s");
    expect(source).toMatch(/if \(!scripts \|\| !scripts\.length\)/);
    expect(source).toMatch(/return scripts\.reduce\(/);
  });
});

/** The script run against the few things of a page it touches. */
function page(readyState: "loading" | "interactive", queued?: unknown[]) {
  const listeners: (() => void)[] = [];
  const self: Record<string, unknown> = queued ? { __next_s: queued } : {};
  const document = {
    readyState,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  new Function("self", "document", HYDRATE_AFTER_PARSE_SCRIPT)(self, document);
  const q = self["__next_s"] as unknown[] & { reduce: (...a: unknown[]) => Promise<unknown> };
  return { q, parsed: () => listeners.forEach((fn) => fn()) };
}

/** What Next does with the queue, cut down. */
function bootstrap(q: unknown[] & { reduce: (...a: unknown[]) => Promise<unknown> }, ran: unknown[]) {
  return q.reduce((p: Promise<void>, item: unknown) => p.then(() => { ran.push(item); }), Promise.resolve());
}

describe("starting React once the page is all here", () => {
  it("is never skipped as an empty queue", () => {
    expect(page("loading").q.length).toBeGreaterThan(0);
  });

  it("waits for the page to finish, then runs what Next queued, in order", async () => {
    const { q, parsed } = page("loading", ["first"]);
    q.push("second");
    const ran: unknown[] = [];
    let started = false;
    const done = bootstrap(q, ran).then(() => { started = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toBe(false);
    parsed();
    await done;
    expect(ran).toEqual(["first", "second"]);
  });

  it("goes straight on when the page has already been read", async () => {
    const ran: unknown[] = [];
    await bootstrap(page("interactive").q, ran);
    expect(ran).toEqual([]);
  });
});
