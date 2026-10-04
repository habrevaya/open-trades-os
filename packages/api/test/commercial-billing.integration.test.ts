import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
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
import * as obligations from "../src/services/obligations";
import * as claims from "../src/services/claims";
import * as payerDelivery from "../src/services/payer-delivery";
import { clockPass } from "../src/services/contract-clocks";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * COMMERCIAL AND WARRANTY BILLING, END TO END THROUGH THE SERVICES
 *
 * Our price book is not the price authority in half the market. These tests
 * follow the money through the paths a real commercial or home warranty job
 * takes: priced from somebody else's card, held by a client's limit, run
 * against a contract's clocks, billed to two payers that add up to the work,
 * claimed against a third party, and handed to a payer as a link and a file.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cb:org");
const USER = fixtureId("cb:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});

let fmClient = "", fmSite = "";
let warrantyCo = "", homeowner = "", home = "";
let plumbingType = "";
let labourItem = "", capacitor = "", motor = "", flush = "";

const person = (name: string, type: "residential" | "commercial") => customers.create(owner(), {
  type, name, phone: `+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`,
  paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
});
const place = (line1: string, customerId: string) => properties.create(owner(), {
  address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
  hasDog: false, customFields: {}, customerId, customerRole: "owner",
});

/**
 * A job with work recorded on it, done on a Tuesday at ten in the morning
 * Austin time, so the band a card charges is the same whenever this runs.
 */
async function workedJob(
  customerId: string, propertyId: string,
  used: Array<{ priceBookItemId: string; quantity: string }>,
  extra: Record<string, unknown> = {},
) {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Commercial work", tags: [], customFields: {},
    visit: {
      windowStart: "2026-10-06T14:00:00.000Z", windowEnd: "2026-10-06T17:00:00.000Z",
      estimatedDurationMinutes: 120, technicianIds: [],
    },
    ...extra,
  } as Parameters<typeof jobs.create>[1]);
  const [visit] = await raw<{ id: string }[]>`select id from public.visit where job_id = ${job.id as string}`;
  await raw`update public.visit set arrived_at = '2026-10-06T15:00:00Z' where id = ${visit!.id}`;
  await jobs.complete(owner(), { id: visit!.id, partsUsed: used });
  return job.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Commercial Billing Co", slug: "commercial-billing-co" });

  fmClient = (await person("Meridian Facilities", "commercial")).id;
  fmSite = (await place("400 Distribution Way", fmClient)).id;
  warrantyCo = (await person("Shield Home Warranty", "commercial")).id;
  homeowner = (await person("Hana Homeowner", "residential")).id;
  home = (await place("12 Elm St", homeowner)).id;

  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code) values (${ORG}, 'Plumbing repair', 'plumb') returning id`;
  plumbingType = type!.id;

  labourItem = (await priceBook.create(owner(), { kind: "labor", code: "LAB-HR", name: "Labour, per hour", price: "120.00", cost: "45.00", taxable: false })).id;
  capacitor = (await priceBook.create(owner(), { kind: "material", code: "CAP-45", name: "Run capacitor", price: "289.00", cost: "18.00", taxable: false })).id;
  motor = (await priceBook.create(owner(), { kind: "material", code: "MOT-1", name: "Condenser fan motor", price: "749.00", cost: "200.00", taxable: false })).id;
  flush = (await priceBook.create(owner(), { kind: "service", code: "FLUSH", name: "Drain flush", price: "150.00", cost: "10.00", taxable: false })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

/** Every posting balances, and the receivable on each customer is what their invoices owe. */
async function ledgerBalances() {
  const [sums] = await raw<{ debits: string; credits: string }[]>`
    select coalesce(sum(case when direction = 'debit' then amount end), 0)::text as debits,
           coalesce(sum(case when direction = 'credit' then amount end), 0)::text as credits
    from public.ledger_entry where organization_id = ${ORG}`;
  return sums!;
}
async function receivableOf(customerId: string) {
  const [row] = await raw<{ ar: string }[]>`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::text as ar
    from public.ledger_entry where organization_id = ${ORG} and account_code = '1200' and customer_id = ${customerId}`;
  return row!.ar;
}

run("a client's rate card prices their work", () => {
  let cardId = "";

  beforeAll(async () => {
    const contract = await contracts.createContract(owner(), {
      customerId: fmClient, name: "Meridian MSA 2026", startsOn: "2026-01-01", endsOn: "2026-12-31",
    });
    const card = await contracts.createRateCard(owner(), { name: "Meridian schedule", contractId: contract.id });
    cardId = card.id;
    await contracts.setRateCardLines(owner(), {
      rateCardId: card.id,
      lines: [{ priceBookItemId: capacitor, description: "Capacitor, supplied and fitted", price: "175.00" }],
    });
    await rateCards.setTerms(owner(), {
      rateCardId: card.id,
      labourRates: [
        { band: "standard", hourlyRate: "95.00", minimumMinutes: 60, incrementMinutes: 15 },
        { band: "after_hours", hourlyRate: "142.50" },
        { jobTypeId: plumbingType, band: "standard", hourlyRate: "110.00" },
      ],
      materialMarkup: [{ upToCost: "100.00", percent: "0.5" }, { upToCost: null, percent: "0.2" }],
      tripCharge: "45.00",
    });
  });

  it("keeps the card's rules and reads them back", async () => {
    const terms = await rateCards.terms(owner(), { rateCardId: cardId });
    expect(terms.labourRates).toHaveLength(3);
    expect(terms.labourRates.find((r) => r.jobTypeId === plumbingType)?.jobTypeName).toBe("Plumbing repair");
    expect(terms.tripCharge).toBe("45.0000");
  });

  it("refuses a markup written as a percentage, and changes nothing", async () => {
    await expect(rateCards.setTerms(owner(), {
      rateCardId: cardId, labourRates: [], materialMarkup: [{ percent: "25" }],
    })).rejects.toThrow(/fraction/);
    expect((await rateCards.terms(owner(), { rateCardId: cardId })).labourRates).toHaveLength(3);
  });

  it("prices every line by the card's own rule, and says which on the line", async () => {
    const jobId = await workedJob(fmClient, fmSite, [
      { priceBookItemId: labourItem, quantity: "1.5" },
      { priceBookItemId: capacitor, quantity: "1" },
      { priceBookItemId: motor, quantity: "1" },
      { priceBookItemId: flush, quantity: "1" },
    ]);
    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.basis).toBe("single");
    const by = (name: string) => plan.lines.find((l) => l.name === name)!;
    expect(by("Labour, per hour")).toMatchObject({ basis: "labour_rate", authority: "contract", unitPrice: "95.0000", quantity: "1.5000" });
    expect(by("Run capacitor")).toMatchObject({ basis: "card_line", unitPrice: "175.0000" });
    expect(by("Condenser fan motor")).toMatchObject({ basis: "material_markup", unitPrice: "240.0000" });
    /** A service the card does not price: our book, and flagged. */
    expect(by("Drain flush")).toMatchObject({ authority: "price_book", outOfScope: true });
    expect(by("Trip charge")).toMatchObject({ basis: "trip_charge", unitPrice: "45.0000", quantity: "1" });
    expect(plan.pricedTotal).toBe("752.5000");

    const result = await jobBilling.bill(owner(), { jobId });
    expect(result.invoices).toHaveLength(1);
    const invoice = await billing.get(owner(), { id: result.invoices[0]!.id });
    expect(invoice.total).toBe("752.5000");
    const labour = invoice.lines.find((l) => l.name === "Labour, per hour")!;
    expect(labour.priceAuthority).toBe("contract");
    expect(labour.priceBasis).toBe("labour_rate");
    expect(labour.rateCardId).toBe(cardId);
    expect(labour.priceNote).toMatch(/Standard hours rate: 90 min at 95.00/);

    /** Every job line is now billed, so the same work cannot reach a second invoice. */
    const [left] = await raw<{ n: number }[]>`select count(*)::int as n from public.job_line where job_id = ${jobId} and invoice_line_id is null`;
    expect(left!.n).toBe(0);
  });

  it("prices the ordinary invoice the same way, from the job lines it bills", async () => {
    const jobId = await workedJob(fmClient, fmSite, [{ priceBookItemId: labourItem, quantity: "0.5" }]);
    const lines = (await jobs.lines(owner(), { id: jobId })).data;
    const invoice = await billing.create(owner(), {
      customerId: fmClient, jobId,
      lines: [{ jobLineId: lines[0]!.id, name: lines[0]!.name, quantity: "0.5", unitPrice: "120.00", discountAmount: "0", taxable: false }],
    });
    /** The card's one hour minimum, at its rate, rather than the half hour at our price that was typed. */
    expect(invoice.lines[0]).toMatchObject({ quantity: "1.0000", unitPrice: "95.0000", priceAuthority: "contract" });
    expect(invoice.total).toBe("95.0000");
  });

  it("charges the trade's own rate for work booked under that trade", async () => {
    const jobId = await workedJob(fmClient, fmSite, [{ priceBookItemId: labourItem, quantity: "2" }], { jobTypeId: plumbingType });
    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.lines.find((l) => l.kind === "labor")!.unitPrice).toBe("110.0000");
  });

  it("leaves a customer with no card on our price book, unflagged", async () => {
    const jobId = await workedJob(homeowner, home, [{ priceBookItemId: flush, quantity: "1" }]);
    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.lines.map((l) => [l.authority, l.outOfScope])).toEqual([["price_book", false]]);
    expect(plan.lines.some((l) => l.basis === "trip_charge")).toBe(false);
  });
});

run("the client's limit", () => {
  let contractId = "", client = "", site = "";

  beforeAll(async () => {
    client = (await person("Northgate Retail", "commercial")).id;
    site = (await place("9 Mall Ct", client)).id;
    const contract = await contracts.createContract(owner(), {
      customerId: client, name: "Northgate MSA", defaultNotToExceed: "500.00",
    });
    contractId = contract.id;
    await contracts.addSite(owner(), { contractId, propertyId: site, siteNumber: "S-14", notToExceed: "300.00" });
  });

  it("holds an invoice over the site's limit and says what would fit", async () => {
    const jobId = await workedJob(client, site, [{ priceBookItemId: motor, quantity: "1" }]);
    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.payers[0]!.ceiling).toMatchObject({ state: "over", held: true });
    expect(plan.problems.join(" ")).toMatch(/site S-14/);

    await expect(jobBilling.bill(owner(), { jobId })).rejects.toThrow(/held until the client raises the limit/);
    await expect(billing.create(owner(), {
      customerId: client, jobId,
      lines: [{ name: "Motor", quantity: "1", unitPrice: "749.00", discountAmount: "0", taxable: false }],
    })).rejects.toThrow(/bill 300.00 now/);
  });

  it("lets it through on a warn contract, and leaves a deadline saying so", async () => {
    await contracts.updateContract(owner(), { id: contractId, notToExceedAction: "warn" });
    const jobId = await workedJob(client, site, [{ priceBookItemId: motor, quantity: "1" }]);
    const result = await jobBilling.bill(owner(), { jobId });
    const due = await obligations.open(owner(), { kind: "contract.over_not_to_exceed" });
    expect(due.some((o) => o.entityId === result.invoices[0]!.id)).toBe(true);
    await contracts.updateContract(owner(), { id: contractId, notToExceedAction: "hold" });
  });

  it("gives way to an authorisation the client raised on the job", async () => {
    const jobId = await workedJob(client, site, [{ priceBookItemId: motor, quantity: "1" }]);
    await commercial.authorize(owner(), { jobId, amount: "1000.00", grantedByName: "Northgate AP" });
    const result = await jobBilling.bill(owner(), { jobId });
    expect(result.invoices).toHaveLength(1);
  });
});

run("the contract's clocks", () => {
  let client = "", site = "", contractId = "";

  beforeAll(async () => {
    client = (await person("Harbor Property Group", "commercial")).id;
    site = (await place("77 Harbor Rd", client)).id;
    contractId = (await contracts.createContract(owner(), {
      customerId: client, name: "Harbor SLA",
      slaTerms: [{ kind: "respond", minutes: 120 }, { kind: "arrive", minutes: 240 }, { kind: "arrive", minutes: 60, priority: "emergency" }],
      invoiceWithinDays: 30,
    })).id;
  });

  it("refuses a clock nobody could be held to", async () => {
    await expect(contracts.createContract(owner(), {
      customerId: client, name: "Bad", slaTerms: [{ kind: "acknowledge", minutes: 60 }],
    })).rejects.toThrow(/respond, arrive or complete/);
  });

  it("raises the clocks when the job runs under the contract, emergency terms included", async () => {
    const job = await jobs.create(owner(), {
      customerId: client, propertyId: site, summary: "No cooling in the server room", tags: [], customFields: {}, priority: 2,
    });
    await jobBilling.setContract(owner(), { jobId: job.id as string, contractId });
    const { clocks } = await jobBilling.clocks(owner(), { jobId: job.id as string });
    expect(clocks.map((c) => c.kind).sort()).toEqual(["sla.arrive", "sla.respond"]);
    const arrive = clocks.find((c) => c.kind === "sla.arrive")!;
    expect(arrive.dueAt.getTime() - new Date(job.createdAt as unknown as string).getTime()).toBe(60 * 60_000);
  });

  it("puts a breach in the queue, raises a task for it, and clears it when the fact arrives", async () => {
    const job = await jobs.create(owner(), {
      customerId: client, propertyId: site, summary: "Leak at unit 4", tags: [], customFields: {},
    });
    const jobId = job.id as string;
    /** Received five hours ago: both clocks have run out. */
    await raw`update public.job set created_at = now() - interval '5 hours' where id = ${jobId}`;
    await jobBilling.setContract(owner(), { jobId, contractId });

    const overdue = (await obligations.open(owner(), { overdueOnly: true })).filter((o) => o.entityId === jobId);
    expect(overdue.map((o) => o.kind).sort()).toEqual(["sla.arrive", "sla.respond"]);

    const swept = await obligations.sweep(owner());
    expect(swept.breached).toBeGreaterThanOrEqual(2);
    expect(swept.escalated).toBeGreaterThanOrEqual(2);
    const tasks = await raw<{ title: string; priority: string }[]>`
      select title, priority from public.task where entity_type = 'job' and entity_id = ${jobId} order by title`;
    expect(tasks.map((t) => t.title)).toEqual([`On site by: job ${job.number}`, `Respond by: job ${job.number}`]);
    expect(tasks.every((t) => t.priority === "high")).toBe(true);
    /** And again: nothing raised twice. */
    await obligations.sweep(owner());
    const [again] = await raw<{ n: number }[]>`select count(*)::int as n from public.task where entity_id = ${jobId}`;
    expect(again!.n).toBe(2);

    /** The visit is booked and the technician arrives: the queue drops them before any worker pass. */
    await jobs.addVisit(owner(), {
      id: jobId, windowStart: new Date(Date.now() + 3600_000).toISOString(),
      windowEnd: new Date(Date.now() + 7200_000).toISOString(), estimatedDurationMinutes: 60, technicianIds: [],
    } as Parameters<typeof jobs.addVisit>[1]);
    await raw`update public.visit set arrived_at = now() where job_id = ${jobId}`;
    expect((await obligations.open(owner(), {})).filter((o) => o.entityId === jobId)).toEqual([]);

    /** The worker records it as met, late, with the fact that met it, and closes the tasks. */
    await clockPass(db(), { force: true });
    const { clocks } = await jobBilling.clocks(owner(), { jobId });
    expect(clocks.find((c) => c.kind === "sla.arrive")).toMatchObject({ standing: "met_late" });
    expect(clocks.find((c) => c.kind === "sla.arrive")!.satisfiedByEvent).toMatch(/technician arrived/);
    const open = await raw<{ n: number }[]>`select count(*)::int as n from public.task where entity_id = ${jobId} and status = 'open'`;
    expect(open[0]!.n).toBe(0);
  });

  it("starts the invoicing window when the work is done, and an invoice meets it", async () => {
    const jobId = await workedJob(client, site, [{ priceBookItemId: flush, quantity: "1" }]);
    await jobBilling.setContract(owner(), { jobId, contractId });
    let clocks = (await jobBilling.clocks(owner(), { jobId })).clocks;
    expect(clocks.find((c) => c.kind === "invoice.submit_by")?.standing).toBe("due");
    await jobBilling.bill(owner(), { jobId });
    clocks = (await jobBilling.clocks(owner(), { jobId })).clocks;
    expect(clocks.find((c) => c.kind === "invoice.submit_by")?.standing).toBe("met");
  });

  it("cancels the clocks when the contract comes off the job", async () => {
    const job = await jobs.create(owner(), { customerId: homeowner, propertyId: home, summary: "x", tags: [], customFields: {} });
    await commercial.setParties(owner(), { jobId: job.id as string, parties: [{ role: "payer", customerId: client }] });
    await jobBilling.setContract(owner(), { jobId: job.id as string, contractId });
    await jobBilling.setContract(owner(), { jobId: job.id as string, contractId: null });
    await commercial.setParties(owner(), { jobId: job.id as string, parties: [] });
    await obligations.sweep(owner());
    const { clocks } = await jobBilling.clocks(owner(), { jobId: job.id as string });
    expect(clocks.every((c) => c.standing === "cancelled")).toBe(true);
  });

  it("refuses a contract with somebody who is not on the job", async () => {
    const job = await jobs.create(owner(), { customerId: homeowner, propertyId: home, summary: "x", tags: [], customFields: {} });
    await expect(jobBilling.setContract(owner(), { jobId: job.id as string, contractId }))
      .rejects.toThrow(/not on this job/);
  });
});

run("a home warranty job billed in two parts", () => {
  let warrantyCard = "";

  beforeAll(async () => {
    const contract = await contracts.createContract(owner(), {
      customerId: warrantyCo, name: "Shield network agreement", claimWithinDays: 60, invoiceFormat: "csv",
    });
    warrantyCard = (await contracts.createRateCard(owner(), {
      name: "Shield schedule", contractId: contract.id, authority: "warranty_network",
    })).id;
    await rateCards.setTerms(owner(), {
      rateCardId: warrantyCard,
      labourRates: [{ band: "standard", hourlyRate: "85.00" }],
      materialMarkup: [{ upToCost: null, percent: "0.1" }],
    });
  });

  async function warrantyJob() {
    const jobId = await workedJob(homeowner, home, [
      { priceBookItemId: labourItem, quantity: "2" },
      { priceBookItemId: motor, quantity: "1" },
      { priceBookItemId: flush, quantity: "1" },
    ]);
    await entitlements.resolve(owner(), {
      jobId, source: "home_warranty", customerResponsibility: "100.00", externalReference: "SHW-5521",
    });
    await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: warrantyCo }] });
    return jobId;
  }

  it("says who pays for the covered work before it can be billed", async () => {
    const jobId = await workedJob(homeowner, home, [{ priceBookItemId: motor, quantity: "1" }]);
    await entitlements.resolve(owner(), { jobId, source: "home_warranty" });
    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.problems.join(" ")).toMatch(/Choose them under Pays/);
    await expect(jobBilling.bill(owner(), { jobId })).rejects.toBeInstanceOf(ConflictError);
  });

  it("prices covered work by the warranty schedule and the rest by our book, and adds up to the cent", async () => {
    const jobId = await warrantyJob();
    const plan = await jobBilling.preview(owner(), { jobId });
    expect(plan.basis).toBe("coverage");
    const by = (name: string) => plan.lines.find((l) => l.name === name)!;
    /** Labour and the motor are covered, so the network's schedule prices them. */
    expect(by("Labour, per hour")).toMatchObject({ authority: "warranty_network", unitPrice: "85.0000" });
    expect(by("Condenser fan motor")).toMatchObject({ authority: "warranty_network", unitPrice: "220.0000" });
    /** The flush is not covered, so it is the homeowner's at our price. */
    expect(by("Drain flush")).toMatchObject({ authority: "price_book", outOfScope: false });
    expect(plan.pricedTotal).toBe("540.0000");

    const shield = plan.payers.find((p) => p.role === "third_party")!;
    const hana = plan.payers.find((p) => p.role === "customer")!;
    expect(shield.total).toBe("290.0000");
    expect(hana.total).toBe("250.0000");
    expect(plan.reconciles).toBe(true);
  });

  it("raises two invoices that reconcile to the job, posted to two receivables", async () => {
    const before = await ledgerBalances();
    const shieldBefore = await receivableOf(warrantyCo);
    const jobId = await warrantyJob();
    const result = await jobBilling.bill(owner(), { jobId }, );
    expect(result.basis).toBe("coverage");
    expect(result.invoices.map((i) => i.total).sort()).toEqual(["250.0000", "290.0000"]);
    expect(result.invoicedTotal).toBe("540.0000");

    const shield = await billing.get(owner(), { id: result.invoices.find((i) => i.customerId === warrantyCo)!.id });
    const hana = await billing.get(owner(), { id: result.invoices.find((i) => i.customerId === homeowner)!.id });
    /** The deductible comes out of the covered work, shown on both sides of the split line. */
    const split = hana.lines.filter((l) => l.priceBasis === "share");
    expect(split.length).toBeGreaterThan(0);
    expect(split[0]!.description).toMatch(/billed to Shield Home Warranty/);
    expect(shield.lines.every((l) => l.coverageSource === "home_warranty")).toBe(true);
    expect(hana.lines.find((l) => l.name === "Drain flush")!.lineTotal).toBe("150.0000");

    const after = await ledgerBalances();
    expect(after.debits).toBe(after.credits);
    expect(Number(after.debits) - Number(before.debits)).toBe(540);
    expect(Number(await receivableOf(warrantyCo)) - Number(shieldBefore)).toBe(290);

    /** Billing it again bills nothing: every line is billed. */
    expect((await jobBilling.preview(owner(), { jobId })).problems.join(" ")).toMatch(/Nothing on this job is still to bill/);
  });

  it("replays a retried request rather than billing twice", async () => {
    const jobId = await warrantyJob();
    const first = await jobBilling.bill(owner("bill-twice"), { jobId });
    const second = await jobBilling.bill(owner("bill-twice"), { jobId });
    expect(second.invoices.map((i) => i.id)).toEqual(first.invoices.map((i) => i.id));
  });

  it("takes the customer's share off an ordinary invoice automatically", async () => {
    const jobId = await workedJob(homeowner, home, [{ priceBookItemId: motor, quantity: "1" }]);
    await entitlements.resolve(owner(), { jobId, source: "parts_warranty", customerResponsibility: "50.00" });
    const lines = (await jobs.lines(owner(), { id: jobId })).data;
    const invoice = await billing.create(owner(), {
      customerId: homeowner, jobId,
      lines: [{ jobLineId: lines[0]!.id, name: "Condenser fan motor", quantity: "1", unitPrice: "749.00", discountAmount: "0", taxable: false }],
    });
    /** The manufacturer covers the part, less the 50.00 the customer still owes. */
    expect(invoice.total).toBe("50.0000");
    expect(invoice.lines[0]!.description).toMatch(/Parts warranty covers 699.00 of 749.00/);
  });

  run("the claim", () => {
    let claimId = "", invoiceId = "";

    beforeAll(async () => {
      const jobId = await warrantyJob();
      const result = await jobBilling.bill(owner(), { jobId });
      invoiceId = result.invoices.find((i) => i.customerId === warrantyCo)!.id;
    });

    it("is refused on the customer's own invoice", async () => {
      const jobId = await warrantyJob();
      const result = await jobBilling.bill(owner(), { jobId });
      const theirs = result.invoices.find((i) => i.customerId === homeowner)!.id;
      await expect(claims.file(owner(), { invoiceId: theirs })).rejects.toThrow(/customer's own/);
    });

    it("is filed against the third party, once, and meets the claim clock", async () => {
      const claim = await claims.file(owner(), { invoiceId, externalReference: "SHW-5521" });
      claimId = claim.id;
      expect(claim).toMatchObject({ status: "submitted", claimedAmount: "290.0000", payerName: "Shield Home Warranty", source: "home_warranty" });
      await expect(claims.file(owner(), { invoiceId })).rejects.toThrow(/already has a claim/);
      const { clocks } = await jobBilling.clocks(owner(), { jobId: claim.jobId });
      expect(clocks.find((c) => c.kind === "claim.file_by")?.standing).toBe("met");
    });

    it("is approved for less, then paid in full of what they agreed", async () => {
      await expect(claims.decide(owner(), { id: claimId, outcome: "approved", amount: "400.00" })).rejects.toThrow(/cannot approve/);
      const approved = await claims.decide(owner(), { id: claimId, outcome: "approved", amount: "260.00" });
      expect(approved).toMatchObject({ status: "approved", approvedAmount: "260.0000", shortfall: "30.0000" });
      await expect(claims.recordPayment(owner(), { id: claimId, amount: "270.00", method: "ach" })).rejects.toThrow(/not for this claim/);
      const paid = await claims.recordPayment(owner(), { id: claimId, amount: "260.00", method: "check", reference: "88112" });
      expect(paid).toMatchObject({ status: "paid", paidAmount: "260.0000", outstanding: "0.0000", invoiceBalance: "30.0000" });
      /** The receivable on Shield went down by what they paid. */
      const ledger = await ledgerBalances();
      expect(ledger.debits).toBe(ledger.credits);
    });

    it("is short paid when less arrives than they approved", async () => {
      const jobId = await warrantyJob();
      const result = await jobBilling.bill(owner(), { jobId });
      const claim = await claims.file(owner(), { invoiceId: result.invoices.find((i) => i.customerId === warrantyCo)!.id });
      const short = await claims.recordPayment(owner(), { id: claim.id, amount: "200.00", method: "ach" });
      expect(short).toMatchObject({ status: "short_paid", shortfall: "90.0000", outstanding: "90.0000" });
    });

    it("is denied with their reason, and that is final", async () => {
      const jobId = await warrantyJob();
      const result = await jobBilling.bill(owner(), { jobId });
      const claim = await claims.file(owner(), { invoiceId: result.invoices.find((i) => i.customerId === warrantyCo)!.id });
      await expect(claims.decide(owner(), { id: claim.id, outcome: "denied" })).rejects.toThrow(/Say why/);
      const denied = await claims.decide(owner(), { id: claim.id, outcome: "denied", note: "Pre-existing condition" });
      expect(denied.status).toBe("denied");
      await expect(claims.decide(owner(), { id: claim.id, outcome: "approved" })).rejects.toThrow(/new claim/);
      expect((await claims.list(owner(), { status: ["denied"] })).some((c) => c.id === claim.id)).toBe(true);
    });
  });

  it("hands the warranty company a file in their format and a link to their invoices", async () => {
    await expect(payerDelivery.exportInvoices(owner(), { customerId: warrantyCo, format: "xml" })).rejects.toThrow(/takes CSV/);
    const file = await payerDelivery.exportInvoices(owner(), { customerId: warrantyCo });
    expect(file.format).toBe("csv");
    expect(file.body.split("\r\n")[0]).toMatch(/^invoice_number,issued_on,due_on/);
    expect(file.body).toMatch(/Warranty network schedule/);
    expect(file.body).not.toMatch(/45\.00,/);

    const delivered = await raw<{ channel: string }[]>`
      select d.channel from public.invoice_delivery d join public.invoice i on i.id = d.invoice_id
      where i.customer_id = ${warrantyCo} and d.channel = 'manual'`;
    expect(delivered.length).toBe(file.invoiceCount);

    const link = await payerDelivery.issuePortalLink(owner(), { customerId: warrantyCo });
    const token = link.url.split("/").pop()!;
    const page = await payerDelivery.viewPortal(db(), { token });
    expect(page.payerName).toBe("Shield Home Warranty");
    expect(page.invoices.length).toBeGreaterThan(0);
    /** Their invoices only: nothing addressed to the homeowner. */
    expect(page.invoices.every((i) => i.lines.every((l) => l.priceAuthority !== "Our price book"))).toBe(true);
    const csv = await payerDelivery.portalCsv(db(), { token });
    expect(csv.startsWith("invoice_number")).toBe(true);
  });

  it("refuses a payer link read as anything else", async () => {
    const link = await payerDelivery.issuePortalLink(owner(), { customerId: warrantyCo });
    const token = link.url.split("/").pop()!;
    const { viewInvoice } = await import("../src/services/invoice-delivery");
    await expect(viewInvoice(db(), { token })).rejects.toThrow();
  });
});

run("coverage read from the unit's warranty", () => {
  it("covers what was in force on the day of the visit", async () => {
    const [unit] = await raw<{ id: string }[]>`
      insert into public.equipment (organization_id, property_id, category, manufacturer, model,
        warranty_parts_expires_on, warranty_labor_expires_on)
      values (${ORG}, ${home}, 'Condenser', 'Carrier', '24ACC6', '2027-01-01', '2026-09-30') returning id`;
    const jobId = await workedJob(homeowner, home, [{ priceBookItemId: motor, quantity: "1" }], { equipmentId: unit!.id });
    const result = await jobBilling.coverageFromEquipment(owner(), { jobId });
    expect(result).toMatchObject({ resolved: true, source: "parts_warranty", coversParts: true, coversLabour: false, on: "2026-10-06" });
    const terms = await entitlements.forJob(owner(), { jobId });
    expect(terms?.grantingEntityType).toBe("equipment");
  });

  it("says when the unit was out of warranty, and writes nothing", async () => {
    const [unit] = await raw<{ id: string }[]>`
      insert into public.equipment (organization_id, property_id, category, warranty_parts_expires_on)
      values (${ORG}, ${home}, 'Water heater', '2025-03-01') returning id`;
    const jobId = await workedJob(homeowner, home, [{ priceBookItemId: flush, quantity: "1" }], { equipmentId: unit!.id });
    const result = await jobBilling.coverageFromEquipment(owner(), { jobId });
    expect(result.resolved).toBe(false);
    expect(await entitlements.forJob(owner(), { jobId })).toBeNull();
  });
});

run("shares between two payers", () => {
  it("bills an owner seventy per cent and the tenant the rest", async () => {
    const owner2 = (await person("Lakeside Owners LLC", "commercial")).id;
    const tenant = (await person("Tom Tenant", "residential")).id;
    const flat = (await place("5 Lakeside Dr", tenant)).id;
    const jobId = await workedJob(tenant, flat, [{ priceBookItemId: flush, quantity: "1" }, { priceBookItemId: capacitor, quantity: "1" }]);
    await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: owner2, sharePercent: "0.7" }] });
    const result = await jobBilling.bill(owner(), { jobId });
    expect(result.basis).toBe("shares");
    const totals = Object.fromEntries(result.invoices.map((i) => [i.customerName, i.total]));
    expect(totals).toEqual({ "Lakeside Owners LLC": "307.3000", "Tom Tenant": "131.7000" });
  });
});

run("tax on a job billed in parts", () => {
  /** What the ledger holds as sales tax collected from one customer. */
  async function taxCollectedFrom(customerId: string) {
    const [row] = await raw<{ tax: string }[]>`
      select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::text as tax
      from public.ledger_entry
      where organization_id = ${ORG} and account_code = '2200' and customer_id = ${customerId}`;
    return row!.tax;
  }

  it("taxes each payer on their own half and adds up to the tax on the whole job, to the cent", async () => {
    const filter = (await priceBook.create(owner(), {
      kind: "material", code: "FILT-T", name: "Pleated filter", price: "33.35", cost: "9.00", taxable: true,
    })).id;
    const landlord = (await person("Harbor Rentals", "commercial")).id;
    const tenant = (await person("Tia Tenant", "residential")).id;
    const flat = (await place("8 Harbor Ln", tenant)).id;
    const jobId = await workedJob(tenant, flat, [{ priceBookItemId: filter, quantity: "1" }]);
    await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: landlord, sharePercent: "0.5" }] });

    /**
     * 33.35 at five per cent is 1.6675 of tax, which is 1.67. Halved, the
     * parts are 16.68 and 16.67 and their tax 0.834 and 0.8335: rounded on
     * each invoice separately that is 0.83 twice, a cent short of the job.
     */
    const plan = await jobBilling.preview(owner(), { jobId, taxRate: "0.05" });
    expect(plan.taxTotal).toBe("1.6700");
    const of = (id: string) => plan.payers.find((p) => p.customerId === id)!;
    expect(of(landlord)).toMatchObject({ total: "16.6800", taxTotal: "0.8400", totalWithTax: "17.5200" });
    expect(of(tenant)).toMatchObject({ total: "16.6700", taxTotal: "0.8300", totalWithTax: "17.5000" });
    expect(plan.lines[0]!.taxRate).toBe("0.05");

    const before = await ledgerBalances();
    const result = await jobBilling.bill(owner(), { jobId, taxRate: "0.05" });
    expect(result.taxTotal).toBe("1.6700");
    const landlordInvoice = await billing.get(owner(), { id: result.invoices.find((i) => i.customerId === landlord)!.id });
    const tenantInvoice = await billing.get(owner(), { id: result.invoices.find((i) => i.customerId === tenant)!.id });
    expect(landlordInvoice).toMatchObject({ subtotal: "16.6800", taxTotal: "0.8400", total: "17.5200" });
    expect(tenantInvoice).toMatchObject({ subtotal: "16.6700", taxTotal: "0.8300", total: "17.5000" });
    /** The tax follows the line: each invoice's line carries the rate and its own part's tax. */
    expect(landlordInvoice.lines[0]).toMatchObject({ taxRate: "0.050000", taxAmount: "0.8400" });
    expect(tenantInvoice.lines[0]).toMatchObject({ taxRate: "0.050000", taxAmount: "0.8300" });

    /** Posted as collected from each payer, and the books still balance. */
    expect(await taxCollectedFrom(landlord)).toBe("0.8400");
    expect(await taxCollectedFrom(tenant)).toBe("0.8300");
    const after = await ledgerBalances();
    expect(after.debits).toBe(after.credits);
    expect(m(after.debits) - m(before.debits)).toBe(m("35.0200"));
  });

  it("charges a tax exempt payer nothing on their part, and the other payer on theirs", async () => {
    const valve = (await priceBook.create(owner(), {
      kind: "material", code: "VALVE-T", name: "Mixing valve", price: "212.47", cost: "80.00", taxable: true,
    })).id;
    const church = (await customers.create(owner(), {
      type: "commercial", name: "Grace Chapel", phone: "+15125550777",
      paymentTermsDays: 30, taxExempt: true, tags: [], customFields: {},
    })).id;
    const caretaker = (await person("Cal Caretaker", "residential")).id;
    const rectory = (await place("1 Chapel Rd", caretaker)).id;
    const jobId = await workedJob(caretaker, rectory, [{ priceBookItemId: valve, quantity: "1" }]);
    await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: church, sharePercent: "0.7" }] });

    const result = await jobBilling.bill(owner(), { jobId, taxRate: "0.0825" });
    const chapel = await billing.get(owner(), { id: result.invoices.find((i) => i.customerId === church)!.id });
    const cal = await billing.get(owner(), { id: result.invoices.find((i) => i.customerId === caretaker)!.id });
    /** 212.47 at seventy per cent is 148.73; the caretaker's 63.74 at 8.25% is 5.25855, so 5.26. */
    expect(chapel).toMatchObject({ subtotal: "148.7300", taxTotal: "0.0000", total: "148.7300" });
    expect(cal).toMatchObject({ subtotal: "63.7400", taxTotal: "5.2600", total: "69.0000" });
    expect(result.taxTotal).toBe("5.2600");
    expect(Number(await taxCollectedFrom(church))).toBe(0);
    expect(await taxCollectedFrom(caretaker)).toBe("5.2600");
  });

  it("refuses a rate written as a percentage, and bills nothing", async () => {
    const jobId = await workedJob(homeowner, home, [{ priceBookItemId: flush, quantity: "1" }]);
    await expect(jobBilling.preview(owner(), { jobId, taxRate: "8.25" })).rejects.toThrow(/Write 0.0825/);
  });
});

/** Whole cents as a number of cents, for comparing sums of money without a float. */
function m(value: string): number {
  const [whole = "0", frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}
