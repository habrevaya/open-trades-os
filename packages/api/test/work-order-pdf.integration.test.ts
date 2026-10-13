import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, PermissionError, type Actor } from "@opentradesos/core";
import * as company from "../src/services/company";
import * as branches from "../src/services/branches";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as documents from "../src/services/documents";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A JOB AS A WORK ORDER PDF (M10, M01)
 *
 * The job with its branch's code, the customer and the address, each visit
 * with its time and who was sent, the work, the checklist and what was used,
 * and a line to sign. Read back through `inspectPdf`, so "the technician's
 * copy has no prices" means no price was drawn. Under the job's own
 * permission and scope: a technician who sees only their own work gets a not
 * found for somebody else's job, the same answer the job page gives.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("work-order-pdf:org");
const OWNER = fixtureId("work-order-pdf:owner");
const TECH_USER = fixtureId("work-order-pdf:tech");
const OTHER_ORG = fixtureId("work-order-pdf:other-org");
const OTHER_OWNER = fixtureId("work-order-pdf:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const read = (file: documents.PdfFile) => pdf.inspectPdf(file.bytes, (b) => new Uint8Array(inflateSync(b)));

let jobId = "";
let jobNumber = 0;
let otherJobId = "";
let technicianId = "";

const technician = (): ServiceContext => ({
  actor: { userId: TECH_USER, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId },
  db: db(),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Work Order Air", slug: "work-order-pdf" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_OWNER, name: "Someone Else", slug: "work-order-pdf-other" });

  const roundRock = (await company.createBusinessUnit(owner(), { name: "Round Rock", code: "RR" })).id;
  await branches.setNumbering(owner(), { jobs: true, invoices: false });
  const customerId = (await customers.create(owner(), {
    type: "residential", name: "Dana Workorder", phone: "+15125550177", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  const propertyId = (await properties.create(owner(), {
    address: { line1: "4 Pecan Hollow", city: "Round Rock", state: "TX", postalCode: "78664", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  await raw`update public.property set access_notes = 'Side gate, ring twice', gate_code = '4321'
            where id = ${propertyId}`;

  await raw`delete from public."user" where id = ${TECH_USER}`;
  await raw`insert into public."user" (id, email, name) values (${TECH_USER}, 'ray@work-order-pdf.test', 'Ray Ortiz')`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${TECH_USER}, 'technician') returning id`;
  const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Ortiz') returning id`;
  technicianId = tech!.id as string;

  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "No cooling upstairs", description: "Check the capacitor and the contactor.",
    tags: [], customFields: {}, businessUnitId: roundRock,
  });
  jobId = job.id as string;
  jobNumber = job.number as number;
  const [visit] = await raw`insert into public.visit
    (organization_id, job_id, status, window_start, window_end, checklist)
    values (${ORG}, ${jobId}, 'dispatched', '2026-10-06T14:00:00Z', '2026-10-06T16:00:00Z',
            ${raw.json([
              { id: "a", label: "Check refrigerant pressure", required: true, doneAt: "2026-10-06T14:30:00Z" },
              { id: "b", label: "Replace the filter", required: false, doneAt: null },
            ])})
    returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
    values (${ORG}, ${visit!.id}, ${technicianId}, true)`;
  await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${jobId}, 'cancelled', '2026-10-05T14:00:00Z', '2026-10-05T16:00:00Z')`;
  await raw`insert into public.job_line (organization_id, job_id, visit_id, kind, name, quantity, unit_price, unit_cost)
    values (${ORG}, ${jobId}, ${visit!.id}, 'part', 'Capacitor 45/5', '2', '89.50', '31.17')`;
  await raw`insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, non_billable_reason)
    values (${ORG}, ${jobId}, 'labor', 'Diagnosis', '1', '0', 'Warranty')`;

  const other = await jobs.create(owner(), {
    customerId, propertyId, summary: "Somebody else's job", tags: [], customFields: {},
  });
  otherJobId = other.id as string;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where id = ${TECH_USER}`;
  await raw.end();
});

run("a job as a work order", () => {
  it("prints the job with its branch's code, the customer, the visit with its time and who, the work and a signature line", async () => {
    const file = await documents.workOrderPdf(owner(), { id: jobId });
    expect(file.filename).toBe(`work-order-RR-${jobNumber}.pdf`);
    const printed = read(file);
    expect(printed.problems).toEqual([]);
    for (const said of [
      `Work order RR-${jobNumber}`, "Office copy", "Round Rock (RR)", "Dana Workorder", "+15125550177",
      "4 Pecan Hollow, Round Rock, TX 78664", "Side gate, ring twice",
      // The company's clock: 14:00 UTC is 9:00 AM in Chicago in October.
      "Visit 1: Tue, Oct 6, 9:00 AM to 11:00 AM CDT", "Ray Ortiz", "Sent out",
      "No cooling upstairs", "Check the capacitor and the contactor.",
      "Check refrigerant pressure (must be done)", "Replace the filter", "Done",
      "Capacitor 45/5", "$89.50", "$179.00", "No charge: Warranty",
      "Customer sign off", "Signature",
    ]) expect(printed.text).toContain(said);
    // One visit: the cancelled one is not work anybody is going to.
    expect(printed.text).not.toContain("Visit 2");
    // Never what a part cost the company, and never the gate code.
    expect(printed.text).not.toContain("31.17");
    expect(printed.text).not.toContain("4321");
  });

  it("prints the technician's copy without a single price", async () => {
    const file = await documents.workOrderPdf(owner(), { id: jobId, forTechnician: true });
    expect(file.filename).toBe(`work-order-RR-${jobNumber}-technician.pdf`);
    const printed = read(file);
    expect(printed.problems).toEqual([]);
    expect(printed.text).toContain("Printed for the technician");
    expect(printed.text).toContain("Capacitor 45/5");
    expect(printed.text).not.toContain("$");
    expect(printed.text).not.toContain("89.5");
  });

  it("is the technician's own job only, for a technician who sees their own work", async () => {
    const mine = read(await documents.workOrderPdf(technician(), { id: jobId, forTechnician: true }));
    expect(mine.text).toContain(`Work order RR-${jobNumber}`);
    await expect(documents.workOrderPdf(technician(), { id: otherJobId })).rejects.toThrow(NotFoundError);
  });

  it("is not found from another company, and refused without the job permission", async () => {
    const stranger: ServiceContext = { actor: { userId: OTHER_OWNER, organizationId: OTHER_ORG, roles: ["owner"] }, db: db() };
    await expect(documents.workOrderPdf(stranger, { id: jobId })).rejects.toThrow(NotFoundError);
    const nobody: ServiceContext = { actor: { userId: OWNER, organizationId: ORG, roles: [] }, db: db() };
    await expect(documents.workOrderPdf(nobody, { id: jobId })).rejects.toThrow(PermissionError);
  });
});
