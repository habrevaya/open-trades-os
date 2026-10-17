import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as rentals from "../src/services/rentals";
import * as haulTimes from "../src/services/haul-times";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { resetOrg, seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TURNAROUND BETWEEN PICKUP AND REDELIVERY, AND THE THREE TIMES IT WAITED ON
 *
 * "Hours from a container being emptied at the facility to it being placed on
 * the next customer site. EXCLUDES cans routed to the yard for repair and cans
 * held at customer request." Nothing recorded the tip, the board took a
 * delivery as a day, and a repair was only the can's state today. A haul now
 * has the moment its can was emptied, a hire says whether its delivery is the
 * moment the can was put down, and a repair and a customer hold are periods.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-turnaround:org");
const OWNER = fixtureId("kpi-turnaround:owner");
const DREW = fixtureId("kpi-turnaround:drew");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const keyed = () => ({ ...owner(), idempotencyKey: `turn-${crypto.randomUUID()}` });

let customerId = "";
const site: Record<string, string> = {};
let seq = 0;

/** A local time in the company's zone, as an instant. */
const local = (day: string, clock = "12:00") => raw.unsafe(`('${day} ${clock}'::timestamp at time zone '${ZONE}')`);
/** The same, as an ISO string for a service: Chicago is five hours behind UTC in May and June, when all of these fall. */
const iso = (day: string, clock: string) => new Date(new Date(`${day}T${clock}:00Z`).getTime() + 5 * 3_600_000).toISOString();

async function container(identifier: string, size = "20 yd"): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.rentable_asset (organization_id, asset_type, identifier, size, created_at)
    values (${ORG}, 'roll_off_container', ${identifier}, ${size}, ${local("2026-01-01")}) returning id`;
  return row!.id;
}

/** A hire, its times given as [day, clock]; a delivery with no clock is one recorded as a day, at midday. */
async function hire(assetId: string, delivered: [string, string?], over: {
  picked?: [string, string]; tipped?: [string, string]; property?: string;
} = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.rental (organization_id, asset_id, property_id, delivered_at, delivered_time_known, picked_up_at, tipped_at)
    values (${ORG}, ${assetId}, ${over.property ?? site.a!}, ${local(delivered[0], delivered[1] ?? "12:00")}, ${delivered[1] !== undefined},
            ${over.picked ? local(over.picked[0], over.picked[1]) : null}, ${over.tipped ? local(over.tipped[0], over.tipped[1]) : null})
    returning id`;
  return row!.id;
}

