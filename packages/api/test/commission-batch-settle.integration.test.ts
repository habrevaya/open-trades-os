import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as commissions from "../src/services/commissions";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * M17. SETTLING SEVERAL SHARED COMMISSIONS AT ONCE, EACH AS PROPOSED
 *
 * The office ticks the waiting invoices whose proposed split it is happy
 * with and settles them in one press. Each is settled exactly as settling it
 * alone would be, audited as its own earning, and one that settling would
 * refuse is listed with the reason without stopping the rest. Real jobs, real
 * invoices.
 *
 *   An invoice of 1,000.00 under eight per cent of revenue earns 80.00.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("commission-batch:org");
const USER = fixtureId("commission-batch:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

let ray = "";
let dana = "";
let customerId = "";
let propertyId = "";
let planId = "";

async function technician(name: string): Promise<string> {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return row!.id;
}

async function invoiceFor(total: string, technicianIds: string[]): Promise<string> {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Two person changeout", tags: [], customFields: {},
    visit: {
      windowStart: "2026-02-03T14:00:00.000Z", windowEnd: "2026-02-03T18:00:00.000Z",
      estimatedDurationMinutes: 240, technicianIds,
    },
  });
  const invoice = await billing.create(owner(), {
    customerId, jobId: job.id as string,
    lines: [{ name: "Condenser", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

async function earnedAudits(): Promise<{ entity_id: string; after: { changed?: boolean } }[]> {
  return raw`select entity_id, after from public.audit_log where organization_id = ${ORG} and action = 'commission.earned'`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Commission Batch Co", slug: "commission-batch-co" });
  ray = await technician("Ray Nunez");
  dana = await technician("Dana Pike");
  const created = await customers.create(owner(), {
    type: "residential", name: "Okafor", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "3 Pine St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
  });
  customerId = created.id as string;
  const [prop] = await raw`select id from public.property where organization_id = ${ORG}`;
  propertyId = (prop as { id: string }).id;
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.commission_entry where organization_id = ${ORG}`;
  await raw`delete from public.commission_reversal where organization_id = ${ORG}`;
  await raw`delete from public.commission_event where organization_id = ${ORG}`;
  await raw`delete from public.commission_plan where organization_id = ${ORG}`;
  await raw`delete from public.commission_standing_share where organization_id = ${ORG}`;
  await raw`delete from public.audit_log where organization_id = ${ORG} and action = 'commission.earned'`;
  planId = (await commissions.declarePlan(owner(), {
    label: "Eight per cent", basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for, net of tax.",
  })).id as string;
});

run("settling shared commissions at once", () => {
  it("shows each waiting invoice's proposed split, worked out as settling it would be", async () => {
    await commissions.setStandingShare(owner(), { technicianId: ray, percent: 25, applies: "always", reason: "Sells it" });
    const invoiceId = await invoiceFor("1000.00", [dana, ray]);
    const { waiting } = await commissions.shared(owner());
    const row = waiting.find((w) => w.invoiceId === invoiceId)!;
    expect(row.proposed.refusal).toBeNull();
    expect(row.proposed.total).toBe("80.0000");
    expect(row.proposed.parts.map((p) => [p.name, p.amount])).toEqual([["Dana Pike", "60.0000"], ["Ray Nunez", "20.0000"]]);
    expect(row.proposed.standingSentence).toContain("Ray Nunez takes 25%");
  });

  it("settles each exactly as one at a time would, audits one per earning, and lists a refusal without stopping the rest", async () => {
    await commissions.setStandingShare(owner(), { technicianId: ray, percent: 25, applies: "always", reason: "Sells it" });
    const first = await invoiceFor("1000.00", [dana, ray]);
    const second = await invoiceFor("500.00", [ray, dana]);
    const voided = await invoiceFor("700.00", [ray, dana]);
    await billing.voidInvoice(owner(), { id: voided, reason: "Raised twice" });
    /** The same invoice settled alone, for the comparison. */
    const alone = await invoiceFor("1000.00", [dana, ray]);
    const aloneProposal = await commissions.proposal(owner(), { invoiceId: alone });
    const aloneDone = await commissions.settleSplit(owner(), {
      invoiceId: alone, shares: aloneProposal.people.map((p) => ({ technicianId: p.technicianId, weight: p.weight })),
    });

    const result = await commissions.settleProposed(owner(), { invoiceIds: [first, second, voided] });
    expect(result.settled.map((s) => [s.invoiceId, s.total, s.replayed])).toEqual([
      [first, "80.0000", false], [second, "40.0000", false],
    ]);
    expect(result.refused.map((r) => r.invoiceId)).toEqual([voided]);
    expect(result.refused[0]!.refusal).toContain("void");

    /** The same parts, the same explanation and the same standing note as the one settled alone. */
    const parts = async (eventId: string) => raw<{ technician_id: string; amount: string; weight: string; explanation: string }[]>`
      select technician_id, amount::text, weight::text, explanation from public.commission_entry
      where event_id = ${eventId} order by share_index`;
    const batch = await parts(result.settled[0]!.eventId!);
    const single = await parts(aloneDone.id);
    expect(batch.map((p) => [p.technician_id, p.amount, p.weight, p.explanation]))
      .toEqual(single.map((p) => [p.technician_id, p.amount, p.weight, p.explanation]));
    const notes = await raw<{ id: string; standing_note: string | null; split_note: string | null }[]>`
      select id, standing_note, split_note from public.commission_event where id in ${raw([result.settled[0]!.eventId!, aloneDone.id])}`;
    expect(new Set(notes.map((n) => n.standing_note)).size).toBe(1);
    expect(notes.every((n) => n.split_note === null)).toBe(true);

    /** Audited one per earning, each saying it was the proposal unchanged. */
    const audits = await earnedAudits();
    const mine = audits.filter((a) => result.settled.some((s) => s.eventId === a.entity_id));
    expect(mine).toHaveLength(2);
    expect(mine.every((a) => a.after.changed === false)).toBe(true);
  });

  it("answers a repeat with what was settled, and refuses one settled another way since", async () => {
    const first = await invoiceFor("1000.00", [dana, ray]);
    const other = await invoiceFor("1000.00", [dana, ray]);
    await commissions.settleSplit(owner(), {
      invoiceId: other, shares: [{ technicianId: ray, weight: "2" }, { technicianId: dana, weight: "1" }], reason: "Ray sold it.",
    });
    const once = await commissions.settleProposed(owner(), { invoiceIds: [first] });
    const again = await commissions.settleProposed(owner(), { invoiceIds: [first, other] });
    expect(again.settled).toEqual([{ ...once.settled[0]!, replayed: true }]);
    expect(again.refused.map((r) => [r.invoiceId, r.refusal])).toEqual([
      [other, "That invoice has already earned its commission, shared another way. Settling it again would pay it twice."],
    ]);
    const [{ n } = { n: "0" }] = await raw<{ n: string }[]>`select count(*)::text as n from public.commission_event where invoice_id = ${first}`;
    expect(n).toBe("1");
  });

  it("refuses each when two plans are in force and none is named, and settles them all under the plan named", async () => {
    await commissions.declarePlan(owner(), {
      label: "Installs, five per cent", basis: "percent_of_revenue", rate: "0.05", note: "Five per cent on installs.",
    });
    const a = await invoiceFor("1000.00", [dana, ray]);
    const b = await invoiceFor("1000.00", [dana, ray]);
    const { waiting } = await commissions.shared(owner());
    expect(waiting.find((w) => w.invoiceId === a)!.proposed.refusal).toContain("Name which one");
    const unnamed = await commissions.settleProposed(owner(), { invoiceIds: [a, b] });
    expect(unnamed.settled).toEqual([]);
    expect(unnamed.refused.every((r) => r.refusal!.includes("Name which one"))).toBe(true);
    const named = await commissions.settleProposed(owner(), { invoiceIds: [a, b], planId });
    expect(named.settled.map((s) => s.total)).toEqual(["80.0000", "80.0000"]);
  });

  it("is refused to a role that cannot settle commission", async () => {
    const a = await invoiceFor("1000.00", [dana, ray]);
    await expect(commissions.settleProposed(as(["office_manager"]), { invoiceIds: [a] })).rejects.toThrow();
  });
});
