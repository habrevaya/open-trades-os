import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as contracts from "../src/services/contracts";
import * as contractBilling from "../src/services/contract-billing";
import * as escalation from "../src/services/contract-escalation";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A CONTRACT'S FIXED FEE RISING WITH ITS ESCALATION
 *
 * Harbor's contract rises 3% a year and bills 1,200.00 a month on the day of
 * the month it started, from its anniversary. Left as it is, the fee does not rise: it is not on
 * the preview. Its schedule set to rise with the escalation, the preview
 * shows it at 1,236.00 from the anniversary, the worker's draft prepares it
 * and the task says it, and a person applying the year's prices makes it the
 * fee for every period from the anniversary. A rise naming one card is not
 * the fee's; a rise for the year is. A fee typed afresh replaces the rise.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("feerise:org");
const USER = fixtureId("feerise:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

let clientId = "";

/**
 * An anniversary three to four weeks away whose day of the month a schedule
 * can bill on (1 to 28), so the period that starts on it is the next one.
 */
function anniversaryAhead(): string {
  for (let days = 21; days <= 30; days += 1) {
    const date = time.addDays(companyToday(), days);
    if (Number(date.slice(8, 10)) <= 28) return date;
  }
  throw new Error("No anniversary three to four weeks ahead falls on day 28 or before.");
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fee Rise Co", slug: "fee-rise-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  clientId = (await customers.create(owner(), {
    type: "commercial", name: "Harbor Facilities", phone: "+15125550731",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  })).id;
});

/** The contract, a year old on the anniversary, with a card when asked and a monthly fee that rises when asked. */
async function harbor(options: { card?: boolean; rises?: boolean } = {}) {
  const anniversary = anniversaryAhead();
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;
  const contract = await contracts.createContract(owner(), { customerId: clientId, name: "Harbor MSA", startsOn, escalationRate: "0.03" });
  const card = options.card === false ? null
    : await contracts.createRateCard(owner(), { name: "Harbor schedule", contractId: contract.id, effectiveFrom: startsOn });
  if (card) {
    await contracts.setRateCardLines(owner(), {
      rateCardId: card.id, lines: [{ externalCode: "FLT", description: "Filter change", price: "100.00" }],
    });
  }
  await contractBilling.set(owner(), {
    contractId: contract.id, amount: "1200.00", frequency: "monthly", billingDay: Number(anniversary.slice(8, 10)),
    startsOn: anniversary, description: "Planned maintenance, both sites",
    ...(options.rises ? { risesWithEscalation: true } : {}),
  });
  return { contract, card, anniversary };
}

run("a fixed fee and the escalation", () => {
  it("does not rise unless its schedule says so", async () => {
    const { contract } = await harbor();
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown.fee).toBeNull();
    expect((await contractBilling.view(owner(), { contractId: contract.id })).schedule).toMatchObject({ risesWithEscalation: false, fees: [] });
  });

  it("is shown risen beside the cards, prepared in the draft and said in the task", async () => {
    const { contract, anniversary } = await harbor({ rises: true });
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown.fee).toEqual({
      before: "1200.0000", after: "1236.0000", rate: "0.030000", because: "The contract's yearly rate", per: "a month",
    });

    const pass = await escalation.noticesFor(db(), ORG);
    expect(pass.raised).toEqual([contract.id]);
    const [notice] = await raw<{ fee_draft: string }[]>`select fee_draft::text from public.contract_escalation_notice where contract_id = ${contract.id}`;
    expect(notice!.fee_draft).toBe("1236.0000");
    const [task] = await raw<{ body: string }[]>`select body from public.task where organization_id = ${ORG}`;
    expect(task!.body).toContain("The fixed fee rises with them, from 1200.00 to 1236.00 a month.");
    expect((await escalation.preview(owner(), { contractId: contract.id })).feeDraft).toMatchObject({ amount: "1236.0000" });

    /** The draft is for looking at: until a person applies it, the period from the anniversary is billed at the fee now. */
    const before = await contractBilling.view(owner(), { contractId: contract.id });
    expect(before.next).toMatchObject({ start: anniversary, amount: "1200.0000" });
  });

  it("rises by the year's rise for every card, never by a rise naming one card", async () => {
    const { contract, card } = await harbor({ rises: true });
    await escalation.setRises(owner(), { contractId: contract.id, rises: [{ rateCardId: card!.id, rate: "0.05" }] });
    expect((await escalation.preview(owner(), { contractId: contract.id })).fee).toMatchObject({
      after: "1236.0000", because: "The contract's yearly rate",
    });
    await escalation.setRises(owner(), { contractId: contract.id, rises: [{ contractYear: 2, rate: "0.04" }] });
    expect((await escalation.preview(owner(), { contractId: contract.id })).fee).toMatchObject({
      after: "1248.0000", rate: "0.040000", because: "Year 2",
    });
  });

  it("is applied by a person with the rest of the rise, as the fee from the anniversary", async () => {
    const { contract, anniversary } = await harbor({ rises: true });
    const shown = await escalation.preview(owner(), { contractId: contract.id });

    /** One rate does not say what was shown when the fee rises too. */
    await expect(escalation.apply(owner(), { contractId: contract.id, anniversary, rate: "0.03" }))
      .rejects.toThrow("The fixed fee rises with year 2's prices, so one rate does not say what was shown. Apply it from the preview, which shows the fee.");

    /** A fee changed since the preview is a different rise. */
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1250.00", frequency: "monthly", billingDay: Number(anniversary.slice(8, 10)),
      description: "Planned maintenance, both sites",
    });
    await expect(escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! }))
      .rejects.toThrow(/its fixed fee, have changed/);
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1200.00", frequency: "monthly", billingDay: Number(anniversary.slice(8, 10)),
      description: "Planned maintenance, both sites",
    });

    const done = await escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! });
    expect(done.fee).toEqual({ from: anniversary, amount: "1236.0000", previousAmount: "1200.0000", rate: "0.030000" });
    expect(done.cards).toHaveLength(1);
    const view = await contractBilling.view(owner(), { contractId: contract.id });
    expect(view.schedule!.fees).toEqual([{ from: anniversary, amount: "1236.0000", previousAmount: "1200.0000", rate: "0.030000" }]);
    expect(view.next).toMatchObject({ start: anniversary, amount: "1236.0000" });
    const [audit] = await raw<{ after: { fee: { amount: string } } }[]>`select after from public.audit_log
      where organization_id = ${ORG} and action = 'contract.escalated' and entity_id = ${contract.id}`;
    expect(audit!.after.fee.amount).toBe("1236.0000");

    /** A retry answers with what it made. */
    expect((await escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! })).fee).toEqual(done.fee);

    /** A fee typed afresh is the fee meant: it replaces the rise for every period not yet billed. */
    await contractBilling.set(owner(), {
      contractId: contract.id, amount: "1300.00", frequency: "monthly", billingDay: Number(anniversary.slice(8, 10)),
      description: "Planned maintenance, both sites",
    });
    const typed = await contractBilling.view(owner(), { contractId: contract.id });
    expect(typed.schedule!.fees).toEqual([]);
    expect(typed.next).toMatchObject({ start: anniversary, amount: "1300.0000" });
  });

  it("rises on a contract whose only price is its fixed fee", async () => {
    const { contract, anniversary } = await harbor({ card: false, rises: true });
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown.problem).toBeNull();
    expect(shown.cards).toEqual([]);
    const done = await escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! });
    expect(done).toMatchObject({ cards: [], fee: { amount: "1236.0000" } });
  });
});
