import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as journals from "../src/services/journals";
import * as accounting from "../src/services/accounting";
import * as ledgerReports from "../src/services/ledger";
import type { ServiceContext } from "../src/services/context";
import type {
  AccountingProvider, ExternalJournal, HttpResponse, PushResult,
} from "../src/accounting/provider";
import { createQuickBooksProvider } from "../src/accounting/quickbooks";
import { createXeroProvider } from "../src/accounting/xero";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M14. A MANUAL JOURNAL, AND EVERY WAY ONE IS REFUSED
 *
 * Balanced or refused with the imbalance named, never into a closed period or
 * the future, never into an account the product keeps in step with
 * documents, reversed rather than edited and only once, audited, and sent to
 * the books as a journal once its accounts are mapped.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("journals:org");
const USER = fixtureId("journals:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...extra,
});
const finance = (extra: Partial<ServiceContext> = {}) => as(["accountant"], extra);

const RENT = {
  memo: "September rent, paid from the operating account",
  lines: [
    { accountCode: "6500", debit: "2400.00", memo: "Rent" },
    { accountCode: "1000", credit: "2400.00" },
  ],
};

/** An UnprocessableError with an issue saying this, which is what the screen shows. */
const saying = (pattern: RegExp) => ({
  issues: expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(pattern) })]),
});

async function balance(code: string): Promise<string> {
  const [row] = await raw`select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} and account_code = ${code}`;
  return (row as { net: string }).net;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Journal Co", slug: "journal-co" });
});

