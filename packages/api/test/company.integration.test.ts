import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as company from "../src/services/company";
import * as timeOff from "../src/services/time-off";
import * as crews from "../src/services/crews";
import * as inventory from "../src/services/inventory";
import * as properties from "../src/services/properties";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE COMPANY'S OWN SHAPE, AND THE GATES THAT COULD NEVER FIRE
 *
 * Four tables shipped in the first migration with no writer anywhere:
 * `business_unit`, `location`, `territory` and `time_off`, plus
 * `reorder_policy` in inventory. Seven services read them and several refuse
 * work on what they find.
 *
 * THE PROPERTY MOST OF THIS FILE IS ABOUT is not that the new write paths
 * work. It is that the EXISTING refusals now happen, and the tests that prove
 * it are the ones marked as payoffs below. Each one drives a decision that
 * was reachable only by a human writing SQL:
 *
 *   A crew refused for being in a different business unit. The comparison was
 *   between two nulls on every job in every company.
 *
 *   A crew refused because everybody on it is away. Approved leave could not
 *   be recorded, so no technician in any company was ever away.
 *
 *   A property resolved into a territory, which decides its travel fee and
 *   its route. Every property was outside every area.
 *
 *   A reorder suggestion. `toOrder` opens with "no policies, return nothing",
 *   and nothing could write a policy, so the screen was empty for everyone.
 *
 *   A purchase order at all, because `purchase_order.default_location_id` is
 *   NOT NULL and no location could exist.
 *
 * A test that only checked the new create paths would pass with every one of
 * those still broken, which is why they are each driven to the far side.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("co:org");
