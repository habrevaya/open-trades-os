import { describe, it, expect } from "vitest";
import { webhooks } from "../src/index";

/**
 * WHAT A DELIVERY'S HISTORY KEEPS, AND WHAT A REPLAY MEANS
 *
 * The rules the delivery pass applies to every attempt and every replay
 * request, tested without a receiver. Each of these is a way the history
 * could grow without bound or a replay could send something nobody asked
 * for.
 */

describe("the excerpt of a response", () => {
  it("keeps a short answer whole", () => {
    expect(webhooks.excerpt('{"ok":true}')).toBe('{"ok":true}');
  });

  it("keeps nothing for an empty answer rather than an empty string", () => {
    expect(webhooks.excerpt("")).toBeNull();
    expect(webhooks.excerpt("   \n")).toBeNull();
    expect(webhooks.excerpt(null)).toBeNull();
    expect(webhooks.excerpt(undefined)).toBeNull();
  });

  it("cuts a long answer at the limit and says how much it left out", () => {
    const body = "x".repeat(webhooks.EXCERPT_LIMIT + 250);
    const kept = webhooks.excerpt(body)!;
    expect(kept.startsWith("x".repeat(webhooks.EXCERPT_LIMIT))).toBe(true);
    expect(kept).toMatch(/\[250 more characters not kept\]$/);
  });

  it("removes NUL, which Postgres text cannot hold", () => {
    expect(webhooks.excerpt("a\u0000b")).toBe("ab");
  });

  it("never stores half a character", () => {
    const body = `${"x".repeat(9)}\u{1F600}tail`;
    const kept = webhooks.excerpt(body, 10)!;
    /** The emoji is two code units and the cut fell between them. */
    expect(kept.startsWith("x".repeat(9))).toBe(true);
    expect(kept.charCodeAt(9)).toBe("\n".charCodeAt(0));
  });
});

describe("what is kept", () => {
  it("keeps thirty days", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    expect(webhooks.retentionCutoff(now).toISOString()).toBe("2026-09-02T12:00:00.000Z");
  });

  it("calls an attempt delivered, refused or unreachable", () => {
    expect(webhooks.statusOf({ ok: true, responseStatus: 200 })).toBe("delivered");
    expect(webhooks.statusOf({ ok: false, responseStatus: 500 })).toBe("refused");
    expect(webhooks.statusOf({ ok: false, responseStatus: null })).toBe("unreachable");
  });
});

describe("a replay's range", () => {
  it("runs from the point asked for to the newest event there is now, and no further", () => {
    expect(webhooks.replayRange({ from: 40, newest: 52 })).toEqual({
      ok: true, fromSequence: 40, throughSequence: 52, position: 39,
    });
  });

  it("takes an end inside the log", () => {
    expect(webhooks.replayRange({ from: 40, through: 41, newest: 52 })).toMatchObject({
      ok: true, fromSequence: 40, throughSequence: 41,
    });
  });

  it("refuses a range that ends before it starts, or past what has happened", () => {
    expect(webhooks.replayRange({ from: 40, through: 39, newest: 52 }).ok).toBe(false);
    expect(webhooks.replayRange({ from: 40, through: 60, newest: 52 }).ok).toBe(false);
    expect(webhooks.replayRange({ from: 60, newest: 52 }).ok).toBe(false);
    expect(webhooks.replayRange({ from: 0, newest: 52 }).ok).toBe(false);
    expect(webhooks.replayRange({ from: 1, newest: 0 }).ok).toBe(false);
  });

  it("refuses more events than a replay is for, and says what to do instead", () => {
    const result = webhooks.replayRange({ from: 1, newest: webhooks.MAX_REPLAY_EVENTS + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/at most 5000.*API/s);
    expect(webhooks.replayRange({ from: 2, newest: webhooks.MAX_REPLAY_EVENTS + 1 }).ok).toBe(true);
  });
});
