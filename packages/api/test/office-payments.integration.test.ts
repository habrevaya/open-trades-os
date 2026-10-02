import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * RECORDING A PAYMENT WITH ITS ALLOCATIONS NAMED
 *
 * The record-a-payment screen always names where the money goes, one box
 * per open invoice. Applying held money later checked the invoice was this
 * customer's, open, and owed at least that much; recording a payment with
 * the same allocations checked none of it.
 */

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("office-payments:org");
const USER = fixtureId("office-payments:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Payments Co", slug: "office-payments" });
});
afterAll(async () => { if (raw) await raw.end(); });

async function customerOwing(amount: string) {
  const customer = await customers.create(owner(), {
    type: "residential", name: "Paying Customer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const invoice = await billing.create(owner(), {
    customerId: customer.id,
    lines: [{ name: "Service", quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
  return { customerId: customer.id, invoice };
}

run("a payment with its allocations named", () => {
  it("pays the invoices named and holds the rest", async () => {
    const { customerId, invoice } = await customerOwing("100.00");
    const paid = await billing.pay(owner(), {
      customerId, method: "check", amount: "150.00", tipAmount: "0", checkNumber: "1044",
      allocations: [{ invoiceId: invoice.id, amount: "100.00" }],
    });
    expect(paid.unappliedAmount).toBe("50.0000");
    expect((await billing.get(owner(), { id: invoice.id })).status).toBe("paid");
  });

  it("refuses another customer's invoice", async () => {
    const mine = await customerOwing("100.00");
    const theirs = await customerOwing("100.00");
    await expect(billing.pay(owner(), {
      customerId: mine.customerId, method: "cash", amount: "100.00", tipAmount: "0",
      allocations: [{ invoiceId: theirs.invoice.id, amount: "100.00" }],
    })).rejects.toThrow(/is not this customer's/);
  });

  it("refuses more than the invoice owes, counting every line for it together", async () => {
    const { customerId, invoice } = await customerOwing("100.00");
    await expect(billing.pay(owner(), {
      customerId, method: "cash", amount: "120.00", tipAmount: "0",
      allocations: [{ invoiceId: invoice.id, amount: "120.00" }],
    })).rejects.toThrow(/owes 100/);
    await expect(billing.pay(owner(), {
      customerId, method: "cash", amount: "120.00", tipAmount: "0",
      allocations: [{ invoiceId: invoice.id, amount: "60.00" }, { invoiceId: invoice.id, amount: "60.00" }],
    })).rejects.toThrow(/owes 100/);
    expect((await billing.get(owner(), { id: invoice.id })).balance).toBe("100.0000");
  });

  it("refuses a void invoice and a draft, which take no payment", async () => {
    const { customerId, invoice } = await customerOwing("100.00");
    await billing.voidInvoice(owner(), { id: invoice.id, reason: "Wrong customer" });
    await expect(billing.pay(owner(), {
      customerId, method: "cash", amount: "100.00", tipAmount: "0",
      allocations: [{ invoiceId: invoice.id, amount: "100.00" }],
    })).rejects.toThrow(/is void and takes no payment/);

    const draft = await billing.create(owner(), {
      customerId, draft: true,
      lines: [{ name: "Service", quantity: "1", unitPrice: "80.00", discountAmount: "0", taxable: false }],
    });
    await expect(billing.pay(owner(), {
      customerId, method: "cash", amount: "80.00", tipAmount: "0",
      allocations: [{ invoiceId: draft.id, amount: "80.00" }],
    })).rejects.toThrow(/is draft and takes no payment/);
  });

  it("holds the whole of a payment applied to nothing, applies it later, and refunds what is left", async () => {
    const { customerId, invoice } = await customerOwing("300.00");
    const deposit = await billing.pay(owner(), {
      customerId, method: "ach", amount: "500.00", tipAmount: "0", allocations: [],
    });
    expect(deposit.unappliedAmount).toBe("500.0000");

    const applied = await billing.applyPayment(owner(), {
      id: deposit.id, allocations: [{ invoiceId: invoice.id, amount: "300.00" }],
    });
    expect(applied.unappliedAmount).toBe("200.0000");
    expect((await billing.get(owner(), { id: invoice.id })).status).toBe("paid");

    const refunded = await billing.recordRefund(owner(), {
      id: deposit.id, amount: "200.00", method: "check", checkNumber: "2001", reason: "Job came in under",
    });
    expect(refunded.unappliedAmount).toBe("0.0000");
    expect((await billing.get(owner(), { id: invoice.id })).status).toBe("paid");
  });
});
