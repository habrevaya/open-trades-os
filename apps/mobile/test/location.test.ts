import { describe, it, expect } from "vitest";
import type { SharingState } from "@opentradesos/field-client";
import { fixFrom, locationLine, shouldTrack } from "../src/lib/location";

/**
 * What the phone decides about its location, without the phone: when the
 * operating system should be asked for fixes, what one fix becomes on the
 * wire, and the line the person reads at the top of their day.
 */

const on: SharingState = {
  state: { sharing: true, reason: "on_the_way", visitId: "v1" },
  sentence: "Sharing your location while you are on the way to Nina Patel. Nina Patel can see you on their tracking link until you arrive.",
  intervalSeconds: 60,
};
const offTheClock: SharingState = {
  state: { sharing: false, reason: "off_the_clock" },
  sentence: "Not sharing your location: you are off the clock and not on a visit.",
  intervalSeconds: 60,
};
const companyOff: SharingState = { state: { sharing: false, reason: "company_off" }, sentence: "x", intervalSeconds: 60 };

describe("when the phone takes fixes", () => {
  it("only while sharing is due and the phone allows it", () => {
    expect(shouldTrack(on, "always")).toBe(true);
    expect(shouldTrack(on, "while_open")).toBe(true);
    expect(shouldTrack(on, "denied")).toBe(false);
    expect(shouldTrack(offTheClock, "always")).toBe(false);
    expect(shouldTrack(null, "always")).toBe(false);
  });
});

describe("one fix on the wire", () => {
  const base = { coords: { latitude: 30.27, longitude: -97.74, accuracy: 12.4, heading: 370, speed: 11.2 }, timestamp: Date.UTC(2026, 9, 2, 15) };

  it("keeps what the phone knows and says when it was taken", () => {
    expect(fixFrom(base)).toEqual({
      latitude: 30.27, longitude: -97.74, accuracyMeters: 12, heading: 10, speed: 11.2,
      recordedAt: "2026-10-02T15:00:00.000Z",
    });
  });

  it("leaves out what the phone does not know, and refuses a faked GPS", () => {
    expect(fixFrom({ ...base, coords: { ...base.coords, heading: -1, speed: -1, accuracy: null } }))
      .toEqual({ latitude: 30.27, longitude: -97.74, recordedAt: "2026-10-02T15:00:00.000Z" });
    expect(fixFrom({ ...base, mocked: true })).toBeNull();
  });
});

describe("the line at the top of the day", () => {
  it("says it is sharing, and with whom, every time it is", () => {
    expect(locationLine(on, "always")).toEqual({ tone: "on", text: on.sentence });
    expect(locationLine(on, "while_open")!.text).toMatch(/Only while the app is open/);
  });

  it("says plainly when the phone's setting is what stops it", () => {
    expect(locationLine(on, "denied")).toMatchObject({ tone: "problem" });
    expect(locationLine(on, "denied")!.text).toMatch(/no pin/);
  });

  it("says it is not sharing off the clock, and nothing when the company does not use it", () => {
    expect(locationLine(offTheClock, "always")).toEqual({ tone: "off", text: offTheClock.sentence });
    expect(locationLine(companyOff, "always")).toBeNull();
  });
});
