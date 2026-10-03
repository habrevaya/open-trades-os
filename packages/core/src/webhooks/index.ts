/**
 * WEBHOOK DELIVERY HISTORY AND REPLAY, THE RULES WITHOUT THE DATABASE
 *
 * Three decisions that would otherwise be made inline in the delivery pass,
 * where a test has to stand up a receiver to reach them: how much of a
 * response is kept, how long and how many attempts are kept, and what range
 * a replay request actually means.
 */

/**
 * How much of a receiver's answer is kept per attempt, in characters.
 *
 * Enough for the first screen of a JSON error, a stack trace's top frames,
 * or the title of an HTML error page, which between them are what anybody
 * debugging a receiver reads. A receiver answering every retry with a
 * megabyte of HTML would otherwise grow the history by a megabyte a minute,
 * on a table whose entire purpose is to be read when something is wrong.
 */
export const EXCERPT_LIMIT = 2000;

/**
 * How many attempts are kept per endpoint, newest first, and for how long.
 *
 * Both, because each alone fails one way. A count alone keeps a quiet
 * endpoint's attempts from two years ago, which is customer data sitting in a
 * debugging table long after anybody could want it. An age alone lets a busy
 * endpoint retrying every thirty seconds keep a month of rows. Whichever cuts
 * first wins.
 */
export const KEEP_PER_ENDPOINT = 1000;
export const KEEP_DAYS = 30;

/**
 * The most events one replay request may cover.
 *
 * A replay is a request to somebody else's server per event, in order, and
 * the receiver is usually the thing that just broke. "Everything since the
 * company started" is not a replay, it is a migration, and the receiver
 * should be loading from the API instead.
 */
export const MAX_REPLAY_EVENTS = 5000;

/**
 * What is kept of a response body.
 *
 * NUL is removed, because Postgres text cannot hold it and one byte of a
 * binary answer would otherwise fail the write that records the attempt,
 * which is the one write that must not fail. The cut never lands inside a
 * surrogate pair, so an excerpt ending in an emoji is not stored as half a
 * character. What was cut is said, with how much, rather than left to look
 * like the whole answer.
 */
export function excerpt(body: string | null | undefined, limit = EXCERPT_LIMIT): string | null {
  if (body === null || body === undefined) return null;
  const clean = body.split("\u0000").join("");
  if (clean.trim() === "") return null;
  if (clean.length <= limit) return clean;

  let end = limit;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)}\n[${clean.length - end} more characters not kept]`;
}

/** The oldest attempt still worth keeping. */
export function retentionCutoff(now: Date, days = KEEP_DAYS): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * What one attempt came to, in three words a screen can filter by.
 *
 * `refused` and `unreachable` are separate because they are different
 * mornings: a receiver answering 500 is up and broken, one that never
 * answered is down, or the address is wrong, or a firewall moved.
 */
export type DeliveryStatus = "delivered" | "refused" | "unreachable";
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["delivered", "refused", "unreachable"];

export function statusOf(attempt: { ok: boolean; responseStatus: number | null }): DeliveryStatus {
  if (attempt.ok) return "delivered";
  return attempt.responseStatus === null ? "unreachable" : "refused";
}

/**
 * A replay request, turned into the range it covers, or the reason it
 * cannot be one.
 *
 * `through` is FIXED when the request is made, at the newest event there is.
 * A replay that kept reading as new events arrived would never finish, and
 * would send each new event twice: once live and once as a replay.
 *
 * `position` starts one before `from`, because it is "the last sequence this
 * replay has had answered", and nothing has been yet.
 */
export type ReplayRange =
  | { ok: true; fromSequence: number; throughSequence: number; position: number }
  | { ok: false; reason: string };

export function replayRange(input: {
  from: number;
  through?: number | null | undefined;
  /** The newest sequence in this company's log right now. */
  newest: number;
}): ReplayRange {
  const { from, newest } = input;
  if (!Number.isInteger(from) || from < 1) {
    return { ok: false, reason: "A replay starts at an event in the log, which is numbered from 1." };
  }
  if (newest < 1) return { ok: false, reason: "Nothing has happened yet, so there is nothing to send again." };
  if (from > newest) {
    return { ok: false, reason: `The log ends at event ${newest}, so there is nothing from ${from} to send again.` };
  }
  const through = input.through ?? newest;
  if (!Number.isInteger(through) || through < from) {
    return { ok: false, reason: "That range ends before it starts." };
  }
  if (through > newest) {
    return { ok: false, reason: `The log ends at event ${newest}. A replay cannot send what has not happened.` };
  }
  if (through - from + 1 > MAX_REPLAY_EVENTS) {
    return {
      ok: false,
      reason: `That is ${through - from + 1} events, and a replay sends at most ${MAX_REPLAY_EVENTS}. `
        + "Replay a shorter range, or load the history from the API.",
    };
  }
  return { ok: true, fromSequence: from, throughSequence: through, position: from - 1 };
}
