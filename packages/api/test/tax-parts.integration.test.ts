import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as taxRates from "../src/services/tax";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import * as customers from "../src/services/customers";
import * as agreements from "../src/services/agreements";
import * as properties from "../src/services/properties";
import { UnprocessableError, ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A RATE WRITTEN DOWN IN PARTS, END TO END
 *
 * Austin's 8.25% entered as the state's 6.25%, Travis County's 1% and the
 * city's 1%. The customer is charged 8.25% exactly as before; the posting
 * owes each jurisdiction its share, to the cent; a void and a credit note
 * take each share back as it was posted; and the filing report reads tax
 * collected by part from the ledger, the state's share of two rates on one
 * row, and agrees with the total by rate.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("taxparts:org");
const OWNER = fixtureId("taxparts:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let austin = "", roundRock = "", flat = "";
let homeowner = "";

const taxEntries = (sourceType: string, sourceId: string) => raw<{ direction: string; amount: string; metadata: Record<string, string> }[]>`
  select direction, amount::text, metadata from public.ledger_entry
  where organization_id = ${ORG} and source_type = ${sourceType} and source_id = ${sourceId} and account_code = '2200'
  order by created_at, amount desc`;

async function balanced() {
  const [sums] = await raw<{ debits: string; credits: string }[]>`
    select coalesce(sum(case when direction = 'debit' then amount end), 0)::text as debits,
           coalesce(sum(case when direction = 'credit' then amount end), 0)::text as credits
    from public.ledger_entry where organization_id = ${ORG}`;
  expect(sums!.debits).toBe(sums!.credits);
}

const part = (lines: Array<{ name: string; price: string; taxRateId: string }>) => billing.create(owner(), {
  customerId: homeowner,
  lines: lines.map((l) => ({ name: l.name, quantity: "1", unitPrice: l.price, discountAmount: "0", taxable: true, taxRateId: l.taxRateId })),
} as Parameters<typeof billing.create>[1]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Rate Parts Co", slug: "rate-parts-co" });
  homeowner = (await customers.create(owner(), {
    type: "residential", name: "Ada Parts", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  } as Parameters<typeof customers.create>[1])).id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a rate written down in parts", () => {
  it("charges the sum of its parts and keeps the parts on the version", async () => {
    let view = await taxRates.create(owner(), {
      name: "Austin", effectiveFrom: "2020-01-01",
      parts: [{ name: "Texas", percent: "6.25" }, { name: "Travis County", percent: "1" }, { name: "City of Austin", percent: "1" }],
    });
    austin = view.rates.find((r) => r.name === "Austin")!.id;
    expect(view.rates.find((r) => r.id === austin)).toMatchObject({
      current: { rate: "0.0825", percent: "8.25" },
      versions: [{ parts: [
        { name: "Texas", rate: "0.0625", percent: "6.25" },
        { name: "Travis County", rate: "0.01", percent: "1" },
        { name: "City of Austin", rate: "0.01", percent: "1" },
      ] }],
    });

    view = await taxRates.create(owner(), {
      name: "Round Rock", percent: "8.25", effectiveFrom: "2020-01-01",
      parts: [{ name: "Texas", percent: "6.25" }, { name: "Williamson County", percent: "0.5" }, { name: "City of Round Rock", percent: "1.5" }],
    });
    roundRock = view.rates.find((r) => r.name === "Round Rock")!.id;
    view = await taxRates.create(owner(), { name: "Flat", percent: "7", effectiveFrom: "2020-01-01" });
    flat = view.rates.find((r) => r.name === "Flat")!.id;
    expect(view.rates.find((r) => r.id === flat)!.versions[0]!.parts).toEqual([]);

    /** The same request again is the same rate. */
    await taxRates.create(owner(), {
      name: "Austin", effectiveFrom: "2020-01-01",
      parts: [{ name: "Texas", percent: "6.25" }, { name: "Travis County", percent: "1" }, { name: "City of Austin", percent: "1" }],
    });
    expect((await taxRates.list(owner())).rates.filter((r) => r.name === "Austin")).toHaveLength(1);
  });

  it("refuses parts that do not add up to the whole rate given, and parts that are not a rate, in words", async () => {
    await expect(taxRates.create(owner(), {
      name: "Wrong", percent: "8.5", parts: [{ name: "Texas", percent: "6.25" }, { name: "County", percent: "2" }],
    })).rejects.toThrow(UnprocessableError);
    await expect(taxRates.create(owner(), {
      name: "Wrong", parts: [{ name: "Texas", percent: "6.25" }, { name: "texas", percent: "2" }],
    })).rejects.toMatchObject({ issues: [{ path: "parts", message: expect.stringContaining("two parts called") }] });
    await expect(taxRates.create(owner(), { name: "Wrong" })).rejects.toThrow(UnprocessableError);
    await expect(taxRates.addVersion(owner(), {
      id: austin, effectiveFrom: "2020-01-01", parts: [{ name: "Texas", percent: "6.25" }, { name: "Travis County", percent: "2" }],
    })).rejects.toThrow(ConflictError);
    expect((await taxRates.list(owner())).rates.some((r) => r.name === "Wrong")).toBe(false);
  });

  it("posts an invoice's tax one entry per part, to the cent, and charges the customer the same", async () => {
    const invoice = await part([{ name: "Tank", price: "1000.10", taxRateId: austin }]);
    expect(invoice.taxTotal).toBe("82.5100");
    const entries = await taxEntries("invoice", invoice.id);
    expect(entries.map((e) => [e.direction, e.amount, e.metadata["part"], e.metadata["partRate"]])).toEqual([
      ["credit", "62.5100", "Texas", "0.0625"],
      ["credit", "10.0000", "Travis County", "0.01"],
      ["credit", "10.0000", "City of Austin", "0.01"],
    ]);
    expect(entries.every((e) => e.metadata["taxRateId"] === austin && e.metadata["taxRate"] === "0.0825")).toBe(true);
    expect(entries.filter((e) => e.metadata["taxableBase"] !== undefined).map((e) => e.metadata["taxableBase"])).toEqual(["1000.1000"]);
    await balanced();
  });

  it("takes each part back on a void exactly as posted, and credits each part back in the invoice's own shares", async () => {
    const voided = await part([{ name: "A", price: "100.00", taxRateId: austin }]);
    await billing.voidInvoice(owner(), { id: voided.id, reason: "Raised twice" });
    expect((await taxEntries("void", voided.id)).map((e) => [e.direction, e.amount, e.metadata["part"]])).toEqual([
      ["debit", "6.2500", "Texas"], ["debit", "1.0000", "Travis County"], ["debit", "1.0000", "City of Austin"],
    ]);

    const credited = await part([{ name: "B", price: "40.00", taxRateId: austin }]);
    const [line] = await raw<{ id: string }[]>`select id from public.invoice_line where invoice_id = ${credited.id}`;
    const note = await creditNotes.create(owner(), {
      invoiceId: credited.id, reason: "billing_error", draft: false, apply: true,
      lines: [{ invoiceLineId: line!.id, quantity: "1", unitPrice: "13.00" }],
    } as Parameters<typeof creditNotes.create>[1]);
    const back = await taxEntries("credit_note", note.id as string);
    /** 13.00 at 8.25% is 1.07 back: the state 0.81, the county and the city 0.13 each. */
    expect(back.map((e) => [e.direction, e.amount, e.metadata["part"]])).toEqual([
      ["debit", "0.8100", "Texas"], ["debit", "0.1300", "Travis County"], ["debit", "0.1300", "City of Austin"],
    ]);
    await balanced();
  });

  it("files tax collected by part, the state's share of two rates on one row, adding up to the total", async () => {
    const today = companyToday();
    await part([{ name: "C", price: "200.00", taxRateId: roundRock }, { name: "D", price: "100.00", taxRateId: flat }]);
    const report = await taxRates.report(owner(), { from: today, to: today });

    const texas = report.byPart.find((r) => r.name === "Texas")!;
    /** Austin: 62.51, 6.25 less 6.25 voided, 2.50 less 0.81 credited; Round Rock: 12.50. */
    expect(texas).toMatchObject({ inParts: true, percent: "6.25", taxCollected: "76.7000" });
    expect(report.byPart.find((r) => r.name === "Williamson County")).toMatchObject({ taxCollected: "1.0000", taxableSales: "200.0000" });
    expect(report.byPart.find((r) => r.name === "Flat")).toMatchObject({ inParts: false, taxCollected: "7.0000" });

    const byPart = report.byPart.reduce((acc, r) => acc + Number(r.taxCollected), 0);
    expect(byPart.toFixed(4)).toBe(Number(report.totalCollected).toFixed(4));
    /** By rate, the sales are counted once however many parts the rate has. */
    expect(report.rows.find((r) => r.taxRateId === roundRock)).toMatchObject({ taxableSales: "200.0000", taxCollected: "16.5000" });
  });

  it("splits by the parts in force on the invoice's date when a county changes its share", async () => {
    const from = "2020-06-01";
    await taxRates.addVersion(owner(), {
      id: flat, effectiveFrom: from, parts: [{ name: "Texas", percent: "6.25" }, { name: "Flat County", percent: "0.75" }],
    });
    const invoice = await part([{ name: "E", price: "100.00", taxRateId: flat }]);
    expect((await taxEntries("invoice", invoice.id)).map((e) => [e.amount, e.metadata["part"]])).toEqual([
      ["6.2500", "Texas"], ["0.7500", "Flat County"],
    ]);
  });

  it("posts an agreement instalment through the same by rate posting, so it is never a row of its own", async () => {
    const property = await properties.create(owner(), {
      address: { line1: "1 Club Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: homeowner, customerRole: "owner",
    } as Parameters<typeof properties.create>[1]);
    const plan = await agreements.createPlan(owner(), {
      name: "Comfort Club", price: "228.00", billingFrequency: "monthly", termMonths: 12, includedVisitsPerTerm: 2,
    });
    const agreement = await agreements.sell(owner(), {
      planId: plan.id, customerId: homeowner, propertyId: property.id, startedOn: companyToday(),
    });
    const [instalment] = await raw<{ id: string }[]>`select id from public.agreement_billing
      where agreement_id = ${agreement.id} and invoice_id is null order by sequence limit 1`;
    const invoice = await agreements.bill(owner(), { agreementBillingId: instalment!.id });
    /** An instalment is not taxed, so nothing is owed to any rate, and the report has no row for it. */
    expect(await taxEntries("agreement_billing", invoice.id)).toEqual([]);
    const report = await taxRates.report(owner(), { from: companyToday(), to: companyToday() });
    expect(report.rows.some((r) => r.name === "Not recorded by rate")).toBe(false);
    await balanced();
  });
});