async function hold(assetId: string, kind: "repair" | "customer", from: [string, string] | null, until: [string, string] | null) {
  await raw`
    insert into public.container_hold (organization_id, asset_id, kind, starts_at, ends_at, reason)
    values (${ORG}, ${assetId}, ${kind}::container_hold_kind, ${from ? local(from[0], from[1]) : null},
            ${until ? local(until[0], until[1]) : null}, 'A reason')`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Turnaround Co", slug: "kpi-turnaround-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'dumpster-rental' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'commercial', 'Builder Bob') returning id`;
  customerId = c!.id;
  for (const key of ["a", "b"]) {
    const [p] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, ${`${key} Site Rd`}, 'Austin', 'TX', '78704') returning id`;
    site[key] = p!.id;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id, role, is_primary)
              values (${ORG}, ${customerId}, ${p!.id}, 'owner', true)`;
  }
});

/**
 * June, by hand, in Chicago's clock. Each line is a placement in June of a can
 * that had a haul before it, against that haul's tip.
 *
 *   C1  emptied Jun 2 2:00 PM, placed Jun 3 9:30 AM                 19.5   counted
 *   C2  emptied Jun 5 10:00 AM, placed Jun 6 4:00 PM                30.0   counted
 *   C3  emptied Jun 9 8:00 AM, placed Jun 9 12:30 PM                 4.5   counted
 *       (a customer hold on C3 ended Jun 9 7:00 AM, before the tip: outside it)
 *   C3  emptied Jun 28 9:00 AM, placed Jun 29 9:00 AM               24.0   counted
 *       (a repair running before history began ended Jun 1: outside it)
 *   C4  emptied Jun 10, placed Jun 15; out for repair Jun 11 to 14         left out, repair
 *   C5  emptied Jun 12, placed Jun 14; held for a customer from Jun 12     left out, customer hold
 *   C6  emptied Jun 15, placed Jun 16 recorded only as a day               not known
 *   C1  collected Jun 20 with no tip recorded, placed Jun 22               not known
 *   C2  emptied Jun 25, placed Jul 1                                       another month
 *   C7  first placement Jun 5, no haul before it                           not a turnaround
 *
 * 78 hours over 4 placements: 19.50 hours.
 */
async function june(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const n of [1, 2, 3, 4, 5, 6, 7]) ids[`C${n}`] = await container(`10${n}`);

  ids.H1a = await hire(ids.C1!, ["2026-05-28"], { picked: ["2026-06-02", "10:00"], tipped: ["2026-06-02", "14:00"] });
  ids.H1b = await hire(ids.C1!, ["2026-06-03", "09:30"], { picked: ["2026-06-20", "10:00"], property: site.b! });
  ids.H1c = await hire(ids.C1!, ["2026-06-22", "10:00"]);

  ids.H2a = await hire(ids.C2!, ["2026-05-20"], { picked: ["2026-06-05", "08:00"], tipped: ["2026-06-05", "10:00"] });
  ids.H2b = await hire(ids.C2!, ["2026-06-06", "16:00"], { picked: ["2026-06-25", "11:00"], tipped: ["2026-06-25", "13:00"] });
  ids.H2c = await hire(ids.C2!, ["2026-07-01", "09:00"]);

  ids.H3a = await hire(ids.C3!, ["2026-05-30"], { picked: ["2026-06-09", "07:30"], tipped: ["2026-06-09", "08:00"] });
  ids.H3b = await hire(ids.C3!, ["2026-06-09", "12:30"], { picked: ["2026-06-28", "08:00"], tipped: ["2026-06-28", "09:00"] });
  ids.H3c = await hire(ids.C3!, ["2026-06-29", "09:00"]);
  await hold(ids.C3!, "customer", ["2026-06-08", "10:00"], ["2026-06-09", "07:00"]);
  await hold(ids.C3!, "repair", null, ["2026-06-01", "09:00"]);

  ids.H4a = await hire(ids.C4!, ["2026-05-25"], { picked: ["2026-06-10", "13:00"], tipped: ["2026-06-10", "15:00"] });
  ids.H4b = await hire(ids.C4!, ["2026-06-15", "09:00"]);
  await hold(ids.C4!, "repair", ["2026-06-11", "08:00"], ["2026-06-14", "17:00"]);

  ids.H5a = await hire(ids.C5!, ["2026-05-26"], { picked: ["2026-06-12", "09:00"], tipped: ["2026-06-12", "11:00"] });
  ids.H5b = await hire(ids.C5!, ["2026-06-14", "08:00"]);
  await hold(ids.C5!, "customer", ["2026-06-12", "13:00"], ["2026-06-14", "08:00"]);

  ids.H6a = await hire(ids.C6!, ["2026-05-01"], { picked: ["2026-06-15", "09:00"], tipped: ["2026-06-15", "10:00"] });
  ids.H6b = await hire(ids.C6!, ["2026-06-16"]);

  ids.H7a = await hire(ids.C7!, ["2026-06-05", "09:00"]);
  return ids;
}

const card = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "turnaround_hours")!;

run("turnaround between pickup and redelivery", () => {
  it("is the hours from each can emptied to placed, over the placements counted, worked by hand", async () => {
    const ids = await june();
    const kpi = await card();
    expect([Number(kpi.numerator), Number(kpi.denominator), kpi.value]).toEqual([78, 4, "19.50"]);
    expect(kpi.besides).toEqual([
      expect.objectContaining({ key: "unknown", count: "2" }),
      expect.objectContaining({ key: "excluded", count: "2" }),
    ]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const hours = await kpis.drill(owner(), { key: "turnaround_hours", half: "numerator", ...WINDOW });
    expect(Object.fromEntries(hours.records.map((r) => [name(r.id), Number(r.value)])))
      .toEqual({ H1b: 19.5, H2b: 30, H3b: 4.5, H3c: 24 });
    expect(hours.records.find((r) => name(r.id) === "H1b")!.label)
      .toBe("Container 101 (20 yd): emptied Jun 2, 2:00 PM, placed Jun 3, 9:30 AM");
    const placements = await kpis.drill(owner(), { key: "turnaround_hours", half: "denominator", ...WINDOW });
    expect(placements.records.map((r) => name(r.id)).sort()).toEqual(["H1b", "H2b", "H3b", "H3c"]);

    const unknown = await kpis.drill(owner(), { key: "turnaround_hours", half: "unknown", ...WINDOW });
    expect(Object.fromEntries(unknown.records.map((r) => [name(r.id), r.label]))).toEqual({
      H6b: "Container 106 (20 yd): placed Jun 16, time not recorded",
      H1c: "Container 101 (20 yd): placed Jun 22, 10:00 AM, emptied at a time not recorded",
    });
    const excluded = await kpis.drill(owner(), { key: "turnaround_hours", half: "excluded", ...WINDOW });
    expect(Object.fromEntries(excluded.records.map((r) => [name(r.id), r.label]))).toEqual({
      H4b: "Container 104 (20 yd): emptied Jun 10, 3:00 PM, placed Jun 15, 9:00 AM, out for repair in between",
      H5b: "Container 105 (20 yd): emptied Jun 12, 11:00 AM, placed Jun 14, 8:00 AM, held for a customer in between",
    });
  });

  it("puts the same placements through core's rule and gets the same answer", async () => {
    await june();
    const hires = await raw<{ id: string; asset_id: string; delivered_at: Date; known: boolean; picked_up_at: Date | null; tipped_at: Date | null }[]>`
      select id, asset_id, delivered_at, delivered_time_known as known, picked_up_at, tipped_at
      from public.rental where organization_id = ${ORG} order by delivered_at`;
    const holds = await raw<{ asset_id: string; kind: "repair" | "customer"; starts_at: Date | null; ends_at: Date | null }[]>`
      select asset_id, kind::text as kind, starts_at, ends_at from public.container_hold where organization_id = ${ORG}`;
    const start = new Date("2026-06-01T05:00:00Z");
    const end = new Date("2026-07-01T05:00:00Z");
    let total = 0;
    let counted = 0;
    const why: string[] = [];
    for (const placed of hires.filter((h) => h.delivered_at >= start && h.delivered_at < end)) {
      const before = hires.filter((h) => h.asset_id === placed.asset_id && h.id !== placed.id && h.delivered_at < placed.delivered_at).at(-1);
      if (!before?.picked_up_at) continue;
      const verdict = reporting.turnaroundOf({
        tippedAt: before.tipped_at, placedAt: placed.delivered_at, placedTimeKnown: placed.known,
        holds: holds.filter((h) => h.asset_id === placed.asset_id).map((h) => ({ kind: h.kind, startsAt: h.starts_at, endsAt: h.ends_at })),
      });
      if (verdict.counted) { total += verdict.hours; counted += 1; } else why.push(verdict.why);
    }
    const kpi = await card();
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([total, counted]);
    expect(why.sort()).toEqual(["customer_hold", "no_tip", "placed_day_only", "repair"]);
  });
});

run("recording the drop, the tip and the holds", () => {
  it("records a delivery's moment or only its day, and sets the hour later on that day only", async () => {
    const can = await container("201");
    const byTime = await rentals.deliver(keyed(), { assetId: can, propertyId: site.a!, deliveredAt: iso("2026-06-03", "09:30") });
    expect(byTime.deliveredTimeKnown).toBe(true);
    await rentals.pickUp(keyed(), { id: byTime.id, pickedUpAt: iso("2026-06-05", "10:00") });

    const byDay = await rentals.deliver(keyed(), { assetId: can, propertyId: site.b!, deliveredOn: "2026-06-08" });
    expect(byDay.deliveredTimeKnown).toBe(false);
    /** Midday in the company's clock, the same day everywhere. */
    expect(byDay.deliveredAt).toBe(iso("2026-06-08", "12:00"));
    await expect(rentals.deliver(keyed(), {
      assetId: await container("202"), propertyId: site.a!, deliveredOn: "2026-06-08", deliveredAt: iso("2026-06-08", "09:00"),
    })).rejects.toThrow(/not both/);

    await expect(haulTimes.recordPlacement(owner(), { id: byDay.id, deliveredAt: iso("2026-06-09", "08:00") }))
      .rejects.toThrow(/recorded on Jun 8/);
    const set = await haulTimes.recordPlacement(owner(), { id: byDay.id, deliveredAt: iso("2026-06-08", "07:45") });
    expect(set).toEqual({ id: byDay.id, deliveredAt: iso("2026-06-08", "07:45"), deliveredTimeKnown: true });
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${byDay.id} and action = 'rental.placed'`;
    expect(audited.length).toBe(1);
    await expect(haulTimes.recordPlacement(as(DREW, ["technician"]), { id: byDay.id, deliveredAt: iso("2026-06-08", "07:45") }))
      .rejects.toThrow(/asset:write/);
  });

  it("records the tip with the collection or after it, and refuses one that would run a turnaround backwards", async () => {
    const can = await container("301");
    const first = await rentals.deliver(keyed(), { assetId: can, propertyId: site.a!, deliveredAt: iso("2026-06-01", "09:00") });
    const collected = await rentals.pickUp(keyed(), {
      id: first.id, pickedUpAt: iso("2026-06-04", "10:00"), tippedAt: iso("2026-06-04", "11:15"),
    });
    expect(collected.tippedAt).toBe(iso("2026-06-04", "11:15"));

    await expect(haulTimes.recordTip(owner(), { id: first.id, tippedAt: iso("2026-05-31", "11:00") })).rejects.toThrow(/before the can was delivered/);
    await expect(haulTimes.recordTip(owner(), { id: first.id, tippedAt: iso("2026-06-03", "11:00") })).rejects.toThrow(/collected on Jun 4/);
    await expect(haulTimes.recordTip(owner(), { id: first.id, tippedAt: new Date(Date.now() + 3_600_000).toISOString() }))
      .rejects.toThrow(/not come yet/);

    /** Put back out at 10:30 the next morning: a delivery before its last tip is refused, and a tip after it too. */
    await expect(rentals.deliver(keyed(), { assetId: can, propertyId: site.b!, deliveredAt: iso("2026-06-04", "11:00") }))
      .rejects.toThrow(/emptied at the facility at 11:15 AM on Jun 4, after this delivery/);
    const second = await rentals.deliver(keyed(), { assetId: can, propertyId: site.b!, deliveredAt: iso("2026-06-05", "10:30") });
    await expect(haulTimes.recordTip(owner(), { id: first.id, tippedAt: iso("2026-06-05", "11:00") }))
      .rejects.toThrow(/on its next site at 10:30 AM on Jun 5/);
    expect((await haulTimes.recordTip(owner(), { id: first.id, tippedAt: iso("2026-06-04", "12:00") })).tippedAt).toBe(iso("2026-06-04", "12:00"));

    /** A swap recorded as a day leaves a can whose drop is only a day; setting the hour moves the swap with it. */
    const empty = await container("302");
    const swapped = await rentals.swap(keyed(), { id: second.id, replacementAssetId: empty, on: "2026-06-12", tippedAt: iso("2026-06-12", "15:00") });
    expect(swapped.opened.deliveredTimeKnown).toBe(false);
    expect(swapped.closed.tippedAt).toBe(iso("2026-06-12", "15:00"));
    await haulTimes.recordPlacement(owner(), { id: swapped.opened.id, deliveredAt: iso("2026-06-12", "13:20") });
    const [closed] = await raw<{ picked_up_at: Date }[]>`select picked_up_at from public.rental where id = ${second.id}`;
    expect(closed!.picked_up_at.toISOString()).toBe(iso("2026-06-12", "13:20"));
  });

  it("keeps a repair and a customer hold as periods, ends a hold on delivery, and refuses what does not fit", async () => {
    const can = await container("401");
    await rentals.tagOutOfService(owner(), { id: can, reason: "Cracked floor", at: iso("2026-06-02", "08:00") });
    await expect(rentals.tagOutOfService(owner(), { id: can, reason: "Again" })).rejects.toBeInstanceOf(ConflictError);
    await rentals.returnToService(owner(), { id: can, at: iso("2026-06-05", "16:00") });
    const repairs = (await haulTimes.listHolds(owner(), { assetId: can, limit: 10 })).data;
    expect(repairs).toEqual([expect.objectContaining({
      kind: "repair", reason: "Cracked floor", startsAt: iso("2026-06-02", "08:00"), endsAt: iso("2026-06-05", "16:00"), assetIdentifier: "401",
    })]);

    /** Recorded after the fact, with its end, and refused where another overlaps it. */
    const past = await haulTimes.holdForCustomer(keyed(), {
      assetId: can, reason: "Bob wants this one for the slab pour", customerId,
      startsAt: iso("2026-06-06", "09:00"), endsAt: iso("2026-06-08", "09:00"),
    });
    expect(past).toMatchObject({ kind: "customer", customerName: "Builder Bob" });
    await expect(haulTimes.holdForCustomer(keyed(), { assetId: can, reason: "Again", startsAt: iso("2026-06-07", "09:00") }))
      .rejects.toThrow(/already held for a customer from/);

    /** A replayed request gets the first answer back and writes nothing twice. */
    const key = { ...owner(), idempotencyKey: `hold-${crypto.randomUUID()}` };
    const running = await haulTimes.holdForCustomer(key, { assetId: can, reason: "Holding for Monday", startsAt: iso("2026-06-10", "09:00") });
    expect(await haulTimes.holdForCustomer(key, { assetId: can, reason: "Holding for Monday", startsAt: iso("2026-06-10", "09:00") })).toEqual(running);
    await expect(haulTimes.endHold(owner(), { id: repairs[0]!.id })).rejects.toThrow(/put back in service/);

    const out = await rentals.deliver(keyed(), { assetId: can, propertyId: site.a!, deliveredAt: iso("2026-06-15", "08:30") });
    const ended = (await haulTimes.listHolds(owner(), { assetId: can, limit: 10 })).data.find((h) => h.id === running.id)!;
    expect(ended.endsAt).toBe(iso("2026-06-15", "08:30"));
    await expect(haulTimes.holdForCustomer(keyed(), { assetId: can, reason: "On a site" })).rejects.toThrow(/is on a site/);

    /** Collected needing repair: the repair runs from the collection. */
    await rentals.pickUp(keyed(), { id: out.id, pickedUpAt: iso("2026-06-20", "10:00"), backInService: false });
    const open = (await haulTimes.listHolds(owner(), { assetId: can, open: true, limit: 10 })).data;
    expect(open).toEqual([expect.objectContaining({ kind: "repair", startsAt: iso("2026-06-20", "10:00"), endsAt: null })]);
    expect((await rentals.listAssets(owner(), { limit: 50 })).data.find((a) => a.id === can)!.holds)
      .toEqual([expect.objectContaining({ kind: "repair", startsAt: iso("2026-06-20", "10:00") })]);
  });
});

