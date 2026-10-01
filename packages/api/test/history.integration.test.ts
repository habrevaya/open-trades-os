import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as billing from "../src/services/billing";
import * as jobs from "../src/services/jobs";
import * as estimates from "../src/services/estimates";
import * as accounting from "../src/services/accounting";
import { ConflictError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * RECORDING WHAT ALREADY HAPPENED
 *
 * A migration loads years of history through the same routes a person uses
 * today. Every business date it sends has to land on that date, in the ledger
 * as well as on the document, and the power to send one has to belong to
 * somebody who was given it: back-dating is how books are cooked.
 *
 * Each case here is one rule from services/history.ts, checked against what
 * the ledger actually holds rather than what the service returned.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("history:org");
const USER = fixtureId("history:user");

let raw: postgres.Sql;
let customerId = "";
let propertyId = "";

const as = (roles: string[], grants: string[] = []): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: roles as Actor["roles"],
    ...(grants.length > 0 ? { grants: grants as NonNullable<Actor["grants"]> } : {}),
  },
  db: testDb(url!),
});
const owner = () => as(["owner"]);
/** Everything an office manager has. Not `data:import`. */
const office = () => as(["office_manager"]);

/** The company has no timezone set, so its calendar is the fallback's. */
const ZONE = "America/Chicago";
const today = () => time.dateIn(new Date(), ZONE);
const daysAgo = (n: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const line = { name: "Service call", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false };

async function ledgerFor(sourceId: string) {
  return raw<{ occurred_at: Date; account_code: string; direction: string; amount: string }[]>`
    select occurred_at, account_code, direction, amount from public.ledger_entry
    where organization_id = ${ORG} and source_id = ${sourceId}`;
}
async function eventsFor(entityId: string) {
  return raw<{ name: string }[]>`
    select name from public.domain_event where organization_id = ${ORG} and entity_id = ${entityId}`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "History Co", slug: "history-co" });
  const customer = await customers.create(owner(), {
    type: "residential", name: "Hilda History", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "1 Old Road", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("an invoice issued on another day", () => {
  it("is issued on that day, and its posting is dated by it", async () => {
    const invoice = await billing.create(owner(), { customerId, issuedOn: "2023-03-15", lines: [line] });
    expect(invoice.issuedOn).toBe("2023-03-15");

    const entries = await ledgerFor(invoice.id);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(time.dateIn(e.occurred_at, ZONE)).toBe("2023-03-15");
  });

  it("is not announced: no workflow hears about an invoice from 2023", async () => {
    const historical = await billing.create(owner(), { customerId, issuedOn: "2023-03-16", lines: [line] });
    expect(await eventsFor(historical.id)).toEqual([]);
    const current = await billing.create(owner(), { customerId, lines: [line] });
    expect((await eventsFor(current.id)).map((e) => e.name)).toContain("invoice.issued");
  });

  it("needs data:import for history, and nothing for a late entry inside a week", async () => {
    await expect(billing.create(office(), { customerId, issuedOn: "2023-03-15", lines: [line] }))
      .rejects.toThrow(PermissionError);
    const late = await billing.create(office(), { customerId, issuedOn: daysAgo(3), lines: [line] });
    expect(late.issuedOn).toBe(daysAgo(3));
    // The office manager's own today still works, dated in the company's calendar.
    const now = await billing.create(office(), { customerId, lines: [line] });
    expect(now.issuedOn).toBe(today());
  });

  it("is never in the future, whoever asks", async () => {
    const tomorrow = time.nextDay(today());
    await expect(billing.create(owner(), { customerId, issuedOn: tomorrow, lines: [line] }))
      .rejects.toThrow(UnprocessableError);
  });
});

run("a payment received on another day", () => {
  it("posts its cash on the day it arrived, and says nothing to the customer", async () => {
    const invoice = await billing.create(owner(), { customerId, issuedOn: "2023-04-01", lines: [line] });
    const payment = await billing.pay(owner(), {
      customerId, method: "check", amount: "100.00", tipAmount: "0",
      receivedAt: "2023-04-20T15:00:00.000Z",
      allocations: [{ invoiceId: invoice.id, amount: "100.00" }],
    });
    const entries = await ledgerFor(payment.id);
    for (const e of entries) expect(e.occurred_at.toISOString()).toBe("2023-04-20T15:00:00.000Z");
    expect(await eventsFor(payment.id)).toEqual([]);
    expect(await eventsFor(invoice.id)).toEqual([]);
  });

  it("refuses an office manager dating a cheque to last year", async () => {
    await expect(billing.pay(office(), {
      customerId, method: "check", amount: "10.00", tipAmount: "0",
      receivedAt: "2025-01-02T15:00:00.000Z", allocations: [],
    })).rejects.toThrow(PermissionError);
  });
});

run("a closed period", () => {
  it("refuses anything posted into it, even from the owner", async () => {
    await accounting.closePeriod(owner(), { periodEnd: "2022-12-31", note: "2022 filed." });
    const before = await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}`;

    await expect(billing.create(owner(), { customerId, issuedOn: "2022-11-30", lines: [line] }))
      .rejects.toThrow(ConflictError);
    await expect(billing.pay(owner(), {
      customerId, method: "cash", amount: "5.00", tipAmount: "0", receivedAt: "2022-12-31T18:00:00.000Z",
    })).rejects.toThrow(/closed through 2022-12-31/);

    const after = await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}`;
    expect(after[0]!.n).toBe(before[0]!.n);

    // The first day after the close is open.
    const open = await billing.create(owner(), { customerId, issuedOn: "2023-01-01", lines: [line] });
    expect(open.issuedOn).toBe("2023-01-01");
  });
});

run("a job finished on another day", () => {
  it("keeps the day it was finished, and does not ask anybody for a review", async () => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Old repair", tags: [], customFields: {},
    });
    await jobs.update(owner(), { id: job.id, status: "scheduled" });
    const done = await jobs.update(owner(), {
      id: job.id, status: "completed", completedAt: "2022-08-01T20:00:00.000Z",
    });
    expect(done.completedAt?.toISOString()).toBe("2022-08-01T20:00:00.000Z");
    const names = (await eventsFor(job.id)).map((e) => e.name);
    expect(names).not.toContain("job.completed");
  });

  it("takes a completion time only with the move to completed", async () => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Another", tags: [], customFields: {},
    });
    await expect(jobs.update(owner(), { id: job.id, completedAt: "2022-08-01T20:00:00.000Z" }))
      .rejects.toThrow(UnprocessableError);
    await jobs.update(owner(), { id: job.id, status: "scheduled" });
    await expect(jobs.update(office(), {
      id: job.id, status: "completed", completedAt: "2022-08-01T20:00:00.000Z",
    })).rejects.toThrow(PermissionError);
  });
});

run("an estimate written on another day", () => {
  it("records the day it was written, and today when nothing is said", async () => {
    const options = [{ name: "Repair", isRecommended: false, lines: [{ ...line, isOptional: false, isSelected: false }] }];
    const old = await estimates.create(owner(), {
      customerId, propertyId, issuedOn: "2021-06-01", taxRate: "0", options,
    });
    expect(old.issuedOn).toBe("2021-06-01");
    const fresh = await estimates.create(office(), { customerId, propertyId, taxRate: "0", options });
    expect(fresh.issuedOn).toBe(today());
    await expect(estimates.create(office(), { customerId, propertyId, issuedOn: "2021-06-01", taxRate: "0", options }))
      .rejects.toThrow(PermissionError);
  });
});
