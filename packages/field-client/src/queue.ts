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
} as const;

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
   *  not fix and a queue that retries forever hides it. */
  maxAttempts?: number;
}

export class FieldQueue {
  private readonly storage: Storage;
  private readonly deviceId: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly batchSize: number;
  private readonly maxAttempts: number;

  constructor(options: QueueOptions) {
    this.storage = options.storage;
    this.deviceId = options.deviceId;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 5;
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
  }> {
    const all = await this.pending();
    const sendable = all
      .filter((o) => o.status !== "rejected" && o.attempts < this.maxAttempts)
      .slice(0, this.batchSize);

    if (sendable.length === 0) {
      return {
        sent: 0, applied: 0, held: 0, rejected: 0, conflicted: 0,
        snapshotRevision: null, error: null,
      };
    }

    let response: SyncResponse;
    try {
      response = await transport.send({
        deviceId: this.deviceId,
        operations: sendable.map(({ status: _s, attempts: _a, lastError: _e, conflict: _c, ...op }) => op),
      });
    } catch (error) {
      /**
       * The connection dropped mid-flight, which on this connection is
       * routine. The operations stay exactly where they are: the client ids
       * are unchanged, so a resend is recognised by the server as a replay
       * rather than applied twice.
       */
      const message = error instanceof Error ? error.message : String(error);
      for (const op of sendable) {
        await this.write({ ...op, attempts: op.attempts + 1, lastError: message });
      }
      return {
        sent: 0, applied: 0, held: 0, rejected: 0, conflicted: 0,
        snapshotRevision: null, error: message,
      };
    }

    return this.reconcile(sendable, response);
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
        await this.write({ ...op, attempts: op.attempts + 1, lastError: "no result returned" });
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
        await this.write({
          ...op,
          status: "conflicted",
          conflict: result.conflict ?? "The office changed this while you were offline.",
        });
        conflicted += 1;
        continue;
      }

      if (result.status === "rejected") {
        await this.write({
          ...op,
          status: "rejected",
          lastError: result.rejection ?? "Rejected",
        });
        rejected += 1;
        continue;
      }

      // held or accepted. Waiting on something earlier from this device.
      await this.write({ ...op, status: "held" });
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
    for (const op of await this.pending()) {
      if (op.clientId === clientId) {
        await this.storage.remove(KEY.operation(op.sequence));
        return true;
      }
    }
    return false;
  }

  /** Retry something that had given up, after the technician asks. */
  async retry(clientId: string): Promise<boolean> {
    for (const op of await this.pending()) {
      if (op.clientId === clientId) {
        await this.write({ ...op, status: "pending", attempts: 0, lastError: undefined });
        return true;
      }
    }
    return false;
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
    const local = await this.currentSequence();
    // Never backwards. If the phone is somehow ahead, it is ahead because it
    // has operations the server has not seen.
    if (serverSequence > local) {
      await this.storage.set(KEY.counter, String(serverSequence));
    }
  }

  private async nextSequence(): Promise<number> {
    const next = (await this.currentSequence()) + 1;
    await this.storage.set(KEY.counter, String(next));
    return next;
  }

  private async write(op: QueuedOperation): Promise<void> {
    await this.storage.set(KEY.operation(op.sequence), JSON.stringify(op));
  }
}
