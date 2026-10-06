import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { field, type Actor } from "@opentradesos/core";
import * as taxRates from "../src/services/tax";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as estimates from "../src/services/estimates";
import * as jobBilling from "../src/services/job-billing";
import * as commercial from "../src/services/commercial";
import * as priceBook from "../src/services/pricebook";
import * as setup from "../src/services/setup";
import * as fieldOps from "../src/services/field";
import * as dispatchSvc from "../src/services/dispatch";
import { createTaxProvider, registeredTaxProviders } from "../src/tax";
import { ConflictError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * SALES TAX FROM THE COMPANY'S OWN RATES, END TO END
 *
 * The rates a company sets up, the rate each sale is charged from them, and
 * where the money goes: every invoice's tax is the sum of its lines, every
 * posting balances with sales tax payable one entry per rate, and the filing
 * report read from the ledger says the same thing the invoices do.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tax:org");
const OWNER = fixtureId("tax:owner");
const RAY = fixtureId("tax:ray");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const office = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["office_manager"] as Actor["roles"] }, db: db(),
});

let travis = "", roundRock = "", stateOnly = "";
let rayTech = "";
let homeowner = "", home = "", districtHome = "";
let part = "", labour = "";

const person = (name: string, extra: Record<string, unknown> = {}) => customers.create(owner(), {
  type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {}, ...extra,
} as Parameters<typeof customers.create>[1]);
const place = (line1: string, customerId: string, extra: Record<string, unknown> = {}) => properties.create(owner(), {
  address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
  hasDog: false, customFields: {}, customerId, customerRole: "owner", ...extra,
} as Parameters<typeof properties.create>[1]);