const USER = fixtureId("co:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/** Holds visit:dispatch and timeclock:own, and NOT settings:write. */
const dispatcher = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] }, db: db(),
});
/** Holds timeclock:own and NOT timesheet:approve. */
const technicianCtx = (userId: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: ["technician"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

async function technician(key: string, name: string): Promise<{ id: string; userId: string }> {
  const userId = fixtureId(`co:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`co-${key}@test.local`})
            on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${m!.id}, ${name}, true) returning id`;
  return { id: t!.id, userId };
}

async function jobIn(businessUnitId: string | null): Promise<string> {
  const [n] = await raw<{ next: number }[]>`
    select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id,
                            business_unit_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, ${businessUnitId},
            'scheduled', 'Replace the panel')
    returning id`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Company Co", slug: "company-co" });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name)
    values (${ORG}, 'residential', 'Setup Customer') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '5 Setup Street', 'Austin', 'TX', '78702') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
});

/* -------------------------------------------------------- business units */

run("divisions of the company", () => {
  it("creates one, which nothing could do", async () => {
    const unit = await company.createBusinessUnit(owner(), { name: "Service", code: "SVC" });
    expect(unit).toMatchObject({ name: "Service", code: "SVC", active: true });
    expect(await company.listBusinessUnits(owner())).toHaveLength(1);
  });

  it("PAYOFF: a crew is now refused for a job in another division", async () => {
    /**
     * The blocker is in `services/crews.ts` and has always been correct. It
     * compares `crew.business_unit_id` against `job.business_unit_id`, both
     * nullable, and nothing could set either, so for the life of the product
     * it compared null against null and never fired once.
     *
     * The second half is what makes this a test of the comparison rather than
     * of the create: the SAME crew takes the job in its OWN division.
     */
    const service = await company.createBusinessUnit(owner(), { name: "Service" });
    const install = await company.createBusinessUnit(owner(), { name: "Install" });

    const crew = await crews.create(owner(), { name: "Install crew", businessUnitId: install.id });
    const tech = await technician("bu", "Dana");
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: tech.id }] });

    const wrong = await crews.canTake(owner(), {
      id: crew.id, jobId: await jobIn(service.id), on: "2026-06-02",
    });
    expect(wrong.blockers.map((b) => b.code)).toContain("different_business_unit");
    expect(wrong.canTake).toBe(false);

    const right = await crews.canTake(owner(), {
      id: crew.id, jobId: await jobIn(install.id), on: "2026-06-02",
    });
    expect(right.blockers.map((b) => b.code)).not.toContain("different_business_unit");
  });

  it("refuses a second division with the same code", async () => {
    /**
     * Two units with one code means an accounting export that attributes
     * revenue to whichever one the join picked, which is a number somebody
     * reconciles and cannot explain.
     */
    await company.createBusinessUnit(owner(), { name: "Service", code: "SVC" });
    await expect(company.createBusinessUnit(owner(), { name: "Other", code: "SVC" }))
      .rejects.toThrow(ConflictError);
    // And a unit may keep its own code through an unrelated edit.
    const unit = await company.createBusinessUnit(owner(), { name: "Install", code: "INS" });
    await expect(company.updateBusinessUnit(owner(), { id: unit.id, name: "Installation", code: "INS" }))
      .resolves.toMatchObject({ name: "Installation", code: "INS" });
  });

  it("retires rather than deleting, and keeps what points at it", async () => {
    /**
     * Every foreign key onto `business_unit` is ON DELETE SET NULL, so a
     * delete would silently unscope twelve tables of history and last year's
     * revenue by branch would change. The job still names the retired unit.
     */
    const unit = await company.createBusinessUnit(owner(), { name: "Service" });
    const jobId = await jobIn(unit.id);
    await company.updateBusinessUnit(owner(), { id: unit.id, active: false });

    const [job] = await raw<{ business_unit_id: string | null }[]>`
      select business_unit_id from public.job where id = ${jobId}`;
    expect(job!.business_unit_id).toBe(unit.id);
    expect((await company.listBusinessUnits(owner()))[0]).toMatchObject({ active: false });
  });

  it("refuses a division with no name", async () => {
    await expect(company.createBusinessUnit(owner(), { name: "   " }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses somebody who may only LOOK at the settings", async () => {
    /**
     * GRANTED `settings:read` AND NOTHING ELSE, which is the only actor that
     * can tell the pair apart.
     *
     * The first version of this used a dispatcher, and a deliberate downgrade
     * of the guard from `settings:write` to `settings:read` left it green: a
     * dispatcher holds NEITHER, so the test could not say which of the two
     * was being checked. It is the recurring trap in this suite, and it is
     * also how a settings screen ends up editable by everyone who can see it.
     */
    const reader: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG,
        roles: ["technician"] as Actor["roles"],
        grants: ["settings:read"] as NonNullable<Actor["grants"]>,
      },
      db: db(),
    };
    await expect(company.listBusinessUnits(reader)).resolves.toEqual([]);
    await expect(company.createBusinessUnit(reader, { name: "Service" })).rejects.toThrow();
    await expect(company.createLocation(reader, { name: "Depot" })).rejects.toThrow();
    await expect(company.createTerritory(reader, { name: "North" })).rejects.toThrow();

    // And somebody who may dispatch still cannot, which is the other half.
    await expect(company.createBusinessUnit(dispatcher(), { name: "Service" })).rejects.toThrow();
  });
});

/* -------------------------------------------------------------- locations */

