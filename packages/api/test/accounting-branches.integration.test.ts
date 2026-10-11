import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, ledger, type Actor } from "@opentradesos/core";
import * as accounting from "../src/services/accounting";
import * as accountingBranches from "../src/services/accounting-branches";
import * as accountingDeletions from "../src/services/accounting-deletions";
import * as billing from "../src/services/billing";
import * as company from "../src/services/company";
import * as creditNotes from "../src/services/credit-notes";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as journals from "../src/services/journals";
import * as properties from "../src/services/properties";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import type {
  AccountingEntityKind, AccountingProvider, ChangeSet, ExternalBranchOption, ExternalChange,
  ExternalCreditNote, ExternalInvoice, ExternalJournal, ExternalRefund, HttpResponse, PushResult, ReadResult,
} from "../src/accounting/provider";
import { createQuickBooksProvider } from "../src/accounting/quickbooks";
import { createXeroProvider } from "../src/accounting/xero";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M14. A BRANCH IN THE BOOKS, AND A DOCUMENT DELETED THERE
 *
 * Every posting carries the branch of the job or invoice it came from, and a
 * journal line its own branch, job and customer. Until now the books were
 * sent the account and the amount and nothing else, so neither QuickBooks nor
 * Xero could be read by branch. These tests drive the sync with a fake of the
 * books and read what it was handed, and drive each real adapter with a fake
 * transport and read the request that would have gone over the wire. Nothing
 * here reaches Intuit or Xero: this is tested against fakes only.
 *
 * And the other direction: a journal, a refund or a use of a credit note sent
 * to the books and deleted there is noticed on the next read of changes,
 * flagged on the record here with a task for the bookkeeper, and never sent
 * again or reversed by itself.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("books-in-branches/org");
const USER = fixtureId("books-in-branches/user");
const OTHER_ORG = fixtureId("books-in-branches/other-org");
const OTHER_USER = fixtureId("books-in-branches/other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], grants: string[] = []): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG, roles: roles as Actor["roles"],
    ...(grants.length > 0 ? { grants: grants as NonNullable<Actor["grants"]> } : {}),
  },
  db: db(),
});
const owner = () => as(["owner"]);
const other = (): ServiceContext => ({ actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] }, db: db() });

let roundRock = "";
let georgetown = "";
let foreignBranch = "";
let customerId = "";
let propertyId = "";

/* ----------------------------------------------------------- the fake books */

interface Fake extends AccountingProvider {
  creates: { kind: AccountingEntityKind; key: string }[];
  invoices: ExternalInvoice[];
  journals: ExternalJournal[];
  refunds: ExternalRefund[];
  creditNotes: ExternalCreditNote[];
}

function fakeBooks(options: {
  changes?: ExternalChange[]; journalCustomers?: boolean; branchOptions?: ReadResult<ExternalBranchOption[]>;
} = {}): Fake {
  const creates: Fake["creates"] = [];
  const invoices: ExternalInvoice[] = [];
  const journalsSent: ExternalJournal[] = [];
  const refunds: ExternalRefund[] = [];
  const notes: ExternalCreditNote[] = [];
  let next = 1;
  const push = (kind: AccountingEntityKind, key: string): PushResult => {
    creates.push({ kind, key });
    return { ok: true, externalId: `${kind}-${next++}`, version: "0", adopted: false };
  };
  return {
    name: "fake",
    creates, invoices, journals: journalsSent, refunds, creditNotes: notes,
    heldMoneyReachesBooks: true,
    journalCustomers: options.journalCustomers ?? true,
    async pushCustomer(c) { return push("customer", c.idempotencyKey); },
    async pushInvoice(i) { invoices.push(i); return push("invoice", i.idempotencyKey); },
    async pushPayment(p) { return push("payment", p.idempotencyKey); },
    async pushCredit(c) { return push("credit_memo", c.idempotencyKey); },
    async pushRefund(r) { refunds.push(r); return push("refund", r.idempotencyKey); },
    async pushCreditNote(n) { notes.push(n); return push("credit_note", n.idempotencyKey); },
    async pushCreditApplication(a) { return push("credit_note_application", a.idempotencyKey); },
    async pushCreditNoteRefund(r) { return push("credit_note_refund", r.idempotencyKey); },
    async pushJournal(j) { journalsSent.push(j); return push("journal", j.idempotencyKey); },
    async findCreditApplication() { return { ok: true, value: null }; },
    async findPushed() { return { ok: true, value: null }; },
    async changes(cursor): Promise<ReadResult<ChangeSet>> {
      return { ok: true, value: { cursor: `after-${cursor ?? "start"}`, changes: options.changes ?? [], more: false } };
    },
    async accounts() { return { ok: true, value: [] }; },
    ...(options.branchOptions ? { branchOptions: async () => options.branchOptions! } : {}),
  };
}

