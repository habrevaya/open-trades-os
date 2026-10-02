import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { ledger as led } from "@opentradesos/core";
import * as auditLog from "../src/services/audit";
import * as ledgerReports from "../src/services/ledger";
import * as billing from "../src/services/billing";
import * as deposits from "../src/services/deposits";
import * as customers from "../src/services/customers";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * READING BACK WHAT THE PRODUCT ALREADY WROTE
 *
 * Four permissions were granted to roles and checked by nothing, and all four
 * said the same thing: the data is written and no screen reads it. The books
 * are append only and trigger enforced, every mutation writes a before and an
 * after, payments are allocated oldest balance first, and none of it was
 * reachable without a database client.
 *
 * THE PROPERTY THESE TESTS ARE ABOUT is that each read is the one a person
 * would actually ask for, which is a stronger claim than "it returns rows":
 *
 *   A trial balance must be SIGNED TOWARDS EACH ACCOUNT'S OWN SIDE. Getting
 *   that backwards produces a report that balances perfectly and states the
 *   opposite of the truth about every liability in the company, which is the
 *   one error here that no later check would catch.
 *
 *   A journal must be GROUPED BY TRANSACTION. A flat list of entries cannot
 *   be checked by a person.
 *
 *   A deposit's outstanding figure must be DERIVED. It is a liability, and a
 *   fifth stored column can disagree with the four it comes from.
 *
 *   An audit read must be KEYSET PAGED. This is the one table that grows
 *   while somebody reads it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rb:org");
const USER = fixtureId("rb:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/** Granted exactly one permission, so a pair can be told apart. */
const granted = (permission: string): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: ["technician"] as Actor["roles"],
    grants: [permission] as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

let customerId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  postings = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Readback Co", slug: "readback-co" });
  const made = await customers.create(owner(), {
    type: "residential", name: "Reconcile Ltd",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  });
  customerId = made.id;
});

/**
 * One balanced posting, written as rows.
 *
 * WRITTEN DIRECTLY RATHER THAN THROUGH `writePosting`, because this file is
 * testing the READ. Going through the writer would make every assertion here
 * depend on whichever business action happened to produce a posting, and a
 * trial balance has to be correct about a chart of accounts wider than the
 * three or four codes an invoice touches.
 *
 * Both legs go in one statement so the deferred balance trigger, which fires
 * at commit and is one of the properties this whole project rests on, sees a
 * balanced transaction. If it ever refuses one of these, the fixture is wrong
 * and not the trigger.
 */
let postings = 0;
async function posting(
  entries: { direction: "debit" | "credit"; accountCode: string; amount: string }[],
  sourceType = "invoice",
  occurredAt = new Date("2026-03-01T10:00:00Z"),
): Promise<void> {
  postings += 1;
  const transactionId = fixtureId(`rb:txn:${postings}`);
  const sourceId = fixtureId(`rb:src:${postings}`);
  await raw`
    insert into public.ledger_entry
      (organization_id, transaction_id, occurred_at, direction, account_code,
       currency, amount, source_type, source_id, customer_id)
    select ${ORG}, ${transactionId}, ${occurredAt}, (x->>'d')::ledger_direction,
           x->>'a', 'USD', (x->>'m')::numeric, ${sourceType}, ${sourceId}, ${customerId}
    from jsonb_array_elements(${raw.json(entries.map((e) => ({
      d: e.direction, a: e.accountCode, m: e.amount,
    })) as never)}) as x`;
}

/* ----------------------------------------------------------- the ledger */

