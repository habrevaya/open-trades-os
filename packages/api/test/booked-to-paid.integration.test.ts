import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { applyTradePack } from "../src/services/trade-pack";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb } from "./helpers";

/**
 * PHASE 1'S DEFINITION OF DONE
 *
 * A real job goes from booked to paid, and the money agrees with the ledger to
 * the cent. Everything else in this file exists to prove that one sentence.
 */
const url = process.env.DATABASE_URL;

// A contributor without a database still gets a green suite. CI does not get
// that privilege: these tests are the only thing standing between a schema
// change and a cross tenant leak, and a run that quietly skips them reads
// green while proving nothing.
if (!url && process.env.CI) {
  throw new Error(
    "DATABASE_URL is not set. These tests must run in CI, not skip.",
  );
}

const run = url ? describe : describe.skip;

const ORG = "b0000001-0000-0000-0000-000000000001";
const USER = "b0000002-0000-0000-0000-000000000002";
let raw: postgres.Sql;

const ctx = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] },
  db: testDb(url!),
  ...extra,
});

/** Net movement on an account across the whole organization. Debits positive. */
async function accountBalance(account: string): Promise<string> {
  const [row] = await raw`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} and account_code = ${account}`;
  return (row as { net: string }).net;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "End To End HVAC", slug: "e2e-hvac" });
  await applyTradePack(ctx(), "hvac");
});

afterAll(async () => { if (raw) await raw.end(); });

