import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as commissions from "../src/services/commissions";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as priceBook from "../src/services/pricebook";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * M17 AND M06. AN ITEM'S OWN COMMISSION RATE, PAID BY THE COMPANY'S CHOICE
 *
 * Real price book items, a real job, a real invoice priced from the book,
 * paid in full, and the commission settled on it, once for each choice. The
 * invoice, every time:
 *
 *   Water heater, 50 gallon   1,000.00   the item's own rate 10%
 *   Smart thermostat            300.00   the item's own rate 5%
 *   Haul away the old tank      200.00   no rate of its own
 *
 * Under a plan of eight per cent of revenue (120.00 on the whole invoice;
 * 80.00, 24.00 and 16.00 on the lines):
 *
 *   The plan only                 120.00
 *   The item's rate instead       100.00 + 15.00 + 16.00 = 131.00
 *   Whichever pays more           100.00 + 24.00 + 16.00 = 140.00
 *   The item's rate on top        120.00 + 100.00 + 15.00 = 235.00
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("commission-item-rates:org");
const USER = fixtureId("commission-item-rates:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);
/** Reads commission and configures none of it. */
const reader = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: [], grants: ["commission:read"] }, db: db() });

let ray = "";
let dana = "";
let customerId = "";
let propertyId = "";
let heater = "";
let thermostat = "";
let haul = "";

async function technician(name: string): Promise<string> {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return row!.id;
}

/** A job the people named worked, invoiced from the price book and paid in full. */
async function paidInvoice(technicianIds: string[] = [ray]): Promise<string> {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Water heater changeout", tags: [], customFields: {},
    visit: {
      windowStart: "2026-02-03T14:00:00.000Z", windowEnd: "2026-02-03T18:00:00.000Z",
      estimatedDurationMinutes: 240, technicianIds,
    },
  });
  const invoice = await billing.create(owner(), {
    customerId, jobId: job.id as string,
    lines: [
      { priceBookItemId: heater, name: "Water heater, 50 gallon", quantity: "1", unitPrice: "1000.00", discountAmount: "0", taxable: false },
      { priceBookItemId: thermostat, name: "Smart thermostat", quantity: "1", unitPrice: "300.00", discountAmount: "0", taxable: false },
      { priceBookItemId: haul, name: "Haul away the old tank", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false },
    ],
  });
  expect(invoice.subtotal).toBe("1500.0000");
  await billing.pay(owner(), {
    customerId, method: "card", amount: "1500.00", tipAmount: "0",
    allocations: [{ invoiceId: invoice.id as string, amount: "1500.00" }],
  });
  const [paid] = await raw<{ status: string }[]>`select status::text from public.invoice where id = ${invoice.id as string}`;
  expect(paid!.status).toBe("paid");
  return invoice.id as string;
}

const versionsOn = (invoiceId: string) => raw<{ name: string; version_id: string | null }[]>`
  select name, price_book_item_version_id as version_id from public.invoice_line where invoice_id = ${invoiceId} order by sort_order`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Item Rates Co", slug: "commission-item-rates-co" });
  ray = await technician("Ray Nunez");
  dana = await technician("Dana Pike");
  const created = await customers.create(owner(), {
    type: "residential", name: "Halvorsen", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "40 Elm St", city: "Austin", state: "TX", postalCode: "78702", country: "US" } },
  });
  customerId = created.id as string;
  const [prop] = await raw<{ id: string }[]>`select id from public.property where organization_id = ${ORG}`;
  propertyId = prop!.id;

  heater = (await priceBook.create(owner(), { kind: "equipment", code: "WH-50", name: "Water heater, 50 gallon", price: "1000.00", taxable: false })).id;
  thermostat = (await priceBook.create(owner(), { kind: "material", code: "TSTAT", name: "Smart thermostat", price: "300.00", taxable: false })).id;
  haul = (await priceBook.create(owner(), { kind: "service", code: "HAUL", name: "Haul away the old tank", price: "200.00", taxable: false })).id;
  await priceBook.revise(owner(), { id: heater, commissionRate: "0.10" });
  await priceBook.revise(owner(), { id: thermostat, commissionRate: "0.05" });

  await commissions.declarePlan(owner(), {
    label: "Service, eight per cent", basis: "percent_of_revenue", rate: "0.08",
    note: "Eight per cent of what the job invoiced for, net of tax.",
  });
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  // Every test starts from a company that has not chosen.
  await raw`update public.organization set settings = settings - 'commission' where id = ${ORG}`;
});

