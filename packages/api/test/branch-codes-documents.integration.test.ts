import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, type Actor } from "@opentradesos/core";
import * as company from "../src/services/company";
import * as branches from "../src/services/branches";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as documents from "../src/services/documents";
import { buildStatement } from "../src/services/statements";
import { render } from "../src/lib/render";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A BRANCH'S CODE WHEREVER THE NUMBER IS
 *
 * A company that prints "HOU-1042" on its screens printed "1042" on the PDF
 * the customer was emailed, in the email's subject, on their statement and
 * in a text quoting the job. This asks that each of those prints the number
 * the way the invoice and job pages do, and that a number with no code is
 * printed alone, as before.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("branch-codes-docs:org");
const OWNER = fixtureId("branch-codes-docs:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const read = (file: documents.PdfFile) => pdf.inspectPdf(file.bytes, (b) => new Uint8Array(inflateSync(b)));

let customerId = "";
let coded = { id: "", number: 0 };
let plain = { id: "", number: 0 };
let jobNumber = 0;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Coded Air", slug: "branch-codes-docs" });
  const houston = (await company.createBusinessUnit(owner(), { name: "Houston", code: "HOU" })).id;
  await branches.setNumbering(owner(), { jobs: true, invoices: true });
  customerId = (await customers.create(owner(), {
    type: "residential", name: "Carla Coded", email: "carla@codes.test", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  const propertyId = (await properties.create(owner(), {
    address: { line1: "12 Code St", city: "Houston", state: "TX", postalCode: "77002", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Condenser swap", tags: [], customFields: {}, businessUnitId: houston,
  });
  jobNumber = job.number as number;
  const line = { name: "Condenser", quantity: "1", unitPrice: "1200.00", discountAmount: "0", taxable: false };
  const a = await billing.create(owner(), { customerId, jobId: job.id as string, issuedOn: companyToday(), lines: [line] });
  coded = { id: a.id as string, number: a.number as number };
  const b = await billing.create(owner(), { customerId, issuedOn: companyToday(), lines: [line] });
  plain = { id: b.id as string, number: b.number as number };
});

afterAll(async () => { if (raw) await raw.end(); });

run("a branch's code on the documents a customer is handed", () => {
  it("prints it on the invoice PDF and its file name, and prints a number with no code alone", async () => {
    const file = await documents.invoicePdf(owner(), { id: coded.id });
    expect(file.filename).toBe(`invoice-HOU-${coded.number}.pdf`);
    const text = read(file).text;
    expect(text).toContain(`Invoice HOU-${coded.number}`);
    const other = await documents.invoicePdf(owner(), { id: plain.id });
    expect(other.filename).toBe(`invoice-${plain.number}.pdf`);
    expect(read(other).text).toContain(`Invoice ${plain.number}`);
  });

  it("prints it on the statement, on its lines and its open invoices", async () => {
    const statement = await inTenant(owner(), (tx) => buildStatement(tx, ORG, customerId, {}));
    expect(statement.openInvoices.find((i) => i.id === coded.id)?.numberPrefix).toBe("HOU");
    expect(statement.lines.map((l) => l.description)).toContain(`Invoice HOU-${coded.number}`);
    const text = read(await documents.statementPdf(owner(), { id: customerId })).text;
    expect(text).toContain(`HOU-${coded.number}`);
  });

  it("puts it in the invoice email's subject and body", async () => {
    await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
              values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@codes.test" })})
              on conflict do nothing`;
    const invoiceDelivery = await import("../src/services/invoice-delivery");
    const sent = await invoiceDelivery.send(owner(), { invoiceId: coded.id });
    const [message] = await raw<{ subject: string; body: string }[]>`
      select subject, body from public.message where id = ${sent.messageId}`;
    expect(message!.subject).toBe(`Invoice HOU-${coded.number} from Coded Air`);
    expect(message!.body).toContain(`Invoice HOU-${coded.number} from Coded Air is ready.`);
  });

  it("puts it in a text or email that quotes {{ job.number }}, read off the job the event carries", async () => {
    const [row] = await raw<{ number_prefix: string | null }[]>`
      select number_prefix from public.job where organization_id = ${ORG} and number = ${jobNumber}`;
    expect(row!.number_prefix).toBe("HOU");
    expect(render("Job {{ job.number }} is complete.", { job: { number: jobNumber, numberPrefix: "HOU" } }))
      .toBe(`Job HOU-${jobNumber} is complete.`);
    expect(render("Job {{ job.number }} is complete.", { job: { number: 7, numberPrefix: null } })).toBe("Job 7 is complete.");
    expect(render("{{ visit.sequence }}", { visit: { sequence: 2, numberPrefix: "HOU" } })).toBe("2");
  });
});
