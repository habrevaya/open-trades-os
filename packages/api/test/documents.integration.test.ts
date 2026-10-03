import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, PermissionError, type Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as portal from "../src/services/portal";
import * as documents from "../src/services/documents";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE FILES A CUSTOMER IS HANDED
 *
 * An invoice, a proposal and a statement as PDF, from the office's screens and
 * from the customer's own links. Every file is read back: a reader could open
 * it (the cross reference table holds together) and it says what the screen
 * says, to the cent. A customer's copy is never a draft and never somebody
 * else's, and it never carries the cost the office sees.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("docs:org");
const USER = fixtureId("docs:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);
const read = (file: documents.PdfFile) => pdf.inspectPdf(file.bytes, (b) => new Uint8Array(inflateSync(b)));

let customerId = "";
let otherCustomerId = "";
let propertyId = "";
let issuedId = "";
let draftId = "";
let othersId = "";
let estimateId = "";

const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lone Star Air", slug: "docs-lone-star" });
  await raw`update public.organization set brand_color = '#0f766e', timezone = 'America/Chicago' where id = ${ORG}`;
  const [c] = await raw`insert into public.customer (organization_id, name, email) values (${ORG}, 'Dana Ruiz', 'dana@docs.test') returning id`;
  customerId = c!.id;
  const [o] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Other Person') returning id`;
  otherCustomerId = o!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Lane', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;

  const issued = await billing.create(owner(), {
    customerId, issuedOn: today(),
    lines: [
      { name: "Capacitor replacement", quantity: "1", unitPrice: "189.00", unitCost: "24.00", discountAmount: "0", taxable: false },
      { name: "Service call", quantity: "1", unitPrice: "99.00", discountAmount: "0", taxable: false },
    ],
  });
  issuedId = issued.id as string;
  // The work's address, which an invoice takes from its job; this one has none, so it is set here.
  await raw`update public.invoice set property_id = ${propertyId} where id = ${issuedId}`;
  await billing.pay({ ...owner(), idempotencyKey: `docs-pay-${Date.now()}` }, {
    customerId, method: "cash", amount: "100.00", tipAmount: "0",
    allocations: [{ invoiceId: issuedId, amount: "100.00" }],
  });
  const draft = await billing.create(owner(), {
    customerId, draft: true,
    lines: [{ name: "Not sent yet", quantity: "1", unitPrice: "50.00", discountAmount: "0", taxable: false }],
  });
  draftId = draft.id as string;
  const others = await billing.create(owner(), {
    customerId: otherCustomerId, issuedOn: today(),
    lines: [{ name: "Someone else's work", quantity: "1", unitPrice: "75.00", discountAmount: "0", taxable: false }],
  });
  othersId = others.id as string;

  const estimate = await estimates.create(owner(), {
    customerId, propertyId, taxRate: "0", title: "Cooling for the summer",
    options: [
      { name: "Repair the motor", isRecommended: false, lines: [{ name: "Fan motor", quantity: "1", unitPrice: "680.00", unitCost: "290.00", discountAmount: "0", taxable: true, isOptional: false, isSelected: false }] },
      { name: "New condenser", isRecommended: true, lines: [{ name: "Condenser", quantity: "1", unitPrice: "3400.00", unitCost: "1980.00", discountAmount: "0", taxable: true, isOptional: false, isSelected: false }] },
    ],
  });
  estimateId = estimate.id as string;
});

afterAll(async () => { if (raw) await raw.end(); });

async function grant(scope: "invoice" | "estimate" | "customer", subjectId: string | null, customer = customerId) {
  const issued = await portal.issueGrant(owner(), {
    customerId: customer, scope, ...(subjectId ? { subjectId } : {}), expiresInDays: 30,
  });
  return issued.url.split("/").pop()!;
}

run("an invoice as a PDF", () => {
  it("prints the office's copy with its lines, total, payment and balance", async () => {
    const file = await documents.invoicePdf(owner(), { id: issuedId });
    const doc = read(file);
    expect(doc.problems).toEqual([]);
    expect(file.filename).toMatch(/^invoice-\d+\.pdf$/);
    expect(doc.text).toContain("Lone Star Air");
    expect(doc.text).toContain("Dana Ruiz");
    expect(doc.text).toContain("4 Lane, Austin, TX 78704");
    expect(doc.text).toContain("Capacitor replacement");
    expect(doc.text).toContain("$288.00");
    expect(doc.text).toContain("Balance due");
    expect(doc.text).toContain("$188.00");
    expect(doc.text).toContain("Cash");
    // The cost the office sees is not on paper a customer is handed.
    expect(doc.text).not.toContain("$24.00");
  });

  it("prints the customer's copy from the invoice link, the same numbers", async () => {
    const token = await grant("invoice", issuedId);
    const file = await documents.invoicePdfForToken(db(), { token });
    const doc = read(file);
    expect(doc.problems).toEqual([]);
    expect(doc.text).toContain("$188.00");
  });

  it("gives a customer their own invoices from their account link, and never a draft or somebody else's", async () => {
    const token = await grant("customer", null);
    expect(read(await documents.invoicePdfForAccount(db(), { token, invoiceId: issuedId })).problems).toEqual([]);
    await expect(documents.invoicePdfForAccount(db(), { token, invoiceId: draftId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(documents.invoicePdfForAccount(db(), { token, invoiceId: othersId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses an invoice link used for an estimate, and somebody who may not read invoices", async () => {
    const token = await grant("estimate", estimateId);
    await expect(documents.invoicePdfForToken(db(), { token })).rejects.toThrow();
    await expect(documents.invoicePdf(as(["marketing"] as Actor["roles"]), { id: issuedId }))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("is not found for somebody whose scope does not reach the invoice, as the invoice list treats it", async () => {
    /** A technician sees invoices on their own work; this one is on no job at all. */
    await expect(documents.invoicePdf(as(["technician"]), { id: issuedId })).rejects.toBeInstanceOf(NotFoundError);
  });
});

run("a proposal as a PDF", () => {
  it("prints every option with its total, from the office and from the customer's link", async () => {
    const office = read(await documents.proposalPdf(owner(), { id: estimateId }));
    expect(office.problems).toEqual([]);
    expect(office.text).toContain("Cooling for the summer");
    expect(office.text).toContain("New condenser (recommended)");
    expect(office.text).toContain("$3,400.00");
    expect(office.text).toContain("Repair the motor");
    expect(office.text).not.toContain("$1,980.00");

    const token = await grant("estimate", estimateId);
    const customer = read(await documents.proposalPdfForToken(db(), { token }));
    expect(customer.problems).toEqual([]);
    expect(customer.text).toContain("$3,400.00");
  });
});

run("a statement as a PDF", () => {
  it("prints the period, the running balance and what is owed, from the office and the account link", async () => {
    const office = read(await documents.statementPdf(owner(), { id: customerId }));
    expect(office.problems).toEqual([]);
    expect(office.text).toContain("Statement");
    expect(office.text).toContain("Dana Ruiz");
    expect(office.text).toContain("Owed on invoices");
    // 288 issued, 100 paid; the draft is not owed.
    expect(office.text).toContain("$188.00");

    const token = await grant("customer", null);
    const customer = read(await documents.statementPdfForToken(db(), { token }));
    expect(customer.problems).toEqual([]);
    expect(customer.text).toContain("$188.00");
  });
});
