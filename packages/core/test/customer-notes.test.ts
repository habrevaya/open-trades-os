import { describe, it, expect } from "vitest";
import {
  normalizeNote, mayEdit, editableUntil, EDIT_WINDOW_MINUTES, MAX_NOTE_LENGTH,
} from "../src/customer-notes/index.js";

const AUTHOR = "00000000-0000-4000-8000-000000000001";
const SOMEBODY_ELSE = "00000000-0000-4000-8000-000000000002";
const written = new Date("2026-10-14T15:00:00Z");
const minutesLater = (n: number) => new Date(written.getTime() + n * 60_000);

describe("a note as somebody typed it", () => {
  it("trims the ends and keeps the lines inside", () => {
    expect(normalizeNote("  Prefers mornings.\r\nSide gate sticks.  ")).toEqual({
      ok: true, body: "Prefers mornings.\nSide gate sticks.",
    });
  });

  it("refuses an empty note and one that is a document", () => {
    expect(normalizeNote("   \n ").ok).toBe(false);
    expect(normalizeNote("x".repeat(MAX_NOTE_LENGTH)).ok).toBe(true);
    const long = normalizeNote("x".repeat(MAX_NOTE_LENGTH + 1));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toMatch(/Split it into two notes/);
  });
});

describe("who may change a note, and for how long", () => {
  const typed = { origin: "typed", authorUserId: AUTHOR, createdAt: written };

  it("lets its author fix it for a short while", () => {
    expect(mayEdit(typed, AUTHOR, minutesLater(1))).toEqual({ ok: true });
    expect(mayEdit(typed, AUTHOR, minutesLater(EDIT_WINDOW_MINUTES))).toEqual({ ok: true });
    expect(editableUntil(typed)).toEqual(minutesLater(EDIT_WINDOW_MINUTES));
  });

  it("after that a correction is a new note", () => {
    const late = mayEdit(typed, AUTHOR, minutesLater(EDIT_WINDOW_MINUTES + 1));
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.message).toMatch(/Add a new note to correct it/);
  });

  it("never lets somebody else change it", () => {
    const other = mayEdit(typed, SOMEBODY_ELSE, minutesLater(1));
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.message).toMatch(/Only the person who wrote a note/);
  });

  it("leaves a note from a file or the old notes box as it was", () => {
    for (const origin of ["imported", "carried"]) {
      const note = { origin, authorUserId: null, createdAt: written };
      expect(mayEdit(note, AUTHOR, minutesLater(1)).ok).toBe(false);
      expect(editableUntil(note)).toBeNull();
    }
  });
});