run("booked to paid", () => {
  let customerId: string;
  let propertyId: string;
  let jobId: string;
  let visitId: string;
  let invoiceId: string;

  it("books a customer with their property", async () => {
    const created = await customers.create(ctx(), {
      type: "residential", name: "Delacroix", email: "d@example.test", phone: "512-555-0114",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
      property: { address: { line1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
    });
    customerId = created.id as string;

    const [prop] = await raw`select id from public.property where organization_id = ${ORG}`;
    propertyId = prop!.id;
    expect(customerId).toBeTruthy();
  });

  it("creates a job with its first visit scheduled", async () => {
    const job = await jobs.create(ctx(), {
      customerId, propertyId,
      summary: "No cooling upstairs",
      customerComplaint: "Started making a clicking noise then stopped blowing cold",
      tags: [], customFields: {},
      visit: {
        windowStart: "2026-09-25T13:00:00.000Z",
        windowEnd: "2026-09-25T17:00:00.000Z",
        estimatedDurationMinutes: 90,
        technicianIds: [],
      },
    });
    jobId = job.id as string;
    expect(job.status).toBe("scheduled");
    expect(job.number).toBe(1);

    const [v] = await raw`select id, status from public.visit where job_id = ${jobId}`;
    visitId = v!.id;
    expect(v!.status).toBe("unassigned");
  });

  it("completes the visit and closes the job", async () => {
    const result = await jobs.complete(ctx(), {
      id: visitId,
      technicianNotes: "Dual run capacitor failed, measured 18uF against 45 rated. Replaced, verified cooling.",
    });
    expect(result.status).toBe("completed");
    expect(result.raisedDispatchException).toBe(false);

    const job = await jobs.get(ctx(), { id: jobId });
    expect(job.status).toBe("completed");
  });

  it("invoices from the price book, not from the request", async () => {
    const [item] = await raw`
      select id from public.price_book_item where organization_id = ${ORG} and code = 'CAP-DUAL'`;

    const invoice = await billing.create(ctx(), {
      customerId, jobId,
      lines: [
        // A deliberately wrong price. The price book version must win.
        { priceBookItemId: item!.id, name: "ignored", quantity: "1", unitPrice: "1.00", discountAmount: "0", taxable: true },
        { name: "Diagnostic fee", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: true },
      ],
    });
    invoiceId = invoice.id as string;

    expect(invoice.lines[0]!.unitPrice).toBe("329.0000");
    expect(invoice.lines[0]!.name).toBe("Dual run capacitor replacement");
    expect(invoice.total).toBe("458.0000");
    expect(invoice.balance).toBe("458.0000");
    expect(invoice.status).toBe("open");
  });

  it("freezes the price book version onto the line", async () => {
    // A later price rise must not rewrite what this invoice said.
    const [line] = await raw`
      select price_book_item_version_id from public.invoice_line
      where invoice_id = ${invoiceId} and price_book_item_version_id is not null`;
    expect(line!.price_book_item_version_id).toBeTruthy();
  });

  it("posts the invoice to the ledger", async () => {
    expect(await accountBalance("1200")).toBe("458.0000");   // AR up
    expect(await accountBalance("4000")).toBe("-458.0000");  // Revenue earned
  });

  it("takes a card payment and clears the balance", async () => {
    const result = await billing.pay(ctx({ idempotencyKey: "pay-e2e-1" }), {
      customerId, method: "card", amount: "458.00", tipAmount: "0",
      allocations: [{ invoiceId, amount: "458.00" }],
    });
    expect(result.ledgerTransactionId).toBeTruthy();

    const invoice = await billing.get(ctx(), { id: invoiceId });
    expect(invoice.status).toBe("paid");
    expect(invoice.balance).toBe("0.0000");

    const job = await jobs.get(ctx(), { id: jobId });
    expect(job.status).toBe("paid");
  });

  /**
   * THE ASSERTION THE PHASE EXISTS FOR. Bill it, collect it, and the
   * receivable is exactly flat. A cent of drift here never reconciles.
   */
  it("leaves the receivable at exactly zero", async () => {
    expect(await accountBalance("1200")).toBe("0.0000");
    expect(await accountBalance("1000")).toBe("458.0000"); // Cash
  });

  it("keeps every ledger transaction balanced", async () => {
    const rows = await raw`
      select transaction_id,
        sum(case when direction = 'debit' then amount else -amount end)::text as imbalance
      from public.ledger_entry where organization_id = ${ORG}
      group by transaction_id having sum(case when direction = 'debit' then amount else -amount end) <> 0`;
    expect(rows).toHaveLength(0);
  });

  it("agrees with AR aging", async () => {
    const aging = await billing.arAging(ctx(), {});
    expect(aging.total).toBe("0.0000");
  });

  it("is idempotent on the payment, so a retry does not double collect", async () => {
    await billing.pay(ctx({ idempotencyKey: "pay-e2e-1" }), {
      customerId, method: "card", amount: "458.00", tipAmount: "0",
      allocations: [{ invoiceId, amount: "458.00" }],
    });
    const [row] = await raw`select count(*)::int as n from public.payment where organization_id = ${ORG}`;
    expect(row!.n).toBe(1);
    expect(await accountBalance("1200")).toBe("0.0000");
  });
});

run("a payment spanning invoices", () => {
  it("applies oldest balance first when no allocation is given", async () => {
    const created = await customers.create(ctx(), {
      type: "residential", name: "Whitfield", paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: {},
    });
    const cid = created.id as string;

    const first = await billing.create(ctx(), {
      customerId: cid,
      dueOn: "2026-08-01",
      lines: [{ name: "Service call", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });
    const second = await billing.create(ctx(), {
      customerId: cid,
      dueOn: "2026-09-01",
      lines: [{ name: "Maintenance", quantity: "1", unitPrice: "189.00", discountAmount: "0", taxable: false }],
    });

    // Enough to clear the first and part of the second.
    await billing.pay(ctx(), { customerId: cid, method: "check", amount: "200.00", tipAmount: "0" });

    const a = await billing.get(ctx(), { id: first.id as string });
    const b = await billing.get(ctx(), { id: second.id as string });

    expect(a.status).toBe("paid");
    expect(a.balance).toBe("0.0000");
    expect(b.status).toBe("partially_paid");
    expect(b.balance).toBe("118.0000");
  });

  it("refuses to allocate more than the payment", async () => {
    const created = await customers.create(ctx(), {
      type: "residential", name: "Overallocate", paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: {},
    });
    const invoice = await billing.create(ctx(), {
      customerId: created.id as string,
      lines: [{ name: "Service call", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false }],
    });
    await expect(billing.pay(ctx(), {
      customerId: created.id as string, method: "cash", amount: "50.00", tipAmount: "0",
      allocations: [{ invoiceId: invoice.id as string, amount: "100.00" }],
    })).rejects.toThrow(/but the payment is/);
  });
});

run("a visit completed after dispatch cancelled it", () => {
  it("accepts the write and raises an exception instead of rejecting it", async () => {
    const created = await customers.create(ctx(), {
      type: "residential", name: "Offline Case", paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: {},
    });
    const [prop] = await raw`
      insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '9 Crawlspace Ln', 'Austin', 'TX', '78702') returning id`;

    const job = await jobs.create(ctx(), {
      customerId: created.id as string, propertyId: prop!.id,
      summary: "Basement, no signal", tags: [], customFields: {},
      visit: {
        windowStart: "2026-09-26T13:00:00.000Z", windowEnd: "2026-09-26T17:00:00.000Z",
        estimatedDurationMinutes: 60, technicianIds: [],
      },
    });

    const [visitRow] = await raw`select id from public.visit where job_id = ${job.id}`;
    const cancelledVisitId = String(visitRow!.id);
    await raw`update public.visit set status = 'cancelled' where id = ${cancelledVisitId}`;

    const result = await jobs.complete(ctx(), {
      id: cancelledVisitId,
      completedOfflineAt: "2026-09-26T15:30:00.000Z",
      technicianNotes: "Work was done before the cancellation reached the device",
    });

    // The work physically happened. Rejecting the write would destroy the
    // labour record, photos, signature and readings.
    expect(result.status).toBe("completed_after_cancellation");
    expect(result.raisedDispatchException).toBe(true);

    const [obligation] = await raw`
      select kind from public.obligation
      where organization_id = ${ORG} and entity_id = ${cancelledVisitId}`;
    expect(obligation!.kind).toBe("dispatch.completed_after_cancellation");
  });
});