/* --------------------------------------------------------------- fixtures */

async function mapAccounts(codes: string[]): Promise<void> {
  for (const code of codes) {
    await accounting.setMapping(owner(), {
      accountCode: code, externalId: `acct-${code}`, externalName: `Account ${code}`, externalKind: "Account",
    });
  }
}

const mapRoundRock = () => accountingBranches.setBranchMapping(owner(), {
  businessUnitId: roundRock, externalId: "class-rr", externalName: "Round Rock",
});

const linkRows = () => raw<{
  id: string; kind: string; entity_id: string; state: string; external_id: string | null;
  deleted_noticed_at: Date | null; deletion_task_id: string | null;
}[]>`select id, kind, entity_id, state, external_id, deleted_noticed_at, deletion_task_id
     from public.accounting_entity_link where organization_id = ${ORG} order by created_at`;

const booksTasks = () => raw<{ id: string; title: string; body: string | null; entity_type: string | null; entity_id: string | null; queue: string | null }[]>`
  select id, title, body, entity_type, entity_id, queue from public.task
  where organization_id = ${ORG} and queue = 'books' order by created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Books In Branches", slug: "books-in-branches" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Books Next Door", slug: "books-in-branches-next-door" });

  roundRock = (await company.createBusinessUnit(owner(), { name: "Round Rock" })).id;
  georgetown = (await company.createBusinessUnit(owner(), { name: "Georgetown" })).id;
  foreignBranch = (await company.createBusinessUnit(other(), { name: "Elsewhere" })).id;

  customerId = (await customers.create(owner(), {
    type: "residential", name: "Rivera Property Group", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id;
  propertyId = (await properties.create(owner(), {
    address: { line1: "4 Bluebonnet Ln", city: "Round Rock", state: "TX", postalCode: "78664", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id;

  await raw`insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'accounting', 'quickbooks', 'connected', 'TEST_QBO_CREDENTIAL', ${raw.json({ realmId: "123" })})`;
});

/** An issued invoice on a job in a branch, so its posting carries the branch. */
async function invoiceIn(businessUnitId: string, unitPrice = "400.00"): Promise<string> {
  const jobId = (await jobs.create(owner(), {
    customerId, propertyId, summary: "Furnace", tags: [], customFields: {}, businessUnitId,
  })).id;
  const invoice = await billing.create(owner(), {
    customerId, jobId,
    lines: [{ name: "Service call", quantity: "1", unitPrice, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

/* ------------------------------------------------------- branch mapping */

run("which class or tracking option a branch is", () => {
  it("keeps one mapping per branch, lists it by the branch's own name, and lets it go", async () => {
    await mapRoundRock();
    await accountingBranches.setBranchMapping(owner(), {
      businessUnitId: roundRock, externalId: "opt-north", externalName: "North", groupId: "cat-1", groupName: "Region",
    });
    expect(await accountingBranches.listBranchMappings(owner())).toEqual([{
      businessUnitId: roundRock, branchName: "Round Rock", externalId: "opt-north", externalName: "North",
      groupId: "cat-1", groupName: "Region",
    }]);
    const [audit] = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and action = 'accounting.branch_mapped' limit 1`;
    expect(audit?.action).toBe("accounting.branch_mapped");

    await accountingBranches.removeBranchMapping(owner(), { businessUnitId: roundRock });
    expect(await accountingBranches.listBranchMappings(owner())).toEqual([]);
    await expect(accountingBranches.removeBranchMapping(owner(), { businessUnitId: roundRock })).rejects.toThrow(NotFoundError);
  });

  it("will not map another company's branch, and needs accounting:sync", async () => {
    await expect(accountingBranches.setBranchMapping(owner(), {
      businessUnitId: foreignBranch, externalId: "class-x", externalName: "X",
    })).rejects.toThrow(NotFoundError);
    const withoutSync = as([], ["settings:read", "settings:write", "ledger:read", "ledger:post", "invoice:read"]);
    await expect(accountingBranches.setBranchMapping(withoutSync, {
      businessUnitId: roundRock, externalId: "class-rr", externalName: "Round Rock",
    })).rejects.toThrow(PermissionError);
    await expect(accountingBranches.listBranchMappings(withoutSync)).rejects.toThrow(PermissionError);
  });

  it("reads what the books offer, and says so when the reads have run out rather than showing nothing", async () => {
    const offered = await accountingBranches.listRemoteBranchOptions(owner(), {
      provider: fakeBooks({ branchOptions: { ok: true, value: [{ externalId: "c1", name: "Round Rock", groupId: null, groupName: null, active: true }] } }),
    });
    expect(offered.options.map((o) => o.name)).toEqual(["Round Rock"]);
    const blocked = await accountingBranches.listRemoteBranchOptions(owner(), {
      provider: fakeBooks({
        branchOptions: { ok: false, code: "429", message: "out", retryable: true, budgetExhausted: true, retryAfterSeconds: 60 },
      }),
    });
    expect(blocked).toMatchObject({ options: [], blocked: accounting.READ_BUDGET_EXHAUSTED, error: null, retryAfterSeconds: 60 });
  });
});

