import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { geo, time, type Actor } from "@opentradesos/core";
import * as booking from "../src/services/booking";
import * as dispatchMap from "../src/services/dispatch-map";
import * as jobs from "../src/services/jobs";
import * as agentFacts from "../src/services/agent-facts";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * WHAT A PLAN'S PRIORITY DISPATCH RESERVES
 *
 * Two technicians and a four hour morning window that holds eight one hour
 * jobs. The company holds a quarter of each window for members until three
 * days before it opens. A stranger is offered six; a member, all eight; a
 * window inside three days, all eight to anybody. Members' own bookings use
 * the hold up before anybody else's room is touched, and with no plan that
 * promises priority nothing is held at all. "Suggest who" names the member
 * and places them first.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("mc:org");
const USER = fixtureId("mc:user");
const ZONE = "America/Chicago";
const HELD_DAY = companyToday(5);
const SOON_DAY = companyToday(2);
const FULL_DAY = companyToday(6);

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let serviceId = "";
let windowId = "";
let planId = "";
let memberId = "";
let strangerId = "";
let rayId = "";
let yardId = "";

async function service() {
  const [row] = await inTenant(owner(), (tx) => tx.select().from(schema.bookableService).where(eq(schema.bookableService.id, serviceId)));
  return row!;
}

/** What is left in the morning window on a day, for a member or for anybody else. */
async function remaining(date: string, member: boolean): Promise<number> {
  const slots = await booking.openSlots(db(), {
    organizationId: ORG, timezone: ZONE, service: await service(), from: date, days: 1,
    member: member ? await booking.memberTest(db(), ORG, memberId, null) : undefined,
  });
  return slots.find((s) => s.arrivalWindowId === windowId)?.remaining ?? 0;
}

