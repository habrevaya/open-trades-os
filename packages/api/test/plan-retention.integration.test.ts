import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as agreements from "../src/services/agreements";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * RETENTION, RENEWAL AND CHURN, ON THE SCORECARD
 *
 * The four figures that were waiting on a coded cancellation reason. Each is
 * computed in SQL and held here to core's rule (`reporting.retention`,
 * `reporting.renewals`, `reporting.churn`): the same agreements go through
 * both, and the halves, the records behind them, the ones left out because the
 * home was left and the ones whose reason is unknown must all agree.
 *
 * And cancelling with a reason from the list: a move or a sale ends the
 * customer's link to the address when the office says so, which is the fact
 * that keeps a later lapse there out of the churn.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("planret:org");
const USER = fixtureId("planret:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Plan Retention Co", slug: "plan-retention-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
});

/** One agreement as the scenario states it, and how it is written down. */
interface Case extends Omit<reporting.AgreementFacts, "id" | "customerId" | "propertyId"> {
  name: string;
  /** Agreements sharing a customer name are one account. */
  customer?: string;
  /** Terms written down, as `agreement_term` rows: term number and end. */
  terms?: Array<{ term: number; endsOn: string }>;
  /** The customer's link to the address ended on this day. */
  linkEndedOn?: string;
}

/**
 * Write the scenario: a customer, an address and a link per account, a plan,
 * and each agreement. Returns the facts core reads, with the real ids.
 */
async function write(cases: Case[]) {
  const [plan] = await raw<{ id: string }[]>`
    insert into public.agreement_plan (organization_id, name, code, price, billing_frequency)
    values (${ORG}, 'Fortnightly clean', 'fc', '199.0000', 'annual') returning id`;
  const customers = new Map<string, { id: string; propertyId: string }>();
  const facts: reporting.AgreementFacts[] = [];
  const terms: reporting.TermFacts[] = [];
  const links: reporting.LinkFacts[] = [];
  for (const c of cases) {
    const who = c.customer ?? c.name;
    let found = customers.get(who);
    if (!found) {
      const [customer] = await raw<{ id: string }[]>`
        insert into public.customer (organization_id, type, name, payment_terms_days)
        values (${ORG}, 'residential', ${who}, 0) returning id`;
      const [property] = await raw<{ id: string }[]>`
        insert into public.property (organization_id, address_line1, city, state, postal_code)
        values (${ORG}, ${`${who} Lane`}, 'Austin', 'TX', '78704') returning id`;
      found = { id: customer!.id, propertyId: property!.id };
      customers.set(who, found);
      await raw`
        insert into public.customer_property (organization_id, customer_id, property_id, role, started_on, ended_on)
        values (${ORG}, ${found.id}, ${found.propertyId}, 'owner', '2020-01-01', ${c.linkEndedOn ?? null})`;
      links.push({ customerId: found.id, propertyId: found.propertyId, endedOn: c.linkEndedOn ?? null });
    }
    const [row] = await raw<{ id: string }[]>`
      insert into public.agreement (organization_id, plan_id, customer_id, property_id, status, started_on,
                                   ends_on, cancelled_on, cancellation_reason, cancellation_code,
                                   price, billing_frequency, renewal_count)
      values (${ORG}, ${plan!.id}, ${found.id}, ${found.propertyId}, ${c.status}::agreement_status,
              ${c.startedOn}::date, ${c.endsOn}, ${c.cancelledOn},
              ${c.cancelledOn ? "Recorded" : null}, ${c.cancellationCode}::agreement_cancellation_code,
              '199.0000', 'annual', ${c.renewalCount})
      returning id`;
    facts.push({
      id: row!.id, customerId: found.id, propertyId: found.propertyId, status: c.status, startedOn: c.startedOn,
      endsOn: c.endsOn, cancelledOn: c.cancelledOn, cancellationCode: c.cancellationCode, renewalCount: c.renewalCount,
    });
    for (const t of c.terms ?? []) {
      await raw`
        insert into public.agreement_term (organization_id, agreement_id, term, ends_on)
        values (${ORG}, ${row!.id}, ${t.term}, ${t.endsOn}::date)`;
      terms.push({ agreementId: row!.id, term: t.term, endsOn: t.endsOn });
    }
  }
  return { facts, terms, links };
}

const plain = { status: "active", startedOn: "2026-01-01", endsOn: "2027-01-01", cancelledOn: null, cancellationCode: null, renewalCount: 0 } as const;

