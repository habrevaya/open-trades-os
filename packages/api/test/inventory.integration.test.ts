import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { ConflictError, NotFoundError } from "../src/services/context";
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

run("buying more of it", () => {
  /**
   * `vendor`, `purchase_order` and `purchase_order_line` were written by
   * nothing. `receivePurchaseOrder` updates a line and an order, `toOrder`
   * suggests what to buy, and there was no way to name a supplier or turn a
   * suggestion into an order. The purchasing screen was permanently empty and
   * the receiving path updated rows that could not exist.
   *
   * I wrote those three tables in the commit that added this module and did
   * not give them a create path, which is the defect this repository treats
   * as its most serious, committed by the person complaining about it.
   */
  let vendorId = "";

  beforeEach(async () => {
    if (!url) return;
    await raw`delete from public.purchase_order_line where organization_id = ${ORG}`;
    await raw`delete from public.purchase_order where organization_id = ${ORG}`;
    await raw`delete from public.vendor where organization_id = ${ORG}`;
    await raw`delete from public.reorder_policy where organization_id = ${ORG}`;
    const vendor = await inventory.createVendor(owner(), {
      name: "Gulf Coast Supply", accountNumber: "GC-4417",
    });
    vendorId = vendor.id;
  });

  it("creates an order a vendor could actually be sent", async () => {
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: warehouse,
      lines: [{ itemId, quantity: "16", unitPrice: "42.5000" }],
    });

    expect(order.status).toBe("draft");
    // A number a person can read down a phone. "Which PO was that" has no
    // useful answer if the answer is a uuid.
    expect(order.number).toBeGreaterThan(0);

    const lines = await raw<{ quantity_ordered: string; location_id: string }[]>`
      select quantity_ordered, location_id from public.purchase_order_line
      where purchase_order_id = ${order.id}`;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity_ordered).toBe("16.0000");
    // Defaulted from the order, which is what a single delivery address means.
    expect(lines[0]!.location_id).toBe(warehouse);
  });

  it("sends a line to its own location when the vendor splits the delivery", async () => {
    /**
     * A vendor drops the condensers at the shop and the filters straight onto
     * a van more often than it sounds. One location on the order means
     * somebody receives the whole thing to the warehouse and then transfers
     * half of it, or simply does not, and the van stock is wrong from the
     * first delivery.
     */
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: warehouse,
      lines: [
        { itemId, quantity: "4", unitPrice: "42.5000" },
        { itemId, quantity: "2", unitPrice: "42.5000", locationId: van },
      ],
    });

    const lines = await raw<{ location_id: string }[]>`
      select location_id from public.purchase_order_line
      where purchase_order_id = ${order.id} order by sort_order`;
    expect(lines.map((l) => l.location_id)).toEqual([warehouse, van]);
  });

  it("refuses an order with no lines", async () => {
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: warehouse, lines: [],
    })).rejects.toThrow(/not an order/i);
  });

  it("refuses a line for none of something", async () => {
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: warehouse,
      lines: [{ itemId, quantity: "0", unitPrice: "42.5000" }],
    })).rejects.toThrow(/positive quantity/i);
  });

  it("refuses a vendor nobody here has, by name and not by accident", async () => {
    /**
     * Asserted as a NotFoundError specifically. The first version accepted
     * any throw, and deleting the check left it green: the insert still fails
     * on the foreign key, so the test was measuring Postgres rather than this
     * service. The difference matters to a caller, who gets a readable
     * refusal instead of a constraint violation.
     */
    await expect(inventory.createPurchaseOrder(owner(), {
      vendorId: "11111111-1111-4111-8111-111111111111",
      defaultLocationId: warehouse,
      lines: [{ itemId, quantity: "1", unitPrice: "1.0000" }],
    })).rejects.toThrow(NotFoundError);
  });

  it("numbers orders sequentially within the company", async () => {
    const first = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: warehouse,
      lines: [{ itemId, quantity: "1", unitPrice: "1.0000" }],
    });
    const second = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: warehouse,
      lines: [{ itemId, quantity: "1", unitPrice: "1.0000" }],
    });
    expect(second.number).toBe(first.number + 1);
  });

  it("does not count a draft against the suggestion, and does count a submitted one", async () => {
    /**
     * MY FIRST VERSION OF THIS TEST ASSERTED THE OPPOSITE and core was right.
     *
     * A purchase order sitting in somebody's drafts is not stock arriving.
     * Counting it makes the reorder engine go quiet about a part nobody ever
     * actually ordered, which is the worse of the two failures: the buyer
     * finds out when a technician has none.
     *
     * Once it is sent, it counts, and that is the reason an order exists
     * before it arrives. Without it a buyer looking at the suggestion screen
     * on Tuesday orders the same sixteen contactors they ordered on Monday.
     */
    /**
     * A reorder policy is needed for a suggestion to exist at all, and the
     * shared beforeEach clears the movement history, so this test sets up its
     * own rather than relying on one another test happened to leave behind.
     */
    await raw`insert into public.reorder_policy
      (organization_id, item_id, location_id, reorder_point, reorder_quantity)
      values (${ORG}, ${itemId}, ${warehouse}, 10.0000, 16.0000)`;

    const before = await inventory.toOrder(owner());
    const line = before.find((s) => s.locationId === warehouse);
    if (!line) throw new Error("expected a suggestion to act on");

    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: warehouse,
      lines: [{ itemId: line.itemId, quantity: line.suggested, unitPrice: "12.0000" }],
    });

    const whileDraft = await inventory.toOrder(owner());
    expect(whileDraft.find((s) => s.locationId === warehouse)?.onOrder).toBe("0");

    await inventory.setPurchaseOrderStatus(owner(), { id: order.id, status: "submitted" });

    const afterSending = await inventory.toOrder(owner());
    const same = afterSending.find((s) => s.itemId === line.itemId && s.locationId === warehouse);
    // Either it is now covered and drops off the list, or it is still short
    // and says how much is coming. Both are honest; silence would not be.
    expect(same === undefined || same.onOrder !== "0").toBe(true);
    if (same) expect(same.onOrder).toBe(line.suggested);
  });
});

