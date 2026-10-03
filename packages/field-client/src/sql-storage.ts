import type { Storage } from "./storage";

/**
 * The queue, in SQLite.
 *
 * What a phone uses, and the choice over AsyncStorage and MMKV is about one
 * property: a write that has returned is on disk. SQLite commits each
 * statement through its journal before the call resolves, so a tap the
 * screen acknowledged survives the app being killed a millisecond later and
 * the battery dying a second after that. MMKV writes to a memory map and
 * leaves the flush to the operating system, which survives the app being
 * killed and not necessarily the phone losing power, and AsyncStorage on iOS
 * is a directory of files with a manifest written beside them. Both are
 * fine for preferences. This is somebody's payroll.
 *
 * It also ships with Expo, runs in a background task, and needs no native
 * module the app would not have anyway.
 *
 * Written against a four method driver rather than against expo-sqlite, so
 * the same class runs in a test against Node's own SQLite and passes the same
 * contract suite as every other backend. The phone app's adapter is a few
 * lines.
 */
export type SqlValue = string | number | null;

export interface SqlDriver {
  run(sql: string, params: SqlValue[]): Promise<void>;
  all<T>(sql: string, params: SqlValue[]): Promise<T[]>;
}

export class SqlStorage implements Storage {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: SqlDriver, private readonly table = "otos_kv") {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Not a table name: ${table}`);
  }

  /**
   * Created on first use rather than in the constructor, because a
   * constructor cannot wait, and a background task that opens the queue and
   * immediately reads it must not race the table into existence.
   *
   * WITHOUT ROWID because the key is the only thing ever looked up and the
   * queue lists by key range, which is exactly the primary key's order.
   */
  private init(): Promise<void> {
    this.ready ??= this.db.run(
      `create table if not exists ${this.table} (key text primary key not null, value text not null) without rowid`,
      [],
    );
    return this.ready;
  }

  async get(key: string): Promise<string | null> {
    await this.init();
    const rows = await this.db.all<{ value: string }>(
      `select value from ${this.table} where key = ?`, [key],
    );
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.init();
    await this.db.run(
      `insert into ${this.table} (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`,
      [key, value],
    );
  }

  async remove(key: string): Promise<void> {
    await this.init();
    await this.db.run(`delete from ${this.table} where key = ?`, [key]);
  }

  /**
   * A range rather than LIKE, so an underscore or a percent in a key is not
   * a wildcard and the primary key index does the work. Every key the queue
   * writes is ASCII, so the top of the Basic Multilingual Plane is above all
   * of them.
   */
  async keys(prefix: string): Promise<string[]> {
    await this.init();
    const rows = await this.db.all<{ key: string }>(
      `select key from ${this.table} where key >= ? and key < ? order by key`,
      [prefix, `${prefix}￿`],
    );
    return rows.map((r) => r.key);
  }
}
