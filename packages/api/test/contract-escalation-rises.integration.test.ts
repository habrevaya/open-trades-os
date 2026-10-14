import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, PermissionError, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as contracts from "../src/services/contracts";
import * as rateCards from "../src/services/rate-cards";
import * as escalation from "../src/services/contract-escalation";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * RISES THAT DIFFER BY YEAR, BY CARD OR BY TRADE
 *
 * "Year two 3%, year three 4%", "plumbing labour rises 5%", "the emergency
 * card is fixed for the term". Each price rises by the most specific rise
 * that applies, the preview says which, applying needs the key the person
 * saw, a year nothing rises in is passed over, and the worker still prepares
 * the draft thirty days ahead and never applies anything.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("escrises:org");
const USER = fixtureId("escrises:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Escalation Rises Co", slug: "escalation-rises-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  clientId = (await customers.create(owner(), {
    type: "commercial", name: "Harbor Facilities", phone: "+15125550610",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  })).id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Plumbing') returning id`;
  plumbing = type!.id;
});

/**
 * A contract `years` years old less `daysToAnniversary`, with a card of a
 * listed price, a plumbing hourly rate, an hourly rate for any work and a
 * trip charge.
 */
async function contractWith(daysToAnniversary: number, rate: string | null, years = 1) {
  const anniversary = companyToday(daysToAnniversary);
  const startsOn = `${Number(anniversary.slice(0, 4)) - years}${anniversary.slice(4)}`;
  const contract = await contracts.createContract(owner(), {
    customerId: clientId, name: "Harbor MSA", startsOn, escalationRate: rate,
  });
  const card = await card_(contract.id, "Harbor schedule", startsOn);
  return { contract, card, anniversary, startsOn };
}

async function card_(contractId: string, name: string, startsOn: string) {
  const card = await contracts.createRateCard(owner(), { name, contractId, effectiveFrom: startsOn });
  await contracts.setRateCardLines(owner(), {
    rateCardId: card.id,
    lines: [{ externalCode: "FLT", description: "Filter change", price: "100.00" }],
  });
  await rateCards.setTerms(owner(), {
    rateCardId: card.id,
    labourRates: [{ band: "standard", hourlyRate: "90.00", jobTypeId: plumbing }, { band: "standard", hourlyRate: "80.00" }],
    materialMarkup: [],
    tripCharge: "50.00",
  });
  return card;
}

const priced = (shown: escalation.EscalationPreview, cardId: string) => {
  const card = shown.cards.find((c) => c.rateCardId === cardId)!;
  return {
    line: [card.lines[0]!.after, card.lines[0]!.rate, card.lines[0]!.because],
    plumbing: card.labourRates.filter((r) => r.jobTypeName === "Plumbing").map((r) => [r.after, r.rate, r.because])[0],
    anyWork: card.labourRates.filter((r) => r.jobTypeName === null).map((r) => [r.after, r.rate, r.because])[0],
    trip: [card.tripCharge!.after, card.tripCharge!.rate, card.tripCharge!.because],
  };
};

