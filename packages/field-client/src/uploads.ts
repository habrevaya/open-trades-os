import { isOffline, isSignedOut, type FieldQueue } from "./queue";
import type { Storage } from "./storage";
import type { StoreUploadResult } from "./wire";

/**
 * PHOTOGRAPHS AND SIGNATURES, WHICH ARE NOT OPERATIONS
 *
 * The operation queue carries intents of a few hundred bytes. A photograph is
 * four megabytes, and putting it in the same queue would mean one photograph
 * on one bar holds up every punch behind it. So a file goes in two halves,
 * which is how the server was built to take them:
 *
 *   The RECORD that it exists, an `attachment.attach` or `signature.capture`
 *   operation, goes through the operation queue like everything else, in
 *   order, with the hash and the size the server will check the bytes
 *   against.
 *
 *   The BYTES follow, here, once the server says it is waiting for them. They
 *   are read from a file the app copied into its own storage, never kept in
 *   the database, and the file is deleted once the server has them.
 *
 * Asking the server what it is owed, rather than remembering what was sent,
 * is what makes a lost response harmless: a photograph that arrived and whose
 * answer did not is simply no longer on the server's list.
 */

const KEY = {
  upload: (id: string) => `otos.upload.${id}`,
  prefix: "otos.upload.",
} as const;

/** A receipt is a photograph kept with an expense instead of a visit. */
export type UploadKind = "photo" | "signature" | "receipt";
export type UploadStatus = "waiting" | "sent" | "failed";

export interface UploadRecord {
  /** The file's own id, which is also the server's `clientId` for it. */
  uploadId: string;
  /** The visit it was taken at, or for a receipt the expense it is for. */
  visitId: string;
  kind: UploadKind;
  contentType: string;
  byteSize: number;
  /** SHA-256 of the bytes, hex. The server refuses bytes that do not match. */
  contentHash: string;
  /** Where the app keeps the bytes. Opaque here. */
  localUri: string;
  caption?: string | undefined;
  createdAt: string;
  /**
   * Whether the record's operation is in the operation queue. Written false
   * first and true after, so a crash between the two is found and finished
   * on the next drain rather than leaving bytes the server never hears about.
   */
  queued: boolean;
  status: UploadStatus;
  attempts: number;
  lastError?: string | undefined;
  sentAt?: string | undefined;
}

export interface UploadTransport {
  /** The upload ids the server is still waiting for bytes for. */
  owed(): Promise<string[]>;
  store(uploadId: string, base64: string, caption?: string | undefined): Promise<StoreUploadResult>;
  fail(uploadId: string, error: string): Promise<void>;
}

/** The app's half: where the bytes live on the phone. */
export interface UploadFiles {
  read(localUri: string): Promise<string>;
  remove(localUri: string): Promise<void>;
}

export interface DrainResult {
  sent: number;
  waiting: number;
  failed: number;
  error: string | null;
  /** Stopped for want of signal, or of a sign in, rather than finished. */
  offline: boolean;
  signedOut: boolean;
}

export class UploadQueue {
  private readonly storage: Storage;
  private readonly queue: FieldQueue;
  private readonly files: UploadFiles;
  private readonly now: () => Date;