/* ------------------------------------------------------ what the books get */

run("a branch and a customer, sent with the document", () => {
  it("sends each journal line's own branch as its class and its customer, and an unmapped one as before", async () => {
    await mapAccounts(["6500", ledger.ACCOUNTS.CASH]);
    await mapRoundRock();
    await journals.create(owner(), {
      occurredOn: companyToday(), memo: "Rent for two shops",
      lines: [
        { accountCode: "6500", debit: "1200.00", memo: "Round Rock shop", businessUnitId: roundRock, customerId },
        { accountCode: "6500", debit: "800.00", memo: "Georgetown shop", businessUnitId: georgetown },
        { accountCode: ledger.ACCOUNTS.CASH, credit: "2000.00" },
      ],
    });
    const books = fakeBooks();
    await accounting.sync(owner(), { provider: books });

    expect(books.journals).toHaveLength(1);
    const [roundRockLine, georgetownLine, cashLine] = books.journals[0]!.lines;
    expect(roundRockLine).toMatchObject({
      branch: { externalId: "class-rr", name: "Round Rock", groupId: null, groupName: null },
      customerExternalId: "customer-1",
    });
    /** Georgetown is not mapped: nothing extra, exactly as before. */
    expect(georgetownLine!.branch ?? null).toBeNull();
    expect(cashLine!.branch ?? null).toBeNull();
    expect(cashLine!.customerExternalId ?? null).toBeNull();
    /** The customer went first, because the line refers to it. */
    expect(books.creates.map((c) => c.kind)).toEqual(["customer", "journal"]);
  });

  it("does not push a customer to a book whose journal lines take none", async () => {
    await mapAccounts(["6500", ledger.ACCOUNTS.CASH]);
    await journals.create(owner(), {
      occurredOn: companyToday(), memo: "A cost that is one customer's",
      lines: [{ accountCode: "6500", debit: "50.00", customerId }, { accountCode: ledger.ACCOUNTS.CASH, credit: "50.00" }],
    });
    const books = fakeBooks({ journalCustomers: false });
    await accounting.sync(owner(), { provider: books });
    expect(books.creates.map((c) => c.kind)).toEqual(["journal"]);
    expect(books.journals[0]!.lines[0]!.customerExternalId ?? null).toBeNull();
  });

  it("sends an invoice with the class of the branch its posting carries, and one in an unmapped branch without", async () => {
    await mapAccounts([ledger.ACCOUNTS.REVENUE]);
    await mapRoundRock();
    const inRoundRock = await invoiceIn(roundRock);
    const inGeorgetown = await invoiceIn(georgetown, "250.00");
    const books = fakeBooks();
    await accounting.sync(owner(), { provider: books });

    const numbers = await raw<{ id: string; number: number }[]>`
      select id, number from public.invoice where id in (${inRoundRock}, ${inGeorgetown})`;
    const keyOf = (id: string) => String(numbers.find((n) => n.id === id)!.number);
    expect(books.invoices.find((i) => i.idempotencyKey === keyOf(inRoundRock))!.branch)
      .toEqual({ externalId: "class-rr", name: "Round Rock", groupId: null, groupName: null });
    expect(books.invoices.find((i) => i.idempotencyKey === keyOf(inGeorgetown))!.branch ?? null).toBeNull();
  });

  it("sends a credit note and a refund in the branch of their postings", async () => {
    await mapAccounts([
      ledger.ACCOUNTS.REVENUE, ledger.ACCOUNTS.CASH, ledger.ACCOUNTS.AR, ledger.ACCOUNTS.CUSTOMER_DEPOSITS,
    ]);
    await mapRoundRock();
    const invoiceId = await invoiceIn(roundRock);
    const payment = await billing.pay(owner(), {
      customerId, method: "check", amount: "400.00", tipAmount: "0", allocations: [{ invoiceId, amount: "400.00" }],
    });
    await creditNotes.create(owner(), {
      invoiceId, reason: "billing_error", draft: false, apply: false,
      lines: [{ name: "Overcharged for the trip", quantity: "1", unitPrice: "40.00" }],
    });
    const books = fakeBooks();
    await accounting.sync(owner(), { provider: books });
    await billing.recordRefund(owner(), { id: payment.id as string, amount: "40.00", method: "check", reason: "Trip charge" });
    await accounting.sync(owner(), { provider: books });

    const roundRockClass = { externalId: "class-rr", name: "Round Rock", groupId: null, groupName: null };
    expect(books.creditNotes[0]!.branch).toEqual(roundRockClass);
    expect(books.refunds).toHaveLength(1);
    expect(books.refunds[0]!.branch).toEqual(roundRockClass);
  });
});

