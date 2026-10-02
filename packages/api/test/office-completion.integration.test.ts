import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as priceBook from "../src/services/pricebook";
import * as billing from "../src/services/billing";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * FINISHING WORK FROM THE OFFICE
 *
 * What the job page's "Complete visit" and "Reopen job" lean on: what was
 * used becomes job lines priced from the price book, the last visit
 * finishes the job along its lifecycle and says so as an event, and a job
 * already invoiced is not walked back by a late visit.
 */

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("office-completion:org");
const USER = fixtureId("office-completion:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: Actor["roles"][number]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] }, db: db(),
});
const owner = () => as("owner");

let capacitor = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Completion Co", slug: "office-completion" });
  const item = await priceBook.create(owner(), {
    kind: "material", code: "CAP-45", name: "Dual run capacitor", price: "43.37", cost: "11.20", taxable: true,
  });
  capacitor = item.id;
});
afterAll(async () => { if (raw) await raw.end(); });

async function aJob(visits: number) {
  const customer = await customers.create(owner(), {
    type: "residential", name: "Completion Customer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "9 Done Dr", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const start = new Date(Date.now() + 86_400_000);
  const job = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "No cooling", tags: [], customFields: {},
    visit: {
      windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 7_200_000).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [],
    },
  });
  for (let i = 1; i < visits; i += 1) {
    await jobs.addVisit(owner(), {
      id: job.id, windowStart: start.toISOString(),
      windowEnd: new Date(start.getTime() + 7_200_000).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [],
    });
  }
  return { ...(await jobs.get(owner(), { id: job.id })), customerId: customer.id };
}

const eventsFor = (jobId: string, name: string) =>
  raw<{ id: string }[]>`select id from public.domain_event where entity_id = ${jobId} and name = ${name}`;

run("completing a visit from the office", () => {
  it("records what was used as job lines, priced from the price book in force", async () => {
    const job = await aJob(1);
    await jobs.complete(owner(), {
      id: job.visits[0]!.id, technicianNotes: "Replaced the capacitor.",
      partsUsed: [{ priceBookItemId: capacitor, quantity: "3" }],
    });
    const lines = await jobs.lines(owner(), { id: job.id });
    expect(lines.data).toHaveLength(1);
    expect(lines.data[0]).toMatchObject({
      name: "Dual run capacitor", quantity: "3.0000", unitPrice: "43.3700", unitCost: "11.2000",
      kind: "part", source: "office", invoiceLineId: null, visitId: job.visits[0]!.id,
    });
  });

  it("hides what a part cost from somebody who may not see cost", async () => {
    const job = await aJob(1);
    await jobs.complete(owner(), {
      id: job.visits[0]!.id, partsUsed: [{ priceBookItemId: capacitor, quantity: "1" }],
    });
    const seen = await jobs.lines(as("dispatcher"), { id: job.id });
    expect(seen.data[0]!.unitPrice).toBe("43.3700");
    expect("unitCost" in seen.data[0]!).toBe(false);
  });

  it("refuses a part that is not in the price book, and records nothing", async () => {
    const job = await aJob(1);
    await expect(jobs.complete(owner(), {
      id: job.visits[0]!.id, partsUsed: [{ priceBookItemId: fixtureId("office-completion:no-such-item"), quantity: "1" }],
    })).rejects.toThrow(/Price book item not found/);
    expect((await jobs.get(owner(), { id: job.id })).visits[0]!.status).not.toBe("completed");
  });

  it("finishes the job with its last visit, and says so as an event", async () => {
    const job = await aJob(2);
    await jobs.complete(owner(), { id: job.visits[0]!.id });
    expect((await jobs.get(owner(), { id: job.id })).status).toBe("scheduled");
    expect(await eventsFor(job.id, "job.completed")).toHaveLength(0);

    await jobs.complete(owner(), { id: job.visits[1]!.id });
    expect((await jobs.get(owner(), { id: job.id })).status).toBe("completed");
    expect(await eventsFor(job.id, "job.completed")).toHaveLength(1);
    expect(await eventsFor(job.visits[1]!.id, "visit.completed")).toHaveLength(1);
  });

  it("does not walk an invoiced job back to completed when a late visit is finished", async () => {
    const job = await aJob(2);
    await jobs.complete(owner(), { id: job.visits[0]!.id });
    await billing.create(owner(), {
      customerId: job.customerId, jobId: job.id,
      lines: [{ name: "Diagnostic", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });
    expect((await jobs.get(owner(), { id: job.id })).status).toBe("invoiced");

    await jobs.complete(owner(), { id: job.visits[1]!.id });
    expect((await jobs.get(owner(), { id: job.id })).status).toBe("invoiced");
  });

  it("reopens a finished job, and finishes it again, along the job's lifecycle", async () => {
    const job = await aJob(1);
    await jobs.complete(owner(), { id: job.visits[0]!.id });
    await jobs.update(owner(), { id: job.id, status: "in_progress" });
    expect((await jobs.get(owner(), { id: job.id })).status).toBe("in_progress");
    await jobs.update(owner(), { id: job.id, status: "completed" });
    expect((await jobs.get(owner(), { id: job.id })).status).toBe("completed");
  });

  it("will not reopen a paid job", async () => {
    const job = await aJob(1);
    await raw`update public.job set status = 'paid' where id = ${job.id}`;
    await expect(jobs.update(owner(), { id: job.id, status: "in_progress" }))
      .rejects.toThrow(/cannot move from "paid"/);
  });
});
