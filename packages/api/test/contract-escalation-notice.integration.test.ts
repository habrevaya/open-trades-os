import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as contracts from "../src/services/contracts";
import * as rateCards from "../src/services/rate-cards";
import * as escalation from "../src/services/contract-escalation";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A CONTRACT'S ESCALATION COMING DUE, RAISED AND NEVER APPLIED BY ITSELF
 *
 * Thirty days before the anniversary the worker prepares next year's card as
 * a draft and raises one task for the office. The draft is never in force:
 * the client is priced by last year's card until a person applies the rise,
 * however long after the anniversary that is. Applying it removes the draft,
 * writes the card in force from the one in force, and closes the task.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("escnotice:org");
const USER = fixtureId("escnotice:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

let clientId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Escalation Notice Co", slug: "escalation-notice-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  clientId = (await customers.create(owner(), {
    type: "commercial", name: "Harbor Facilities", phone: "+15125550700",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  })).id;
});

/** A contract whose next anniversary is `daysToAnniversary` away, with one card. */
async function contractWithCard(daysToAnniversary: number, rate: string | null = "0.03", withCard = true) {
  const anniversary = companyToday(daysToAnniversary);
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;
  const contract = await contracts.createContract(owner(), {
    customerId: clientId, name: "Harbor MSA", startsOn, escalationRate: rate,
  });
  if (!withCard) return { contract, card: null, anniversary, startsOn };
  const card = await contracts.createRateCard(owner(), { name: "Harbor schedule", contractId: contract.id, effectiveFrom: startsOn });
  await contracts.setRateCardLines(owner(), {
    rateCardId: card.id,
    lines: [{ externalCode: "FLT", description: "Filter change", price: "100.00" }],
  });
  await rateCards.setTerms(owner(), {
    rateCardId: card.id, labourRates: [{ band: "standard", hourlyRate: "90.00" }], materialMarkup: [], tripCharge: "40.00",
  });
  return { contract, card, anniversary, startsOn };
}

const pass = (on?: string) => escalation.noticesFor(db(), ORG, on ? { now: new Date(`${on}T18:00:00Z`) } : {});

const tasks = () => raw<{ id: string; title: string; body: string; queue: string; status: string; entity_type: string; entity_id: string; due_at: Date }[]>`
  select id, title, body, queue, status, entity_type, entity_id, due_at from public.task where organization_id = ${ORG}`;

const drafts = (contractId: string) => raw<{ id: string; name: string; active: boolean; draft_for: string; effective_from: string; trip_charge: string; escalation_rate: string }[]>`
  select id, name, active, draft_for::text, effective_from::text, trip_charge::text, escalation_rate::text
  from public.rate_card where contract_id = ${contractId} and draft_for is not null`;

function pricedOn(on: string) {
  return inTenant(owner(), (tx) => rateCards.cardsFor(tx, ORG, { customerId: clientId, on, timeZone: "America/Chicago" }));
}

