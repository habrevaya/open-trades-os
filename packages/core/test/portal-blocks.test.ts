import { describe, it, expect } from "vitest";
import {
  composeBlocks, readingKeys, attributeLabel, ALWAYS_SHOWN, occupiedMinutes, windowCapacity,
  readPortalSettings,
} from "../src/customer-portal/index.js";

/**
 * WHAT A CUSTOMER'S ACCOUNT SHOWS, AND HOW MUCH MORE WORK A WINDOW HOLDS
 *
 * The two pure decisions behind the account page and online booking: which
 * blocks a trade's layout draws (and which every account draws regardless),
 * and how many more jobs of one length fit in an arrival window given who is
 * on, who is off and what they already have.
 */

describe("the blocks on a customer's account", () => {
  it("draws the pack's blocks in its order, with its words, then what every account shows", () => {
    const blocks = composeBlocks([
      { kind: "service_report", title: "What we did and what we used" },
      { kind: "next_visit" },
      { kind: "readings_trend", title: "Activity", config: { keys: ["stations_serviced"] } },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual([
      "service_report", "next_visit", "readings_trend", "visit_timeline", "invoices", "plan_status", "equipment_register",
    ]);
    expect(blocks[0]).toMatchObject({ title: "What we did and what we used", declared: true });
    expect(blocks[1]).toMatchObject({ title: "Coming up", declared: true });
    expect(blocks[2]!.config).toEqual({ keys: ["stations_serviced"] });
    expect(blocks.at(-1)).toMatchObject({ kind: "equipment_register", declared: false });
  });

  it("shows a company with no pack its history, bills, plan and equipment all the same", () => {
    expect(composeBlocks([]).map((b) => b.kind)).toEqual([...ALWAYS_SHOWN]);
  });

  it("drops hidden blocks, kinds it does not know and a kind named twice", () => {
    const blocks = composeBlocks([
      { kind: "photo_gallery", visible: false },
      { kind: "weather_forecast" },
      { kind: "contact_card", title: "Your team" },
      { kind: "contact_card", title: "Again" },
      { kind: "documents", config: [1, 2] },
    ]);
    expect(blocks.filter((b) => b.declared).map((b) => b.kind)).toEqual(["contact_card", "documents"]);
    expect(blocks.find((b) => b.kind === "contact_card")!.title).toBe("Your team");
    expect(blocks.find((b) => b.kind === "documents")!.config).toEqual({});
  });

  it("asks a trend for at most six named readings, once each", () => {
    expect(readingKeys({ keys: ["a", "b", "a", "", 4, "c", "d", "e", "f", "g"] })).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(readingKeys({})).toEqual([]);
  });

  it("names an attribute from its key when the pack gives no label", () => {
    expect(attributeLabel("filter_size")).toBe("Filter size");
  });

  it("keeps bank payments off until the company turns them on", () => {
    expect(readPortalSettings(undefined).bankAccounts).toBe(false);
    expect(readPortalSettings({ bankAccounts: "yes" }).bankAccounts).toBe(false);
    expect(readPortalSettings({ bankAccounts: true }).bankAccounts).toBe(true);
  });
});

describe("how many more jobs fit in a window", () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 9, 6, hour));
  const morning = { start: at(8), end: at(12) };

  it("counts only the part of a visit inside the window", () => {
    expect(occupiedMinutes(morning, [{ start: at(11), minutes: 180 }])).toBe(60);
    expect(occupiedMinutes(morning, [{ start: at(6), minutes: 180 }])).toBe(60);
    expect(occupiedMinutes(morning, [{ start: at(13), minutes: 60 }])).toBe(0);
  });

  it("fits whole jobs into each person's free time, and nothing from somebody away or unqualified", () => {
    const capacity = windowCapacity({
      window: morning,
      durationMinutes: 90,
      waitingMinutes: 0,
      technicians: [
        { id: "ray", busy: [{ start: at(8), minutes: 60 }], away: false, qualified: true },
        { id: "dana", busy: [], away: true, qualified: true },
        { id: "sam", busy: [], away: false, qualified: false },
        { id: "lee", busy: [], away: false, qualified: true },
      ],
    });
    expect(capacity.byTechnician.get("ray")).toBe(2);
    expect(capacity.byTechnician.get("dana")).toBe(0);
    expect(capacity.byTechnician.get("sam")).toBe(0);
    expect(capacity.byTechnician.get("lee")).toBe(2);
    expect(capacity.jobs).toBe(4);
  });

  it("takes the work waiting for somebody off the total first", () => {
    const capacity = windowCapacity({
      window: morning, durationMinutes: 120, waitingMinutes: 150,
      technicians: [{ id: "ray", busy: [], away: false, qualified: true }, { id: "lee", busy: [], away: false, qualified: true }],
    });
    expect(capacity.jobs).toBe(2);
  });

  it("needs the whole window for a job longer than it, and offers nothing in a full one", () => {
    const long = windowCapacity({
      window: morning, durationMinutes: 480, waitingMinutes: 0,
      technicians: [{ id: "ray", busy: [{ start: at(9), minutes: 30 }], away: false, qualified: true }],
    });
    expect(long.jobs).toBe(0);
    const empty = windowCapacity({
      window: morning, durationMinutes: 480, waitingMinutes: 0,
      technicians: [{ id: "ray", busy: [], away: false, qualified: true }],
    });
    expect(empty.jobs).toBe(1);
  });
});
