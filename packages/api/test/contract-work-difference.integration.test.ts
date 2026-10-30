import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as priceBook from "../src/services/pricebook";
import * as contracts from "../src/services/contracts";
import * as rateCards from "../src/services/rate-cards";
import * as jobBilling from "../src/services/job-billing";
import * as escalation from "../src/services/contract-escalation";
import * as lateRise from "../src/services/contract-late-rise";
import * as billing from "../src/services/billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A CARD RISE APPLIED LATE, ON JOB WORK
 *
 * Pier Facilities' contract says its prices rise 3% a year. Nobody applied
 * year 2 on the anniversary, ten days ago, and a job billed since was priced
 * at last year's card: an hour and a half of labour, a capacitor from the
 * card's list, a motor at a markup on our cost, a drain flush from our own
 * price book and the trip. Applying the rise now offers what the labour, the
 * capacitor and the trip are short, line by line, and names the motor and the
 * flush as left out, with why. Nothing is billed by itself: two lines go on a
 * draft the office asks for, the trip is waived, and deleting the draft offers
 * its lines again.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("workdiff:org");
const USER = fixtureId("workdiff:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

let clientId = "", siteId = "";
let labourItem = "", capacitor = "", motor = "", flush = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Work Difference Co", slug: "work-difference-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  clientId = (await customers.create(owner(), {
    type: "commercial", name: "Pier Facilities", phone: "+15125550791",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  })).id;
  siteId = (await properties.create(owner(), {
    address: { line1: "1 Pier Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: clientId, customerRole: "owner",
  })).id;
  labourItem = (await priceBook.create(owner(), { kind: "labor", code: "LAB-HR", name: "Labour, per hour", price: "120.00", cost: "45.00", taxable: false })).id;
  capacitor = (await priceBook.create(owner(), { kind: "material", code: "CAP-45", name: "Run capacitor", price: "289.00", cost: "18.00", taxable: false })).id;
  motor = (await priceBook.create(owner(), { kind: "material", code: "MOT-1", name: "Condenser fan motor", price: "749.00", cost: "200.00", taxable: false })).id;
  flush = (await priceBook.create(owner(), { kind: "service", code: "FLUSH", name: "Drain flush", price: "150.00", cost: "10.00", taxable: false })).id;
});