run("the trial balance", () => {
  it("signs every balance towards the side its own account sits on", async () => {
    /**
     * THE ERROR THIS TEST EXISTS FOR, and the only one here that no later
     * check would catch.
     *
     * One invoice: debit receivable, credit revenue. Receivable is an asset,
     * so its debit balance is POSITIVE. Revenue is a credit balance account,
     * so the same size credit is also POSITIVE. A report signed towards debit
     * for everything would show revenue as negative, balance perfectly, and
     * tell an owner their best month was a loss.
     */
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.AR, amount: "1200.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.REVENUE, amount: "1200.0000" },
    ]);

    const report = await ledgerReports.trialBalance(owner());
    const byCode = new Map(report.rows.map((r) => [r.accountCode, r]));

    expect(byCode.get(led.ACCOUNTS.AR)).toMatchObject({
      accountClass: "asset", normalBalance: "debit",
      debits: "1200.0000", credits: "0.0000", balance: "1200.0000",
    });
    expect(byCode.get(led.ACCOUNTS.REVENUE)).toMatchObject({
      accountClass: "revenue", normalBalance: "credit",
      debits: "0.0000", credits: "1200.0000", balance: "1200.0000",
    });
  });

  it("shows a contra revenue account as a negative", async () => {
    /**
     * The other half of the same rule, and the one that proves the sign is
     * computed rather than assumed from the class. A DEBIT to revenue is a
     * reduction, which is what the discount account collects, and it has to
     * come back negative on a report whose other revenue rows are positive.
     */
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.DISCOUNTS, amount: "100.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.AR, amount: "100.0000" },
    ]);

    const report = await ledgerReports.trialBalance(owner());
    const discounts = report.rows.find((r) => r.accountCode === led.ACCOUNTS.DISCOUNTS)!;
    expect(discounts.accountClass).toBe("revenue");
    expect(discounts.balance).toBe("-100.0000");
  });

  it("reports both totals and whether they agree", async () => {
    /**
     * Reported rather than asserted. A trigger already refuses an unbalanced
     * posting, so printing both sides is how a reader confirms that for
     * themselves instead of taking the schema's word for it.
     */
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.CASH, amount: "500.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.AR, amount: "500.0000" },
    ]);
    const report = await ledgerReports.trialBalance(owner());
    expect(report.totalDebits).toBe("500.0000");
    expect(report.totalCredits).toBe("500.0000");
    expect(report.balanced).toBe(true);
  });

  it("says so when the books do not balance", async () => {
    /**
     * `balanced: true` CANNOT BE WRONG ON A BALANCED LEDGER, which is why the
     * test above could not see the field hard-coded to true. A deliberate
     * breakage proved it: every assertion stayed green with the comparison
     * replaced by the literal.
     *
     * So this writes a state the database refuses. `session_replication_role
     * = replica` suspends the deferred balance trigger for THIS SESSION only,
     * which is the same mechanism `resetOrg` uses and is restored
     * immediately. Nothing about the trigger changes.
     *
     * It is worth the trouble because the whole point of printing both totals
     * is that a reader can check us. If they could never differ, the field is
     * decoration; if they can, a report that hid it would be the worst
     * possible outcome here, telling an accountant the books are fine on the
     * one day they are not.
     */
    await raw.unsafe("set session_replication_role = replica");
    try {
      await raw`
        insert into public.ledger_entry
          (organization_id, transaction_id, occurred_at, direction, account_code,
           currency, amount, source_type, source_id)
        values (${ORG}, ${fixtureId("rb:lop")}, now(), 'debit', ${led.ACCOUNTS.CASH},
                'USD', '75.0000', 'manual', ${fixtureId("rb:lopsrc")})`;
    } finally {
      await raw.unsafe("set session_replication_role = default");
    }

    const report = await ledgerReports.trialBalance(owner());
    expect(report.totalDebits).toBe("75.0000");
    expect(report.totalCredits).toBe("0.0000");
    expect(report.balanced).toBe(false);
  });

  it("narrows to a window, and says which one", async () => {
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.CASH, amount: "100.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.AR, amount: "100.0000" },
    ], "payment", new Date("2026-01-15T00:00:00Z"));
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.CASH, amount: "200.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.AR, amount: "200.0000" },
    ], "payment", new Date("2026-03-15T00:00:00Z"));

    const q1 = await ledgerReports.trialBalance(owner(), {
      from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z",
    });
    expect(q1.totalDebits).toBe("100.0000");
    expect(q1.from).toBe("2026-01-01T00:00:00Z");

    const all = await ledgerReports.trialBalance(owner());
    expect(all.totalDebits).toBe("300.0000");
  });

  it("refuses somebody who may read a job but not the books", async () => {
    await expect(ledgerReports.trialBalance(granted("job:read"))).rejects.toThrow();
    await expect(ledgerReports.trialBalance(granted("ledger:read"))).resolves.toBeTruthy();
  });
});

