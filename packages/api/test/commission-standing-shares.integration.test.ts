import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as commissions from "../src/services/commissions";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { NotFoundError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * M17. A STANDING SHARE OF SHARED COMMISSION
 *
 * Ray sells the systems and always takes 30% of a commission he shares. Ana
 * takes 40% of the jobs she leads. The split screen proposes that, settling it
 * as proposed needs no reason and says why on each part, and the office can
 * still change it with a reason. Real jobs, real invoices.
 *
 *   An invoice of 1,000.00 under eight per cent of revenue earns 80.00.
 *   Ray 30% beside two others:   24.00, 28.00 and 28.00
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("commission-standing:org");
const USER = fixtureId("commission-standing:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

let ray = "";
let dana = "";
let ana = "";
let customerId = "";
let propertyId = "";

async function technician(name: string): Promise<string> {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return row!.id;
}

/** The first technician named leads the visit. */
async function invoiceFor(total: string, technicianIds: string[]): Promise<string> {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "System replacement", tags: [], customFields: {},
    visit: {
      windowStart: "2026-02-03T14:00:00.000Z", windowEnd: "2026-02-03T18:00:00.000Z",
      estimatedDurationMinutes: 240, technicianIds,
    },
  });
  const invoice = await billing.create(owner(), {
    customerId, jobId: job.id as string,
    lines: [{ name: "System", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Standing Share Co", slug: "commission-standing-co" });
  ray = await technician("Ray Nunez");
  dana = await technician("Dana Pike");
  ana = await technician("Ana Ruiz");
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
  await commissions.declarePlan(owner(), {
    label: "Eight per cent", basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for, net of tax.",
  });
});

const raySells = () => commissions.setStandingShare(owner(), {
  technicianId: ray, percent: 30, applies: "always", reason: "He sells the systems.",
});

run("setting a standing share", () => {
  it("is a whole percent from 1 to 99 with a reason, for somebody in the company, and only by whoever configures commission", async () => {
    await expect(commissions.setStandingShare(owner(), { technicianId: ray, percent: 100, applies: "always", reason: "x" }))
      .rejects.toThrow(UnprocessableError);
    await expect(commissions.setStandingShare(owner(), { technicianId: ray, percent: 30, applies: "always", reason: "  " }))
      .rejects.toThrow(UnprocessableError);
    await expect(commissions.setStandingShare(owner(), { technicianId: USER, percent: 30, applies: "always", reason: "x" }))
      .rejects.toThrow(NotFoundError);
    await expect(commissions.setStandingShare(as(["office_manager"]), { technicianId: ray, percent: 30, applies: "always", reason: "x" }))
      .rejects.toThrow();

    const set = await raySells();
    expect(set).toMatchObject({ percent: 30, applies: "always", replayed: false, inWords: "Ray Nunez takes 30% of shared commission whenever they are on the job." });
    /** The accountant reads them. */
    const listed = await commissions.standingShares(as(["accountant"]));
    expect(listed.live.map((s) => s.id)).toEqual([set.id]);
  });

  it("answers a repeat with what is in force, and stops the old one rather than editing it", async () => {
    const first = await raySells();
    expect((await raySells())).toMatchObject({ id: first.id, replayed: true });
    const second = await commissions.setStandingShare(owner(), { technicianId: ray, percent: 25, applies: "always", reason: "He sells the systems." });
    expect(second.id).not.toBe(first.id);
    const listed = await commissions.standingShares(owner());
    expect(listed.live.map((s) => [s.name, s.percent])).toEqual([["Ray Nunez", 25]]);
    expect(listed.ended.map((s) => [s.id, s.percent])).toEqual([[first.id, 30]]);
    const [audit] = await raw<{ n: string }[]>`select count(*)::text as n from public.audit_log
      where organization_id = ${ORG} and action = 'commission.standing_share_set'`;
    expect(Number(audit!.n)).toBeGreaterThanOrEqual(2);
  });
});

run("a split proposed from standing shares", () => {
  it("gives the standing share and splits the rest evenly, and settles as proposed with no reason, saying why on each part", async () => {
    await raySells();
    const invoiceId = await invoiceFor("1000.00", [dana, ray, ana]);
    const proposal = await commissions.proposal(owner(), { invoiceId });
    expect(proposal.refusal).toBeNull();
    expect(proposal.changed).toBe(false);
    expect(proposal.standingSentence).toBe(
      "Standing shares: Ray Nunez takes 30% (He sells the systems). The remaining 70% is split evenly between the other 2 people.",
    );
    expect(proposal.standing.map((s) => [s.name, s.percent])).toEqual([["Ray Nunez", 30]]);
    expect(proposal.people.map((p) => [p.name, p.amount])).toEqual([
      ["Ana Ruiz", "28.0000"], ["Dana Pike", "28.0000"], ["Ray Nunez", "24.0000"],
    ]);

    /** The screen sends the shares it showed, and nobody changed them. */
    const done = await commissions.settleSplit(owner(), {
      invoiceId, shares: proposal.people.map((p) => ({ technicianId: p.technicianId, weight: p.weight })),
    });
    expect(done.splitNote).toBeNull();
    const [event] = await raw<{ standing_note: string | null; split_note: string | null }[]>`
      select standing_note, split_note from public.commission_event where id = ${done.id}`;
    expect(event!.standing_note).toBe(proposal.standingSentence);
    expect(event!.split_note).toBeNull();
    const entries = await raw<{ technician_id: string; amount: string; explanation: string }[]>`
      select technician_id, amount::text, explanation from public.commission_entry where event_id = ${done.id}`;
    expect(entries.find((e) => e.technician_id === ray)!.amount).toBe("24.0000");
    expect(entries.every((e) => e.explanation.includes("Ray Nunez takes 30% (He sells the systems)"))).toBe(true);
  });

  it("can still be changed by the office, with a reason, within the same rules", async () => {
    await raySells();
    const invoiceId = await invoiceFor("1000.00", [dana, ray]);
    const even = [{ technicianId: ray, weight: "1" }, { technicianId: dana, weight: "1" }];
    const shown = await commissions.proposal(owner(), { invoiceId, shares: even });
    expect(shown.changed).toBe(true);
    expect(shown.people.find((p) => p.technicianId === ray)).toMatchObject({ proposedWeight: "30", weight: "1" });

    await expect(commissions.settleSplit(owner(), { invoiceId, shares: even }))
      .rejects.toThrow(/A reason for the split/);
    const refused = await commissions.settleSplit(owner(), { invoiceId, shares: even }).catch((e: unknown) => e as UnprocessableError);
    expect(JSON.stringify((refused as UnprocessableError).issues ?? refused)).toContain("not the split the standing shares propose");

    const done = await commissions.settleSplit(owner(), { invoiceId, shares: even, reason: "Dana found the second leak." });
    expect(done.splitNote).toBe("Dana found the second leak.");
    const [event] = await raw<{ standing_note: string | null }[]>`select standing_note from public.commission_event where id = ${done.id}`;
    expect(event!.standing_note).toBeNull();
    /** The same rules: a split of zeros is still refused. */
    const other = await invoiceFor("500.00", [dana, ray]);
    await expect(commissions.settleSplit(owner(), {
      invoiceId: other, shares: [{ technicianId: ray, weight: "0" }, { technicianId: dana, weight: "0" }], reason: "No",
    })).rejects.toThrow(UnprocessableError);
  });

  it("applies a lead's share only on a job they led", async () => {
    await commissions.setStandingShare(owner(), { technicianId: ana, percent: 40, applies: "as_lead", reason: "Leads the installs" });
    const led = await invoiceFor("1000.00", [ana, dana]);
    const helped = await invoiceFor("1000.00", [dana, ana]);
    const ledProposal = await commissions.proposal(owner(), { invoiceId: led });
    expect(ledProposal.people.map((p) => [p.name, p.amount])).toEqual([["Ana Ruiz", "32.0000"], ["Dana Pike", "48.0000"]]);
    const helpedProposal = await commissions.proposal(owner(), { invoiceId: helped });
    expect(helpedProposal.standing).toEqual([]);
    expect(helpedProposal.people.map((p) => p.amount)).toEqual(["40.0000", "40.0000"]);
  });

  it("proposes the even split, and says why, when the standing shares cannot all be honoured", async () => {
    await raySells();
    await commissions.setStandingShare(owner(), { technicianId: dana, percent: 80, applies: "always", reason: "Owner's son" });
    const invoiceId = await invoiceFor("1000.00", [dana, ray, ana]);
    const proposal = await commissions.proposal(owner(), { invoiceId });
    expect(proposal.standingConflict).toContain("add up to 110%");
    expect(proposal.standingSentence).toBeNull();
    expect(proposal.people.map((p) => p.proposedWeight)).toEqual(["1", "1", "1"]);
  });

  it("is what settling without a split pays, and stopping it puts the even split back without touching what was settled", async () => {
    const share = await raySells();
    const first = await invoiceFor("1000.00", [dana, ray]);
    const settled = await commissions.settle(owner(), { invoiceId: first });
    expect(settled.parts.find((p) => p.technicianId === ray)!.amount).toBe("24.0000");
    expect(settled.parts.find((p) => p.technicianId === dana)!.amount).toBe("56.0000");
    expect(settled.parts[0]!.explanation).toContain("Standing shares: Ray Nunez takes 30%");

    await commissions.endStandingShare(owner(), { id: share.id });
    expect((await commissions.endStandingShare(owner(), { id: share.id })).endedAt).not.toBeNull();
    const second = await invoiceFor("1000.00", [dana, ray]);
    const after = await commissions.proposal(owner(), { invoiceId: second });
    expect(after.standing).toEqual([]);
    expect(after.people.map((p) => p.amount)).toEqual(["40.0000", "40.0000"]);
    const kept = await raw<{ amount: string }[]>`select amount::text from public.commission_entry
      where organization_id = ${ORG} and technician_id = ${ray} and event_id = ${settled.id}`;
    expect(kept.map((k) => k.amount)).toEqual(["24.0000"]);
  });
});