async function visitFor(customerId: string, date: string, technicianId: string | null, lng = -97.70) {
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
    values (${ORG}, 'A house', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test')
    returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${p!.id}, 'scheduled', 'Tune up') returning id`;
  const start = booking.windowStart(date, "08:00", ZONE);
  const [v] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, ${technicianId ? "dispatched" : "unassigned"}::visit_status,
            ${start}, ${booking.windowStart(date, "12:00", ZONE)}, 60) returning id`;
  if (technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${v!.id}, ${technicianId}, true)`;
  }
  return v!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Member Air", slug: "member-air" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [l] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Shop', '1 Shop Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual')
    returning id`;
  yardId = l!.id;
  for (const name of ["Ray Ortiz", "Dana Lee"]) {
    const userId = fixtureId(`mc:tech:${name}`);
    await raw`insert into public."user" (id, email) values (${userId}, ${`mc-${name.split(" ")[0]}@test.local`}) on conflict (id) do nothing`;
    const [m] = await raw<{ id: string }[]>`
      insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
    const [t] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name, home_location_id)
      values (${ORG}, ${m!.id}, ${name}, ${yardId}) returning id`;
    if (name === "Ray Ortiz") rayId = t!.id;
  }
  for (let day = 0; day < 7; day += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
              values (${ORG}, ${day}, '07:00', '18:00')`;
  }
  const [w] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'Morning', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]}) returning id`;
  windowId = w!.id;
  const [t] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, default_duration_minutes)
    values (${ORG}, 'Tune up', 60) returning id`;
  const [s] = await raw<{ id: string }[]>`insert into public.bookable_service (organization_id, job_type_id, public_name, max_per_window, min_notice_hours)
    values (${ORG}, ${t!.id}, 'Tune up', 20, 24) returning id`;
  serviceId = s!.id;

  const [plan] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price, priority_dispatch)
    values (${ORG}, 'Comfort Club', 180, true) returning id`;
  planId = plan!.id;
  const [member] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Mel Member') returning id`;
  memberId = member!.id;
  await raw`insert into public.agreement (organization_id, plan_id, customer_id, status, started_on, price, billing_frequency)
    values (${ORG}, ${planId}, ${memberId}, 'active', ${companyToday(-30)}, 180, 'annual')`;
  const [stranger] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Sid Stranger') returning id`;
  strangerId = stranger!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a share of each window held for members", () => {
  it("holds nothing until a company sets a share", async () => {
    expect(await booking.memberHold(owner())).toEqual({
      reservePercent: 0, releaseHours: 48, plansWithPriority: 1,
      plans: [{ id: planId, name: "Comfort Club", holdPercent: null }],
    });
    expect(await remaining(HELD_DAY, false)).toBe(8);
  });

  it("is set by somebody who configures online booking, within sense", async () => {
    await expect(booking.setMemberHold(as(["dispatcher"]), { reservePercent: 25, releaseHours: 72 }))
      .rejects.toMatchObject({ name: "PermissionError" });
    await expect(booking.setMemberHold(owner(), { reservePercent: 95, releaseHours: 72 })).rejects.toThrow(/ninety per cent/);
    expect(await booking.setMemberHold(owner(), { reservePercent: 25, releaseHours: 72 }))
      .toMatchObject({ reservePercent: 25, releaseHours: 72, plansWithPriority: 1 });
  });

  it("offers a stranger six of eight and a member all eight, until three days before", async () => {
    expect(await remaining(HELD_DAY, false)).toBe(6);
    expect(await remaining(HELD_DAY, true)).toBe(8);
    /** Inside the release time, what was held is anybody's. */
    expect(await remaining(SOON_DAY, false)).toBe(8);
  });

  it("is used up by members' own work before anybody else's room is touched", async () => {
    await visitFor(memberId, HELD_DAY, rayId);
    expect(await remaining(HELD_DAY, false)).toBe(6);
    await visitFor(memberId, HELD_DAY, rayId);
    expect(await remaining(HELD_DAY, false)).toBe(6);
    expect(await remaining(HELD_DAY, true)).toBe(6);
    /** A stranger's booking comes out of the stranger's share. */
    await visitFor(strangerId, HELD_DAY, rayId);
    expect(await remaining(HELD_DAY, false)).toBe(5);
  });

  it("is refused at the moment a stranger's request is written, when only the held share is left", async () => {
    /** Six jobs waiting for somebody leave two places, and both are held. */
    for (let i = 0; i < 6; i += 1) await visitFor(strangerId, FULL_DAY, null);
    expect(await remaining(FULL_DAY, false)).toBe(0);
    expect(await remaining(FULL_DAY, true)).toBe(2);
    await expect(booking.assertRoom(db(), {
      organizationId: ORG, timezone: ZONE, service: await service(), date: FULL_DAY, arrivalWindowId: windowId,
    })).rejects.toThrow(/just been taken/);
    await expect(booking.assertRoom(db(), {
      organizationId: ORG, timezone: ZONE, service: await service(), date: FULL_DAY, arrivalWindowId: windowId,
      member: await booking.memberTest(db(), ORG, memberId, null),
    })).resolves.toBeUndefined();
  });

  it("holds nothing while no live plan promises priority", async () => {
    await raw`update public.agreement_plan set priority_dispatch = false where id = ${planId}`;
    expect((await booking.memberHold(owner())).plansWithPriority).toBe(0);
    expect(await remaining(FULL_DAY, false)).toBe(2);
    await raw`update public.agreement_plan set priority_dispatch = true where id = ${planId}`;
  });
});

run("Suggest who puts members first", () => {
  it("names the plan on the member's visit and places it before the stranger's", async () => {
    const day = time.dateIn(new Date(Date.now() + 9 * 864e5), ZONE);
    const strangers = await visitFor(strangerId, day, null, -97.71);
    const members = await visitFor(memberId, day, null, -97.69);
    const result = await dispatchMap.suggestions(as(["dispatcher"]), { date: day });
    const ids = result.suggestions.map((s) => s.visitId);
    expect(ids.indexOf(members)).toBeLessThan(ids.indexOf(strangers));
    expect(result.suggestions.find((s) => s.visitId === members)!.member).toBe("Comfort Club");
    expect(result.suggestions.find((s) => s.visitId === strangers)!.member).toBeNull();
  });
});