/** A job on an address with work recorded on it, not yet billed. */
async function jobWith(customerId: string, propertyId: string, lines: Array<{ name: string; kind: string; price: string; taxable: boolean }>) {
  const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e7)}, ${customerId}, ${propertyId}, 'completed', 'Repair') returning id`;
  const ids: string[] = [];
  for (const line of lines) {
    const [row] = await raw`insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, taxable)
      values (${ORG}, ${job!.id}, ${line.kind}::job_line_kind, ${line.name}, 1, ${line.price}, ${line.taxable}) returning id`;
    ids.push(row!.id as string);
  }
  return { jobId: job!.id as string, lineIds: ids };
}

const invoiceLines = (id: string) => raw<{ tax_rate: string; tax_amount: string; tax_rate_id: string | null; tax_source: string | null; taxable: boolean }[]>`
  select tax_rate::text, tax_amount::text, tax_rate_id, tax_source, taxable from public.invoice_line
  where invoice_id = ${id} order by sort_order`;

/** The invoice's tax is its lines' tax, to the cent. */
async function linesAddUp(id: string) {
  const [row] = await raw<{ total: string; lines: string }[]>`
    select i.tax_total::text as total, (select coalesce(sum(tax_amount), 0)::numeric(14,4)::text from public.invoice_line l where l.invoice_id = i.id) as lines
    from public.invoice i where i.id = ${id}`;
  expect(row!.lines).toBe(row!.total);
}

/** Sales tax payable on one document's posting, entry by entry. */
const taxEntries = (sourceType: string, sourceId: string) => raw<{ direction: string; amount: string; metadata: Record<string, string> }[]>`
  select direction, amount::text, metadata from public.ledger_entry
  where organization_id = ${ORG} and source_type = ${sourceType} and source_id = ${sourceId} and account_code = '2200'
  order by amount desc`;

async function balanced() {
  const [sums] = await raw<{ debits: string; credits: string }[]>`
    select coalesce(sum(case when direction = 'debit' then amount end), 0)::text as debits,
           coalesce(sum(case when direction = 'credit' then amount end), 0)::text as credits
    from public.ledger_entry where organization_id = ${ORG}`;
  expect(sums!.debits).toBe(sums!.credits);
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Tax Table Co", slug: "tax-table-co" });

  part = (await priceBook.create(owner(), { kind: "material", code: "TANK", name: "Expansion tank", price: "180.00" } as Parameters<typeof priceBook.create>[1])).id;
  labour = (await priceBook.create(owner(), { kind: "labor", code: "HOUR", name: "Labour, per hour", price: "120.00" } as Parameters<typeof priceBook.create>[1])).id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("the rates a company sets up", () => {
  it("makes the first rate the usual one, versions a change by its day, and audits each", async () => {
    let view = await taxRates.create(owner(), { name: "Travis County", percent: "8.25", effectiveFrom: "2020-01-01" });
    travis = view.rates.find((r) => r.name === "Travis County")!.id;
    expect(view.defaultTaxRateId).toBe(travis);
    expect(view.rates[0]).toMatchObject({ isDefault: true, current: { rate: "0.0825", percent: "8.25", effectiveFrom: "2020-01-01" } });

    view = await taxRates.create(owner(), { name: "Round Rock", percent: "8.25", effectiveFrom: "2020-01-01" });
    roundRock = view.rates.find((r) => r.name === "Round Rock")!.id;
    view = await taxRates.create(owner(), { name: "State only", percent: "6.25", effectiveFrom: "2020-01-01" });
    stateOnly = view.rates.find((r) => r.name === "State only")!.id;
    expect(view.defaultTaxRateId).toBe(travis);

    view = await taxRates.addVersion(owner(), { id: roundRock, percent: "8.5", effectiveFrom: companyToday(30) });
    const rr = view.rates.find((r) => r.id === roundRock)!;
    expect(rr.current?.percent).toBe("8.25");
    expect(rr.versions.map((v) => [v.percent, v.state])).toEqual([["8.25", "current"], ["8.5", "scheduled"]]);

    const [audited] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action like 'tax.%'`;
    expect(audited!.n).toBeGreaterThanOrEqual(5);
  });

  it("refuses a second rate by the same name and a second percentage on one day, and takes the same request twice", async () => {
    await expect(taxRates.create(owner(), { name: "travis county", percent: "7", effectiveFrom: "2020-01-01" }))
      .rejects.toThrow("There is already a rate called Travis County");
    const again = await taxRates.create(owner(), { name: "Travis County", percent: "8.25", effectiveFrom: "2020-01-01" });
    expect(again.rates.filter((r) => r.name === "Travis County")).toHaveLength(1);
    await expect(taxRates.addVersion(owner(), { id: roundRock, percent: "9", effectiveFrom: companyToday(30) }))
      .rejects.toThrow("already has a percentage from");
    await expect(taxRates.create(owner(), { name: "Typo", percent: "825" })).rejects.toBeInstanceOf(UnprocessableError);
  });

  it("will not retire the usual rate, and needs settings to change any of it", async () => {
    await expect(taxRates.retire(owner(), { id: travis })).rejects.toBeInstanceOf(ConflictError);
    await expect(taxRates.create(office(), { name: "Office tries", percent: "1" })).rejects.toThrow();
    expect((await taxRates.list(office())).rates.length).toBeGreaterThanOrEqual(3);
  });

  it("answers through the provider seam, whose only provider is the company's own table", async () => {
    expect(registeredTaxProviders()).toEqual(["table"]);
    const table = await db().transaction((tx) => taxRates.tableWithin(tx as never, ORG));
    const answer = await createTaxProvider("table", { table }).rateFor({
      on: "2026-01-15",
      party: { exemption: { exempt: false, certificate: null, expiresOn: null }, customerRateId: null, addressRateId: stateOnly },
      address: null,
    });
    expect(answer).toMatchObject({ taxRateId: stateOnly, rate: "0.0625", source: "address" });
  });
});

