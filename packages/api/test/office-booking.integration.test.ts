import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * BOOKING FROM THE OFFICE
 *
 * The rules a booking screen leans on, asked of the service the screen
 * calls: nobody is put on a day they have off, a lead becomes booked work
 * when it gets a visit, and a cancelled job takes no more visits.
 */

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("office-booking:org");
const USER = fixtureId("office-booking:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

async function technician(key: string, name: string, active = true): Promise<string> {
  const userId = fixtureId(`office-booking:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`office-booking-${key}@test.local`})
            on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${m!.id}, ${name}, ${active}) returning id`;
  return t!.id;
}

async function customerWithAddress() {
  const customer = await customers.create(owner(), {
    type: "residential", name: "Booking Customer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "4 Booking Ln", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  return { customerId: customer.id, propertyId: property.id };
}

/** Tomorrow at a fixed hour, so the window is always work still to come. */
function tomorrowAt(hour: number): { start: string; end: string } {
  const start = new Date(Date.now() + 86_400_000);
  start.setUTCHours(hour, 0, 0, 0);
  return { start: start.toISOString(), end: new Date(start.getTime() + 2 * 3_600_000).toISOString() };
}

let ana = "";
let ben = "";
let gone = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Booking Co", slug: "office-booking" });
  ana = await technician("ana", "Ana Ruiz");
  ben = await technician("ben", "Ben Okafor");
  gone = await technician("gone", "Left Last Year", false);
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await raw`
    insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
    values (${ORG}, ${ben}, ${`${day}T00:00:00Z`}::timestamptz, ${`${day}T23:59:00Z`}::timestamptz, true)`;
});
afterAll(async () => { if (raw) await raw.end(); });

run("booking a job from the office", () => {
  it("books the first visit with the technician who is free", async () => {
    const { customerId, propertyId } = await customerWithAddress();
    const window = tomorrowAt(15);
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "No heat", tags: [], customFields: {},
      visit: { windowStart: window.start, windowEnd: window.end, estimatedDurationMinutes: 90, technicianIds: [ana] },
    });
    expect(job.status).toBe("scheduled");
    expect(job.visits[0]!.technicianIds).toEqual([ana]);
  });

  it("refuses somebody on approved time off that day, by name", async () => {
    const { customerId, propertyId } = await customerWithAddress();
    const window = tomorrowAt(16);
    await expect(jobs.create(owner(), {
      customerId, propertyId, summary: "No heat", tags: [], customFields: {},
      visit: { windowStart: window.start, windowEnd: window.end, estimatedDurationMinutes: 60, technicianIds: [ana, ben] },
    })).rejects.toThrow(/Ben Okafor is on approved time off then/);
  });

  it("refuses a technician who has left", async () => {
    const { customerId, propertyId } = await customerWithAddress();
    const window = tomorrowAt(17);
    await expect(jobs.create(owner(), {
      customerId, propertyId, summary: "No heat", tags: [], customFields: {},
      visit: { windowStart: window.start, windowEnd: window.end, estimatedDurationMinutes: 60, technicianIds: [gone] },
    })).rejects.toThrow(/not active/);
  });

  it("does not refuse history: a past visit is a record, not a booking", async () => {
    const { customerId, propertyId } = await customerWithAddress();
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Last week", tags: [], customFields: {},
    });
    const past = new Date(Date.now() - 7 * 86_400_000);
    await raw`
      insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${ana}, ${new Date(past.getTime() - 3_600_000).toISOString()}::timestamptz,
              ${new Date(past.getTime() + 5 * 3_600_000).toISOString()}::timestamptz, true)`;
    const visit = await jobs.addVisit(owner(), {
      id: job.id, windowStart: past.toISOString(),
      windowEnd: new Date(past.getTime() + 3_600_000).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [ana],
    });
    expect(visit.technicianIds).toEqual([ana]);
  });

  it("refuses a second visit on a day the technician is away", async () => {
    const { customerId, propertyId } = await customerWithAddress();
    const job = await jobs.create(owner(), { customerId, propertyId, summary: "Install", tags: [], customFields: {} });
    const window = tomorrowAt(18);
    await expect(jobs.addVisit(owner(), {
      id: job.id, windowStart: window.start, windowEnd: window.end,
      estimatedDurationMinutes: 60, technicianIds: [ben],
    })).rejects.toThrow(/Ben Okafor is on approved time off/);
  });

  it("makes a lead booked work once it has a visit with a time", async () => {
    const { customerId, propertyId } = await customerWithAddress();
    const job = await jobs.create(owner(), { customerId, propertyId, summary: "Quote first", tags: [], customFields: {} });
    expect(job.status).toBe("lead");

    // A visit with no time yet is not a booking.
    await jobs.addVisit(owner(), { id: job.id, estimatedDurationMinutes: 60, technicianIds: [] });
    expect((await jobs.get(owner(), { id: job.id })).status).toBe("lead");

    const window = tomorrowAt(14);
    await jobs.addVisit(owner(), {
      id: job.id, windowStart: window.start, windowEnd: window.end, estimatedDurationMinutes: 60, technicianIds: [ana],
    });
    const after = await jobs.get(owner(), { id: job.id });
    expect(after.status).toBe("scheduled");
    expect(after.visits.map((v) => v.sequence)).toEqual([1, 2]);
  });

  it("takes no new visit on a cancelled job, and still records a cancelled one", async () => {
    const { customerId, propertyId } = await customerWithAddress();
    const job = await jobs.create(owner(), { customerId, propertyId, summary: "Called off", tags: [], customFields: {} });
    await jobs.update(owner(), { id: job.id, status: "cancelled" });
    const window = tomorrowAt(13);
    await expect(jobs.addVisit(owner(), {
      id: job.id, windowStart: window.start, windowEnd: window.end, estimatedDurationMinutes: 60, technicianIds: [],
    })).rejects.toThrow(/was cancelled/);
    const recorded = await jobs.addVisit(owner(), {
      id: job.id, windowStart: window.start, windowEnd: window.end,
      estimatedDurationMinutes: 60, technicianIds: [], status: "cancelled",
    });
    expect(recorded.status).toBe("cancelled");
  });
});
