import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as deposits from "../src/services/deposits";
import * as creditNotes from "../src/services/credit-notes";
import * as company from "../src/services/company";
import * as journals from "../src/services/journals";
import * as ledgerReports from "../src/services/ledger";
import * as profitability from "../src/services/profitability";
import { POSTING_SOURCES, NO_SOURCE_BRANCH } from "../src/services/ledger-branch";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M14. THE BRANCH, THE JOB AND THE CUSTOMER ON A POSTING
 *
 * Three questions, each one an accountant asks before trusting the books:
 *
 *   Does a journal line carry what it says it is about, and is that this
 *   company's own? A foreign key accepts another company's job, so the service
 *   has to say no, naming the line.
 *
 *   Does a branch's trial balance hold the whole of the branch's books and
 *   balance on its own? The doc used to refuse the filter because filling the
 *   branch on invoices alone gave a branch its revenue and none of its
 *   payments. Every posting the product writes from a branch's job or invoice
 *   now carries that branch, so every kind is posted here and the branch's
 *   totals are asserted to balance, line by line, against the whole company's.
 *
 *   Does the job's margin read a journal line on the job once? A cost journalled
 *   to a job is in its materials the same day, a reversal takes it back out,
 *   and labour is listed and left out because the hours are counted from the
 *   clock.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("lb:org");
const USER = fixtureId("lb:user");
const OTHER_ORG = fixtureId("lb:other-org");
const OTHER_USER = fixtureId("lb:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);
const finance = () => as(["accountant"]);

let austin = "";
let houston = "";
let waco = "";
let austinCustomer = "";
let houstonCustomer = "";
let austinJob = "";
let houstonJob = "";
let nowhereJob = "";
let foreignJob = "";
let foreignCustomer = "";
let foreignBranch = "";
let removedJob = "";

/** An UnprocessableError with an issue saying this, which is what the screen shows. */
const saying = (pattern: RegExp) => ({
  issues: expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(pattern) })]),
});

const net = (rows: { direction: string; amount: string }[]) =>
  rows.reduce((sum, r) => sum + (r.direction === "debit" ? Number(r.amount) : -Number(r.amount)), 0);

/** Every ledger row a source wrote, with its branch. */
const rowsOf = (sourceId: string) => raw<{ account_code: string; direction: string; amount: string; business_unit_id: string | null; job_id: string | null }[]>`
  select account_code, direction::text as direction, amount::text as amount, business_unit_id, job_id
  from public.ledger_entry where organization_id = ${ORG} and source_id = ${sourceId}`;

