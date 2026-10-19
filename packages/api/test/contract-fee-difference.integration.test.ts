import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, PermissionError, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as contracts from "../src/services/contracts";
import * as rateCards from "../src/services/rate-cards";
import * as contractBilling from "../src/services/contract-billing";
import * as escalation from "../src/services/contract-escalation";
import * as billing from "../src/services/billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A RISE BY A FIXED AMOUNT, AND A RISE APPLIED LATE
 *
 * Harbor's contract says labour rises 2.00 an hour a year and the monthly fee
 * 50.00 a month. The preview adds the amounts, to the cent, and applying them
 * writes them. Applied six weeks after the anniversary, the two months from
 * it that were already billed at 1,200.00 keep their invoices, and the
 * contract offers what each is short, period by period: one put on a draft
 * invoice when somebody asks, the other waived, and nothing billed by itself.
 * Deleting the draft offers its period again.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("feediff:org");
const USER = fixtureId("feediff:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

let clientId = "";
let plumbing = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fee Difference Co", slug: "fee-difference-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  clientId = (await customers.create(owner(), {
    type: "commercial", name: "Harbor Facilities", phone: "+15125550744",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  })).id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Plumbing') returning id`;
  plumbing = type!.id;
});

/** An anniversary between five and eight weeks ago whose day a schedule can bill on, so two months from it are billed. */
function anniversaryBehind(): string {
  for (let days = 36; days <= 56; days += 1) {
    const date = time.addDays(companyToday(), -days);
    if (Number(date.slice(8, 10)) <= 28) return date;
  }
  throw new Error("No anniversary five to eight weeks back falls on day 28 or before.");
}

/** The contract a year and some weeks old, billed every month on its day from its start, every period raised. */
async function harborBilledThrough() {
  const anniversary = anniversaryBehind();
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;
  const contract = await contracts.createContract(owner(), { customerId: clientId, name: "Harbor MSA", startsOn, escalationRate: "0.03" });
  await contractBilling.set(owner(), {
    contractId: contract.id, amount: "1200.00", frequency: "monthly", billingDay: Number(anniversary.slice(8, 10)),
    startsOn, description: "Planned maintenance, both sites", risesWithEscalation: true,
  });
  /** Twelve at a time, so twice to reach today. */
  await contractBilling.raiseDue(owner(), { contractId: contract.id });
  await contractBilling.raiseDue(owner(), { contractId: contract.id });
  return { contract, anniversary, startsOn };
}

run("a rise by a fixed amount", () => {
  it("adds the amount to the prices it covers, and refuses a row that says both", async () => {
    const anniversary = companyToday(10);
    const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;
    const contract = await contracts.createContract(owner(), { customerId: clientId, name: "Harbor MSA", startsOn, escalationRate: "0.03" });
    const card = await contracts.createRateCard(owner(), { name: "Harbor schedule", contractId: contract.id, effectiveFrom: startsOn });
    await contracts.setRateCardLines(owner(), {
      rateCardId: card.id, lines: [{ externalCode: "FLT", description: "Filter change", price: "100.00" }],
    });
    await rateCards.setTerms(owner(), {
      rateCardId: card.id, labourRates: [{ band: "standard", hourlyRate: "95.00", jobTypeId: plumbing }], materialMarkup: [],
    });

    await expect(escalation.setRises(owner(), { contractId: contract.id, rises: [{ jobTypeId: plumbing, rate: "0.03", amount: "2.00" }] }))
      .rejects.toThrow(/both a per cent and an amount/);
    const saved = await escalation.setRises(owner(), { contractId: contract.id, rises: [{ jobTypeId: plumbing, amount: "2.00" }] });
    expect(saved).toMatchObject([{ jobTypeId: plumbing, rate: "0.000000", amount: "2.0000", fee: false }]);

    const shown = await escalation.preview(owner(), { contractId: contract.id });
    const [hourly] = shown.cards[0]!.labourRates;
    expect(hourly).toMatchObject({ before: "95.0000", after: "97.0000", amount: "2.0000", because: "Every year, Plumbing hourly rates" });
    /** A listed price is not a trade's, so it rises by the contract's rate, and says nothing about an amount. */
    expect(shown.cards[0]!.lines[0]).toEqual(expect.objectContaining({ after: "103.0000", because: "The contract's yearly rate" }));
    expect(shown.cards[0]!.lines[0]).not.toHaveProperty("amount");

    const done = await escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! });
    const next = await rateCards.terms(owner(), { rateCardId: done.cards[0]!.rateCardId });
    expect(next.labourRates.map((r) => r.hourlyRate)).toEqual(["97.0000"]);
  });
});