run("what is taxable", () => {
  it("defaults a labour item to untaxed and a part to taxed, and a shelf's answer to items added to it", async () => {
    const [item] = await raw`select v.taxable from public.price_book_item_version v where v.item_id = ${labour}`;
    expect(item!.taxable).toBe(false);
    const [taxedPart] = await raw`select v.taxable from public.price_book_item_version v where v.item_id = ${part}`;
    expect(taxedPart!.taxable).toBe(true);

    const [shelf] = await raw`insert into public.price_book_category (organization_id, name) values (${ORG}, 'Service calls') returning id`;
    const call = await priceBook.create(owner(), { kind: "service", code: "CALL", name: "Service call", price: "89.00", categoryId: shelf!.id } as Parameters<typeof priceBook.create>[1]);
    await setup.setItemTax(owner(), { itemIds: [call.id], taxable: false, taxClass: "service", categoryId: shelf!.id as string });
    const [after] = await raw`select taxable from public.price_book_category where id = ${shelf!.id}`;
    expect(after!.taxable).toBe(false);
    const later = await priceBook.create(owner(), { kind: "service", code: "CALL2", name: "After hours call", price: "149.00", categoryId: shelf!.id } as Parameters<typeof priceBook.create>[1]);
    const [laterVersion] = await raw`select taxable from public.price_book_item_version where item_id = ${later.id}`;
    expect(laterVersion!.taxable).toBe(false);
  });
});

