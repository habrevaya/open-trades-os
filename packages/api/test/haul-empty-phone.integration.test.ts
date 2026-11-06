import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import { type ServiceContext } from "../src/services/context";
import { resetOrg, seedOrg, testDb, fixtureId } from "./helpers";

/**
 * "IT CAME BACK EMPTY", FROM THE DRIVER'S PHONE
 *
 * The office could mark a collected can as having come back empty
 * (`PUT /v1/rentals/{id}/came-back-empty`); the driver, who is the one who
 * saw it, could not. It is now a third moment on `haul.time`, held to exactly
 * the office's rules: not before the collection is recorded, not on another
 * day, not for a can with a tip time or a scale ticket, not still to come,
 * and only on the driver's own stops. A tip after the mark is refused, as it
 * is from the office.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("haul-empty-phone:org");
const OWNER = fixtureId("haul-empty-phone:owner");
const DRIVER = fixtureId("haul-empty-phone:driver");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});

let customerId = "";
let siteId = "";
let technicianId = "";
let device = "";
let seq = 0;
const driver = () => as(DRIVER, ["technician"], { technicianId });

/** A local time in the company's zone, as an instant. Chicago is five hours behind UTC in June. */
const iso = (day: string, clock: string) => new Date(new Date(`${day}T${clock}:00Z`).getTime() + 5 * 3_600_000).toISOString();

async function container(identifier: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.rentable_asset (organization_id, asset_type, identifier, size)
    values (${ORG}, 'roll_off_container', ${identifier}, '20 yd') returning id`;
  return row!.id;
}

/** A hire delivered on Jun 10 and, when asked, collected on Jun 12 at 10:00, with a collection stop on the driver's day. */
async function collectedHire(identifier: string, over: { collected?: boolean; tipped?: boolean; onMyStop?: boolean } = {}) {
  const assetId = await container(identifier);
  const [hire] = await raw<{ id: string }[]>`
    insert into public.rental (organization_id, asset_id, property_id, delivered_at, picked_up_at, tipped_at)
    values (${ORG}, ${assetId}, ${siteId}, ${iso("2026-06-10", "12:00")},
            ${over.collected === false ? null : iso("2026-06-12", "10:00")},
            ${over.tipped ? iso("2026-06-12", "14:00") : null})
    returning id`;
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${siteId}, 'scheduled', 'Roll off') returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, rental_id, rental_event, window_start, window_end)
    values (${ORG}, ${job!.id}, 1, 'scheduled', ${hire!.id}, 'pickup', ${iso("2026-06-12", "08:00")}, ${iso("2026-06-12", "17:00")})
    returning id`;
  if (over.onMyStop !== false) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
              values (${ORG}, ${visit!.id}, ${technicianId}, true)`;
  }
  return hire!.id;
}

let sequence = 0;
const send = (rentalId: string, moment: "empty" | "tipped", at: string) => fieldOps.sync(driver(), {
  deviceId: device,
  operations: [{
    clientId: crypto.randomUUID(), sequence: ++sequence, kind: "haul.time", subjectId: rentalId,
    occurredAt: at, payload: { field: moment, at },
  }],
}).then((r) => r.results[0]!);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Empty Haul Co", slug: "haul-empty-phone-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'dumpster-rental' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'commercial', 'Builder Bea') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '7 Yard Rd', 'Austin', 'TX', '78704') returning id`;
  siteId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, role, is_primary)
            values (${ORG}, ${customerId}, ${siteId}, 'owner', true)`;
  await raw`delete from public."user" where id = ${DRIVER}`;
  await raw`insert into public."user" (id, email, name) values (${DRIVER}, 'dee@haul-empty-phone.test', 'Dee')`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${DRIVER}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, 'Dee') returning id`;
  technicianId = t!.id;
  device = (await fieldOps.register(driver(), { installationId: `dee-${crypto.randomUUID()}` })).deviceId;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("came back empty from the driver's phone", () => {
  it("marks a collected can on the driver's own stop, on the audit log as the phone's, and shows it on the day", async () => {
    const hire = await collectedHire("701");
    expect(await send(hire, "empty", iso("2026-06-12", "10:00"))).toMatchObject({ status: "applied", rejection: null });
    const [row] = await raw<{ empty_at: Date }[]>`select came_back_empty_at as empty_at from public.rental where id = ${hire}`;
    expect(row!.empty_at.toISOString()).toBe(iso("2026-06-12", "10:00"));
    const [line] = await raw<{ after: { source: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and entity_id = ${hire} and action = 'rental.came_back_empty'`;
    expect(line!.after.source).toBe("phone");

    const day = await dispatch.snapshot(driver(), { deviceId: device, from: "2026-06-12", days: 1 });
    expect(day.hauls?.find((h) => h.tip?.rentalId === hire)?.tip).toEqual({
      rentalId: hire, container: "701 (20 yd)", tippedAt: null, cameBackEmptyAt: iso("2026-06-12", "10:00"),
    });

    /** A tip after the mark is refused, as it is from the office. */
    const tip = await send(hire, "tipped", iso("2026-06-12", "15:00"));
    expect(tip.status).toBe("rejected");
    expect(tip.rejection).toMatch(/recorded as coming back empty/);
  });

  it("is held to the office's rules", async () => {
    const onSite = await collectedHire("702", { collected: false });
    expect((await send(onSite, "empty", iso("2026-06-12", "10:00"))).rejection).toMatch(/still on its site/);

    const tipped = await collectedHire("703", { tipped: true });
    expect((await send(tipped, "empty", iso("2026-06-12", "10:00"))).rejection).toMatch(/so it did not come back empty/);

    const otherDay = await collectedHire("704");
    expect((await send(otherDay, "empty", iso("2026-06-13", "09:00"))).rejection).toMatch(/The time it came back empty is on that day/);

    const notMine = await collectedHire("705", { onMyStop: false });
    expect((await send(notMine, "empty", iso("2026-06-12", "10:00"))).rejection).toMatch(/not on one of your stops/);

    const marks = await raw`select 1 from public.rental where organization_id = ${ORG} and came_back_empty_at is not null
      and id in (${onSite}, ${tipped}, ${otherDay}, ${notMine})`;
    expect(marks).toHaveLength(0);
  });
});
