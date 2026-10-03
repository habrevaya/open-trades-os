import type { field } from "@opentradesos/core";

type OperationKind = field.OperationKind;
import type { Storage } from "./storage";

/**
 * THE QUEUE ON THE PHONE
 *
 * Everything a technician does goes in here first and is sent later. Later can
 * be eight hours later, and the phone may be restarted, killed by the OS, or
 * run flat in between.
 *
 * Three properties, in the order they matter.
 *
 * NOTHING IS LOST. An operation is durable before the caller is told it
 * happened. A tap that appears to work and then is not there after a restart
 * is worse than a tap that visibly fails, because the technician has moved on.
 *
 * NOTHING IS DUPLICATED. The client id is generated once, persisted with the
 * operation, and reused on every retry. A queue that regenerates it turns one
 * punch into four.
 *
 * NOTHING IS REORDERED. Sequence numbers come from a counter that is persisted
 * before use and never reused, including across a reinstall that kept the
 * device registration. A gap is recoverable; a repeat is not, because the
 * server treats it as a replay and silently discards the second one.
 */

const KEY = {
  operation: (seq: number) => `otos.op.${String(seq).padStart(12, "0")}`,
  counter: "otos.sequence",
  device: "otos.device",
  backoff: "otos.backoff",
  skipped: "otos.skipped",
} as const;

/**
 * THE REQUEST NEVER GOT AN ANSWER.
 *
 * Thrown by a transport when nothing judged the operations: no signal, a
 * server that could not be reached, a sign in that has to be renewed first.
 * The queue does not count it against the operations, and that distinction
 * is the difference between a queue that works offline and one that does
 * not. Counting it, which is what a plain Error does, meant a phone with no
 * signal for three minutes had retried everything five times and given up
 * on the whole day, in a basement, before the technician had found the
 * furnace.
 *
 * An answer that refused the batch, a server fault or a revoked device, is a
 * plain Error and is counted, because retrying that forever hides it.
 */
export class OfflineError extends Error {
  readonly offline = true as const;
  constructor(message = "No connection") {
    super(message);
    this.name = "OfflineError";
  }
}

/**
 * By shape rather than by class, because a transport bundled into another
 * copy of this package (a phone app's own build of it) throws an
 * OfflineError that `instanceof` here would not recognise.
 */
export const isOffline = (error: unknown): boolean =>
  error instanceof OfflineError
  || (typeof error === "object" && error !== null && (error as { offline?: unknown }).offline === true);

/** The token was refused rather than the connection lost. See SignedOutError. */
export const isSignedOut = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { signedOut?: unknown }).signedOut === true;

/**
 * How long to wait after the Nth failure in a row before trying on a timer.
 *
 * Doubling from five seconds to a ceiling of fifteen minutes, with the
 * second half of each wait randomised. The ceiling is because a technician
 * who drives back into signal should see the queue empty within a few
 * minutes, not an hour. The randomness is for the morning after an outage,
 * when every phone in the company would otherwise retry on the same second.
 *
 * Only the timer waits. Somebody tapping a button always sends straight
 * away, because a person who just did something expects it to go now.
 */
export function backoffDelayMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return 0;
  const ceiling = Math.min(5_000 * 2 ** (failures - 1), 15 * 60_000);
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

export type QueuedStatus = "pending" | "sending" | "held" | "rejected" | "conflicted";

export interface QueuedOperation {
  clientId: string;
  sequence: number;
  kind: OperationKind;
  subjectId?: string | undefined;
  occurredAt: string;
  payload: Record<string, unknown>;
  latitude?: string | undefined;
  longitude?: string | undefined;
  accuracyMeters?: number | undefined;

  status: QueuedStatus;
  attempts: number;
  lastError?: string | undefined;
  /** Set when the server applied it but disagreed with its own state. */
  conflict?: string | undefined;
}

export interface SyncResult {
  clientId: string;
  status: "accepted" | "applied" | "conflicted" | "rejected" | "superseded" | "held";
  conflict: string | null;
  rejection: string | null;
  occurredAt: string;
  clamped: "future" | "reordered" | null;
}

export interface SyncResponse {
  results: SyncResult[];
  awaiting: number[];
  snapshotRevision: number;
}

export interface Transport {
  send(input: {
    deviceId: string;
    operations: Array<Omit<QueuedOperation, "status" | "attempts" | "lastError" | "conflict">>;
    /** Sequences this device numbered and lost. See `flush`. Absent when none. */
    skipped?: number[];
  }): Promise<SyncResponse>;
}

