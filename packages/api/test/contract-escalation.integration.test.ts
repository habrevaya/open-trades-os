import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as contracts from "../src/services/contracts";
import * as rateCards from "../src/services/rate-cards";
import * as escalation from "../src/services/contract-escalation";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A CONTRACT'S ANNUAL ESCALATION
 *
 * The rate has always been stored on the contract and nothing applied it.
 * These tests rise a card on the anniversary: shown first, applied only as
 * shown, as a new version from the anniversary with the old one ending the
 * day before, so work before then keeps last year's prices.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("esc:org");
const USER = fixtureId("esc:user");

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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Escalation Co", slug: "escalation-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  clientId = (await customers.create(owner(), {
    type: "commercial", name: "Meridian Facilities", phone: "+15125550600",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  })).id;
});

/** A contract that started a year ago less `daysToAnniversary`, with one card of a line, labour and a trip charge. */
async function contractWithCard(daysToAnniversary: number, rate: string | null = "0.035") {
  const anniversary = companyToday(daysToAnniversary);
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;
  const contract = await contracts.createContract(owner(), {
    customerId: clientId, name: "Meridian MSA", startsOn, escalationRate: rate,
  });
  const card = await contracts.createRateCard(owner(), { name: "Meridian schedule", contractId: contract.id, effectiveFrom: startsOn });
  await contracts.setRateCardLines(owner(), {
    rateCardId: card.id,
    lines: [{ externalCode: "CAP", description: "Capacitor, supplied and fitted", price: "175.00" }],
  });
  await rateCards.setTerms(owner(), {
    rateCardId: card.id,
    labourRates: [{ band: "standard", hourlyRate: "95.00" }, { band: "after_hours", hourlyRate: "142.50" }],
    materialMarkup: [{ upToCost: null, percent: "0.25" }],
    tripCharge: "49.99",
  });
  return { contract, card, anniversary, startsOn };
}

/** The cards that price this client on a day, as invoicing asks. */
function pricedOn(on: string) {
  return inTenant(owner(), (tx) => rateCards.cardsFor(tx, ORG, { customerId: clientId, on, timeZone: "America/Chicago" }));
}

run("an annual escalation", () => {
  it("shows every price before and after, to the cent, and writes nothing", async () => {
    const { contract, card, anniversary } = await contractWithCard(10);
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown).toMatchObject({
      anniversary, contractYear: 2, daysAway: 10, ready: true, problem: null, rate: "0.035000",
    });
    expect(shown.cards).toHaveLength(1);
    expect(shown.cards[0]).toMatchObject({
      rateCardId: card.id,
      lines: [expect.objectContaining({ before: "175.0000", after: "181.1300" })],
      tripCharge: { before: "49.9900", after: "51.7400" },
    });
    expect(shown.cards[0]!.labourRates.map((r) => [r.band, r.before, r.after]).sort()).toEqual([
      ["after_hours", "142.5000", "147.4900"],
      ["standard", "95.0000", "98.3300"],
    ]);
    expect(await pricedOn(anniversary)).toHaveLength(1);
  });

  it("writes a new version from the anniversary and ends the old one the day before", async () => {
    const { contract, card, anniversary } = await contractWithCard(10);
    const done = await escalation.apply(owner(), { contractId: contract.id, anniversary, rate: "0.035" });
    expect(done.cards).toEqual([expect.objectContaining({
      fromRateCardId: card.id, name: "Meridian schedule (year 2)", effectiveFrom: anniversary,
    })]);

    const before = await pricedOn(time.addDays(anniversary, -1));
    const after = await pricedOn(anniversary);
    expect(before.map((c) => c.id)).toEqual([card.id]);
    expect(after.map((c) => c.id)).toEqual([done.cards[0]!.rateCardId]);
    expect(after[0]!.lines[0]!.price.amount).toBe(1_811_300n);
    expect(after[0]!.tripCharge?.amount).toBe(517_400n);
    expect(after[0]!.markup.map((t) => t.percent)).toEqual(["0.25"]);
    expect(after[0]!.labourRates.map((r) => r.hourlyRate.amount).sort((a, b) => (a < b ? -1 : 1))).toEqual([983_300n, 1_474_900n]);

    /** Applied once: a retry answers with what it made, and the next anniversary is a year on. */
    const again = await escalation.apply(owner(), { contractId: contract.id, anniversary, rate: "0.035" });
    expect(again.cards.map((c) => c.rateCardId)).toEqual([done.cards[0]!.rateCardId]);
    const next = await escalation.preview(owner(), { contractId: contract.id });
    expect(next).toMatchObject({ contractYear: 3, ready: false, escalatedThrough: anniversary });
    expect(next.anniversary).toBe(`${Number(anniversary.slice(0, 4)) + 1}${anniversary.slice(4)}`);
  });

  it("is refused unless told the anniversary and rate that were shown", async () => {
    const { contract, anniversary } = await contractWithCard(10);
    await expect(escalation.apply(owner(), { contractId: contract.id, anniversary: time.addDays(anniversary, 1), rate: "0.035" }))
      .rejects.toThrow(/next anniversary is/);
    await contracts.updateContract(owner(), { id: contract.id, escalationRate: "0.04" });
    await expect(escalation.apply(owner(), { contractId: contract.id, anniversary, rate: "0.035" }))
      .rejects.toThrow(/Look at the preview again/);
    expect(await pricedOn(anniversary)).toHaveLength(1);
  });

  it("waits until sixty days before, and says why", async () => {
    const { contract, anniversary } = await contractWithCard(90);
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown.ready).toBe(false);
    expect(shown.problem).toMatch(/can be prepared from/);
    await expect(escalation.apply(owner(), { contractId: contract.id, anniversary, rate: "0.035" }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("catches up an anniversary that was missed", async () => {
    const { contract, anniversary } = await contractWithCard(-20);
    const shown = await escalation.preview(owner(), { contractId: contract.id });
    expect(shown).toMatchObject({ anniversary, daysAway: -20, ready: true });
    await escalation.apply(owner(), { contractId: contract.id, anniversary, rate: "0.035" });
    expect((await pricedOn(companyToday()))[0]!.name).toBe("Meridian schedule (year 2)");
  });

  it("says when there is nothing to rise, and who may not", async () => {
    const { contract } = await contractWithCard(10, null);
    expect((await escalation.preview(owner(), { contractId: contract.id })).problem).toMatch(/no annual escalation rate/);
    const { contract: other, anniversary } = await contractWithCard(10);
    await expect(escalation.apply(as(["dispatcher"]), { contractId: other.id, anniversary, rate: "0.035" })).rejects.toThrow();
  });
});