run("an invoice raised in the office", () => {
  beforeAll(async () => {
    if (!url) return;
    homeowner = (await person("Hana Homeowner")).id;
    home = (await place("12 Elm St", homeowner)).id;
    districtHome = (await place("9 Mill Rd", homeowner, { taxRateId: stateOnly })).id;
  });

  it("charges the usual rate on the taxable lines only, and the lines add up to the tax", async () => {
    const { jobId } = await jobWith(homeowner, home, []);
    const invoice = await billing.create(owner(), {
      customerId: homeowner, jobId,
      lines: [
        { priceBookItemId: part, name: "Tank", quantity: "3", unitPrice: "0", discountAmount: "0", taxable: true },
        { priceBookItemId: labour, name: "Labour", quantity: "1.5", unitPrice: "0", discountAmount: "0", taxable: true },
        { name: "Fittings", quantity: "1", unitPrice: "10.05", discountAmount: "0", taxable: true },
        { name: "Valve", quantity: "1", unitPrice: "10.05", discountAmount: "0", taxable: true },
      ],
    } as Parameters<typeof billing.create>[1]);
    const lines = await invoiceLines(invoice.id);
    expect(lines.map((l) => [l.tax_rate, l.tax_rate_id, l.tax_source])).toEqual([
      ["0.082500", travis, "default"],
      ["0.000000", null, null],
      ["0.082500", travis, "default"],
      ["0.082500", travis, "default"],
    ]);
    // 540 + 10.05 + 10.05 at 8.25% is 46.20825, rounded once to 46.21.
    expect(invoice.taxTotal).toBe("46.2100");
    await linesAddUp(invoice.id);
    const entries = await taxEntries("invoice", invoice.id);
    expect(entries).toEqual([{ direction: "credit", amount: "46.2100", metadata: { taxRateId: travis, taxRate: "0.0825", taxableBase: "560.1000" } }]);
    await balanced();
  });

  it("charges the address's rate over the customer's, and the customer's where the address names none", async () => {
    await customers.update(owner(), { id: homeowner, taxRateId: roundRock });
    const atDistrict = await jobWith(homeowner, districtHome, []);
    const district = await billing.create(owner(), {
      customerId: homeowner, jobId: atDistrict.jobId,
      lines: [{ name: "Part", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true }],
    } as Parameters<typeof billing.create>[1]);
    expect((await invoiceLines(district.id))[0]).toMatchObject({ tax_rate_id: stateOnly, tax_source: "address" });
    expect(district.taxTotal).toBe("6.2500");

    const atHome = await jobWith(homeowner, home, []);
    const own = await billing.create(owner(), {
      customerId: homeowner, jobId: atHome.jobId,
      lines: [{ name: "Part", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true }],
    } as Parameters<typeof billing.create>[1]);
    expect((await invoiceLines(own.id))[0]).toMatchObject({ tax_rate_id: roundRock, tax_source: "customer" });
    await customers.update(owner(), { id: homeowner, taxRateId: null });
  });

  it("charges an exempt customer nothing while the certificate is good, and taxes them once it lapses", async () => {
    const school = await person("Elm Street School", {
      taxExempt: true, taxExemptCertificate: "TX-01-339", taxExemptExpiresOn: companyToday(60),
    });
    const line = [{ name: "Part", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true }];
    const exempt = await billing.create(owner(), { customerId: school.id, lines: line } as Parameters<typeof billing.create>[1]);
    expect(exempt.taxTotal).toBe("0.0000");
    expect((await invoiceLines(exempt.id))[0]).toMatchObject({ tax_source: "exempt", taxable: true });

    await customers.update(owner(), { id: school.id, taxExemptExpiresOn: companyToday(-1) });
    const lapsed = await billing.create(owner(), { customerId: school.id, lines: line } as Parameters<typeof billing.create>[1]);
    expect(lapsed.taxTotal).toBe("8.2500");
  });

  it("lets the office choose another rate, or none, for the invoice or a line", async () => {
    const lines = [
      { name: "A", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true },
      { name: "B", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true, taxRateId: stateOnly },
    ];
    const mixed = await billing.create(owner(), { customerId: homeowner, taxRateId: roundRock, lines } as Parameters<typeof billing.create>[1]);
    expect((await invoiceLines(mixed.id)).map((l) => [l.tax_rate_id, l.tax_source])).toEqual([[roundRock, "chosen"], [stateOnly, "chosen"]]);
    expect(mixed.taxTotal).toBe("14.5000");
    expect((await taxEntries("invoice", mixed.id)).map((e) => [e.amount, e.metadata["taxRateId"]])).toEqual([
      ["8.2500", roundRock], ["6.2500", stateOnly],
    ]);
    await linesAddUp(mixed.id);

    const none = await billing.create(owner(), { customerId: homeowner, taxRateId: null, lines: [lines[0]!] } as Parameters<typeof billing.create>[1]);
    expect(none.taxTotal).toBe("0.0000");

    await expect(billing.create(owner(), {
      customerId: homeowner, lines: [{ ...lines[0]!, taxRateId: fixtureId("tax:nope") }],
    } as Parameters<typeof billing.create>[1])).rejects.toBeInstanceOf(UnprocessableError);
    await balanced();
  });

  it("takes several rates back off one by one when the invoice is voided, and a credit note by its lines' rates", async () => {
    const invoice = await billing.create(owner(), {
      customerId: homeowner,
      lines: [
        { name: "A", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true, taxRateId: roundRock },
        { name: "B", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true, taxRateId: stateOnly },
      ],
    } as Parameters<typeof billing.create>[1]);
    const credited = await billing.create(owner(), {
      customerId: homeowner,
      lines: [
        { name: "C", quantity: "1", unitPrice: "40.00", discountAmount: "0", taxable: true, taxRateId: roundRock },
        { name: "D", quantity: "1", unitPrice: "40.00", discountAmount: "0", taxable: true, taxRateId: stateOnly },
      ],
    } as Parameters<typeof billing.create>[1]);

    await billing.voidInvoice(owner(), { id: invoice.id, reason: "Raised twice" });
    expect((await taxEntries("void", invoice.id)).map((e) => [e.direction, e.amount, e.metadata["taxRateId"]])).toEqual([
      ["debit", "8.2500", roundRock], ["debit", "6.2500", stateOnly],
    ]);

    const sourceLines = await raw<{ id: string }[]>`select id from public.invoice_line where invoice_id = ${credited.id} order by sort_order`;
    const note = await creditNotes.create(owner(), {
      invoiceId: credited.id, reason: "billing_error", draft: false, apply: true,
      lines: sourceLines.map((l) => ({ invoiceLineId: l.id, quantity: "1", unitPrice: "40.00" })),
    } as Parameters<typeof creditNotes.create>[1]);
    expect((await taxEntries("credit_note", note.id as string)).map((e) => [e.direction, e.amount, e.metadata["taxRateId"]])).toEqual([
      ["debit", "3.3000", roundRock], ["debit", "2.5000", stateOnly],
    ]);
    await creditNotes.voidNote(owner(), { id: note.id as string, reason: "Wrong one" }).catch(() => undefined);
    await balanced();
  });
});