export interface QueueOptions {
  storage: Storage;
  deviceId: string;
  /** Injected so a test can make time deterministic. */
  now?: () => Date;
  newId?: () => string;
  /** Operations per request. The connection this exists for is a van on a
   *  highway, and a batch that is too large never completes. */
  batchSize?: number;
  /** After this many failures an operation stops being retried automatically
   *  and is surfaced instead, because something is wrong that retrying will
   *  not fix and a queue that retries forever hides it. An `OfflineError` is
   *  not a failure for this count. */
  maxAttempts?: number;
  /** Injected so a test can make the backoff deterministic. */
  random?: () => number;
}

export class FieldQueue {
  private readonly storage: Storage;
  private readonly deviceId: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly random: () => number;
  /**
   * Every read-modify-write of the counter or of one operation runs through
   * here, one at a time.
   *
   * Storage is asynchronous, so two taps in the same instant (a photo saved
   * while the status button is pressed) both read counter 5, both write 6,
   * and the second operation overwrites the first under the same key. That
   * is a lost operation with no error anywhere, which is the one outcome
   * this package exists to prevent. Sending is NOT held here, because a tap
   * must not wait for a request on one bar of signal.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: QueueOptions) {
    this.storage = options.storage;
    this.deviceId = options.deviceId;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.random = options.random ?? Math.random;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Record something the technician did.
   *
   * The counter is advanced and persisted BEFORE the operation is written.
   * That ordering is the whole thing: a crash between the two burns a sequence
   * number, which leaves a gap the server holds for and which the next sync
   * resolves. The other ordering loses nothing visibly and hands out the same
   * sequence twice, and the second operation is discarded by the server as a
   * replay with no error anywhere.
   */
  async enqueue(input: {
    kind: OperationKind;
    subjectId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
    occurredAt?: Date | undefined;
    latitude?: string | undefined;
    longitude?: string | undefined;
    accuracyMeters?: number | undefined;
  }): Promise<QueuedOperation> {
    return this.serial(() => this.enqueueNow(input));
  }

  private async enqueueNow(input: Parameters<FieldQueue["enqueue"]>[0]): Promise<QueuedOperation> {
    const sequence = await this.nextSequence();

    const operation: QueuedOperation = {
      clientId: this.newId(),
      sequence,
      kind: input.kind,
      subjectId: input.subjectId,
      // The device's clock. The server clamps it and keeps both, because a
      // phone that has been offline since breakfast may have drifted.
      occurredAt: (input.occurredAt ?? this.now()).toISOString(),
      payload: input.payload ?? {},
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      status: "pending",
      attempts: 0,
    };

    await this.storage.set(KEY.operation(sequence), JSON.stringify(operation));
    return operation;
  }

  /** Everything not yet acknowledged, oldest first. */
  async pending(): Promise<QueuedOperation[]> {
    const keys = await this.storage.keys("otos.op.");
    const operations: QueuedOperation[] = [];

    for (const key of keys) {
      const raw = await this.storage.get(key);
      if (!raw) continue;
      try {
        operations.push(JSON.parse(raw) as QueuedOperation);
      } catch {
        // A half written record from a crash mid-write. Skipping it is right:
        // the sequence it occupied becomes a gap the server waits on, which is
        // recoverable, and there is nothing to recover from the bytes.
        continue;
      }
    }

    // The keys are zero padded so lexical order is numeric order, but sorting
    // explicitly means a storage backend that does not sort cannot break it.
    return operations.sort((a, b) => a.sequence - b.sequence);
  }

  /** What the technician should be told about. */
  async problems(): Promise<QueuedOperation[]> {
    return (await this.pending()).filter(
      (o) => o.status === "rejected" || o.status === "conflicted" || o.attempts >= this.maxAttempts,
    );
  }