/* -------------------------------------------- deleted over there, noticed here */

run("a document deleted in the books after it was sent", () => {
  it("flags a journal on the record with a task for the bookkeeper, and sends nothing again by itself", async () => {
    await mapAccounts(["6500", ledger.ACCOUNTS.CASH]);
    const entry = await journals.create(owner(), {
      occurredOn: companyToday(), memo: "September rent",
      lines: [{ accountCode: "6500", debit: "900.00" }, { accountCode: ledger.ACCOUNTS.CASH, credit: "900.00" }],
    });
    await accounting.sync(owner(), { provider: fakeBooks() });
    const link = (await linkRows()).find((l) => l.kind === "journal")!;
    expect(link.state).toBe("linked");
    expect((await journals.get(owner(), { id: entry.id })).deletedInBooks).toBeNull();

    const deleted: ExternalChange = { kind: "journal", externalId: link.external_id!, version: null, deleted: true, changedAt: new Date() };
    await accounting.sync(owner(), { provider: fakeBooks({ changes: [deleted] }) });

    const after = (await linkRows()).find((l) => l.kind === "journal")!;
    expect(after.state).toBe("deleted");
    expect(after.deleted_noticed_at).not.toBeNull();
    const tasks = await booksTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: `Journal ${entry.number} (September rent) was deleted in QuickBooks Online`,
      entity_type: "journal_entry", entity_id: entry.id, queue: "books",
    });
    expect(tasks[0]!.body).toMatch(/Nothing has been sent again or reversed here/);
    expect(after.deletion_task_id).toBe(tasks[0]!.id);

    const flagged = await journals.get(owner(), { id: entry.id });
    expect(flagged.deletedInBooks).toMatchObject({ linkId: after.id, books: "QuickBooks Online", taskId: tasks[0]!.id });

    /** The same deletion read again raises no second task, and nothing is sent. */
    const again = fakeBooks({ changes: [deleted] });
    await accounting.sync(owner(), { provider: again });
    expect(await booksTasks()).toHaveLength(1);
    expect(again.creates).toHaveLength(0);
    const ledgerCount = await raw<{ n: number }[]>`
      select count(*)::int as n from public.journal_entry where organization_id = ${ORG}`;
    expect(ledgerCount[0]!.n).toBe(1);

    /** Sent again on purpose: the flag goes, and the next pass sends it under the same claim. */
    await accounting.retryDocument(owner(), { linkId: after.id });
    expect((await journals.get(owner(), { id: entry.id })).deletedInBooks).toBeNull();
    const resend = fakeBooks();
    await accounting.sync(owner(), { provider: resend });
    expect(resend.creates.map((c) => c.kind)).toEqual(["journal"]);
  });

  it("flags a refund deleted in the books on the customer's payment", async () => {
    await mapAccounts([ledger.ACCOUNTS.REVENUE, ledger.ACCOUNTS.CASH, ledger.ACCOUNTS.AR, ledger.ACCOUNTS.CUSTOMER_DEPOSITS]);
    const invoiceId = await invoiceIn(roundRock);
    const payment = await billing.pay(owner(), {
      customerId, method: "check", amount: "400.00", tipAmount: "0", allocations: [{ invoiceId, amount: "400.00" }],
    });
    await accounting.sync(owner(), { provider: fakeBooks() });
    await billing.recordRefund(owner(), { id: payment.id as string, amount: "75.00", method: "check", reason: "Part of the job undone" });
    await accounting.sync(owner(), { provider: fakeBooks() });
    const refundLink = (await linkRows()).find((l) => l.kind === "refund" && l.external_id)!;

    expect(await accountingDeletions.paymentRefundFlags(owner(), { paymentIds: [payment.id as string] })).toEqual({});
    await accounting.sync(owner(), {
      provider: fakeBooks({ changes: [{ kind: "refund", externalId: refundLink.external_id!, version: null, deleted: true, changedAt: new Date() }] }),
    });

    const flags = await accountingDeletions.paymentRefundFlags(owner(), { paymentIds: [payment.id as string] });
    expect(flags[payment.id as string]).toEqual([expect.objectContaining({ linkId: refundLink.id, books: "QuickBooks Online" })]);
    const [task] = await booksTasks();
    expect(task).toMatchObject({ entity_type: "customer", entity_id: customerId });
    expect(task!.title).toMatch(/refund of a payment was deleted in QuickBooks Online/);
    /** Read by whoever reads payments, and nobody else. */
    await expect(accountingDeletions.paymentRefundFlags(as([], ["invoice:read"]), { paymentIds: [payment.id as string] }))
      .rejects.toThrow(PermissionError);
  });

  it("notices a use of a credit note taken off it in the books, and leaves one still listed alone", async () => {
    await mapAccounts([ledger.ACCOUNTS.REVENUE]);
    const first = await invoiceIn(roundRock);
    const second = await invoiceIn(roundRock);
    const note = await creditNotes.create(owner(), {
      customerId, reason: "billing_error", draft: false, apply: false,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "60.00" }],
    });
    await creditNotes.apply(owner(), { id: note.id, applications: [{ invoiceId: first, amount: "20.00" }, { invoiceId: second, amount: "40.00" }] });
    await accounting.sync(owner(), { provider: fakeBooks() });

    const links = await linkRows();
    const noteLink = links.find((l) => l.kind === "credit_note")!;
    const applied = links.filter((l) => l.kind === "credit_note_application");
    expect(applied).toHaveLength(2);
    const invoiceExternal = (id: string) => links.find((l) => l.kind === "invoice" && l.entity_id === id)!.external_id;
    const view = await creditNotes.get(owner(), { id: note.id });
    const toSecond = view.applications.find((a) => a.invoiceId === second)!;
    const kept = applied.find((l) => l.entity_id === toSecond.id)!;

    /**
     * The credit note read back lists one allocation: the one to the second
     * invoice. The one to the first was taken off over there.
     */
    await accounting.sync(owner(), {
      provider: fakeBooks({
        changes: [{
          kind: "credit_memo", externalId: noteLink.external_id!, version: null, deleted: false, changedAt: new Date(),
          allocations: [{ externalId: kept.external_id, invoiceExternalId: invoiceExternal(second), amount: "40.00", date: null }],
        }],
      }),
    });

    const after = await creditNotes.get(owner(), { id: note.id });
    const toFirst = after.applications.find((a) => a.invoiceId === first)!;
    expect(toFirst.deletedInBooks).toMatchObject({ books: "QuickBooks Online" });
    expect(after.applications.find((a) => a.invoiceId === second)!.deletedInBooks).toBeNull();
    const tasks = await booksTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ entity_type: "credit_note", entity_id: note.id });
    expect(tasks[0]!.title).toMatch(new RegExp(`Credit note ${note.number} used on invoice \\S+ was deleted`));
    /** The credit note itself is still in the books, and still believed in. */
    expect((await linkRows()).find((l) => l.kind === "credit_note")!.state).toBe("linked");
  });

  it("concludes nothing from a credit note read that does not list its allocations", async () => {
    await mapAccounts([ledger.ACCOUNTS.REVENUE]);
    const invoiceId = await invoiceIn(roundRock);
    await creditNotes.create(owner(), {
      invoiceId, reason: "billing_error", draft: false, apply: true,
      lines: [{ name: "Goodwill", quantity: "1", unitPrice: "30.00" }],
    });
    await accounting.sync(owner(), { provider: fakeBooks() });
    const noteLink = (await linkRows()).find((l) => l.kind === "credit_note")!;
    await accounting.sync(owner(), {
      provider: fakeBooks({
        changes: [{ kind: "credit_memo", externalId: noteLink.external_id!, version: null, deleted: false, changedAt: new Date() }],
      }),
    });
    expect((await linkRows()).filter((l) => l.kind === "credit_note_application").map((l) => l.state)).toEqual(["linked"]);
    expect(await booksTasks()).toHaveLength(0);
  });
});

