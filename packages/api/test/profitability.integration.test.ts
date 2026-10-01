import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as deposits from "../src/services/deposits";
import * as fieldOps from "../src/services/field";
import * as profitability from "../src/services/profitability";
import * as reports from "../src/services/reports";
import { ProfitabilityDimension } from "../src/contracts/profitability";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M15. WHICH WORK MAKES MONEY.
 *
 * Every number asserted below comes out of a job that was really created,
 * really punched against, really invoiced and really paid, through the
 * services a person uses. Seeding a ledger row and a timeclock row that suit
 * the answer would prove the arithmetic in this file and nothing about the
 * product, and the arithmetic is the least interesting part: the figure that
 * matters is the one that falls out of a day somebody actually worked.
 *
 * THE DRAIN JOB BELOW IS BUILT SO THAT EVERY WAY OF GETTING IT WRONG GIVES A
 * DIFFERENT ANSWER.
 *
 *   revenue     600 invoiced less a 50 discount         550.00
 *   material    two fittings at 25                       50.00
 *   labour      seven hours at a frozen loaded 40       280.00
 *   fees        a card fee on the one payment            16.50
 *   margin                                              203.50
 *
 * Read revenue off `invoice.total` instead of the ledger and it is 550 only
 * by luck: it includes tax when there is tax and it keeps a voided invoice.
 * Count the labour job line's own cost as well as the punch and the material
 * is 330 and the margin is 76.50 below the truth. Price the hours at the
 * labour line's price rather than the frozen wage and the labour is 665.
 * Forget the fee and the margin is 220. Four wrong answers, all plausible,
 * none of them 203.50.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m15:org");
const USER = fixtureId("m15:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const as = (
  roles: Actor["roles"],
  extra: Partial<Actor> = {},
): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles, ...extra }, db: db(),
});
const owner = () => as(["owner"]);
const tech = () => as(["technician"]);

let customerId = "";
let propertyId = "";
let technicianId = "";
let drainTypeId = "";
let installTypeId = "";

/** The settled drain job, which the arithmetic above describes. */
let drainJobId = "";
let drainVisitId = "";
/** Still running: a punch open, a line nobody has billed. */
let openJobId = "";
/** Our own rework: real cost, no income. */
let warrantyJobId = "";
/** Invoiced and paid with no hours ever recorded against it. */
let untimedJobId = "";
/** Invoiced and then voided. The ledger says nothing was earned. */
let voidedJobId = "";
/** Hours worked under a classification no wage scale covers. */
let unpricedJobId = "";
/** Two jobs cleared by ONE card payment, so the fee has to be split. */
let sharedBigJobId = "";
let sharedSmallJobId = "";

const ONE_HOUR = 3_600_000;

/** A device per sync, because a device's sequence numbers never skip. */
async function syncAs(
  operations: {
    kind: string; subjectId?: string; occurredAt: Date; payload: Record<string, unknown>;
  }[],
): Promise<void> {
  const { deviceId } = await fieldOps.register(tech(), { installationId: `m15-${randomUUID()}` });
  await fieldOps.sync(tech(), {
    deviceId,
    operations: operations.map((op, i) => ({
      clientId: randomUUID(),
      sequence: i + 1,
      kind: op.kind,
      ...(op.subjectId ? { subjectId: op.subjectId } : {}),
      occurredAt: op.occurredAt.toISOString(),
      payload: op.payload,
    })),
  } as Parameters<typeof fieldOps.sync>[1]);
}