run("each plan holds its own share", () => {
  const DAY = companyToday(10);
  let silverPlan = "";
  let silverMember = "";

  beforeAll(async () => {
    if (!url) return;
    const [plan] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price, priority_dispatch)
      values (${ORG}, 'Silver', 90, true) returning id`;
    silverPlan = plan!.id;
    const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Sue Silver') returning id`;
    silverMember = c!.id;
    await raw`insert into public.agreement (organization_id, plan_id, customer_id, status, started_on, price, billing_frequency)
      values (${ORG}, ${silverPlan}, ${silverMember}, 'active', ${companyToday(-30)}, 90, 'annual')`;
  });

  const left = async (customerId: string | null) => {
    const slots = await booking.openSlots(db(), {
      organizationId: ORG, timezone: ZONE, service: await service(), from: DAY, days: 1,
      member: customerId ? await booking.memberTest(db(), ORG, customerId, null) : undefined,
    });
    return slots.find((s) => s.arrivalWindowId === windowId)?.remaining ?? 0;
  };

  it("keeps back the largest share any plan holds, and lets each member into their own plan's share", async () => {
    /** The company's quarter, for both plans: two of eight held. */
    expect(await left(null)).toBe(6);
    expect(await left(silverMember)).toBe(8);

    /** Comfort Club now holds half of each window for its own members. */
    await raw`update public.agreement_plan set member_hold_percent = 50 where id = ${planId}`;
    expect(await left(null)).toBe(4);
    expect(await left(memberId)).toBe(8);
    /** Silver still holds the company's quarter: its members get two of the four held, and no further. */
    expect(await left(silverMember)).toBe(6);

    const hold = await booking.memberHold(owner());
    expect(hold.plans).toEqual(expect.arrayContaining([
      { id: planId, name: "Comfort Club", holdPercent: 50 },
      { id: silverPlan, name: "Silver", holdPercent: null },
    ]));
    await raw`update public.agreement_plan set member_hold_percent = null where id = ${planId}`;
  });

  it("holds nothing when every plan that promises priority holds none", async () => {
    await raw`update public.agreement_plan set member_hold_percent = 0 where organization_id = ${ORG}`;
    expect(await left(null)).toBe(8);
    await raw`update public.agreement_plan set member_hold_percent = null where organization_id = ${ORG}`;
  });

  afterAll(async () => {
    if (!url) return;
    await raw`update public.agreement_plan set priority_dispatch = false where id = ${silverPlan}`;
  });
});

run("the office booking a job by hand into time held for members", () => {
  const DAY = companyToday(11);
  let typeId = "";

  const placeFor = async (customerId: string) => {
    const [p] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, 'Another house', 'Austin', 'TX', '78701') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
    return p!.id;
  };
  const book = async (customerId: string, bookAnyway?: boolean) => {
    const propertyId = await placeFor(customerId);
    return jobs.create(as(["office_manager"]), {
      customerId, propertyId, jobTypeId: typeId, summary: "No cooling", tags: [], customFields: {},
      visit: {
        windowStart: booking.windowStart(DAY, "09:00", ZONE).toISOString(),
        windowEnd: booking.windowStart(DAY, "11:00", ZONE).toISOString(),
        estimatedDurationMinutes: 60, technicianIds: [],
        ...(bookAnyway === undefined ? {} : { bookAnyway }),
      },
    } as Parameters<typeof jobs.create>[1]);
  };

  beforeAll(async () => {
    if (!url) return;
    const [t] = await raw<{ id: string }[]>`select job_type_id as id from public.bookable_service where id = ${serviceId}`;
    typeId = t!.id;
    /** Six waiting for somebody leave two places in the morning, and both are held. */
    for (let i = 0; i < 6; i += 1) await visitFor(strangerId, DAY, null);
  });

  it("refuses a stranger in words, and says how to book them anyway", async () => {
    await expect(book(strangerId)).rejects.toThrow(/Morning window on .* is held for members.*Book anyway/);
    expect(await booking.memberHoldInForce(as(["office_manager"]))).toBe(true);
  });

  it("books a member there without asking", async () => {
    const job = await book(memberId);
    expect(job.visits).toHaveLength(1);
  });

  it("books a stranger when the person booking says so, and puts it on the record with their name", async () => {
    const job = await book(strangerId, true);
    const [visit] = await raw<{ id: string }[]>`select id from public.visit where job_id = ${job.id as string}`;
    const [row] = await raw<{ actor_user_id: string; after: { window: string } }[]>`
      select actor_user_id, after from public.audit_log
      where organization_id = ${ORG} and action = 'visit.booked_into_member_hold' and entity_id = ${visit!.id}`;
    expect(row!.actor_user_id).toBe(USER);
    expect(row!.after.window).toBe("Morning");
  });

  it("does not ask when nothing is held there", async () => {
    await raw`update public.agreement_plan set priority_dispatch = false where id = ${planId}`;
    await expect(book(strangerId)).resolves.toBeDefined();
    await raw`update public.agreement_plan set priority_dispatch = true where id = ${planId}`;
  });
});