/* -------------------------------------------- what each real adapter sends */

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

const CREDENTIAL = JSON.stringify({ refreshToken: "rt", clientId: "ci", clientSecret: "cs" });
const isToken = (address: string) => new URL(address).origin === "https://token.test";

function transport(calls: Call[], reply: (call: Call) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  return async (address: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = { url: address, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) };
    calls.push(call);
    const answer = isToken(address)
      ? { status: 200, body: { access_token: "at", expires_in: 3600 } as unknown, headers: {} as Record<string, string> }
      : reply(call);
    const headers = answer.headers ?? {};
    const response: HttpResponse = {
      status: answer.status ?? 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(answer.body),
    };
    return response;
  };
}

const quickbooks = (calls: Call[], reply: (call: Call) => { status?: number; body: unknown }) => createQuickBooksProvider(
  { realmId: "9", baseUrl: "https://qbo.test", tokenUrl: "https://token.test" }, CREDENTIAL, {}, transport(calls, reply),
);
const xero = (calls: Call[], reply: (call: Call) => { status?: number; body: unknown; headers?: Record<string, string> }) => createXeroProvider(
  { tenantId: "t-1", baseUrl: "https://xero.test", tokenUrl: "https://token.test" }, CREDENTIAL, {}, transport(calls, reply),
);
const bodyOf = (calls: Call[], fragment: string) =>
  JSON.parse(calls.find((c) => c.url.includes(fragment) && c.body)!.body!) as Record<string, unknown>;

