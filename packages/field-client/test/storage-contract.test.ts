import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStorage, WebStorage, FieldQueue, type Storage } from "../src/index";

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