  /**
   * Send what is queued.
   *
   * Returns what happened rather than throwing, because every caller of this
   * is a background task or a pull to refresh and neither wants an exception.
   * A transport failure leaves the queue exactly as it was, which is the
   * behaviour that makes calling this on a timer safe.
   */
  async flush(transport: Transport): Promise<{
    sent: number;
    applied: number;
    held: number;
    rejected: number;
    conflicted: number;
    snapshotRevision: number | null;
    error: string | null;
    /** Lost sequences learned from this answer, to declare on the next send. */
    skipping?: number;
  }> {
    const all = await this.pending();
    /**
     * Not the rejected, which the server will refuse again, and not the
     * conflicted, which it has already applied: a conflict stays on the
     * phone so the technician sees it, not so it can be sent every half
     * minute for the rest of the day.
     */
    const sendable = all
      .filter((o) => o.status !== "rejected" && o.status !== "conflicted" && o.attempts < this.maxAttempts)
      .slice(0, this.batchSize);

    if (sendable.length === 0) {
      return {
        sent: 0, applied: 0, held: 0, rejected: 0, conflicted: 0,
        snapshotRevision: null, error: null,
      };
    }

    let response: SyncResponse;
    try {
      const local = new Set(all.map((o) => o.sequence));
      const skipped = (await this.skippedSequences()).filter((n) => !local.has(n));
      response = await transport.send({
        deviceId: this.deviceId,
        operations: sendable.map(({ status: _s, attempts: _a, lastError: _e, conflict: _c, ...op }) => op),
        ...(skipped.length > 0 ? { skipped } : {}),
      });
    } catch (error) {
      /**
       * The connection dropped mid-flight, which on this connection is
       * routine. The operations stay exactly where they are: the client ids
       * are unchanged, so a resend is recognised by the server as a replay
       * rather than applied twice.
       */
      const message = error instanceof Error ? error.message : String(error);
      const counted = !isOffline(error);
      for (const op of sendable) {
        await this.update(op.sequence, (current) => ({
          ...current,
          attempts: counted ? current.attempts + 1 : current.attempts,
          lastError: message,
        }));
      }
      await this.recordFailure();
      return {
        sent: 0, applied: 0, held: 0, rejected: 0, conflicted: 0,
        snapshotRevision: null, error: message,
      };
    }

    await this.storage.remove(KEY.backoff);
    const result = await this.reconcile(sendable, response);
    return { ...result, skipping: await this.learnSkipped(response.awaiting ?? []) };
  }

  /**
   * NUMBERS THIS PHONE LOST, SAID OUT LOUD.
   *
   * The counter is advanced before an operation is written, so a phone that
   * dies between the two has numbered something that does not exist; and an
   * operation the technician discards before it ever got through leaves the
   * same hole. The server holds everything after a hole, waiting for it, and
   * says which numbers in `awaiting`. A number it is waiting for that this
   * phone does not hold will never come, so the next send declares it, and
   * the server stops waiting.
   *
   * Only numbers the phone has handed out, and only ones it does not hold:
   * an operation that is merely slow, or has stopped retrying, is still here
   * and is not declared lost.
   */
  private async learnSkipped(awaiting: number[]): Promise<number> {
    if (awaiting.length === 0) {
      await this.storage.remove(KEY.skipped);
      return 0;
    }
    const held = new Set((await this.pending()).map((o) => o.sequence));
    const counter = await this.currentSequence();
    const before = new Set(await this.skippedSequences());
    const lost = awaiting.filter((n) => n <= counter && !held.has(n));
    await this.storage.set(KEY.skipped, JSON.stringify(lost));
    return lost.filter((n) => !before.has(n)).length;
  }