run("a draft, priced on one day and issued on another", () => {
  it("refuses to issue at a rate no longer in force, and issues once the draft is saved again", async () => {
    const customer = await person("Drafted Customer");
    const lines = [{ name: "Part", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: true }];
    const draft = await billing.create(owner(), { customerId: customer.id, draft: true, lines } as Parameters<typeof billing.create>[1]);
    expect(draft.taxTotal).toBe("16.5000");

    // The county raises its rate from today, after the draft was written.
    await taxRates.addVersion(owner(), { id: travis, percent: "8.5", effectiveFrom: companyToday() });
    await expect(billing.issue(owner(), { id: draft.id })).rejects.toThrow("has changed since it was written");

    const saved = await billing.updateDraft(owner(), { id: draft.id, lines } as Parameters<typeof billing.updateDraft>[1]);
    expect(saved.taxTotal).toBe("17.0000");
    const issued = await billing.issue(owner(), { id: draft.id });
    expect(issued.status).toBe("open");
    expect((await taxEntries("invoice", draft.id))[0]).toMatchObject({ amount: "17.0000", metadata: { taxRate: "0.085" } });
  });

  it("lets the office change the rate on a draft, and keeps a chosen rate at issue", async () => {
    const customer = await person("Chosen Customer");
    const lines = [{ name: "Part", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true }];
    const draft = await billing.create(owner(), { customerId: customer.id, draft: true, lines } as Parameters<typeof billing.create>[1]);
    await expect(billing.updateDraft(owner(), { id: draft.id, taxRateId: stateOnly } as Parameters<typeof billing.updateDraft>[1]))
      .rejects.toBeInstanceOf(UnprocessableError);
    const changed = await billing.updateDraft(owner(), { id: draft.id, taxRateId: stateOnly, lines } as Parameters<typeof billing.updateDraft>[1]);
    expect(changed.taxTotal).toBe("6.2500");
    expect((await billing.issue(owner(), { id: draft.id })).status).toBe("open");
  });
});

run("an estimate", () => {
  it("takes the usual rate, carries it onto the invoice as signed, and the invoice's lines add up", async () => {
    const customer = await person("Estimate Customer");
    const property = await place("4 Oak Ln", customer.id);
    const written = await estimates.create(owner(), {
      customerId: customer.id, propertyId: property.id,
      options: [{
        name: "Replace", isRecommended: true,
        lines: [
          { name: "Fitting", quantity: "1", unitPrice: "10.05", discountAmount: "0", taxable: true, isOptional: false, isSelected: false },
          { name: "Valve", quantity: "1", unitPrice: "10.05", discountAmount: "0", taxable: true, isOptional: false, isSelected: false },
          { name: "Surge guard", quantity: "1", unitPrice: "10.05", discountAmount: "0", taxable: true, isOptional: true, isSelected: false },
        ],
      }],
    } as Parameters<typeof estimates.create>[1]);
    const [line] = await raw`select tax_rate::text, tax_rate_id, tax_source from public.estimate_line l
      join public.estimate_option o on o.id = l.option_id where o.estimate_id = ${written.id} order by l.sort_order limit 1`;
    expect(line).toEqual({ tax_rate: "0.085000", tax_rate_id: travis, tax_source: "default" });

    const [option] = await raw<{ id: string }[]>`select id from public.estimate_option where estimate_id = ${written.id}`;
    await estimates.approve(owner(), { id: written.id, optionId: option!.id, selectedLineIds: [], signerName: "E C", capturedVia: "phone" } as Parameters<typeof estimates.approve>[1]);
    const converted = await estimates.convert(owner(), { id: written.id, createJob: false, createInvoice: true } as Parameters<typeof estimates.convert>[1]);
    const lines = await invoiceLines(converted.invoiceId as string);
    expect(lines.every((l) => l.tax_source === "estimate" && l.tax_rate_id === travis)).toBe(true);
    await linesAddUp(converted.invoiceId as string);
    expect((await billing.issue(owner(), { id: converted.invoiceId as string })).status).toBe("open");
    await balanced();
  });

  it("records a typed rate as the company's rate it matches", async () => {
    const customer = await person("Typed Customer");
    const property = await place("6 Oak Ln", customer.id);
    const written = await estimates.create(owner(), {
      customerId: customer.id, propertyId: property.id, taxRate: "0.0625",
      options: [{ name: "Fix", isRecommended: true, lines: [
        { name: "Part", quantity: "1", unitPrice: "50.00", discountAmount: "0", taxable: true, isOptional: false, isSelected: false },
      ] }],
    } as Parameters<typeof estimates.create>[1]);
    const [line] = await raw`select tax_rate_id, tax_source from public.estimate_line l
      join public.estimate_option o on o.id = l.option_id where o.estimate_id = ${written.id}`;
    expect(line).toEqual({ tax_rate_id: stateOnly, tax_source: "chosen" });
  });
});