run("branches and warehouses", () => {
  it("creates one, and the branch keeps its own time zone", async () => {
    const place = await company.createLocation(owner(), {
      name: "Phoenix branch", city: "Phoenix", state: "AZ",
      timezone: "America/Phoenix", isWarehouse: true,
    });
    expect(place).toMatchObject({
      name: "Phoenix branch", timezone: "America/Phoenix", isWarehouse: true, country: "US",
    });
  });

  it("refuses a time zone this server cannot resolve", async () => {
    /**
     * Every day window in the product hands the stored name to `Intl`, which
     * does not throw on a bad one so much as produce the wrong day. Refused
     * in front of the person who typed it rather than at six the next morning
     * in front of a dispatcher.
     *
     * The check is `time.isZone` in core, which `services/branding.ts` now
     * calls too: it was written out inline there, and two rules about which
     * zones exist can disagree.
     */
    await expect(company.createLocation(owner(), { name: "Bad", timezone: "US/Pacfic" }))
      .rejects.toThrow(/not a time zone/);
  });

  it("PAYOFF: a purchase order becomes possible", async () => {
    /**
     * `purchase_order.default_location_id` is NOT NULL with ON DELETE
     * RESTRICT. Until a location could exist, the whole purchasing path was
     * unreachable: `createPurchaseOrder` had no location to be given.
     */
    const warehouse = await company.createLocation(owner(), {
      name: "Main warehouse", isWarehouse: true,
    });
    const vendor = await inventory.createVendor(owner(), { name: "Supply Co" });
    const order = await inventory.createPurchaseOrder(owner(), {
      vendorId: vendor.id,
      defaultLocationId: warehouse.id,
      lines: [{ itemId: await stockedItem(), quantity: "10", unitPrice: "4.0000" }],
    });
    expect(order.id).toBeTruthy();
  });

  it("refuses turning a warehouse that holds stock into one that is not", async () => {
    /**
     * Stock is only counted where `is_warehouse` is true. Turning the flag
     * off on a location holding parts does not move them, it hides them: the
     * count drops, the reorder report starts asking for things that are on
     * the shelf, and nothing says where they went.
     */
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();
    await inventory.receive(owner(), {
      itemId, locationId: warehouse.id, quantity: "5", totalCost: "20.0000",
    });

    await expect(company.updateLocation(owner(), { id: warehouse.id, isWarehouse: false }))
      .rejects.toThrow(/still holds stock/);
  });

  it("allows it once the stock has gone, rather than once it has never been there", async () => {
    /**
     * THE REASON THE CHECK FOLDS THE LEDGER RATHER THAN COUNTING ROWS.
     *
     * There is no stock level table: on hand is derived from the append only
     * movement ledger, and the sign of a movement is a property of its KIND.
     * A location that received five and issued five has movements and holds
     * nothing, and a `count(*)` on movements would refuse this forever.
     */
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();
    await inventory.receive(owner(), {
      itemId, locationId: warehouse.id, quantity: "5", totalCost: "20.0000",
    });
    await inventory.count(owner(), {
      itemId, locationId: warehouse.id, counted: "0", reasonCode: "cycle_count",
    });

    await expect(company.updateLocation(owner(), { id: warehouse.id, isWarehouse: false }))
      .resolves.toMatchObject({ isWarehouse: false });
  });

  it("lists only warehouses when asked", async () => {
    await company.createLocation(owner(), { name: "Office", isWarehouse: false });
    await company.createLocation(owner(), { name: "Store", isWarehouse: true });
    expect(await company.listLocations(owner(), { warehousesOnly: true })).toHaveLength(1);
    expect(await company.listLocations(owner(), {})).toHaveLength(2);
  });
});