run("an order moving along", () => {
  let vendorId = "";
  let orderId = "";

  beforeEach(async () => {
    if (!url) return;
    await raw`delete from public.purchase_order_line where organization_id = ${ORG}`;
    await raw`delete from public.purchase_order where organization_id = ${ORG}`;
    await raw`delete from public.vendor where organization_id = ${ORG}`;
    vendorId = (await inventory.createVendor(owner(), { name: "Transitions Inc" })).id;
    orderId = (await inventory.createPurchaseOrder(owner(), {
      vendorId, defaultLocationId: warehouse,
      lines: [{ itemId, quantity: "5", unitPrice: "10.0000" }],
    })).id;
  });

  it("stamps when it actually went out", async () => {
    // A status alone cannot answer "when did we send this", which is the
    // question a buyer asks a week later.
    await inventory.setPurchaseOrderStatus(owner(), { id: orderId, status: "submitted" });

    const [row] = await raw<{ status: string; submitted_at: Date | null }[]>`
      select status, submitted_at from public.purchase_order where id = ${orderId}`;
    expect(row!.status).toBe("submitted");
    expect(row!.submitted_at).not.toBeNull();
  });

  it("refuses to reopen a received order", async () => {
    /**
     * `inv.canTransition` and `LEGAL_TRANSITIONS` were exported and called by
     * nothing, because no order existed whose status could move. Received and
     * cancelled are absorbing states, and reopening one is how stock gets
     * received twice against the same promise.
     */
    await inventory.setPurchaseOrderStatus(owner(), { id: orderId, status: "submitted" });
    await inventory.setPurchaseOrderStatus(owner(), { id: orderId, status: "received" });

    await expect(inventory.setPurchaseOrderStatus(owner(), { id: orderId, status: "draft" }))
      .rejects.toThrow(/cannot become/i);
  });

  it("refuses to acknowledge an order nobody sent", async () => {
    await expect(inventory.setPurchaseOrderStatus(owner(), { id: orderId, status: "acknowledged" }))
      .rejects.toThrow(/cannot become/i);
  });

  it("treats a second submit as a no-op rather than an error or a new date", async () => {
    /**
     * A double click on the send button should not be an error, and must not
     * move the date the vendor was told about.
     *
     * What protects that is the early return when the status has not changed,
     * NOT the `!order.submittedAt` guard on the stamp: removing that guard
     * leaves this green, because the transition table has no path back to
     * `submitted` from anywhere, so the stamp can only ever be written once.
     * The guard stays as a second lock on a table that might gain one, and
     * saying so beats leaving a protection nobody can trigger.
     */
    await inventory.setPurchaseOrderStatus(owner(), { id: orderId, status: "submitted" });
    const [first] = await raw<{ submitted_at: Date }[]>`
      select submitted_at from public.purchase_order where id = ${orderId}`;

    await new Promise((r) => setTimeout(r, 20));
    const again = await inventory.setPurchaseOrderStatus(owner(), {
      id: orderId, status: "submitted",
    });
    expect(again.status).toBe("submitted");

    const [after] = await raw<{ submitted_at: Date }[]>`
      select submitted_at from public.purchase_order where id = ${orderId}`;
    expect(after!.submitted_at.getTime()).toBe(first!.submitted_at.getTime());
  });

  it("receives against an order that now exists", async () => {
    /**
     * `receivePurchaseOrder` has been here all along, updating rows nothing
     * could create. This is the first time it has had an order to work on.
     */
    await inventory.setPurchaseOrderStatus(owner(), { id: orderId, status: "submitted" });
    const [line] = await raw<{ id: string }[]>`
      select id from public.purchase_order_line where purchase_order_id = ${orderId}`;

    await inventory.receivePurchaseOrder(owner(), {
      purchaseOrderId: orderId,
      lines: [{ lineId: line!.id, quantity: "5" }],
    });

    const [order] = await raw<{ status: string }[]>`
      select status from public.purchase_order where id = ${orderId}`;
    expect(order!.status).toBe("received");
    expect((await levelAt(warehouse))?.onHand).not.toBe("0");
  });
});

