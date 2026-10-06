import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as priceBook from "../src/services/pricebook";
import * as contracts from "../src/services/contracts";
import * as jobBilling from "../src/services/job-billing";
import * as commercial from "../src/services/commercial";
import * as entitlements from "../src/services/entitlements";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * LABOUR BEYOND A MANUFACTURER'S ALLOWANCE
 *
 * A manufacturer's parts warranty pays its allowance for replacing a coil:
 * 210.00, allowing ninety minutes. The technician was on site for two and a
 * half hours. The hour beyond the allowance used to be charged to nobody.
 * Billing the job in parts now offers it, with the minutes, to whoever pays:
 * offered, never added by itself, and once on somebody's part it is billed
 * with the rest and the invoices still add up to the work.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("allowance:org");
const USER = fixtureId("allowance:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let maker = "", homeowner = "", home = "", coil = "", labour = "", technician = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Allowance Co", slug: "allowance-co" });
  const person = (name: string, type: "residential" | "commercial", phone: string) => customers.create(owner(), {
    type, name, phone, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  maker = (await person("Carrier Dealer Programme", "commercial", "+15125550601")).id;
  homeowner = (await person("Hana Homeowner", "residential", "+15125550602")).id;
  home = (await properties.create(owner(), {
    address: { line1: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: homeowner, customerRole: "owner",
  })).id;
  coil = (await priceBook.create(owner(), { kind: "material", code: "COIL", name: "Evaporator coil", price: "900.00", cost: "400.00", taxable: false })).id;
  labour = (await priceBook.create(owner(), { kind: "labor", code: "LAB", name: "Labour, per hour", price: "120.00", cost: "45.00", taxable: false })).id;

  const contract = await contracts.createContract(owner(), { customerId: maker, name: "Dealer programme", startsOn: "2026-01-01" });
  const card = await contracts.createRateCard(owner(), {
    name: "Coil allowance", contractId: contract.id, authority: "manufacturer_allowance",
  });
  await contracts.setRateCardLines(owner(), {
    rateCardId: card.id,
    lines: [{ priceBookItemId: coil, description: "Coil replaced under warranty", price: "210.00", allowedMinutes: 90 }],
  });

  const [person2] = await raw<{ id: string }[]>`
    insert into public."user" (email, name) values (${`tech-${Date.now()}@allowance.test`}, 'Tess Tech') returning id`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${person2!.id}, 'technician') returning id`;
  const [tech] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${membership!.id}, 'Tess Tech', true) returning id`;
  technician = tech!.id;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where email like '%@allowance.test'`;
  await raw.end();
});

/** A warranty coil job, worked for `minutes` on site, with whatever else was used. */
async function coilJob(minutes: number, used: Array<{ priceBookItemId: string; quantity: string }> = []) {
  const job = await jobs.create(owner(), {
    customerId: homeowner, propertyId: home, summary: "Coil leaking", tags: [], customFields: {},
    visit: {
      windowStart: "2026-10-06T14:00:00.000Z", windowEnd: "2026-10-06T17:00:00.000Z",
      estimatedDurationMinutes: 120, technicianIds: [],
    },
  } as Parameters<typeof jobs.create>[1]);
  const jobId = job.id as string;
  const [visit] = await raw<{ id: string }[]>`select id from public.visit where job_id = ${jobId}`;
  await raw`update public.visit set arrived_at = '2026-10-06T15:00:00Z' where id = ${visit!.id}`;
  await jobs.complete(owner(), { id: visit!.id, partsUsed: [{ priceBookItemId: coil, quantity: "1" }, ...used] });
  await raw`
    insert into public.timeclock_entry (organization_id, technician_id, kind, job_id, visit_id, started_at, ended_at, minutes)
    values (${ORG}, ${technician}, 'on_site', ${jobId}, ${visit!.id}, '2026-10-06T15:00:00Z',
            '2026-10-06T15:00:00Z'::timestamptz + ${`${minutes} minutes`}::interval, ${minutes})`;
  await entitlements.resolve(owner(), { jobId, source: "parts_warranty", externalReference: "CDP-1182" });
  await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: maker }] });
  return jobId;
}

run("labour beyond a manufacturer's allowance", () => {
  it("is offered with the minutes, and added to nobody until somebody asks", async () => {
    const jobId = await coilJob(150);
    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.basis).toBe("coverage");
    expect(plan.lines.find((l) => l.name === "Evaporator coil")).toMatchObject({ basis: "card_line", unitPrice: "210.0000", allowedMinutes: 90 });
    expect(plan.beyond).toEqual({
      workedMinutes: 150, allowedMinutes: 90, onLinesMinutes: 0, beyondMinutes: 60, addedTo: null,
      payers: [
        { customerId: maker, name: "Carrier Dealer Programme" },
        { customerId: homeowner, name: "Hana Homeowner" },
      ],
    });
    /** Offered, not added: the work is the allowance and nothing else. */
    expect(plan.lines.map((l) => l.key)).not.toContain("beyond");
    expect(plan.pricedTotal).toBe("210.0000");
    expect(plan.problems).toEqual([]);
  });

  it("goes on the customer's part when the office puts it there, and the invoices still add up", async () => {
    const jobId = await coilJob(150);
    const plan = await jobBilling.preview(owner(), { jobId, beyondPayer: homeowner, beyondRate: "120.00" });
    const line = plan.lines.find((l) => l.key === "beyond")!;
    expect(line).toMatchObject({ name: "Labour beyond the allowance", quantity: "1.0000", unitPrice: "120.0000", amount: "120.0000", authority: "entered" });
    expect(line.note).toMatch(/^60 min on site beyond the 90 min the allowance allows\. 60 min at 120\.00 an hour/);
    expect(plan.beyond?.addedTo).toBe(homeowner);
    expect(plan.payers.find((p) => p.customerId === homeowner)).toMatchObject({ total: "120.0000" });
    expect(plan.payers.find((p) => p.customerId === maker)).toMatchObject({ total: "210.0000" });
    expect(plan).toMatchObject({ pricedTotal: "330.0000", invoicedTotal: "330.0000", reconciles: true });

    const billed = await jobBilling.bill(owner(), { jobId, beyondPayer: homeowner, beyondRate: "120.00" });
    expect(billed.invoices.map((i) => [i.customerId, i.total]).sort()).toEqual(
      [[maker, "210.0000"], [homeowner, "120.0000"]].sort(),
    );
    const theirs = await billing.get(owner(), { id: billed.invoices.find((i) => i.customerId === homeowner)!.id });
    expect(theirs.lines[0]).toMatchObject({ name: "Labour beyond the allowance", priceBasis: "entered" });
    expect(theirs.lines[0]!.priceNote).toMatch(/60 min on site beyond the 90 min/);

    /** The allowance is billed now, so nothing is offered a second time. */
    expect((await jobBilling.preview(owner(), { jobId })).beyond).toBeNull();
  });

  it("does not offer time already on a labour line, nor a job that kept inside the allowance", async () => {
    const withLabour = await coilJob(150, [{ priceBookItemId: labour, quantity: "0.5" }]);
    expect((await jobBilling.preview(owner(), { jobId: withLabour })).beyond).toMatchObject({ onLinesMinutes: 30, beyondMinutes: 30 });
    const inside = await coilJob(80);
    expect((await jobBilling.preview(owner(), { jobId: inside })).beyond).toBeNull();
  });

  it("refuses to bill a request it cannot honour, in words", async () => {
    const inside = await coilJob(80);
    await expect(jobBilling.bill(owner(), { jobId: inside, beyondPayer: homeowner, beyondRate: "120.00" }))
      .rejects.toThrow(/no labour beyond an allowance/);
    const jobId = await coilJob(150);
    await expect(jobBilling.bill(owner(), { jobId, beyondPayer: homeowner }))
      .rejects.toBeInstanceOf(ConflictError);
    const stranger = (await customers.create(owner(), {
      type: "residential", name: "Somebody Else", phone: "+15125550609", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    })).id;
    await expect(jobBilling.bill(owner(), { jobId, beyondPayer: stranger, beyondRate: "120.00" }))
      .rejects.toThrow(/only to somebody this job is billed to/);
  });
});
