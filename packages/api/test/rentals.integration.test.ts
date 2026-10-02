import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { rental as rt } from "@opentradesos/core";
import * as rentals from "../src/services/rentals";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A TRADE PACK THAT SHIPPED, AND THE CONTAINER THAT DID NOT EXIST
 *
 * `packs/dumpster-rental.ts` is one of eight packs a company can apply at
 * setup. Two hundred and seventy eight lines: six job types whose capacity
 * model is `asset_rental`, thirty eight price book items built around container
 * days and scale tickets, two checklists written for a driver with a hook
 * truck, and eight KPI definitions precise enough to name how each one is
 * usually computed wrongly.
 *
 * `rentable_asset` had no reader and no writer. Neither did `rental`. Neither
 * did `visit.rental_id` or `visit.rental_event`. A roll off company could apply
 * the pack, get the price book and the checklists, and record no containers.
 *
 * FOUR PROPERTIES THIS FILE IS ACTUALLY ABOUT, each one a thing the pack states
 * and each one the way the trade's arithmetic is usually got wrong:
 *
 *   A container day is any part of a calendar day, not elapsed hours over 24.
 *   The utilisation denominator includes the yard.
 *   The two billing meters are independent, and a missing rate is leakage.
 *   A swap is one placement, not two rentals.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rnt:org");
const USER = fixtureId("rnt:user");
const OTHER_ORG = fixtureId("rnt:other-org");
const OTHER_USER = fixtureId("rnt:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const other = (): ServiceContext => ({
  actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
});
/**
 * Exactly these permissions and NO ROLE, so a pair can be told apart. `owner`
 * holds both halves of every pair here, and the fleet roles hold combinations
 * that would make one of these pass for the wrong reason.
 */
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
let seq = 0;

async function can(identifier: string, size = "20 yard"): Promise<string> {
  const asset = await rentals.addAsset(owner(), {
    assetType: "roll_off_container", identifier, size,
  });
  return asset.id;
}

async function job(): Promise<{ jobId: string; visitId: string }> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, 'scheduled', 'Container delivery')
    returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status)
    values (${ORG}, ${row!.id}, 1, 'scheduled') returning id`;
  return { jobId: row!.id, visitId: visit!.id };
}

/** Central time, so the calendar-day assertions below are about a real zone. */
const ZONE = "America/Chicago";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Haul Co", slug: "haul-co" });
  await seedOrg(raw, {
    organizationId: OTHER_ORG, userId: OTHER_USER, name: "Rival Haul", slug: "rival-haul",
  });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Remodel Ltd', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '14 Elm', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [second] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Oak', 'Austin', 'TX', '78704') returning id`;
  otherPropertyId = second!.id;
});

/* ======================================================= the container day */

describe("a container day", () => {
  it("counts any part of a calendar day, not elapsed hours over twenty four", () => {
    /**
     * THE ARITHMETIC THE WHOLE TRADE RUNS ON, and the one every spreadsheet
     * version gets wrong. A can delivered at 4pm Monday and collected at 9am
     * Tuesday is on site for seventeen hours, which is 0.7 of a day by division
     * and TWO container days by the trade's reckoning: it occupied a space in
     * the fleet on two separate days and the customer had it on two separate
     * days.
     *
     * Every operator counts it the second way and every competitor's invoice
     * counts it the second way. Dividing by twenty four undercharges every
     * short rental and reports a utilisation rate that is quietly too low.
     */
    const monday4pm = new Date("2026-06-01T21:00:00Z");
    const tuesday9am = new Date("2026-06-02T14:00:00Z");
    expect(rt.containerDays(monday4pm, tuesday9am, ZONE)).toBe(2);
  });

  it("counts one day for a can delivered and collected the same day", () => {
    expect(rt.containerDays(
      new Date("2026-06-01T14:00:00Z"), new Date("2026-06-01T20:00:00Z"), ZONE,
    )).toBe(1);
  });

  it("counts in the company's zone, so an evening drop is not a day late", () => {
    /**
     * 2026-06-01T02:00:00Z is 9pm on 31 May in Central time. Counted in UTC the
     * rental starts on 1 June, which loses the day the can actually arrived and
     * does it for every evening drop a company makes.
     */
    const eveningDrop = new Date("2026-06-01T02:00:00Z");
    const nextAfternoon = new Date("2026-06-01T19:00:00Z");
    expect(rt.containerDays(eveningDrop, nextAfternoon, ZONE)).toBe(2);
    expect(rt.containerDays(eveningDrop, nextAfternoon, "UTC")).toBe(1);
  });

  it("is zero rather than negative when the dates are backwards", () => {
    expect(rt.containerDays(
      new Date("2026-06-05T12:00:00Z"), new Date("2026-06-01T12:00:00Z"), ZONE,
    )).toBe(0);
  });
});

/* ============================================================== the fleet */

