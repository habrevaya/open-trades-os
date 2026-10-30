import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as agreements from "../src/services/agreements";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHY A PLAN LAPSED, AND RELEASING AN ENDED TERM FROM THE SCREEN
 *
 * The office may say why a lapsed plan lapsed, from the cancellation list, and may count an ended
 * term's unused visits as earned without waiting for the worker. Neither changes what the worker does.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("lapse-release:org");
const USER = fixtureId("lapse-release:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);
const today = () => time.dateIn(new Date(), "America/Chicago");
const monthAgo = () => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
};

let customerId = "";
let propertyId = "";

const PLAN = {
  name: "Comfort Club", price: "240.00", billingFrequency: "quarterly" as const, termMonths: 12,
  includedVisitsPerTerm: 2, renewalNoticeDays: 30, autoRenews: false,
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Lapse Release Air", slug: "lapse-release-air" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Rosa Member", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  propertyId = (await properties.create(owner(), {
    address: { line1: "4 Lapse Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw.unsafe("set session_replication_role = replica");
  await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
  await raw.unsafe("set session_replication_role = origin");
  await raw`delete from public.deferred_revenue_entry where organization_id = ${ORG}`;
  await raw`delete from public.agreement_billing where organization_id = ${ORG}`;
  await raw`delete from public.agreement_visit where organization_id = ${ORG}`;
  await raw`delete from public.agreement_term where organization_id = ${ORG}`;
  await raw`delete from public.agreement where organization_id = ${ORG}`;
  await raw`delete from public.agreement_plan where organization_id = ${ORG}`;
  await raw`delete from public.task where organization_id = ${ORG}`;
  await raw`delete from public.integration_event where organization_id = ${ORG}`;
  await raw`update public.customer_property set ended_on = null where customer_id = ${customerId}`;
});

const sell = async (startedOn: string, plan: Partial<agreements.PlanInput> = {}) => {
  const created = await agreements.createPlan(owner(), { ...PLAN, ...plan });
  return agreements.sell(owner(), { planId: created.id, customerId, propertyId, startedOn });
};

const postings = (termId: string) => raw<{ account_code: string; direction: string; amount: string }[]>`
  select account_code, direction, amount::numeric(14,2)::text as amount from public.ledger_entry
  where organization_id = ${ORG} and source_type = 'agreement_breakage' and source_id = ${termId} order by direction`;

run("releasing an ended term from its screen", () => {
  it("counts what the term still holds as earned, once, with the worker's own posting", async () => {
    const sold = await sell("2025-06-01");
    const before = await agreements.get(owner(), { id: sold.id });
    const term = before.terms[0]!;
    expect(term).toMatchObject({ term: 1, endsOn: "2026-06-01", breakageReleasedOn: null });
    expect(before.unearned).toBe("240.0000");

    const first = await agreements.releaseTerm(owner(), { id: sold.id, termId: term.id });
    expect(first).toMatchObject({ term: 1, breakageReleasedOn: today(), breakageAmount: "240.0000", breakageVisits: 2, releasedNow: true });
    expect(await postings(term.id)).toEqual([
      { account_code: "2400", direction: "debit", amount: "240.00" },
      { account_code: "4100", direction: "credit", amount: "240.00" },
    ]);
    expect((await agreements.get(owner(), { id: sold.id })).unearned).toBe("0.0000");
    const [audit] = await raw`select count(*)::int as n from public.audit_log where organization_id = ${ORG} and action = 'agreement.breakage_released' and entity_id = ${sold.id}`;
    expect(audit!.n).toBe(1);

    /** A second press, and then the worker, post nothing more. */
    const second = await agreements.releaseTerm(owner(), { id: sold.id, termId: term.id });
    expect(second).toMatchObject({ breakageAmount: "240.0000", releasedNow: false });
    const pass = await agreements.renewalsFor(db(), ORG, new Date());
    expect(pass.released).toEqual([]);
    expect(await postings(term.id)).toHaveLength(2);
  });

  it("is refused in words for a term still running, and counts nothing", async () => {
    const sold = await sell(monthAgo());
    const term = (await agreements.get(owner(), { id: sold.id })).terms[0]!;
    await expect(agreements.releaseTerm(owner(), { id: sold.id, termId: term.id })).rejects.toThrow(/never earlier/);
    expect((await agreements.get(owner(), { id: sold.id })).unearned).toBe("240.0000");
    expect(await postings(term.id)).toEqual([]);
  });

  it("answers a retry with the first answer, and refuses another agreement's term and a person who may not write", async () => {
    const sold = await sell("2025-06-01");
    const other = await sell("2025-06-01", { name: "Other Club" });
    const term = (await agreements.get(owner(), { id: sold.id })).terms[0]!;
    const otherTerm = (await agreements.get(owner(), { id: other.id })).terms[0]!;
    const key = crypto.randomUUID();
    const first = await agreements.handlers.releaseAgreementTerm(owner(key), { id: sold.id, termId: term.id });
    const again = await agreements.handlers.releaseAgreementTerm(owner(key), { id: sold.id, termId: term.id });
    expect(again).toEqual(first);
    expect(first.releasedNow).toBe(true);
    await expect(agreements.releaseTerm(owner(), { id: sold.id, termId: otherTerm.id })).rejects.toThrow(/Term/);
    await expect(agreements.releaseTerm(as(["technician"]), { id: other.id, termId: otherTerm.id })).rejects.toBeInstanceOf(PermissionError);
    expect(await postings(otherTerm.id)).toEqual([]);
  });
});

run("saying why a plan lapsed", () => {
  const lapse = async (startedOn = "2025-06-01") => {
    const sold = await sell(startedOn);
    const pass = await agreements.renewalsFor(db(), ORG, new Date("2026-06-01T15:00:00Z"));
    expect(pass.lapsed).toEqual([sold.id]);
    return sold;
  };

  it("starts unknown, takes a reason from the list, and a correction keeps the earlier words in the audit log", async () => {
    const sold = await lapse();
    expect(await agreements.get(owner(), { id: sold.id })).toMatchObject({ agreement: { status: "lapsed", lapseReasonCode: null, lapseReason: null } });
    await agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "price", reason: "Said it was too much" });
    expect((await agreements.get(owner(), { id: sold.id })).agreement).toMatchObject({ lapseReasonCode: "price", lapseReason: "Said it was too much" });
    /** The same again changes nothing and writes no second audit row. */
    await agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "price", reason: "Said it was too much" });
    await agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "switched" });
    expect((await agreements.get(owner(), { id: sold.id })).agreement).toMatchObject({ lapseReasonCode: "switched", lapseReason: null });
    const rows = await raw`select before, after from public.audit_log where organization_id = ${ORG}
      and action = 'agreement.lapse_reason_recorded' and entity_id = ${sold.id} order by created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[1]!.before).toMatchObject({ lapseReasonCode: "price", lapseReason: "Said it was too much" });
  });

  it("needs words for something else, a code from the list, and a plan that has lapsed", async () => {
    const sold = await lapse();
    await expect(agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "other" })).rejects.toThrow(/in words/);
    await expect(agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "bored" as never })).rejects.toThrow(/not one of the reasons/);
    const running = await sell(monthAgo(), { name: "Running Club" });
    await expect(agreements.recordLapseReason(owner(), { id: running.id, reasonCode: "price" })).rejects.toThrow(/has not lapsed/);
    const cancelled = await sell(monthAgo(), { name: "Cancelled Club" });
    await agreements.cancel(owner(), { id: cancelled.id, reasonCode: "price", keepThePrepayment: true });
    await expect(agreements.recordLapseReason(owner(), { id: cancelled.id, reasonCode: "price" })).rejects.toThrow(/cancelled/);
    await expect(agreements.recordLapseReason(as(["technician"]), { id: sold.id, reasonCode: "price" })).rejects.toBeInstanceOf(PermissionError);
  });

  it("ends their link to the address only when asked, and only for a move or a sale", async () => {
    const sold = await lapse();
    await expect(agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "price", endPropertyLink: true })).rejects.toThrow(/Only a move or a sale/);
    const kept = await agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "moved" });
    expect(kept.endedLinks).toBe(0);
    const [open] = await raw`select ended_on from public.customer_property where customer_id = ${customerId} and property_id = ${propertyId}`;
    expect(open!.ended_on).toBeNull();
    const ended = await agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "sold", endPropertyLink: true });
    expect(ended.endedLinks).toBe(1);
    const [closed] = await raw`select ended_on::text from public.customer_property where customer_id = ${customerId} and property_id = ${propertyId}`;
    expect(closed!.ended_on).toBe(today());
  });

  it("is cleared by a renewal, so a running plan carries no old lapse", async () => {
    const sold = await lapse();
    await agreements.recordLapseReason(owner(), { id: sold.id, reasonCode: "service" });
    await agreements.renew(owner(), { id: sold.id });
    expect((await agreements.get(owner(), { id: sold.id })).agreement).toMatchObject({ status: "active", lapseReasonCode: null, lapseReason: null });
  });

  it("is on the contract under membership:write", async () => {
    const { routes } = await import("../src/contracts");
    expect(routes.recordAgreementLapseReason.permissions).toEqual(["membership:write"]);
    expect(routes.releaseAgreementTerm.permissions).toEqual(["membership:write"]);
  });
});
