import { describe, it, expect } from "vitest";
import { CUSTOMER_NOTES_LIMIT, customerNoteLine, customerNotesToShow, projectDay, type FieldCustomerNote } from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * THE OFFICE'S NOTES, ON THE PHONE'S VISIT
 *
 * Pinned first whatever order the day was saved in, newest first after that, at
 * most twenty, dated in the company's zone, and carried through the day with the
 * visit so they are there with no signal.
 */
const note = (id: string, over: Partial<FieldCustomerNote> = {}): FieldCustomerNote => ({
  id, body: `Note ${id}`, notedAt: "2026-10-05T14:00:00.000Z", pinned: false, by: "Dana", ...over,
});

describe("which notes the visit shows and in what order", () => {
  it("puts pinned ones first, then the newest, and keeps the order of two written together", () => {
    const sent = [
      note("old", { notedAt: "2026-08-01T10:00:00.000Z" }),
      note("new", { notedAt: "2026-10-05T10:00:00.000Z" }),
      note("pin-old", { pinned: true, notedAt: "2026-07-01T10:00:00.000Z" }),
      note("pin-new", { pinned: true, notedAt: "2026-09-01T10:00:00.000Z" }),
      note("tie-a", { notedAt: "2026-06-01T10:00:00.000Z" }),
      note("tie-b", { notedAt: "2026-06-01T10:00:00.000Z" }),
    ];
    expect(customerNotesToShow(sent).map((n) => n.id)).toEqual(["pin-new", "pin-old", "new", "old", "tie-a", "tie-b"]);
  });

  it("shows at most twenty, and does not change what it was given", () => {
    const sent = Array.from({ length: 25 }, (_, i) => note(`n${i}`, { notedAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString() }));
    const before = sent.map((n) => n.id);
    const shown = customerNotesToShow(sent);
    expect(shown).toHaveLength(CUSTOMER_NOTES_LIMIT);
    expect(shown[0]!.id).toBe("n24");
    expect(sent.map((n) => n.id)).toEqual(before);
  });

  it("is empty from a server too old to send any, and when the office marked none", () => {
    expect(customerNotesToShow(undefined)).toEqual([]);
    expect(customerNotesToShow([])).toEqual([]);
  });
});

describe("the line under a note", () => {
  it("says pinned, who wrote it and the day", () => {
    expect(customerNoteLine(note("a", { pinned: true }), "America/Chicago")).toBe("Pinned. Dana, Oct 5, 2026");
    expect(customerNoteLine(note("a"), "America/Chicago")).toBe("Dana, Oct 5, 2026");
  });

  it("says no writer for a note carried over or brought in from a file", () => {
    expect(customerNoteLine(note("a", { by: null }), "America/Chicago")).toBe("Oct 5, 2026");
  });

  it("dates a Texas evening as that evening, not tomorrow in UTC", () => {
    const evening = note("a", { notedAt: "2026-10-06T02:30:00.000Z" });
    expect(customerNoteLine(evening, "America/Chicago")).toBe("Dana, Oct 5, 2026");
    expect(customerNoteLine(evening, "UTC")).toBe("Dana, Oct 6, 2026");
  });
});

describe("on the way to the phone", () => {
  it("comes through the day with the visit", () => {
    const server = new FakeServer();
    server.addVisit("v1", { customerNotes: [note("a", { pinned: true })] });
    const day = projectDay({ snapshot: { revision: 1, unchanged: false, visits: [...server.visits.values()], priceBook: [], openTimeEntry: null }, operations: [] });
    expect(day.visits[0]!.customerNotes).toEqual([note("a", { pinned: true })]);
  });
});
