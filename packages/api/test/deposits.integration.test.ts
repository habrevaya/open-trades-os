import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createClient } from "@opentradesos/db";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as deposits from "../src/services/deposits";
import * as estimates from "../src/services/estimates";
import * as billing from "../src/services/billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId } from "./helpers";

/**
 * Deposits against a real ledger.
 *
 * The only claim worth testing here is the accounting one: a deposit is a
 * liability from the moment it arrives, and the liability account nets to zero
 * once the money is either applied, returned or earned. Everything else is
 * bookkeeping around that.
 */
const url = process.env.DATABASE_URL;

if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}

const run = url ? describe : describe.skip;

const ORG = fixtureId("deposits/org");
const USER = fixtureId("deposits/user");

let raw: postgres.Sql;
const db = () => createClient(url!);
const ctxFor = (roles: Actor["roles"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});
const office = () => ctxFor(["office_manager"]);
const finance = () => ctxFor(["accountant"]);

let customerId = "";
let propertyId = "";

/** Net movement on 2300, customer deposits. Debits positive. */
async function depositLiability(): Promise<number> {
  const rows = await raw<{ direction: string; amount: string }[]>`
    select direction, amount from public.ledger_entry
    where organization_id = ${ORG} and account_code = '2300'`;
  return rows.reduce(
    (acc, r) => acc + (r.direction === "debit" ? 1 : -1) * Number(r.amount),
    0,
  );
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Deposit Co", slug: "deposit-co" });

  const [c] = await raw`insert into public.customer (organization_id, name)
    values (${ORG}, 'Avery Cole') returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Pecan St', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${customerId}, ${propertyId})`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("asking for a deposit", () => {
  it("takes a flat amount", async () => {
    const d = await deposits.request(office(), { customerId, amount: "500.00" });
    expect(d.amountRequested).toBe("500.0000");
    expect(d.status).toBe("requested");
  });

  it("takes a percentage of the option the customer approved", async () => {
    const created = await estimates.create(office(), {
      customerId, propertyId, taxRate: "0",
      options: [
        { name: "Small", isRecommended: false, lines: [
          { name: "Repair", quantity: "1", unitPrice: "1000.00", discountAmount: "0",
            taxable: true, isOptional: false, isSelected: false }]},
        { name: "Large", isRecommended: false, lines: [
          { name: "Replace", quantity: "1", unitPrice: "8000.00", discountAmount: "0",
            taxable: true, isOptional: false, isSelected: false }]},
      ],
    }) as Record<string, unknown>;

    const small = (created["options"] as Array<Record<string, unknown>>)
      .find((o) => o["name"] === "Small")!;

    await estimates.approve(office(), {
      id: created["id"] as string, optionId: small["id"] as string,
      selectedLineIds: [], signerName: "Avery Cole", capturedVia: "phone",
    });

    const d = await deposits.request(office(), {
      customerId, estimateId: created["id"] as string, percent: "0.5",
    });

    // Half of what they agreed to, not half of the option they turned down.
    expect(d.amountRequested).toBe("500.0000");
  });

  it("caps a percentage at the maximum", async () => {
    const created = await estimates.create(office(), {
      customerId, propertyId, taxRate: "0",
      options: [{ name: "Only", isRecommended: true, lines: [
        { name: "Big job", quantity: "1", unitPrice: "40000.00", discountAmount: "0",
          taxable: true, isOptional: false, isSelected: false }]}],
    }) as Record<string, unknown>;

    const d = await deposits.request(office(), {
      customerId, estimateId: created["id"] as string, percent: "0.5", maximum: "5000.00",
    });
    expect(d.amountRequested).toBe("5000.0000");
  });

  it("refuses a percentage with nothing to take a percentage of", async () => {
    await expect(deposits.request(office(), { customerId, percent: "0.5" }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses a caller without deposit:collect", async () => {
    await expect(deposits.request(ctxFor(["readonly"]), { customerId, amount: "100.00" }))
      .rejects.toThrow(PermissionError);
  });
});

run("the money moving", () => {
  it("books a received deposit as a liability and never as revenue", async () => {
    const before = await depositLiability();
    const d = await deposits.request(office(), { customerId, amount: "2000.00" });
    await deposits.record(office(), { depositId: d.id, amount: "2000.00" });

    // Credits are negative here, so holding two thousand moves this by -2000.
    expect(await depositLiability()).toBeCloseTo(before - 2000, 4);

    const [revenue] = await raw`select coalesce(sum(amount), 0)::text as total
      from public.ledger_entry
      where organization_id = ${ORG} and account_code = '4000'
        and source_type = 'deposit'`;
    expect(Number(revenue!.total)).toBe(0);
  });

  it("recognises no sales tax on a deposit", async () => {
    const d = await deposits.request(office(), { customerId, amount: "1000.00" });
    await deposits.record(office(), { depositId: d.id, amount: "1000.00" });

    const [tax] = await raw`select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and account_code = '2200' and source_id = ${d.id}`;
    expect(tax!.n).toBe(0);
  });

  it("applies no more than the invoice is asking for", async () => {
    const d = await deposits.request(office(), { customerId, amount: "2000.00" });
    await deposits.record(office(), { depositId: d.id, amount: "2000.00" });

    const invoice = await billing.create(office(), {
      customerId,
      lines: [{ name: "First stage", quantity: "1", unitPrice: "1400.00",
                discountAmount: "0", taxable: false }],
    }) as Record<string, unknown>;

    const result = await deposits.apply(office(), {
      id: d.id, invoiceId: invoice["id"] as string,
    });

    // The remaining six hundred stays held rather than becoming a credit the
    // customer has to ring up about.
    expect(result.amountApplied).toBe("1400.0000");
    expect(result.deposit.amountApplied).toBe("1400.0000");
  });

  it("moves no cash when a deposit is applied", async () => {
    const d = await deposits.request(office(), { customerId, amount: "300.00" });
    await deposits.record(office(), { depositId: d.id, amount: "300.00" });
    const invoice = await billing.create(office(), {
      customerId,
      lines: [{ name: "Work", quantity: "1", unitPrice: "300.00",
                discountAmount: "0", taxable: false }],
    }) as Record<string, unknown>;

    await deposits.apply(office(), { id: d.id, invoiceId: invoice["id"] as string });

    const [cash] = await raw`select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and account_code = '1000'
        and source_type = 'deposit_application'`;
    expect(cash!.n).toBe(0);
  });

  it("returns a deposit without touching revenue", async () => {
    const d = await deposits.request(office(), { customerId, amount: "750.00" });
    await deposits.record(office(), { depositId: d.id, amount: "750.00" });
    const returned = await deposits.refund(finance(), { id: d.id, disposition: "refund" });

    expect(returned.status).toBe("refunded");
    const [rev] = await raw`select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'deposit_refund'
        and account_code = '4000'`;
    expect(rev!.n).toBe(0);
  });

  it("earns a forfeited deposit without moving cash", async () => {
    const d = await deposits.request(office(), { customerId, amount: "400.00" });
    await deposits.record(office(), { depositId: d.id, amount: "400.00" });
    await deposits.refund(finance(), { id: d.id, disposition: "forfeit" });

    const [rev] = await raw`select coalesce(sum(amount), 0)::text as total
      from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'deposit_forfeiture'
        and account_code = '4000' and direction = 'credit'`;
    expect(Number(rev!.total)).toBe(400);

    const [cash] = await raw`select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'deposit_forfeiture'
        and account_code = '1000'`;
    expect(cash!.n).toBe(0);
  });

  it("will not give back more than is still held", async () => {
    const d = await deposits.request(office(), { customerId, amount: "100.00" });
    await deposits.record(office(), { depositId: d.id, amount: "100.00" });
    await expect(deposits.refund(finance(), {
      id: d.id, disposition: "refund", amount: "250.00",
    })).rejects.toThrow(ConflictError);
  });

  it("refuses a refund from a role without deposit:refund", async () => {
    const d = await deposits.request(office(), { customerId, amount: "100.00" });
    await deposits.record(office(), { depositId: d.id, amount: "100.00" });
    // The office collects. Giving money back is finance's call.
    await expect(deposits.refund(office(), { id: d.id, disposition: "refund" }))
      .rejects.toThrow(PermissionError);
  });

  it("treats a repeated refund as a no-op and a changed mind as a conflict", async () => {
    const d = await deposits.request(office(), { customerId, amount: "100.00" });
    await deposits.record(office(), { depositId: d.id, amount: "100.00" });
    await deposits.refund(finance(), { id: d.id, disposition: "refund" });

    await expect(deposits.refund(finance(), { id: d.id, disposition: "refund" }))
      .resolves.toMatchObject({ status: "refunded" });
    await expect(deposits.refund(finance(), { id: d.id, disposition: "forfeit" }))
      .rejects.toThrow(ConflictError);
  });
});

run("converting an approved estimate", () => {
  const approvedEstimate = async () => {
    const created = await estimates.create(office(), {
      customerId, propertyId, taxRate: "0.0825",
      title: "Water heater",
      options: [{ name: "Standard", isRecommended: true, lines: [
        { name: "50 gallon heater, installed", quantity: "1", unitPrice: "2200.00",
          unitCost: "1150.00", discountAmount: "0", taxable: true,
          isOptional: false, isSelected: false },
        { name: "Expansion tank", quantity: "1", unitPrice: "180.00",
          unitCost: "70.00", discountAmount: "0", taxable: true,
          isOptional: true, isSelected: false },
      ]}],
    }) as Record<string, unknown>;

    const option = (created["options"] as Array<Record<string, unknown>>)[0]!;
    return { id: created["id"] as string, optionId: option["id"] as string, option };
  };

  it("bills the approved total to the cent", async () => {
    const { id, optionId } = await approvedEstimate();
    await estimates.approve(office(), {
      id, optionId, selectedLineIds: [], signerName: "Avery Cole", capturedVia: "in_person",
    });

    const result = await estimates.convert(office(), {
      id, createJob: true, createInvoice: true,
    });

    const [invoice] = await raw`select total from public.invoice where id = ${result.invoiceId}`;
    // 2200 plus 8.25 percent, and nothing for the tank nobody took.
    expect(invoice!.total).toBe("2381.5000");
  });

  it("does not bill an optional line the customer left alone", async () => {
    const { id, optionId } = await approvedEstimate();
    await estimates.approve(office(), {
      id, optionId, selectedLineIds: [], signerName: "Avery Cole", capturedVia: "in_person",
    });
    const result = await estimates.convert(office(), {
      id, createJob: true, createInvoice: true,
    });

    const lines = await raw`select name from public.invoice_line
      where invoice_id = ${result.invoiceId}`;
    expect(lines.map((l) => l.name)).toEqual(["50 gallon heater, installed"]);
  });

  it("bills an optional line the customer did take", async () => {
    const { id, optionId, option } = await approvedEstimate();
    const tank = (option["lines"] as Array<Record<string, unknown>>)
      .find((l) => l["isOptional"])!;

    await estimates.approve(office(), {
      id, optionId, selectedLineIds: [tank["id"] as string],
      signerName: "Avery Cole", capturedVia: "in_person",
    });
    const result = await estimates.convert(office(), {
      id, createJob: true, createInvoice: true,
    });

    const [invoice] = await raw`select total from public.invoice where id = ${result.invoiceId}`;
    // 2380 plus 8.25 percent, rounded once at the document.
    expect(invoice!.total).toBe("2576.3500");
  });

  it("carries the tax rate as applied, not one looked up again", async () => {
    const { id, optionId } = await approvedEstimate();
    await estimates.approve(office(), {
      id, optionId, selectedLineIds: [], signerName: "Avery Cole", capturedVia: "in_person",
    });
    const result = await estimates.convert(office(), {
      id, createJob: true, createInvoice: true,
    });

    const [line] = await raw`select tax_rate from public.invoice_line
      where invoice_id = ${result.invoiceId} limit 1`;
    expect(line!.tax_rate).toBe("0.082500");
  });

  it("refuses to convert an estimate nobody approved", async () => {
    const { id } = await approvedEstimate();
    await expect(estimates.convert(office(), { id, createJob: true, createInvoice: false }))
      .rejects.toThrow(ConflictError);
  });

  it("converting twice does not create a second job", async () => {
    const { id, optionId } = await approvedEstimate();
    await estimates.approve(office(), {
      id, optionId, selectedLineIds: [], signerName: "Avery Cole", capturedVia: "in_person",
    });

    const first = await estimates.convert(office(), { id, createJob: true, createInvoice: false });
    const second = await estimates.convert(office(), { id, createJob: true, createInvoice: false });
    expect(second.jobId).toBe(first.jobId);
  });
});
