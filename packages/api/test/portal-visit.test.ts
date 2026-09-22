import { describe, it, expect } from "vitest";
import { pickVisit, CUSTOMER_VISIT_STATUS } from "../src/services/portal";
import { schema } from "@opentradesos/db";

const NOW = new Date("2026-03-10T15:00:00Z");
const at = (iso: string) => new Date(iso);

const visit = (over: Partial<Parameters<typeof pickVisit>[0][number]> & { id: string }) => ({
  status: "scheduled",
  windowStart: null,
  windowEnd: null,
  technicianName: null,
  ...over,
});

/**
 * Which visit the tracking page describes.
 *
 * The customer is refreshing this because somebody is supposed to be at their
 * house. Showing them the date of visit one of a four visit maintenance
 * agreement, because it sorts first, is the failure this guards against.
 */
describe("picking the visit a customer is asking about", () => {
  it("returns nothing for a job with no visits", () => {
    expect(pickVisit([], NOW)).toBeNull();
  });

  it("prefers the visit in progress over anything scheduled", () => {
    const chosen = pickVisit([
      visit({ id: "march", status: "completed", windowStart: at("2026-03-01T14:00:00Z") }),
      visit({ id: "today", status: "working", windowStart: at("2026-03-10T14:00:00Z") }),
      visit({ id: "june", status: "scheduled", windowStart: at("2026-06-01T14:00:00Z") }),
    ], NOW);
    expect(chosen?.id).toBe("today");
  });

  it("prefers the technician who is en route over one merely dispatched later", () => {
    const chosen = pickVisit([
      visit({ id: "later", status: "scheduled", windowStart: at("2026-03-10T18:00:00Z") }),
      visit({ id: "now", status: "en_route", windowStart: at("2026-03-10T14:00:00Z") }),
    ], NOW);
    expect(chosen?.id).toBe("now");
  });

  it("falls back to the next upcoming visit, not the first one ever", () => {
    const chosen = pickVisit([
      visit({ id: "march", status: "completed", windowStart: at("2026-03-01T14:00:00Z") }),
      visit({ id: "september", status: "scheduled", windowStart: at("2026-09-01T14:00:00Z") }),
      visit({ id: "june", status: "scheduled", windowStart: at("2026-06-01T14:00:00Z") }),
    ], NOW);
    expect(chosen?.id).toBe("june");
  });

  it("never offers a cancelled visit as the next one", () => {
    // Telling a customer a technician is coming on a date that was cancelled
    // is worse than telling them nothing.
    const chosen = pickVisit([
      visit({ id: "cancelled", status: "cancelled", windowStart: at("2026-04-01T14:00:00Z") }),
      visit({ id: "real", status: "scheduled", windowStart: at("2026-06-01T14:00:00Z") }),
    ], NOW);
    expect(chosen?.id).toBe("real");
  });

  it("shows the most recent past visit when the work is finished", () => {
    const chosen = pickVisit([
      visit({ id: "first", status: "completed", windowStart: at("2026-01-05T14:00:00Z") }),
      visit({ id: "last", status: "completed", windowStart: at("2026-03-01T14:00:00Z") }),
    ], NOW);
    expect(chosen?.id).toBe("last");
  });

  it("handles a visit that was never scheduled", () => {
    const chosen = pickVisit([visit({ id: "unscheduled", status: "unassigned" })], NOW);
    expect(chosen?.id).toBe("unscheduled");
  });

  it("carries the lead technician through", () => {
    const chosen = pickVisit([
      visit({ id: "today", status: "working", windowStart: at("2026-03-10T14:00:00Z"), technicianName: "Ray Ortiz" }),
    ], NOW);
    expect(chosen?.technicianName).toBe("Ray Ortiz");
  });
});

/**
 * What the customer is told their job is doing.
 *
 * Every internal visit state must have a customer-facing word, because a
 * missing one falls through to the raw enum and puts "completed after
 * cancellation" on a homeowner's screen.
 */
describe("customer-facing status", () => {
  it("covers every visit state the database can hold", () => {
    // Read off the real enum rather than a list copied by hand. A state added
    // to the schema and not to the wording map would otherwise reach a
    // customer's screen as a raw identifier, and a hand-copied list in a test
    // is exactly the thing that does not get updated alongside a migration.
    for (const status of schema.visitStatus.enumValues) {
      expect(CUSTOMER_VISIT_STATUS[status], `no customer wording for "${status}"`).toBeDefined();
    }
  });

  it("does not tell a homeowner their job is unassigned", () => {
    expect(CUSTOMER_VISIT_STATUS["unassigned"]).toBe("Scheduled");
  });

  it("does not leak the accounting distinction on a cancelled-then-worked visit", () => {
    // From the customer's side the work happened. The distinction is ours.
    expect(CUSTOMER_VISIT_STATUS["completed_after_cancellation"]).toBe("Completed");
    expect(CUSTOMER_VISIT_STATUS["completed"]).toBe("Completed");
  });

  it("says on the way rather than en route", () => {
    expect(CUSTOMER_VISIT_STATUS["en_route"]).toBe("On the way");
  });

  it("is sentence case, not title case", () => {
    // The page used to apply a CSS capitalize, which rendered "On The Way".
    for (const wording of Object.values(CUSTOMER_VISIT_STATUS)) {
      expect(wording).toBe(wording.charAt(0).toUpperCase() + wording.slice(1).toLowerCase());
    }
  });
});