/** Every kind of agreement the four figures have to tell apart, in June 2026. */
const SCENARIO: Case[] = [
  { name: "Kept", ...plain },
  { name: "Price", ...plain, status: "cancelled", cancelledOn: "2026-06-12", cancellationCode: "price" },
  { name: "Moved", ...plain, status: "cancelled", cancelledOn: "2026-06-12", cancellationCode: "moved" },
  { name: "Legacy", ...plain, status: "cancelled", cancelledOn: "2026-06-12" },
  /** Lapsed at the end of its term, and the house was sold: only the address says so. */
  { name: "Sold", ...plain, status: "lapsed", endsOn: "2026-06-20", linkEndedOn: "2026-06-25" },
  /** Lapsed, and nothing says why: a lost customer. */
  { name: "Lapsed", ...plain, status: "lapsed", endsOn: "2026-06-15" },
  /** Renewed on its anniversary in June: its first term ended and it went on. */
  { name: "Renewed", ...plain, startedOn: "2025-06-10", endsOn: "2027-06-10", renewalCount: 1,
    terms: [{ term: 1, endsOn: "2026-06-10" }, { term: 2, endsOn: "2027-06-10" }] },
  /** Cancelled after its term ended, before the reason was coded. */
  { name: "Late", ...plain, status: "cancelled", endsOn: "2026-06-05", cancelledOn: "2026-06-07" },
  /** Cancelled half way through a term ending in June: never reached a renewal. */
  { name: "Midterm", ...plain, status: "cancelled", endsOn: "2026-06-18", cancelledOn: "2026-03-01", cancellationCode: "service" },
  /** Started in the window: not on at the start. */
  { name: "New", ...plain, startedOn: "2026-06-05" },
  /** Two plans, one cancelled for a switch: still an account, one subscription churned. */
  { name: "TwoA", customer: "Two", ...plain, status: "cancelled", cancelledOn: "2026-06-03", cancellationCode: "switched" },
  { name: "TwoB", customer: "Two", ...plain },
  { name: "Pending", ...plain, status: "pending", startedOn: "2026-05-01" },
];

/** The scorecard's figure for a key, and the records behind each half and each count beside it. */
async function figure(key: string) {
  const card = await kpis.scorecard(owner(), WINDOW);
  const row = card.computed.find((r) => r.key === key);
  expect(row, `${key} is computed`).toBeTruthy();
  const ids = async (half: kpis.KpiHalf) =>
    (await kpis.drill(owner(), { key, half, ...WINDOW })).records.map((r) => r.id).sort();
  return {
    row: row!,
    numerator: await ids("numerator"),
    denominator: await ids("denominator"),
    excluded: await ids("excluded"),
    unknown: await ids("unknown"),
  };
}

