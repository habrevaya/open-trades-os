import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inventory from "../src/services/inventory";
import * as stockUnits from "../src/services/stock-units";
import * as fills from "../src/services/truck-fills";
import { routes } from "../src/contracts";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TRUCK FILLS PROPOSED OVERNIGHT, THROUGH A REAL DATABASE
 *
 * The night writes drafts, one per truck at most, and a person confirms them.
 * What these tests hold on to is the sentence nothing here moves stock by
 * itself: a night, a second night and a "check now" leave every level exactly
 * where it was, and only a confirmation moves anything, through the one
 * transfer a hand typed move is.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("tf:org");
const OWNER = fixtureId("tf:owner");
const TECH = fixtureId("tf:tech");

let raw: postgres.Sql;
let filter = "";
let capacitor = "";
let board = "";
let shop = "";
let depot = "";
let van = "";
let truck2 = "";

const db = () => testDb(url!);
const as = (userId: string, roles: string[], key?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(OWNER, ["owner"], key);
const tech = () => as(TECH, ["technician"]);

async function item(code: string, name: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'material', ${code}) returning id`;
  await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, '10.00', now() - interval '1 day')`;
  return row!.id;
}

async function place(name: string, warehouse: boolean): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse) values (${ORG}, ${name}, ${warehouse}) returning id`;
  return row!.id;
}

const onHand = async (itemId: string, locationId: string) =>
  (await inventory.levels(owner())).find((l) => l.itemId === itemId && l.locationId === locationId)?.onHand ?? "0";

const open = async () => (await fills.list(owner()));
const NOW = new Date("2026-03-10T06:00:00Z");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Truck Fill Co", slug: "truck-fill-co" });
  await raw`delete from public."user" where id = ${TECH} or email = 'tech@truck-fill.test'`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, 'tech@truck-fill.test', 'Tess Tech')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${TECH}, 'technician')`;
  await raw`update public.organization set timezone = 'UTC' where id = ${ORG}`;
  filter = await item("FILT-20", "Filter 20x25");
  capacitor = await item("CAP-35", "Capacitor 35/5");
  board = await item("BRD-1", "Control board");
  shop = await place("Shop", true);
  depot = await place("Depot", true);
  van = await place("Van 7", false);
  truck2 = await place("Truck 9", false);
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.truck_fill_line where organization_id = ${ORG}`;
  await raw`delete from public.truck_fill_draft where organization_id = ${ORG}`;
  await raw`delete from public.truck_stock_minimum where organization_id = ${ORG}`;
  await raw`delete from public.stock_movement where organization_id = ${ORG}`;
  await raw`delete from public.stock_tracking where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'truckFills' where id = ${ORG}`;
  await inventory.receive(owner(), { itemId: filter, locationId: shop, quantity: "20", totalCost: "100.00" });
  await inventory.receive(owner(), { itemId: capacitor, locationId: depot, quantity: "8", totalCost: "80.00" });
});

run("the night's proposal", () => {
  it("writes one draft per truck under a minimum, from the warehouse holding the most, and moves nothing", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await stockUnits.setTruckMinimum(owner(), { itemId: capacitor, locationId: van, minimum: "1", target: "4" });
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: truck2, minimum: "1", target: "3" });

    const result = await fills.proposeNow(owner());
    expect(result).toEqual({ created: 2, refreshed: 0, withdrawn: 0 });

    const drafts = await open();
    expect(drafts.map((d) => d.truckName)).toEqual(["Truck 9", "Van 7"]);
    const vanDraft = drafts.find((d) => d.truckName === "Van 7")!;
    expect(vanDraft.lines.map((l) => [l.itemName, l.quantity, l.fromLocationName])).toEqual([
      ["Capacitor 35/5", "4", "Depot"],
      ["Filter 20x25", "6", "Shop"],
    ]);

    // Nothing moved: the only thing that happened is that somebody can read a proposal.
    expect(await onHand(filter, shop)).toBe("20");
    expect(await onHand(filter, van)).toBe("0");
    expect(await onHand(capacitor, depot)).toBe("8");
  });

  it("holds one open draft per truck: a second look rewrites it, and the index refuses a second", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await fills.proposeNow(owner());
    const [first] = await open();

    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "9" });
    expect(await fills.proposeNow(owner())).toEqual({ created: 0, refreshed: 1, withdrawn: 0 });
    const drafts = await open();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.id).toBe(first!.id);
    expect(drafts[0]!.lines.map((l) => l.quantity)).toEqual(["9"]);

    await expect(raw`insert into public.truck_fill_draft (organization_id, truck_id, proposed_on)
      values (${ORG}, ${van}, '2026-03-10')`).rejects.toThrow(/truck_fill_draft_open_idx/);
  });

  it("withdraws a draft the truck has outgrown, and leaves a truck the warehouses cannot help out alone", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await stockUnits.setTruckMinimum(owner(), { itemId: board, locationId: truck2, minimum: "1", target: "2" });
    // The board is out of stock everywhere, so there is nothing to propose for it.
    expect(await fills.proposeNow(owner())).toEqual({ created: 1, refreshed: 0, withdrawn: 0 });

    await inventory.transfer(owner(), { itemId: filter, fromLocationId: shop, toLocationId: van, quantity: "6" });
    expect(await fills.proposeNow(owner())).toEqual({ created: 0, refreshed: 0, withdrawn: 1 });
    expect(await open()).toEqual([]);
    const [row] = await raw`select status, outcome from public.truck_fill_draft where organization_id = ${ORG}`;
    expect(row).toMatchObject({ status: "withdrawn", outcome: "The truck no longer needs anything from a warehouse." });
  });

  it("reads the same for somebody who may read stock, and asks more of anybody who changes it", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await fills.proposeNow(owner());
    expect(await fills.list(tech())).toHaveLength(1);
    await expect(fills.proposeNow(tech())).rejects.toThrow(/inventory:adjust/);
    const [draft] = await open();
    await expect(fills.confirm(tech(), { id: draft!.id })).rejects.toThrow(/inventory:adjust/);
    await expect(fills.dismiss(tech(), { id: draft!.id })).rejects.toThrow(/inventory:adjust/);
  });

  it("declares the permissions the services demand", () => {
    expect(routes.listTruckFills.permissions).toEqual(["inventory:read"]);
    for (const route of [routes.checkTruckFills, routes.confirmTruckFill, routes.dismissTruckFill]) {
      expect(route.permissions).toEqual(["inventory:adjust"]);
      expect(route.idempotent).toBe(true);
    }
  });
});

run("the worker's clock", () => {
  it("runs once a day of the company's own calendar, and not before one in the morning there", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    const pass = async (at: string) => (await fills.nightlyPass(db(), { now: new Date(at), force: true }))
      .filter((r) => r.organizationId === ORG);

    expect(await pass("2026-03-10T00:30:00Z")).toEqual([expect.objectContaining({ ran: false })]);
    expect(await open()).toEqual([]);

    expect(await pass("2026-03-10T02:00:00Z")).toEqual([
      expect.objectContaining({ ran: true, proposed: { created: 1, refreshed: 0, withdrawn: 0 } }),
    ]);
    expect(await open()).toHaveLength(1);

    // The same day again, and a person dismissed it in between: not proposed again until tomorrow.
    const [draft] = await open();
    await fills.dismiss(owner(), { id: draft!.id });
    expect(await pass("2026-03-10T09:00:00Z")).toEqual([expect.objectContaining({ ran: false })]);
    expect(await open()).toEqual([]);

    // Tomorrow night the truck is still under its minimum, so it is proposed again.
    expect(await pass("2026-03-11T03:00:00Z")).toEqual([expect.objectContaining({ ran: true })]);
    expect(await open()).toHaveLength(1);
    expect(await onHand(filter, van)).toBe("0");
  });

  it("follows the company's own midnight, not the server's", async () => {
    await raw`update public.organization set timezone = 'Pacific/Auckland' where id = ${ORG}`;
    try {
      await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
      // 12:30 UTC on the 10th is 01:30 on the 11th in Auckland in March.
      const [result] = (await fills.nightlyPass(db(), { now: new Date("2026-03-10T12:30:00Z"), force: true }))
        .filter((r) => r.organizationId === ORG);
      expect(result).toMatchObject({ ran: true });
      expect((await open())[0]!.proposedOn).toBe("2026-03-11");
    } finally {
      await raw`update public.organization set timezone = 'UTC' where id = ${ORG}`;
    }
  });

  it("is a company's own business: a company with no minimum is not looked at", async () => {
    const results = await fills.nightlyPass(db(), { now: NOW, force: true });
    expect(results.find((r) => r.organizationId === ORG)).toBeUndefined();
  });
});

run("confirming a draft", () => {
  it("moves each line through the one transfer, once however many times it is sent, and says it was done", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await stockUnits.setTruckMinimum(owner(), { itemId: capacitor, locationId: van, minimum: "1", target: "4" });
    await fills.proposeNow(owner());
    const [draft] = await open();

    const answer = await fills.confirm(owner("fill-1"), { id: draft!.id });
    expect(answer.status).toBe("confirmed");
    expect(answer.moved.map((m) => `${m.itemName} ${m.quantity} from ${m.from}`).sort()).toEqual([
      "Capacitor 35/5 4 from Depot", "Filter 20x25 6 from Shop",
    ]);
    expect(await onHand(filter, van)).toBe("6");
    expect(await onHand(filter, shop)).toBe("14");
    expect(await onHand(capacitor, van)).toBe("4");

    expect(await fills.confirm(owner("fill-1"), { id: draft!.id })).toEqual(answer);
    expect(await onHand(filter, van)).toBe("6");
    await expect(fills.confirm(owner("fill-2"), { id: draft!.id })).rejects.toThrow(/already confirmed/);
    expect(await open()).toEqual([]);

    const [row] = await raw`select status, decided_by_name, outcome from public.truck_fill_draft where id = ${draft!.id}`;
    expect(row).toMatchObject({ status: "confirmed", decided_by_name: expect.any(String) });
    expect(row!.outcome).toContain("Moved 6 Filter 20x25 from Shop.");
    const [audited] = await raw`select count(*)::int as n from public.audit_log where action = 'truck_fill.confirmed' and entity_id = ${draft!.id}`;
    expect(audited!.n).toBe(1);
  });

  it("reads the shelf again: a truck filled by hand since gets only what it still needs", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await fills.proposeNow(owner());
    const [draft] = await open();

    // Somebody put two on the van by hand after the draft was written: still at the minimum, but four short of the fill level, not six.
    await inventory.transfer(owner(), { itemId: filter, fromLocationId: shop, toLocationId: van, quantity: "2" });
    const answer = await fills.confirm(owner(), { id: draft!.id });
    expect(answer.moved).toEqual([expect.objectContaining({ itemName: "Filter 20x25", quantity: "4" })]);
    expect(await onHand(filter, van)).toBe("6");
  });

  it("leaves a line the truck no longer needs alone, and withdraws a draft with nothing left to move", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await fills.proposeNow(owner());
    const [draft] = await open();
    await inventory.transfer(owner(), { itemId: filter, fromLocationId: shop, toLocationId: van, quantity: "6" });

    const answer = await fills.confirm(owner(), { id: draft!.id });
    expect(answer).toMatchObject({
      status: "withdrawn", moved: [],
      left: [expect.objectContaining({ itemName: "Filter 20x25", reason: expect.stringContaining("no longer under its minimum") })],
    });
    expect(await onHand(filter, van)).toBe("6");
    expect(await open()).toEqual([]);
  });

  it("leaves a part no warehouse holds any more, and still moves the rest", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await stockUnits.setTruckMinimum(owner(), { itemId: capacitor, locationId: van, minimum: "1", target: "4" });
    await fills.proposeNow(owner());
    const [draft] = await open();
    // The depot's capacitors are written off after the draft is made.
    await inventory.count(owner(), { itemId: capacitor, locationId: depot, counted: "0", reasonCode: "damaged" });

    // The live read finds no warehouse holding any capacitor, so that line is left; the filters still go.
    const answer = await fills.confirm(owner(), { id: draft!.id });
    expect(answer.moved.map((m) => m.itemName)).toEqual(["Filter 20x25"]);
    expect(answer.left.map((l) => l.itemName)).toEqual(["Capacitor 35/5"]);
  });

  it("needs a tracked part's numbers typed, refuses without them, and keeps the draft open", async () => {
    await stockUnits.setTracking(owner(), { itemId: board, mode: "serial" });
    await inventory.receive(owner(), {
      itemId: board, locationId: shop, quantity: "2", totalCost: "200.00",
      units: [{ number: "SN-A1" }, { number: "SN-A2" }],
    });
    await stockUnits.setTruckMinimum(owner(), { itemId: board, locationId: van, minimum: "1", target: "2" });
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await fills.proposeNow(owner());
    const [draft] = await open();
    expect(draft!.lines.find((l) => l.itemName === "Control board")).toMatchObject({ tracking: "serial", quantity: "2" });

    // All or none: the filters were fine, and they did not move either.
    await expect(fills.confirm(owner(), { id: draft!.id })).rejects.toThrow(/Control board/);
    expect(await onHand(board, van)).toBe("0");
    expect(await onHand(filter, van)).toBe("0");
    expect(await open()).toHaveLength(1);

    const answer = await fills.confirm(owner(), {
      id: draft!.id, units: [{ itemId: board, units: [{ number: "SN-A1" }, { number: "SN-A2" }] }],
    });
    expect(answer.status).toBe("confirmed");
    expect(await onHand(board, van)).toBe("2");
  });

  it("is refused for a draft that is not there", async () => {
    await expect(fills.confirm(owner(), { id: fixtureId("tf:nothing") })).rejects.toThrow(/not found/i);
  });
});

run("dismissing a draft", () => {
  it("moves nothing, keeps who and when, and refuses a second answer", async () => {
    await stockUnits.setTruckMinimum(owner(), { itemId: filter, locationId: van, minimum: "2", target: "6" });
    await fills.proposeNow(owner());
    const [draft] = await open();
    expect(await fills.dismiss(owner("d-1"), { id: draft!.id })).toEqual({ id: draft!.id, status: "dismissed" });
    expect(await fills.dismiss(owner("d-1"), { id: draft!.id })).toEqual({ id: draft!.id, status: "dismissed" });
    await expect(fills.dismiss(owner("d-2"), { id: draft!.id })).rejects.toThrow(/already dismissed/);
    expect(await onHand(filter, van)).toBe("0");
    const [row] = await raw`select status, decided_by_name from public.truck_fill_draft where id = ${draft!.id}`;
    expect(row!.status).toBe("dismissed");
    expect(row!.decided_by_name).not.toBeNull();

    // And "check now" proposes it again, because the truck is still under its minimum.
    expect(await fills.proposeNow(owner())).toEqual({ created: 1, refreshed: 0, withdrawn: 0 });
  });
});
