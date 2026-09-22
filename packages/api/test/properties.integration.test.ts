import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as properties from "../src/services/properties";
import * as customers from "../src/services/customers";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * Properties, against a real database.
 *
 * The property service is the one place where the customer-to-property link
 * is a row rather than a column, and every interesting behaviour here is a
 * property of that choice: ownership that ends without losing history, one
 * primary at a time, and a landlord with several addresses.
 */
const url = process.env.DATABASE_URL;

if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}

const run = url ? describe : describe.skip;

const ORG_A = fixtureId("properties:org-a");
const ORG_B = fixtureId("properties:org-b");
const USER_A = fixtureId("properties:user-a");
const USER_B = fixtureId("properties:user-b");

let raw: postgres.Sql;
const db = () => testDb(url!);

const ctxFor = (
  organizationId: string, userId: string, roles: Actor["roles"],
  extra: Partial<ServiceContext> = {},
): ServiceContext => ({
  actor: { userId, organizationId, roles },
  db: db(),
  ...extra,
});

const owner = () => ctxFor(ORG_A, USER_A, ["owner"]);

const ADDRESS = {
  line1: "4102 Ramsey Ave", city: "Austin", state: "TX",
  postalCode: "78756", country: "US",
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG_A, userId: USER_A, name: "Ramsey Air", slug: "ramsey-prop" });
  await seedOrg(raw, { organizationId: ORG_B, userId: USER_B, name: "Other Co", slug: "other-prop" });
});

afterAll(async () => { if (raw) await raw.end(); });

async function aCustomer(name: string) {
  return customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false,
    tags: [], customFields: {},
  });
}

run("permissions", () => {
  it("refuses a read to a role without property:read", async () => {
    await expect(properties.list(ctxFor(ORG_A, USER_A, []), { limit: 10 }))
      .rejects.toThrow(PermissionError);
  });

  it("refuses a write to a technician", async () => {
    await expect(
      properties.create(ctxFor(ORG_A, USER_A, ["technician"]), {
        address: ADDRESS, hasDog: false, customFields: {}, customerRole: "owner",
      }),
    ).rejects.toThrow(PermissionError);
  });
});

run("creating", () => {
  it("creates a property and links the customer in one transaction", async () => {
    const customer = await aCustomer("Dana Whitfield");
    const property = await properties.create(owner(), {
      address: ADDRESS, nickname: "Home", gateCode: "#4417", hasDog: true,
      customFields: {}, customerId: customer.id, customerRole: "owner",
    });

    expect(property.address.line1).toBe("4102 Ramsey Ave");
    expect(property.gateCode).toBe("#4417");
    expect(property.hasDog).toBe(true);

    const read = await properties.get(owner(), { id: property.id });
    expect(read.customers.map((c) => c.name)).toEqual(["Dana Whitfield"]);
  });

  it("creates a property with no customer, for an address captured before the lead is", async () => {
    const property = await properties.create(owner(), {
      address: { ...ADDRESS, line1: "1 Orphan Way" }, hasDog: false,
      customFields: {}, customerRole: "owner",
    });
    const read = await properties.get(owner(), { id: property.id });
    expect(read.customers).toEqual([]);
  });

  it("is idempotent on a retry, rather than creating the address twice", async () => {
    const key = `prop-${Date.now()}`;
    const input = {
      address: { ...ADDRESS, line1: "77 Retry Ln" }, hasDog: false,
      customFields: {}, customerRole: "owner" as const,
    };
    const first = await properties.create({ ...owner(), idempotencyKey: key }, input);
    const second = await properties.create({ ...owner(), idempotencyKey: key }, input);
    expect(second.id).toBe(first.id);
  });

  it("reports a missing property rather than returning nothing", async () => {
    await expect(properties.get(owner(), { id: fixtureId("properties:nope") }))
      .rejects.toThrow(NotFoundError);
  });
});

