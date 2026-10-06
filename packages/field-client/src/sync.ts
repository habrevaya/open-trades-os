import {
  isOffline, isSignedOut, type FieldQueue, type QueuedOperation, type Transport,
} from "./queue";
import type { Storage } from "./storage";
import type { UploadQueue, UploadTransport } from "./uploads";
import type { FieldAbilities, FieldInspectionProgram, FieldSnapshot, PriceBookEntry } from "./wire";
import { projectDay, todayIn, type DayView } from "./day";
import { describeOperation, describeUpload, type Problem } from "./problems";
import { sharingFor, type PositionBuffer, type SharingState } from "./positions";

/**
 * ONE PASS OF "SEND WHAT IS WAITING, THEN ASK WHAT CHANGED"
 *
 * The phone runs this from four places: after every tap, on a half minute
 * timer while the app is open, when the connection comes back, and from the
 * operating system's background task. All four call the same function, and
 * only one pass runs at a time; a call that arrives during a pass waits for
 * it and gets its result, rather than starting a second send of the same
 * operations over the same one bar.
 *
 * The order is the order the server needs:
 *
 *   1. Operations, oldest first, in batches until nothing more is accepted,
 *      then any positions waiting, after the operations so a punch in sent
 *      in the same pass is on the record when its fixes are judged.
 *   2. The bytes of any photograph or signature whose record has now landed.
 *   3. The day as the server now sees it, saved so the app opens offline.
 *
 * A pass with no signal stops at the first request and changes nothing but
 * the backoff. A pass with an expired sign in stops the same way and says
 * so, and nothing on the phone is lost: the work waits for the sign in.
 */

const KEY = {
  snapshot: "otos.snapshot",
  applied: "otos.applied",
  lastSync: "otos.last-sync",
} as const;

export interface CachedSnapshot {
  snapshot: FieldSnapshot;
  /** The first day it covers, in the company's timezone. */
  from: string;
  fetchedAt: string;
}

export interface SyncReport {
  /** False when a timer call found the queue still backing off. */
  ran: boolean;
  applied: number;
  uploadsSent: number;
  snapshotUpdated: boolean;
  offline: boolean;
  signedOut: boolean;
  /** Something the server answered with, worth showing. Null when all went. */
  error: string | null;
}

export interface SyncEngineOptions {
  queue: FieldQueue;
  uploads: UploadQueue;
  storage: Storage;
  transport: Transport;
  uploadTransport: UploadTransport;
  snapshot: (input: { from: string; days: number; sinceRevision?: number | undefined }) => Promise<FieldSnapshot>;
  /** The company's timezone, which decides what "today" is. */
  timezone: string;
  /** Today and tomorrow, so tomorrow's first job is on the phone tonight. */
  days?: number;
  now?: () => Date;
  /** Batches per pass. A whole day is a few; this stops a held tail looping. */
  maxRounds?: number;
  /** Where fixes wait for the next send, when the app shares location. */
  positions?: PositionBuffer;
}

export class SyncEngine {
  private readonly options: SyncEngineOptions;
  private readonly now: () => Date;
  private running: Promise<SyncReport> | null = null;
  private again = false;