run("a rise of the fee applied late", () => {
  it("offers what each period billed at the old fee is short, and bills it only when asked", async () => {
    const { contract, anniversary } = await harborBilledThrough();
    await escalation.setRises(owner(), { contractId: contract.id, rises: [{ fee: true, amount: "50.00" }] });
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown).toMatchObject({ anniversary, ready: true, problem: null });
    expect(shown.fee).toMatchObject({ before: "1200.0000", after: "1250.0000", amount: "50.0000", because: "Every year, the fixed fee" });

    const before = await contractBilling.view(owner(), { contractId: contract.id });
    const fromAnniversary = before.periods.filter((p) => p.start >= anniversary);
    expect(fromAnniversary).toHaveLength(2);
    expect(before.differences).toEqual([]);

    const done = await escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! });
    expect(done.fee).toMatchObject({ from: anniversary, amount: "1250.0000", rate: "0.000000", riseAmount: "50.0000" });
    expect(done.billedAtOldFee).toBe(2);

    const offered = (await contractBilling.view(owner(), { contractId: contract.id })).differences;
    expect(offered.map((d) => [d.start, d.billed, d.risen, d.difference, d.status])).toEqual(
      fromAnniversary.map((p) => [p.start, "1200.0000", "1250.0000", "50.0000", "offered"]).sort(),
    );
    /** Nothing was billed by itself: the only invoices are the periods. */
    const [invoices] = await raw<{ count: string }[]>`select count(*)::text as count from public.invoice where organization_id = ${ORG}`;
    expect(Number(invoices!.count)).toBe(before.periods.length);

    /** Only somebody who can raise an invoice can bill it. */
    await expect(contractBilling.draftDifference(as(["readonly"]), { contractId: contract.id, periodIds: [offered[0]!.periodId] }))
      .rejects.toBeInstanceOf(PermissionError);

    const drafted = await contractBilling.draftDifference(owner("diff-1"), { contractId: contract.id, periodIds: [offered[0]!.periodId] });
    expect(drafted).toMatchObject({ periods: 1, total: "50.0000" });
    /** The same press again answers with the same draft. */
    expect(await contractBilling.draftDifference(owner("diff-1"), { contractId: contract.id, periodIds: [offered[0]!.periodId] }))
      .toEqual(drafted);
    const invoice = await billing.get(owner(), { id: drafted.invoiceId });
    expect(invoice).toMatchObject({ status: "draft", customerId: clientId });
    const lines = (invoice as unknown as { lines: Array<{ name: string; description: string | null; unitPrice: string }> }).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.name).toBe(`Planned maintenance, both sites, fee rise from ${anniversary}`);
    expect(lines[0]!.description).toMatch(/1250\.00 at the risen fee, less 1200\.00 billed on invoice \d+/);

    await expect(contractBilling.draftDifference(owner(), { contractId: contract.id, periodIds: [offered[0]!.periodId] }))
      .rejects.toThrow(/already been put on draft invoice/);
    const waived = await contractBilling.waiveDifference(owner(), { contractId: contract.id, periodIds: [offered[1]!.periodId] });
    expect(waived.differences.map((d) => d.status)).toEqual(["drafted", "waived"]);
    await expect(contractBilling.waiveDifference(owner(), { contractId: contract.id, periodIds: [offered[1]!.periodId] }))
      .rejects.toBeInstanceOf(ConflictError);

    /** A draft deleted is a decision not yet made: its period is offered again. */
    await billing.deleteDraft(owner(), { id: drafted.invoiceId });
    const again = (await contractBilling.view(owner(), { contractId: contract.id })).differences;
    expect(again.map((d) => d.status)).toEqual(["offered", "waived"]);
  });

  it("offers nothing for a period billed after the rise, or once a fee typed afresh replaces it", async () => {
    const { contract, anniversary } = await harborBilledThrough();
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown.fee).toMatchObject({ after: "1236.0000", because: "The contract's yearly rate" });
    expect(shown.fee).not.toHaveProperty("amount");
    await escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! });
    expect((await contractBilling.view(owner(), { contractId: contract.id })).differences.map((d) => d.difference))
      .toEqual(["36.0000", "36.0000"]);

    /** Typed afresh, the fee is the fee meant, and it never reaches a period already billed. */
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1300.00", frequency: "monthly", billingDay: Number(anniversary.slice(8, 10)),
      description: "Planned maintenance, both sites",
    });
    expect((await contractBilling.view(owner(), { contractId: contract.id })).differences).toEqual([]);
    await expect(contractBilling.draftDifference(owner(), { contractId: contract.id, periodIds: [contract.id] }))
      .rejects.toThrow(/no difference to bill/);
  });
});
