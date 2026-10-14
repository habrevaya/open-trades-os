import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import * as booking from "../src/services/booking";
import * as dispatch from "../src/services/dispatch";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A VISIT DROPPED ON A PERSON ON THE BOARD, AND THE TIME HELD FOR MEMBERS
 *
 * Three technicians and a four hour morning window of one hour jobs: twelve
 * in all, four each. A quarter is held for members until two days before, so
 * three across the window and one of each person's four. Ray already has
 * three strangers' visits that morning. A fourth stranger dropped on him
 * would take the one hour of his kept for members, while Dana and Sam have
 * room outside it: refused, naming them, until the dispatcher sends anyway,
 * which the audit log records. A member goes on without asking, and once
 * members' own work has used the hold up nothing is refused.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("mhb:org");
const USER = fixtureId("mhb:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

const tech: Record<string, string> = {};
let memberId = "";
let strangerId = "";

async function visitFor(customerId: string, date: string, technicianId: string | null) {
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, 'A house', 'Austin', 'TX', '78701') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${p!.id}, 'scheduled', 'Tune up') returning id`;
  const [v] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, ${technicianId ? "dispatched" : "unassigned"}::visit_status,
            ${booking.windowStart(date, "08:00", ZONE)}, ${booking.windowStart(date, "12:00", ZONE)}, 60) returning id`;
  if (technicianId) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${v!.id}, ${technicianId}, true)`;
  }
  return v!.id;
}

/** Ray's morning with three strangers on it, and a fourth stranger's visit waiting. */
async function rayAlmostFull(date: string) {
  for (let i = 0; i < 3; i += 1) await visitFor(strangerId, date, tech["Ray Ortiz"]!);
  return visitFor(strangerId, date, null);
}

const assignedTo = async (visitId: string) =>
  (await raw<{ technician_id: string }[]>`select technician_id from public.visit_assignment where visit_id = ${visitId}`)
    .map((r) => r.technician_id);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Member Board Air", slug: "member-hold-board" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  for (const name of ["Ray Ortiz", "Dana Lee", "Sam Diaz"]) {
    const userId = fixtureId(`mhb:tech:${name}`);
    await raw`insert into public."user" (id, email) values (${userId}, ${`mhb-${name.split(" ")[0]}@test.local`}) on conflict (id) do nothing`;
    const [m] = await raw<{ id: string }[]>`
      insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
    const [t] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
    tech[name] = t!.id;
  }
  for (let day = 0; day < 7; day += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${day}, '07:00', '18:00')`;
  }
  await raw`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'Morning', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]})`;
  const [plan] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price, priority_dispatch)
    values (${ORG}, 'Comfort Club', 180, true) returning id`;
  const [member] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Mel Member') returning id`;
  memberId = member!.id;
  await raw`insert into public.agreement (organization_id, plan_id, customer_id, status, started_on, price, billing_frequency)
    values (${ORG}, ${plan!.id}, ${memberId}, 'active', ${companyToday(-30)}, 180, 'annual')`;
  const [stranger] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Sid Stranger') returning id`;
  strangerId = stranger!.id;
  await booking.setMemberHold(owner(), { reservePercent: 25, releaseHours: 48 });
});

afterAll(async () => { if (raw) await raw.end(); });

run("a visit dropped on a person on the board", () => {
  it("is refused on a person whose last free hour is kept for members, naming who could take it instead", async () => {
    const date = companyToday(5);
    const visitId = await rayAlmostFull(date);
    const refused = dispatch.assign(as(["dispatcher"]), { id: visitId, technicianIds: [tech["Ray Ortiz"]!] });
    await expect(refused).rejects.toMatchObject({ memberHoldRefused: true });
    await expect(dispatch.assign(as(["dispatcher"]), { id: visitId, technicianIds: [tech["Ray Ortiz"]!] })).rejects.toThrow(
      `Ray Ortiz's time in the Morning window on ${date} is kept for members, and this customer is not a member there that day. `
      + "Dana Lee or Sam Diaz could take it instead. Or send anyway to give them a member's place.",
    );
    expect(await assignedTo(visitId)).toEqual([]);

    /** Either of them takes it without being asked. */
    await dispatch.assign(as(["dispatcher"]), { id: visitId, technicianIds: [tech["Dana Lee"]!] });
    expect(await assignedTo(visitId)).toEqual([tech["Dana Lee"]]);
  });

  it("goes on when the dispatcher sends anyway, with their name, the day and the window on the record", async () => {
    const date = companyToday(6);
    const visitId = await rayAlmostFull(date);
    await dispatch.assign(as(["dispatcher"]), { id: visitId, technicianIds: [tech["Ray Ortiz"]!], intoMemberHold: true });
    expect(await assignedTo(visitId)).toEqual([tech["Ray Ortiz"]]);
    const [row] = await raw<{ actor_user_id: string; after: { technicianId: string; date: string; window: string } }[]>`
      select actor_user_id, after from public.audit_log
      where organization_id = ${ORG} and action = 'visit.assigned_into_member_hold' and entity_id = ${visitId}`;
    expect(row).toMatchObject({ actor_user_id: USER, after: { technicianId: tech["Ray Ortiz"], date, window: "Morning" } });
  });

  it("puts a member there without asking", async () => {
    const date = companyToday(7);
    for (let i = 0; i < 3; i += 1) await visitFor(strangerId, date, tech["Ray Ortiz"]!);
    const visitId = await visitFor(memberId, date, null);
    await dispatch.assign(as(["dispatcher"]), { id: visitId, technicianIds: [tech["Ray Ortiz"]!] });
    expect(await assignedTo(visitId)).toEqual([tech["Ray Ortiz"]]);
  });

  it("refuses nothing once members' own work has used the window's hold up", async () => {
    const date = companyToday(8);
    for (let i = 0; i < 3; i += 1) await visitFor(memberId, date, tech["Sam Diaz"]!);
    const visitId = await rayAlmostFull(date);
    await dispatch.assign(as(["dispatcher"]), { id: visitId, technicianIds: [tech["Ray Ortiz"]!] });
    expect(await assignedTo(visitId)).toEqual([tech["Ray Ortiz"]]);
  });

  it("refuses nothing inside the time the hold is let go, or for somebody already on the visit", async () => {
    const soon = companyToday(1);
    const visitId = await rayAlmostFull(soon);
    await dispatch.assign(as(["dispatcher"]), { id: visitId, technicianIds: [tech["Ray Ortiz"]!] });
    expect(await assignedTo(visitId)).toEqual([tech["Ray Ortiz"]]);

    /** Ray already on one of his three: adding Dana beside him asks about Dana alone. */
    const date = companyToday(9);
    for (let i = 0; i < 3; i += 1) await visitFor(strangerId, date, tech["Ray Ortiz"]!);
    const [first] = await raw<{ visit_id: string }[]>`
      select a.visit_id from public.visit_assignment a join public.visit v on v.id = a.visit_id
      where a.technician_id = ${tech["Ray Ortiz"]!} and v.window_start = ${booking.windowStart(date, "08:00", ZONE)} limit 1`;
    await dispatch.assign(as(["dispatcher"]), { id: first!.visit_id, technicianIds: [tech["Ray Ortiz"]!, tech["Dana Lee"]!] });
    expect((await assignedTo(first!.visit_id)).sort()).toEqual([tech["Ray Ortiz"], tech["Dana Lee"]].sort());
  });
});