run("an escalation coming due", () => {
  it("raises nothing more than thirty days ahead", async () => {
    const { contract } = await contractWithCard(45);
    const result = await pass();
    expect(result).toMatchObject({ raised: [], error: null });
    expect(await tasks()).toHaveLength(0);
    expect(await drafts(contract.id)).toHaveLength(0);
  });

  it("thirty days ahead prepares the draft and raises one task in the office queue, due on the anniversary", async () => {
    const { contract, card, anniversary } = await contractWithCard(25);
    const result = await pass();
    expect(result.raised).toEqual([contract.id]);

    const [task] = await tasks();
    expect(task).toMatchObject({
      title: `Year 2 prices for Harbor MSA are due on ${anniversary}`,
      queue: "office", status: "open", entity_type: "service_contract", entity_id: contract.id,
    });
    expect(task!.body).toContain("rise by 3% on");
    expect(task!.body).toContain("Nothing changes until somebody does.");
    expect(time.dateIn(task!.due_at, "America/Chicago")).toBe(anniversary);

    const [draft] = await drafts(contract.id);
    expect(draft).toMatchObject({
      name: "Harbor schedule (year 2)", active: false, draft_for: anniversary, effective_from: anniversary,
      trip_charge: "41.2000", escalation_rate: "0.030000",
    });
    const [line] = await raw<{ price: string }[]>`select price::text from public.rate_card_line where rate_card_id = ${draft!.id}`;
    expect(line!.price).toBe("103.0000");

    /** A draft prices nothing, and is not one of the contract's cards. */
    expect((await pricedOn(anniversary)).map((c) => c.id)).toEqual([card!.id]);
    const overview = (await contracts.overview(owner())).find((c) => c.id === contract.id)!;
    expect(overview.cards.map((c) => c.id)).toEqual([card!.id]);
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown.drafts).toEqual([expect.objectContaining({ rateCardId: draft!.id, name: "Harbor schedule (year 2)" })]);

    /** Again, and again tomorrow: still one task and one draft. */
    await pass();
    await pass(companyToday(1));
    expect(await tasks()).toHaveLength(1);
    expect(await drafts(contract.id)).toHaveLength(1);
  });

  it("is never applied by itself, however long after the anniversary", async () => {
    const { contract, card, anniversary } = await contractWithCard(5);
    await pass();
    await pass(time.addDays(anniversary, 40));
    const [row] = await raw<{ escalated_through: string | null }[]>`
      select escalated_through::text from public.service_contract where id = ${contract.id}`;
    expect(row!.escalated_through).toBeNull();
    expect((await pricedOn(time.addDays(anniversary, 40))).map((c) => c.id)).toEqual([card!.id]);
    expect(await tasks()).toHaveLength(1);
  });

  it("prepares the draft again when the contract's rate changes, and keeps the one task", async () => {
    const { contract, anniversary } = await contractWithCard(20);
    await pass();
    await raw`update public.service_contract set escalation_rate = 0.05 where id = ${contract.id}`;
    const result = await pass();
    expect(result.refreshed).toEqual([contract.id]);
    const [draft] = await drafts(contract.id);
    expect(draft).toMatchObject({ trip_charge: "42.0000", escalation_rate: "0.050000", draft_for: anniversary });
    const all = await tasks();
    expect(all).toHaveLength(1);
    expect(all[0]!.body).toContain("rise by 5% on");
  });

  it("when a person applies it, removes the draft, writes the card in force and closes the task", async () => {
    const { contract, card, anniversary } = await contractWithCard(15);
    await pass();
    const done = await escalation.apply(owner(), { contractId: contract.id, anniversary, rate: "0.03" });
    expect(await drafts(contract.id)).toHaveLength(0);
    const after = await pricedOn(anniversary);
    expect(after.map((c) => c.id)).toEqual([done.cards[0]!.rateCardId]);
    expect(after[0]!.tripCharge?.amount).toBe(412_000n);
    expect((await pricedOn(time.addDays(anniversary, -1))).map((c) => c.id)).toEqual([card!.id]);

    const [task] = await tasks();
    expect(task).toMatchObject({ status: "done" });
    const [notice] = await raw<{ applied_at: Date | null }[]>`
      select applied_at from public.contract_escalation_notice where contract_id = ${contract.id}`;
    expect(notice!.applied_at).not.toBeNull();

    /** The next anniversary is a year away: nothing more is raised. */
    expect((await pass()).raised).toEqual([]);
    expect(await tasks()).toHaveLength(1);
  });

  it("raises one for an anniversary that was missed, and none for a contract with no card to rise", async () => {
    const { contract } = await contractWithCard(-10);
    const bare = await contractWithCard(10, "0.03", false);
    const result = await pass();
    expect(result.raised).toEqual([contract.id]);
    expect(result.raised).not.toContain(bare.contract.id);
    expect(await tasks()).toHaveLength(1);
  });
});