  private async skippedSequences(): Promise<number[]> {
    const raw = await this.storage.get(KEY.skipped);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
    } catch {
      return [];
    }
  }

  /**
   * Whether a timer should try now. A failed send pushes this out; an
   * answered one, or anybody tapping a button, resets it.
   */
  async due(): Promise<boolean> {
    const until = await this.backoffUntil();
    return until === null || until.getTime() <= this.now().getTime();
  }

  /** When the timer will next try, for a screen that says so. */
  async backoffUntil(): Promise<Date | null> {
    const state = await this.backoffState();
    return state ? new Date(state.until) : null;
  }

  private async backoffState(): Promise<{ failures: number; until: string } | null> {
    const raw = await this.storage.get(KEY.backoff);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { failures: number; until: string };
      return typeof parsed.failures === "number" && typeof parsed.until === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async recordFailure(): Promise<void> {
    const failures = ((await this.backoffState())?.failures ?? 0) + 1;
    const until = new Date(this.now().getTime() + backoffDelayMs(failures, this.random));
    await this.storage.set(KEY.backoff, JSON.stringify({ failures, until: until.toISOString() }));
  }

  /**
   * Apply the server's verdicts.
   *
   * Applied and superseded are removed. Held stays, because the server is
   * waiting on an earlier operation and this one will go through once it
   * arrives. Rejected and conflicted stay too, visibly, because the technician
   * is the only person who can say what actually happened.
   */
  private async reconcile(sent: QueuedOperation[], response: SyncResponse) {
    const byClientId = new Map(response.results.map((r) => [r.clientId, r]));
    let applied = 0, held = 0, rejected = 0, conflicted = 0;

    for (const op of sent) {
      const result = byClientId.get(op.clientId);

      if (!result) {
        /**
         * Sent and not mentioned in the response. Not an error: a response
         * truncated by a dropped connection looks exactly like this. Leave it
         * queued and let the next flush ask again, which is safe because the
         * client id makes a repeat a replay.
         */
        await this.update(op.sequence, (current) => ({
          ...current, attempts: current.attempts + 1, lastError: "no result returned",
        }));
        continue;
      }

      if (result.status === "applied" || result.status === "superseded") {
        await this.storage.remove(KEY.operation(op.sequence));
        applied += 1;
        continue;
      }

      if (result.status === "conflicted") {
        // Applied, and it disagreed with what the server held. It stays on the
        // phone so the technician sees it, and the office sees it too.
        await this.update(op.sequence, (current) => ({
          ...current,
          status: "conflicted",
          conflict: result.conflict ?? "The office changed this while you were offline.",
        }));
        conflicted += 1;
        continue;
      }

      if (result.status === "rejected") {
        await this.update(op.sequence, (current) => ({
          ...current,
          status: "rejected",
          lastError: result.rejection ?? "Rejected",
        }));
        rejected += 1;
        continue;
      }

      // held or accepted. Waiting on something earlier from this device.
      await this.update(op.sequence, (current) => ({ ...current, status: "held" }));
      held += 1;
    }

    return {
      sent: sent.length,
      applied, held, rejected, conflicted,
      snapshotRevision: response.snapshotRevision,
      error: null,
    };
  }

  /**
   * Discard an operation the technician has decided about.
   *
   * The only way anything leaves the queue other than being applied. Called
   * from the screen that shows conflicts, never automatically: a queue that
   * quietly drops its own failures is a queue that loses a day's work and
   * reports success.
   */
  async dismiss(clientId: string): Promise<boolean> {
    return this.serial(async () => {
      for (const op of await this.pending()) {
        if (op.clientId === clientId) {
          await this.storage.remove(KEY.operation(op.sequence));
          return true;
        }
      }
      return false;
    });
  }

  /** Retry something that had given up, after the technician asks. */
  async retry(clientId: string): Promise<boolean> {
    const found = await this.serial(async () => {
      for (const op of await this.pending()) {
        if (op.clientId === clientId) {
          await this.write({ ...op, status: "pending", attempts: 0, lastError: undefined });
          return true;
        }
      }
      return false;
    });
    // Somebody asked, so the timer's wait is over too.
    if (found) await this.storage.remove(KEY.backoff);
    return found;
  }

  /**
   * The sequence the device has reached.
   *
   * Persisted separately from the operations so it survives them being
   * removed. Deriving it from the queue instead would reset to zero the moment
   * a technician finished a day and everything synced, and the next operation
   * would collide with the first one of the previous day.
   */
  async currentSequence(): Promise<number> {
    const raw = await this.storage.get(KEY.counter);
    return raw ? Number(raw) : 0;
  }

  /**
   * Adopt the sequence the server says this device reached.
   *
   * Called after registering, which matters for a reinstall: the phone has no
   * counter and the server does, and starting again at one would make every
   * operation a replay of a different one from the last install.
   */
  async adoptSequence(serverSequence: number): Promise<void> {
    return this.serial(async () => {
      const local = await this.currentSequence();
      // Never backwards. If the phone is somehow ahead, it is ahead because it
      // has operations the server has not seen.
      if (serverSequence > local) {
        await this.storage.set(KEY.counter, String(serverSequence));
      }
    });
  }

  private async nextSequence(): Promise<number> {
    const next = (await this.currentSequence()) + 1;
    await this.storage.set(KEY.counter, String(next));
    return next;
  }

  private async write(op: QueuedOperation): Promise<void> {
    await this.storage.set(KEY.operation(op.sequence), JSON.stringify(op));
  }

  /**
   * Change one stored operation, reading it again first.
   *
   * A send can take a minute on one bar, and the technician can dismiss or
   * retry the operation in the meantime. Writing back the copy taken before
   * the request would put a dismissed operation back on the phone, so the
   * verdict is applied to whatever is stored now, and to nothing if it has
   * gone.
   */
  private async update(
    sequence: number,
    change: (current: QueuedOperation) => QueuedOperation,
  ): Promise<void> {
    await this.serial(async () => {
      const raw = await this.storage.get(KEY.operation(sequence));
      if (!raw) return;
      let current: QueuedOperation;
      try {
        current = JSON.parse(raw) as QueuedOperation;
      } catch {
        return;
      }
      await this.write(change(current));
    });
  }
}