const usd = (amount: string) => ({ amount, currency: "USD" });
const ROUND_ROCK_CLASS = { externalId: "5000000000000012345", name: "Round Rock", groupId: null, groupName: null };
const NORTH = { externalId: "opt-north", name: "North", groupId: "cat-region", groupName: "Region" };

const journal = (branch: typeof ROUND_ROCK_CLASS | typeof NORTH): ExternalJournal => ({
  idempotencyKey: "OTJ7", number: 7, postedOn: "2026-10-01", currency: "USD", memo: "Rent",
  lines: [
    { accountExternalId: "a-6500", direction: "debit", amount: usd("1200.0000"), description: "Shop rent", branch, customerExternalId: "cust-9" },
    { accountExternalId: "a-1000", direction: "credit", amount: usd("1200.0000"), description: null },
  ],
});

const invoice = (branch: ExternalInvoice["branch"]): ExternalInvoice => ({
  idempotencyKey: "1042", customerExternalId: "cust-9", documentNumber: "1042", issuedOn: "2026-10-01", dueOn: null,
  currency: "USD", memo: null, branch,
  lines: [{
    description: "Service call", quantity: "1", unitPrice: usd("400.0000"), amount: usd("400.0000"),
    accountExternalId: "item-4000", accountExternalKind: "Item",
  }],
  tax: { amount: usd("33.0000"), accountExternalId: "item-2200" },
});

