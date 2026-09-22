import type { Storage } from "./storage";

/**
 * The queue, in a browser.
 *
 * localStorage rather than IndexedDB on purpose. The queue writes small JSON
 * records synchronously on a user action, which is exactly what localStorage
 * is good at, and IndexedDB's asynchrony buys nothing here while costing a
 * schema, a version and an upgrade path.
 *
 * The limit is about five megabytes, which at roughly 400 bytes an operation
 * is more than ten thousand of them. A technician who queues ten thousand
 * operations without a connection has a different problem.
 *
 * Every call is wrapped, because localStorage throws rather than returning
 * null in a private window, with site data blocked, or when the quota is hit.
 * A queue that crashes when storage is unavailable takes the whole screen with
 * it, and the technician cannot even see the job they are standing in front of.
 */
export class WebStorage implements Storage {
  constructor(private readonly prefix = "") {}

  /** Whether writes are actually persisting. Worth showing the technician. */
  static available(): boolean {
    try {
      const probe = "__otos_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return window.localStorage.getItem(this.prefix + key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    /**
     * This one does NOT swallow. Everywhere else a storage failure degrades
     * to "nothing was there", which is survivable. Here it means the
     * technician's tap was not recorded, and telling them it worked is the
     * failure the whole queue exists to prevent.
     */
    window.localStorage.setItem(this.prefix + key, value);
  }

  async remove(key: string): Promise<void> {
    try {
      window.localStorage.removeItem(this.prefix + key);
    } catch {
      // Already gone is the outcome the caller wanted.
    }
  }

  async keys(prefix: string): Promise<string[]> {
    try {
      const found: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key?.startsWith(this.prefix + prefix)) {
          found.push(key.slice(this.prefix.length));
        }
      }
      return found.sort();
    } catch {
      return [];
    }
  }
}
