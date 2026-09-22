/**
 * WHERE THE QUEUE LIVES
 *
 * On a phone this is AsyncStorage or SQLite. In a test it is a map. The queue
 * does not know which, and that is the point: the interesting failures here
 * are ordering, crash recovery and duplication, none of which need a device to
 * reproduce and all of which are miserable to reproduce on one.
 *
 * The contract is deliberately small. Anything richer, a transaction or a
 * query, is something a React Native storage backend may not have, and
 * discovering that after the logic depends on it is a rewrite.
 */
export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Keys under a prefix. The only listing operation the queue needs. */
  keys(prefix: string): Promise<string[]>;
}

/** For tests, and for a first run before anything is persisted. */
export class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  /**
   * Set by a test to simulate the phone dying mid-write.
   *
   * A queue that only works when every write completes is a queue that has not
   * been tested against the thing that actually happens: a technician's phone
   * at four percent battery in a crawl space.
   *
   * It takes a predicate rather than a flag because WHICH write fails is the
   * whole question. Enqueue does two: the counter, then the operation. Failing
   * the first is harmless, nothing happened. Failing the second is the case
   * worth reasoning about, and a flag that stops at the first write never
   * reaches it.
   */
  failWriteWhen: ((key: string) => boolean) | null = null;

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    if (this.failWriteWhen?.(key)) {
      this.failWriteWhen = null;
      throw new Error(`storage write failed for ${key}`);
    }
    this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** Test helper: everything that survived, as it would after a restart. */
  snapshot(): Map<string, string> {
    return new Map(this.data);
  }

  static from(snapshot: Map<string, string>): MemoryStorage {
    const s = new MemoryStorage();
    for (const [k, v] of snapshot) s.data.set(k, v);
    return s;
  }
}