run("the journal", () => {
  it("groups both sides of one event together", async () => {
    /**
     * The whole value of the report. "Why does this invoice show as paid" is
     * answered by seeing the cash debit beside the receivable credit under
     * one transaction id, and a flat list of entries cannot be checked by a
     * person.
     */
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.CASH, amount: "300.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.AR, amount: "300.0000" },
    ], "payment");

    const { transactions } = await ledgerReports.journal(owner());
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.lines).toHaveLength(2);
    expect(transactions[0]!.totalDebits).toBe("300.0000");
    expect(transactions[0]!.totalCredits).toBe("300.0000");
    expect(transactions[0]!.sourceType).toBe("payment");
  });

  it("returns whole postings when filtered on one account, not the matching halves", async () => {
    /**
     * THE BUG THE TWO-QUERY SHAPE EXISTS TO PREVENT. Filtering and paging in
     * one pass returns the MATCHING LINES of a posting rather than the
     * posting. A reader filtering on receivable would see one leg of forty
     * invoices and none of their revenue legs, which looks exactly like a
     * ledger that does not balance.
     */
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.AR, amount: "900.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.REVENUE, amount: "900.0000" },
    ]);

    const { transactions } = await ledgerReports.journal(owner(), {
      accountCode: led.ACCOUNTS.AR,
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.lines.map((l) => l.accountCode).sort())
      .toEqual([led.ACCOUNTS.AR, led.ACCOUNTS.REVENUE].sort());
    expect(transactions[0]!.totalDebits).toBe(transactions[0]!.totalCredits);
  });

  it("puts the newest posting first", async () => {
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.CASH, amount: "10.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.AR, amount: "10.0000" },
    ], "payment", new Date("2026-01-01T00:00:00Z"));
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.CASH, amount: "20.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.AR, amount: "20.0000" },
    ], "payment", new Date("2026-06-01T00:00:00Z"));

    const { transactions } = await ledgerReports.journal(owner());
    expect(transactions[0]!.occurredAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("tells a reader what each account is, so a code alone is not the answer", async () => {
    await posting([
      { direction: "debit", accountCode: led.ACCOUNTS.CUSTOMER_DEPOSITS, amount: "50.0000" },
      { direction: "credit", accountCode: led.ACCOUNTS.CASH, amount: "50.0000" },
    ], "deposit");
    const { transactions } = await ledgerReports.journal(owner());
    const classes = new Map(transactions[0]!.lines.map((l) => [l.accountCode, l.accountClass]));
    expect(classes.get(led.ACCOUNTS.CUSTOMER_DEPOSITS)).toBe("liability");
    expect(classes.get(led.ACCOUNTS.CASH)).toBe("asset");
  });
});

/* --------------------------------------------------------- the audit log */