/** A price book item that stock can be received against. */
async function stockedItem(): Promise<string> {
  const [category] = await raw<{ id: string }[]>`
    insert into public.price_book_category (organization_id, name)
    values (${ORG}, 'Parts') returning id`;
  const [item] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, category_id, kind, code)
    values (${ORG}, ${category!.id}, 'material', 'CAP-1') returning id`;
  await raw`
    insert into public.price_book_item_version
      (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${item!.id}, 1, 'Capacitor', '12.0000', now())`;
  return item!.id;
}

/* ------------------------------------------------------------ territories */

run("the areas the company covers", () => {
  it("creates one and normalises its postal codes", async () => {
    /**
     * A postal code is matched as a string against a property's own, and
     * "78701 " never equals "78701". Case matters for the countries whose
     * codes carry letters, and the symptom of getting it wrong is one
     * neighbourhood having no travel fee for no visible reason.
     */
    const area = await company.createTerritory(owner(), {
      name: "Central", postalCodes: [" 78701 ", "78702", "78701", "k1a 0b1"],
      travelFee: "25.0000",
    });
    expect(area.postalCodes).toEqual(["78701", "78702", "K1A 0B1"]);
    expect(area.travelFee).toBe("25.0000");
  });

  it("PAYOFF: a property now resolves into an area", async () => {
    /**
     * A property's territory decides its travel fee and which route a stop
     * belongs to. With no territories, every property in every company
     * resolved to nothing, and `property.territory_id` was a column no
     * screen could fill.
     */
    const area = await company.createTerritory(owner(), {
      name: "East", postalCodes: ["78702"],
    });
    await properties.update(owner(), { id: propertyId, territoryId: area.id });

    const found = await properties.list(owner(), { territoryId: area.id, limit: 50 });
    expect(found.data.map((p) => p.id)).toContain(propertyId);
  });

  it("refuses a postal code that is already in another area", async () => {
    /**
     * `services/properties.ts` resolves a territory by finding the one whose
     * codes contain the property's. With two matches it takes whichever row
     * came back first, which is not stable across a vacuum, so the same
     * property can change territory, travel fee and route between two reads
     * with nothing changing in the data.
     */
    await company.createTerritory(owner(), { name: "Central", postalCodes: ["78701", "78702"] });
    await expect(company.createTerritory(owner(), { name: "East", postalCodes: ["78702"] }))
      .rejects.toThrow(/already in "Central"/);
  });

  it("lets an area keep its own codes through an edit", async () => {
    const area = await company.createTerritory(owner(), { name: "Central", postalCodes: ["78701"] });
    await expect(company.updateTerritory(owner(), {
      id: area.id, name: "Central Austin", postalCodes: ["78701", "78703"],
    })).resolves.toMatchObject({ postalCodes: ["78701", "78703"] });
  });

  it("frees a code once the area holding it is retired", async () => {
    /**
     * Retired areas are excluded from the overlap check, because a code that
     * is only claimed by something switched off is not claimed. Without this
     * a company reorganising their patches could never reuse a code.
     */
    const old = await company.createTerritory(owner(), { name: "Old", postalCodes: ["78701"] });
    await company.updateTerritory(owner(), { id: old.id, active: false });
    await expect(company.createTerritory(owner(), { name: "New", postalCodes: ["78701"] }))
      .resolves.toMatchObject({ name: "New" });
  });
});

/* --------------------------------------------------------------- time off */

run("the day somebody is away", () => {
  it("records a request and does NOT approve it", async () => {
    /**
     * The board, the crew gate and the booking page all read approved leave
     * only. A request that granted itself would make them refuse work on a
     * day nobody has agreed to, and `approved` would mean nothing.
     */
    const tech = await technician("off", "Ana");
    const asked = await timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-01T00:00:00Z",
      endsAt: "2026-06-05T23:59:00Z",
      reason: "Holiday",
    });
    expect(asked).toMatchObject({ approved: false, standing: "requested" });
    expect(await timeOff.pending(owner())).toHaveLength(1);
  });

  it("PAYOFF: an approval is what the crew gate refuses on", async () => {
    /**
     * `everybody_off` in `services/crews.ts` reads approved leave bounded in
     * the company's own zone. It could never fire, because approved leave
     * could not be recorded, so every technician in every company was
     * available every day.
     *
     * The request is made AND the crew is checked before approval, so this is
     * a test of the approval rather than of the row existing.
     */
    const tech = await technician("gate", "Bo");
    const crew = await crews.create(owner(), { name: "Two hander" });
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: tech.id }] });
    const jobId = await jobIn(null);

    const asked = await timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-01T00:00:00Z",
      endsAt: "2026-06-05T23:59:00Z",
    });

    const whileRequested = await crews.canTake(owner(), { id: crew.id, jobId, on: "2026-06-02" });
    expect(whileRequested.blockers.map((b) => b.code)).not.toContain("everybody_off");

    await timeOff.approve(owner(), { id: asked.id });

    const whileApproved = await crews.canTake(owner(), { id: crew.id, jobId, on: "2026-06-02" });
    expect(whileApproved.blockers.map((b) => b.code)).toContain("everybody_off");
    expect(whileApproved.headcount.availableOn).toBe(0);
  });

  it("refuses an overlapping request for the same person", async () => {
    const tech = await technician("ov", "Cy");
    await timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    });
    await expect(timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-04T00:00:00Z", endsAt: "2026-06-08T00:00:00Z",
    })).rejects.toThrow(/overlaps time off/);
  });

  it("refuses an approval that would create an overlap after the fact", async () => {
    /**
     * TWO REQUESTS CAN BOTH BE LEGAL AND THE SECOND APPROVAL ILLEGAL, which
     * is why the check runs again here. A request is checked against what
     * exists when it is made, and the first version of this service checked
     * only there: two overlapping requests queued before either was granted
     * would both be approved, and the board would show one technician off
     * twice on the same morning.
     *
     * The rows are written directly so neither goes through the request-time
     * check, which is the state the service has to survive rather than
     * prevent.
     */
    const tech = await technician("post", "Dee");
    const [first] = await raw<{ id: string }[]>`
      insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${tech.id}, '2026-06-01T00:00:00Z', '2026-06-05T00:00:00Z', false)
      returning id`;
    const [second] = await raw<{ id: string }[]>`
      insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${tech.id}, '2026-06-04T00:00:00Z', '2026-06-08T00:00:00Z', false)
      returning id`;

    await timeOff.approve(owner(), { id: first!.id });
    await expect(timeOff.approve(owner(), { id: second!.id }))
      .rejects.toThrow(/overlaps time off already approved/);
  });

  it("declines by keeping the row and taking it off the board", async () => {
    /**
     * Soft deleted rather than removed, because "did I put in for that week"
     * is a question people ask months later and a deleted row answers it with
     * silence. Every reader filters `deleted_at`, so it stops affecting the
     * board the moment this commits.
     */
    const tech = await technician("dec", "Eli");
    const asked = await timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    });
    const declined = await timeOff.decline(owner(), { id: asked.id, reason: "Too many out" });
    expect(declined.standing).toBe("declined");

    expect(await timeOff.list(owner(), { technicianId: tech.id })).toHaveLength(0);
    const withHistory = await timeOff.list(owner(), {
      technicianId: tech.id, includeDeclined: true,
    });
    expect(withHistory).toHaveLength(1);
    expect(withHistory[0]!.reason).toBe("Too many out");

    // And the same window can be asked for again, because nothing claims it.
    await expect(timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    })).resolves.toMatchObject({ standing: "requested" });
  });

  it("needs a reason to take an approval back, and not to turn one down", async () => {
    const tech = await technician("rev", "Fay");
    const asked = await timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    });
    // A plain decline of something nobody granted needs none.
    await expect(timeOff.decline(owner(), { id: asked.id })).resolves.toMatchObject({
      standing: "declined",
    });

    const second = await timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-07-01T00:00:00Z", endsAt: "2026-07-05T00:00:00Z",
    });
    await timeOff.approve(owner(), { id: second.id });
    await expect(timeOff.decline(owner(), { id: second.id })).rejects.toThrow(/needs a reason/);
  });

  it("will not approve something already declined", async () => {
    const tech = await technician("und", "Gus");
    const asked = await timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    });
    await timeOff.decline(owner(), { id: asked.id });
    await expect(timeOff.approve(owner(), { id: asked.id })).rejects.toThrow(/was declined/);
  });

  it("refuses a window that ends before it starts", async () => {
    const tech = await technician("inv", "Hal");
    await expect(timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-05T00:00:00Z", endsAt: "2026-06-01T00:00:00Z",
    })).rejects.toThrow(/end after it starts/);
  });

  it("lets a technician ask for their own day and not grant it", async () => {
    /**
     * THE PERMISSION SPLIT THAT MAKES `approved` MEAN ANYTHING. A technician
     * holds `timeclock:own` and not `timesheet:approve`, so they can ask and
     * cannot clear their own week.
     */
    const tech = await technician("self", "Ivy");
    const ctx = technicianCtx(tech.userId);

    const asked = await timeOff.request(ctx, {
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    });
    expect(asked.technicianId).toBe(tech.id);
    await expect(timeOff.approve(ctx, { id: asked.id })).rejects.toThrow();
    await expect(timeOff.pending(ctx)).rejects.toThrow();
  });

  it("refuses a technician recording somebody else's day", async () => {
    const mine = await technician("mine", "Jo");
    const theirs = await technician("theirs", "Kit");
    await expect(timeOff.request(technicianCtx(mine.userId), {
      technicianId: theirs.id,
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    })).rejects.toThrow();
  });

  it("lets somebody withdraw their own request, and only while it is pending", async () => {
    const tech = await technician("wd", "Lee");
    const ctx = technicianCtx(tech.userId);
    const asked = await timeOff.request(ctx, {
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    });
    await expect(timeOff.withdraw(ctx, { id: asked.id })).resolves.toMatchObject({
      standing: "declined",
    });

    const second = await timeOff.request(ctx, {
      startsAt: "2026-07-01T00:00:00Z", endsAt: "2026-07-05T00:00:00Z",
    });
    await timeOff.approve(owner(), { id: second.id });
    await expect(timeOff.withdraw(ctx, { id: second.id })).rejects.toThrow(/already approved/);
  });

  it("refuses withdrawing somebody else's request", async () => {
    const mine = await technician("w1", "Max");
    const theirs = await technician("w2", "Nia");
    const asked = await timeOff.request(owner(), {
      technicianId: theirs.id,
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    });
    await expect(timeOff.withdraw(technicianCtx(mine.userId), { id: asked.id }))
      .rejects.toThrow(/somebody else's/);
  });

  it("tells somebody with no technician row what to do instead", async () => {
    /**
     * An office manager has a membership and no technician row, which is
     * correct: they do not appear on the board. The refusal says so rather
     * than failing on a null.
     */
    await expect(timeOff.request(owner(), {
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-05T00:00:00Z",
    })).rejects.toThrow(/not set up as a technician/);
  });

  it("finds leave that spans the window rather than sitting inside it", async () => {
    /**
     * OVERLAP, NOT CONTAINMENT. A fortnight starting before the window and
     * ending after it covers every day in it and is contained by nothing, so
     * a containment filter would leave the board showing that technician as
     * available all week.
     */
    const tech = await technician("span", "Oz");
    const asked = await timeOff.request(owner(), {
      technicianId: tech.id,
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-20T00:00:00Z",
    });
    await timeOff.approve(owner(), { id: asked.id });

    const found = await timeOff.list(owner(), {
      technicianId: tech.id, from: "2026-06-08T00:00:00Z", to: "2026-06-12T00:00:00Z",
    });
    expect(found).toHaveLength(1);
  });
});

/* -------------------------------------------------------- reorder policy */

run("what to buy, which had nothing to read", () => {
  it("PAYOFF: a suggestion appears where the screen was always empty", async () => {
    /**
     * `toOrder` opens with "no policies, return nothing", and nothing could
     * write a policy. So the suggestion screen returned an empty array for
     * every company that ever opened it, and `inv.suggestReorders` in core,
     * with its reorder point and its on-order arithmetic, had no caller that
     * could reach it with data.
     *
     * Both halves: empty before, and a named part after.
     */
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();

    expect(await inventory.toOrder(owner())).toEqual([]);

    await inventory.setReorderPolicy(owner(), {
      itemId, locationId: warehouse.id,
      reorderPoint: "10.0000", reorderQuantity: "25.0000",
    });

    const suggestions = await inventory.toOrder(owner());
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ itemId, itemName: "Capacitor", locationName: "Main" });
  });

  it("stops suggesting once there is enough on the shelf", async () => {
    /**
     * That the suggestion is computed from the position rather than merely
     * emitted for every policy. A policy with stock above its point should
     * produce nothing, and a test that only checked the first case would pass
     * with `suggestReorders` returning every policy it was given.
     */
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();
    await inventory.setReorderPolicy(owner(), {
      itemId, locationId: warehouse.id,
      reorderPoint: "10.0000", reorderQuantity: "25.0000",
    });
    await inventory.receive(owner(), {
      itemId, locationId: warehouse.id, quantity: "40", totalCost: "160.0000",
    });
    expect(await inventory.toOrder(owner())).toEqual([]);
  });

  it("refuses a target level below the point that triggers the order", async () => {
    /**
     * Every order would leave stock under the point that triggered it, so the
     * same suggestion comes back tomorrow, forever, and nobody can tell
     * whether the order was placed.
     */
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();
    await expect(inventory.setReorderPolicy(owner(), {
      itemId, locationId: warehouse.id,
      reorderPoint: "20.0000", reorderQuantity: "5.0000", targetLevel: "10.0000",
    })).rejects.toThrow(/below the reorder point/);
  });

  it("refuses a policy somewhere stock is not counted", async () => {
    /**
     * Stock is only counted at a warehouse, so a policy anywhere else
     * compares a reorder point against a position that is always zero: it
     * suggests the same order every day and nothing arriving ever satisfies
     * it.
     */
    const office = await company.createLocation(owner(), { name: "Office", isWarehouse: false });
    const itemId = await stockedItem();
    await expect(inventory.setReorderPolicy(owner(), {
      itemId, locationId: office.id, reorderPoint: "10.0000", reorderQuantity: "5.0000",
    })).rejects.toThrow(/only counted at a warehouse/);
  });

  it("refuses a policy that would order nothing", async () => {
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();
    await expect(inventory.setReorderPolicy(owner(), {
      itemId, locationId: warehouse.id, reorderPoint: "10.0000", reorderQuantity: "0",
    })).rejects.toThrow(/fires and orders nothing/);
  });

  it("replaces the policy for a part rather than adding a second", async () => {
    /**
     * One per item per location, which the schema enforces with a unique
     * index. Upserting because "set the reorder point for this part here" is
     * one intention whether or not a row exists, and making the caller know
     * which is a screen that fails the second time somebody uses it.
     */
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();
    await inventory.setReorderPolicy(owner(), {
      itemId, locationId: warehouse.id, reorderPoint: "10.0000", reorderQuantity: "25.0000",
    });
    await inventory.setReorderPolicy(owner(), {
      itemId, locationId: warehouse.id, reorderPoint: "15.0000", reorderQuantity: "30.0000",
    });
    const policies = await inventory.reorderPolicies(owner());
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ reorderPoint: "15.0000", reorderQuantity: "30.0000" });
  });

  it("can set a policy again after clearing it", async () => {
    /**
     * The unique index is PARTIAL, on `deleted_at is null`, so a cleared
     * policy takes no part in it and setting one again inserts a fresh row
     * rather than reviving the old one. That is the behaviour worth having:
     * the cleared policy stays readable as the record that somebody once
     * bought this part automatically.
     *
     * Asserted because the shape of the index is easy to get wrong in the
     * other direction. With a non-partial index the insert would conflict
     * with the dead row and the upsert would leave it dead, and this would be
     * a policy that can be cleared once and never set again.
     */
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();
    await inventory.setReorderPolicy(owner(), {
      itemId, locationId: warehouse.id, reorderPoint: "10.0000", reorderQuantity: "25.0000",
    });
    await inventory.clearReorderPolicy(owner(), { itemId, locationId: warehouse.id });
    expect(await inventory.reorderPolicies(owner())).toHaveLength(0);
    expect(await inventory.toOrder(owner())).toEqual([]);

    await inventory.setReorderPolicy(owner(), {
      itemId, locationId: warehouse.id, reorderPoint: "12.0000", reorderQuantity: "20.0000",
    });
    expect(await inventory.reorderPolicies(owner())).toHaveLength(1);
  });

  it("refuses clearing a policy that is not there", async () => {
    const warehouse = await company.createLocation(owner(), { name: "Main", isWarehouse: true });
    const itemId = await stockedItem();
    await expect(inventory.clearReorderPolicy(owner(), { itemId, locationId: warehouse.id }))
      .rejects.toThrow(NotFoundError);
  });
});