run("retention, renewal and churn on the scorecard", () => {
  it("cleaning's recurring retention is core's rule, account by account", async () => {
    await raw`update public.organization set primary_trade = 'cleaning' where id = ${ORG}`;
    const { facts, links } = await write(SCENARIO);
    const expected = reporting.retention({ agreements: facts, links, ...WINDOW });
    const got = await figure("recurring_retention");
    expect({ numerator: got.numerator, denominator: got.denominator, excluded: got.excluded, unknown: got.unknown }).toEqual(expected);
    /**
     * Kept, Renewed and Two, over those and Price, Legacy, Lapsed and Late;
     * Moved and Sold left out; Legacy and Late cancelled with no coded reason.
     */
    expect(got.row).toMatchObject({ numerator: "3", denominator: "7", value: "42.9" });
    expect(got.row.besides).toEqual([
      expect.objectContaining({ key: "excluded", count: "2" }),
      expect.objectContaining({ key: "unknown", count: "2" }),
    ]);
  });

  it("pest control's renewal rate and lawn's programme renewal are core's rule, term by term", async () => {
    await raw`update public.organization set primary_trade = 'pest-control' where id = ${ORG}`;
    const { facts, terms, links } = await write(SCENARIO);
    const expected = reporting.renewals({ agreements: facts, terms, links, ...WINDOW, today: companyToday() });
    const toAgreements = (keys: string[]) => keys.map((k) => k.split(":")[0]!).sort();
    for (const key of ["renewal_rate", "programme_renewal"]) {
      if (key === "programme_renewal") {
        await raw`update public.organization set primary_trade = 'lawn-and-landscape' where id = ${ORG}`;
      }
      const got = await figure(key);
      expect(got.numerator).toEqual(toAgreements(expected.numerator));
      expect(got.denominator).toEqual(toAgreements(expected.denominator));
      expect(got.excluded).toEqual(toAgreements(expected.excluded));
      expect(got.unknown).toEqual(toAgreements(expected.unknown));
      /** Renewed, over Renewed, Lapsed and Late; Sold left out; Late unknown. */
      expect(got.row).toMatchObject({ numerator: "1", denominator: "3" });
      expect(got.row.besides?.map((b) => [b.key, b.count])).toEqual([["excluded", "1"], ["unknown", "1"]]);
    }
  });

  it("trash bin churn is core's rule, subscription by subscription", async () => {
    await raw`update public.organization set primary_trade = 'trash-bin-cleaning' where id = ${ORG}`;
    const { facts, links } = await write(SCENARIO);
    const expected = reporting.churn({ agreements: facts, links, ...WINDOW });
    const got = await figure("churn");
    expect({ numerator: got.numerator, denominator: got.denominator, excluded: got.excluded, unknown: got.unknown }).toEqual(expected);
    /** Price, Legacy, Lapsed, Late and TwoA lost, over the ten on at the start. */
    expect(got.row).toMatchObject({ numerator: "5", denominator: "10", value: "50.0" });
    expect(got.row.besides?.map((b) => [b.key, b.count])).toEqual([["excluded", "2"], ["unknown", "2"]]);
  });

  it("reads an empty book as nothing to measure, not as nought", async () => {
    await raw`update public.organization set primary_trade = 'cleaning' where id = ${ORG}`;
    const got = (await kpis.scorecard(owner(), WINDOW)).computed.find((r) => r.key === "recurring_retention")!;
    expect(got).toMatchObject({ value: null, numerator: "0", denominator: "0" });
  });
});

run("cancelling with a reason from the list", () => {
  /** An agreement sold the ordinary way, at an address the customer is linked to. */
  async function sold() {
    const { facts } = await write([{ name: "Okafor", ...plain, startedOn: companyToday(-200), endsOn: companyToday(165) }]);
    return facts[0]!;
  }

  it("records the code, and for a move ends the link to the address when the office says so", async () => {
    await raw`update public.organization set primary_trade = 'cleaning' where id = ${ORG}`;
    const a = await sold();
    const cancelled = await agreements.cancel(owner(), { id: a.id, reasonCode: "moved", endPropertyLink: true });
    expect(cancelled).toMatchObject({ status: "cancelled", cancellationCode: "moved", cancellationReason: "Moved house", endedLinks: 1 });
    const [link] = await raw<{ ended_on: string | null }[]>`
      select ended_on::text from public.customer_property where customer_id = ${a.customerId}`;
    expect(link!.ended_on).toBe(companyToday());

    /** And retention over the days around it leaves them out rather than counting them lost. */
    const card = await kpis.scorecard(owner(), { from: companyToday(-5), to: companyToday() });
    const retention = card.computed.find((r) => r.key === "recurring_retention")!;
    expect(retention).toMatchObject({ denominator: "0" });
    expect(retention.besides?.find((b) => b.key === "excluded")?.count).toBe("1");
  });

  it("keeps words with a reason, and needs them for something else", async () => {
    const a = await sold();
    await expect(agreements.cancel(owner(), { id: a.id, reasonCode: "other" })).rejects.toThrow(/in words/);
    await expect(agreements.cancel(owner(), { id: a.id, reasonCode: "price", endPropertyLink: true }))
      .rejects.toBeInstanceOf(ConflictError);
    const cancelled = await agreements.cancel(owner(), { id: a.id, reasonCode: "other", reason: "Going abroad for a year" });
    expect(cancelled).toMatchObject({ cancellationCode: "other", cancellationReason: "Going abroad for a year", endedLinks: 0 });
    const [link] = await raw<{ ended_on: string | null }[]>`
      select ended_on::text from public.customer_property where customer_id = ${a.customerId}`;
    expect(link!.ended_on).toBeNull();
  });

  it("is required on the API, which refuses a cancellation with only words", async () => {
    const a = await sold();
    const { cancelAgreement } = await import("../src/contracts/agreements");
    expect(cancelAgreement.input.safeParse({ id: a.id, reason: "Sold the house" }).success).toBe(false);
    expect(cancelAgreement.input.safeParse({ id: a.id, reasonCode: "sold" }).success).toBe(true);
  });
});