describe("QuickBooks, as it is sent a branch and a customer", () => {
  it("puts the class and the customer on the journal line, and nothing on a line that has neither", async () => {
    const calls: Call[] = [];
    await quickbooks(calls, () => ({ body: { JournalEntry: { Id: "je-1", SyncToken: "0" } } })).pushJournal!(journal(ROUND_ROCK_CLASS));
    const lines = bodyOf(calls, "/journalentry")["Line"] as { JournalEntryLineDetail: Record<string, unknown> }[];
    expect(lines[0]!.JournalEntryLineDetail).toMatchObject({
      ClassRef: { value: "5000000000000012345", name: "Round Rock" },
      Entity: { Type: "Customer", EntityRef: { value: "cust-9" } },
    });
    expect(lines[1]!.JournalEntryLineDetail).not.toHaveProperty("ClassRef");
    expect(lines[1]!.JournalEntryLineDetail).not.toHaveProperty("Entity");
  });

  it("puts the class on every line of an invoice, its tax line too, and none when the branch is not mapped", async () => {
    const calls: Call[] = [];
    const books = quickbooks(calls, () => ({ body: { Invoice: { Id: "i-1", SyncToken: "0" } } }));
    await books.pushInvoice(invoice(ROUND_ROCK_CLASS));
    await books.pushInvoice(invoice(null));
    const [mapped, unmapped] = calls.filter((c) => c.url.includes("/invoice") && c.body)
      .map((c) => (JSON.parse(c.body!) as { Line: { SalesItemLineDetail: Record<string, unknown> }[] }).Line);
    expect(mapped!.map((l) => l.SalesItemLineDetail["ClassRef"])).toEqual([
      { value: "5000000000000012345", name: "Round Rock" }, { value: "5000000000000012345", name: "Round Rock" },
    ]);
    expect(unmapped!.every((l) => !("ClassRef" in l.SalesItemLineDetail))).toBe(true);
  });

  it("puts the class on a refund's expense line", async () => {
    const calls: Call[] = [];
    await quickbooks(calls, () => ({ body: { Purchase: { Id: "p-1", SyncToken: "0" } } })).pushRefund({
      idempotencyKey: "ORabc", customerExternalId: "cust-9", paymentExternalId: "pay-1", refundedOn: "2026-10-02",
      amount: usd("40.0000"), appliedAmount: usd("40.0000"), heldAmount: usd("0"), bankAccountExternalId: "a-1000",
      receivableAccountExternalId: "a-1200", clearingAccountExternalId: null, memo: "Refund", branch: ROUND_ROCK_CLASS,
    });
    const line = (bodyOf(calls, "/purchase")["Line"] as { AccountBasedExpenseLineDetail: Record<string, unknown> }[])[0]!;
    expect(line.AccountBasedExpenseLineDetail["ClassRef"]).toEqual({ value: "5000000000000012345", name: "Round Rock" });
  });

  it("offers its classes by their full names, in one read", async () => {
    const calls: Call[] = [];
    const result = await quickbooks(calls, () => ({
      body: { QueryResponse: { Class: [
        { Id: "1", Name: "Round Rock", FullyQualifiedName: "Texas:Round Rock", Active: true },
        { Id: "2", Name: "Old", Active: false },
      ] } },
    })).branchOptions!();
    expect(result).toEqual({ ok: true, value: [
      { externalId: "1", name: "Texas:Round Rock", groupId: null, groupName: null, active: true },
      { externalId: "2", name: "Old", groupId: null, groupName: null, active: false },
    ] });
    const reads = calls.filter((c) => !isToken(c.url));
    expect(reads).toHaveLength(1);
    expect(decodeURIComponent(reads[0]!.url)).toContain("select * from Class");
  });

  it("reads journals and expenses in the same change feed request, and reports their deletion", async () => {
    const calls: Call[] = [];
    const result = await quickbooks(calls, () => ({
      body: {
        time: "2026-10-07T12:00:00Z",
        CDCResponse: [{ QueryResponse: [
          { JournalEntry: [{ Id: "je-1", status: "Deleted", MetaData: { LastUpdatedTime: "2026-10-07T11:00:00Z" } }] },
          { Purchase: [{ Id: "p-1", status: "Deleted" }] },
        ] }],
      },
    })).changes("2026-10-06T00:00:00Z");
    const reads = calls.filter((c) => !isToken(c.url));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.url).toContain("entities=Customer,Invoice,Payment,CreditMemo,JournalEntry,Purchase");
    expect(result.ok && result.value.changes.map((c) => [c.kind, c.externalId, c.deleted])).toEqual([
      ["journal", "je-1", true], ["refund", "p-1", true],
    ]);
  });
});

