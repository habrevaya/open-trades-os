import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as estimates from "../src/services/estimates";
import { testDb, seedOrg, fixtureId } from "./helpers";
import type { ServiceContext } from "../src/services/context";

/**
 * Human-facing numbers, allocated concurrently.
 *
 * `max(number) + 1` reads correctly in review and is wrong the moment two
 * people book at once: both transactions read the same maximum and both are
 * handed job 41. It cannot be caught by a test that does one thing at a time,
 * which is why it survived until now, and a contractor who finds two jobs
 * numbered 41 does not forget it.
 *
 * So these run genuinely in parallel, on separate connections, and assert on
 * the SET of numbers rather than on any one of them.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("num:org");
const USER = fixtureId("num:user");

let raw: postgres.Sql;
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: testDb(url!),
});

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Number Co", slug: "number-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Nina Number", phone: "+15125550190",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "2 Number Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("numbering under concurrency", () => {
  it("hands eight simultaneous jobs eight different numbers", async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        jobs.create(owner(), {
          customerId, propertyId, summary: `Parallel ${i}`, tags: [], customFields: {},
        })),
    );

    const numbers = created.map((j) => j.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(numbers.length);

    // And contiguous, not merely distinct. Gaps in invoice numbering are a
    // compliance problem in several jurisdictions, so an allocator that
    // burned a number on contention would be a different bug wearing the
    // same clothes.
    expect(numbers[numbers.length - 1]! - numbers[0]!).toBe(numbers.length - 1);
  });

  it("numbers estimates on their own series, not the jobs' one", async () => {
    // A shared counter would be the obvious shortcut and is visibly wrong to
    // anyone who has ever filed a set of invoices.
    const made = await Promise.all(
      Array.from({ length: 4 }, () =>
        estimates.create(owner(), {
          customerId, propertyId, title: "Parallel estimate",
          taxRate: "0",
          options: [{
            name: "Only", isRecommended: true,
            lines: [{
              name: "Diagnostic", quantity: "1", unitPrice: "89.00",
              discountAmount: "0", taxable: true, isOptional: false, isSelected: true,
            }],
          }],
        })),
    );
    const numbers = made.map((e) => e.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(4);
    expect(numbers[0]).toBe(1);
  });
});
