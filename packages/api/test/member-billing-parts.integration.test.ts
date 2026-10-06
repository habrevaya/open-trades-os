import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as agreements from "../src/services/agreements";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as priceBook from "../src/services/pricebook";
import * as contracts from "../src/services/contracts";
import * as rateCards from "../src/services/rate-cards";
import * as jobBilling from "../src/services/job-billing";
import * as commercial from "../src/services/commercial";
import * as entitlements from "../src/services/entitlements";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * MEMBER PRICING ON A JOB BILLED IN PARTS (M31, M08)
 *
 * A member's home warranty job: the warranty company pays the covered work at
 * its own schedule, the member pays the deductible and the work not covered.
 * Their plan takes its discount off their own part at our price and nothing
 * off the warranty company's, and the invoices, the discount and the tax
 * still add up to the job to the cent.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("mbp:org");
const USER = fixtureId("mbp:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let warrantyCo = "", landlord = "", member = "", home = "";
let labourItem = "", motor = "", flush = "", valve = "";
let agreementId = "";

const person = (name: string, type: "residential" | "commercial") => customers.create(owner(), {
  type, name, phone: `+1512556${String(Math.floor(Math.random() * 9000) + 1000)}`,
  paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
});

async function workedJob(used: Array<{ priceBookItemId: string; quantity: string }>) {
  const job = await jobs.create(owner(), {
    customerId: member, propertyId: home, summary: "No cooling", tags: [], customFields: {},
    visit: {
      windowStart: "2026-10-06T14:00:00.000Z", windowEnd: "2026-10-06T17:00:00.000Z",
      estimatedDurationMinutes: 120, technicianIds: [],
    },
  } as Parameters<typeof jobs.create>[1]);
  const [visit] = await raw<{ id: string }[]>`select id from public.visit where job_id = ${job.id as string}`;
  await raw`update public.visit set arrived_at = '2026-10-06T15:00:00Z' where id = ${visit!.id}`;
  await jobs.complete(owner(), { id: visit!.id, partsUsed: used });
  return job.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Member Parts Co", slug: "member-parts-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;

  warrantyCo = (await person("Shield Home Warranty", "commercial")).id;
  landlord = (await person("Lee Landlord", "residential")).id;
  member = (await person("Mia Member", "residential")).id;
  home = (await properties.create(owner(), {
    address: { line1: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: member, customerRole: "owner",
  })).id;

  labourItem = (await priceBook.create(owner(), { kind: "labor", code: "LAB-HR", name: "Labour, per hour", price: "120.00", cost: "45.00", taxable: false })).id;
  motor = (await priceBook.create(owner(), { kind: "material", code: "MOT-1", name: "Condenser fan motor", price: "749.00", cost: "200.00", taxable: false })).id;
  flush = (await priceBook.create(owner(), { kind: "service", code: "FLUSH", name: "Drain flush", price: "150.00", cost: "10.00", taxable: false })).id;
  valve = (await priceBook.create(owner(), { kind: "material", code: "VALVE", name: "Shut off valve", price: "200.00", cost: "40.00", taxable: true })).id;

  const contract = await contracts.createContract(owner(), {
    customerId: warrantyCo, name: "Shield network agreement", claimWithinDays: 60, invoiceFormat: "csv",
  });
  const card = await contracts.createRateCard(owner(), {
    name: "Shield schedule", contractId: contract.id, authority: "warranty_network",
  });
  await rateCards.setTerms(owner(), {
    rateCardId: card.id,
    labourRates: [{ band: "standard", hourlyRate: "85.00" }],
    materialMarkup: [{ upToCost: null, percent: "0.1" }],
  });

  const plan = await agreements.createPlan(owner(), {
    name: "Comfort Club", price: "240.00", billingFrequency: "annual", termMonths: 12,
    includedVisitsPerTerm: 0, discountRate: "0.10",
  });
  agreementId = (await agreements.sell(owner(), {
    planId: plan.id, customerId: member, propertyId: home, startedOn: companyToday(-30),
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("member pricing on a job billed by payer", () => {
  it("takes the plan's discount off the member's own part at our price, and nothing off the warranty company's", async () => {
    const jobId = await workedJob([
      { priceBookItemId: labourItem, quantity: "2" },
      { priceBookItemId: motor, quantity: "1" },
      { priceBookItemId: flush, quantity: "1" },
    ]);
    await entitlements.resolve(owner(), { jobId, source: "home_warranty", customerResponsibility: "100.00" });
    await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: warrantyCo }] });

    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.pricedTotal).toBe("540.0000");
    const shield = plan.payers.find((p) => p.role === "third_party")!;
    const mia = plan.payers.find((p) => p.role === "customer")!;
    expect(shield).toMatchObject({ total: "290.0000", memberDiscount: "0.0000" });
    /** The flush is hers at our price, so ten per cent of it; the deductible is the warranty's figure and is left alone. */
    expect(mia).toMatchObject({ total: "235.0000", memberDiscount: "15.0000" });
    expect(plan.member).toEqual({ agreementId, planName: "Comfort Club" });
    expect(plan.memberDiscount).toBe("15.0000");
    expect(plan.reconciles).toBe(true);

    const result = await jobBilling.bill(owner(), { jobId });
    const invoices = await Promise.all(result.invoices.map((i) => billing.get(owner(), { id: i.id })));
    const hers = invoices.find((i) => i.customerId === member)!;
    const theirs = invoices.find((i) => i.customerId === warrantyCo)!;
    expect(hers.total).toBe("235.0000");
    const flushLine = hers.lines.find((l) => l.name === "Drain flush")!;
    expect(flushLine).toMatchObject({ memberDiscountAmount: "15.0000", memberAgreementId: agreementId });
    expect(theirs.total).toBe("290.0000");
    expect(theirs.lines.every((l) => l.memberAgreementId === null)).toBe(true);

    const [sums] = await raw<{ debits: string; credits: string }[]>`
      select coalesce(sum(case when direction = 'debit' then amount end), 0)::text as debits,
             coalesce(sum(case when direction = 'credit' then amount end), 0)::text as credits
      from public.ledger_entry where organization_id = ${ORG}`;
    expect(sums!.debits).toBe(sums!.credits);
  });

  it("discounts the member's share of a line split by shares, taxes them on what they pay, and adds up", async () => {
    const jobId = await workedJob([{ priceBookItemId: valve, quantity: "1" }]);
    await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: landlord, sharePercent: "0.5" }] });

    const plan = await jobBilling.preview(owner(), { jobId, taxRate: "0.0825" });
    const lee = plan.payers.find((p) => p.customerId === landlord)!;
    const mia = plan.payers.find((p) => p.customerId === member)!;
    expect(lee).toMatchObject({ total: "100.0000", memberDiscount: "0.0000", taxTotal: "8.2500" });
    /** Her half is 100, less 10 for the plan; 8.25% of 90 is 7.425, so 7.43. */
    expect(mia).toMatchObject({ total: "90.0000", memberDiscount: "10.0000", taxTotal: "7.4300" });
    expect(plan.taxTotal).toBe("15.6800");
    expect(plan.reconciles).toBe(true);

    const result = await jobBilling.bill(owner(), { jobId, taxRate: "0.0825" });
    const hers = await billing.get(owner(), { id: result.invoices.find((i) => i.customerId === member)!.id });
    expect(hers).toMatchObject({ subtotal: "100.0000", discountTotal: "10.0000", taxTotal: "7.4300", total: "97.4300" });
    expect(result.taxTotal).toBe("15.6800");
  });

  it("takes nothing off when the job's own customer holds no plan", async () => {
    await agreements.cancel(owner(), { id: agreementId, reason: "Moved", keepThePrepayment: true });
    const jobId = await workedJob([{ priceBookItemId: flush, quantity: "1" }]);
    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.member).toBeNull();
    expect(plan.memberDiscount).toBe("0.0000");
    expect(plan.payers[0]!.total).toBe("150.0000");
  });
});