run("rises that differ by year, by card or by trade", () => {
  it("rises each year by that year's rise, and applies only with the key the preview showed", async () => {
    const { contract, card, anniversary } = await contractWith(10, null);
    const saved = await escalation.setRises(owner(), {
      contractId: contract.id,
      rises: [{ contractYear: 2, rate: "0.03" }, { contractYear: 3, rate: "0.04" }],
    });
    expect(saved.map((r) => [r.contractYear, r.rate])).toEqual([[2, "0.030000"], [3, "0.040000"]]);

    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown).toMatchObject({ anniversary, contractYear: 2, ready: true, problem: null, rate: null });
    expect(shown.key).toMatch(/^[0-9a-f]{24}$/);
    expect(priced(shown, card.id)).toEqual({
      line: ["103.0000", "0.030000", "Year 2"],
      plumbing: ["92.7000", "0.030000", "Year 2"],
      anyWork: ["82.4000", "0.030000", "Year 2"],
      trip: ["51.5000", "0.030000", "Year 2"],
    });

    /** One rate cannot say what was shown when the rises differ, and a key from before a change is refused. */
    await expect(escalation.apply(owner(), { contractId: contract.id, anniversary, rate: "0.03" }))
      .rejects.toThrow(/differs by year, card or trade/);
    await expect(escalation.apply(owner(), { contractId: contract.id, anniversary, key: "0".repeat(24) }))
      .rejects.toThrow(/changed since the preview/);

    const done = await escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! });
    expect(done).toMatchObject({ anniversary, rate: null });
    const [made] = await raw<{ id: string; escalation_rate: string; trip_charge: string }[]>`
      select id, escalation_rate::text, trip_charge::text from public.rate_card where id = ${done.cards[0]!.rateCardId}`;
    expect(made).toMatchObject({ escalation_rate: "0.030000", trip_charge: "51.5000" });

    /** Year three, a year on, rises by four per cent from the year two prices. */
    const next = await escalation.preview(owner(), { contractId: contract.id });
    expect(next).toMatchObject({ contractYear: 3, ready: false });
    expect(priced(next, made!.id).line).toEqual(["107.1200", "0.040000", "Year 3"]);
  });

  it("rises a trade's hourly rates by its own rise, keeps a card fixed, and moves a card's rise to its new version", async () => {
    const { contract, card, anniversary, startsOn } = await contractWith(10, "0.03");
    const emergency = await card_(contract.id, "Emergency schedule", startsOn);
    await escalation.setRises(owner(), {
      contractId: contract.id,
      rises: [
        { jobTypeId: plumbing, rate: "0.05" },
        { rateCardId: emergency.id, rate: "0" },
      ],
    });
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(priced(shown, card.id)).toEqual({
      line: ["103.0000", "0.030000", "The contract's yearly rate"],
      plumbing: ["94.5000", "0.050000", "Every year, Plumbing hourly rates"],
      anyWork: ["82.4000", "0.030000", "The contract's yearly rate"],
      trip: ["51.5000", "0.030000", "The contract's yearly rate"],
    });
    /** The fixed card keeps its prices exactly; the trade's rise is more specific than the card's. */
    expect(priced(shown, emergency.id)).toEqual({
      line: ["100.0000", "0.000000", "Every year, Emergency schedule"],
      plumbing: ["94.5000", "0.050000", "Every year, Plumbing hourly rates"],
      anyWork: ["80.0000", "0.000000", "Every year, Emergency schedule"],
      trip: ["50.0000", "0.000000", "Every year, Emergency schedule"],
    });

    const done = await escalation.apply(owner(), { contractId: contract.id, anniversary, key: shown.key! });
    const nextEmergency = done.cards.find((c) => c.fromRateCardId === emergency.id)!.rateCardId;
    const terms = await rateCards.terms(owner(), { rateCardId: nextEmergency });
    expect(terms.labourRates.map((r) => [r.jobTypeId, r.hourlyRate]).sort()).toEqual([
      [null, "80.0000"], [plumbing, "94.5000"],
    ].sort());
    /** The rise naming the card names its new version, so it still holds next year. */
    const rises = await escalation.listRises(owner(), { contractId: contract.id });
    expect(rises.find((r) => r.rateCardId !== null)).toMatchObject({ rateCardId: nextEmergency, rateCardName: "Emergency schedule (year 2)" });
    const audit = await raw<{ after: { rises: unknown[] } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'contract.escalated'`;
    expect(audit[0]!.after.rises).toHaveLength(2);
  });

  it("passes over a year nothing rises in", async () => {
    /** Only year three rises. A year old less ten days, the next rise is a year and ten days away. */
    const young = await contractWith(10, null);
    await escalation.setRises(owner(), { contractId: young.contract.id, rises: [{ contractYear: 3, rate: "0.04" }] });
    const later = await escalation.preview(owner(), { contractId: young.contract.id });
    expect(later).toMatchObject({ contractYear: 3, ready: false });
    expect(later.anniversary).toBe(`${Number(young.anniversary.slice(0, 4)) + 1}${young.anniversary.slice(4)}`);

    /** Two years old less ten days: year two went by with nothing to rise, and year three is ten days away. */
    const older = await contractWith(10, null, 2);
    await escalation.setRises(owner(), { contractId: older.contract.id, rises: [{ contractYear: 3, rate: "0.04" }] });
    const shown = await escalation.preview(owner(), { contractId: older.contract.id });
    expect(shown).toMatchObject({ anniversary: older.anniversary, contractYear: 3, ready: true });
    expect(priced(shown, older.card.id).line).toEqual(["104.0000", "0.040000", "Year 3"]);

    /** A rise for a year gone by and never applied is still owed, as a missed one always is. */
    await escalation.setRises(owner(), { contractId: older.contract.id, rises: [{ contractYear: 2, rate: "0.04" }] });
    const yearTwo = `${Number(older.anniversary.slice(0, 4)) - 1}${older.anniversary.slice(4)}`;
    expect(await escalation.preview(owner(), { contractId: older.contract.id })).toMatchObject({ anniversary: yearTwo, contractYear: 2, ready: true });
    /** Applied, rises only for years gone by leave nothing to rise, said in words. */
    await raw`update public.service_contract set escalated_through = ${yearTwo} where id = ${older.contract.id}`;
    expect((await escalation.preview(owner(), { contractId: older.contract.id })).problem).toMatch(/None of this contract's rises/);
  });

  it("is prepared as a draft thirty days ahead by each rise, and prepared again when a rise changes", async () => {
    const { contract } = await contractWith(20, null);
    await escalation.setRises(owner(), {
      contractId: contract.id,
      rises: [{ contractYear: 2, rate: "0.03" }, { jobTypeId: plumbing, rate: "0.05" }],
    });
    const first = await escalation.noticesFor(db(), ORG);
    expect(first.raised).toEqual([contract.id]);
    const [task] = await raw<{ id: string; body: string }[]>`select id, body from public.task where organization_id = ${ORG}`;
    expect(task!.body).toMatch(/rates rise on .*: year 2 by 3%, every year, plumbing hourly rates by 5%\./);
    const draftRates = await raw<{ hourly_rate: string; job_type_id: string | null }[]>`
      select l.hourly_rate::text, l.job_type_id from public.rate_card_labour_rate l
      join public.rate_card c on c.id = l.rate_card_id
      where c.contract_id = ${contract.id} and c.draft_for is not null order by l.hourly_rate`;
    expect(draftRates.map((r) => r.hourly_rate)).toEqual(["82.4000", "94.5000"]);

    /** Nothing changed: nothing happens. A rise changed: the draft and the task's words follow. */
    expect((await escalation.noticesFor(db(), ORG)).refreshed).toEqual([]);
    await escalation.setRises(owner(), {
      contractId: contract.id,
      rises: [{ contractYear: 2, rate: "0.04" }, { jobTypeId: plumbing, rate: "0.05" }],
    });
    expect((await escalation.noticesFor(db(), ORG)).refreshed).toEqual([contract.id]);
    const [again] = await raw<{ body: string }[]>`select body from public.task where id = ${task!.id}`;
    expect(again!.body).toMatch(/year 2 by 4%/);
    expect(await raw`select 1 from public.task where organization_id = ${ORG}`).toHaveLength(1);
    /** It is never applied by itself. */
    const [row] = await raw<{ escalated_through: string | null }[]>`
      select escalated_through::text from public.service_contract where id = ${contract.id}`;
    expect(row!.escalated_through).toBeNull();
  });

  it("refuses rises it cannot apply, and anybody who may not change the contract's terms", async () => {
    const { contract } = await contractWith(10, "0.03");
    const other = await contracts.createContract(owner(), { customerId: clientId, name: "Other", startsOn: time.addDays(companyToday(), -30) });
    const otherCard = await contracts.createRateCard(owner(), { name: "Other card", contractId: other.id });
    await expect(escalation.setRises(owner(), {
      contractId: contract.id, rises: [{ contractYear: 2, rate: "0.03" }, { contractYear: 2, rate: "0.04" }],
    })).rejects.toThrow(/Row 2 says the same year, card and trade/);
    await expect(escalation.setRises(owner(), { contractId: contract.id, rises: [{ contractYear: 1, rate: "0.03" }] }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(escalation.setRises(owner(), { contractId: contract.id, rises: [{ rateCardId: otherCard.id, rate: "0.03" }] }))
      .rejects.toThrow(/not one of this contract's/);
    await expect(escalation.setRises(as(["technician"]), { contractId: contract.id, rises: [{ contractYear: 2, rate: "0.03" }] }))
      .rejects.toBeInstanceOf(PermissionError);
    expect(await escalation.listRises(owner(), { contractId: contract.id })).toEqual([]);
    /** With no rises, applying by the yearly rate works as it always has. */
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    await escalation.apply(owner(), { contractId: contract.id, anniversary: shown.anniversary!, rate: "0.03" });
  });
});
