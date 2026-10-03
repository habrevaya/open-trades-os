import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { MemoryStorage, WebStorage, SqlStorage, FieldQueue, type Storage, type SqlDriver } from "../src/index";

/**
 * Node's own SQLite, behind the driver the phone app's expo-sqlite adapter
 * implements. Loaded through require because the bundler under vitest does
 * not yet list `node:sqlite` among Node's built in modules.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function nodeSqlite(): SqlDriver {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params) { db.prepare(sql).run(...params); },
    async all<T>(sql: string, params: Array<string | number | null>) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

/**
 * ONE SUITE, EVERY BACKEND
 *
 * The queue is written against an interface, so a new backend, AsyncStorage on
 * a phone, SQLite, whatever comes next, is correct exactly when it passes
 * this. Writing a separate suite per backend is how two of them end up with
 * different behaviour on the case nobody thought to repeat, and the case
 * nobody thinks to repeat is always the ordering one.
 */

/** Enough of the DOM API for WebStorage, which is all it touches. */
function fakeWindow() {
  const data = new Map<string, string>();
  return {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() { return data.size; },
    },
  };
}

const BACKENDS: Array<{ name: string; make: () => Storage }> = [
  { name: "memory", make: () => new MemoryStorage() },
  {
    name: "web",
    make: () => {
      (globalThis as unknown as { window: unknown }).window = fakeWindow();
      return new WebStorage("otos:");
    },
  },
  { name: "sqlite", make: () => new SqlStorage(nodeSqlite()) },
];

describe.each(BACKENDS)("$name storage", ({ make }) => {
  let storage: Storage;
  beforeEach(() => { storage = make(); });

  it("returns null for a key that was never set", async () => {
    expect(await storage.get("missing")).toBeNull();
  });

  it("reads back what it wrote", async () => {
    await storage.set("a", "one");
    expect(await storage.get("a")).toBe("one");
  });

  it("overwrites rather than appending", async () => {
    await storage.set("a", "one");
    await storage.set("a", "two");
    expect(await storage.get("a")).toBe("two");
  });

  it("removes", async () => {
    await storage.set("a", "one");
    await storage.remove("a");
    expect(await storage.get("a")).toBeNull();
  });

  it("removing something absent is not an error", async () => {
    await expect(storage.remove("never")).resolves.toBeUndefined();
  });

  it("lists only keys under the prefix", async () => {
    await storage.set("otos.op.1", "x");
    await storage.set("otos.op.2", "y");
    await storage.set("otos.sequence", "2");
    expect((await storage.keys("otos.op.")).sort()).toEqual(["otos.op.1", "otos.op.2"]);
  });

  it("returns keys in a stable order", async () => {
    // The queue sorts numerically afterwards, but a backend that returns them
    // in a different order on each call makes every bug unreproducible.
    for (const k of ["c", "a", "b"]) await storage.set(`p.${k}`, "1");
    expect(await storage.keys("p.")).toEqual(await storage.keys("p."));
  });

  it("does not leak the backend's own prefix to the caller", async () => {
    // WebStorage namespaces its keys. The queue must never see that, or the
    // keys it stores and the keys it lists stop matching.
    await storage.set("otos.op.000000000001", "{}");
    expect(await storage.keys("otos.op.")).toEqual(["otos.op.000000000001"]);
  });

  it("carries a whole queue, end to end", async () => {
    const q = new FieldQueue({ storage, deviceId: "d1", newId: () => `c${Math.random()}` });
    await q.enqueue({ kind: "timeclock.punch_in" });
    await q.enqueue({ kind: "visit.arrive", subjectId: "v1" });

    expect((await q.pending()).map((o) => o.sequence)).toEqual([1, 2]);
    expect(await q.currentSequence()).toBe(2);
  });
});

describe("sqlite storage", () => {
  it("treats an underscore and a percent in a prefix as themselves, not as wildcards", async () => {
    const storage = new SqlStorage(nodeSqlite());
    await storage.set("a_b.1", "x");
    await storage.set("axb.1", "y");
    await storage.set("a%.1", "z");
    expect(await storage.keys("a_b.")).toEqual(["a_b.1"]);
    expect(await storage.keys("a%.")).toEqual(["a%.1"]);
  });

  it("keeps what it wrote across a reopen of the same database", async () => {
    const db = nodeSqlite();
    await new SqlStorage(db).set("otos.sequence", "41");
    expect(await new SqlStorage(db).get("otos.sequence")).toBe("41");
  });

  it("refuses a table name that would be spliced into SQL", () => {
    expect(() => new SqlStorage(nodeSqlite(), "kv; drop table x")).toThrow();
  });
});
