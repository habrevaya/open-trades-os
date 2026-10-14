import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as commissions from "../src/services/commissions";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { ConflictError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * M17. A COMMISSION SEVERAL PEOPLE SHARE, SETTLED FROM A SCREEN
 *
 * The office sees the invoices on jobs more than one person worked, the even
 * split core proposes with each part worked out, changes the shares within
 * the rule, and settles it. A split that is not the even one needs a reason,
 * which the people paid read in their part's explanation, and the audit keeps
 * the split proposed beside the one settled. Real jobs, real invoices.
 *
 *   An invoice of 1,000.00 under eight per cent of revenue earns 80.00.
 *   Even between two:      40.00 and 40.00
 *   Two to one:            53.34 and 26.66, the odd cent to the larger share
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("commission-splits:org");
const USER = fixtureId("commission-splits:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

let ray = "";
let dana = "";
let ola = "";
let customerId = "";
let propertyId = "";

async function technician(name: string): Promise<string> {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return row!.id;
}

async function invoiceFor(total: string, technicianIds: string[]): Promise<string> {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Two man condenser swap", tags: [], customFields: {},
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

async function plan(label = "Service, eight per cent") {
  return commissions.declarePlan(owner(), {
    label, basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for, net of tax.",
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Commission Splits Co", slug: "commission-splits-co" });
  ray = await technician("Ray Nunez");
  dana = await technician("Dana Pike");
  ola = await technician("Ola Marsh");
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
});

run("a commission several people share", () => {
  it("waits on the screen with the even split core proposes, each part worked out", async () => {
    const before = await invoiceFor("1000.00", [ray, dana]);
    await plan();
    const invoiceId = await invoiceFor("1000.00", [ray, dana]);
    const alone = await invoiceFor("500.00", [ray]);

    const { waiting } = await commissions.shared(owner());
    expect(waiting.map((w) => w.invoiceId)).toContain(invoiceId);
    /** One person is not a share, and an invoice from before the first plan earned nothing anybody was told about. */
    expect(waiting.map((w) => w.invoiceId)).not.toContain(alone);
    expect(waiting.map((w) => w.invoiceId)).not.toContain(before);
    const row = waiting.find((w) => w.invoiceId === invoiceId)!;
    expect(row.people.map((p) => p.name).sort()).toEqual(["Dana Pike", "Ray Nunez"]);
    expect(row.revenue).toBe("1000.0000");

    const proposal = await commissions.proposal(owner(), { invoiceId });
    expect(proposal.refusal).toBeNull();
    expect(proposal.total).toBe("80.0000");
    expect(proposal.changed).toBe(false);
    expect(proposal.people.map((p) => [p.name, p.weight, p.amount, p.onJob])).toEqual([
      ["Dana Pike", "1", "40.0000", true], ["Ray Nunez", "1", "40.0000", true],
    ]);
    /** It wrote nothing. */
    expect(await raw`select 1 from public.commission_event where organization_id = ${ORG}`).toHaveLength(0);
  });

  it("works out a changed split, and somebody added who was not on the job, the same way settling would", async () => {
    await plan();
    const invoiceId = await invoiceFor("1000.00", [ray, dana]);
    const twoToOne = await commissions.proposal(owner(), {
      invoiceId, shares: [{ technicianId: ray, weight: "2" }, { technicianId: dana, weight: "1" }],
    });
    expect(twoToOne.changed).toBe(true);
    expect(twoToOne.people.find((p) => p.technicianId === ray)).toMatchObject({ weight: "2", proposedWeight: "1", amount: "53.3400" });
    expect(twoToOne.people.find((p) => p.technicianId === dana)).toMatchObject({ amount: "26.6600" });

    const added = await commissions.proposal(owner(), {
      invoiceId, shares: commissions.parseShares(`${ray}:1,${dana}:1,${ola}:1`),
    });
    expect(added.people.find((p) => p.technicianId === ola)).toMatchObject({ name: "Ola Marsh", onJob: false, proposedWeight: "0" });
    expect(added.changed).toBe(true);

    /** What settling would refuse is said, not thrown. */
    const zeros = await commissions.proposal(owner(), {
      invoiceId, shares: [{ technicianId: ray, weight: "0" }, { technicianId: dana, weight: "0" }],
    });
    expect(zeros.refusal).toContain("Every share in that split is zero");
    await plan("Installs, eight per cent");
    expect((await commissions.proposal(owner(), { invoiceId })).refusal).toContain("Name which one");
    expect(() => commissions.parseShares("not-a-split")).toThrow(UnprocessableError);
  });

  it("settles a changed split only with a reason, which the people paid read, and audits the proposal beside it", async () => {
    await plan();
    const invoiceId = await invoiceFor("1000.00", [ray, dana]);
    const shares = [{ technicianId: ray, weight: "2" }, { technicianId: dana, weight: "1" }];
    await expect(commissions.settleSplit(owner(), { invoiceId, shares })).rejects.toThrow(UnprocessableError);
    await expect(commissions.settleSplit(owner(), { invoiceId, shares, reason: "   " })).rejects.toThrow(UnprocessableError);

    const done = await commissions.settleSplit(owner(), { invoiceId, shares, reason: "Ray sold the system on the first visit." });
    expect(done).toMatchObject({ total: "80.0000", splitNote: "Ray sold the system on the first visit.", replayed: false });

    const entries = await raw<{ technician_id: string; amount: string; weight: string; explanation: string }[]>`
      select technician_id, amount::text, weight::text, explanation from public.commission_entry
      where organization_id = ${ORG} order by share_index`;
    expect(entries.map((e) => [e.technician_id, e.amount])).toEqual([[ray, "53.3400"], [dana, "26.6600"]]);
    for (const e of entries) expect(e.explanation).toContain("Shared this way by the office: Ray sold the system on the first visit.");
    const [event] = await raw<{ split_note: string }[]>`select split_note from public.commission_event where organization_id = ${ORG}`;
    expect(event!.split_note).toBe("Ray sold the system on the first visit.");

    const [logged] = await raw<{ after: Record<string, unknown> }[]>`select after from public.audit_log
      where organization_id = ${ORG} and action = 'commission.earned'`;
    expect(logged!.after).toMatchObject({
      changed: true, splitNote: "Ray sold the system on the first visit.",
      /** The even split between the people on the job, by name. */
      proposed: [{ technicianId: dana, weight: "1" }, { technicianId: ray, weight: "1" }],
    });

    /** The same split again is the same answer; another split is settling twice. */
    const again = await commissions.settleSplit(owner(), { invoiceId, shares, reason: "Ray sold the system on the first visit." });
    expect(again).toMatchObject({ id: done.id, replayed: true });
    await expect(commissions.settleSplit(owner(), { invoiceId, shares: [{ technicianId: ray, weight: "1" }, { technicianId: dana, weight: "1" }] }))
      .rejects.toThrow(ConflictError);

    const { waiting, settled } = await commissions.shared(owner());
    expect(waiting.map((w) => w.invoiceId)).not.toContain(invoiceId);
    expect(settled[0]).toMatchObject({ invoiceId, total: "80.0000", splitNote: "Ray sold the system on the first visit." });
    expect(settled[0]!.parts.map((p) => [p.name, p.weight, p.amount])).toEqual([
      ["Ray Nunez", "2.000000", "53.3400"], ["Dana Pike", "1.000000", "26.6600"],
    ]);
    const shown = await commissions.proposal(owner(), { invoiceId });
    expect(shown.settled?.splitNote).toBe("Ray sold the system on the first visit.");
    expect(shown.refusal).toContain("already earned");
  });

  it("settles the even split with no reason, and leaves out somebody given nothing", async () => {
    await plan();
    const even = await invoiceFor("1000.00", [ray, dana]);
    const done = await commissions.settleSplit(owner(), {
      invoiceId: even, shares: [{ technicianId: dana, weight: "3" }, { technicianId: ray, weight: "3" }],
    });
    expect(done.splitNote).toBeNull();

    const one = await invoiceFor("1000.00", [ray, dana]);
    await commissions.settleSplit(owner(), {
      invoiceId: one, shares: [{ technicianId: ray, weight: "1" }, { technicianId: dana, weight: "0" }],
      reason: "Dana was only there to carry the unit.",
    });
    const paid = await raw<{ technician_id: string; amount: string }[]>`select e.technician_id, e.amount::text
      from public.commission_entry e join public.commission_event ce on ce.id = e.event_id
      where ce.invoice_id = ${one}`;
    expect(paid).toEqual([{ technician_id: ray, amount: "80.0000" }]);
  });

  it("is read with commission:read and settled with commission:configure, as every commission is", async () => {
    await plan();
    const invoiceId = await invoiceFor("1000.00", [ray, dana]);
    await expect(commissions.shared(as(["dispatcher"]))).rejects.toThrow();
    await expect(commissions.proposal(as(["office_manager"]), { invoiceId })).rejects.toThrow();
    await expect(commissions.settleSplit(as(["dispatcher"]), { invoiceId, shares: [{ technicianId: ray, weight: "1" }] }))
      .rejects.toThrow();
    expect((await commissions.proposal(as(["accountant"]), { invoiceId })).total).toBe("80.0000");
  });
});