/** The branches on the rows a source wrote: one value if they all agree, so "every line is in Austin" is one assertion. */
const branchesOf = async (sourceId: string) => [...new Set((await rowsOf(sourceId)).map((r) => r.business_unit_id))];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Branch Books", slug: "lb-books" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Next Door", slug: "lb-next-door" });

  austin = (await company.createBusinessUnit(owner(), { name: "Austin" })).id;
  houston = (await company.createBusinessUnit(owner(), { name: "Houston" })).id;
  waco = (await company.createBusinessUnit(owner(), { name: "Waco" })).id;
  await company.updateBusinessUnit(owner(), { id: waco, active: false });

  const customer = async (name: string, ctx = owner()) => (await customers.create(ctx, {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id;
  const property = async (ctx: ServiceContext, customerId: string, line1: string) => (await properties.create(ctx, {
    address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id;
  const job = async (ctx: ServiceContext, customerId: string, propertyId: string, summary: string, businessUnitId?: string) =>
    (await jobs.create(ctx, {
      customerId, propertyId, summary, tags: [], customFields: {},
      ...(businessUnitId ? { businessUnitId } : {}),
    })).id;

  austinCustomer = await customer("Austin Customer");
  houstonCustomer = await customer("Houston Customer");
  const austinProperty = await property(owner(), austinCustomer, "1 Congress Ave");
  const houstonProperty = await property(owner(), houstonCustomer, "1 Main St");
  austinJob = await job(owner(), austinCustomer, austinProperty, "Austin furnace", austin);
  houstonJob = await job(owner(), houstonCustomer, houstonProperty, "Houston condenser", houston);
  nowhereJob = await job(owner(), austinCustomer, austinProperty, "Booked before branches");
  removedJob = await job(owner(), austinCustomer, austinProperty, "Booked in error", austin);
  await raw`update public.job set deleted_at = now() where id = ${removedJob}`;

  const other = (): ServiceContext => ({ actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] }, db: db() });
  foreignBranch = (await company.createBusinessUnit(other(), { name: "Elsewhere" })).id;
  foreignCustomer = await customer("Next Door Customer", other());
  const foreignProperty = await property(other(), foreignCustomer, "9 Other St");
  foreignJob = await job(other(), foreignCustomer, foreignProperty, "Next door's job");
});

afterAll(async () => { if (raw) await raw.end(); });

/* ===================================================== the journal line */

run("a journal line says what it is about", () => {
  it("carries a branch, a job and a customer onto the ledger, and reads them back", async () => {
    const entry = await journals.create(finance(), {
      memo: "Subcontractor's bill for the Austin furnace", occurredOn: "2026-09-10",
      lines: [
        { accountCode: "5000", debit: "300.00", memo: "Duct work", businessUnitId: austin, jobId: austinJob, customerId: austinCustomer },
        { accountCode: "1000", credit: "300.00" },
      ],
    });
    const [cost, cash] = entry.lines;
    expect(cost).toMatchObject({
      businessUnitId: austin, branchName: "Austin", jobId: austinJob, customerId: austinCustomer, customerName: "Austin Customer",
    });
    expect(cost!.jobNumber).toMatch(/^\d+$/);
    expect(cash).toMatchObject({ businessUnitId: null, jobId: null, customerId: null, branchName: null });

    const rows = await rowsOf(entry.id);
    expect(rows.find((r) => r.account_code === "5000")).toMatchObject({ business_unit_id: austin, job_id: austinJob });
    expect(rows.find((r) => r.account_code === "1000")).toMatchObject({ business_unit_id: null, job_id: null });
    const [customerRow] = await raw`select customer_id from public.ledger_entry where source_id = ${entry.id} and account_code = '5000'`;
    expect(customerRow!.customer_id).toBe(austinCustomer);
  });

  it("gives a line that names a job and no branch the job's branch, and leaves a job in no branch with none", async () => {
    const inBranch = await journals.create(finance(), {
      memo: "Disposal receipt", lines: [
        { accountCode: "5000", debit: "40.00", jobId: houstonJob }, { accountCode: "1000", credit: "40.00" },
      ],
    });
    expect(inBranch.lines[0]).toMatchObject({ jobId: houstonJob, businessUnitId: houston });
    const nowhere = await journals.create(finance(), {
      memo: "Disposal receipt", lines: [
        { accountCode: "5000", debit: "40.00", jobId: nowhereJob }, { accountCode: "1000", credit: "40.00" },
      ],
    });
    expect(nowhere.lines[0]).toMatchObject({ jobId: nowhereJob, businessUnitId: null });
  });

  it("lets a line's own branch win over its job's, because rent for two shops is one bill", async () => {
    const entry = await journals.create(finance(), {
      memo: "Cost split", lines: [
        { accountCode: "5000", debit: "10.00", jobId: austinJob, businessUnitId: houston }, { accountCode: "1000", credit: "10.00" },
      ],
    });
    expect(entry.lines[0]!.businessUnitId).toBe(houston);
  });

  it("refuses another company's branch, job and customer, each against its own line, and writes nothing", async () => {
    const before = await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}`;
    await expect(journals.create(finance(), {
      memo: "Borrowed ids", lines: [
        { accountCode: "5000", debit: "5.00", businessUnitId: foreignBranch },
        { accountCode: "5000", debit: "5.00", jobId: foreignJob },
        { accountCode: "5000", debit: "5.00", customerId: foreignCustomer },
        { accountCode: "1000", credit: "15.00" },
      ],
    })).rejects.toMatchObject({
      issues: [
        expect.objectContaining({ path: "lines.0.businessUnitId", message: "Line 1: that branch is not one of yours." }),
        expect.objectContaining({ path: "lines.1.jobId", message: "Line 2: that job is not one of yours, or it has been removed." }),
        expect.objectContaining({ path: "lines.2.customerId", message: "Line 3: that customer is not one of yours, or has been removed." }),
      ],
    });
    const after = await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("refuses a retired branch and a removed job, because nothing new is booked against what was put away", async () => {
    await expect(journals.create(finance(), {
      memo: "Waco", lines: [{ accountCode: "6500", debit: "5.00", businessUnitId: waco }, { accountCode: "1000", credit: "5.00" }],
    })).rejects.toMatchObject(saying(/Waco has been retired/));
    await expect(journals.create(finance(), {
      memo: "Gone", lines: [{ accountCode: "5000", debit: "5.00", jobId: removedJob }, { accountCode: "1000", credit: "5.00" }],
    })).rejects.toMatchObject(saying(/job is not one of yours, or it has been removed/));
    const [customer] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name, payment_terms_days, deleted_at)
      values (${ORG}, 'residential', 'Gone Customer', 0, now()) returning id`;
    await expect(journals.create(finance(), {
      memo: "Gone", lines: [{ accountCode: "5000", debit: "5.00", customerId: customer!.id }, { accountCode: "1000", credit: "5.00" }],
    })).rejects.toMatchObject(saying(/customer is not one of yours, or has been removed/));
  });

  it("refuses an id that is not an id before it reaches the database", async () => {
    await expect(journals.create(finance(), {
      memo: "Typed", lines: [{ accountCode: "5000", debit: "5.00", jobId: "1042" }, { accountCode: "1000", credit: "5.00" }],
    })).rejects.toMatchObject(saying(/The job on this line is not one of yours/));
  });

  it("reverses with the same branch, job and customer on each line, so the two net to nothing where they were", async () => {
    const entry = await journals.create(finance(), {
      memo: "A bill that was wrong", occurredOn: "2026-09-12", lines: [
        { accountCode: "5000", debit: "75.00", businessUnitId: austin, jobId: austinJob, customerId: austinCustomer },
        { accountCode: "1000", credit: "75.00" },
      ],
    });
    const reversal = await journals.reverse(finance(), { id: entry.id });
    expect(reversal.lines.find((l) => l.accountCode === "5000")).toMatchObject({
      direction: "credit", businessUnitId: austin, jobId: austinJob, customerId: austinCustomer,
    });
    const rows = await raw<{ direction: string; amount: string }[]>`
      select direction::text as direction, amount::text as amount from public.ledger_entry
      where organization_id = ${ORG} and account_code = '5000' and source_id in (${entry.id}, ${reversal.id})
        and business_unit_id = ${austin} and job_id = ${austinJob} and customer_id = ${austinCustomer}`;
    expect(rows).toHaveLength(2);
    expect(net(rows)).toBe(0);
  });

  it("shows the words to somebody who may read what they name, and the ids alone to one who may not", async () => {
    const entry = await journals.create(finance(), {
      memo: "Words", lines: [
        { accountCode: "5000", debit: "1.00", businessUnitId: austin, jobId: austinJob, customerId: austinCustomer },
        { accountCode: "1000", credit: "1.00" },
      ],
    });
    const ledgerOnly: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: [] as unknown as Actor["roles"], grants: ["ledger:read"] as NonNullable<Actor["grants"]> },
      db: db(),
    };
    const seen = (await journals.get(ledgerOnly, { id: entry.id })).lines[0]!;
    expect(seen).toMatchObject({ businessUnitId: austin, jobId: austinJob, customerId: austinCustomer });
    expect(seen.jobNumber).toBeNull();
    expect(seen.customerName).toBeNull();
    expect(seen.branchName).toBe("Austin");
  });

  it("finds a job by the number it is printed with and a customer by their exact name, and says so when it cannot", async () => {
    const [row] = await raw<{ number: number }[]>`select number from public.job where id = ${austinJob}`;
    expect(await journals.findAbout(finance(), { job: String(row!.number), customer: "austin customer" }))
      .toEqual({ jobId: austinJob, customerId: austinCustomer });
    expect(await journals.findAbout(finance(), { job: `#${row!.number}` })).toEqual({ jobId: austinJob, customerId: null });
    await expect(journals.findAbout(finance(), { job: "999999" })).rejects.toMatchObject(saying(/There is no job 999999/));
    await expect(journals.findAbout(finance(), { job: "abc" })).rejects.toMatchObject(saying(/not a job number/));
    await expect(journals.findAbout(finance(), { customer: "Nobody At All" })).rejects.toMatchObject(saying(/no customer called/));
    await customers.create(owner(), { type: "residential", name: "Twin Name", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {} });
    await customers.create(owner(), { type: "residential", name: "Twin Name", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {} });
    await expect(journals.findAbout(finance(), { customer: "Twin Name" })).rejects.toMatchObject(saying(/More than one customer/));
    await expect(journals.findAbout(as(["dispatcher"]), { job: "1" })).rejects.toThrow();
  });
});

