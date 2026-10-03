import { location } from "@opentradesos/core";
import { isOffline, type PositionFix, type SyncResponse, type Transport } from "./queue";
import type { Storage } from "./storage";
import type { DayView } from "./day";
import type { LocationSharing } from "./wire";

/**
 * WHERE THE PHONE WAS, WHILE ITS PERSON WAS WORKING
 *
 * Two halves, and only the second touches the operating system.
 *
 * `sharingFor` decides, from the day on the phone and the company's settings
 * as the server last sent them, whether the phone should be taking fixes at
 * all and why, using core's rule: only while clocked in, on the way to a
 * visit or working one, and only when the company and this person have it
 * on. It runs offline, because the day does. The app starts and stops the
 * operating system's location updates on its answer and shows the person
 * the sentence that goes with it every time it is on.
 *
 * `PositionBuffer` keeps the fixes on the phone until the next sync sends
 * them. Positions are not operations: no sequence, no conflict rule, and one
 * that is lost costs nothing, so they do not go through the queue that
 * guards a payroll record. They are thinned (a parked van sends one every
 * few minutes, not one a minute), capped (a phone with no signal for a day
 * keeps the newest, not a growing file), and THROWN AWAY when sharing turns
 * off, so a fix taken just before somebody clocked out and turned the app
 * off never leaves the phone after it.
 */

export interface SharingState {
  state: location.Sharing;
  /** The sentence the technician reads. */
  sentence: string;
  intervalSeconds: number;
}

/** The visit the person is on the way to or working, the one their fixes belong to. */
function activeVisit(day: DayView): { id: string; stage: "en_route" | "working"; name: string } | null {
  const onTheWay = day.visits.find((v) => v.stage === "en_route");
  if (onTheWay) return { id: onTheWay.id, stage: "en_route", name: onTheWay.customer.name };
  const working = day.visits.find((v) => v.stage === "working" || v.stage === "arrived");
  if (working) return { id: working.id, stage: "working", name: working.customer.name };
  return null;
}

export function sharingFor(day: DayView, settings: LocationSharing | null | undefined): SharingState {
  const visit = activeVisit(day);
  const state = location.sharingNow({
    companyEnabled: settings?.companyEnabled ?? false,
    personEnabled: settings?.personEnabled ?? false,
    clockedIn: day.clock.open,
    visit: visit ? { id: visit.id, stage: visit.stage } : null,
  });
  return {
    state,
    sentence: location.describeSharing(state, visit?.name ?? null),
    intervalSeconds: settings?.intervalSeconds ?? location.SHARING_DEFAULTS.intervalSeconds,
  };
}

const KEY = "otos.positions";

export interface PositionBufferOptions {
  storage: Storage;
  deviceId: string;
  /** The most fixes kept unsent. The newest are kept. */
  maxFixes?: number;
  /** Keep a fix this long after the last kept one, or ... */
  minSeconds?: number;
  /** ... this far from it. */
  minMeters?: number;
  /** Fixes per request. */
  batchSize?: number;
}

export class PositionBuffer {
  private readonly options: Required<Omit<PositionBufferOptions, "storage" | "deviceId">> & PositionBufferOptions;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: PositionBufferOptions) {
    this.options = { maxFixes: 500, minSeconds: 180, minMeters: 75, batchSize: 200, ...options };
  }

  /** One read-modify-write at a time, for the reason the queue gives. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  async pending(): Promise<PositionFix[]> {
    const raw = await this.options.storage.get(KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as PositionFix[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async save(fixes: PositionFix[]): Promise<void> {
    if (fixes.length === 0) await this.options.storage.remove(KEY);
    else await this.options.storage.set(KEY, JSON.stringify(fixes));
  }

  /**
   * Keep a fix, if it says something the last one did not. Only call this
   * while `sharingFor` says sharing is on: the buffer does not know the day.
   */
  record(fix: PositionFix): Promise<boolean> {
    return this.serial(async () => {
      const all = await this.pending();
      const asFix = (f: PositionFix) => ({ ...f, recordedAt: new Date(f.recordedAt) });
      const last = all[all.length - 1];
      if (last) {
        const kept = location.thin([asFix(last), asFix(fix)], {
          minSeconds: this.options.minSeconds, minMeters: this.options.minMeters,
        });
        if (kept.length < 2) return false;
      }
      const next = [...all, fix].slice(-this.options.maxFixes);
      await this.save(next);
      return true;
    });
  }

  /** Throw away what has not been sent, because sharing stopped. */
  clear(): Promise<void> {
    return this.serial(() => this.save([]));
  }

  /**
   * Send what is waiting, through the field sync, oldest first. What was sent
   * is removed once the server answers, whatever it kept: a fix it dropped
   * is one it will drop again. With no signal everything stays.
   */
  async flush(transport: Transport): Promise<{ sent: number; stored: number; offline: boolean; error: string | null }> {
    let sent = 0;
    let stored = 0;
    for (;;) {
      const batch = (await this.pending()).slice(0, this.options.batchSize);
      if (batch.length === 0) return { sent, stored, offline: false, error: null };
      let answer: SyncResponse;
      try {
        answer = await transport.send({ deviceId: this.options.deviceId, operations: [], positions: batch });
      } catch (error) {
        return {
          sent, stored, offline: isOffline(error),
          error: isOffline(error) ? null : error instanceof Error ? error.message : String(error),
        };
      }
      const gone = new Set(batch.map((f) => f.recordedAt));
      await this.serial(async () => this.save((await this.pending()).filter((f) => !gone.has(f.recordedAt))));
      sent += batch.length;
      stored += answer.positions?.stored ?? 0;
    }
  }
}