run("a job billed in parts, each line at its own rate", () => {
  it("taxes each payer's part of each line at that line's rate, and the invoices' tax adds up to the job's", async () => {
    const tenant = await person("Tom Tenant");
    const landlord = await person("Lakeside Owners");
    const flat = await place("22 Lake Dr", tenant.id);
    const { jobId, lineIds } = await jobWith(tenant.id, flat.id, [
      { name: "Heater element", kind: "part", price: "210.05", taxable: true },
      { name: "Thermostat", kind: "part", price: "89.99", taxable: true },
      { name: "Labour", kind: "labor", price: "150.00", taxable: false },
    ]);
    await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: landlord.id, sharePercent: "0.7" }] });

    const lineRates = [`line:${lineIds[1]}=${stateOnly}`];
    const plan = await jobBilling.preview(owner(), { jobId, lineRates });
    expect(plan.problems).toEqual([]);
    expect(plan.lines.map((l) => [l.taxRateId, l.taxSource])).toEqual([[travis, "default"], [stateOnly, "chosen"], [null, null]]);
    expect(plan.tax.choices.map((c) => c.id)).toEqual(expect.arrayContaining([travis, roundRock, stateOnly]));

    const result = await jobBilling.bill(owner(), { jobId, lineRates });
    const taxes = await raw<{ id: string; tax_total: string }[]>`select id, tax_total::text from public.invoice where job_id = ${jobId}`;
    const sum = taxes.reduce((acc, t) => acc + Math.round(Number(t.tax_total) * 100), 0);
    expect(sum).toBe(Math.round(Number(result.taxTotal) * 100));
    // 210.05 at 8.5% and 89.99 at 6.25%: 17.854250 + 5.624375 = 23.478625, rounded once.
    expect(result.taxTotal).toBe("23.4800");
    for (const t of taxes) {
      await linesAddUp(t.id);
      const rates = new Set((await taxEntries("invoice", t.id)).map((e) => e.metadata["taxRateId"]));
      expect(rates).toEqual(new Set([travis, stateOnly]));
    }
    await balanced();
  });
});

