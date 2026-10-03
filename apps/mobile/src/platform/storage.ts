import * as SQLite from "expo-sqlite";
import { SqlStorage, type SqlDriver } from "@opentradesos/field-client";

/**
 * The queue's storage on the phone: SQLite, through the driver the field
 * client's SqlStorage is written against. Why SQLite rather than AsyncStorage
 * or MMKV is on SqlStorage itself: a write that has returned is on disk.
 *
 * One database per person per server, so a second technician signing in on a
 * shared handset neither sees nor sends the first one's work, and the first
 * one's work is still there when they sign back in.
 */
const open = new Map<string, Promise<SqlStorage>>();

export function storageFor(userId: string): Promise<SqlStorage> {
  const name = `field-${userId.replace(/[^a-zA-Z0-9-]/g, "")}.db`;
  let pending = open.get(name);
  if (!pending) {
    pending = SQLite.openDatabaseAsync(name).then(async (db) => {
      /*
        Write ahead logging, so a read by the screen never waits on a write
        by the background task, and a commit is one append rather than a
        rewrite of the page.
      */
      await db.execAsync("pragma journal_mode = wal");
      const driver: SqlDriver = {
        async run(sql, params) { await db.runAsync(sql, params); },
        async all<T>(sql: string, params: Array<string | number | null>) { return db.getAllAsync<T>(sql, params); },
      };
      return new SqlStorage(driver);
    });
    open.set(name, pending);
  }
  return pending;
}