run("posting a journal", () => {
  it("posts a balanced entry to the ledger, numbered and audited", async () => {
    const entry = await journals.create(finance(), { ...RENT, occurredOn: "2026-09-30" });
    expect(entry.number).toBe(1);
    expect(entry.total).toBe("2400.0000");
    expect(entry.lines).toHaveLength(2);
    expect(await balance("6500")).toBe("2400.0000");
    expect(await balance("1000")).toBe("-2400.0000");
    const [audit] = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${entry.id}`;
    expect((audit as { action: string }).action).toBe("journal.posted");
    const tb = await ledgerReports.trialBalance(finance());
    expect(tb.balanced).toBe(true);
    expect((await journals.create(finance(), RENT)).number).toBe(2);
  });

  it("refuses an entry that does not balance, naming the difference", async () => {
    await expect(journals.create(finance(), {
      memo: "Off by forty", lines: [{ accountCode: "6500", debit: "100" }, { accountCode: "1000", credit: "60" }],
    })).rejects.toMatchObject(saying(/debits are more by 40/));
    expect(await balance("6500")).toBe("0.0000");
  });

  it("refuses a control account, the future and an empty memo", async () => {
    await expect(journals.create(finance(), {
      memo: "Fix AR", lines: [{ accountCode: "1200", debit: "10" }, { accountCode: "4000", credit: "10" }],
    })).rejects.toMatchObject(saying(/Line 1: Account 1200 cannot take a journal/));
    await expect(journals.create(finance(), { ...RENT, occurredOn: "2099-01-01" })).rejects.toThrow(/future/);
    await expect(journals.create(finance(), { ...RENT, memo: "  " })).rejects.toThrow(/Say what it is for/);
  });

  it("refuses a closed period, and names it", async () => {
    await accounting.closePeriod(finance(), { periodEnd: "2026-06-30" });
    await expect(journals.create(finance(), { ...RENT, occurredOn: "2026-06-15" })).rejects.toThrow(/closed through 2026-06-30/);
    await journals.create(finance(), { ...RENT, occurredOn: "2026-07-01" });
  });

  it("is the accountant's and the owner's, not the administrator's", async () => {
    await expect(journals.create(as(["admin"]), RENT)).rejects.toThrow();
    await expect(journals.create(as(["office_manager"]), RENT)).rejects.toThrow();
    await journals.create(as(["owner"]), RENT);
    await expect(journals.list(as(["dispatcher"]))).rejects.toThrow();
  });

  it("replays a retried request as the entry it already made", async () => {
    const first = await journals.create(finance({ idempotencyKey: "je-1" }), RENT);
    const again = await journals.create(finance({ idempotencyKey: "je-1" }), RENT);
    expect(again.id).toBe(first.id);
    expect(await balance("6500")).toBe("2400.0000");
  });
});

run("reversing a journal", () => {
  it("takes every line back, pointing at what it reverses, once", async () => {
    const entry = await journals.create(finance(), { ...RENT, occurredOn: "2026-09-01" });
    const reversal = await journals.reverse(finance(), { id: entry.id });
    expect(reversal.reversesJournalId).toBe(entry.id);
    expect(reversal.reversesNumber).toBe(entry.number);
    expect(reversal.memo).toContain(`Reverses journal ${entry.number}`);
    expect(await balance("6500")).toBe("0.0000");
    const points = await raw`select reverses_entry_id from public.ledger_entry
      where source_type = 'journal' and source_id = ${reversal.id}`;
    const originals = entry.lines.map((l) => l.entryId).sort();
    expect(points.map((p) => (p as { reverses_entry_id: string }).reverses_entry_id).sort()).toEqual(originals);

    const listed = (await journals.list(finance())).journals.find((j) => j.id === entry.id)!;
    expect(listed.reversedByNumber).toBe(reversal.number);
    await expect(journals.reverse(finance(), { id: entry.id })).rejects.toThrow(/already reversed/);
    await expect(journals.reverse(finance(), { id: reversal.id })).rejects.toThrow(/itself a reversal/);
  });

  it("reverses into the open period an entry whose own period is closed", async () => {
    const entry = await journals.create(finance(), { ...RENT, occurredOn: "2026-05-31" });
    await accounting.closePeriod(finance(), { periodEnd: "2026-05-31" });
    await expect(journals.reverse(finance(), { id: entry.id, occurredOn: "2026-05-31" })).rejects.toThrow(/closed/);
    const reversal = await journals.reverse(finance(), { id: entry.id });
    expect(reversal.occurredOn > "2026-05-31").toBe(true);
  });
});

/* ------------------------------------------------------- to the books */

function books(withJournals = true): AccountingProvider & { journals: ExternalJournal[] } {
  const sent: ExternalJournal[] = [];
  const ok = (id: string): PushResult => ({ ok: true, externalId: id, version: null, adopted: false });
  const provider: AccountingProvider & { journals: ExternalJournal[] } = {
    name: "fake",
    journals: sent,
    async pushCustomer() { return ok("c"); },
    async pushInvoice() { return ok("i"); },
    async pushPayment() { return ok("p"); },
    async pushCredit() { return ok("cr"); },
    async pushRefund() { return ok("r"); },
    async pushCreditNote() { return ok("cn"); },
    async pushCreditApplication() { return ok("ca"); },
    async findCreditApplication() { return { ok: true, value: null }; },
    heldMoneyReachesBooks: true,
    async findPushed() { return { ok: true, value: null }; },
    async changes() { return { ok: true, value: { cursor: "c", changes: [], more: false } }; },
    async accounts() { return { ok: true, value: [] }; },
  };
  if (withJournals) provider.pushJournal = async (journal) => { sent.push(journal); return ok(`je-${sent.length}`); };
  return provider;
}

run("syncing a journal to the books", () => {
  beforeEach(async () => {
    await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
      values (${ORG}, 'accounting', 'quickbooks', 'connected', 'TEST_QBO', ${raw.json({ realmId: "1" } as never)})`;
  });

  it("waits for its accounts to be mapped, then goes once with every line", async () => {
    const entry = await journals.create(finance(), RENT);
    const fake = books();
    await accounting.sync(finance(), { provider: fake });
    expect(fake.journals).toHaveLength(0);
    const problems = await accounting.listProblems(finance());
    expect(JSON.stringify(problems)).toContain("not mapped");

    for (const code of ["6500", "1000"]) {
      await accounting.setMapping(finance(), { accountCode: code, externalId: `qbo-${code}`, externalName: code, externalKind: "Account" });
    }
    await accounting.sync(finance(), { provider: fake });
    expect(fake.journals).toHaveLength(1);
    expect(fake.journals[0]).toMatchObject({ idempotencyKey: `OTJ${entry.number}`, number: entry.number, memo: RENT.memo });
    expect(fake.journals[0]!.lines.map((l) => [l.accountExternalId, l.direction, l.amount.amount])).toEqual(
      expect.arrayContaining([["qbo-6500", "debit", "2400.0000"], ["qbo-1000", "credit", "2400.0000"]]),
    );
    await accounting.sync(finance(), { provider: fake });
    expect(fake.journals).toHaveLength(1);
  });

  it("says so when the books cannot take a journal", async () => {
    await journals.create(finance(), RENT);
    await accounting.sync(finance(), { provider: books(false) });
    expect(JSON.stringify(await accounting.listProblems(finance()))).toContain("cannot be sent a manual journal");
  });
});

