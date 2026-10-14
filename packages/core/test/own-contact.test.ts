import { describe, it, expect } from "vitest";
import { people as p } from "../src/index";

/**
 * A PERSON KEEPS THEIR OWN ADDRESS AND PHONE
 *
 * What is accepted, how it is kept, and how a change reads to the office.
 */
const full = { phone: "(512) 555-0143", addressLine1: "12 Oak St", city: "Austin", state: "tx", postalCode: "78701" };

describe("what a person types", () => {
  it("keeps the phone as a dialable number, the state in capitals, and tidies spaces", () => {
    expect(p.checkOwnContact({ ...full, addressLine1: "  12   Oak St ", addressLine2: " Apt  4 " })).toEqual({
      ok: true,
      contact: { phone: "+15125550143", addressLine1: "12 Oak St", addressLine2: "Apt 4", city: "Austin", state: "TX", postalCode: "78701" },
    });
  });

  it("lets either be empty, and both", () => {
    expect(p.checkOwnContact({ phone: "512-555-0143" })).toMatchObject({ ok: true, contact: { phone: "+15125550143", addressLine1: null } });
    expect(p.checkOwnContact({ city: "", postalCode: " " })).toEqual({ ok: true, contact: p.NO_OWN_CONTACT });
  });

  it("refuses something that is not a phone number, in words", () => {
    const r = p.checkOwnContact({ phone: "call me" });
    expect(r.ok === false && r.reason).toContain("is not a phone number");
  });

  it("wants all of street, town, state and ZIP or none", () => {
    for (const missing of ["addressLine1", "city", "state", "postalCode"]) {
      const r = p.checkOwnContact({ ...full, [missing]: "" });
      expect(r.ok === false && r.reason, missing).toContain("street, the town, the state and the ZIP");
    }
    expect(p.checkOwnContact({ addressLine2: "Apt 4" }).ok).toBe(false);
  });

  it("refuses a state that is not two letters and a ZIP that is not a ZIP", () => {
    const state = p.checkOwnContact({ ...full, state: "Texas" });
    expect(state.ok === false && state.reason).toContain("two letters");
    const zip = p.checkOwnContact({ ...full, postalCode: "787" });
    expect(zip.ok === false && zip.reason).toContain("ZIP code is five digits");
    expect(p.checkOwnContact({ ...full, postalCode: "78701-1234" }).ok).toBe(true);
  });

  it("keeps each line short", () => {
    const r = p.checkOwnContact({ ...full, addressLine1: "x".repeat(121) });
    expect(r.ok === false && r.reason).toContain("hundred and twenty");
  });
});

describe("what changed", () => {
  const was = (p.checkOwnContact(full) as { contact: p.OwnContact }).contact;

  it("says nothing when nothing did", () => {
    expect(p.ownContactChanges(was, { ...was })).toEqual([]);
  });

  it("names the phone and the address, each only when it changed, in words", () => {
    expect(p.ownContactChanges(was, { ...was, phone: "+15125550199" })).toEqual([
      { field: "phone", before: "(512) 555-0143", after: "(512) 555-0199" },
    ]);
    expect(p.ownContactChanges(was, { ...was, city: "Round Rock", postalCode: "78664" })).toEqual([
      { field: "address", before: "12 Oak St, Austin, TX 78701", after: "12 Oak St, Round Rock, TX 78664" },
    ]);
    expect(p.ownContactChanges(was, p.NO_OWN_CONTACT).map((c) => [c.field, c.after])).toEqual([["phone", "none"], ["address", "none"]]);
  });

  it("reads the first version as a change from nothing", () => {
    expect(p.ownContactChanges(null, was)).toEqual([
      { field: "phone", before: "none", after: "(512) 555-0143" },
      { field: "address", before: "none", after: "12 Oak St, Austin, TX 78701" },
    ]);
    expect(p.ownContactChanges(null, p.NO_OWN_CONTACT)).toEqual([]);
  });
});