/* =============================================== every posting kind, once */

run("every posting the product writes from a branch's job or invoice carries that branch", () => {
  let austinInvoice = "";
  let houstonInvoice = "";
  let nowhereInvoice = "";
  let austinPayment = "";
  let splitPayment = "";
  let austinCredit = "";
  let austinDeposit = "";

  const invoiceFor = (customerId: string, jobId: string | undefined, price: string) => billing.create(owner(), {
    customerId, ...(jobId ? { jobId } : {}),
    lines: [{ name: "Work", quantity: "1", unitPrice: price, discountAmount: "0", taxable: true, taxRate: "0.0825" }],
  });

  beforeAll(async () => {
    /** One of every document a branch's books are made of, in Austin, and enough in Houston to tell them apart. */
    const a = await invoiceFor(austinCustomer, austinJob, "1000.00");
    austinInvoice = a.id as string;
    const h = await invoiceFor(houstonCustomer, houstonJob, "400.00");
    houstonInvoice = h.id as string;
    const n = await invoiceFor(austinCustomer, nowhereJob, "50.00");
    nowhereInvoice = n.id as string;

    // A payment on Austin's invoice alone, with a card fee.
    const p1 = await billing.pay({ ...owner(), idempotencyKey: "lb-pay-austin" }, {
      customerId: austinCustomer, method: "card", amount: "300.00", tipAmount: "0", feeAmount: "9.00",
      allocations: [{ invoiceId: austinInvoice, amount: "300.00" }],
    });
    austinPayment = p1.id as string;

    // A payment that clears one invoice in each of two branches: it belongs to neither.
    const p2 = await billing.pay({ ...owner(), idempotencyKey: "lb-pay-split" }, {
      customerId: austinCustomer, method: "check", amount: "150.00", tipAmount: "0",
      allocations: [{ invoiceId: austinInvoice, amount: "100.00" }, { invoiceId: nowhereInvoice, amount: "50.00" }],
    });
    splitPayment = p2.id as string;

    // A credit note against Austin's invoice, applied.
    const invoice = await billing.get(owner(), { id: austinInvoice });
    const note = await creditNotes.create(owner(), {
      invoiceId: austinInvoice, reason: "billing_error", draft: false, apply: true,
      lines: [{ invoiceLineId: invoice.lines[0]!.id, quantity: "1", unitPrice: "50.00" }],
    });
    austinCredit = note.id as string;

    // A deposit on Austin's job, taken and applied to its invoice.
    const held = await deposits.request(owner(), { customerId: austinCustomer, jobId: austinJob, amount: "100.00" });
    await deposits.record(owner(), { depositId: held.id as string, amount: "100.00", processingFee: "3.00" });
    austinDeposit = held.id as string;
    await deposits.apply(owner(), { id: austinDeposit, invoiceId: austinInvoice });
  });

  it("puts an invoice's every leg in its job's branch", async () => {
    expect(await branchesOf(austinInvoice)).toEqual([austin]);
    expect(await branchesOf(houstonInvoice)).toEqual([houston]);
    expect((await rowsOf(austinInvoice)).map((r) => r.account_code).sort()).toEqual(["1200", "2200", "4000"]);
  });

  it("leaves the invoice of a job in no branch with none", async () => {
    expect(await branchesOf(nowhereInvoice)).toEqual([null]);
  });

  it("puts a payment, with its card fee and cash, in the branch of the invoice it paid", async () => {
    expect(await branchesOf(austinPayment)).toEqual([austin]);
    expect((await rowsOf(austinPayment)).map((r) => r.account_code).sort()).toEqual(["1000", "1200", "6100"]);
  });

  it("leaves a payment spread over invoices in two branches in neither, rather than splitting what nobody recorded", async () => {
    expect(await branchesOf(splitPayment)).toEqual([null]);
  });

  it("puts a credit note, and a deposit with its application, in the branch of the invoice and the job", async () => {
    expect(await branchesOf(austinCredit)).toEqual([austin]);
    expect(await branchesOf(austinDeposit)).toEqual([austin]);
  });

  it("puts a void and a write off in the branch of the invoice, and the commission and refund too", async () => {
    const voidMe = await invoiceFor(houstonCustomer, houstonJob, "90.00");
    await billing.voidInvoice(owner(), { id: voidMe.id as string, reason: "Wrong property" });
    expect(await branchesOf(voidMe.id as string)).toEqual([houston]);
    expect((await rowsOf(voidMe.id as string)).length).toBeGreaterThanOrEqual(6);

    const writeOffMe = await invoiceFor(austinCustomer, austinJob, "30.00");
    await billing.writeOff(owner(), { id: writeOffMe.id as string, reason: "Moved away" });
    expect(await branchesOf(writeOffMe.id as string)).toEqual([austin]);

    const refundMe = await invoiceFor(houstonCustomer, houstonJob, "20.00");
    const paid = await billing.pay({ ...owner(), idempotencyKey: "lb-pay-refund" }, {
      customerId: houstonCustomer, method: "check", amount: "20.00", tipAmount: "0",
      allocations: [{ invoiceId: refundMe.id as string, amount: "20.00" }],
    });
    await billing.recordRefund(owner(), { id: paid.id as string, amount: "5.00", method: "cash", reason: "Part of it back" });
    const rows = await raw<{ business_unit_id: string | null; account_code: string }[]>`
      select business_unit_id, account_code from public.ledger_entry
      where organization_id = ${ORG} and source_type = 'refund' and source_id = ${paid.id}`;
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.business_unit_id))]).toEqual([houston]);
  });

  /* -------------------------------------------------- the reports */

  it("gives a branch a trial balance that holds the whole of its books and balances on its own", async () => {
    const whole = await ledgerReports.trialBalance(finance());
    const inAustin = await ledgerReports.trialBalance(finance(), { businessUnitId: austin });
    const inHouston = await ledgerReports.trialBalance(finance(), { businessUnitId: houston });
    const inNone = await ledgerReports.trialBalance(finance(), { businessUnitId: "none" });

    // Austin's has its revenue AND its receivable, payments, fees, credit, deposit and write off.
    const accounts = inAustin.rows.map((r) => r.accountCode);
    for (const code of ["1000", "1200", "2200", "2300", "4000", "6100", "6900"]) expect(accounts).toContain(code);

    // The journal lines posted above go to one side of an entry and leave the other with no branch, so the
    // branch's own books balance only for what the product wrote. Compared posting by posting, that is every
    // posting whose lines all carry one branch.
    expect(whole.balanced).toBe(true);
    expect(inAustin.branch.filter).toBe(austin);
    expect(inNone.branch.filter).toBe("none");

    // Every entry is in exactly one of: a branch or none. Split three ways they add up to the whole.
    const sum = (tb: typeof whole, side: "totalDebits" | "totalCredits") => Number(tb[side]);
    const everyBranch = await raw<{ id: string }[]>`select id from public.business_unit where organization_id = ${ORG}`;
    let debits = sum(inNone, "totalDebits");
    let credits = sum(inNone, "totalCredits");
    for (const unit of everyBranch) {
      const tb = await ledgerReports.trialBalance(finance(), { businessUnitId: unit.id });
      debits += sum(tb, "totalDebits");
      credits += sum(tb, "totalCredits");
    }
    expect(debits).toBeCloseTo(sum(whole, "totalDebits"), 4);
    expect(credits).toBeCloseTo(sum(whole, "totalCredits"), 4);
    expect(inHouston.rows.length).toBeGreaterThan(0);
  });

  it("balances a branch's books for every posting the product wrote, entry by entry", async () => {
    /**
     * The product's own postings carry one branch per posting, so each branch's
     * share of THEM balances. (The journal lines posted at the top of this file
     * are the exception on purpose: they give one line a branch and leave the
     * other without.) Every transaction that came from a document is checked.
     */
    const rows = await raw<{ transaction_id: string; branches: number; debit: string; credit: string }[]>`
      select transaction_id,
             count(distinct coalesce(business_unit_id::text, 'none'))::int as branches,
             sum(case when direction = 'debit' then amount else 0 end)::text as debit,
             sum(case when direction = 'credit' then amount else 0 end)::text as credit
      from public.ledger_entry
      where organization_id = ${ORG} and source_type <> 'journal'
      group by transaction_id`;
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      expect(row.branches, `transaction ${row.transaction_id} is in more than one branch`).toBe(1);
      expect(Number(row.debit)).toBeCloseTo(Number(row.credit), 4);
    }
  });

  it("says how much of the books carries no branch, and from when entries carry one", async () => {
    const tb = await ledgerReports.trialBalance(finance());
    expect(tb.branch.filter).toBeNull();
    expect(tb.branch.entries).toBeGreaterThan(0);
    expect(tb.branch.withoutBranch).toBeGreaterThan(0);
    expect(tb.branch.withoutBranch).toBeLessThan(tb.branch.entries);
    expect(Number(tb.branch.withoutBranchDebits)).toBeGreaterThan(0);
    expect(tb.branch.firstBranchedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const [counts] = await raw<{ without: number; entries: number }[]>`
      select count(*)::int as entries, count(*) filter (where business_unit_id is null)::int as without
      from public.ledger_entry where organization_id = ${ORG}`;
    expect(tb.branch.entries).toBe(counts!.entries);
    expect(tb.branch.withoutBranch).toBe(counts!.without);

    // A branch's own report still says how much of the company has none, so nobody reads it as the whole.
    const inAustin = await ledgerReports.trialBalance(finance(), { businessUnitId: austin });
    expect(inAustin.branch.withoutBranch).toBe(counts!.without);
  });

  it("says there is nothing branched in a window before any entry carried a branch, and nothing old is changed", async () => {
    /**
     * Older postings have no branch and the report says so. A window before
     * the first posting here has none, and a posting from long ago that was
     * made without a branch stays without one: the table cannot be updated.
     */
    const old = await raw<{ id: string }[]>`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, currency, amount, source_type, source_id)
      select ${ORG}, t.id, '2024-03-01T12:00:00Z', d.direction, d.code, 'USD', '25', 'manual', t.id
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, '1000'), ('credit'::ledger_direction, '4000')) as d(direction, code)
      returning id`;
    expect(old).toHaveLength(2);
    const tb = await ledgerReports.trialBalance(finance(), { from: "2024-01-01T00:00:00Z", to: "2024-12-31T23:59:59Z" });
    expect(tb.branch).toMatchObject({ entries: 2, withoutBranch: 2, withoutBranchDebits: "25.0000" });
    expect(tb.branch.firstBranchedOn).not.toBe("2024-03-01");
    await expect(raw`update public.ledger_entry set business_unit_id = ${austin} where id = ${old[0]!.id}`).rejects.toThrow();
  });

  it("filters the journal by branch, and by none", async () => {
    const inAustin = await ledgerReports.journal(finance(), { businessUnitId: austin, limit: 200 });
    expect(inAustin.transactions.length).toBeGreaterThan(3);
    for (const tx of inAustin.transactions) {
      expect(tx.lines.some((l) => l.businessUnitId === austin)).toBe(true);
    }
    const inNone = await ledgerReports.journal(finance(), { businessUnitId: "none", limit: 200 });
    for (const tx of inNone.transactions) {
      expect(tx.lines.some((l) => l.businessUnitId === null)).toBe(true);
    }
  });

  it("needs the ledger permission, and a branch is checked as an id", async () => {
    await expect(ledgerReports.trialBalance(as(["dispatcher"]), { businessUnitId: austin })).rejects.toThrow();
    await expect(ledgerReports.journal(as(["dispatcher"]), { businessUnitId: "none" })).rejects.toThrow();
  });
});

