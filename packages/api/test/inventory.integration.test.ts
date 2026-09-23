import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { ConflictError } from "../src/services/context";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * PURCHASING, VENDORS AND INVENTORY
 *
 * The arithmetic is tested to death in core. What this file is for is the
 * three things core cannot check:
 *
 *   THE LEVEL IS FOLDED FROM THE DATABASE, not read from a column, and there
 *   is no column to read. The whole design falls over quietly if somebody
 *   adds one, so a test asks the schema directly.
 *
 *   A RESERVATION BELONGS TO A JOB, all the way through a real write. The
 *   core module got this wrong first time and the bug only appears with two
 *   jobs and one part.
 *
 *   THE ORDER OF MOVEMENTS SURVIVES A ROUND TRIP. Costing depends on it, and
 *   a sequence assigned wrong is not visible until a FIFO cost is wrong six
 *   months later.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("iv:org");
const USER = fixtureId("iv:user");

let raw: postgres.Sql;
let itemId = "";
let warehouse = "";
let van = "";
let jobA = "";
let jobB = "";

const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);
const tech = () => as(["technician"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Stock Co", slug: "stock-co" });

  const [item] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code)
    values (${ORG}, 'material', 'COMP-410') returning id`;
  itemId = item!.id;
  await raw`
    insert into public.price_book_item_version
      (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${itemId}, 1, 'Compressor, 3 ton', '1290.00', now())`;

  const [shop] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse)
    values (${ORG}, 'Shop', true) returning id`;
  warehouse = shop!.id;
  const [truck] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'Van 4') returning id`;
  van = truck!.id;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Stock Customer", phone: "+15125550199",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "1 Stock St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const a = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Job A", tags: [], customFields: {},
  });
  const b = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Job B", tags: [], customFields: {},
  });
  jobA = a.id;
  jobB = b.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.stock_movement where organization_id = ${ORG}`;
  await raw`delete from public.reorder_policy where organization_id = ${ORG}`;
});

const levelAt = async (locationId: string) =>
  (await inventory.levels(owner())).find((l) => l.locationId === locationId);

