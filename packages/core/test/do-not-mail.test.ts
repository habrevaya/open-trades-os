import { describe, it, expect } from "vitest";
import { directMail as dm } from "../src/index";

/**
 * THE DO NOT MAIL LIST: WHICH DOOR IS WHICH, AND WHO IT STOPS
 *
 * Addresses are compared as the post office would, not as typed, and a listed
 * address with no unit is the whole building. A customer on the list is never
 * mailed wherever they live, and the address they were listed at is held too.
 */

const at = (line1: string, over: Partial<dm.MailAddress> = {}): Omit<dm.MailAddress, "name"> =>
  ({ line1, line2: null, city: "Austin", state: "TX", postalCode: "78704", ...over });

const entry = (over: Partial<dm.DoNotMailEntry> = {}): dm.DoNotMailEntry =>
  ({ id: "e1", customerId: null, building: null, unit: "", name: null, reason: null, ...over });

describe("comparing addresses as the post office would", () => {
  it("reads one door written three ways as one", () => {
    const a = dm.addressKeys(at("12 Oak Street"));
    expect(a).toEqual({ building: "12 oak st|78704", unit: "" });
    expect(dm.addressKeys(at("12 OAK ST.", { postalCode: "78704-1234" }))).toEqual(a);
    expect(dm.addressKeys(at(" 12  oak   st,"))).toEqual(a);
  });

  it("abbreviates the words a street is written with", () => {
    expect(dm.addressKeys(at("400 North Congress Avenue"))).toEqual(dm.addressKeys(at("400 N Congress Ave")));
    expect(dm.addressKeys(at("9 South Lamar Boulevard"))?.building).toBe("9 s lamar blvd|78704");
  });

  it("takes a unit from the second line or from the end of the street line, however it is written", () => {
    expect(dm.addressKeys(at("12 Oak St", { line2: "Apt 4" }))?.unit).toBe("4");
    expect(dm.addressKeys(at("12 Oak St Apt 4"))).toEqual({ building: "12 oak st|78704", unit: "4" });
    expect(dm.addressKeys(at("12 Oak St, #4"))).toEqual({ building: "12 oak st|78704", unit: "4" });
    expect(dm.addressKeys(at("12 Oak St", { line2: "Unit B" }))?.unit).toBe("b");
    expect(dm.addressKeys(at("12 Oak St", { line2: "Apartment 4" }))).toEqual(dm.addressKeys(at("12 Oak St Apt 4")));
  });

  it("has no key for an address that cannot be posted to", () => {
    expect(dm.addressKeys(at("12 Oak St", { postalCode: "" }))).toBeNull();
    expect(dm.addressKeys(at("", { }))).toBeNull();
    expect(dm.addressKeys(at("12 Oak St", { state: "Texas" }))).toBeNull();
  });
});

describe("who an entry stops", () => {
  const door = dm.addressKeys(at("12 Oak St"))!;

  it("stops a customer wherever they live", () => {
    const hit = dm.doNotMailEntryFor([entry({ customerId: "c1", name: "Ada" })], { customerId: "c1", address: at("99 Elm St") });
    expect(hit).toMatchObject({ by: "customer", entry: { id: "e1" } });
    expect(dm.doNotMailEntryFor([entry({ customerId: "c1" })], { customerId: "c2", address: at("99 Elm St") })).toBeNull();
  });

  it("stops anybody posted to a listed door, whoever they are", () => {
    const listed = entry({ building: door.building, unit: "" });
    expect(dm.doNotMailEntryFor([listed], { customerId: "c9", address: at("12 OAK STREET") })).toMatchObject({ by: "address" });
    expect(dm.doNotMailEntryFor([listed], { customerId: "c9", address: at("14 Oak St") })).toBeNull();
    expect(dm.doNotMailEntryFor([listed], { customerId: "c9", address: at("12 Oak St", { postalCode: "78705" }) })).toBeNull();
  });

  it("holds the whole building for an address listed with no unit, and one flat for a flat", () => {
    const wholeBuilding = entry({ building: door.building, unit: "" });
    expect(dm.doNotMailEntryFor([wholeBuilding], { customerId: null, address: at("12 Oak St Apt 7") })).not.toBeNull();
    const oneFlat = entry({ building: door.building, unit: "4" });
    expect(dm.doNotMailEntryFor([oneFlat], { customerId: null, address: at("12 Oak St #4") })).not.toBeNull();
    expect(dm.doNotMailEntryFor([oneFlat], { customerId: null, address: at("12 Oak St Apt 5") })).toBeNull();
    expect(dm.doNotMailEntryFor([oneFlat], { customerId: null, address: at("12 Oak St") })).toBeNull();
  });

  it("says why, in words, with the address and how to change it", () => {
    const hit = { entry: entry({ customerId: "c1", name: "Ada Lovelace", reason: "asked on the phone, 3 June" }), by: "customer" as const };
    expect(dm.doNotMailWords(hit, "12 Oak St")).toBe(
      "Not posted. Ada Lovelace is on your do not mail list: asked on the phone, 3 June. Take them off the list on the Direct mail page to mail them.",
    );
    expect(dm.doNotMailWords({ entry: entry(), by: "address" }, "12 Oak St, Austin, TX, 78704")).toBe(
      "Not posted. 12 Oak St, Austin, TX, 78704 is on your do not mail list. Take them off the list on the Direct mail page to mail them.",
    );
  });
});