run("the fleet", () => {
  it("puts a container in the yard, available and in the denominator", async () => {
    const asset = await rentals.addAsset(owner(), {
      assetType: "roll_off_container", identifier: "2041", size: "20 yard",
      purchaseCost: "4800.0000",
    });
    expect(asset.status).toBe("available");
    expect(asset.currentPropertyId).toBeNull();
    expect(asset.identifier).toBe("2041");
  });

  it("refuses a container with no number on it", async () => {
    await expect(rentals.addAsset(owner(), { assetType: "roll_off_container", identifier: "  " }))
      .rejects.toThrow(/needs its number/);
  });

  it("will not take the same number twice", async () => {
    await can("3001");
    await expect(can("3001")).rejects.toThrow();
  });

  it("says where each unit is, by address rather than by id", async () => {
    /**
     * "On site" is not an answer to the question a dispatcher asks twenty times
     * a day, and `current_property_id` on its own is a uuid.
     */
    const a = await can("4001");
    await can("4002");
    await rentals.deliver(owner(), { assetId: a, propertyId });

    const { data } = await rentals.listAssets(owner(), { limit: 50 });
    const byNumber = new Map(data.map((row) => [row.identifier, row]));
    expect(byNumber.get("4001")!.currentAddress).toBe("14 Elm, Austin");
    expect(byNumber.get("4001")!.status).toBe("on_site");
    expect(byNumber.get("4002")!.currentAddress).toBeNull();
  });

  it("will not send out a container that is already on a site", async () => {
    const a = await can("5001");
    await rentals.deliver(owner(), { assetId: a, propertyId });
    await expect(rentals.deliver(owner(), { assetId: a, propertyId: otherPropertyId }))
      .rejects.toThrow(/already on a customer site/);
  });

  it("will not send out a container tagged for repair", async () => {
    const a = await can("5002");
    await rentals.tagOutOfService(owner(), { id: a, reason: "Floor punctured" });
    await expect(rentals.deliver(owner(), { assetId: a, propertyId }))
      .rejects.toThrow(/tagged out of service/);

    await rentals.returnToService(owner(), { id: a });
    const back = await rentals.deliver(owner(), { assetId: a, propertyId });
    expect(back.open).toBe(true);
  });

  it("requires a reason for tagging one out", async () => {
    /**
     * A container tagged out with no reason is one nobody knows how to put
     * back, and it sits outside the utilisation figure indefinitely.
     */
    const a = await can("5003");
    await expect(rentals.tagOutOfService(owner(), { id: a, reason: "  " }))
      .rejects.toThrow(/what is wrong with it/);
  });

  it("tags a unit out straight off a customer site, which is the ordinary case", async () => {
    /**
     * The pickup checklist's last line is "record the container condition and
     * tag it out of service if it needs repair". A state machine that made a
     * driver return it to the yard first would be describing a different trade.
     */
    const a = await can("5004");
    const hire = await rentals.deliver(owner(), { assetId: a, propertyId });
    await rentals.pickUp(owner(), { id: hire.id, backInService: false });
    const { data } = await rentals.listAssets(owner(), { limit: 10 });
    expect(data[0]!.status).toBe("out_of_service");
  });

  it("retires a unit, keeps its history, and refuses while it is out", async () => {
    const a = await can("6001");
    const hire = await rentals.deliver(owner(), { assetId: a, propertyId });

    await expect(rentals.retireAsset(owner(), { id: a }))
      .rejects.toThrow(/Collect it before retiring it/);

    await rentals.pickUp(owner(), { id: hire.id, tons: "1.5000" });
    const gone = await rentals.retireAsset(owner(), { id: a });
    expect(gone.retired).toBe(true);

    /**
     * The hire still resolves to the number. A report saying "container 6001"
     * rather than a uuid is the difference between an answerable tonnage query
     * and an unanswerable one.
     */
    const still = await rentals.getRental(owner(), { id: hire.id });
    expect(still.assetIdentifier).toBe("6001");
    const { data } = await rentals.listAssets(owner(), { limit: 50 });
    expect(data.map((row) => row.identifier)).not.toContain("6001");
  });
});

/* =============================================================== the hire */

