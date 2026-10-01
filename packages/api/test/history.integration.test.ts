import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as billing from "../src/services/billing";
import * as jobs from "../src/services/jobs";
import * as estimates from "../src/services/estimates";
import * as accounting from "../src/services/accounting";
import * as priceBook from "../src/services/pricebook";
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

run("tax as another system charged it", () => {
  const taxed = (taxAmount?: string) => ({
    name: "Part", quantity: "1", unitPrice: "10.05", discountAmount: "0", taxable: true,
    taxRate: "0.0825", ...(taxAmount ? { taxAmount } : {}),
  });

  it("keeps the source's per-line rounding and posts it as tax collected", async () => {
    const invoice = await billing.create(owner(), {
      customerId, issuedOn: "2023-05-01",
      lines: [taxed("0.82"), taxed("0.82"), taxed("0.82"), taxed("0.82")],
      expectedTotals: { subtotal: "40.20", taxTotal: "3.28", total: "43.48" },
    });
    expect(invoice.taxTotal).toBe("3.2800");
    expect(invoice.total).toBe("43.4800");
    expect(invoice.lines[0]!.taxRate).toBe("0.082500");
    const tax = (await ledgerFor(invoice.id)).filter((e) => e.account_code === "2200");
    expect(tax.map((e) => [e.direction, e.amount])).toEqual([["credit", "3.2800"]]);
  });

  it("computes from the rate when no amount is stated, rounding once", async () => {
    const invoice = await billing.create(owner(), {
      customerId, issuedOn: "2023-05-01", lines: [taxed(), taxed(), taxed(), taxed()],
    });
    expect(invoice.taxTotal).toBe("3.3200");
  });

  it("refuses a stated tax its rate cannot produce, naming the line", async () => {
    await expect(billing.create(owner(), {
      customerId, lines: [taxed(), taxed("1.50")],
    })).rejects.toMatchObject({ issues: [{ path: "lines.1.taxAmount" }] });
  });

  it("refuses totals that differ to the cent, naming each one, and stores nothing", async () => {
    const before = await raw`select count(*)::int as n from public.invoice where organization_id = ${ORG}`;
    await expect(billing.create(owner(), {
      customerId, lines: [taxed("0.83")],
      expectedTotals: { taxTotal: "0.83", total: "10.87" },
    })).rejects.toMatchObject({ issues: [{ path: "expectedTotals.total" }] });
    const after = await raw`select count(*)::int as n from public.invoice where organization_id = ${ORG}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("is history only: an office manager cannot state a tax rate", async () => {
    await expect(billing.create(office(), { customerId, lines: [taxed()] })).rejects.toThrow(PermissionError);
  });

  it("carries an invoice-level discount as a discount, and a charge as a manual line", async () => {
    const discounted = await billing.create(office(), {
      customerId, lines: [line], adjustment: { name: "Loyalty discount", amount: "-15.00" },
      expectedTotals: { subtotal: "100.00", discountTotal: "15.00", total: "85.00" },
    });
    expect(discounted.lines.at(-1)).toMatchObject({ origin: "manual", discountAmount: "15.0000", taxable: false });
    const contra = (await ledgerFor(discounted.id)).filter((e) => e.account_code === "4900");
    expect(contra.map((e) => [e.direction, e.amount])).toEqual([["debit", "15.0000"]]);

    const charged = await billing.create(office(), {
      customerId, lines: [line], adjustment: { name: "Not itemised", amount: "4.50" },
    });
    expect(charged.total).toBe("104.5000");
  });
});

run("an estimate taxed per line", () => {
  it("uses a line's own rate over the estimate's", async () => {
    const estimate = await estimates.create(office(), {
      customerId, propertyId, taxRate: "0.08",
      options: [{
        name: "Repair", isRecommended: false, lines: [
          { ...line, taxable: true, isOptional: false, isSelected: false },
          { ...line, taxable: true, taxRate: "0", isOptional: false, isSelected: false },
        ],
      }],
    });
    expect(estimate.options[0]!.taxTotal).toBe("8.0000");
  });
});

run("a historical line linked to the price book", () => {
  it("keeps the price it was sold at when asked, and is re-priced when not", async () => {
    const item = await priceBook.create(owner(), {
      kind: "service", code: "HIST-TUNE", name: "Tune up", price: "189.00", taxable: false,
    });
    const asSold = { priceBookItemId: item.id, name: "Tune up (2024)", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false };
    const kept = await billing.create(owner(), {
      customerId, issuedOn: "2024-04-01", lines: [{ ...asSold, priceAsGiven: true }],
    });
    expect(kept.lines[0]).toMatchObject({ unitPrice: "129.0000", name: "Tune up (2024)" });
    expect(kept.lines[0]!.priceBookItemVersionId).not.toBeNull();

    const repriced = await billing.create(owner(), { customerId, lines: [asSold] });
    expect(repriced.lines[0]!.unitPrice).toBe("189.0000");

    await expect(billing.create(office(), { customerId, lines: [{ ...asSold, priceAsGiven: true }] }))
      .rejects.toThrow(PermissionError);
  });
});