run("the customer link", () => {
  it("gives a landlord every one of their addresses", async () => {
    const landlord = await aCustomer("Brazos Property Group");
    for (const line1 of ["10 Rental St", "12 Rental St", "14 Rental St"]) {
      await properties.create(owner(), {
        address: { ...ADDRESS, line1 }, hasDog: false, customFields: {},
        customerId: landlord.id, customerRole: "owner",
      });
    }
    const page = await properties.list(owner(), { limit: 50, customerId: landlord.id });
    expect(page.data).toHaveLength(3);
  });

  it("links a second customer in a different role on the same property", async () => {
    const ownerCustomer = await aCustomer("Owner Person");
    const tenant = await aCustomer("Tenant Person");
    const property = await properties.create(owner(), {
      address: { ...ADDRESS, line1: "30 Duplex Rd" }, hasDog: false, customFields: {},
      customerId: ownerCustomer.id, customerRole: "owner",
    });

    await properties.link(owner(), {
      id: property.id, customerId: tenant.id, role: "tenant", isPrimary: false,
    });

    const read = await properties.get(owner(), { id: property.id });
    expect(read.customers.map((c) => c.role).sort()).toEqual(["owner", "tenant"]);
  });

  it("does not duplicate a link when the same call is made twice", async () => {
    // An import re-run, or a retried request. Owned twice by the same person
    // shows that person twice on every screen that lists owners.
    const customer = await aCustomer("Repeat Link");
    const property = await properties.create(owner(), {
      address: { ...ADDRESS, line1: "40 Repeat Ave" }, hasDog: false, customFields: {}, customerRole: "owner",
    });

    await properties.link(owner(), { id: property.id, customerId: customer.id, role: "owner", isPrimary: true });
    await properties.link(owner(), { id: property.id, customerId: customer.id, role: "owner", isPrimary: true });

    const read = await properties.get(owner(), { id: property.id });
    expect(read.customers).toHaveLength(1);
  });

  it("leaves exactly one primary when a new one is set", async () => {
    // Two primaries means every screen that picks "the" customer picks
    // whichever row came back first, which changes between reads.
    const first = await aCustomer("First Owner");
    const second = await aCustomer("Second Owner");
    const property = await properties.create(owner(), {
      address: { ...ADDRESS, line1: "50 Sold St" }, hasDog: false, customFields: {},
      customerId: first.id, customerRole: "owner",
    });

    await properties.link(owner(), { id: property.id, customerId: second.id, role: "owner", isPrimary: true });

    const primaries = await raw`
      select count(*)::int as n from public.customer_property
      where property_id = ${property.id} and is_primary and ended_on is null`;
    expect(primaries[0]?.["n"]).toBe(1);
  });

  it("keeps a sold property out of the seller's list without deleting the history", async () => {
    const seller = await aCustomer("Seller");
    const property = await properties.create(owner(), {
      address: { ...ADDRESS, line1: "60 Moved On Rd" }, hasDog: false, customFields: {},
      customerId: seller.id, customerRole: "owner",
    });

    await properties.link(owner(), {
      id: property.id, customerId: seller.id, role: "owner",
      isPrimary: false, endedOn: "2024-06-01",
    });

    const page = await properties.list(owner(), { limit: 50, customerId: seller.id });
    expect(page.data).toHaveLength(0);

    // The row is still there. Ten years of service history hangs off it.
    const rows = await raw`
      select ended_on from public.customer_property
      where property_id = ${property.id} and customer_id = ${seller.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["ended_on"]).toBeTruthy();
  });

  it("stops naming a former owner as a customer of the property", async () => {
    // Distinct from the seller's own list above: this is the property read,
    // which answers "who is associated with this address today". A technician
    // arriving must not be told to ask for somebody who moved out.
    const past = await aCustomer("Past Owner");
    const present = await aCustomer("Present Owner");
    const property = await properties.create(owner(), {
      address: { ...ADDRESS, line1: "65 Changed Hands Dr" }, hasDog: false, customFields: {},
      customerId: past.id, customerRole: "owner",
    });
    await properties.link(owner(), {
      id: property.id, customerId: present.id, role: "owner", isPrimary: true,
    });
    await properties.link(owner(), {
      id: property.id, customerId: past.id, role: "owner", isPrimary: false, endedOn: "2024-06-01",
    });

    const read = await properties.get(owner(), { id: property.id });
    expect(read.customers.map((c) => c.name)).toEqual(["Present Owner"]);
  });

  it("refuses to link a customer that does not exist", async () => {
    const property = await properties.create(owner(), {
      address: { ...ADDRESS, line1: "70 Nobody Ln" }, hasDog: false, customFields: {}, customerRole: "owner",
    });
    await expect(properties.link(owner(), {
      id: property.id, customerId: fixtureId("properties:ghost"), role: "owner", isPrimary: true,
    })).rejects.toThrow(NotFoundError);
  });
});

run("search", () => {
  it("finds a property by street, city or postal code", async () => {
    await properties.create(owner(), {
      address: { line1: "9900 Findable Blvd", city: "Pflugerville", state: "TX", postalCode: "78660", country: "US" },
      hasDog: false, customFields: {}, customerRole: "owner",
    });

    for (const q of ["Findable", "Pflugerville", "78660"]) {
      const page = await properties.list(owner(), { limit: 10, q });
      expect(page.data.some((p) => p.addressLine1 === "9900 Findable Blvd"), `q=${q}`).toBe(true);
    }
  });
});

run("the tenant boundary", () => {
  it("does not show one company's properties to another", async () => {
    await properties.create(owner(), {
      address: { ...ADDRESS, line1: "999 Private Way" }, hasDog: false, customFields: {}, customerRole: "owner",
    });
    const theirs = await properties.list(ctxFor(ORG_B, USER_B, ["owner"]), { limit: 100 });
    expect(theirs.data.some((p) => p.addressLine1 === "999 Private Way")).toBe(false);
  });

  it("reports another company's property as missing, not forbidden", async () => {
    // Forbidden confirms it exists, which is itself a leak.
    const mine = await properties.create(owner(), {
      address: { ...ADDRESS, line1: "998 Also Private" }, hasDog: false, customFields: {}, customerRole: "owner",
    });
    await expect(properties.get(ctxFor(ORG_B, USER_B, ["owner"]), { id: mine.id }))
      .rejects.toThrow(NotFoundError);
  });
});