async function makeJob(
  summary: string,
  over: { jobTypeId?: string; minutes?: number; isWarranty?: boolean } = {},
): Promise<{ jobId: string; visitId: string }> {
  const start = new Date(Date.now() - 2 * ONE_HOUR);
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary, tags: [], customFields: {},
    ...(over.jobTypeId ? { jobTypeId: over.jobTypeId } : {}),
    ...(over.isWarranty ? { isWarranty: true } : {}),
    visit: {
      windowStart: start.toISOString(),
      windowEnd: new Date(start.getTime() + 4 * ONE_HOUR).toISOString(),
      estimatedDurationMinutes: over.minutes ?? 240,
      technicianIds: [technicianId],
    },
  });
  const [visit] = await raw<{ id: string }[]>`
    select id from public.visit where job_id = ${job.id} order by sequence limit 1`;
  return { jobId: job.id as string, visitId: visit!.id };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Margin Mechanical", slug: "margin-mech" });

  const [membership] = await raw<{ id: string }[]>`
    select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membership!.id}, 'Ray Nunez', 'Journeyman') returning id`;
  technicianId = t!.id;

  /**
   * Thirty an hour plus ten of fringe. The loaded rate is forty and it is
   * base plus fringe rather than a burden multiplier, because this product
   * has never asked anybody for a burden rate and inventing one would put a
   * number into every margin that nobody chose.
   */
  await raw`insert into public.wage_scale
    (organization_id, authority, classification, base_rate, fringe_rate)
    values (${ORG}, 'employee_default', 'Journeyman', '30.0000', '10.0000')`;

  const [drain] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Drain cleaning') returning id`;
  drainTypeId = drain!.id;
  const [install] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Install') returning id`;
  installTypeId = install!.id;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Marguerite Finn", phone: "+15125550177",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id as string;
  const property = await properties.create(owner(), {
    address: { line1: "41 Margin Way", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id as string;

  // ---- The drain job: four hours scheduled, seven hours worked ----------
  const drain1 = await makeJob("Main line backing up", { jobTypeId: drainTypeId, minutes: 240 });
  drainJobId = drain1.jobId;
  drainVisitId = drain1.visitId;

  const punchIn = new Date(Date.now() - 8 * ONE_HOUR);
  await syncAs([
    {
      kind: "timeclock.punch_in", occurredAt: punchIn,
      payload: { technicianId, jobId: drainJobId, classification: "Journeyman" },
    },
    {
      kind: "visit.add_line", subjectId: drainVisitId, occurredAt: punchIn,
      payload: {
        kind: "part", name: "Cleanout fitting", quantity: "2",
        unitPrice: "40.00", unitCost: "25.00",
      },
    },
    {
      /**
       * A labour line with a cost on it, which is the trap. The seven hours
       * are already on the timeclock; counting this line's cost as well is
       * the same money twice and it is the most flattering arithmetic error
       * available here.
       */
      kind: "visit.add_line", subjectId: drainVisitId, occurredAt: punchIn,
      payload: {
        kind: "labor", name: "Seven hours", quantity: "7",
        unitPrice: "95.00", unitCost: "40.00",
      },
    },
    {
      kind: "timeclock.punch_out", occurredAt: new Date(punchIn.getTime() + 7 * ONE_HOUR),
      payload: { technicianId },
    },
    /**
     * Half an hour off the clock, on the same job and with the same
     * classification, so it would be priced if anything priced it. An unpaid
     * break is the one kind that is not paid, which is the entire thing the
     * kind exists to say, and counting it would add half an hour of hours and
     * twenty dollars of cost to a job nobody was working on.
     */
    {
      kind: "timeclock.punch_in", occurredAt: new Date(punchIn.getTime() + 7 * ONE_HOUR),
      payload: {
        technicianId, jobId: drainJobId, classification: "Journeyman",
        kind: "unpaid_break",
      },
    },
    {
      kind: "timeclock.punch_out",
      occurredAt: new Date(punchIn.getTime() + 7 * ONE_HOUR + ONE_HOUR / 2),
      payload: { technicianId },
    },
  ]);

  /**
   * A second visit that was booked for three hours and never attended.
   * Written directly because cancelling a visit is M09's surface rather than
   * this module's, and what matters here is only that the row exists in the
   * state the fragment claims to exclude: time nobody was expected to spend
   * is not time the job was planned to take, and leaving it in makes every
   * rescheduled job look like it came in under plan.
   */
  await raw`insert into public.visit
    (organization_id, job_id, sequence, status, estimated_duration_minutes)
    values (${ORG}, ${drainJobId}, 2, 'cancelled', 180)`;

  await jobs.complete(owner(), { id: drainVisitId, technicianNotes: "Roots at the cleanout." });

  const drainInvoice = await billing.create(owner(), {
    customerId, jobId: drainJobId,
    lines: [{
      name: "Main line clearing", quantity: "1", unitPrice: "600.00",
      discountAmount: "50.00", taxable: false,
    }],
  });

  /**
   * The flat rate shape: one invoice line, two job lines beneath it. Linking
   * them is what makes the job settled, because `invoice_line_id` null and no
   * `non_billable_reason` is the definition of work nobody has decided about.
   */
  const [invoiceLine] = await raw<{ id: string }[]>`
    select id from public.invoice_line where invoice_id = ${drainInvoice.id}`;
  await raw`update public.job_line set invoice_line_id = ${invoiceLine!.id}
            where job_id = ${drainJobId}`;

  await billing.pay({ ...owner(), idempotencyKey: "m15-drain-pay" }, {
    customerId, method: "card", amount: "550.00", tipAmount: "0", feeAmount: "16.50",
    allocations: [{ invoiceId: drainInvoice.id as string, amount: "550.00" }],
  });

  // ---- Warranty rework: cost, and no income ----------------------------
  const warranty = await makeJob("Come back on the install", { jobTypeId: installTypeId, minutes: 60, isWarranty: true });
  warrantyJobId = warranty.jobId;
  const warrantyPunch = new Date(Date.now() - 6 * ONE_HOUR);
  await syncAs([
    {
      kind: "timeclock.punch_in", occurredAt: warrantyPunch,
      payload: { technicianId, jobId: warrantyJobId, classification: "Journeyman" },
    },
    {
      kind: "visit.add_line", subjectId: warranty.visitId, occurredAt: warrantyPunch,
      payload: {
        kind: "part", name: "Replacement valve", quantity: "1",
        unitPrice: "0", unitCost: "120.00", nonBillableReason: "our_own_rework",
      },
    },
    {
      kind: "timeclock.punch_out", occurredAt: new Date(warrantyPunch.getTime() + 2 * ONE_HOUR),
      payload: { technicianId },
    },
  ]);
  await jobs.complete(owner(), { id: warranty.visitId, technicianNotes: "Reseated the valve." });

  // ---- Invoiced and paid, and nobody ever clocked it -------------------
  const untimed = await makeJob("Water heater swap", { jobTypeId: installTypeId, minutes: 180 });
  untimedJobId = untimed.jobId;
  await jobs.complete(owner(), { id: untimed.visitId, technicianNotes: "Swapped." });

  /**
   * Two hundred down on a card before the van moved, which cost six dollars
   * to take. `postDeposit` tags that fee with the job, unlike a payment's,
   * so this is the fee that lands on the work directly rather than through
   * the allocations.
   */
  const held = await deposits.request(owner(), {
    customerId, jobId: untimedJobId, amount: "200.00",
  });
  await deposits.record(owner(), {
    depositId: held.id as string, amount: "200.00", processingFee: "6.00",
  });

  const untimedInvoice = await billing.create(owner(), {
    customerId, jobId: untimedJobId,
    lines: [{ name: "Water heater", quantity: "1", unitPrice: "1200.00", discountAmount: "0", taxable: false }],
  });
  await deposits.apply(owner(), { id: held.id as string, invoiceId: untimedInvoice.id as string });
  await billing.pay({ ...owner(), idempotencyKey: "m15-untimed-pay" }, {
    customerId, method: "check", amount: "1000.00", tipAmount: "0",
    allocations: [{ invoiceId: untimedInvoice.id as string, amount: "1000.00" }],
  });

  // ---- One payment, two jobs -------------------------------------------
  /**
   * The case the fee allocation exists for. A card fee is posted against the
   * CUSTOMER because a payment can clear invoices on several jobs at once,
   * and there is no job on the row to filter by. Three hundred and one
   * hundred, cleared by one payment that cost twelve dollars to take, splits
   * nine and three.
   */
  const big = await makeJob("Disposal swap", { jobTypeId: installTypeId, minutes: 60 });
  sharedBigJobId = big.jobId;
  const small = await makeJob("Hose bib", { jobTypeId: installTypeId, minutes: 30 });
  sharedSmallJobId = small.jobId;
  const bigInvoice = await billing.create(owner(), {
    customerId, jobId: sharedBigJobId,
    lines: [{ name: "Disposal", quantity: "1", unitPrice: "300.00", discountAmount: "0", taxable: false }],
  });
  const smallInvoice = await billing.create(owner(), {
    customerId, jobId: sharedSmallJobId,
    lines: [{ name: "Hose bib", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false }],
  });
  await billing.pay({ ...owner(), idempotencyKey: "m15-shared-pay" }, {
    customerId, method: "card", amount: "400.00", tipAmount: "0", feeAmount: "12.00",
    allocations: [
      { invoiceId: bigInvoice.id as string, amount: "300.00" },
      { invoiceId: smallInvoice.id as string, amount: "100.00" },
    ],
  });

  // ---- Invoiced, then voided -------------------------------------------
  const voided = await makeJob("Repipe that fell through", { jobTypeId: installTypeId, minutes: 480 });
  voidedJobId = voided.jobId;
  const voidedInvoice = await billing.create(owner(), {
    customerId, jobId: voidedJobId,
    lines: [{ name: "Repipe", quantity: "1", unitPrice: "750.00", discountAmount: "0", taxable: false }],
  });
  await billing.voidInvoice(owner(), { id: voidedInvoice.id as string, reason: "Raised against the wrong property" });

  // ---- Hours nothing could price ---------------------------------------
  const unpriced = await makeJob("Apprentice on a drain", { jobTypeId: drainTypeId, minutes: 60 });
  unpricedJobId = unpriced.jobId;
  const apprenticePunch = new Date(Date.now() - 5 * ONE_HOUR);
  await syncAs([
    {
      kind: "timeclock.punch_in", occurredAt: apprenticePunch,
      // No wage scale covers this classification, so nothing can price it.
      payload: { technicianId, jobId: unpricedJobId, classification: "Apprentice" },
    },
    {
      kind: "timeclock.punch_out", occurredAt: new Date(apprenticePunch.getTime() + 3 * ONE_HOUR),
      payload: { technicianId },
    },
  ]);

  /**
   * LAST, AND THAT ORDER IS NOT ARBITRARY. `timeclock.punch_out` closes the
   * most recent OPEN punch for that technician, whichever job it was on,
   * because a phone that lost a punch in cannot be told its day failed. A
   * punch left open earlier in this fixture would therefore be the one every
   * later punch out closed, and the jobs above would silently lose their
   * hours. Leaving the open one until the end is how a fixture respects a
   * rule the product really has.
   */
  // ---- A job still running --------------------------------------------
  const open = await makeJob("Slab leak, day two", { jobTypeId: installTypeId, minutes: 120 });
  openJobId = open.jobId;
  await syncAs([
    {
      kind: "timeclock.punch_in", occurredAt: new Date(Date.now() - 3 * ONE_HOUR),
      payload: { technicianId, jobId: openJobId, classification: "Journeyman" },
    },
    {
      kind: "visit.add_line", subjectId: open.visitId, occurredAt: new Date(Date.now() - 2 * ONE_HOUR),
      payload: { kind: "part", name: "Copper, 20ft", quantity: "1", unitPrice: "180.00", unitCost: "96.00" },
    },
    {
      // A part with no cost on it, which is unknown rather than free.
      kind: "visit.add_line", subjectId: open.visitId, occurredAt: new Date(Date.now() - 2 * ONE_HOUR),
      payload: { kind: "part", name: "Fittings, off the truck", quantity: "1", unitPrice: "35.00" },
    },
  ]);
});

afterAll(async () => { if (raw) await raw.end(); });

run("what one job earned", () => {
  it("builds the fixture it is about", async () => {
    /**
     * The vacuous case. Every assertion below is about a job with hours, a
     * line and a payment on it, and a fixture that silently failed to create
     * any of them would make most of them pass against zeros.
     */
    const [row] = await raw<{ punches: string; lines: string; payments: string }[]>`
      select
        (select count(*) from public.timeclock_entry where job_id = ${drainJobId}) as punches,
        (select count(*) from public.job_line where job_id = ${drainJobId}) as lines,
        (select count(*) from public.payment where organization_id = ${ORG}) as payments`;
    // Seven hours worked and half an hour of unpaid break, two job lines, and
    // the two payments this fixture takes.
    expect(Number(row!.punches)).toBe(2);
    expect(Number(row!.lines)).toBe(2);
    expect(Number(row!.payments)).toBe(3);
  });

  it("recognises revenue from the ledger, net of the discount and without the tax", async () => {
    /**
     * Rule 4 in packages/db/src/schema/billing.ts: every financial report
     * reads from the ledger. Six hundred was credited to revenue and fifty
     * debited to contra revenue, so the job earned five hundred and fifty,
     * and the discount is visible on its own account rather than netted away
     * where nobody can see how much of it the company is doing.
     */
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    expect(statement.revenue).toBe("550.0000");

    const accounts = statement.revenueEntries.map((e) => e.accountCode).sort();
    expect(accounts).toEqual(["4000", "4900"]);
  });

  it("costs the material and refuses to count the labour line twice", async () => {
    // Two fittings at twenty five. The labour line carries a cost of forty an
    // hour for seven hours and contributes nothing, because those hours are
    // already on the timeclock.
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    expect(statement.materialCost).toBe("50.0000");
  });

  it("costs the hours at the rate frozen onto the punch, not at what they billed", async () => {
    /**
     * Seven hours at the loaded forty. The customer was charged ninety five
     * an hour on the labour line and the hour did not cost ninety five; a
     * margin built on the billed rate is the quoted price of the line, which
     * is the thing this module exists to stop being mistaken for a cost.
     */
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    expect(statement.actualHours).toBe("7.00");
    expect(statement.labourCost).toBe("280.0000");
  });

  it("puts the card fee on the job that was paid for", async () => {
    /**
     * `postPayment` tags the fee with the customer and not the job, because
     * one payment can clear invoices on several jobs. Walking the allocations
     * is what gets it back onto the work, and this payment cleared one
     * invoice, so the whole fee lands here.
     */
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    expect(statement.processingFees).toBe("16.5000");
    expect(statement.feeEntries.map((e) => e.accountCode)).toEqual(["6100"]);
  });

  it("splits one payment's fee across the jobs it cleared, in proportion", async () => {
    /**
     * Twelve dollars taken once, against three hundred and one hundred. The
     * obvious alternatives are both wrong in a way that looks fine: putting
     * the whole fee on the first invoice the payment touched charges one job
     * for the other's cost, and dropping the fee entirely leaves a real
     * expense attributed to nobody while every margin reads a little high.
     */
    const bigger = await profitability.statement(owner(), { jobId: sharedBigJobId });
    const smaller = await profitability.statement(owner(), { jobId: sharedSmallJobId });
    expect(bigger.processingFees).toBe("9.0000");
    expect(smaller.processingFees).toBe("3.0000");
    // And the split is the whole fee, not most of it.
    expect(Number(bigger.processingFees) + Number(smaller.processingFees)).toBe(12);
  });

  it("arrives at the margin, and says it is gross", async () => {
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    // 550 less 50, 280 and 16.50.
    expect(statement.grossMargin).toBe("203.5000");
    expect(statement.grossMarginPercent).toBe(37);
    expect(statement.caveats.overhead).toMatch(/No overhead is allocated/);
    expect(statement.caveats.overtime).toMatch(/premium is NOT included/);
  });

  it("shows the gap between what was scheduled and what it took", async () => {
    // The whole reason a profitable price list produces an unprofitable
    // company: four hours sold, seven hours worked.
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    expect(statement.scheduledHours).toBe("4.00");
    expect(statement.actualHours).toBe("7.00");
    expect(statement.hoursOverPlan).toBe("3.00");
  });

  it("traces every ledger number to the rows it came from", async () => {
    /**
     * A number that cannot be traced back to ledger rows should not be on the
     * report. Revenue is the sum of the entries listed beside it, with the
     * sign convention the statement uses, and this is the assertion that
     * keeps the two from drifting.
     */
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    const net = statement.revenueEntries.reduce(
      (total, e) => total + (e.direction === "credit" ? Number(e.amount) : -Number(e.amount)),
      0,
    );
    expect(net).toBe(Number(statement.revenue));
  });

  it("does not pay for an unpaid break, or plan for a visit nobody attended", async () => {
    /**
     * Two exclusions that each look like a rounding error and are not. The
     * half hour break is the one kind of time that is not paid; counting it
     * adds twenty dollars of cost to a job nobody was working on. The
     * cancelled three hour visit was never time this job was expected to
     * take, and leaving it in makes a job that ran three hours over read as
     * one that came in three hours under.
     */
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    expect(statement.actualHours).toBe("7.00");
    expect(statement.labourCost).toBe("280.0000");
    expect(statement.scheduledHours).toBe("4.00");
  });

  it("calls a settled job settled, with nothing provisional about it", async () => {
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    expect(statement.settled).toBe(true);
    expect(statement.provisional).toEqual([]);
  });
});

run("a job that is not finished being wrong", () => {
  it("is reported rather than hidden, and says why its margin is provisional", async () => {
    /**
     * A job with unbilled labour is not a profitable job, it is an incomplete
     * one. Excluding it would hide the work somebody can still act on;
     * including it silently would put it at the top of a league table on the
     * strength of having all its revenue and half its cost.
     */
    const statement = await profitability.statement(owner(), { jobId: openJobId });
    expect(statement.settled).toBe(false);
    expect(statement.openTimeEntries).toBe(1);
    expect(statement.provisional.join(" ")).toMatch(/still running/);
    expect(statement.provisional.join(" ")).toMatch(/neither billed nor marked non-billable/);
  });

  it("counts an unbilled line as cost that revenue has not arrived for", async () => {
    const statement = await profitability.statement(owner(), { jobId: openJobId });
    expect(statement.unbilledCost).toBe("96.0000");
    expect(statement.revenue).toBe("0.0000");
  });

  it("keeps a deposit's own fee off the revenue it is listed beside", async () => {
    /**
     * A deposit's processing fee is posted against the JOB, unlike a
     * payment's, so it arrives in the same job-tagged read that revenue comes
     * from. Letting it through would put a cost on the revenue list and count
     * it as a credit against the work.
     */
    const statement = await profitability.statement(owner(), { jobId: untimedJobId });
    expect(statement.processingFees).toBe("6.0000");
    expect(statement.feeEntries.map((e) => e.accountCode)).toEqual(["6100"]);
    expect(statement.revenueEntries.map((e) => e.accountCode)).toEqual(["4000"]);
    // The deposit itself earned nothing. It is a liability until the work is done.
    expect(statement.revenue).toBe("1200.0000");
  });

  it("says a job nobody clocked has no labour cost because nobody measured it", async () => {
    /**
     * The quietest way for this report to lie. A job with revenue and no
     * hours has a labour cost of zero, and zero is a plausible number, so it
     * reads as the best work the company does.
     */
    const statement = await profitability.statement(owner(), { jobId: untimedJobId });
    expect(statement.labourRecorded).toBe(false);
    expect(statement.labourCost).toBe("0.0000");
    expect(statement.provisional.join(" ")).toMatch(/because nobody measured it/);
  });

  it("gives warranty rework a null margin percentage rather than a zero", async () => {
    // Real cost, no income. Zero percent would say it broke even.
    const statement = await profitability.statement(owner(), { jobId: warrantyJobId });
    expect(statement.revenue).toBe("0.0000");
    expect(statement.materialCost).toBe("120.0000");
    expect(statement.labourCost).toBe("80.0000");
    expect(statement.grossMargin).toBe("-200.0000");
    expect(statement.grossMarginPercent).toBeNull();
    // The line was marked non-billable, so nothing about it is undecided.
    expect(statement.unbilledCost).toBe("0.0000");
  });
});

run("the ledger is the authority, not the invoice", () => {
  it("earns nothing from an invoice that was voided", async () => {
    /**
     * RULE 4 IN packages/db/src/schema/billing.ts, stated as a test. A void
     * is a reversing posting and never touches `invoice.total`, so a report
     * that read the row would say this job earned seven hundred and fifty
     * pounds of nothing. The row still says so; the ledger does not.
     */
    const statement = await profitability.statement(owner(), { jobId: voidedJobId });
    expect(statement.revenue).toBe("0.0000");

    const [invoice] = await raw<{ total: string; status: string }[]>`
      select total, status from public.invoice where job_id = ${voidedJobId}`;
    expect(invoice!.status).toBe("void");
    expect(Number(invoice!.total)).toBe(750);

    // The reversal and the original are both listed, which is what makes the
    // zero explicable rather than merely correct.
    expect(statement.revenueEntries.length).toBeGreaterThan(1);
  });

  it("shows hours nothing could price rather than costing them at zero", async () => {
    /**
     * `freezeRate` leaves an entry unpriced rather than wrongly priced when
     * no scale matches, and a report that summed those as zero would report a
     * three hour job as free. Visibly unpriced beats silently zero.
     */
    const statement = await profitability.statement(owner(), { jobId: unpricedJobId });
    expect(statement.actualHours).toBe("3.00");
    expect(statement.labourCost).toBe("0.0000");
    expect(statement.unpricedLabourHours).toBe("3.00");
    expect(statement.settled).toBe(false);
    expect(statement.provisional.join(" ")).toMatch(/no wage scale in effect/);
  });

  it("says a line with no cost on it is unknown rather than free", async () => {
    const statement = await profitability.statement(owner(), { jobId: openJobId });
    expect(statement.uncostedLines).toBe(1);
    expect(statement.provisional.join(" ")).toMatch(/no cost recorded/);
    expect(statement.lines.some((l) => l.unitCost === null)).toBe(true);
  });
});

run("rolled up by the thing that changes a decision", () => {
  it("groups margin by job type", async () => {
    const result = await profitability.summary(owner(), { by: "job_type" });
    const drain = result.rows.find((r) => r["job_type"] === "Drain cleaning");
    expect(drain).toBeDefined();
    expect(Number(drain!["gross_margin"])).toBe(203.5);
    expect(Number(drain!["revenue"])).toBe(550);
  });

  it("agrees with the statement for the same job, to the cent", async () => {
    /**
     * The failure this module would otherwise have: a per-job margin and a
     * rolled-up margin that differ by a few dollars, found in a meeting,
     * after which nobody trusts either. They agree because both read the same
     * fragments out of the catalogue.
     */
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    const result = await profitability.summary(owner(), { by: "job", includeInProgress: true });
    const row = result.rows.find((r) => String(r["job"]).includes(statement.summary));
    expect(row).toBeDefined();
    expect(Number(row!["gross_margin"])).toBe(Number(statement.grossMargin));
    expect(Number(row!["labour_cost"])).toBe(Number(statement.labourCost));
    expect(Number(row!["revenue"])).toBe(Number(statement.revenue));
  });

  it("leaves work in progress out by default and puts it back when asked", async () => {
    const settled = await profitability.summary(owner(), { by: "status", includeInProgress: false });
    const all = await profitability.summary(owner(), { by: "status", includeInProgress: true });
    const count = (rows: typeof settled.rows) =>
      rows.reduce((n, r) => n + Number(r["count"]), 0);
    expect(count(all.rows)).toBeGreaterThan(count(settled.rows));
  });

  it("groups by the day of the week, in week order rather than by size", async () => {
    // An owner who learns that drain cleaning loses money on Saturdays can do
    // something about it on Monday, and only if the days are in order.
    const result = await profitability.summary(owner(), { by: "weekday", includeInProgress: true });
    expect(result.columns.find((c) => c.key === "weekday")?.sortPrefix).toBe(true);
    const labels = result.rows.map((r) => String(r["weekday"]));
    expect(labels).toEqual([...labels].sort());
  });

  it("refuses a dimension the catalogue does not have", async () => {
    await expect(reports.run(owner(), {
      dataset: "profitability",
      dimensions: ["job.id) as x, (select current_setting('app.organization_id')"],
      measures: ["gross_margin"],
    })).rejects.toThrow(/Not available/);
  });

  it("runs every profitability report that ships", async () => {
    const shipped = reports.BUILT_IN.filter((r) => r.definition.dataset === "profitability");
    expect(shipped.length).toBeGreaterThan(0);
    for (const report of shipped) {
      await expect(reports.run(owner(), report.definition), report.slug).resolves.toBeTruthy();
    }
  });
});

run("who may read a margin", () => {
  /**
   * The assertions worth more than any of the arithmetic. Cost has been
   * redacted from a technician since this product had a redaction layer, and
   * a report is the obvious way around a field level guard: the column is
   * gone from the job screen and the same number is a `sum` away.
   */
  const dispatcher = () => as(["dispatcher"]);
  /** Holds `job.cost:read`, and may not run the company's financial reports. */
  const officeManager = () => as(["office_manager"]);
  /** Holds `report.financial:read`, and has had job costing taken away. */
  const financeWithoutCost = () =>
    as(["accountant"], { revocations: ["job.cost:read"] });
  /** Real preset: the money permissions, deliberately without payroll. */
  const admin = () => as(["admin"]);

  it("refuses a technician the statement outright", async () => {
    await expect(profitability.statement(tech(), { jobId: drainJobId }))
      .rejects.toThrow(/report.financial:read/);
  });

  it("refuses a technician the report, rather than blanking the cost column", async () => {
    /**
     * Refused rather than blanked, because a report that quietly drops the
     * column somebody asked for teaches them the number is zero and they act
     * on it.
     */
    await expect(reports.run(dispatcher(), {
      dataset: "profitability", dimensions: ["job_type"], measures: ["gross_margin"],
    })).rejects.toThrow(/report.financial:read/);
  });

  it("refuses job costing to a reader who may see revenue but not cost", async () => {
    await expect(reports.run(financeWithoutCost(), {
      dataset: "profitability", dimensions: ["job_type"], measures: ["revenue", "gross_margin"],
    })).rejects.toThrow(/job.cost:read/);

    // And the revenue half still runs, so the refusal above is about the
    // measure rather than about the dataset.
    const allowed = await reports.run(financeWithoutCost(), {
      dataset: "profitability", dimensions: ["job_type"], measures: ["revenue"],
    });
    expect(allowed.rows.length).toBeGreaterThan(0);
  });

  it("refuses the statement to a reader without job costing", async () => {
    await expect(profitability.statement(financeWithoutCost(), { jobId: drainJobId }))
      .rejects.toThrow(/job.cost:read/);
  });

  it("refuses the statement to somebody who holds job costing and not the financial report", async () => {
    /**
     * The hole this closes: a statement discloses revenue, so serving it to
     * a reader the catalogue would refuse makes it the financial report with
     * a loop around it. Ten thousand calls and you have the roll-up.
     */
    await expect(profitability.statement(officeManager(), { jobId: drainJobId }))
      .rejects.toThrow(/report.financial:read/);
  });

  it("does not name whose hours they were without payroll:read", async () => {
    /**
     * `admin` holds both money permissions and deliberately not
     * `payroll:read`. Four hours and a hundred and sixty dollars beside a
     * name is a forty dollar loaded rate, which is that person's wage.
     */
    const statement = await profitability.statement(admin(), { jobId: drainJobId });
    expect(statement.labour.length).toBeGreaterThan(0);
    expect(statement.labour.every((l) => l.technicianName === null)).toBe(true);
    expect(statement.labour.every((l) => l.technicianId === null)).toBe(true);
    // The job's own totals are job costing and are not withheld.
    expect(statement.labourCost).toBe("280.0000");
  });

  it("names them for somebody who does hold payroll:read", async () => {
    // The other half, so the test above cannot pass against a breakdown that
    // is empty for everybody.
    const statement = await profitability.statement(owner(), { jobId: drainJobId });
    expect(statement.labour.map((l) => l.technicianName)).toEqual(["Ray Nunez"]);
    expect(statement.labour[0]!.hours).toBe("7.00");
  });

  it("scopes a technician who has been granted the money permissions to their own work", async () => {
    /**
     * A working owner who gives themselves a technician record and keeps the
     * money is a real configuration. Without a scope filter on this dataset
     * they read the margin on every job in the company.
     */
    const theirs = as(["technician"], {
      technicianId,
      grants: ["report.financial:read", "job.cost:read"],
    });
    const statement = await profitability.statement(theirs, { jobId: drainJobId });
    expect(statement.grossMargin).toBe("203.5000");

    // A job they were never sent to is not found, which is the same answer as
    // a job that does not exist: distinguishing them lists the job numbers.
    const [other] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 990001, ${customerId}, ${propertyId}, 'completed', 'Somebody else''s job')
      on conflict (organization_id, number) do update set summary = excluded.summary
      returning id`;
    await expect(profitability.statement(theirs, { jobId: other!.id }))
      .rejects.toThrow(NotFoundError);
    // And an owner can read the same job, so the refusal is the scope rather
    // than a job the fixture failed to create.
    await expect(profitability.statement(owner(), { jobId: other!.id })).resolves.toBeTruthy();
  });

  it("scopes the roll-up too, not only the statement", async () => {
    const theirs = as(["technician"], {
      technicianId,
      grants: ["report.financial:read", "job.cost:read"],
    });
    const mine = await profitability.summary(theirs, { by: "job", includeInProgress: true });
    const all = await profitability.summary(owner(), { by: "job", includeInProgress: true });
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(all.rows.length).toBeGreaterThan(mine.rows.length);
  });
});

/**
 * TWO COPIES OF A LIST DISAGREE EVENTUALLY.
 *
 * The contract spells the dimensions out as an enum so a bad `by` is a 422
 * naming the eleven that work rather than a refusal naming a key nobody can
 * list. That is worth having and it is a second copy: a dimension added to
 * the catalogue and not to the enum is unreachable through the API, and one
 * added to the enum and not to the catalogue is a request the server rejects
 * for a reason the caller cannot act on. Neither is a type error.
 *
 * No database, so it runs for a contributor who has none.
 */
describe("the route and the catalogue offer the same dimensions", () => {
  it("names exactly what the dataset has", () => {
    expect([...ProfitabilityDimension.options].sort())
      .toEqual([...profitability.SUMMARY_DIMENSIONS].sort());
  });
});