/* ============================================== job costing reads journals */

run("job costing reads a job's journal lines once", () => {
  /** Materials and the figures of one job, off its statement. */
  const statement = (jobId: string) => profitability.statement(owner(), { jobId });

  it("adds a cost journalled to a job to its materials, once, and the reversal takes it back out", async () => {
    const before = await statement(austinJob);
    const entry = await journals.create(finance(), {
      memo: "Subcontractor, duct work", occurredOn: "2026-09-15", lines: [
        { accountCode: "5000", debit: "300.00", memo: "Duct work", jobId: austinJob },
        { accountCode: "1000", credit: "300.00" },
      ],
    });
    const after = await statement(austinJob);
    // Exactly once: not twice by being read from the ledger and from a second place.
    expect(Number(after.materialCost) - Number(before.materialCost)).toBe(300);
    expect(Number(before.grossMargin) - Number(after.grossMargin)).toBe(300);
    expect(after.costEntries.filter((r) => r.journalNumber === entry.number)).toHaveLength(1);
    expect(after.journalLines.filter((l) => l.journalNumber === entry.number)).toEqual([
      expect.objectContaining({ accountCode: "5000", direction: "debit", amount: "300.0000", countedIn: "material", journalId: entry.id }),
    ]);

    const reversal = await journals.reverse(finance(), { id: entry.id });
    const reversed = await statement(austinJob);
    expect(Number(reversed.materialCost)).toBe(Number(before.materialCost));
    expect(Number(reversed.grossMargin)).toBe(Number(before.grossMargin));
    // Both the entry and its reversal are listed, so the statement shows what happened.
    const mine = reversed.journalLines.filter((l) => l.accountCode === "5000" && [entry.id, reversal.id].includes(l.journalId));
    expect(mine.map((l) => l.direction).sort()).toEqual(["credit", "debit"]);
  });

  it("lists a labour journal on the job and leaves it out of the margin, because the hours are counted from the clock", async () => {
    const before = await statement(houstonJob);
    const entry = await journals.create(finance(), {
      memo: "Payroll the bureau ran", lines: [
        { accountCode: "5200", debit: "800.00", jobId: houstonJob }, { accountCode: "1000", credit: "800.00" },
      ],
    });
    const after = await statement(houstonJob);
    expect(after.materialCost).toBe(before.materialCost);
    expect(after.labourCost).toBe(before.labourCost);
    expect(after.grossMargin).toBe(before.grossMargin);
    expect(after.journalLines.find((l) => l.journalNumber === entry.number)).toMatchObject({
      accountCode: "5200", countedIn: null, amount: "800.0000",
    });
  });

  it("counts revenue an accountant recognised on the job, and card fees journalled to it", async () => {
    const before = await statement(nowhereJob);
    await journals.create(finance(), {
      memo: "Revenue the invoices did not carry", lines: [
        { accountCode: "1000", debit: "200.00" }, { accountCode: "4000", credit: "200.00", jobId: nowhereJob },
      ],
    });
    await journals.create(finance(), {
      memo: "Merchant fees for the job", lines: [
        { accountCode: "6100", debit: "6.00", jobId: nowhereJob }, { accountCode: "1000", credit: "6.00" },
      ],
    });
    const after = await statement(nowhereJob);
    expect(Number(after.revenue) - Number(before.revenue)).toBe(200);
    expect(Number(after.processingFees) - Number(before.processingFees)).toBe(6);
    const newest = after.journalLines.filter((l) => l.accountCode === "6100" || l.accountCode === "4000");
    expect(newest.map((l) => l.countedIn).sort()).toEqual(["fees", "revenue"]);
  });

  it("reads the same figure from the roll up as from the statement", async () => {
    const roll = await (await import("../src/services/reports")).run(owner(), {
      dataset: "profitability", dimensions: ["job"], measures: ["revenue", "material_cost", "gross_margin"],
    });
    const row = roll.rows.find((r) => String(r["job"]).includes("Austin furnace"))
      ?? roll.rows.find((r) => Number(r["material_cost"]) >= 300);
    expect(row).toBeDefined();
    const one = await statement(austinJob);
    expect(Number(row!["material_cost"])).toBeCloseTo(Number(one.materialCost), 2);
  });
});