run("the company's choice", () => {
  it("is the plan only until somebody chooses, and offers the four choices in words", async () => {
    const view = await commissions.itemRule(owner());
    expect(view.rule).toBe("plan_only");
    expect(view.rules.map((r) => r.rule)).toEqual(["plan_only", "item_wins", "higher", "item_adds"]);
    expect(view.rules[1]!.meaning).toBe("A line for an item with its own rate pays that rate instead of the plan. Every other line pays the plan.");
  });

  it("is set with commission:configure, and audited before and after", async () => {
    await expect(commissions.setItemRule(reader(), { rule: "item_wins" })).rejects.toThrow(PermissionError);
    expect((await commissions.itemRule(reader())).rule).toBe("plan_only");

    expect((await commissions.setItemRule(owner(), { rule: "item_wins" })).rule).toBe("item_wins");
    const [row] = await raw<{ before: unknown; after: unknown }[]>`
      select before, after from public.audit_log
      where organization_id = ${ORG} and action = 'commission_item_rule.set' order by created_at desc limit 1`;
    expect(row).toMatchObject({ before: { itemRule: "plan_only" }, after: { itemRule: "item_wins" } });

    // The same choice again changes nothing and is not audited twice.
    await commissions.setItemRule(owner(), { rule: "item_wins" });
    const [{ count }] = await raw<{ count: number }[]>`
      select count(*)::int as count from public.audit_log where organization_id = ${ORG} and action = 'commission_item_rule.set'
        and after->>'itemRule' = 'item_wins'`;
    expect(count).toBe(1);
  });

  it("refuses a choice that is not one of the four", async () => {
    await expect(commissions.setItemRule(owner(), { rule: "item_always" as never })).rejects.toThrow(ConflictError);
  });
});

