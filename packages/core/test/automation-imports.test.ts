import { describe, it, expect } from "vitest";
import { shouldTrigger, type TriggerEvent, type WorkflowSpec } from "../src/automation/index.js";

/**
 * A FILE BROUGHT IN WITH AUTOMATIONS HELD STARTS NOTHING
 *
 * The switch on the spreadsheet screen is on by default, and the events its
 * rows raise carry it. Held is held for every event the file raised, the
 * created ones and the rest, and an event typed in by hand is untouched.
 */
describe("events from a spreadsheet", () => {
  const spec = (triggerEvents: string[]): WorkflowSpec => ({
    id: "w1", versionId: "v1", enabled: true, triggerEvents, conditions: {},
  });
  const event = (name: string, over: Partial<TriggerEvent> = {}): TriggerEvent => ({
    name, payload: {}, causationDepth: 0, ...over,
  });

  it("starts nothing for a customer brought in with automations held", () => {
    expect(shouldTrigger(spec(["customer.created"]), event("customer.created", { heldByImport: true })))
      .toEqual({ run: false, reason: "imported" });
  });

  it("holds the file's other events too, so a recent paid invoice asks for no review", () => {
    expect(shouldTrigger(spec(["invoice.paid"]), event("invoice.paid", { heldByImport: true })))
      .toEqual({ run: false, reason: "imported" });
  });

  it("still starts for one typed in, and for a file brought in with the switch off", () => {
    expect(shouldTrigger(spec(["customer.created"]), event("customer.created"))).toEqual({ run: true });
    expect(shouldTrigger(spec(["customer.created"]), event("customer.created", { heldByImport: false }))).toEqual({ run: true });
  });

  it("says the event was not subscribed before it says held, so the run log reads truthfully", () => {
    expect(shouldTrigger(spec(["job.created"]), event("customer.created", { heldByImport: true })))
      .toEqual({ run: false, reason: "event_not_subscribed" });
  });
});