run("giving a reservation back", () => {
  /**
   * `inv.planRelease` is the third member of the commit / issue / release
   * trio and was called by nothing. The other two were wired; this one was
   * not, and the gap was not cosmetic.
   *
   * A reservation is a `commit` movement with a job on it, and the level fold
   * subtracts every OPEN commitment from available. Without a release there
   * was no way to close one, so a cancelled job held its parts forever: the
   * shelf showed them, the available figure did not, and the reorder engine
   * kept buying against a shortfall that existed only because of a job nobody
   * was going to do. Every number stayed internally consistent, which is why
   * nothing detected it.
   */
  beforeEach(async () => {
    if (!url) return;
    await inventory.receive(owner(), {
      itemId, locationId: warehouse, quantity: "4", totalCost: "400.00",
    });
  });

  it("puts the parts back on the available figure", async () => {
    await inventory.reserve(owner(), {
      itemId, locationId: warehouse, jobId: jobA, quantity: "3",
    });
    const held = await levelAt(warehouse);
    expect([held?.onHand, held?.committed, held?.available]).toEqual(["4", "3", "1"]);

    await inventory.release(owner(), {
      itemId, locationId: warehouse, jobId: jobA, quantity: "3",
    });

    const back = await levelAt(warehouse);
    // On hand never moved. Only the reservation did, which is the whole
    // difference between a release and an issue.
    expect([back?.onHand, back?.committed, back?.available]).toEqual(["4", "0", "4"]);
  });

  it("releases part of a reservation and keeps the rest", async () => {
    await inventory.reserve(owner(), {
      itemId, locationId: warehouse, jobId: jobA, quantity: "3",
    });
    await inventory.release(owner(), {
      itemId, locationId: warehouse, jobId: jobA, quantity: "1",
    });

    const open = await inventory.commitments(owner());
    expect(open.map((c) => [c.jobId, c.quantity])).toEqual([[jobA, "2"]]);
  });

  it("refuses to release more than the job is holding", async () => {
    /**
     * `planRelease` clamps nothing and says so: it refuses only a
     * non-positive quantity. Releasing four against a reservation of one
     * writes a release the fold then subtracts, and the commitment goes
     * NEGATIVE, which reads as the job having lent stock to the shelf.
     */
    await inventory.reserve(owner(), {
      itemId, locationId: warehouse, jobId: jobA, quantity: "1",
    });

    await expect(inventory.release(owner(), {
      itemId, locationId: warehouse, jobId: jobA, quantity: "4",
    })).rejects.toThrow(/holding 1/);

    const open = await inventory.commitments(owner());
    expect(open.map((c) => c.quantity)).toEqual(["1"]);
  });

  it("does not touch another job's reservation", async () => {
    await inventory.reserve(owner(), { itemId, locationId: warehouse, jobId: jobA, quantity: "1" });
    await inventory.reserve(owner(), { itemId, locationId: warehouse, jobId: jobB, quantity: "1" });

    await inventory.release(owner(), { itemId, locationId: warehouse, jobId: jobA, quantity: "1" });

    const open = await inventory.commitments(owner());
    expect(open.map((c) => c.jobId)).toEqual([jobB]);
  });
});
