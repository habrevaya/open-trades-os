import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE DEMO'S MONEY IS POSTED, NOT INSERTED
 *
 * The seed once wrote its invoices straight into the invoice table, so the
 * ledger behind them was empty and every seeded job showed $0.00 of revenue
 * beside an invoice for hundreds, in the screenshots too. Revenue, job
 * costing and the accounting sync read the ledger, and only the billing
 * service writes it, so the seed has to raise and pay its invoices through
 * that service. This fails the day somebody inserts one by hand again.
 */
describe("the seed", () => {
  const source = readFileSync(join(__dirname, "../src/seed/index.ts"), "utf8");

  it("writes no invoice, payment or ledger row of its own", () => {
    const tables = ["invoice", "invoice_line", "payment", "payment_allocation", "ledger_entry", "deposit"];
    const direct = tables.filter((table) => new RegExp(`insert into public\\.${table}\\b`).test(source));
    expect(direct).toEqual([]);
  });

  it("raises and pays them through the billing service", () => {
    expect(source).toMatch(/billing\.create\(/);
    expect(source).toMatch(/billing\.pay\(/);
  });
});