/** Work done on a Tuesday at ten, Austin time, so the card's time band is the same whenever this runs. */
async function workedJob(used: Array<{ priceBookItemId: string; quantity: string }>) {
  const job = await jobs.create(owner(), {
    customerId: clientId, propertyId: siteId, summary: "Condenser repair", tags: [], customFields: {},
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

/** The contract a year and ten days old, its card, and the year 2 rise not yet applied. */
async function pierContract() {
  const anniversary = companyToday(-10);
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;
  const contract = await contracts.createContract(owner(), { customerId: clientId, name: "Pier MSA", startsOn, escalationRate: "0.03" });
  const card = await contracts.createRateCard(owner(), { name: "Pier schedule", contractId: contract.id, effectiveFrom: startsOn });
  await contracts.setRateCardLines(owner(), {
    rateCardId: card.id,
    lines: [{ priceBookItemId: capacitor, description: "Capacitor, supplied and fitted", price: "175.00" }],
  });
  await rateCards.setTerms(owner(), {
    rateCardId: card.id,
    labourRates: [{ band: "standard", hourlyRate: "95.00", minimumMinutes: 60, incrementMinutes: 15 }],
    materialMarkup: [{ upToCost: null, percent: "0.2" }],
    tripCharge: "45.00",
  });
  return { contract, card, anniversary };
}

async function applyRise(contractId: string, anniversary: string) {
  const shown = await escalation.preview(owner(), { contractId });
  expect(shown).toMatchObject({ anniversary, ready: true });
  return escalation.apply(owner(), { contractId, anniversary, key: shown.key! });
}

run("a card rise applied late, on job work", () => {
  it("offers what each line billed at last year's card is short, names what it leaves out, and bills only when asked", async () => {
    const { contract, card, anniversary } = await pierContract();
    const jobId = await workedJob([
      { priceBookItemId: labourItem, quantity: "1.5" },
      { priceBookItemId: capacitor, quantity: "1" },
      { priceBookItemId: motor, quantity: "1" },
      { priceBookItemId: flush, quantity: "1" },
    ]);
    const billed = await jobBilling.bill(owner(), { jobId });
    expect(billed.invoices).toHaveLength(1);
    const first = billed.invoices[0]!;
    /** A second job billed as a draft is not offered: its prices can still change before it goes. */
    const draftJob = await workedJob([{ priceBookItemId: capacitor, quantity: "2" }]);
    const drafted = await jobBilling.bill(owner(), { jobId: draftJob, draft: true });

    /** Before the rise, nothing is late. */
    expect((await lateRise.view(owner(), { contractId: contract.id })).rises).toEqual([]);

    const done = await applyRise(contract.id, anniversary);
    expect(done.cards).toHaveLength(1);

    const [rise, ...others] = (await lateRise.view(owner(), { contractId: contract.id })).rises;
    expect(others).toEqual([]);
    expect(rise).toMatchObject({ anniversary, cards: [{ fromRateCardId: card.id, rateCardId: done.cards[0]!.rateCardId }] });
    const by = (name: string) => rise!.lines.find((l) => l.name === name)!;
    expect(rise!.lines.map((l) => l.name).sort()).toEqual(["Labour, per hour", "Run capacitor", "Trip charge"]);
    expect(by("Labour, per hour")).toMatchObject({
      invoiceNumber: first.number, quantity: "1.5000", billedPrice: "95.0000", risenPrice: "97.8500",
      billed: "142.5000", risen: "146.7800", difference: "4.2800", status: "offered",
    });
    expect(by("Run capacitor")).toMatchObject({ billedPrice: "175.0000", risenPrice: "180.2500", difference: "5.2500" });
    expect(by("Trip charge")).toMatchObject({ billedPrice: "45.0000", risenPrice: "46.3500", difference: "1.3500" });

    const reasons = Object.fromEntries(rise!.leftOut.map((l) => [`${l.invoiceNumber} ${l.name}`, l.reason]));
    expect(reasons[`${first.number} Condenser fan motor`]).toMatch(/markup on our cost/);
    expect(reasons[`${first.number} Drain flush`]).toMatch(/price book/);
    expect(reasons[`${drafted.invoices[0]!.number} Run capacitor`]).toMatch(/Still a draft/);

    /** Looking needs the contract and the invoices; billing it needs to write an invoice. */
    await expect(lateRise.view(as(["readonly"]), { contractId: contract.id })).rejects.toBeInstanceOf(PermissionError);
    await expect(lateRise.draft(as(["readonly"]), {
      contractId: contract.id, anniversary, invoiceLineIds: [by("Run capacitor").invoiceLineId],
    })).rejects.toBeInstanceOf(PermissionError);

    /** Nothing was billed by itself: the only invoices are the two jobs'. */
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.invoice where organization_id = ${ORG}`;
    expect(count!.n).toBe(2);

    const picked = [by("Labour, per hour").invoiceLineId, by("Run capacitor").invoiceLineId];
    const made = await lateRise.draft(owner("work-diff-1"), { contractId: contract.id, anniversary, invoiceLineIds: picked });
    expect(made).toMatchObject({ anniversary, lines: 2, total: "9.5300" });
    expect(await lateRise.draft(owner("work-diff-1"), { contractId: contract.id, anniversary, invoiceLineIds: picked })).toEqual(made);
    const invoice = await billing.get(owner(), { id: made.invoiceId });
    expect(invoice).toMatchObject({ status: "draft", customerId: clientId });
    const lines = invoice.lines as Array<{ name: string; description: string | null; unitPrice: string; priceAuthority: string | null; rateCardId: string | null }>;
    const capLine = lines.find((l) => l.name.startsWith("Run capacitor"))!;
    expect(capLine.name).toBe(`Run capacitor, card price rise from ${anniversary}`);
    expect(capLine.description).toBe(`1.00 at 180.25 on Pier schedule (year 2), less 175.00 billed on invoice ${first.number} for job ${(await jobs.get(owner(), { id: jobId })).number}`);
    expect(capLine).toMatchObject({ unitPrice: "5.2500", priceAuthority: "contract", rateCardId: done.cards[0]!.rateCardId });

    await expect(lateRise.draft(owner(), { contractId: contract.id, anniversary, invoiceLineIds: [picked[0]!] }))
      .rejects.toThrow(/already been put on draft invoice/);
    await expect(lateRise.draft(owner(), { contractId: contract.id, anniversary, invoiceLineIds: [rise!.leftOut[0]!.invoiceLineId] }))
      .rejects.toThrow(/is not offered/);

    const waived = await lateRise.waive(owner(), { contractId: contract.id, anniversary, invoiceLineIds: [by("Trip charge").invoiceLineId] });
    expect(Object.fromEntries(waived.rises[0]!.lines.map((l) => [l.name, l.status]))).toEqual({
      "Labour, per hour": "drafted", "Run capacitor": "drafted", "Trip charge": "waived",
    });
    await expect(lateRise.waive(owner(), { contractId: contract.id, anniversary, invoiceLineIds: [by("Trip charge").invoiceLineId] }))
      .rejects.toBeInstanceOf(ConflictError);

    /** A draft deleted is a decision not yet made: its lines are offered again. */
    await billing.deleteDraft(owner(), { id: made.invoiceId });
    const again = (await lateRise.view(owner(), { contractId: contract.id })).rises[0]!;
    expect(Object.fromEntries(again.lines.map((l) => [l.name, l.status]))).toEqual({
      "Labour, per hour": "offered", "Run capacitor": "offered", "Trip charge": "waived",
    });
  });

  it("offers nothing on work billed after the rise was applied, or on a line with a discount", async () => {
    const { contract, anniversary } = await pierContract();
    const lateJob = await workedJob([{ priceBookItemId: capacitor, quantity: "1" }]);
    const lines = (await jobs.lines(owner(), { id: lateJob })).data;
    /** Billed by hand with a discount, at last year's card. */
    const discounted = await billing.create(owner(), {
      customerId: clientId, jobId: lateJob,
      lines: [{ jobLineId: lines[0]!.id, name: lines[0]!.name, quantity: "1", unitPrice: "289.00", discountAmount: "10.00", taxable: false }],
    });
    expect(discounted.lines[0]).toMatchObject({ unitPrice: "175.0000", priceBasis: "card_line" });

    await applyRise(contract.id, anniversary);
    const afterJob = await workedJob([{ priceBookItemId: capacitor, quantity: "1" }]);
    const after = await jobBilling.bill(owner(), { jobId: afterJob });
    /** The capacitor and the trip, at the risen card. */
    expect(after.invoices[0]!.total).toBe("226.6000");

    const [rise] = (await lateRise.view(owner(), { contractId: contract.id })).rises;
    expect(rise!.lines).toEqual([]);
    expect(rise!.leftOut).toEqual([expect.objectContaining({ invoiceNumber: discounted.number, reason: expect.stringMatching(/discount/) })]);
    await expect(lateRise.waive(owner(), { contractId: contract.id, anniversary, invoiceLineIds: [rise!.leftOut[0]!.invoiceLineId] }))
      .rejects.toThrow(/discount/);
  });
});