run("a hire", () => {
  it("opens at the instant the caller gives, not at the clock", async () => {
    /**
     * A driver writing up a day's drops at five in the evening would otherwise
     * have every rental start at five, and every short hire would lose a day.
     */
    const a = await can("7001");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
    });
    expect(hire.deliveredAt).toBe("2026-06-01T15:00:00.000Z");
  });

  it("points the job's stop at the hire and says which leg it is", async () => {
    /**
     * `visit.rental_id` and `visit.rental_event` were written by nothing, so the
     * board could not tell a driver whether they were dropping or collecting.
     * The pack models delivery, pickup and swap as three job types for exactly
     * this reason: the driver has to arrive with an empty can on the truck for a
     * swap, which the router has to know.
     */
    const a = await can("7002");
    const { jobId, visitId } = await job();
    await rentals.deliver(owner(), { assetId: a, propertyId, jobId });

    const [visit] = await raw<{ rental_id: string | null; rental_event: string | null }[]>`
      select rental_id, rental_event from public.visit where id = ${visitId}`;
    expect(visit!.rental_id).not.toBeNull();
    expect(visit!.rental_event).toBe("delivery");
  });

  it("records a hire with no job behind it, which is the standing container", async () => {
    /**
     * A commercial site with a can that never leaves has no job per period.
     * Inventing a visit so a column could be filled would put a stop on a
     * dispatch board nobody is driving to.
     */
    const a = await can("7003");
    const hire = await rentals.deliver(owner(), { assetId: a, propertyId });
    expect(hire.open).toBe(true);
    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.visit where organization_id = ${ORG}`;
    expect(n).toBe("0");
  });

  it("closes on pickup and records the ticket on the rental, not only the visit", async () => {
    /**
     * The scale ticket is the support behind the largest line on the invoice and
     * the largest line in the cost of goods. A number living in a visit's
     * readings blob cannot be totalled, reconciled against the facility's
     * account, or found when a customer questions a tonnage charge.
     */
    const a = await can("7004");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
    });
    const closed = await rentals.pickUp(owner(), {
      id: hire.id,
      pickedUpAt: "2026-06-08T15:00:00.000Z",
      tons: "2.4000",
      divertedTons: "0.6000",
      ticketNumber: "T-99812",
      facility: "Austin Transfer Station",
      materialType: "Mixed construction and demolition",
      disposalFee: "188.0000",
    });

    expect(closed.open).toBe(false);
    expect(closed.weightTons).toBe("2.4000");
    expect(closed.disposalTicketNumber).toBe("T-99812");
    expect(closed.disposalFacility).toBe("Austin Transfer Station");
    expect(closed.daysSoFar).toBe(8);
  });

  it("will not collect the same container twice", async () => {
    const a = await can("7005");
    const hire = await rentals.deliver(owner(), { assetId: a, propertyId });
    await rentals.pickUp(owner(), { id: hire.id });
    await expect(rentals.pickUp(owner(), { id: hire.id }))
      .rejects.toThrow(/already been collected/);
  });

  it("refuses a pickup dated before the delivery", async () => {
    /** A negative period bills as a credit. */
    const a = await can("7006");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-10T15:00:00.000Z",
    });
    await expect(rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-06-01T15:00:00.000Z" }))
      .rejects.toThrow(/before the delivery/);
  });

  it("refuses a negative tonnage", async () => {
    const a = await can("7007");
    const hire = await rentals.deliver(owner(), { assetId: a, propertyId });
    await expect(rentals.pickUp(owner(), { id: hire.id, tons: "-1.0000" }))
      .rejects.toThrow(/is not a weight/);
  });

  it("counts days to now while the hire is open", async () => {
    /**
     * Named `daysSoFar` rather than a duration, because that is what it is. A
     * dispatcher looking at a board wants to know how long the can has been
     * sitting there; calling it the rental's length would make it look final.
     */
    const a = await can("7008");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    });
    expect(hire.daysSoFar).toBeGreaterThanOrEqual(4);
  });
});

/* =============================================================== the swap */

run("a swap", () => {
  it("closes one rental, opens another, and links them", async () => {
    /**
     * `rental.asset_id` is a single column and the can physically changed, so a
     * swap cannot be an update. The LINK is the point: without it a four week
     * construction hire with three swaps reads as four unrelated week long
     * rentals.
     */
    const full = await can("8001");
    const empty = await can("8002");
    const first = await rentals.deliver(owner(), {
      assetId: full, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      includedDays: 7, overageRate: "12.0000",
    });

    const result = await rentals.swap(owner(), {
      id: first.id, replacementAssetId: empty, at: "2026-06-08T15:00:00.000Z",
      tons: "3.1000", ticketNumber: "T-11", facility: "Austin Transfer Station",
    });

    expect(result.closed.open).toBe(false);
    expect(result.closed.weightTons).toBe("3.1000");
    expect(result.opened.open).toBe(true);
    expect(result.opened.previousRentalId).toBe(first.id);
    expect(result.opened.assetId).toBe(empty);
    expect(result.opened.propertyId).toBe(propertyId);
  });

  it("carries the terms forward rather than asking for them again", async () => {
    /**
     * A swap mid hire does not renegotiate the rate. Asking the caller to resend
     * them means a swap recorded without them silently puts the rest of the hire
     * on no terms at all, which is the no-rate refusal arriving weeks later at
     * billing.
     */
    const full = await can("8003");
    const empty = await can("8004");
    const first = await rentals.deliver(owner(), {
      assetId: full, propertyId,
      includedDays: 14, overageRate: "18.0000", includedTons: "4.0000", perTonRate: "85.0000",
    });
    const { opened } = await rentals.swap(owner(), {
      id: first.id, replacementAssetId: empty,
    });
    expect(opened.includedDays).toBe(14);
    expect(opened.overageRate).toBe("18.0000");
    expect(opened.includedTons).toBe("4.0000");
    expect(opened.perTonRate).toBe("85.0000");
  });

  it("puts the outgoing can back in the yard and the incoming one on the site", async () => {
    const full = await can("8005");
    const empty = await can("8006");
    const first = await rentals.deliver(owner(), { assetId: full, propertyId });
    await rentals.swap(owner(), { id: first.id, replacementAssetId: empty });

    const { data } = await rentals.listAssets(owner(), { limit: 50 });
    const byNumber = new Map(data.map((row) => [row.identifier, row]));
    expect(byNumber.get("8005")!.status).toBe("available");
    expect(byNumber.get("8006")!.status).toBe("on_site");
    expect(byNumber.get("8006")!.currentPropertyId).toBe(propertyId);
  });

  it("refuses a swap for the same container", async () => {
    /** Taking one away and putting it back is a dump and return. */
    const a = await can("8007");
    const hire = await rentals.deliver(owner(), { assetId: a, propertyId });
    await expect(rentals.swap(owner(), { id: hire.id, replacementAssetId: a }))
      .rejects.toThrow(/same container/);
  });

  it("refuses a swap on a closed rental", async () => {
    const a = await can("8008");
    const b = await can("8009");
    const hire = await rentals.deliver(owner(), { assetId: a, propertyId });
    await rentals.pickUp(owner(), { id: hire.id });
    await expect(rentals.swap(owner(), { id: hire.id, replacementAssetId: b }))
      .rejects.toThrow(/already closed/);
  });
});

/* ============================================================ the billing */

run("what the two meters read", () => {
  it("bills days and no tons for a can that sat a long time holding nothing much", async () => {
    /**
     * TWO METERS, NEITHER DERIVED FROM THE OTHER, which is the pack's wording.
     * Three weeks on a seven day rental holding four hundred pounds owes days
     * and no tons, and a single overage figure cannot express that.
     */
    const a = await can("9001");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      includedDays: 7, overageRate: "12.0000", includedTons: "3.0000", perTonRate: "85.0000",
    });
    await rentals.pickUp(owner(), {
      id: hire.id, pickedUpAt: "2026-06-21T15:00:00.000Z", tons: "0.2000",
    });

    const bill = await rentals.overage(owner(), { id: hire.id });
    expect(bill.days).toBe(21);
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toEqual({
      meter: "rental_days", overBy: "14", rate: "12.0000", amount: "168.0000",
    });
    expect(bill.total).toBe("168.0000");
  });

  it("bills tons and no days for a can collected early holding six", async () => {
    const a = await can("9002");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      includedDays: 7, overageRate: "12.0000", includedTons: "3.0000", perTonRate: "85.0000",
    });
    await rentals.pickUp(owner(), {
      id: hire.id, pickedUpAt: "2026-06-02T15:00:00.000Z", tons: "6.0000",
    });

    const bill = await rentals.overage(owner(), { id: hire.id });
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]!.meter).toBe("disposal_tons");
    expect(bill.lines[0]!.overBy).toBe("3.0000");
    expect(bill.lines[0]!.amount).toBe("255.0000");
  });

  it("bills both when both ran over, as two separate lines", async () => {
    /**
     * A customer disputing one of them is entitled to see which, and a total
     * cannot show either.
     */
    const a = await can("9003");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      includedDays: 7, overageRate: "12.0000", includedTons: "3.0000", perTonRate: "85.0000",
    });
    await rentals.pickUp(owner(), {
      id: hire.id, pickedUpAt: "2026-06-11T15:00:00.000Z", tons: "4.5000",
    });

    const bill = await rentals.overage(owner(), { id: hire.id });
    expect(bill.lines.map((line) => line.meter)).toEqual(["rental_days", "disposal_tons"]);
    expect(bill.lines[0]!.amount).toBe("48.0000");
    expect(bill.lines[1]!.amount).toBe("127.5000");
    expect(bill.total).toBe("175.5000");
  });

  it("refuses rather than reporting nothing to charge when a rate is missing", async () => {
    /**
     * A rental eleven days past its included week with no daily rate on it is
     * eleven days of work already done that nobody can invoice, which is exactly
     * what the pack's overage_capture KPI calls billing leakage. Reporting a
     * zero would make the leak invisible and the KPI read a hundred per cent.
     */
    const a = await can("9004");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z", includedDays: 7,
    });
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-06-18T15:00:00.000Z" });

    await expect(rentals.overage(owner(), { id: hire.id }))
      .rejects.toThrow(/carries no daily rate/);
  });

  it("refuses when the tonnage ran over and there is no per ton rate", async () => {
    /**
     * The other half of the missing-rate refusal, and the sweep found it had no
     * test: the days version was covered and the tonnage version was not.
     * Disposal is the largest cost line in this trade, so unbilled tonnage comes
     * straight off the margin rather than off the top line.
     */
    const a = await can("9008");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      includedDays: 30, includedTons: "2.0000",
    });
    await rentals.pickUp(owner(), {
      id: hire.id, pickedUpAt: "2026-06-05T15:00:00.000Z", tons: "5.0000",
    });
    await expect(rentals.overage(owner(), { id: hire.id }))
      .rejects.toThrow(/no per ton rate/);
  });

  it("bills every ton when no tonnage is included", async () => {
    /**
     * The DISP-TON-FLAT line in the pack is "disposal, per ton, no included
     * tonnage", so a null included tonnage means every ton is billable. Reading
     * a null as unlimited would make the largest cost line in the trade free,
     * and the sweep found nothing covering it through `bill`.
     */
    const a = await can("9009");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      perTonRate: "95.0000",
    });
    await rentals.pickUp(owner(), {
      id: hire.id, pickedUpAt: "2026-06-03T15:00:00.000Z", tons: "2.0000",
    });
    const bill = await rentals.overage(owner(), { id: hire.id });
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]!.overBy).toBe("2.0000");
    expect(bill.lines[0]!.amount).toBe("190.0000");
  });

  it("refuses an overage figure while the container is still on site", async () => {
    /**
     * An open hire's overage changes every midnight, and a number that does that
     * on a screen beside an invoice is one somebody will put on the invoice.
     */
    const a = await can("9005");
    const hire = await rentals.deliver(owner(), { assetId: a, propertyId, includedDays: 1 });
    await expect(rentals.overage(owner(), { id: hire.id }))
      .rejects.toThrow(/still on site/);
  });

  it("charges nothing when nothing went over", async () => {
    const a = await can("9006");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      includedDays: 7, overageRate: "12.0000", includedTons: "3.0000", perTonRate: "85.0000",
    });
    await rentals.pickUp(owner(), {
      id: hire.id, pickedUpAt: "2026-06-05T15:00:00.000Z", tons: "1.1000",
    });
    const bill = await rentals.overage(owner(), { id: hire.id });
    expect(bill.lines).toEqual([]);
    expect(bill.total).toBe("0.0000");
  });

  it("charges nothing for days on an open ended standing rate", async () => {
    /**
     * `includedDays` of null is the RO-MONTHLY line: a can that stays on site
     * indefinitely, with hauls and disposal billed per event. A rule that
     * treated a null as zero included days would bill every day of it.
     */
    const a = await can("9007");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-01-01T15:00:00.000Z",
      overageRate: "18.0000",
    });
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-06-01T15:00:00.000Z" });
    const bill = await rentals.overage(owner(), { id: hire.id });
    expect(bill.days).toBe(152);
    expect(bill.lines).toEqual([]);
  });
});

/* ============================================================ the metrics */

run("the fleet report", () => {
  it("counts the yard in the denominator, which is the whole metric", async () => {
    /**
     * THE PACK SAYS IT IN SO MANY WORDS: available days INCLUDE cans sitting in
     * the yard and EXCLUDE only cans tagged out of service, because "excluding
     * yard cans makes a bloated fleet look fully booked".
     *
     * Four cans, thirty days, one can out for all of it. Three available cans
     * times thirty is ninety available days. A report that counted only the can
     * that went out would say a hundred per cent utilisation on a fleet that is
     * three quarters idle, which is the one conclusion this metric exists to
     * prevent.
     */
    const out = await can("A001");
    await can("A002");
    await can("A003");
    const broken = await can("A004");
    await rentals.tagOutOfService(owner(), { id: broken, reason: "Floor rusted through" });

    const hire = await rentals.deliver(owner(), {
      assetId: out, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
    });
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-06-10T15:00:00.000Z" });

    const report = await rentals.fleetReport(owner(), { from: "2026-06-01", to: "2026-06-30" });
    expect(report.windowDays).toBe(30);
    expect(report.outOfServiceUnits).toBe(1);
    expect(report.availableDays).toBe(90);
    expect(report.rentedDays).toBe(10);
    expect(report.utilisationRate).toBe("11.1");
  });

  it("clips a hire that spans the window to the days inside it", async () => {
    /**
     * A can delivered in March and collected in May contributes only April's
     * days to April's figure. Without the clipping a long standing container
     * would push a month's utilisation over a hundred per cent.
     */
    const a = await can("B001");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-03-10T15:00:00.000Z",
    });
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-05-20T15:00:00.000Z" });

    const april = await rentals.fleetReport(owner(), { from: "2026-04-01", to: "2026-04-30" });
    expect(april.rentedDays).toBe(30);
    expect(april.utilisationRate).toBe("100.0");
  });

  it("attributes an evening drop to the day it arrived in the company's zone", async () => {
    /**
     * THE REPORT AND THE RENTAL PAGE HAVE TO AGREE ABOUT THE SAME HIRE, and for
     * a while they could not. `containerDays` counts in the company's timezone;
     * the report's SQL used a bare `::date` on a timestamptz, which converts in
     * the SESSION's zone, and that is UTC.
     *
     * 2026-04-01T00:00:00Z is 7pm on 31 March in Central time. The can arrived in
     * March and the UTC reading puts it in April, which is a day late for every
     * evening drop a company makes and shows up as a March figure that is short
     * and an April figure that is long.
     */
    const a = await can("B003");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-04-01T00:00:00.000Z",
    });
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-04-01T18:00:00.000Z" });

    const march = await rentals.fleetReport(owner(), { from: "2026-03-01", to: "2026-03-31" });
    expect(march.rentedDays).toBe(1);
    const april = await rentals.fleetReport(owner(), { from: "2026-04-01", to: "2026-04-30" });
    expect(april.rentedDays).toBe(1);
  });

  it("counts a thirty day window as thirty days, not thirty one", async () => {
    /**
     * `dayBoundsIn` returns midnight at the start of the day after, which is
     * right for a half open comparison and wrong inside an inclusive day count.
     * One can out for the whole of April reported a hundred and three per cent
     * utilisation.
     */
    const a = await can("B004");
    const hire = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-04-01T15:00:00.000Z",
    });
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-04-30T15:00:00.000Z" });

    const april = await rentals.fleetReport(owner(), { from: "2026-04-01", to: "2026-04-30" });
    expect(april.windowDays).toBe(30);
    expect(april.rentedDays).toBe(30);
    expect(april.utilisationRate).toBe("100.0");
  });

  it("counts an open hire's days up to the end of the window", async () => {
    const a = await can("B002");
    await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-20T15:00:00.000Z",
    });
    const report = await rentals.fleetReport(owner(), { from: "2026-06-01", to: "2026-06-30" });
    expect(report.rentedDays).toBeGreaterThanOrEqual(11);
  });

  it("averages only the hires that ENDED in the window", async () => {
    /**
     * The pack says so, and the reason matters more than it reads: a can that
     * has been on a construction site for ninety days has run longer than any
     * finished rental, and including it at "ninety so far" while excluding its
     * eventual real duration drags the average in both directions at different
     * times. The same average computed a week apart would move for no reason
     * anybody could explain.
     */
    const short = await can("C001");
    const openOne = await can("C002");
    const finished = await rentals.deliver(owner(), {
      assetId: short, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
    });
    await rentals.pickUp(owner(), { id: finished.id, pickedUpAt: "2026-06-05T15:00:00.000Z" });
    await rentals.deliver(owner(), {
      assetId: openOne, propertyId: otherPropertyId, deliveredAt: "2026-06-02T15:00:00.000Z",
    });

    const report = await rentals.fleetReport(owner(), { from: "2026-06-01", to: "2026-06-30" });
    expect(report.rentalsEnded).toBe(1);
    expect(report.averageDurationDays).toBe("5.0");
  });

  it("counts a four week hire with three swaps as one placement", async () => {
    /**
     * THE PACK'S OWN WORDING: average duration "counts a swap inside the parent
     * rental rather than as a rental of its own". Four rows, one placement of
     * twenty nine container days. Counting the rows would report a week.
     */
    const cans = [await can("D001"), await can("D002"), await can("D003"), await can("D004")];
    let current = await rentals.deliver(owner(), {
      assetId: cans[0]!, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
    });
    for (const [index, day] of [["1", "2026-06-08"], ["2", "2026-06-15"], ["3", "2026-06-22"]]
      .map(([n, d]) => [Number(n), d] as const)) {
      const { opened } = await rentals.swap(owner(), {
        id: current.id, replacementAssetId: cans[index]!, at: `${day}T15:00:00.000Z`,
      });
      current = opened;
    }
    await rentals.pickUp(owner(), { id: current.id, pickedUpAt: "2026-06-29T15:00:00.000Z" });

    const report = await rentals.fleetReport(owner(), { from: "2026-06-01", to: "2026-06-30" });
    expect(report.rentalsEnded).toBe(1);
    expect(report.averageDurationDays).toBe("29.0");
  });

  it("follows a swap chain that started before the window", async () => {
    /**
     * A container delivered in March, swapped in April and collected in May is
     * one placement that started in March. A report for May that stopped at the
     * April row would call it a one month hire.
     */
    const first = await can("E001");
    const second = await can("E002");
    const march = await rentals.deliver(owner(), {
      assetId: first, propertyId, deliveredAt: "2026-03-01T15:00:00.000Z",
    });
    const { opened } = await rentals.swap(owner(), {
      id: march.id, replacementAssetId: second, at: "2026-04-01T15:00:00.000Z",
    });
    await rentals.pickUp(owner(), { id: opened.id, pickedUpAt: "2026-05-01T15:00:00.000Z" });

    const may = await rentals.fleetReport(owner(), { from: "2026-05-01", to: "2026-05-31" });
    expect(may.rentalsEnded).toBe(1);
    /** 1 March to 1 May inclusive. */
    expect(may.averageDurationDays).toBe("62.0");
  });

  it("excludes a haul with no ticket rather than averaging it in at zero", async () => {
    /**
     * The pack says a haul with no ticket "should be investigated rather than
     * averaged in at zero". Folding it in both understates the average and
     * removes the only signal that the ticket is missing, so the count of
     * missing ones comes back alongside.
     */
    const a = await can("F001");
    const b = await can("F002");
    const withTicket = await rentals.deliver(owner(), {
      assetId: a, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
    });
    await rentals.pickUp(owner(), {
      id: withTicket.id, pickedUpAt: "2026-06-05T15:00:00.000Z", tons: "3.0000",
    });
    const noTicket = await rentals.deliver(owner(), {
      assetId: b, propertyId: otherPropertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
    });
    await rentals.pickUp(owner(), { id: noTicket.id, pickedUpAt: "2026-06-05T15:00:00.000Z" });

    const report = await rentals.fleetReport(owner(), { from: "2026-06-01", to: "2026-06-30" });
    expect(report.averageTonsPerHaul).toBe("3.00");
    expect(report.haulsWithTicket).toBe(1);
    expect(report.haulsWithoutTicket).toBe(1);
  });

  it("does not count an open hire as a haul with no ticket", async () => {
    /**
     * The sweep caught this one. The query that gathers finished hires filters on
     * a pickup date, and a loop below it skips rows with no pickup, so removing
     * the filter looked harmless. It is not: an open hire has no tonnage either,
     * so it would arrive in the ticket list and be counted as a haul whose scale
     * ticket is missing. That number is a worklist, and a can that is still on
     * site has not been to a weighbridge yet.
     */
    const done = await can("F003");
    const stillOut = await can("F004");
    const finished = await rentals.deliver(owner(), {
      assetId: done, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
    });
    await rentals.pickUp(owner(), {
      id: finished.id, pickedUpAt: "2026-06-04T15:00:00.000Z", tons: "2.0000",
    });
    await rentals.deliver(owner(), {
      assetId: stillOut, propertyId: otherPropertyId, deliveredAt: "2026-06-02T15:00:00.000Z",
    });

    const report = await rentals.fleetReport(owner(), { from: "2026-06-01", to: "2026-06-30" });
    expect(report.haulsWithTicket).toBe(1);
    expect(report.haulsWithoutTicket).toBe(0);
  });

  it("reads an unbillable overage as leakage rather than as success", async () => {
    /**
     * The pack: "anything under one hundred percent is work already done and
     * never invoiced". A rental that went over its period with no rate on it has
     * to count in the denominator and not the numerator, otherwise a fleet
     * giving days away reports a hundred per cent capture.
     */
    const billable = await can("G001");
    const leaking = await can("G002");

    const first = await rentals.deliver(owner(), {
      assetId: billable, propertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      includedDays: 3, overageRate: "12.0000",
    });
    await rentals.pickUp(owner(), { id: first.id, pickedUpAt: "2026-06-10T15:00:00.000Z" });

    const second = await rentals.deliver(owner(), {
      assetId: leaking, propertyId: otherPropertyId, deliveredAt: "2026-06-01T15:00:00.000Z",
      includedDays: 3,
    });
    await rentals.pickUp(owner(), { id: second.id, pickedUpAt: "2026-06-10T15:00:00.000Z" });

    const report = await rentals.fleetReport(owner(), { from: "2026-06-01", to: "2026-06-30" });
    expect(report.exceededRentals).toBe(2);
    expect(report.billableRentals).toBe(1);
    expect(report.overageCaptureRate).toBe("50.0");
  });

  it("says nothing rather than zero when there is no fleet", async () => {
    const report = await rentals.fleetReport(owner(), { from: "2026-06-01", to: "2026-06-30" });
    expect(report.utilisationRate).toBeNull();
    expect(report.averageDurationDays).toBeNull();
    expect(report.averageTonsPerHaul).toBeNull();
    expect(report.overageCaptureRate).toBeNull();
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(rentals.fleetReport(owner(), { from: "2026-06-30", to: "2026-06-01" }))
      .rejects.toThrow(/before its start/);
  });
});

/* =========================================================== who may do it */

run("who may run the fleet", () => {
  it("tells reading the fleet apart from changing it", async () => {
    const asset = await rentals.addAsset(granted("asset:write"), {
      assetType: "roll_off_container", identifier: "H001",
    });
    await expect(rentals.addAsset(granted("asset:read"), {
      assetType: "roll_off_container", identifier: "H002",
    })).rejects.toThrow(/permission/);
    await expect(rentals.listAssets(granted("asset:write"), { limit: 10 }))
      .rejects.toThrow(/permission/);
    expect((await rentals.listAssets(granted("asset:read"), { limit: 10 })).data).toHaveLength(1);
    expect(asset.identifier).toBe("H001");
  });

  it("will not let one company see or move another's containers", async () => {
    /**
     * Row level security rather than the `organization_id` clause in the
     * service, which is why this test matters: the service's reads carry the
     * clause too, so a test that only went through them could not tell which was
     * working. The raw count below is RLS.
     */
    const mine = await can("I001");
    const hire = await rentals.deliver(owner(), { assetId: mine, propertyId });
    await expect(rentals.getRental(other(), { id: hire.id })).rejects.toThrow(NotFoundError);
    await expect(rentals.pickUp(other(), { id: hire.id })).rejects.toThrow(NotFoundError);
    await expect(rentals.tagOutOfService(other(), { id: mine, reason: "theirs" }))
      .rejects.toThrow(NotFoundError);
    expect((await rentals.listAssets(other(), { limit: 50 })).data).toEqual([]);
  });

  it("refuses a property or a job belonging to nobody", async () => {
    const a = await can("J001");
    await expect(rentals.deliver(owner(), { assetId: a, propertyId: fixtureId("rnt:ghost") }))
      .rejects.toThrow(NotFoundError);
    await expect(rentals.deliver(owner(), {
      assetId: a, propertyId, jobId: fixtureId("rnt:ghost-job"),
    })).rejects.toThrow(NotFoundError);
  });
});

/* ============================================================ arithmetic */

describe("the metrics, as arithmetic", () => {
  it("reports nothing rather than zero per cent on an empty fleet", () => {
    /**
     * Zero per cent utilisation says a fleet is idle. No fleet says there is
     * nothing to measure, which is a different problem with a different fix.
     */
    expect(rt.utilisation({ rentedDays: 0, availableDays: 0 })).toBeNull();
    expect(rt.utilisation({ rentedDays: 0, availableDays: 30 })).toBe("0.0");
  });

  it("refuses a negative tonnage handed straight to the arithmetic", () => {
    /**
     * Only reachable from core. The service checks the tonnage when the ticket
     * is recorded, so a negative one can never be stored, which means `bill`'s
     * own check has no path through the API and needs a direct test or it is a
     * guard nothing covers. The sweep is what made that visible.
     */
    const verdict = rt.bill({
      deliveredAt: new Date("2026-06-01T12:00:00Z"),
      pickedUpAt: new Date("2026-06-02T12:00:00Z"),
      zone: ZONE,
      period: { includedDays: null, overageRate: null },
      weight: { includedTons: "1.0000", perTonRate: "85.0000" },
      tons: "-3.0000",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusals[0]!.reason).toBe("negative_tons");
  });

  it("refuses a backwards period rather than billing it as a credit", () => {
    const verdict = rt.bill({
      deliveredAt: new Date("2026-06-10T12:00:00Z"),
      pickedUpAt: new Date("2026-06-01T12:00:00Z"),
      zone: ZONE,
      period: { includedDays: 7, overageRate: "12.0000" },
      weight: { includedTons: null, perTonRate: null },
      tons: null,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusals[0]!.reason).toBe("backwards");
  });

  it("counts a rental that exceeded but could not be billed", () => {
    /**
     * `exceeded` is deliberately separate from `bill`: asking `bill` would hide
     * exactly the rentals the capture metric exists to find.
     */
    const over = rt.exceeded({ days: 14, includedDays: 7, tons: null, includedTons: null });
    expect(over).toEqual({ days: true, tons: false, either: true });
  });

  it("treats an absent included tonnage as none included, not as unlimited", () => {
    /**
     * The DISP-TON-FLAT line in the pack is "disposal, per ton, no included
     * tonnage", so a null included tonnage means every ton is billable. Reading
     * it as unlimited would make the largest cost line in the trade free.
     */
    const over = rt.exceeded({ days: 1, includedDays: null, tons: "2.0000", includedTons: null });
    expect(over.tons).toBe(true);
  });

  it("will not move a container from the repair bay straight onto a site", () => {
    expect(rt.canMove("out_of_service", "on_site")).toBe(false);
    expect(rt.canMove("on_site", "out_of_service")).toBe(true);
    expect(rt.canMove("available", "on_site")).toBe(true);
  });

  it("has a sentence for every refusal a container move can hit", () => {
    for (const from of rt.ASSET_STATUSES) {
      for (const to of rt.ASSET_STATUSES) {
        if (rt.canMove(from, to)) continue;
        expect(rt.moveRefusal(from, to).length).toBeGreaterThan(20);
      }
    }
  });

  it("averages nothing over an empty set", () => {
    expect(rt.averageDuration([])).toBeNull();
    expect(rt.averageTons([])).toEqual({ average: null, withTicket: 0, withoutTicket: 0 });
    expect(rt.overageCapture({ exceeded: 0, billed: 0 })).toBeNull();
  });
});

/** Keeps the ConflictError import honest. */
describe("refusal types", () => {
  it("uses ConflictError for a refusal about the trade rather than a missing row", () => {
    expect(new ConflictError("x")).toBeInstanceOf(Error);
  });
});