run("the driver's phone", () => {
  it("records the drop and the tip on the driver's own stops, refuses anybody else's, and shows them on the day", async () => {
    await raw`delete from public."user" where id = ${DREW}`;
    await raw`insert into public."user" (id, email, name) values (${DREW}, 'drew@kpi-turnaround.test', 'Drew')`;
    const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${DREW}, 'technician') returning id`;
    const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, 'Drew') returning id`;
    const drew = () => as(DREW, ["technician"], { technicianId: t!.id });
    const device = (await fieldOps.register(drew(), { installationId: `drew-${crypto.randomUUID()}` })).deviceId;

    const can = await container("501");
    const other = await container("502");
    const delivered = await rentals.deliver(keyed(), { assetId: can, propertyId: site.a!, deliveredOn: "2026-06-10" });
    const elsewhere = await rentals.deliver(keyed(), { assetId: other, propertyId: site.b!, deliveredOn: "2026-06-10" });
    seq += 1;
    const [job] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${seq}, ${customerId}, ${site.a!}, 'scheduled', 'Roll off for the remodel') returning id`;
    for (const [n, event, rentalId] of [[1, "delivery", delivered.id], [2, "pickup", delivered.id]] as const) {
      const [v] = await raw<{ id: string }[]>`
        insert into public.visit (organization_id, job_id, sequence, status, rental_id, rental_event, window_start, window_end)
        values (${ORG}, ${job!.id}, ${n}, 'scheduled', ${rentalId}, ${event}, ${local("2026-06-10", "08:00")}, ${local("2026-06-10", "17:00")})
        returning id`;
      await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${t!.id}, true)`;
    }

    let sequence = 0;
    const send = (rentalId: string, moment: "placed" | "tipped", at: string) => fieldOps.sync(drew(), {
      deviceId: device,
      operations: [{
        clientId: crypto.randomUUID(), sequence: ++sequence, kind: "haul.time", subjectId: rentalId,
        occurredAt: at, payload: { field: moment, at },
      }],
    }).then((r) => r.results[0]!);

    expect(await send(delivered.id, "placed", iso("2026-06-10", "09:10"))).toMatchObject({ status: "applied" });
    expect(await send(delivered.id, "tipped", iso("2026-06-10", "16:40"))).toMatchObject({ status: "applied" });
    const [row] = await raw<{ delivered_at: Date; known: boolean; tipped_at: Date }[]>`
      select delivered_at, delivered_time_known as known, tipped_at from public.rental where id = ${delivered.id}`;
    expect([row!.delivered_at.toISOString(), row!.known, row!.tipped_at.toISOString()])
      .toEqual([iso("2026-06-10", "09:10"), true, iso("2026-06-10", "16:40")]);

    const refused = await send(elsewhere.id, "placed", iso("2026-06-10", "09:30"));
    expect(refused.status).toBe("rejected");
    expect(refused.rejection).toMatch(/not on one of your stops/);

    const day = await dispatch.snapshot(drew(), { deviceId: device, from: "2026-06-10", days: 1 });
    expect(day.hauls).toEqual(expect.arrayContaining([
      expect.objectContaining({ leg: "delivery", drop: { rentalId: delivered.id, container: "501 (20 yd)", deliveredAt: iso("2026-06-10", "09:10"), timeKnown: true }, tip: null }),
      expect.objectContaining({ leg: "pickup", drop: null, tip: { rentalId: delivered.id, container: "501 (20 yd)", tippedAt: iso("2026-06-10", "16:40") } }),
    ]));
  });
});