  constructor(options: { storage: Storage; queue: FieldQueue; files: UploadFiles; now?: () => Date }) {
    this.storage = options.storage;
    this.queue = options.queue;
    this.files = options.files;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * A photograph or a signature, already copied into the app's storage and
   * hashed by the caller.
   *
   * The record is written before the operation, and marked queued after it,
   * so there is no moment at which a crash loses the file without a trace:
   * either the record says it still needs queueing, or the operation exists.
   */
  async add(input: {
    uploadId: string;
    visitId: string;
    kind: UploadKind;
    contentType: string;
    byteSize: number;
    contentHash: string;
    localUri: string;
    caption?: string | undefined;
    occurredAt?: Date | undefined;
  }): Promise<UploadRecord> {
    const record: UploadRecord = {
      uploadId: input.uploadId,
      visitId: input.visitId,
      kind: input.kind,
      contentType: input.contentType,
      byteSize: input.byteSize,
      contentHash: input.contentHash,
      localUri: input.localUri,
      caption: input.caption,
      createdAt: (input.occurredAt ?? this.now()).toISOString(),
      queued: false,
      status: "waiting",
      attempts: 0,
    };
    await this.save(record);
    await this.enqueueRecord(record, input.occurredAt);
    const queued = { ...record, queued: true };
    await this.save(queued);
    return queued;
  }

  async list(): Promise<UploadRecord[]> {
    const records: UploadRecord[] = [];
    for (const key of await this.storage.keys(KEY.prefix)) {
      const raw = await this.storage.get(key);
      if (!raw) continue;
      try {
        records.push(JSON.parse(raw) as UploadRecord);
      } catch {
        // Half written in a crash. The operation, if it exists, still tells
        // the server a file is owed, and the office can see it never came.
        continue;
      }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Send whatever bytes the server is waiting for.
   *
   * Call it after the operation queue has been flushed, so a record that has
   * just landed is on the server's list. Stops at the first sign of no
   * signal, because every remaining file would fail the same way and each
   * attempt costs battery.
   */
  async drain(transport: UploadTransport): Promise<DrainResult> {
    let records = await this.list();

    // Finish anything a crash interrupted between the record and its operation.
    for (const record of records.filter((r) => !r.queued && r.status === "waiting")) {
      await this.enqueueRecord(record);
      await this.save({ ...record, queued: true });
    }
    records = await this.list();

    const outstanding = records.filter((r) => r.status === "waiting");
    let sent = 0;
    let failed = 0;
    const counts = (error: string | null, cause?: unknown): DrainResult => ({
      sent, waiting: outstanding.length - sent - failed, failed, error,
      offline: cause !== undefined && isOffline(cause),
      signedOut: cause !== undefined && isSignedOut(cause),
    });
    if (outstanding.length === 0) return counts(null);

    let owed: Set<string>;
    try {
      owed = new Set(await transport.owed());
    } catch (error) {
      return counts(messageOf(error), error);
    }

    /**
     * Where each file's operation is, so a file the server has not asked for
     * can be told apart: still queued, refused, or already delivered.
     */
    const operations = new Map<string, { status: string; lastError?: string | undefined }>();
    for (const op of await this.queue.pending()) {
      const id = op.payload["uploadId"];
      if (typeof id === "string") operations.set(id, { status: op.status, lastError: op.lastError });
    }

    for (const record of outstanding) {
      if (owed.has(record.uploadId)) {
        let bytes: string;
        try {
          bytes = await this.files.read(record.localUri);
        } catch {
          /**
           * The file has gone from the phone: storage cleared, or the app
           * reinstalled over it. Said to the server, so the office sees a
           * photograph that will never come rather than one still coming.
           */
          const reason = "The file is no longer on the phone, so it cannot be sent.";
          try { await transport.fail(record.uploadId, reason); } catch { /* said again next time */ }
          await this.save({ ...record, status: "failed", lastError: reason });
          failed += 1;
          continue;
        }

        let outcome: StoreUploadResult;
        try {
          outcome = await transport.store(record.uploadId, bytes, record.caption);
        } catch (error) {
          if (isOffline(error)) return counts(messageOf(error), error);
          await this.save({ ...record, attempts: record.attempts + 1, lastError: messageOf(error) });
          continue;
        }

        if (outcome.stored) {
          await this.markSent(record);
          sent += 1;
        } else if (outcome.willRetry) {
          await this.save({ ...record, attempts: outcome.attempts, lastError: outcome.reason ?? undefined });
        } else {
          await this.save({
            ...record, status: "failed", attempts: outcome.attempts,
            lastError: outcome.reason ?? "The server would not take this file.",
          });
          failed += 1;
        }
        continue;
      }

      const op = operations.get(record.uploadId);
      if (op && op.status === "rejected") {
        await this.save({
          ...record, status: "failed",
          lastError: op.lastError ?? "The record of this file was refused, so the server is not expecting it.",
        });
        failed += 1;
        continue;
      }
      // Its record has not reached the server yet. The next drain sends it.
      if (op) continue;

      /**
       * Not owed and no record on the phone: the record landed and the
       * server has the bytes, from an earlier attempt whose answer was lost.
       */
      await this.markSent(record);
      sent += 1;
    }

    return counts(null);
  }

  /** Forget a file the technician has given up on, and its bytes. */
  async dismiss(uploadId: string): Promise<boolean> {
    const raw = await this.storage.get(KEY.upload(uploadId));
    if (!raw) return false;
    const record = JSON.parse(raw) as UploadRecord;
    try { await this.files.remove(record.localUri); } catch { /* already gone */ }
    await this.storage.remove(KEY.upload(uploadId));
    return true;
  }

  /**
   * Drop the bookkeeping for files the server has had for a while. Kept for a
   * few days so the visit can still say "3 photos sent" after the bytes are
   * gone from the phone.
   */
  async prune(olderThanDays = 7): Promise<number> {
    const cutoff = this.now().getTime() - olderThanDays * 864e5;
    let removed = 0;
    for (const record of await this.list()) {
      if (record.status === "sent" && record.sentAt && new Date(record.sentAt).getTime() < cutoff) {
        await this.storage.remove(KEY.upload(record.uploadId));
        removed += 1;
      }
    }
    return removed;
  }

  private async markSent(record: UploadRecord): Promise<void> {
    await this.save({ ...record, status: "sent", sentAt: this.now().toISOString(), lastError: undefined });
    try { await this.files.remove(record.localUri); } catch { /* gone is what we wanted */ }
  }

  private async enqueueRecord(record: UploadRecord, occurredAt?: Date): Promise<void> {
    const payload: Record<string, unknown> = {
      uploadId: record.uploadId,
      contentType: record.contentType,
      byteSize: record.byteSize,
      contentHash: record.contentHash,
      ...(record.caption ? { caption: record.caption } : {}),
    };
    await this.queue.enqueue({
      kind: record.kind === "signature" ? "signature.capture" : "attachment.attach",
      subjectId: record.visitId,
      payload: record.kind === "receipt" ? { ...payload, entityType: "expense" } : payload,
      occurredAt: occurredAt ?? new Date(record.createdAt),
    });
  }

  private async save(record: UploadRecord): Promise<void> {
    await this.storage.set(KEY.upload(record.uploadId), JSON.stringify(record));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