run("a visit moved to another day by the rebalance", () => {
  it("is told how much room a held window has for somebody who is not a member, and nothing for a member", async () => {
    const DAY = companyToday(12);
    for (let i = 0; i < 5; i += 1) await visitFor(strangerId, DAY, null);
    const at = booking.windowStart(DAY, "09:00", ZONE);
    const rooms = await inTenant(owner(), (tx) => booking.roomOutsideHold(tx, {
      organizationId: ORG, timezone: ZONE,
      asks: [
        { ref: "stranger", customerId: strangerId, propertyId: null, jobTypeId: null, durationMinutes: 60, windowStart: at },
        { ref: "member", customerId: memberId, propertyId: null, jobTypeId: null, durationMinutes: 60, windowStart: at },
      ],
    }));
    /** Eight places, five taken by work waiting, two held: one left for somebody who is not a member. */
    expect(rooms.get("stranger")).toEqual({ key: `${DAY}|${windowId}`, room: 1 });
    expect(rooms.has("member")).toBe(false);
  });
});

run("the assistants know a member by how they reached us", () => {
  const DAY = companyToday(13);

  beforeAll(async () => {
    if (!url) return;
    await raw`update public.customer set phone = '(512) 555-0142', email = 'mel@member.test' where id = ${memberId}`;
    /** Six waiting leave two places, both held for members. */
    for (let i = 0; i < 6; i += 1) await visitFor(strangerId, DAY, null);
  });

  it("matches the number or email to a member, and nobody else", async () => {
    const byPhone = await inTenant(owner(), (tx) => agentFacts.memberByContact(tx, ORG, { phone: "+15125550142" }));
    expect(byPhone?.(DAY)).toBe(0.25);
    const byEmail = await inTenant(owner(), (tx) => agentFacts.memberByContact(tx, ORG, { email: "MEL@member.test" }));
    expect(byEmail?.(DAY)).toBe(0.25);
    const nobody = await inTenant(owner(), (tx) => agentFacts.memberByContact(tx, ORG, { phone: "+15125550999" }));
    expect(nobody).toBeNull();
    expect(agentFacts.contactsIn(["hi, it's mel", "you can reach me at 512.555.0142 or mel@member.test"]))
      .toEqual({ phone: "512.555.0142", email: "mel@member.test" });
  });

  it("offers the member the held windows the public page keeps back, and lets the request into one", async () => {
    const member = await inTenant(owner(), (tx) => agentFacts.memberByContact(tx, ORG, { phone: "+15125550142" }));
    const facts = (who: typeof member) => inTenant(owner(), (tx) => agentFacts.servicesAndWindows(tx, ORG, ZONE, DAY, { days: 1, member: who }));
    expect((await facts(null)).windows.filter((w) => w.date === DAY)).toHaveLength(0);
    expect((await facts(member)).windows.filter((w) => w.date === DAY)).toHaveLength(1);

    const ask = {
      organizationSlug: "member-air", bookableServiceId: serviceId, requestedDate: DAY, arrivalWindowId: windowId,
      contactName: "Mel Member", contactPhone: "+15125550142",
      addressLine1: "1 Mel St", city: "Austin", state: "TX", postalCode: "78701", intakeAnswers: {}, utm: {},
    };
    await expect(booking.createRequest(db(), ask)).rejects.toThrow(/just been taken/);
    const made = await booking.createRequest(db(), ask, undefined, { member });
    expect(made.request.status).toBe("pending");
  });
});
