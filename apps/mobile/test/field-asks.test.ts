import { describe, it, expect } from "vitest";
import { callOffLabel, canCallOff, checkCallOff, CALL_OFF_CHOICES } from "@opentradesos/field-client";
import { partAskedLine } from "../src/lib/work";

/**
 * The visit screen's two asks of the office, without the screen: calling the
 * visit off from the door and asking for a part. The rules are the field
 * client's; this pins what the phone shows and offers.
 */
describe("calling a visit off on the visit screen", () => {
  const zone = "America/Chicago";
  const now = new Date("2026-10-02T20:00:00Z");

  it("is offered on today's visits nobody has started, and on no other", () => {
    expect(canCallOff({ stage: "arrived", windowStart: "2026-10-02T15:00:00Z" }, zone, now)).toBe(true);
    expect(canCallOff({ stage: "working", windowStart: "2026-10-02T15:00:00Z" }, zone, now)).toBe(false);
    expect(canCallOff({ stage: "upcoming", windowStart: "2026-10-03T15:00:00Z" }, zone, now)).toBe(false);
  });

  it("lists the customer first and then the company's own reasons, in the words on the buttons", () => {
    expect(CALL_OFF_CHOICES.map((c) => callOffLabel(c.value))).toEqual([
      "The customer turned us away",
      "We called it off: rain or weather",
      "We called it off: crew short",
      "We called it off: equipment",
      "We called it off: something else",
    ]);
    expect(checkCallOff("", "")).toMatchObject({ ok: false });
  });
});

describe("a part asked for, on the visit screen", () => {
  it("says where it is: on the phone, with the office, or ordered with the job on hold", () => {
    expect(partAskedLine({ part: "Fan motor", held: false, waiting: true })).toBe("Fan motor: waiting to send");
    expect(partAskedLine({ part: "Fan motor", held: false, waiting: false })).toBe("Fan motor: with the office");
    expect(partAskedLine({ part: "Fan motor", held: true, waiting: false })).toBe("Fan motor: ordered, and the job is on hold for it");
  });
});