/* ---------------------------------------------------- the two adapters */

interface Call { url: string; method: string; body?: string }
function transport(answer: unknown, calls: Call[]) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    const body = url.includes("token") ? { access_token: "a", expires_in: 3600 } : answer;
    const response: HttpResponse = { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    return response;
  };
}
const CREDENTIAL = JSON.stringify({ refreshToken: "r", clientId: "c", clientSecret: "s" });
const JOURNAL: ExternalJournal = {
  idempotencyKey: "OTJ7", number: 7, postedOn: "2026-09-30", currency: "USD", memo: "Depreciation",
  lines: [
    { accountExternalId: "81", direction: "debit", amount: { amount: "300.0000", currency: "USD" }, description: null },
    { accountExternalId: "17", direction: "credit", amount: { amount: "300.0000", currency: "USD" }, description: "Vans" },
  ],
};

describe("a journal as each book takes it", () => {
  it("is a QuickBooks JournalEntry numbered with its key", async () => {
    const calls: Call[] = [];
    const qbo = createQuickBooksProvider({ realmId: "1", baseUrl: "https://qbo.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transport({ JournalEntry: { Id: "55", SyncToken: "0" } }, calls));
    const result = await qbo.pushJournal!(JOURNAL);
    expect(result).toMatchObject({ ok: true, externalId: "55" });
    const post = calls.find((c) => c.url.includes("/journalentry"))!;
    const body = JSON.parse(post.body!) as { DocNumber: string; Line: { Amount: number; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string } } }[] };
    expect(body.DocNumber).toBe("OTJ7");
    expect(body.Line.map((l) => [l.JournalEntryLineDetail.PostingType, l.JournalEntryLineDetail.AccountRef.value, l.Amount]))
      .toEqual([["Debit", "81", 300], ["Credit", "17", 300]]);
  });

  it("is a posted Xero manual journal, credits negative, found by its narration", async () => {
    const calls: Call[] = [];
    const xero = createXeroProvider({ tenantId: "t", baseUrl: "https://xero.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transport({ ManualJournals: [{ ManualJournalID: "mj-1" }] }, calls));
    expect(await xero.pushJournal!(JOURNAL)).toMatchObject({ ok: true, externalId: "mj-1" });
    const put = calls.find((c) => c.url.includes("/ManualJournals"))!;
    const body = JSON.parse(put.body!) as { ManualJournals: { Narration: string; Status: string; JournalLines: { LineAmount: number; AccountID: string }[] }[] };
    expect(body.ManualJournals[0]!.Status).toBe("POSTED");
    expect(body.ManualJournals[0]!.Narration.startsWith("OTJ7:")).toBe(true);
    expect(body.ManualJournals[0]!.JournalLines.map((l) => l.LineAmount)).toEqual([300, -300]);

    await xero.findPushed("journal", "OTJ7");
    const find = calls[calls.length - 1]!;
    expect(decodeURIComponent(find.url)).toContain('Narration.StartsWith("OTJ7:")');
  });
});