run("there is no stored level", () => {
  it("has no on hand or committed column anywhere in the schema", async () => {
    /**
     * The design is that a level is folded from an append only history. It
     * falls over quietly the day somebody adds a column and starts keeping
     * the two in step by hand, so this asks the database rather than trusting
     * that nobody will.
     */
    const columns = await raw<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and column_name in ('on_hand', 'committed', 'quantity_on_hand', 'stock_level')`;
    expect(columns).toEqual([]);
  });
});

run("stock arriving and leaving", () => {
  it("folds a level out of the movements", async () => {
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "3", totalCost: "100.00",
    });
    const level = await levelAt(warehouse);
    expect(level?.onHand).toBe("3");
    expect(level?.available).toBe("3");
    expect(level?.itemName).toBe("Compressor, 3 ton");
  });

  it("refuses to issue more than is there, and says by how much", async () => {
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "1", totalCost: "100.00",
    });
    await expect(inventory.issue(owner(), {
      itemId, locationId: warehouse, quantity: "2", jobId: jobA,
    })).rejects.toThrow(ConflictError);
  });

  it("moves both halves of a transfer or neither", async () => {
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "2", totalCost: "240.00",
    });
    await inventory.transfer(owner(), {
      itemId, fromLocationId: warehouse, toLocationId: van, quantity: "1",
    });

    expect((await levelAt(warehouse))?.onHand).toBe("1");
    expect((await levelAt(van))?.onHand).toBe("1");

    // Paired by a transfer id, which is the only thing that joins them.
    const [row] = await raw<{ n: string }[]>`
      select count(distinct transfer_id)::text as n from public.stock_movement
      where organization_id = ${ORG} and transfer_id is not null`;
    expect(row!.n).toBe("1");
  });

  it("records a count as the correction rather than the answer", async () => {
    /**
     * The counted number is never written. What is written is the difference,
     * with a reason, so the history still explains every number it produces.
     * A count that overwrote a level would be the one write in this module
     * that destroys evidence.
     */
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "3", totalCost: "100.00",
    });
    await inventory.count(owner(), {
      itemId, locationId: warehouse, counted: "2", reasonCode: "cycle_count",
    });

    expect((await levelAt(warehouse))?.onHand).toBe("2");
    const kinds = await raw<{ kind: string }[]>`
      select kind from public.stock_movement
      where organization_id = ${ORG} order by sequence`;
    expect(kinds.map((k) => k.kind)).toEqual(["receipt", "adjustment_out"]);
  });
});

run("a reservation belongs to a job", () => {
  it("does not let one job's issue eat another job's reservation", async () => {
    /**
     * THE TEST THIS MODULE'S SCHEMA EXISTS FOR. Two jobs reserve the last
     * compressor. One technician collects theirs and takes an extra. Against
     * a single committed counter the extra came out of the other job's
     * reservation, and nobody found out until a second technician arrived at
     * a property.
     */
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "3", totalCost: "300.00",
    });
    await inventory.reserve(owner(), { itemId, locationId: warehouse, jobId: jobA, quantity: "1" });
    await inventory.reserve(owner(), { itemId, locationId: warehouse, jobId: jobB, quantity: "1" });

    expect((await levelAt(warehouse))?.committed).toBe("2");

    await inventory.issue(owner(), {
      itemId, locationId: warehouse, quantity: "2", jobId: jobA,
    });

    const open = await inventory.commitments(owner());
    expect(open.map((c) => [c.jobId, c.quantity])).toEqual([[jobB, "1"]]);
    expect((await levelAt(warehouse))?.committed).toBe("1");
  });

  it("refuses to issue the part another job has reserved", async () => {
    /**
     * The other half of the same failure, and the half the service was still
     * getting wrong after the schema was fixed. The last compressor is spoken
     * for by job A. Job B's technician takes it, `planIssue` checked ON HAND,
     * and the reservation stood against an empty shelf.
     *
     * Note what is NOT refused: job A taking its own reserved part. Refusing
     * that would tell a technician the shelf is empty while they are holding
     * the part, and the thing they would learn is to stop recording issues.
     */
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "1", totalCost: "100.00",
    });
    await inventory.reserve(owner(), { itemId, locationId: warehouse, jobId: jobA, quantity: "1" });

    await expect(inventory.issue(owner(), {
      itemId, locationId: warehouse, quantity: "1", jobId: jobB,
    })).rejects.toThrow(/available/i);

    // And the job that holds it is not blocked by its own reservation.
    await inventory.issue(owner(), {
      itemId, locationId: warehouse, quantity: "1", jobId: jobA,
    });
    expect((await levelAt(warehouse))?.onHand).toBe("0");
  });

  it("refuses a reservation against stock somebody else has already reserved", async () => {
    // Available, not on hand. The entire point of the three quantities.
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "1", totalCost: "100.00",
    });
    await inventory.reserve(owner(), { itemId, locationId: warehouse, jobId: jobA, quantity: "1" });

    await expect(inventory.reserve(owner(), {
      itemId, locationId: warehouse, jobId: jobB, quantity: "1",
    })).rejects.toThrow(ConflictError);
  });

  it("names the part, the place and the job rather than showing three ids", async () => {
    // A screen full of uuids is the database on somebody's screen, and they
    // cannot act on it. Every read in this service resolves names.
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "1", totalCost: "100.00",
    });
    await inventory.reserve(owner(), { itemId, locationId: warehouse, jobId: jobA, quantity: "1" });

    const held = (await inventory.commitments(owner()))[0]!;
    expect(held.jobSummary).toBe("Job A");
    expect(held.itemName).toBe("Compressor, 3 ton");
    expect(held.locationName).toBe("Shop");
  });
});

run("the order of a history", () => {
  it("gives every movement its own place in the total order", async () => {
    // Two movements sharing a sequence is a history that cannot be replayed,
    // and FIFO is a replay.
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "2", totalCost: "200.00",
    });
    await inventory.transfer(owner(), {
      itemId, fromLocationId: warehouse, toLocationId: van, quantity: "1",
    });

    const rows = await raw<{ sequence: number }[]>`
      select sequence from public.stock_movement where organization_id = ${ORG}`;
    expect(new Set(rows.map((r) => r.sequence)).size).toBe(rows.length);
  });

  it("costs a job from the layers rather than from the movement", async () => {
    /**
     * Two receipts at different prices, and an issue spanning both. The
     * issue's cost is decided by the costing method from the layers, which is
     * the reason a movement out carries no cost of its own.
     */
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "2", totalCost: "100.00",
    });
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "3", totalCost: "360.00",
    });
    await inventory.issue(owner(), {
      itemId, locationId: warehouse, quantity: "3", jobId: jobA,
    });

    // Two at fifty, one at a hundred and twenty.
    expect(await inventory.costOfJob(owner(), { jobId: jobA })).toBe("220.0000");
  });
});

run("who may touch stock", () => {
  it("lets a technician see it and not adjust it", async () => {
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "1", totalCost: "100.00",
    });
    await expect(inventory.levels(tech())).resolves.toBeTruthy();
    await expect(inventory.receive(tech(), {
      itemId, locationId: warehouse, quantity: "1", totalCost: "100.00",
    })).rejects.toThrow();
  });
});

run("numbers a person reads", () => {
  it("does not put the storage scale on the screen", async () => {
    /**
     * A parts list that reads "3.0000 compressors" teaches everyone looking
     * at it that the software was written by somebody who has never seen a
     * parts list. The column holds four decimal places because trades
     * quantities are genuinely fractional, and the screen shows the fewest
     * that say anything.
     *
     * This is the third time today the storage format has reached a screen
     * in this repository: a ceiling box that read 2500.0000 and an enum that
     * read `in_progress` were the other two.
     */
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "3", totalCost: "100.00",
    });

    const level = await levelAt(warehouse);
    expect(level?.onHand).toBe("3");
    expect(level?.available).toBe("3");
    expect(level?.committed).toBe("0");
  });

  it("keeps a fraction that means something", async () => {
    // Two and three quarter pounds of refrigerant is a real quantity, and
    // trimming it to three is a different amount of money.
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "2.75", totalCost: "85.25",
    });
    expect((await levelAt(warehouse))?.onHand).toBe("2.75");
  });
});
