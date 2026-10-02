import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as visitAssets from "../src/services/visit-assets";
import * as deliveries from "../src/services/deliveries";
import * as equipment from "../src/services/equipment";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE MACHINES ON A ROUND, AND THE QUANTITY OFF A TRUCK
 *
 * Three things nothing wrote, and the last of them nothing touched at all.
 *
 * `visit_asset` was read by the equipment history, whose comment says exactly
 * what it was for: "a job about one rooftop unit can carry readings for
 * eight". That section was always empty, and `visitAsset.completedAt` was a
 * known gap: a query whose answer was decided before it ran.
 *
 * `deficiency.equipment_id` was the other known gap. Faults were written and
 * none of them was attached to the machine it was found on.
 *
 * `delivery` had no reader and no writer anywhere. Not a gap in a feature:
 * a whole way of taking money that was absent while the table described it
 * in enough detail to be unmistakable.
 *
 * THE PROPERTY THE DELIVERY BLOCK IS ABOUT is that the meter is the
 * authority and a disagreement is REFUSED rather than resolved. Two numbers
 * that should match and do not is the signal something happened at the kerb,
 * and silently preferring one charges the customer a figure nobody checked.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("fa:org");
const USER = fixtureId("fa:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/** Exactly these permissions and no role, so a pair can be told apart. */
const granted = (...permissions: string[]): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

let customerId = "";
let propertyId = "";
let otherPropertyId = "";
let jobId = "";
let visitId = "";

async function unit(tag: string, where = propertyId): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.equipment (organization_id, property_id, tag, category, model)
    values (${ORG}, ${where}, ${tag}, 'rooftop_unit', 'XC-14') returning id`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Field Co", slug: "field-co" });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name)
    values (${ORG}, 'commercial', 'Roof Holdings') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Plaza', 'Austin', 'TX', '78705') returning id`;
  propertyId = property!.id;
  const [other] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '2 Annex', 'Austin', 'TX', '78705') returning id`;
  otherPropertyId = other!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 1, ${customerId}, ${propertyId}, 'scheduled', 'Quarterly maintenance')
    returning id`;
  jobId = job!.id;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status)
    values (${ORG}, ${jobId}, 1, 'scheduled') returning id`;
  visitId = visit!.id;
});

/* ------------------------------------------- the machines on one visit */

run("the machines one visit covers", () => {
  it("plans a round in the order it is to be walked", async () => {
    /**
     * The order is the point. A technician works a roof in a sequence, and
     * `sequence` is what puts the list on the phone in the order they will
     * actually walk it.
     */
    const a = await unit("RTU-1");
    const b = await unit("RTU-2");
    const c = await unit("RTU-3");

    const result = await visitAssets.plan(owner(), {
      visitId, equipmentIds: [c, a, b],
    });
    expect(result).toEqual({ planned: 3, kept: 0 });

    const { units } = await visitAssets.forVisit(owner(), { visitId });
    expect(units.map((u) => u.equipmentId)).toEqual([c, a, b]);
    /**
     * THE SEQUENCE VALUES, NOT ONLY THE ORDER THEY CAME BACK IN.
     *
     * A deliberate breakage that stopped writing `sequence` left the order
     * assertion green: the column defaults to zero, every row got zero, and
     * Postgres happened to return them in insertion order. An ordering that
     * is right by accident is one that changes after a vacuum.
     */
    expect(units.map((u) => u.sequence)).toEqual([0, 1, 2]);
    expect(units[0]!.equipmentLabel).toBe("RTU-3 rooftop_unit XC-14");
  });

  it("deduplicates the same machine rather than refusing", async () => {
    const a = await unit("RTU-1");
    const result = await visitAssets.plan(owner(), { visitId, equipmentIds: [a, a] });
    expect(result.planned).toBe(1);
  });

  it("refuses a machine at a different address", async () => {
    /**
     * A visit covers one address. Recording work on a machine nobody went to
     * see is how a round ends up with work that was never dispatched, and
     * worse, on somebody else's equipment history.
     */
    const elsewhere = await unit("ANNEX-1", otherPropertyId);
    await expect(visitAssets.plan(owner(), { visitId, equipmentIds: [elsewhere] }))
      .rejects.toThrow(/different property/);
  });

  it("refuses a machine that is not on the register", async () => {
    await expect(visitAssets.plan(owner(), {
      visitId, equipmentIds: [fixtureId("fa:ghost")],
    })).rejects.toThrow(NotFoundError);
  });

  it("records an outcome and stamps when it was done", async () => {
    /**
     * `completed_at` IS WHAT MADE THIS A KNOWN GAP. The equipment history
     * ordered by it and nothing ever wrote one.
     */
    const a = await unit("RTU-1");
    await visitAssets.plan(owner(), { visitId, equipmentIds: [a] });

    const done = await visitAssets.recordOutcome(owner(), {
      visitId, equipmentId: a, outcome: "serviced",
      at: "2026-06-02T09:15:00Z",
    });
    expect(done).toMatchObject({ outcome: "serviced", completedAt: "2026-06-02T09:15:00.000Z" });
  });

  it("takes the moment from the caller, not the clock", async () => {
    /**
     * The field app records a round in a basement and syncs it an hour later.
     * `now()` would stamp every unit with the moment the phone found signal
     * and lose the order they were done in, which on a roof is the order
     * somebody walked.
     */
    const a = await unit("RTU-1");
    const b = await unit("RTU-2");
    await visitAssets.plan(owner(), { visitId, equipmentIds: [a, b] });

    await visitAssets.recordOutcome(owner(), {
      visitId, equipmentId: b, outcome: "serviced", at: "2026-06-02T08:00:00Z",
    });
    await visitAssets.recordOutcome(owner(), {
      visitId, equipmentId: a, outcome: "serviced", at: "2026-06-02T09:00:00Z",
    });

    const { units } = await visitAssets.forVisit(owner(), { visitId });
    const byUnit = new Map(units.map((u) => [u.equipmentId, u.completedAt]));
    expect(byUnit.get(b)).toBe("2026-06-02T08:00:00.000Z");
    expect(byUnit.get(a)).toBe("2026-06-02T09:00:00.000Z");
  });

  it("needs a reason to skip a unit and not to find it locked", async () => {
    /**
     * Every other outcome says what happened. Skipped says somebody decided
     * not to, and that decision is the one a customer asks about. `no_access`
     * deliberately needs none, because the reason is in the word.
     */
    const a = await unit("RTU-1");
    await visitAssets.plan(owner(), { visitId, equipmentIds: [a] });

    await expect(visitAssets.recordOutcome(owner(), {
      visitId, equipmentId: a, outcome: "skipped",
    })).rejects.toThrow(/needs a note/);

    await expect(visitAssets.recordOutcome(owner(), {
      visitId, equipmentId: a, outcome: "no_access",
    })).resolves.toMatchObject({ outcome: "no_access" });
  });

  it("refuses an outcome for a machine nobody planned to see", async () => {
    const a = await unit("RTU-1");
    await expect(visitAssets.recordOutcome(owner(), {
      visitId, equipmentId: a, outcome: "serviced",
    })).rejects.toThrow(/not on this visit/);
  });

  it("keeps the morning's work when the list is tidied at eleven", async () => {
    /**
     * THE ONE EXCEPTION IN `plan`, AND THE IMPORTANT ONE. A dispatcher
     * replanning a round must not delete what was already finished. The unit
     * that was done stays, renumbered to the end so no two rows share a
     * sequence, and the ones not yet touched go.
     */
    const a = await unit("RTU-1");
    const b = await unit("RTU-2");
    const c = await unit("RTU-3");
    await visitAssets.plan(owner(), { visitId, equipmentIds: [a, b] });
    await visitAssets.recordOutcome(owner(), {
      visitId, equipmentId: a, outcome: "serviced", at: "2026-06-02T08:00:00Z",
    });

    const result = await visitAssets.plan(owner(), { visitId, equipmentIds: [c] });
    expect(result).toEqual({ planned: 1, kept: 1 });

    const { units } = await visitAssets.forVisit(owner(), { visitId });
    expect(units.map((u) => u.equipmentId)).toEqual([c, a]);
    expect(units.map((u) => u.sequence)).toEqual([0, 1]);
    // And the one that was never touched is gone.
    expect(units.some((u) => u.equipmentId === b)).toBe(false);
  });

  it("shows the per-unit outcome on the equipment history, which was always empty", async () => {
    /**
     * THE PAYOFF. The equipment history's comment says this section exists so
     * that "inspection work touches equipment it is not the subject of", and
     * nothing could write a row for it to read.
     */
    const a = await unit("RTU-1");
    await visitAssets.plan(owner(), { visitId, equipmentIds: [a] });
    await visitAssets.recordOutcome(owner(), {
      visitId, equipmentId: a, outcome: "faults_found", notes: "Contactor pitted",
      at: "2026-06-02T08:00:00Z",
    });

    const history = await equipment.history(owner(), { id: a });
    expect(history.inspected).toHaveLength(1);
    expect(history.inspected[0]).toMatchObject({
      outcome: "faults_found", notes: "Contactor pitted",
    });
  });

  it("reads an unrecognised outcome as unrecorded rather than as a sixth one", async () => {
    /**
     * The column is `text` and the set is closed in the service, so a row
     * written before the set existed, or by hand, has to come back as
     * something a caller can handle. A sixth value leaking out is a switch
     * somewhere with no arm for it.
     */
    const a = await unit("RTU-1");
    await visitAssets.plan(owner(), { visitId, equipmentIds: [a] });
    await raw`update public.visit_asset set outcome = 'Done', completed_at = now()
              where visit_id = ${visitId}`;
    const { units } = await visitAssets.forVisit(owner(), { visitId });
    expect(units[0]!.outcome).toBeNull();
    expect(units[0]!.completedAt).not.toBeNull();
  });

  it("refuses somebody who may read a visit but not change one", async () => {
    const a = await unit("RTU-1");
    await expect(visitAssets.forVisit(granted("visit:read"), { visitId }))
      .resolves.toEqual({ units: [] });
    await expect(visitAssets.plan(granted("visit:read"), { visitId, equipmentIds: [a] }))
      .rejects.toThrow();
  });
});

/* ------------------------------------------------------- the quantity */

run("what came off the truck", () => {
  const drop = (over: Partial<deliveries.DeliveryInput> = {}): deliveries.DeliveryInput => ({
    customerId, propertyId, product: "propane", unit: "gal",
    unitPrice: "2.5000", quantity: "400.0000", ...over,
  });

  it("records a delivery and prices it", async () => {
    const made = await deliveries.record(owner(), drop());
    expect(made).toMatchObject({
      product: "propane", quantity: "400.0000", unitPrice: "2.5000", total: "1000.0000",
    });
  });

  it("takes the quantity from the meter when both readings are given", async () => {
    /**
     * THE METER IS THE AUTHORITY. A driver's written quantity and the
     * difference between two readings disagree regularly, and when they do
     * the meter is right.
     */
    const made = await deliveries.record(owner(), drop({
      quantity: undefined, meterStart: "11000.0000", meterStop: "11400.0000",
    }));
    expect(made.quantity).toBe("400.0000");

    /**
     * WHEN BOTH ARE GIVEN AND AGREE, WHICH ONE IS STORED IS UNOBSERVABLE, and
     * that is worth writing down because the obvious test for it is a test of
     * nothing.
     *
     * A deliberate breakage made the written quantity win whenever one was
     * given, and no assertion could catch it: the column is `numeric(14,4)`,
     * so Postgres normalises "400" and "400.0000" to the same stored value
     * and returns the same string. The two versions are behaviourally
     * identical, which means the preference is not a defect and there is no
     * honest test for it.
     *
     * The meter's authority is real and shows up in exactly one place: the
     * REFUSAL when the two disagree, which the next test drives. A reading
     * pair with no written figure is the other half, above.
     */
    const both = await deliveries.record(owner(), drop({
      quantity: "400", meterStart: "12000.0000", meterStop: "12400.0000",
    }));
    expect(both.quantity).toBe("400.0000");
  });

  it("refuses a meter and a written quantity that disagree", async () => {
    /**
     * REFUSED RATHER THAN RESOLVED, which is the decision this whole block
     * is about. Silently preferring the meter would charge the customer a
     * number nobody checked and lose the only signal that something happened
     * at the kerb: a mistyped figure, a meter that was not zeroed, a hose
     * moved between two tanks.
     */
    await expect(deliveries.record(owner(), drop({
      quantity: "400.0000", meterStart: "11000.0000", meterStop: "11380.0000",
    }))).rejects.toThrow(/One of the two is wrong/);
  });

  it("refuses a meter that reads lower at the end", async () => {
    /**
     * Rolled over or replaced, and either way the difference is not the
     * quantity. Not made absolute, because the absolute value of a rollover
     * is nowhere near the amount delivered.
     */
    await expect(deliveries.record(owner(), drop({
      quantity: undefined, meterStart: "11400.0000", meterStop: "11000.0000",
    }))).rejects.toThrow(/rolled over or been replaced/);
  });

  it("refuses a delivery with nothing to charge from", async () => {
    await expect(deliveries.record(owner(), drop({ quantity: undefined })))
      .rejects.toThrow(/either a quantity or both meter readings/);
    await expect(deliveries.record(owner(), drop({ quantity: "0" })))
      .rejects.toThrow(/delivery of nothing/);
  });

  it("refuses a delivery with no unit", async () => {
    /**
     * A quantity of 400 is gallons or litres and the difference is the price
     * of the load.
     */
    await expect(deliveries.record(owner(), drop({ unit: "  " })))
      .rejects.toThrow(/needs a unit/);
  });

  it("refuses a tank that reads emptier after the delivery", async () => {
    /**
     * These two are the input to every consumption forecast the business
     * runs, and they are almost always typed the wrong way round when this
     * happens. As recorded it would tell the forecast the customer burned
     * most of a tank while the driver was standing there.
     */
    await expect(deliveries.record(owner(), drop({
      tankPercentBefore: "80.0000", tankPercentAfter: "20.0000",
    }))).rejects.toThrow(/emptier after the delivery/);
  });

  it("refuses a tank percentage that is a quantity in the wrong box", async () => {
    await expect(deliveries.record(owner(), drop({ tankPercentBefore: "400.0000" })))
      .rejects.toThrow(/nought to a hundred/);
  });

  it("refuses a drop billed to somebody who does not own the tank", async () => {
    /**
     * The customer/property link is the one that matters most here: billing a
     * delivery to somebody who does not own the tank it went into is money
     * taken from the wrong person.
     */
    await expect(deliveries.record(owner(), drop({ propertyId: otherPropertyId })))
      .rejects.toThrow(/not on this customer's account/);
  });

  it("refuses a tank at a different address", async () => {
    const elsewhere = await unit("TANK-1", otherPropertyId);
    await expect(deliveries.record(owner(), drop({ equipmentId: elsewhere })))
      .rejects.toThrow(NotFoundError);
  });

  it("totals what was delivered and counts the wasted trips", async () => {
    /**
     * A partial fill is a different event: "the tank took four hundred" and
     * "the tank would only take ninety because somebody had already filled
     * it" are a sale and a wasted trip. Counting them together is how a
     * dealer concludes their usage model works.
     */
    await deliveries.record(owner(), drop({ quantity: "400.0000" }));
    await deliveries.record(owner(), drop({ quantity: "90.0000", wasPartialFill: true }));

    const all = await deliveries.list(owner(), {});
    expect(all.deliveries).toHaveLength(2);
    expect(all.totals).toEqual({
      quantity: "490.0000", value: "1225.0000", partialFills: 1,
    });

    const wasted = await deliveries.list(owner(), { partialOnly: true });
    expect(wasted.deliveries).toHaveLength(1);
    expect(wasted.totals.partialFills).toBe(1);
  });

  it("refuses somebody who may read invoices but not write one", async () => {
    await expect(deliveries.list(granted("invoice:read"), {}))
      .resolves.toMatchObject({ deliveries: [] });
    await expect(deliveries.record(granted("invoice:read"), drop())).rejects.toThrow();
  });
});

/* ----------------------------------------------------- how fast it goes */

run("how fast a property gets through it", () => {
  async function dropOn(day: string, quantity: string, partial = false) {
    await deliveries.record(owner(), {
      customerId, propertyId, product: "propane", unit: "gal",
      unitPrice: "2.5000", quantity, wasPartialFill: partial,
      deliveredAt: `${day}T12:00:00Z`,
    });
  }

  it("says nothing from one delivery", async () => {
    await dropOn("2026-01-01", "400.0000");
    expect(await deliveries.consumption(owner(), {
      propertyId, product: "propane",
    })).toBeNull();
  });

  it("excludes the first delivery's quantity from the rate", async () => {
    /**
     * THE ARITHMETIC THAT IS EXPENSIVE TO GET WRONG, and the reason this
     * function exists rather than a sum over a window.
     *
     * Consumption is measured BETWEEN deliveries. The oil in the first drop
     * is what the customer burned over a period that started before any
     * record exists, so including it divides a quantity spanning an unknown
     * interval by a known one. The answer is always too high, so the truck
     * goes too early, every time, for every customer.
     *
     * Two drops of 400 a hundred days apart: the measured burn is the SECOND
     * 400 over 100 days, which is 4 a day. Including the first would give 8.
     */
    await dropOn("2026-01-01", "400.0000");
    await dropOn("2026-04-11", "400.0000");

    const rate = await deliveries.consumption(owner(), { propertyId, product: "propane" });
    expect(rate).not.toBeNull();
    expect(rate!.days).toBe(100);
    expect(rate!.quantity).toBe("400.0000");
    expect(rate!.perDay).toBe("4.0000");
  });

  it("will not guess a next date from one interval", async () => {
    /**
     * Two deliveries is one interval, and one interval is not a rate: a cold
     * fortnight would set the schedule for the year. Null rather than a
     * plausible date, because a date gets put on a run sheet.
     */
    await dropOn("2026-01-01", "400.0000");
    await dropOn("2026-04-11", "400.0000");
    const rate = await deliveries.consumption(owner(), { propertyId, product: "propane" });
    expect(rate!.nextDueEstimate).toBeNull();
  });

  it("estimates a next date from three, and it is a date to look at", async () => {
    await dropOn("2026-01-01", "400.0000");
    await dropOn("2026-02-01", "310.0000");
    await dropOn("2026-03-01", "280.0000");

    const rate = await deliveries.consumption(owner(), { propertyId, product: "propane" });
    expect(rate!.deliveries).toBe(3);
    // 590 burned over 59 days is 10 a day; the last drop was 280, so about 28
    // days from the first of March.
    expect(rate!.perDay).toBe("10.0000");
    expect(rate!.nextDueEstimate!.slice(0, 10)).toBe("2026-03-29");
  });

  it("counts the wasted trips alongside the rate", async () => {
    await dropOn("2026-01-01", "400.0000");
    await dropOn("2026-02-01", "90.0000", true);
    await dropOn("2026-03-01", "310.0000");
    const rate = await deliveries.consumption(owner(), { propertyId, product: "propane" });
    expect(rate!.partialFills).toBe(1);
  });

  it("keeps two products apart", async () => {
    /**
     * A rate is per product. Mixing propane and oil produces a number that is
     * not a quantity of either, and the truck that goes on the strength of it
     * is carrying the wrong thing.
     */
    await dropOn("2026-01-01", "400.0000");
    await dropOn("2026-02-01", "310.0000");
    await deliveries.record(owner(), {
      customerId, propertyId, product: "#2 oil", unit: "gal",
      unitPrice: "3.1000", quantity: "200.0000", deliveredAt: "2026-02-15T12:00:00Z",
    });

    const propane = await deliveries.consumption(owner(), { propertyId, product: "propane" });
    expect(propane!.deliveries).toBe(2);
    expect(propane!.quantity).toBe("310.0000");
    expect(await deliveries.consumption(owner(), { propertyId, product: "#2 oil" })).toBeNull();
  });
});
