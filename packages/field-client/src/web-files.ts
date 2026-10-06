import type { UploadFiles } from "./uploads";

/**
 * WHERE A PHOTOGRAPH WAITS, IN A BROWSER
 *
 * The phone app copies a photograph into its own documents folder. A page
 * has no folder, and the queue's own storage, localStorage, holds about five
 * megabytes in all: two photographs and the queue would stop being able to
 * record a punch. So the bytes go in IndexedDB, which holds as much as the
 * browser allows the site, and the upload queue's record points at them with
 * an `idb:` address that means nothing anywhere else.
 *
 * A write that has returned is committed: `keep` waits for the transaction's
 * own completion, not only the request, because a photograph the technician
 * was told was kept and then was not is the failure the queue exists to
 * prevent.
 */

const STORE = "files";
const PREFIX = "idb:";

export class IndexedDbFiles implements UploadFiles {
  private opened: Promise<IDBDatabase> | null = null;

  constructor(private readonly name = "otos-files") {}

  /** Whether this browser offers IndexedDB at all. A private window in some browsers does not. */
  static available(): boolean {
    try {
      return typeof indexedDB !== "undefined" && indexedDB !== null;
    } catch {
      return false;
    }
  }

  /** Keep the bytes, base64, under the upload's id. Returns the address the queue records. */
  async keep(uploadId: string, base64: string): Promise<string> {
    const db = await this.db();
    await done(db.transaction(STORE, "readwrite"), (store) => store.put(base64, uploadId));
    return `${PREFIX}${uploadId}`;
  }

  async read(localUri: string): Promise<string> {
    const db = await this.db();
    const value = await request<unknown>(db.transaction(STORE, "readonly").objectStore(STORE).get(idOf(localUri)));
    if (typeof value !== "string") throw new Error("missing");
    return value;
  }

  async remove(localUri: string): Promise<void> {
    const db = await this.db();
    await done(db.transaction(STORE, "readwrite"), (store) => store.delete(idOf(localUri)));
  }

  private db(): Promise<IDBDatabase> {
    if (!this.opened) {
      this.opened = new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open(this.name, 1);
        opening.onupgradeneeded = () => {
          if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE);
        };
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error ?? new Error("This browser would not open its storage."));
      });
      // A failed open is tried again next time rather than remembered forever.
      this.opened.catch(() => { this.opened = null; });
    }
    return this.opened;
  }
}

function idOf(localUri: string): string {
  if (!localUri.startsWith(PREFIX)) throw new Error("missing");
  return localUri.slice(PREFIX.length);
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("storage request failed"));
  });
}

function done(tx: IDBTransaction, act: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    act(tx.objectStore(STORE));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("storage write was abandoned"));
    tx.onerror = () => reject(tx.error ?? new Error("storage write failed"));
  });
}