run("from a paid invoice to the earning, under each choice", () => {
  it("pays the plan only by default, and reads no lines", async () => {
    const invoiceId = await paidInvoice();
    const earned = await commissions.settle(owner(), { invoiceId });
    expect(earned.total).toBe("120.0000");
    expect(earned.itemRule).toBe("plan_only");
    expect(earned.lines).toEqual([]);
    const [row] = await raw<{ item_rule: string; lines: unknown[] }[]>`select item_rule, lines from public.commission_event where id = ${earned.id}`;
    expect(row).toEqual({ item_rule: "plan_only", lines: [] });
  });

  it("pays the item's rate instead of the plan, and records which rate on which version", async () => {
    await commissions.setItemRule(owner(), { rule: "item_wins" });
    const invoiceId = await paidInvoice();
    const earned = await commissions.settle(owner(), { invoiceId });
    expect(earned.total).toBe("131.0000");
    expect(earned.itemRule).toBe("item_wins");

    const versions = await versionsOn(invoiceId);
    expect(earned.lines.map((l) => [l.label, l.priceBookItemVersionId, l.itemRate, l.planPart, l.itemPart, l.paid, l.source])).toEqual([
      ["Water heater, 50 gallon", versions[0]!.version_id, "0.100000", "80.0000", "100.0000", "100.0000", "item"],
      ["Smart thermostat", versions[1]!.version_id, "0.050000", "24.0000", "15.0000", "15.0000", "item"],
      ["Haul away the old tank", versions[2]!.version_id, null, "16.0000", null, "16.0000", "plan"],
    ]);

    // Kept on the earning, and said where the person paid reads it.
    const [row] = await raw<{ item_rule: string; lines: { paid: string }[] }[]>`select item_rule, lines from public.commission_event where id = ${earned.id}`;
    expect(row!.item_rule).toBe("item_wins");
    expect(row!.lines.map((l) => l.paid)).toEqual(["100.0000", "15.0000", "16.0000"]);
    expect(earned.parts[0]!.explanation).toContain("Water heater, 50 gallon: 10% of $1,000.00 is $100.00, paid instead of the plan's $80.00.");
    const register = await commissions.earnings(owner(), { technicianId: ray });
    const entry = register.entries.find((e) => e.invoiceId === invoiceId)!;
    expect(entry.itemRule).toBe("item_wins");
    expect(entry.amount).toBe("131.0000");
    expect(entry.explanation).toContain("instead of the plan");
  });

  it("pays whichever is more, line by line", async () => {
    await commissions.setItemRule(owner(), { rule: "higher" });
    const earned = await commissions.settle(owner(), { invoiceId: await paidInvoice() });
    expect(earned.total).toBe("140.0000");
    expect(earned.itemRule).toBe("higher");
    expect(earned.lines.map((l) => [l.paid, l.source])).toEqual([
      ["100.0000", "item"], ["24.0000", "plan"], ["16.0000", "plan"],
    ]);
    expect(earned.explanation).toContain("Smart thermostat: 5% of $300.00 is $15.00, less than the plan's $24.00, so the plan is paid.");
  });

  it("pays the item's rate on top of the plan, and posts what it pays", async () => {
    await commissions.setItemRule(owner(), { rule: "item_adds" });
    const earned = await commissions.settle(owner(), { invoiceId: await paidInvoice() });
    expect(earned.total).toBe("235.0000");
    expect(earned.lines.map((l) => [l.paid, l.source])).toEqual([
      ["180.0000", "plan_and_item"], ["39.0000", "plan_and_item"], ["16.0000", "plan"],
    ]);
    const [posted] = await raw<{ amount: string }[]>`
      select amount::text from public.ledger_entry where transaction_id = ${earned.ledgerTransactionId!} and direction = 'credit'`;
    expect(posted!.amount).toBe("235.0000");
  });

  it("reads the rate on the version the line was priced from, not the item's rate today", async () => {
    await commissions.setItemRule(owner(), { rule: "item_wins" });
    const invoiceId = await paidInvoice();
    const pricedFrom = (await versionsOn(invoiceId))[0]!.version_id;
    // The water heater's rate is doubled after it was sold.
    await priceBook.revise(owner(), { id: heater, commissionRate: "0.20" });
    const earned = await commissions.settle(owner(), { invoiceId });
    expect(earned.total).toBe("131.0000");
    expect(earned.lines[0]).toMatchObject({ priceBookItemVersionId: pricedFrom, itemRate: "0.100000", paid: "100.0000" });
    // And back, so the rest of the file sells at ten per cent.
    await priceBook.revise(owner(), { id: heater, commissionRate: "0.10" });
  });

  it("splits the resulting amount between the people who share it, the parts adding back exactly", async () => {
    await commissions.setItemRule(owner(), { rule: "item_wins" });
    const invoiceId = await paidInvoice([ray, dana]);
    const shown = await commissions.proposal(owner(), { invoiceId, shares: [{ technicianId: ray, weight: "2" }, { technicianId: dana, weight: "1" }] });
    expect(shown.itemRule).toBe("item_wins");
    expect(shown.itemRuleLabel).toBe("The item's rate, where it has one");
    expect(shown.total).toBe("131.0000");
    expect(shown.lines.map((l) => l.paid)).toEqual(["100.0000", "15.0000", "16.0000"]);

    await commissions.settleSplit(owner(), {
      invoiceId, shares: [{ technicianId: ray, weight: "2" }, { technicianId: dana, weight: "1" }], reason: "Ray sold the heater.",
    });
    const settled = (await commissions.proposal(owner(), { invoiceId })).settled!;
    expect(settled.total).toBe("131.0000");
    expect(settled.itemRule).toBe("item_wins");
    expect(settled.parts.map((p) => p.amount)).toEqual(["87.3400", "43.6600"]);
    expect(settled.explanation).toContain("Commission: $131.00.");
  });

  it("keeps the choice an earning was made under: a later change does not reprice it, and a reversal recomputes under it", async () => {
    await commissions.setItemRule(owner(), { rule: "item_wins" });
    const invoiceId = await paidInvoice();
    const earned = await commissions.settle(owner(), { invoiceId });
    expect(earned.total).toBe("131.0000");

    await commissions.setItemRule(owner(), { rule: "plan_only" });
    const [row] = await raw<{ total: string; item_rule: string }[]>`select total::text, item_rule from public.commission_event where id = ${earned.id}`;
    expect(row).toEqual({ total: "131.0000", item_rule: "item_wins" });

    // A fifth of the invoice credited: a fifth of 131.00 comes back, not a fifth of the plan's 120.00.
    const back = await commissions.reverse(owner(), {
      invoiceId, reason: "credit_note", creditedRevenue: "300.00",
      causeType: "credit_note.issued", causeId: fixtureId(`commission-item-rates:credit:${invoiceId}`),
    });
    expect(back.total).toBe("-26.2000");
  });
});