run("the audit log, read back", () => {
  it("reads what a mutation wrote, with the before and the after", async () => {
    /**
     * The module page claims "a customer can replay their entire history
     * from the log". They could not: the writing worked and the only part
     * anybody would use did not exist.
     */
    await customers.update(owner(), { id: customerId, name: "Reconcile Limited" });

    const page = await auditLog.read(owner(), { entityType: "customer", entityId: customerId });
    const actions = page.rows.map((r) => r.action);
    expect(actions).toContain("customer.created");
    expect(actions).toContain("customer.updated");

    const updated = page.rows.find((r) => r.action === "customer.updated")!;
    expect(updated.before).toMatchObject({ name: "Reconcile Ltd" });
    expect(updated.after).toMatchObject({ name: "Reconcile Limited" });
    expect(updated.actorUserId).toBe(USER);
  });

  it("reads one record's history forwards", async () => {
    /**
     * The order is the point. A caller who has to remember to flip the sort
     * will read a history backwards and describe it that way to a customer.
     */
    await customers.update(owner(), { id: customerId, name: "Second" });
    await customers.update(owner(), { id: customerId, name: "Third" });

    const { rows } = await auditLog.historyOf(owner(), {
      entityType: "customer", entityId: customerId,
    });
    expect(rows[0]!.action).toBe("customer.created");
    expect(rows.at(-1)!.after).toMatchObject({ name: "Third" });
  });

  it("pages on time and hands back a cursor, rather than an offset", async () => {
    /**
     * This is the one table that grows while somebody reads it. An offset
     * cursor shows an auditor rows twice while missing others, which is the
     * exact failure an audit log exists to rule out.
     */
    for (let i = 0; i < 5; i += 1) {
      await customers.update(owner(), { id: customerId, name: `Name ${i}` });
    }

    const first = await auditLog.read(owner(), { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextBefore).toBeTruthy();

    const second = await auditLog.read(owner(), { limit: 2, before: first.nextBefore! });
    expect(second.rows).toHaveLength(2);
    // No row appears on both pages.
    const ids = new Set(first.rows.map((r) => r.id));
    expect(second.rows.every((r) => !ids.has(r.id))).toBe(true);
  });

  it("stops offering a cursor at the end", async () => {
    const page = await auditLog.read(owner(), { limit: 200 });
    expect(page.nextBefore).toBeNull();
  });

  it("narrows by action and by actor", async () => {
    await customers.update(owner(), { id: customerId, name: "Narrowed" });
    const updates = await auditLog.read(owner(), { action: "customer.updated" });
    expect(updates.rows.every((r) => r.action === "customer.updated")).toBe(true);
    expect(updates.rows.length).toBeGreaterThan(0);

    const nobody = await auditLog.read(owner(), { actorUserId: fixtureId("rb:ghost") });
    expect(nobody.rows).toEqual([]);
  });

  it("refuses somebody who may read a customer but not the log", async () => {
    /**
     * The payload holds whatever the row looked like, including columns a
     * reader's own permissions would normally withhold: a technician cannot
     * see cost on a job, and the audit row for that job holds it.
     */
    await expect(auditLog.read(granted("customer:read"), {})).rejects.toThrow();
    await expect(auditLog.read(granted("audit:read"), {})).resolves.toBeTruthy();
  });
});

/* ----------------------------------------------------- payments and deposits */

run("what came in", () => {
  async function invoiced(amount: string): Promise<string> {
    const [n] = await raw<{ next: number }[]>`
      select coalesce(max(number), 0) + 1 as next from public.invoice
      where organization_id = ${ORG}`;
    const [row] = await raw<{ id: string }[]>`
      insert into public.invoice (organization_id, number, customer_id, status,
                                  subtotal, discount_total, tax_total, total,
                                  amount_paid, balance, deposit_held)
      values (${ORG}, ${n!.next}, ${customerId}, 'open',
              ${amount}, '0', '0', ${amount}, '0', ${amount}, '0')
      returning id`;
    return row!.id;
  }

  it("lists what came in, totalled per method", async () => {
    /**
     * Per method because cash and cheque sit in a drawer until somebody banks
     * them and card settles net of a fee two days later. Without this the
     * question went to the card processor's dashboard, which does not know
     * about the cheques.
     */
    /**
     * TWO CHEQUES, NOT ONE, and that is the whole reason the fixture looks
     * like this.
     *
     * With one payment per method, a bucket that accumulates and a bucket
     * that overwrites produce identical output, so a deliberate breakage that
     * threw away the running total stayed green. The second cheque is what
     * makes the count and the sum mean something.
     */
    const invoiceId = await invoiced("650.0000");
    await billing.pay(owner(), {
      customerId, method: "check", amount: "200.0000", tipAmount: "0",
      checkNumber: "4471", allocations: [{ invoiceId, amount: "200.0000" }],
    });
    await billing.pay(owner(), {
      customerId, method: "check", amount: "150.0000", tipAmount: "0",
      checkNumber: "4472", allocations: [{ invoiceId, amount: "150.0000" }],
    });
    await billing.pay(owner(), {
      customerId, method: "card", amount: "300.0000", tipAmount: "0",
      feeAmount: "9.0000", allocations: [{ invoiceId, amount: "300.0000" }],
    });

    const view = await billing.listPayments(owner(), {});
    expect(view.payments).toHaveLength(3);
    expect(view.totals.gross).toBe("650.0000");
    expect(view.totals.fees).toBe("9.0000");
    expect(view.totals.net).toBe("650.0000");

    /**
     * THE WHOLE ARRAY, NOT TWO LOOKUPS INTO IT.
     *
     * A lookup per method cannot see a third bucket appearing or the totals
     * landing in the wrong one, which a deliberate breakage proved: collapsing
     * every method into a single bucket left two `get` assertions green.
     * Sorted by method, which the service promises.
     */
    expect(view.byMethod).toEqual([
      { method: "card", count: 1, gross: "300.0000", net: "300.0000" },
      { method: "check", count: 2, gross: "350.0000", net: "350.0000" },
    ]);
  });

  it("names which invoices a payment cleared", async () => {
    const first = await invoiced("100.0000");
    await billing.pay(owner(), {
      customerId, method: "cash", amount: "100.0000", tipAmount: "0",
      allocations: [{ invoiceId: first, amount: "100.0000" }],
    });
    const view = await billing.listPayments(owner(), {});
    expect(view.payments[0]!.allocations).toEqual([
      expect.objectContaining({ invoiceId: first, amount: "100.0000" }),
    ]);
  });

  it("finds a payment by the invoice it cleared, through the allocation", async () => {
    /**
     * "What paid this invoice" is a question about the relationship. A
     * payment split across three invoices is one payment, so matching it on a
     * column of the payment row would be impossible.
     */
    /**
     * TWO PAYMENTS ON TWO INVOICES, because one of each cannot tell a working
     * filter from an ignored one.
     *
     * A deliberate breakage proved it: with the filter dropped from the
     * query, a single payment still came back for its own invoice, and the
     * "no payments" case still came back empty because the service returns
     * early when no allocation points at the invoice at all. Both assertions
     * stayed green while the filter did nothing.
     */
    const mine = await invoiced("100.0000");
    const theirs = await invoiced("60.0000");
    await billing.pay(owner(), {
      customerId, method: "cash", amount: "100.0000", tipAmount: "0",
      allocations: [{ invoiceId: mine, amount: "100.0000" }],
    });
    await billing.pay(owner(), {
      customerId, method: "cash", amount: "60.0000", tipAmount: "0",
      allocations: [{ invoiceId: theirs, amount: "60.0000" }],
    });

    const found = await billing.listPayments(owner(), { invoiceId: mine });
    expect(found.payments).toHaveLength(1);
    expect(found.payments[0]!.amount).toBe("100.0000");
    expect(found.totals.gross).toBe("100.0000");

    // And an invoice nothing has paid comes back empty rather than with everything.
    const unpaid = await billing.listPayments(owner(), { invoiceId: await invoiced("50.0000") });
    expect(unpaid.payments).toEqual([]);
    expect(unpaid.totals.gross).toBe("0.0000");
  });

  it("answers a date range rather than failing the request", async () => {
    /**
     * `from` and `to` were interpolated into raw SQL as Date objects, which
     * the driver cannot encode, so any request naming a window was a 500.
     */
    const invoiceId = await invoiced("100.0000");
    await billing.pay(owner(), {
      customerId, method: "cash", amount: "40.0000", tipAmount: "0",
      receivedAt: "2026-02-01T15:00:00.000Z", allocations: [{ invoiceId, amount: "40.0000" }],
    });
    await billing.pay(owner(), {
      customerId, method: "cash", amount: "60.0000", tipAmount: "0",
      receivedAt: "2026-03-01T15:00:00.000Z", allocations: [{ invoiceId, amount: "60.0000" }],
    });
    const march = await billing.listPayments(owner(), {
      from: "2026-02-15T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z",
    });
    expect(march.payments.map((p) => p.amount)).toEqual(["60.0000"]);
    expect(march.totals.gross).toBe("60.0000");
  });

  it("refuses somebody who may take a payment but not read the takings", async () => {
    /**
     * `payment:collect` and `payment:read` are different permissions, and a
     * role holding neither could not tell them apart.
     */
    await expect(billing.listPayments(granted("payment:collect"), {})).rejects.toThrow();
    await expect(billing.listPayments(granted("payment:read"), {})).resolves.toBeTruthy();
  });
});

run("money held against work not yet done", () => {
  it("derives what is still held rather than storing it", async () => {
    /**
     * A deposit is a LIABILITY: cash in the account that has already been
     * paid for work the company still owes. A stored "outstanding" column
     * would be a fifth number that can disagree with the four it comes from,
     * and the one it would disagree with is the balance sheet.
     */
    const [row] = await raw<{ id: string }[]>`
      insert into public.deposit (organization_id, customer_id, status,
                                  amount_requested, amount_received,
                                  amount_applied, amount_refunded, received_at)
      values (${ORG}, ${customerId}, 'held',
              '1000.0000', '1000.0000', '250.0000', '100.0000', now())
      returning id`;

    const view = await deposits.list(owner(), {});
    expect(view.deposits).toHaveLength(1);
    expect(view.deposits[0]).toMatchObject({ id: row!.id, outstanding: "650.0000" });
    expect(view.totalOutstanding).toBe("650.0000");
  });

  it("leaves out the ones holding nothing when asked", async () => {
    await raw`
      insert into public.deposit (organization_id, customer_id, status,
                                  amount_requested, amount_received, amount_applied)
      values (${ORG}, ${customerId}, 'applied', '500.0000', '500.0000', '500.0000')`;
    await raw`
      insert into public.deposit (organization_id, customer_id, status,
                                  amount_requested, amount_received)
      values (${ORG}, ${customerId}, 'held', '300.0000', '300.0000')`;

    expect(await deposits.list(owner(), {})).toMatchObject({ totalOutstanding: "300.0000" });
    const open = await deposits.list(owner(), { outstandingOnly: true });
    expect(open.deposits).toHaveLength(1);
    expect(open.deposits[0]!.outstanding).toBe("300.0000");
  });

  it("refuses somebody who may collect a deposit but not read them", async () => {
    await expect(deposits.list(granted("deposit:collect"), {})).rejects.toThrow();
    await expect(deposits.list(granted("deposit:read"), {})).resolves.toBeTruthy();
  });
});