describe("Xero, as it is sent a branch", () => {
  it("puts the tracking option, with its category, on the journal line, and no contact anywhere", async () => {
    const calls: Call[] = [];
    const books = xero(calls, () => ({ body: { ManualJournals: [{ ManualJournalID: "mj-1" }] } }));
    expect(books.journalCustomers ?? false).toBe(false);
    await books.pushJournal!(journal(NORTH));
    const lines = ((bodyOf(calls, "/ManualJournals")["ManualJournals"] as Record<string, unknown>[])[0]!["JournalLines"]) as Record<string, unknown>[];
    expect(lines[0]!["Tracking"]).toEqual([{
      TrackingCategoryID: "cat-region", Name: "Region", TrackingOptionID: "opt-north", Option: "North",
    }]);
    expect(lines[1]).not.toHaveProperty("Tracking");
    expect(JSON.stringify(lines)).not.toContain("cust-9");
  });

  it("puts the tracking option on every line of an invoice and its tax line", async () => {
    const calls: Call[] = [];
    await xero(calls, () => ({ body: { Invoices: [{ InvoiceID: "inv-1" }] } })).pushInvoice(invoice(NORTH));
    const items = ((bodyOf(calls, "/Invoices")["Invoices"] as Record<string, unknown>[])[0]!["LineItems"]) as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const item of items) expect(item["Tracking"]).toEqual([expect.objectContaining({ TrackingOptionID: "opt-north", Name: "Region" })]);
  });

  it("offers every option of every tracking category, with its category", async () => {
    const calls: Call[] = [];
    const result = await xero(calls, () => ({
      body: { TrackingCategories: [{
        TrackingCategoryID: "cat-region", Name: "Region", Status: "ACTIVE",
        Options: [{ TrackingOptionID: "opt-north", Name: "North", Status: "ACTIVE" }, { TrackingOptionID: "opt-old", Name: "Old", Status: "ARCHIVED" }],
      }] },
    })).branchOptions!();
    expect(result).toEqual({ ok: true, value: [
      { externalId: "opt-north", name: "North", groupId: "cat-region", groupName: "Region", active: true },
      { externalId: "opt-old", name: "Old", groupId: "cat-region", groupName: "Region", active: false },
    ] });
  });

  it("reads manual journals and bank transactions for deletions, and a credit note's allocations as listed", async () => {
    const calls: Call[] = [];
    const result = await xero(calls, (call) => {
      if (call.url.includes("/ManualJournals")) return { body: { ManualJournals: [{ ManualJournalID: "mj-1", Status: "DELETED" }] } };
      if (call.url.includes("/BankTransactions")) return { body: { BankTransactions: [{ BankTransactionID: "bt-1", Status: "DELETED" }] } };
      if (call.url.includes("/CreditNotes")) {
        return { body: { CreditNotes: [
          { CreditNoteID: "cn-1", Status: "AUTHORISED", Allocations: [
            { AllocationID: "al-1", Invoice: { InvoiceID: "inv-1" }, Amount: 40, Date: "/Date(1759708800000+0000)/" },
            { AllocationID: "al-2", Invoice: { InvoiceID: "inv-2" }, Amount: 20, IsDeleted: true },
          ] },
          { CreditNoteID: "cn-2", Status: "AUTHORISED" },
        ] } };
      }
      const collection = /\/([A-Za-z]+)\?/.exec(call.url)![1]!;
      return { body: { [collection]: [] } };
    }).changes("2026-10-06T00:00:00.000Z");
    expect(calls.filter((c) => !isToken(c.url)).map((c) => /\/([A-Za-z]+)\?/.exec(c.url)![1]))
      .toEqual(["Contacts", "Invoices", "BatchPayments", "CreditNotes", "ManualJournals", "BankTransactions"]);
    expect(calls.find((c) => c.url.includes("/ManualJournals"))!.headers["If-Modified-Since"]).toBe("2026-10-06T00:00:00.000Z");
    const changes = result.ok ? result.value.changes : [];
    expect(changes.find((c) => c.externalId === "mj-1")).toMatchObject({ kind: "journal", deleted: true });
    expect(changes.find((c) => c.externalId === "bt-1")).toMatchObject({ kind: "refund", deleted: true });
    expect(changes.find((c) => c.externalId === "cn-1")!.allocations).toEqual([
      { externalId: "al-1", invoiceExternalId: "inv-1", amount: "40", date: "2025-10-06" },
    ]);
    /** A credit note read that does not list its allocations says nothing about them. */
    expect(changes.find((c) => c.externalId === "cn-2")!.allocations).toBeUndefined();
  });
});