run("an invoice raised on site", () => {
  it("is taxed at the visit's rate, which the day carries to the phone, and matches the office's", async () => {
    await raw`delete from public."user" where id = ${RAY} or email = 'ray@tax.test'`;
    await raw`insert into public."user" (id, email, name) values (${RAY}, 'ray@tax.test', 'Ray Tech')`;
    const [membership] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${RAY}, 'technician') returning id`;
    const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${membership!.id}, 'Ray Tech') returning id`;
    rayTech = tech!.id as string;
    const ray = (): ServiceContext => ({ actor: { userId: RAY, organizationId: ORG, roles: ["technician"], technicianId: rayTech }, db: db() });

    const customer = await person("Phone Customer");
    const property = await place("1 Phone Way", customer.id);
    const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e7)}, ${customer.id}, ${property.id}, 'scheduled', 'Leak') returning id`;
    const [visit] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'working', now(), now() + interval '2 hours') returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visit!.id}, ${rayTech})`;

    const device = await fieldOps.register(ray(), { installationId: `phone-${crypto.randomUUID()}` });
    const day = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 2 });
    const mine = day.visits.find((v) => v.id === visit!.id)!;
    expect(mine.tax).toMatchObject({ rate: "0.085", percent: "8.5", label: "Travis County 8.5%", source: "default" });

    const partLine = crypto.randomUUID();
    const labourLine = crypto.randomUUID();
    const shown = field.priceOnSite([
      { quantity: "1", unitPrice: "180.00", taxable: true, taxRate: mine.tax.rate },
      { quantity: "1", unitPrice: "120.00", taxable: false, taxRate: mine.tax.rate },
    ]).totals.total;
    const invoiceId = crypto.randomUUID();
    const result = await fieldOps.sync(ray(), {
      deviceId: device.deviceId,
      operations: [
        { kind: "visit.add_line", subjectId: visit!.id, payload: { lineId: partLine, kind: "part", name: "Tank", quantity: "1", unitPrice: "180.0000" } },
        // Labour recorded with nothing said about tax is not taxed.
        { kind: "visit.add_line", subjectId: visit!.id, payload: { lineId: labourLine, kind: "labor", name: "Labour", quantity: "1", unitPrice: "120.0000" } },
        { kind: "invoice.raise", subjectId: invoiceId, payload: { visitId: visit!.id, source: "work", jobLineIds: [partLine, labourLine], shownTotal: shown } },
      ].map((op, i) => ({ ...op, clientId: crypto.randomUUID(), sequence: i + 1, occurredAt: new Date(Date.now() - (3 - i) * 60_000).toISOString() })),
    } as Parameters<typeof fieldOps.sync>[1]);
    expect(result.results.map((r) => [r.status, r.rejection])).toEqual(Array(3).fill(["applied", null]));
    const [onSite] = await raw`select status, tax_total::text, total::text from public.invoice where id = ${invoiceId}`;
    expect(onSite).toEqual({ status: "open", tax_total: "15.3000", total: shown });
    await linesAddUp(invoiceId);
    await balanced();
  });
});

run("sales tax collected by rate", () => {
  it("reads every rate's sales and tax from the ledger, net of voids and credits, and reconciles to the account", async () => {
    const report = await taxRates.report(owner(), { from: companyToday(-1), to: companyToday() });
    const [account] = await raw<{ movement: string }[]>`
      select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::numeric(14,4)::text as movement
      from public.ledger_entry where organization_id = ${ORG} and account_code = '2200'`;
    expect(report.accountMovement).toBe(account!.movement);
    expect(report.totalCollected).toBe(account!.movement);
    const byName = Object.fromEntries(report.rows.map((r) => [`${r.name} ${r.percent}`, r]));
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(["Travis County 8.25", "Travis County 8.5", "State only 6.25", "Round Rock 8.25"]));
    // Every rate's tax is the sum of what the open invoices charged at it, read from their lines.
    const [lines] = await raw<{ tax: string }[]>`
      select coalesce(sum(l.tax_amount), 0)::numeric(14,4)::text as tax from public.invoice_line l
      join public.invoice i on i.id = l.invoice_id
      where i.organization_id = ${ORG} and i.status <> 'void' and i.status <> 'draft' and l.tax_rate_id = ${stateOnly}`;
    const [credits] = await raw<{ tax: string }[]>`
      select coalesce(sum(c.tax_amount), 0)::numeric(14,4)::text as tax from public.credit_note_line c
      join public.invoice_line l on l.id = c.invoice_line_id join public.credit_note n on n.id = c.credit_note_id
      where n.organization_id = ${ORG} and n.status <> 'void' and l.tax_rate_id = ${stateOnly}`;
    expect(Number(byName["State only 6.25"]!.taxCollected)).toBeCloseTo(Number(lines!.tax) - Number(credits!.tax), 4);
    await expect(taxRates.report(office(), { from: companyToday(), to: companyToday() })).rejects.toThrow();
  });

  it("charges nothing anywhere once the company says it charges no sales tax", async () => {
    await taxRates.updateSettings(owner(), { chargesTax: false });
    const invoice = await billing.create(owner(), {
      customerId: homeowner, lines: [{ name: "Part", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: true }],
    } as Parameters<typeof billing.create>[1]);
    expect(invoice.taxTotal).toBe("0.0000");
    expect((await invoiceLines(invoice.id))[0]).toMatchObject({ tax_source: "off" });
    await taxRates.updateSettings(owner(), { chargesTax: true });
  });
});
