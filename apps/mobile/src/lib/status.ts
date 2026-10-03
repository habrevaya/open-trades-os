/**
 * THE LINE UNDER THE DATE
 *
 * The one thing a technician glances at to know whether the office has their
 * work. Three tones, and they mean something: nothing waiting, something
 * waiting that will go by itself, and something that needs them.
 */
export interface SyncState {
  waiting: number;
  uploadsWaiting: number;
  problems: number;
  syncing: boolean;
  offline: boolean;
  signedOut: boolean;
  backoffUntil: Date | null;
  lastSyncedAt: string | null;
}

export type Tone = "ok" | "waiting" | "problem";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function syncLine(state: SyncState, zone: string, now: Date = new Date()): { text: string; tone: Tone } {
  if (state.signedOut) {
    return { text: "Signed out. Sign in again to send your work.", tone: "problem" };
  }

  const parts: string[] = [];
  if (state.waiting > 0) parts.push(plural(state.waiting, "update", "updates"));
  if (state.uploadsWaiting > 0) parts.push(plural(state.uploadsWaiting, "photo", "photos"));

  if (parts.length === 0) {
    if (state.problems > 0) return { text: plural(state.problems, "thing needs", "things need") + " a look", tone: "problem" };
    if (state.syncing) return { text: "Checking for changes", tone: "ok" };
    return { text: state.lastSyncedAt ? `All sent, ${since(state.lastSyncedAt, zone, now)}` : "All sent", tone: "ok" };
  }

  const what = `${parts.join(" and ")} waiting to send`;
  if (state.syncing) return { text: `Sending ${parts.join(" and ")}`, tone: "waiting" };
  if (state.offline) {
    const next = state.backoffUntil && state.backoffUntil > now
      ? `, trying again at ${clock(state.backoffUntil, zone)}`
      : "";
    return { text: `No signal. ${what}${next}`, tone: "waiting" };
  }
  return { text: what, tone: state.problems > 0 ? "problem" : "waiting" };
}

function clock(at: Date, zone: string): string {
  return at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
}

function since(iso: string, zone: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${clock(new Date(iso), zone)}`;
}