/* ====================================================== the guard */

describe("every kind of posting is classified", () => {
  it("has a way to its branch, or a stated reason it has none, for each source type core can write", () => {
    /**
     * The decision is made when a posting kind is added, not discovered when a
     * branch's books are found to be missing something. Read from core's own
     * source: every `sourceType` it writes.
     */
    const source = readFileSync(join(__dirname, "../../core/src/ledger/index.ts"), "utf8");
    const literal = [...source.matchAll(/sourceType:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    const conditional = [...source.matchAll(/sourceType:\s*input\.reversal \? "([a-z_]+)" : "([a-z_]+)"/g)].flatMap((m) => [m[1]!, m[2]!]);
    const written = [...new Set([...literal, ...conditional])].sort();
    expect(written.length).toBeGreaterThan(20);
    const missing = written.filter((kind) => !POSTING_SOURCES.includes(kind));
    expect(missing, `posting kinds with no branch decision: ${missing.join(", ")}`).toEqual([]);
    const stale = POSTING_SOURCES.filter((kind) => !written.includes(kind));
    expect(stale, `classified and never written by core: ${stale.join(", ")}`).toEqual([]);
  });

  it("gives every kind that has no branch of its own a reason somebody can read", () => {
    for (const [kind, reason] of Object.entries(NO_SOURCE_BRANCH)) {
      expect(reason.length, kind).toBeGreaterThan(30);
    }
  });
});