  constructor(options: SyncEngineOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * `force` for a person's tap, which always tries now. Without it, the
   * queue's backoff decides, so a timer on a phone with no signal does not
   * spend the battery asking every half minute.
   */
  run(input: { force?: boolean } = {}): Promise<SyncReport> {
    if (this.running) {
      // A tap during a pass. The pass in flight may already have taken the
      // operation that tap queued, or it may not have, so one more pass runs
      // after it rather than the tap's work waiting for the next timer.
      if (input.force) this.again = true;
      return this.running;
    }
    this.running = this.pass(input.force ?? false).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.run({ force: true });
      }
    });
    return this.running;
  }

  private async pass(force: boolean): Promise<SyncReport> {
    const { queue, uploads } = this.options;
    const report: SyncReport = {
      ran: true, applied: 0, uploadsSent: 0, snapshotUpdated: false,
      offline: false, signedOut: false, error: null,
    };

    if (!force && !(await queue.due())) return { ...report, ran: false };

    const stop = (cause: unknown, message: string | null): SyncReport => ({
      ...report,
      offline: isOffline(cause),
      signedOut: isSignedOut(cause),
      error: isOffline(cause) ? null : message,
    });

    // 1. Operations.
    const before = await queue.pending();
    for (let round = 0; round < (this.options.maxRounds ?? 10); round++) {
      let cause: unknown = null;
      const result = await queue.flush({
        send: async (batch) => {
          try {
            return await this.options.transport.send(batch);
          } catch (error) {
            cause = error;
            throw error;
          }
        },
      });
      report.applied += result.applied;
      if (result.error !== null) {
        await this.rememberApplied(before);
        return stop(cause, result.error);
      }
      // Another round only while something moved: operations landed, or the
      // answer named a lost number that the next send can declare.
      if (result.sent === 0 || (result.applied === 0 && !result.skipping)) break;
    }
    await this.rememberApplied(before);

    if (this.options.positions) {
      const sent = await this.options.positions.flush(this.options.transport);
      if (sent.offline) return { ...report, offline: true };
      if (sent.error) report.error = sent.error;
    }

    // 2. Files.
    const drained = await uploads.drain(this.options.uploadTransport);
    report.uploadsSent = drained.sent;
    if (drained.offline || drained.signedOut) {
      return { ...report, offline: drained.offline, signedOut: drained.signedOut };
    }
    if (drained.error) report.error = drained.error;
    await uploads.prune();

    // 3. The day.
    try {
      report.snapshotUpdated = await this.refresh();
    } catch (error) {
      return stop(error, error instanceof Error ? error.message : String(error));
    }

    await this.options.storage.set(KEY.lastSync, this.now().toISOString());
    return report;
  }

  /**
   * Ask for the day, and only for what changed when nothing on the phone has
   * moved since the last ask.
   *
   * The revision covers the visits and not the clock, so after a punch has
   * landed the whole snapshot is fetched: an "unchanged" answer would leave
   * the screen showing the clock from before it.
   */
  private async refresh(): Promise<boolean> {
    const zone = this.options.timezone;
    const from = todayIn(zone, this.now());
    const cached = await this.cached();
    const overlay = await this.overlay();
    const sinceRevision = cached && cached.from === from && overlay.length === 0
      ? cached.snapshot.revision
      : undefined;

    const fresh = await this.options.snapshot({ from, days: this.options.days ?? 2, sinceRevision });
    /**
     * The sharing settings come with every answer, changed or not: the
     * revision covers the visits, and an office turning sharing off for
     * somebody must reach the phone on the next send, not the next change to
     * their day.
     */
    const snapshot = fresh.unchanged && cached
      ? {
          ...cached.snapshot,
          ...(fresh.locationSharing ? { locationSharing: fresh.locationSharing } : {}),
          /** What the person may do can change without the day changing: a role edited in the office. */
          ...(fresh.abilities ? { abilities: fresh.abilities } : {}),
        }
      : fresh;

    const entry: CachedSnapshot = { snapshot, from, fetchedAt: this.now().toISOString() };
    await this.options.storage.set(KEY.snapshot, JSON.stringify(entry));
    // The server's answer now includes everything it had applied.
    await this.options.storage.remove(KEY.applied);
    return !fresh.unchanged;
  }

  /**
   * Operations the server applied since the day was last fetched, kept so the
   * screen does not step backwards if the signal drops between the send and
   * the fetch. Cleared by the next fetch that succeeds.
   */
  private async rememberApplied(before: QueuedOperation[]): Promise<void> {
    const still = new Set((await this.options.queue.pending()).map((o) => o.clientId));
    const gone = before.filter((o) => !still.has(o.clientId) && o.status !== "rejected");
    if (gone.length === 0) return;
    const overlay = await this.overlay();
    await this.options.storage.set(KEY.applied, JSON.stringify([...overlay, ...gone]));
  }

  async cached(): Promise<CachedSnapshot | null> {
    return readJson<CachedSnapshot>(this.options.storage, KEY.snapshot);
  }

  private async overlay(): Promise<QueuedOperation[]> {
    return (await readJson<QueuedOperation[]>(this.options.storage, KEY.applied)) ?? [];
  }

  async lastSyncedAt(): Promise<string | null> {
    return this.options.storage.get(KEY.lastSync);
  }

  /**
   * Everything the day screen shows, from what is on the phone. Works with
   * no signal at all, which is the point.
   */
  async view(): Promise<{
    day: DayView;
    /** What a part can be picked from, as the server last sent it. */
    priceBook: PriceBookEntry[];
    /** What an inspection can be run against, as the server last sent it. Empty for somebody who may not. */
    inspectionPrograms: FieldInspectionProgram[];
    from: string | null;
    waiting: number;
    uploadsWaiting: number;
    problems: Problem[];
    backoffUntil: Date | null;
    lastSyncedAt: string | null;
    /** Whether the phone should be sharing where its person is now, and the sentence that says so. */
    location: SharingState;
    /** What this person may do on site, as the server last said. Nothing new from an older server. */
    abilities: FieldAbilities;
  }> {
    const { queue, uploads } = this.options;
    const cached = await this.cached();
    const pending = await queue.pending();
    const files = await uploads.list();
    const day = projectDay({
      snapshot: cached?.snapshot ?? null,
      operations: pending,
      applied: await this.overlay(),
      uploads: files,
    });

    const names = new Map(day.visits.map((v) => [v.id, v.customer.name]));
    const nameOf = (id: string) => names.get(id);
    const problems = [
      ...pending.map((op) => describeOperation(op, nameOf)),
      ...files.map((file) => describeUpload(file, nameOf)),
    ].filter((p): p is Problem => p !== null);

    return {
      day,
      priceBook: cached?.snapshot.priceBook ?? [],
      inspectionPrograms: cached?.snapshot.inspectionPrograms ?? [],
      from: cached?.from ?? null,
      // Conflicted operations are recorded; only what has not landed is waiting.
      waiting: pending.filter((o) => o.status !== "conflicted" && o.status !== "rejected").length,
      uploadsWaiting: files.filter((f) => f.status === "waiting").length,
      problems,
      backoffUntil: await queue.backoffUntil(),
      lastSyncedAt: await this.lastSyncedAt(),
      location: sharingFor(day, cached?.snapshot.locationSharing),
      abilities: cached?.snapshot.abilities ?? NO_ABILITIES,
    };
  }
}

/**
 * What a phone offers when the server has not said: nothing new. A server
 * older than selling on site would refuse every one of these, and a button
 * that is always refused is worse than no button.
 */
export const NO_ABILITIES: FieldAbilities = {
  writeEstimates: false, presentEstimates: false, raiseInvoices: false, takePayments: true, tasks: false,
  tipping: { enabled: false, presets: [] }, financing: false, assistant: false, expenses: false,
};

async function readJson<T>(storage: Storage, key: string): Promise<T | null> {
  const raw = await storage.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
