import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, type Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as portal from "../src/services/portal";
import * as documents from "../src/services/documents";
import * as proposals from "../src/services/proposals";
import * as setup from "../src/services/setup";
import * as statements from "../src/services/statements";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * HOW A CUSTOMER REACHES THE COMPANY, ON EVERYTHING IT HANDS THEM
 *
 * The company record had no phone, email or address, so the proposal, the
 * invoice, the statement and their PDFs went out with no way to call anybody.
 * This sets them once, through the same call the settings screen and the
 * setup wizard make, and reads them back off every document a customer is
 * handed: the proposal and statement as the screens draw them, all three
 * PDFs, and the portal header's branding read.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("contact:org");
const USER = fixtureId("contact:owner");
const BARE = fixtureId("contact:bare-org");
const BARE_USER = fixtureId("contact:bare-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (organizationId: string, userId: string, roles: Actor["roles"] = ["owner"]): ServiceContext =>
  ({ actor: { userId, organizationId, roles }, db: db() });
const owner = () => as(ORG, USER);
const read = (file: documents.PdfFile) => pdf.inspectPdf(file.bytes, (b) => new Uint8Array(inflateSync(b)));

let customerId = "";
let invoiceId = "";
let estimateId = "";
let bareInvoiceId = "";

async function seedWork(organizationId: string, userId: string) {
  const ctx = as(organizationId, userId);
  const [c] = await raw`insert into public.customer (organization_id, name) values (${organizationId}, 'Dana Ruiz') returning id`;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${organizationId}, '4 Lane', 'Austin', 'TX', '78704') returning id`;
  const invoice = await billing.create(ctx, {
    customerId: c!.id, issuedOn: companyToday(),
    lines: [{ name: "Service call", quantity: "1", unitPrice: "99.00", discountAmount: "0", taxable: false }],
  });
  const estimate = await estimates.create(ctx, {
    customerId: c!.id, propertyId: p!.id, taxRate: "0", title: "A new condenser",
    options: [{ name: "Condenser", isRecommended: true, lines: [{ name: "Condenser", quantity: "1", unitPrice: "3400.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] }],
  });
  return { customerId: c!.id as string, invoiceId: invoice.id as string, estimateId: estimate.id as string };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lone Star Air", slug: "contact-lone-star" });
  await seedOrg(raw, { organizationId: BARE, userId: BARE_USER, name: "Quiet Plumbing", slug: "contact-quiet" });
  ({ customerId, invoiceId, estimateId } = await seedWork(ORG, USER));
  ({ invoiceId: bareInvoiceId } = await seedWork(BARE, BARE_USER));
});

afterAll(async () => { if (raw) await raw.end(); });

run("setting how customers reach the company", () => {
  it("stores the phone as it dials, the email in lower case, and the address as typed", async () => {
    const saved = await setup.updateDetails(owner(), {
      name: "Lone Star Air",
      phone: "(512) 555-0143",
      email: "Office@LoneStarAir.example",
      addressLine1: "1200 Industrial Blvd",
      addressLine2: "Suite 4",
      city: "Austin",
      state: "TX",
      postalCode: "78745",
    });
    expect(saved.phone).toBe("+15125550143");
    expect(saved.email).toBe("office@lonestarair.example");
    expect(saved.addressLine2).toBe("Suite 4");
    expect((await setup.details(owner())).city).toBe("Austin");
  });

  it("keeps what a request leaves out, so renaming the company does not wipe its address", async () => {
    const renamed = await setup.updateDetails(owner(), { name: "Lone Star Air" });
    expect(renamed.phone).toBe("+15125550143");
    expect(renamed.addressLine1).toBe("1200 Industrial Blvd");
  });

  it("refuses a phone nobody can dial and an address with no town, and changes nothing", async () => {
    await expect(setup.updateDetails(owner(), { name: "Lone Star Air", phone: "call the office" }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(setup.updateDetails(owner(), { name: "Lone Star Air", email: "not an address" }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(setup.updateDetails(owner(), { name: "Lone Star Air", city: null }))
      .rejects.toThrow(/street and the town/);
    const after = await setup.details(owner());
    expect(after.phone).toBe("+15125550143");
    expect(after.city).toBe("Austin");
  });

  it("needs settings:write to change it", async () => {
    await expect(setup.updateDetails(as(ORG, USER, ["technician"]), { name: "Lone Star Air", phone: null }))
      .rejects.toThrow();
  });
});

run("the contact on every document a customer is handed", () => {
  const ADDRESS = "1200 Industrial Blvd, Suite 4, Austin, TX 78745";
  const PHONE = "(512) 555-0143";

  it("is on the proposal as the screen draws it, for the office and the customer's link", async () => {
    const office = await proposals.proposal(owner(), { id: estimateId });
    expect(office.company.contact.phone).toBe("+15125550143");
    expect(office.company.contact.addressLine1).toBe("1200 Industrial Blvd");

    const grant = await portal.issueGrant(owner(), { customerId, scope: "estimate", subjectId: estimateId, expiresInDays: 30 });
    const token = grant.url.split("/").pop()!;
    const customer = await proposals.proposalForToken(db(), token);
    expect(customer.company.contact.email).toBe("office@lonestarair.example");
  });

  it("is on the statement", async () => {
    const statement = await statements.statement(owner(), { id: customerId });
    expect(statement.organizationContact.phone).toBe("+15125550143");
    expect(statement.organizationContact.postalCode).toBe("78745");
  });

  it("is printed at the top of the invoice, proposal and statement PDFs", async () => {
    for (const file of [
      await documents.invoicePdf(owner(), { id: invoiceId }),
      await documents.proposalPdf(owner(), { id: estimateId }),
      await documents.statementPdf(owner(), { id: customerId }),
    ]) {
      const doc = read(file);
      expect(doc.problems, file.filename).toEqual([]);
      // On the first page, which is the one a customer reads.
      const first = doc.pages[0]!.join(" ");
      expect(first, file.filename).toContain(ADDRESS);
      expect(first, file.filename).toContain(PHONE);
      expect(first, file.filename).toContain("office@lonestarair.example");
    }
  });

  it("is in the branding the portal's header draws, from the customer's link", async () => {
    const grant = await portal.issueGrant(owner(), { customerId, scope: "invoice", subjectId: invoiceId, expiresInDays: 30 });
    const brand = await portal.brandingFor(db(), grant.url.split("/").pop()!);
    expect(brand.contact.phone).toBe("+15125550143");
    expect(brand.contact.city).toBe("Austin");
  });

  it("is not on the sign in page's branding, which anybody holding the slug can read", async () => {
    const brand = await portal.publicBrandingAt(db(), "contact-lone-star");
    expect(brand).not.toHaveProperty("contact");
  });

  it("prints nothing at all for a company that has set none of it, rather than empty labels", async () => {
    const doc = read(await documents.invoicePdf(as(BARE, BARE_USER), { id: bareInvoiceId }));
    expect(doc.problems).toEqual([]);
    expect(doc.text).toContain("Quiet Plumbing");
    expect(doc.text).not.toMatch(/Phone|Email|Address/);
  });

  it("comes off the paper when it is cleared", async () => {
    await setup.updateDetails(owner(), {
      name: "Lone Star Air", phone: null, email: "",
      addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null,
    });
    const doc = read(await documents.invoicePdf(owner(), { id: invoiceId }));
    expect(doc.text).not.toContain(PHONE);
    expect(doc.text).not.toContain("Industrial Blvd");
  });
});
