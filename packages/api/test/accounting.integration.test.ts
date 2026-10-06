import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, ledger, type Actor } from "@opentradesos/core";
import * as accounting from "../src/services/accounting";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import * as creditPayouts from "../src/services/credit-payouts";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import {
  AccountingNotConfiguredError, createProvider, registeredProviders,
  type AccountingEntityKind, type AccountingProvider, type ChangeSet,
  type ExternalAccount, type ExternalChange, type ExternalRef, type ExternalRefund, type ExternalCredit,
  type ExternalCreditApplication, type ExternalCreditNote, type ExternalCreditNoteRefund, type ExternalInvoice,
  type HttpResponse, type PushResult, type ReadResult,
} from "../src/accounting/provider";
import {
  AmountNotRepresentableError, createQuickBooksProvider, toProviderAmount,
} from "../src/accounting/quickbooks";
import { createXeroProvider } from "../src/accounting/xero";
import "../src/accounting";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/** The token endpoint, by its parsed origin rather than by how the address happens to begin. */
const isTokenUrl = (address: string): boolean => new URL(address).origin === "https://token.test";

/**
 * THE ACCOUNTING BRIDGE
 *
 * Two properties carry this module, and both are the kind that look fine
 * until the day they matter.
 *
 * IDEMPOTENCY. A sync that runs twice must not put two invoices in a
 * company's QuickBooks. The rule is that a local entity is pushed at most
 * once per connection, enforced by a row in `accounting_entity_link` written
 * and committed BEFORE the HTTP call under a unique index. Every test in
 * "the same document, twice" below attacks one way that could fail.
 *
 * THE READ BUDGET. Intuit charges for reads and refuses the overage with a
 * 429 rather than billing it. So running out of reads has to be an ordinary
 * reported state rather than an exception, the cursor must not advance
 * through a window nobody read, and a push that cannot be verified must not
 * happen. The tests in "when the reads run out" are the ones that stop a
 * metering ceiling turning into a silent outage.
 *
 * Nothing here reaches Intuit. The provider is injected everywhere the
 * service uses one, and the QuickBooks adapter's own tests hand it a
 * transport.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("accounting/org");
const USER = fixtureId("accounting/user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const as = (roles: string[], grants: string[] = []): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: roles as Actor["roles"],
    ...(grants.length > 0 ? { grants: grants as NonNullable<Actor["grants"]> } : {}),
  },
  db: db(),
});
const owner = () => as(["owner"]);
/**
 * Holds a spread of other permissions and deliberately NOT `accounting:sync`.
 *
 * An actor with no permissions at all would be refused by any guard, so a
 * test using one cannot tell a surface guarded by the right permission from
 * one guarded by any permission, which is the exact failure
 * permissions-enforced.test.ts exists to catch one level up.
 */
const withoutSync = () => as([], [
  "settings:read", "settings:write", "invoice:read", "invoice:write",
  "ledger:read", "ledger:post", "payment:collect", "customer:read",
]);
/** Exactly what the worker holds: the sync grant and nothing else. */
const worker = (): ServiceContext => ({ actor: accounting.syncActor(ORG), db: db() });

let connectionId = "";
let customerId = "";
let propertyId = "";

/* ----------------------------------------------------------- the fake books */

interface FakeOptions {
  /** Reads fail with a 429 until this is cleared. */
  readBudgetExhausted?: boolean;
  /** Reads succeed this many times and then start refusing. */
  readsAllowed?: number;
  /** The provider already holds these, keyed by "kind:key". */
  existing?: Map<string, ExternalRef>;
  /** Pushes fail with this. */
  pushFailure?: { code: string; message: string; retryable: boolean; duplicate: boolean };
  /** Only this kind fails. Without it, every push does. */
  failKind?: AccountingEntityKind;
  changes?: ExternalChange[];
  cursor?: string;
}

interface Fake extends AccountingProvider {
  /** Every create it was asked to make, in order. Length is the whole point. */
  creates: { kind: AccountingEntityKind; key: string }[];
  lookups: { kind: AccountingEntityKind; key: string }[];
  /** Every refund it was handed, as handed. */
  refunds: ExternalRefund[];
  credits: ExternalCredit[];
  /** Every invoice, credit note and application handed over, as handed. */
  invoices: ExternalInvoice[];
  creditNotes: ExternalCreditNote[];
  applications: ExternalCreditApplication[];
  creditRefunds: ExternalCreditNoteRefund[];
  options: FakeOptions;
}

function fakeProvider(options: FakeOptions = {}): Fake {
  const creates: { kind: AccountingEntityKind; key: string }[] = [];
  const lookups: { kind: AccountingEntityKind; key: string }[] = [];
  const refunds: ExternalRefund[] = [];
  const credits: ExternalCredit[] = [];
  const invoices: ExternalInvoice[] = [];
  const creditNotes: ExternalCreditNote[] = [];
  const applications: ExternalCreditApplication[] = [];
  const creditRefunds: ExternalCreditNoteRefund[] = [];
  let next = 1;
  let readsLeft = options.readsAllowed ?? Number.MAX_SAFE_INTEGER;
  const affordable = () => {
    if (options.readBudgetExhausted) return false;
    if (readsLeft <= 0) return false;
    readsLeft -= 1;
    return true;
  };

  const push = (kind: AccountingEntityKind, key: string): PushResult => {
    creates.push({ kind, key });
    if (options.pushFailure && (!options.failKind || options.failKind === kind)) {
      return { ok: false, ...options.pushFailure };
    }
    const ref = { externalId: `${kind}-${next++}`, version: "0" };
    options.existing?.set(`${kind}:${key}`, ref);
    return { ok: true, ...ref, adopted: false };
  };

  const blocked = <T,>(): ReadResult<T> => ({
    ok: false,
    code: "429",
    message: "QuickBooks has refused further reads until the metering window rolls.",
    retryable: true,
    budgetExhausted: true,
    retryAfterSeconds: 60,
  });

  return {
    name: "fake",
    creates,
    lookups,
    options,
    async pushCustomer(c) { return push("customer", c.idempotencyKey); },
    async pushInvoice(i) { invoices.push(i); return push("invoice", i.idempotencyKey); },
    async pushPayment(p) { return push("payment", p.idempotencyKey); },
    async pushCredit(c) { credits.push(c); return push("credit_memo", c.idempotencyKey); },
    async pushRefund(r) { refunds.push(r); return push("refund", r.idempotencyKey); },
    async pushCreditNote(n) { creditNotes.push(n); return push("credit_note", n.idempotencyKey); },
    async pushCreditApplication(a) {
      applications.push(a);
      return push("credit_note_application", a.idempotencyKey);
    },
    async pushCreditNoteRefund(r) {
      creditRefunds.push(r);
      return push("credit_note_refund", r.idempotencyKey);
    },
    async findCreditApplication(a) {
      if (!affordable()) return blocked<ExternalRef | null>();
      lookups.push({ kind: "credit_note_application", key: a.idempotencyKey });
      return { ok: true, value: options.existing?.get(`credit_note_application:${a.idempotencyKey}`) ?? null };
    },
    heldMoneyReachesBooks: true,
    refunds,
    credits,
    invoices,
    creditNotes,
    applications,
    creditRefunds,
    async findPushed(kind, key) {
      if (!affordable()) return blocked<ExternalRef | null>();
      lookups.push({ kind, key });
      return { ok: true, value: options.existing?.get(`${kind}:${key}`) ?? null };
    },
    async changes(cursor): Promise<ReadResult<ChangeSet>> {
      if (!affordable()) return blocked<ChangeSet>();
      return {
        ok: true,
        value: {
          cursor: options.cursor ?? `cursor-after-${cursor ?? "start"}`,
          changes: options.changes ?? [],
          more: false,
        },
      };
    },
    async accounts(): Promise<ReadResult<ExternalAccount[]>> {
      if (options.readBudgetExhausted) return blocked<ExternalAccount[]>();
      return {
        ok: true,
        value: [{
          externalId: "42", name: "Services Income", kind: "Item",
          classification: "income", number: null, active: true,
        }],
      };
    },
  };
}

/* --------------------------------------------------------------- fixtures */

/** Everything the sync needs mapped so a push is not refused for a missing account. */
async function mapEverything(): Promise<void> {
  for (const [code, name] of [
    [ledger.ACCOUNTS.REVENUE, "Services Income"],
    [ledger.ACCOUNTS.TAX_PAYABLE, "Sales Tax Payable"],
    [ledger.ACCOUNTS.CASH, "Undeposited Funds"],
    [ledger.ACCOUNTS.WRITE_OFF, "Bad Debt"],
  ] as const) {
    await accounting.setMapping(owner(), {
      accountCode: code, externalId: `qbo-${code}`, externalName: name, externalKind: "Item",
    });
  }
}

async function anInvoice(unitPrice = "400.00"): Promise<string> {
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Service call", quantity: "1", unitPrice, discountAmount: "0", taxable: false }],
  });
  return invoice.id as string;
}

const linkRows = () => raw<{
  kind: string; entity_id: string; state: string; external_id: string | null;
  attempts: number; last_error: string | null; idempotency_key: string;
}[]>`select kind, entity_id, state, external_id, attempts, last_error, idempotency_key
     from public.accounting_entity_link where organization_id = ${ORG} order by kind`;

const runRows = () => raw<{
  cursor: string | null; records_read: number; records_written: number;
  finished_at: Date | null; error: string | null; blocked_reason: string | null;
  entity_type: string | null; direction: string;
}[]>`select cursor, records_read, records_written, finished_at, error, blocked_reason,
            entity_type, direction
     from public.sync_run where organization_id = ${ORG} order by started_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ledger Co", slug: "accounting-ledger-co" });

  const [c] = await raw`insert into public.customer (organization_id, name)
    values (${ORG}, 'Rivera Property Group') returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Bluebonnet Ln', 'Austin', 'TX', '78702') returning id`;
  propertyId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${customerId}, ${propertyId})`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.accounting_entity_link where organization_id = ${ORG}`;
  await raw`delete from public.account_mapping where organization_id = ${ORG}`;
  await raw`delete from public.accounting_period where organization_id = ${ORG}`;
  await raw`delete from public.sync_run where organization_id = ${ORG}`;
  await raw`delete from public.integration_connection where organization_id = ${ORG}`;
  await raw`delete from public.payment_allocation where organization_id = ${ORG}`;
  await raw`delete from public.payment where organization_id = ${ORG}`;
  await raw`delete from public.invoice_line where organization_id = ${ORG}`;
  /**
   * The ledger refuses a DELETE by a trigger, which is correct and is one of
   * the properties this project rests on. `session_replication_role` suspends
   * user triggers FOR THIS SESSION only, for the duration of a cleanup that
   * is deleting test data rather than correcting a book, exactly as
   * `resetOrg` in ./helpers does. Nothing about the trigger changes.
   */
  await raw.unsafe("set session_replication_role = replica");
  try {
    await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
    await raw`delete from public.credit_note_application where organization_id = ${ORG}`;
    await raw`delete from public.credit_note_line where organization_id = ${ORG}`;
    await raw`delete from public.credit_note where organization_id = ${ORG}`;
    await raw`delete from public.invoice where organization_id = ${ORG}`;
  } finally {
    await raw.unsafe("set session_replication_role = origin");
  }

  const [conn] = await raw`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${ORG}, 'accounting', 'quickbooks', 'connected', 'TEST_QBO_CREDENTIAL',
            ${raw.json({ realmId: "123" })})
    returning id`;
  connectionId = conn!.id;
});

/* ------------------------------------------------------------- the seam */

run("the provider seam", () => {
  it("has QuickBooks registered by importing the barrel", () => {
    expect(registeredProviders()).toContain("quickbooks");
  });

  it("refuses a provider nobody wrote an adapter for", () => {
    /**
     * Fail closed. A deployment that names "sage" in its connection row and
     * has no adapter gets a named error, not a sync that appears to run and
     * moves nothing.
     */
    expect(() => createProvider("sage", {}, "{}"))
      .toThrow(AccountingNotConfiguredError);
  });

  it("builds a QuickBooks provider from a connection's settings and secret", () => {
    const provider = createProvider("quickbooks", { realmId: "123" }, JSON.stringify({
      refreshToken: "rt", clientId: "ci", clientSecret: "cs",
    }));
    expect(provider.name).toBe("quickbooks");
  });
});

/* -------------------------------------------------- the QuickBooks adapter */

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function transportFor(
  script: ((call: Call) => { status: number; body: unknown; headers?: Record<string, string> })[],
  calls: Call[],
) {
  let index = 0;
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = { url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) };
    calls.push(call);
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    const result = step!(call);
    const headers = result.headers ?? {};
    const response: HttpResponse = {
      status: result.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => typeof result.body === "string" ? result.body : JSON.stringify(result.body),
    };
    return response;
  };
}

const CREDENTIAL = JSON.stringify({
  refreshToken: "refresh-token-secret", clientId: "client-id", clientSecret: "client-secret",
});

const tokenOk = { status: 200, body: { access_token: "access-token-secret", expires_in: 3600 } };

describe("the QuickBooks adapter", () => {
  it("refuses a credential that is not the three fields it needs", () => {
    /**
     * Named at construction rather than as an opaque 400 from Intuit hours
     * later, when nobody remembers what was configured.
     */
    expect(() => createQuickBooksProvider({ realmId: "1" }, "not json"))
      .toThrow(/refreshToken, clientId and clientSecret/);
    expect(() => createQuickBooksProvider({ realmId: "1" }, JSON.stringify({ clientId: "a", clientSecret: "b" })))
      .toThrow(/missing "refreshToken"/);
  });

  it("refreshes before the first call and sends the access token as a bearer", async () => {
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", baseUrl: "https://qb.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transportFor([
        () => tokenOk,
        () => ({ status: 200, body: { CDCResponse: [], time: "2026-01-02T00:00:00Z" } }),
      ], calls),
    );

    const result = await provider.changes(null);
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://token.test");
    expect(calls[0]!.body).toContain("grant_type=refresh_token");
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer access-token-secret");
    expect(calls[1]!.url).toContain("/v3/company/9/cdc");
  });

  it("never lets a token reach anything it returns", async () => {
    /**
     * The refresh token is a reference into the secret store and the access
     * token is in memory. Neither may appear in a value a caller could
     * serialize into a response body, a log line or a support ticket. This
     * sweeps everything the interface can return.
     */
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", baseUrl: "https://qb.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transportFor([
        () => tokenOk,
        () => ({ status: 200, body: { Invoice: { Id: "77", SyncToken: "0" } } }),
        () => ({ status: 200, body: { CDCResponse: [], time: "2026-01-02T00:00:00Z" } }),
        () => ({ status: 200, body: { QueryResponse: { Account: [], Item: [] } } }),
        () => ({ status: 200, body: { QueryResponse: { Account: [], Item: [] } } }),
        () => ({ status: 401, body: { Fault: { Error: [{ code: "3200", Message: "token expired" }] } } }),
      ], calls),
    );

    const results = [
      await provider.pushInvoice({
        idempotencyKey: "1001", customerExternalId: "5", documentNumber: "1001",
        issuedOn: "2026-02-01", dueOn: null, currency: "USD",
        lines: [{
          description: "Call out", quantity: "1",
          unitPrice: { amount: "100.00", currency: "USD" },
          amount: { amount: "100.00", currency: "USD" },
          accountExternalId: "42", accountExternalKind: "Item",
        }],
        tax: null, memo: null,
      }),
      await provider.changes(null),
      await provider.accounts(),
    ];

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("refresh-token-secret");
    expect(serialized).not.toContain("access-token-secret");
  });

  it("says nothing about the request when a refresh is rejected", async () => {
    /**
     * Intuit echoes request parameters in some token failures, and the
     * request parameter here is the refresh token. An error message is the
     * most widely copied string in any system.
     */
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transportFor([() => ({ status: 400, body: { error: "invalid_grant", refresh_token: "refresh-token-secret" } })], calls),
    );
    await expect(provider.accounts()).rejects.toThrow(/HTTP 400/);
    await expect(provider.accounts()).rejects.not.toThrow(/refresh-token-secret/);
  });

  it("hands a rotated refresh token back to the deployment", async () => {
    /**
     * QuickBooks issues a new refresh token on most refreshes and retires the
     * old one. Dropping it works until the grace period ends, and then the
     * connection is dead with no error anybody saw at the time.
     */
    const calls: Call[] = [];
    const rotated: string[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test", baseUrl: "https://qb.test" }, CREDENTIAL,
      { onCredentialRotated: async (credential) => { rotated.push(credential); } },
      transportFor([
        () => ({ status: 200, body: { access_token: "at", expires_in: 3600, refresh_token: "rotated-token" } }),
        () => ({ status: 200, body: { CDCResponse: [], time: "2026-01-02T00:00:00Z" } }),
      ], calls),
    );

    await provider.changes(null);
    expect(rotated).toHaveLength(1);
    expect(JSON.parse(rotated[0]!)).toMatchObject({
      refreshToken: "rotated-token", clientId: "client-id", clientSecret: "client-secret",
    });
  });

  it("treats a 429 on a READ as a spent budget rather than a failure", async () => {
    /**
     * THE CONSTRAINT THIS WHOLE MODULE IS BUILT AROUND. Intuit meters reads
     * and refuses the overage with a 429 instead of billing it. Modelled as
     * an exception it kills the pass; modelled as a state the pass carries
     * on and the cursor holds.
     */
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test", baseUrl: "https://qb.test" }, CREDENTIAL, {},
      transportFor([
        () => tokenOk,
        () => ({ status: 429, body: "", headers: { "retry-after": "90" } }),
      ], calls),
    );

    const result = await provider.changes(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.budgetExhausted).toBe(true);
    expect(result.retryAfterSeconds).toBe(90);
    expect(result.retryable).toBe(true);
  });

  it("treats a 429 on a WRITE as ordinary throttling, not a spent read budget", async () => {
    /**
     * Writes are not what is metered. Reporting a throttled write as an
     * exhausted read budget would put "wait for the quota window" on a screen
     * when the truth is "try again in a second", and would stop the sync
     * advancing its cursor for a reason unrelated to reading.
     */
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test", baseUrl: "https://qb.test" }, CREDENTIAL, {},
      transportFor([() => tokenOk, () => ({ status: 429, body: "" })], calls),
    );

    const result = await provider.pushCustomer({
      idempotencyKey: "Rivera", name: "Rivera", email: null, phone: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.retryable).toBe(true);
    expect(JSON.stringify(result)).not.toContain("metering window");
  });

  it("reads the cursor from Intuit's own clock, not from the newest change", async () => {
    /**
     * A document written while the request was in flight carries a timestamp
     * inside the page we just read. A cursor derived from the data steps past
     * it and loses it permanently.
     */
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test", baseUrl: "https://qb.test" }, CREDENTIAL, {},
      transportFor([
        () => tokenOk,
        () => ({
          status: 200,
          body: {
            CDCResponse: [{ QueryResponse: [{
              Invoice: [
                { Id: "10", SyncToken: "2", MetaData: { LastUpdatedTime: "2026-03-01T10:00:00Z" } },
                { Id: "11", status: "Deleted", MetaData: { LastUpdatedTime: "2026-03-01T11:00:00Z" } },
              ],
            }] }],
            time: "2026-03-01T12:00:00Z",
          },
        }),
      ], calls),
    );

    const result = await provider.changes("2026-02-01T00:00:00Z");
    if (!result.ok) throw new Error("expected a change set");
    expect(result.value.cursor).toBe("2026-03-01T12:00:00Z");
    expect(result.value.changes).toHaveLength(2);
    expect(result.value.changes[0]).toMatchObject({ kind: "invoice", externalId: "10", deleted: false });
    expect(result.value.changes[1]).toMatchObject({ externalId: "11", deleted: true });
  });

  it("asks for a first window Intuit will accept", async () => {
    /**
     * `/cdc` refuses a changedSince over thirty days old. Being one minute
     * over is a 400 on every pass forever, so the first window is twenty
     * nine days.
     */
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test", baseUrl: "https://qb.test" }, CREDENTIAL, {},
      transportFor([() => tokenOk, () => ({ status: 200, body: { CDCResponse: [], time: "x" } })], calls),
    );
    await provider.changes(null);

    const since = new URL(calls[1]!.url).searchParams.get("changedSince")!;
    const ageDays = (Date.now() - Date.parse(since)) / 86_400_000;
    expect(ageDays).toBeLessThan(30);
    expect(ageDays).toBeGreaterThan(28);
  });

  it("escapes a quote in a lookup key", async () => {
    // An apostrophe in a company name is common and unescaped it produces a
    // parse error from Intuit that reads like an outage.
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test", baseUrl: "https://qb.test" }, CREDENTIAL, {},
      transportFor([() => tokenOk, () => ({ status: 200, body: { QueryResponse: {} } })], calls),
    );
    await provider.findPushed("customer", "O'Brien Mechanical");

    const query = new URL(calls[1]!.url).searchParams.get("query")!;
    expect(query).toContain("\\'Brien");
  });

  it("recognises a duplicate so the service can adopt rather than give up", async () => {
    const calls: Call[] = [];
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test", baseUrl: "https://qb.test" }, CREDENTIAL, {},
      transportFor([
        () => tokenOk,
        () => ({ status: 400, body: { Fault: { Error: [{ code: "6240", Message: "Duplicate Name Exists In The Table" }] } } }),
      ], calls),
    );
    const result = await provider.pushCustomer({
      idempotencyKey: "Rivera", name: "Rivera", email: null, phone: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.duplicate).toBe(true);
  });

  it("refreshes once and retries when a token goes stale mid-flight", async () => {
    const calls: Call[] = [];
    let served = 0;
    const provider = createQuickBooksProvider(
      { realmId: "9", tokenUrl: "https://token.test", baseUrl: "https://qb.test" }, CREDENTIAL, {},
      transportFor([
        () => tokenOk,
        () => { served += 1; return served === 1 ? { status: 401, body: "" } : { status: 200, body: { QueryResponse: {} } }; },
        () => tokenOk,
        () => ({ status: 200, body: { QueryResponse: {} } }),
      ], calls),
    );
    const result = await provider.findPushed("invoice", "1001");
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.url === "https://token.test")).toHaveLength(2);
  });

  it("refuses an amount it cannot send without losing a fraction of a cent", () => {
    /**
     * Money is numeric(14,4) here and QuickBooks holds two decimal places.
     * Truncating means the books and the ledger differ per line, which
     * reconciles to nothing and is found by an accountant rather than by us.
     */
    expect(toProviderAmount("400.0000")).toBe(400);
    expect(toProviderAmount("400.5")).toBe(400.5);
    expect(toProviderAmount("0.10")).toBe(0.1);
    expect(() => toProviderAmount("400.1234")).toThrow(AmountNotRepresentableError);
    expect(() => toProviderAmount("four hundred")).toThrow(AmountNotRepresentableError);
  });
});

/* --------------------------------------------------------- account mapping */

run("mapping our account codes onto theirs", () => {
  it("needs accounting:sync", async () => {
    await expect(accounting.setMapping(withoutSync(), {
      accountCode: "4000", externalId: "1", externalName: "Income", externalKind: "Item",
    })).rejects.toThrow(PermissionError);
  });

  it("records who changed where revenue lands", async () => {
    await accounting.setMapping(owner(), {
      accountCode: "4000", externalId: "1", externalName: "Services Income", externalKind: "Item",
    });
    await accounting.setMapping(owner(), {
      accountCode: "4000", externalId: "2", externalName: "Other Income", externalKind: "Item",
    });

    const mappings = await accounting.listMappings(owner());
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.externalId).toBe("2");

    const [audited] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'accounting.account_mapped'`;
    expect(audited!.n).toBe(2);
  });

  it("names every code a posting used and nothing has been mapped to", async () => {
    await anInvoice();
    const unmapped = await inTenant(owner(), (tx) =>
      accounting.unmappedAccountCodes(tx, ORG, connectionId));
    expect(unmapped).toContain(ledger.ACCOUNTS.REVENUE);
    expect(unmapped).toContain(ledger.ACCOUNTS.AR);
  });

  it("stops a document rather than guessing which income account it belongs in", async () => {
    /**
     * A default here is a year of misfiled revenue found by an accountant in
     * March. The refusal names the code so the fix is obvious.
     */
    await anInvoice();
    const provider = fakeProvider();
    const outcome = await accounting.sync(owner(), { provider });

    expect(outcome.failed).toBe(1);
    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(0);

    const links = await linkRows();
    const invoiceLink = links.find((row) => row.kind === "invoice")!;
    expect(invoiceLink.state).toBe("failed");
    expect(invoiceLink.last_error).toMatch(/4000 is not mapped/);
  });
});

/* ------------------------------------------------------------- one pass */

run("one sync pass", () => {
  it("writes the sync_run row that nothing had ever written", async () => {
    await mapEverything();
    const provider = fakeProvider({ cursor: "2026-03-01T12:00:00Z" });
    const outcome = await accounting.sync(owner(), { provider });

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.direction).toBe("bidirectional");
    expect(runs[0]!.entity_type).toBe("billing");
    expect(runs[0]!.finished_at).not.toBeNull();
    expect(runs[0]!.cursor).toBe("2026-03-01T12:00:00Z");
    expect(runs[0]!.records_read).toBe(outcome.reads);
    expect(runs[0]!.error).toBeNull();
    expect(runs[0]!.blocked_reason).toBeNull();
  });

  it("puts a customer, an invoice and its payment into the books, in that order", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    await billing.pay(owner(), {
      customerId, method: "card", amount: "400.00", tipAmount: "0",
      allocations: [{ invoiceId, amount: "400.00" }],
    });

    const provider = fakeProvider();
    const outcome = await accounting.sync(owner(), { provider });

    expect(provider.creates.map((c) => c.kind)).toEqual(["customer", "invoice", "payment"]);
    expect(outcome.pushed).toBe(3);
    expect(outcome.writes).toBe(3);
    const runs = await runRows();
    expect(runs[0]!.records_written).toBe(3);
  });

  it("holds a payment back until the invoice it cleared is over there", async () => {
    /**
     * An unapplied payment in QuickBooks looks exactly like an overpayment:
     * the receivable stays open and the customer shows a credit they do not
     * have. Waiting one pass costs nothing.
     */
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    await billing.pay(owner(), {
      customerId, method: "card", amount: "400.00", tipAmount: "0",
      allocations: [{ invoiceId, amount: "400.00" }],
    });

    // A provider that refuses every invoice, so nothing links.
    const provider = fakeProvider({
      failKind: "invoice",
      pushFailure: { code: "6000", message: "line item is invalid", retryable: false, duplicate: false },
    });
    await accounting.sync(owner(), { provider });
    expect(provider.creates.filter((c) => c.kind === "payment")).toHaveLength(0);
  });

  it("does not send a draft invoice", async () => {
    /**
     * A draft has no number anybody can rely on and can still change. An
     * accounting system has no concept of a document that might become
     * something else.
     */
    await mapEverything();
    const invoiceId = await anInvoice();
    await raw`update public.invoice set status = 'draft' where id = ${invoiceId}`;

    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(0);
  });

  it("sends a credit memo for an invoice written off after it reached the books", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });

    await billing.writeOff(owner(), { id: invoiceId, reason: "Uncollectable" });
    await accounting.sync(owner(), { provider });

    expect(provider.creates.filter((c) => c.kind === "credit_memo")).toHaveLength(1);
  });

  it("records an error on the run instead of throwing it at the worker", async () => {
    /**
     * One company's broken connection must not end the pass for every
     * company behind it in the loop, and a failure that rolls back the row
     * recording it leaves nothing for an operator to read.
     */
    await mapEverything();
    await anInvoice();
    const provider = fakeProvider();
    provider.pushInvoice = async () => { throw new Error("the socket closed"); };

    const outcome = await accounting.sync(owner(), { provider });
    expect(outcome.error).toBe("the socket closed");

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.error).toBe("the socket closed");
    expect(runs[0]!.finished_at).not.toBeNull();
  });

  it("runs as a worker actor holding accounting:sync and nothing else", async () => {
    await mapEverything();
    await anInvoice();
    const outcome = await accounting.sync(worker(), { provider: fakeProvider() });
    expect(outcome.pushed).toBeGreaterThan(0);
    // The same actor cannot close a period. A worker must never decide that.
    await expect(accounting.closePeriod(worker(), { periodEnd: "2026-01-31" }))
      .rejects.toThrow(PermissionError);
  });

  it("reports an organization with no accounting system rather than throwing", async () => {
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    const state = await accounting.status(owner());
    expect(state.connected).toBe(false);
    await expect(accounting.sync(owner(), { provider: fakeProvider() }))
      .rejects.toThrow(AccountingNotConfiguredError);
  });
});

/* ------------------------------------------------- the idempotency rule */

/* -------------------------------------- a refunded payment, into each book */

/**
 * A refund recorded against a payment reopens what it paid as a NEGATIVE
 * allocation beside the original rather than an edit to it. The sync nets a
 * payment's allocations per invoice before pushing, so neither book is ever
 * sent a negative application or one for an invoice the payment no longer
 * pays. That netting had no test of its own; these drive it through each
 * real adapter and read the request that would have gone over the wire.
 *
 * Only `pushPayment` is the real adapter. Everything else is the fake books,
 * so the customer and invoice links exist for the payment to point at.
 */
function throughReal(real: AccountingProvider): Fake {
  const fake = fakeProvider();
  return { ...fake, pushPayment: (payment) => real.pushPayment(payment) };
}

async function refundedPayment(): Promise<void> {
  await mapEverything();
  const first = await anInvoice("400.00");
  const second = await anInvoice("100.00");
  const payment = await billing.pay(owner(), {
    customerId, method: "check", amount: "400.00", tipAmount: "0",
    allocations: [{ invoiceId: first, amount: "400.00" }],
  });
  await billing.pay(owner(), {
    customerId, method: "check", amount: "100.00", tipAmount: "0",
    allocations: [{ invoiceId: second, amount: "100.00" }],
  });
  await billing.recordRefund(owner(), {
    id: payment.id as string, amount: "150.00", method: "check", reason: "Part of the job undone",
  });
  const allocations = await raw<{ amount: string }[]>`
    select a.amount::text from public.payment_allocation a where a.payment_id = ${payment.id}
    order by a.amount`;
  /** The history really does hold a negative row, or this test proves nothing. */
  expect(allocations.map((a) => a.amount)).toEqual(["-150.0000", "400.0000"]);
}

run("a refunded payment, into each book", () => {
  it("sends QuickBooks what the payment still pays, never a negative line", async () => {
    await refundedPayment();
    const calls: Call[] = [];
    const real = createQuickBooksProvider(
      { realmId: "9", baseUrl: "https://qbo.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transportFor([(call) => (isTokenUrl(call.url)
        ? tokenOk
        : { status: 200, body: { Payment: { Id: `p-${calls.length}`, SyncToken: "0" } } })], calls),
    );

    await accounting.sync(owner(), { provider: throughReal(real) });

    const bodies = calls.filter((c) => c.url.includes("/payment"))
      .map((c) => JSON.parse(c.body!) as { TotalAmt: number; Line: { Amount: number }[] });
    expect(bodies).toHaveLength(2);
    /**
     * What the company kept, on the receipt and on the line. A receipt of
     * 400 with 250 applied would leave a 150 customer credit in QuickBooks
     * that was in fact paid back.
     */
    const refunded = bodies.find((b) => b.TotalAmt === 250)!;
    expect(refunded.Line.map((l) => l.Amount)).toEqual([250]);
    expect(bodies.map((b) => b.TotalAmt).sort()).toEqual([100, 250]);
    for (const body of bodies) {
      expect(body.Line.every((l) => l.Amount > 0)).toBe(true);
    }
  });

  it("sends Xero what the payment still pays, never a negative payment", async () => {
    await refundedPayment();
    const calls: Call[] = [];
    const real = createXeroProvider(
      { tenantId: "t-1", baseUrl: "https://xero.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transportFor([(call) => (isTokenUrl(call.url)
        ? tokenOk
        : { status: 200, body: { BatchPayments: [{ BatchPaymentID: `bp-${calls.length}` }] } })], calls),
    );

    await accounting.sync(owner(), { provider: throughReal(real) });

    const bodies = calls.filter((c) => c.url.includes("/BatchPayments"))
      .map((c) => JSON.parse(c.body!) as {
        BatchPayments: { Payments: { Amount: number }[] }[];
      });
    expect(bodies).toHaveLength(2);
    const amounts = bodies.map((b) => b.BatchPayments[0]!.Payments.map((p) => p.Amount));
    expect(amounts).toContainEqual([250]);
    expect(amounts).toContainEqual([100]);
    expect(amounts.flat().every((a) => a > 0)).toBe(true);
  });
});

/* ------------------------------ a refund after the payment is in the books */

/**
 * A refund made after its payment had already reached QuickBooks or Xero was
 * sent nowhere: the payment was linked, so it was never offered again, and
 * nothing else looked at refunds. The books kept the cash the company had
 * given back.
 */
async function mapForRefunds(): Promise<void> {
  await mapEverything();
  for (const [code, name, kind] of [
    [ledger.ACCOUNTS.AR, "Accounts Receivable", "Account"],
    [ledger.ACCOUNTS.CUSTOMER_DEPOSITS, "Customer Deposits", "Account"],
  ] as const) {
    await accounting.setMapping(owner(), {
      accountCode: code, externalId: `qbo-${code}`, externalName: name, externalKind: kind,
    });
  }
}

async function paidInvoice(amount = "400.00", paid = amount): Promise<{ invoiceId: string; paymentId: string }> {
  const invoiceId = await anInvoice(amount);
  const payment = await billing.pay(owner(), {
    customerId, method: "card", amount: paid, tipAmount: "0",
    allocations: [{ invoiceId, amount }],
  });
  return { invoiceId, paymentId: payment.id as string };
}

const refund = (paymentId: string, amount: string) => billing.recordRefund(owner(), {
  id: paymentId, amount, method: "card", reason: "Part of the job undone",
});

run("a refund after the payment reached the books", () => {
  it("is sent once, as money back against the customer, dated when it went", async () => {
    await mapForRefunds();
    const { paymentId } = await paidInvoice("400.00");
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creates.map((c) => c.kind)).toEqual(["customer", "invoice", "payment"]);

    await refund(paymentId, "150.00");
    await accounting.sync(owner(), { provider });
    await accounting.sync(owner(), { provider });

    expect(provider.refunds).toHaveLength(1);
    const sent = provider.refunds[0]!;
    expect(sent.amount.amount).toBe("150.0000");
    expect(sent.appliedAmount.amount).toBe("150.0000");
    expect(sent.heldAmount.amount).toBe("0.0000");
    expect(sent.paymentExternalId).toMatch(/^payment-/);
    expect(sent.bankAccountExternalId).toBe(`qbo-${ledger.ACCOUNTS.CASH}`);
    expect(sent.receivableAccountExternalId).toBe(`qbo-${ledger.ACCOUNTS.AR}`);
    /** The company's day, which is what its books date a refund by. */
    expect(sent.refundedOn).toBe(companyToday());
    const links = (await linkRows()).filter((l) => l.kind === "refund");
    expect(links).toHaveLength(1);
    expect(links[0]!.state).toBe("linked");
    expect(links[0]!.external_id).toMatch(/^refund-/);
  });

  it("nets a refund made before the push into the payment and never sends it again", async () => {
    await mapForRefunds();
    const { paymentId } = await paidInvoice("400.00");
    await refund(paymentId, "100.00");
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.refunds).toHaveLength(0);

    await refund(paymentId, "50.00");
    await accounting.sync(owner(), { provider });
    expect(provider.refunds.map((r) => r.amount.amount)).toEqual(["50.0000"]);
  });

  it("settles a payment pushed before refunds were synced from the time it was pushed", async () => {
    await mapForRefunds();
    const { paymentId } = await paidInvoice("400.00");
    await refund(paymentId, "100.00");
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });

    /** As an install upgraded from before: no netting recorded, pushed after the first refund. */
    await raw`delete from public.accounting_entity_link
              where organization_id = ${ORG} and kind = 'refund'`;
    await raw`update public.accounting_entity_link
              set refunds_netted_at = null, pushed_at = now()
              where organization_id = ${ORG} and kind = 'payment'`;
    await refund(paymentId, "25.00");
    await accounting.sync(owner(), { provider });

    expect(provider.refunds.map((r) => r.amount.amount)).toEqual(["25.0000"]);
  });

  it("waits for its payment rather than sending a refund of money the books never saw", async () => {
    await mapForRefunds();
    const { paymentId } = await paidInvoice("400.00");
    // The invoice will not go, so neither will the payment.
    const provider = fakeProvider({
      failKind: "invoice",
      pushFailure: { code: "6000", message: "line item is invalid", retryable: false, duplicate: false },
    });
    await refund(paymentId, "50.00");
    await accounting.sync(owner(), { provider });
    expect(provider.refunds).toHaveLength(0);
  });

  it("goes to QuickBooks as an expense from the bank categorised to Accounts Receivable", async () => {
    await mapForRefunds();
    const { paymentId } = await paidInvoice("400.00");
    const calls: Call[] = [];
    const real = createQuickBooksProvider(
      { realmId: "9", baseUrl: "https://qbo.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transportFor([(call) => (isTokenUrl(call.url)
        ? tokenOk
        : { status: 200, body: { Purchase: { Id: "77", SyncToken: "0" } } })], calls),
    );
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    await refund(paymentId, "150.00");
    await accounting.sync(owner(), {
      provider: { ...provider, pushRefund: (r) => real.pushRefund(r), heldMoneyReachesBooks: real.heldMoneyReachesBooks },
    });

    const purchases = calls.filter((c) => c.url.includes("/purchase"));
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.method).toBe("POST");
    const body = JSON.parse(purchases[0]!.body!) as Record<string, unknown> & {
      Line: { Amount: number; DetailType: string; AccountBasedExpenseLineDetail: { AccountRef: { value: string } } }[];
    };
    expect(body["AccountRef"]).toEqual({ value: `qbo-${ledger.ACCOUNTS.CASH}` });
    expect(body["EntityRef"]).toMatchObject({ type: "Customer" });
    expect(body["DocNumber"]).toMatch(/^OR[0-9a-f]{16}$/);
    expect(body["TxnDate"]).toBe(companyToday());
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0]!.Amount).toBe(150);
    expect(body.Line[0]!.DetailType).toBe("AccountBasedExpenseLineDetail");
    expect(body.Line[0]!.AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: `qbo-${ledger.ACCOUNTS.AR}` });
    /** Not a RefundReceipt: that is a negative sale, and our ledger books this against the receivable. */
    expect(calls.some((c) => c.url.toLowerCase().includes("refundreceipt"))).toBe(false);
  });

  it("goes to Xero as an invoice that puts it back on what is owed and a payment out of the bank", async () => {
    await mapForRefunds();
    const { paymentId } = await paidInvoice("400.00");
    const calls: Call[] = [];
    const real = createXeroProvider(
      { tenantId: "t-1", baseUrl: "https://xero.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
      transportFor([(call) => (isTokenUrl(call.url)
        ? tokenOk
        : call.url.includes("/Invoices")
          ? { status: 200, body: { Invoices: [{ InvoiceID: "inv-r" }] } }
          : { status: 200, body: { BankTransactions: [{ BankTransactionID: "bt-1" }] } })], calls),
    );
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    await refund(paymentId, "150.00");
    await accounting.sync(owner(), {
      provider: { ...provider, pushRefund: (r) => real.pushRefund(r), heldMoneyReachesBooks: real.heldMoneyReachesBooks },
    });

    const sent = calls.filter((c) => !isTokenUrl(c.url));
    expect(sent.map((c) => new URL(c.url).pathname)).toEqual(["/Invoices", "/BankTransactions"]);
    const invoice = (JSON.parse(sent[0]!.body!) as { Invoices: Record<string, unknown>[] }).Invoices[0]!;
    expect(invoice["Type"]).toBe("ACCREC");
    expect(invoice["LineItems"]).toEqual([expect.objectContaining({
      UnitAmount: 150, AccountID: `qbo-${ledger.ACCOUNTS.CUSTOMER_DEPOSITS}`,
    })]);
    const spend = (JSON.parse(sent[1]!.body!) as { BankTransactions: Record<string, unknown>[] }).BankTransactions[0]!;
    expect(spend["Type"]).toBe("SPEND");
    expect(spend["BankAccount"]).toEqual({ AccountID: `qbo-${ledger.ACCOUNTS.CASH}` });
    expect(spend["Reference"]).toBe(invoice["InvoiceNumber"]);
    expect(spend["LineItems"]).toEqual([expect.objectContaining({
      UnitAmount: 150, AccountID: `qbo-${ledger.ACCOUNTS.CUSTOMER_DEPOSITS}`,
    })]);
    /** Each with its own idempotency key, so a retry lands on the same two documents. */
    const keys = sent.map((c) => c.headers["Idempotency-Key"] ?? c.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("sends Xero nothing for money a payment only ever held, because Xero never had it", async () => {
    await mapForRefunds();
    const { paymentId } = await paidInvoice("400.00", "450.00");
    const xeroLike = { ...fakeProvider(), heldMoneyReachesBooks: false };
    await accounting.sync(owner(), { provider: xeroLike });
    await refund(paymentId, "50.00");
    await accounting.sync(owner(), { provider: xeroLike });
    expect(xeroLike.refunds).toHaveLength(0);
    expect((await linkRows()).filter((l) => l.kind === "refund").map((l) => l.state)).toEqual(["linked"]);
  });

  it("credits a written-off invoice by what was still owed, not by its total", async () => {
    await mapForRefunds();
    const { invoiceId, paymentId } = await paidInvoice("400.00");
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    await refund(paymentId, "150.00");
    await billing.writeOff(owner(), { id: invoiceId, reason: "Settled the dispute" });
    await accounting.sync(owner(), { provider });

    expect(provider.refunds.map((r) => r.amount.amount)).toEqual(["150.0000"]);
    expect(provider.credits.map((c) => c.amount.amount)).toEqual(["150.0000"]);
  });
});

run("the same document, twice", () => {
  it("does not create a second invoice when the sync runs again", async () => {
    /**
     * THE RULE: a local entity is pushed at most once per connection, and
     * the thing that makes it true is a committed row in
     * accounting_entity_link under a unique index, not a check the provider
     * is asked to perform.
     */
    await mapEverything();
    await anInvoice();
    const provider = fakeProvider();

    await accounting.sync(owner(), { provider });
    const afterFirst = provider.creates.length;
    await accounting.sync(owner(), { provider });

    expect(provider.creates.length).toBe(afterFirst);
    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(1);

    const [count] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.accounting_entity_link
      where organization_id = ${ORG} and kind = 'invoice'`;
    expect(count!.n).toBe(1);
  });

  it("answers 'already sent' from our own table, spending no metered read", async () => {
    /**
     * This is the difference between a sync that fits in the read budget and
     * one that does not: asking the provider per document per pass is the
     * wall Intuit's metering puts up.
     */
    await mapEverything();
    await anInvoice();
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });

    provider.lookups.length = 0;
    const second = await accounting.sync(owner(), { provider });

    expect(provider.lookups).toHaveLength(0);
    // One read for the change feed, and not one per document.
    expect(second.reads).toBe(1);
    expect(second.writes).toBe(0);
    /**
     * Zero, not "skipped two". A document already in the books is filtered
     * out by the work set query, so the second pass does not even claim it.
     * Skipping at the claim would be correct and slower; being absent from
     * the query is what makes a pass over ten thousand linked invoices cost
     * one index scan.
     */
    expect(second.skipped).toBe(0);
  });

  it("refuses a second claim on a document already in the books", async () => {
    /**
     * The guard at the claim, separately from the work set query that
     * usually means the document is never offered in the first place. Two
     * independent answers to the same question, because the query is an
     * optimisation and this is the correctness argument.
     */
    const ref = { externalId: "qbo-invoice-1", version: "0" };
    await inTenant(owner(), async (tx) => {
      const first = await accounting.claim(tx, ORG, connectionId, "invoice", propertyId, "1001");
      if (first.kind !== "claimed") throw new Error("expected a claim");
      await accounting.link(tx, first.linkId, connectionId, "invoice", ref);
    });

    const second = await inTenant(owner(), (tx) =>
      accounting.claim(tx, ORG, connectionId, "invoice", propertyId, "1001"));
    expect(second).toMatchObject({ kind: "linked", externalId: "qbo-invoice-1" });
  });

  it("will not let the database hold two claims for one document", async () => {
    /**
     * The unique index IS the guard. A check followed by an insert is not:
     * two workers both reading "no row" and both inserting is the normal
     * outcome once a pass runs longer than the worker tick, not a rare
     * interleaving.
     */
    await inTenant(owner(), (tx) =>
      accounting.claim(tx, ORG, connectionId, "invoice", propertyId, "1001"));

    await expect(raw`
      insert into public.accounting_entity_link
        (organization_id, connection_id, kind, entity_id, idempotency_key)
      values (${ORG}, ${connectionId}, 'invoice', ${propertyId}, '1001')`)
      .rejects.toThrow(/accounting_entity_link_entity_idx/);
  });

  it("leaves exactly one claim behind when two workers race", async () => {
    const results = await Promise.all([1, 2].map(() =>
      inTenant(owner(), (tx) =>
        accounting.claim(tx, ORG, connectionId, "invoice", propertyId, "1001"))));

    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    const [count] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.accounting_entity_link
      where organization_id = ${ORG} and entity_id = ${propertyId}`;
    expect(count!.n).toBe(1);
  });

  it("leaves a claim another worker made moments ago alone", async () => {
    /**
     * A `pending` row written seconds ago belongs to a pass that is making
     * the HTTP call right now. Treating it as a crash and recovering it is
     * how the same invoice goes twice.
     */
    await raw`
      insert into public.accounting_entity_link
        (organization_id, connection_id, kind, entity_id, idempotency_key, state, attempts)
      values (${ORG}, ${connectionId}, 'invoice', ${propertyId}, '1001', 'pending', 1)`;

    const claimed = await inTenant(owner(), (tx) =>
      accounting.claim(tx, ORG, connectionId, "invoice", propertyId, "1001"));
    expect(claimed.kind).toBe("busy");
  });

  it("recovers a claim left behind by a process that died", async () => {
    /**
     * The other half of the same window. A claim nobody has touched for
     * long enough belongs to a process that is gone, and leaving it forever
     * means the document never reaches the books at all.
     */
    await raw`
      insert into public.accounting_entity_link
        (organization_id, connection_id, kind, entity_id, idempotency_key, state, attempts, updated_at)
      values (${ORG}, ${connectionId}, 'invoice', ${propertyId}, '1001', 'pending', 1,
              now() - interval '1 hour')`;

    const claimed = await inTenant(owner(), (tx) =>
      accounting.claim(tx, ORG, connectionId, "invoice", propertyId, "1001"));
    expect(claimed).toMatchObject({ kind: "recover", idempotencyKey: "1001" });
  });

  it("adopts a document the provider already has rather than making a second", async () => {
    /**
     * The crash window: the claim committed, the create succeeded, the
     * process died before the response was stored. The row is `pending` with
     * no external id, which is the one state that cannot be resolved
     * locally, so it spends one read.
     */
    await mapEverything();
    const invoiceId = await anInvoice();
    const [invoice] = await raw<{ number: number }[]>`
      select number from public.invoice where id = ${invoiceId}`;
    const key = String(invoice!.number);

    // The books already hold it, and our link row is stuck mid-push.
    const existing = new Map<string, ExternalRef>([
      [`invoice:${key}`, { externalId: "qbo-invoice-99", version: "3" }],
    ]);
    /**
     * `updated_at` an hour ago, because a claim written seconds ago belongs
     * to a worker that is still working and is deliberately left alone. This
     * one belongs to a process that died.
     */
    await raw`
      insert into public.accounting_entity_link
        (organization_id, connection_id, kind, entity_id, idempotency_key, state, attempts, updated_at)
      values (${ORG}, ${connectionId}, 'invoice', ${invoiceId}, ${key}, 'pending', 1, now() - interval '1 hour')`;

    const provider = fakeProvider({ existing });
    const outcome = await accounting.sync(owner(), { provider });

    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(0);
    expect(outcome.adopted).toBeGreaterThanOrEqual(1);
    const links = await linkRows();
    expect(links.find((r) => r.kind === "invoice")).toMatchObject({
      state: "linked", external_id: "qbo-invoice-99",
    });
  });

  it("adopts rather than gives up when the provider says it already has one", async () => {
    await mapEverything();
    const invoiceId = await anInvoice();
    const [invoice] = await raw<{ number: number }[]>`
      select number from public.invoice where id = ${invoiceId}`;

    const existing = new Map<string, ExternalRef>([
      [`invoice:${invoice!.number}`, { externalId: "qbo-invoice-7", version: "1" }],
      [`customer:Rivera Property Group`, { externalId: "qbo-customer-7", version: "1" }],
    ]);
    const provider = fakeProvider({ existing });
    provider.pushInvoice = async () => ({
      ok: false, code: "6140", message: "Duplicate Document Number Found",
      retryable: false, duplicate: true,
    });

    const outcome = await accounting.sync(owner(), { provider });
    expect(outcome.adopted).toBeGreaterThanOrEqual(1);
    const links = await linkRows();
    expect(links.find((r) => r.kind === "invoice")).toMatchObject({
      state: "linked", external_id: "qbo-invoice-7",
    });
  });

  it("refuses to point two of our records at one document over there", async () => {
    /**
     * QuickBooks requires customer display names to be unique, so two local
     * customers called the same thing collapse into one over there. Silently
     * pointing both at it merges two companies' receivables.
     */
    const [second] = await raw`insert into public.customer (organization_id, name)
      values (${ORG}, 'Rivera Property Group') returning id`;

    const ref = { externalId: "qbo-customer-1", version: "0" };
    await inTenant(owner(), async (tx) => {
      const first = await accounting.claim(tx, ORG, connectionId, "customer", customerId, "Rivera Property Group");
      if (first.kind !== "claimed") throw new Error("expected a claim");
      await accounting.link(tx, first.linkId, connectionId, "customer", ref);
    });

    const clash = await inTenant(owner(), async (tx) => {
      const claimed = await accounting.claim(tx, ORG, connectionId, "customer", second!.id, "Rivera Property Group");
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return accounting.link(tx, claimed.linkId, connectionId, "customer", ref);
    });

    expect(clash.ok).toBe(false);
    if (clash.ok) throw new Error("unreachable");
    expect(clash.message).toMatch(/Rename one of them/);
  });

  it("stops offering a document that has failed five times", async () => {
    await mapEverything();
    await anInvoice();
    const provider = fakeProvider({
      failKind: "invoice",
      pushFailure: { code: "6000", message: "line item is invalid", retryable: false, duplicate: false },
    });

    for (let pass = 0; pass < 7; pass += 1) await accounting.sync(owner(), { provider });

    /**
     * Five, not seven. A document nothing can fix retried on every tick
     * forever is a failure nobody sees, because each pass looks like the
     * last.
     */
    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(5);
    const problems = await accounting.listProblems(owner());
    expect(problems.some((p) => p.kind === "invoice" && p.attempts >= 5)).toBe(true);
  });

  it("puts a failed document back without losing the claim", async () => {
    await mapEverything();
    await anInvoice();
    const failing = fakeProvider({
      failKind: "invoice",
      pushFailure: { code: "6000", message: "line item is invalid", retryable: false, duplicate: false },
    });
    for (let pass = 0; pass < 6; pass += 1) await accounting.sync(owner(), { provider: failing });

    const [problem] = (await accounting.listProblems(owner())).filter((p) => p.kind === "invoice");
    const retried = await accounting.retryDocument(owner(), { linkId: problem!.id });
    expect(retried.attempts).toBe(0);

    const working = fakeProvider();
    await accounting.sync(owner(), { provider: working });
    expect(working.creates.filter((c) => c.kind === "invoice")).toHaveLength(1);

    const [count] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.accounting_entity_link
      where organization_id = ${ORG} and kind = 'invoice'`;
    expect(count!.n).toBe(1);
  });

  it("refuses to retry something already in the books", async () => {
    await mapEverything();
    await anInvoice();
    await accounting.sync(owner(), { provider: fakeProvider() });
    const links = await linkRows();
    const invoiceLink = links.find((r) => r.kind === "invoice")!;
    const [row] = await raw<{ id: string }[]>`
      select id from public.accounting_entity_link
      where organization_id = ${ORG} and entity_id = ${invoiceLink.entity_id} and kind = 'invoice'`;
    await expect(accounting.retryDocument(owner(), { linkId: row!.id }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses to retry a document that is not there", async () => {
    await expect(accounting.retryDocument(owner(), { linkId: fixtureId("accounting/missing") }))
      .rejects.toThrow(NotFoundError);
  });
});

/* -------------------------------------------------- the metering ceiling */

run("when the reads run out", () => {
  it("records the block on the run and does not call it an error", async () => {
    await mapEverything();
    const provider = fakeProvider({ readBudgetExhausted: true });
    const outcome = await accounting.sync(owner(), { provider });

    expect(outcome.blockedReason).toBe(accounting.READ_BUDGET_EXHAUSTED);
    expect(outcome.error).toBeNull();

    const runs = await runRows();
    expect(runs[0]!.blocked_reason).toBe("read_budget_exhausted");
    expect(runs[0]!.error).toBeNull();
  });

  it("does not advance the cursor through a window it could not afford to read", async () => {
    /**
     * Advancing here would skip every change in the window, permanently,
     * with no error anywhere.
     */
    await mapEverything();
    await accounting.sync(owner(), { provider: fakeProvider({ cursor: "2026-03-01T00:00:00Z" }) });
    await accounting.sync(owner(), { provider: fakeProvider({ readBudgetExhausted: true }) });

    const runs = await runRows();
    expect(runs[1]!.cursor).toBe("2026-03-01T00:00:00Z");

    const resumed = await accounting.sync(owner(), { provider: fakeProvider({ cursor: "2026-03-02T00:00:00Z" }) });
    expect(resumed.cursor).toBe("2026-03-02T00:00:00Z");
  });

  it("still pushes, because the outbound half needs no reads at all", async () => {
    /**
     * Outbound runs FIRST for this reason. If the budget is already gone, a
     * company still gets its invoices into its books; only the change feed
     * waits.
     */
    await mapEverything();
    await anInvoice();
    const provider = fakeProvider({ readBudgetExhausted: true });
    const outcome = await accounting.sync(owner(), { provider });

    expect(outcome.pushed).toBe(2);
    expect(provider.creates.map((c) => c.kind)).toEqual(["customer", "invoice"]);
    expect(outcome.blockedReason).toBe(accounting.READ_BUDGET_EXHAUSTED);
  });

  it("does NOT create a document it could not check for, and that is the point", async () => {
    /**
     * A `pending` row means a create may already be sitting in the
     * customer's books. Creating anyway because the check was unaffordable
     * is exactly the duplicate invoice this whole design exists to prevent.
     * Waiting costs a pass; guessing costs a document somebody has to find
     * and delete out of a filed quarter.
     */
    await mapEverything();
    const invoiceId = await anInvoice();
    const [invoice] = await raw<{ number: number }[]>`
      select number from public.invoice where id = ${invoiceId}`;
    await raw`
      insert into public.accounting_entity_link
        (organization_id, connection_id, kind, entity_id, idempotency_key, state, attempts, updated_at)
      values (${ORG}, ${connectionId}, 'invoice', ${invoiceId}, ${String(invoice!.number)}, 'pending', 1,
              now() - interval '1 hour')`;

    const provider = fakeProvider({ readBudgetExhausted: true });
    await accounting.sync(owner(), { provider });

    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(0);
  });

  it("asks once and then stops asking for the rest of the pass", async () => {
    /**
     * Asking again produces another 429 and another mark against a limit
     * that is already breached. Two abandoned claims and a change feed is
     * three reads a pass could make; a spent budget makes it one.
     */
    await mapEverything();
    const invoiceId = await anInvoice();
    const [invoice] = await raw<{ number: number }[]>`
      select number from public.invoice where id = ${invoiceId}`;
    for (const [kind, entity, key] of [
      ["customer", customerId, "Rivera Property Group"],
      ["invoice", invoiceId, String(invoice!.number)],
    ] as const) {
      await raw`
        insert into public.accounting_entity_link
          (organization_id, connection_id, kind, entity_id, idempotency_key, state, attempts, updated_at)
        values (${ORG}, ${connectionId}, ${kind}, ${entity}, ${key}, 'pending', 1,
                now() - interval '1 hour')`;
    }

    const provider = fakeProvider({ readBudgetExhausted: true });
    const outcome = await accounting.sync(owner(), { provider });
    expect(outcome.reads).toBe(1);
  });

  it("spends its last read verifying a document, not on the change feed", async () => {
    /**
     * WHY OUTBOUND RUNS FIRST. With one read left, the useful place to spend
     * it is the document whose push may already have landed: getting that
     * wrong means either a duplicate invoice or one that never goes. The
     * change feed can wait a tick and lose nothing, because the cursor holds.
     */
    await mapEverything();
    const invoiceId = await anInvoice();
    const [invoice] = await raw<{ number: number }[]>`
      select number from public.invoice where id = ${invoiceId}`;
    const key = String(invoice!.number);
    await raw`
      insert into public.accounting_entity_link
        (organization_id, connection_id, kind, entity_id, idempotency_key, state, attempts, updated_at)
      values (${ORG}, ${connectionId}, 'invoice', ${invoiceId}, ${key}, 'pending', 1,
              now() - interval '1 hour')`;

    const provider = fakeProvider({
      readsAllowed: 1,
      existing: new Map([[`invoice:${key}`, { externalId: "qbo-invoice-3", version: "1" }]]),
    });
    const outcome = await accounting.sync(owner(), { provider });

    expect(outcome.adopted).toBe(1);
    expect(outcome.blockedReason).toBe(accounting.READ_BUDGET_EXHAUSTED);
    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(0);
  });

  it("reports the block on the mapping screen rather than an empty list", async () => {
    const result = await accounting.listRemoteAccounts(owner(), {
      provider: fakeProvider({ readBudgetExhausted: true }),
    });
    expect(result.blocked).toBe(accounting.READ_BUDGET_EXHAUSTED);
    expect(result.error).toBeNull();
    expect(result.retryAfterSeconds).toBe(60);
  });
});

/* ------------------------------------------------------- the change feed */

run("what comes back from the books", () => {
  it("stops believing a document exists once it is deleted over there", async () => {
    await mapEverything();
    await anInvoice();
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });

    const before = await linkRows();
    const invoiceLink = before.find((r) => r.kind === "invoice")!;

    const second = fakeProvider({
      changes: [{ kind: "invoice", externalId: invoiceLink.external_id!, version: "4", deleted: true, changedAt: new Date() }],
    });
    await accounting.sync(owner(), { provider: second });

    const after = await linkRows();
    expect(after.find((r) => r.kind === "invoice")).toMatchObject({ state: "deleted" });
    expect(after.find((r) => r.kind === "invoice")!.last_error).toMatch(/deleted in the accounting system/);
  });

  it("does not re-create a document somebody deleted on purpose", async () => {
    /**
     * Dropping the link instead of marking it would make the next pass treat
     * the invoice as never pushed, which is the sync arguing with a
     * bookkeeper.
     */
    await mapEverything();
    await anInvoice();
    const first = fakeProvider();
    await accounting.sync(owner(), { provider: first });
    const link = (await linkRows()).find((r) => r.kind === "invoice")!;

    await accounting.sync(owner(), {
      provider: fakeProvider({
        changes: [{ kind: "invoice", externalId: link.external_id!, version: "4", deleted: true, changedAt: new Date() }],
      }),
    });

    const third = fakeProvider();
    await accounting.sync(owner(), { provider: third });
    expect(third.creates).toHaveLength(0);
  });

  it("ignores a document created over there rather than inventing a job here", async () => {
    /**
     * An invoice typed straight into QuickBooks has no job, no property and
     * no visit behind it. Materializing one would put work on a dispatch
     * board nobody scheduled.
     */
    await mapEverything();
    const outcome = await accounting.sync(owner(), {
      provider: fakeProvider({
        changes: [{ kind: "invoice", externalId: "stranger-1", version: "1", deleted: false, changedAt: new Date() }],
      }),
    });
    expect(outcome.changesSeen).toBe(1);
    const [invoices] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.invoice where organization_id = ${ORG}`;
    expect(invoices!.n).toBe(0);
  });
});

/* --------------------------------------------------------- closing a period */

run("closing a period", () => {
  it("needs accounting:close, which is not accounting:sync", async () => {
    /**
     * Different powers. Running the sync is operational; saying a quarter is
     * filed is a decision about what the company has reported.
     */
    await expect(accounting.closePeriod(as([], ["accounting:sync"]), { periodEnd: "2026-01-31" }))
      .rejects.toThrow(PermissionError);
    const closed = await accounting.closePeriod(as([], ["accounting:close"]), { periodEnd: "2026-01-31" });
    expect(closed.periodEnd).toBe("2026-01-31");
  });

  it("refuses to close backwards", async () => {
    await accounting.closePeriod(owner(), { periodEnd: "2026-03-31" });
    await expect(accounting.closePeriod(owner(), { periodEnd: "2026-02-28" }))
      .rejects.toThrow(ConflictError);
  });

  it("holds back a document dated inside the closed period", async () => {
    /**
     * A late invoice pushed into a filed quarter changes a number already
     * reported to a tax authority, and the company is left with an amended
     * return and no record of what changed it.
     */
    await mapEverything();
    await anInvoice();
    const today = new Date().toISOString().slice(0, 10);
    await accounting.closePeriod(owner(), { periodEnd: today, note: "Filed." });

    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(0);
  });

  it("lets it through again once the period is reopened", async () => {
    await mapEverything();
    await anInvoice();
    const today = new Date().toISOString().slice(0, 10);
    await accounting.closePeriod(owner(), { periodEnd: today });
    await accounting.sync(owner(), { provider: fakeProvider() });

    await accounting.reopenPeriod(owner(), { periodEnd: today, reason: "Closed the wrong month." });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(1);
  });

  it("does not burn a document's attempts while a period holds it back", async () => {
    /**
     * A refusal takes a claim and counts against attempts, so five passes
     * after a close every old invoice would be permanently failed and
     * reopening would not bring it back.
     */
    await mapEverything();
    await anInvoice();
    const today = new Date().toISOString().slice(0, 10);
    await accounting.closePeriod(owner(), { periodEnd: today });
    for (let pass = 0; pass < 6; pass += 1) await accounting.sync(owner(), { provider: fakeProvider() });

    await accounting.reopenPeriod(owner(), { periodEnd: today, reason: "Wrong month." });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creates.filter((c) => c.kind === "invoice")).toHaveLength(1);
  });

  it("sends a credit memo raised now against an invoice from a closed quarter", async () => {
    /**
     * The credit memo belongs to the period it was RAISED in, which is open.
     * Dating the guard from the invoice instead means writing off an old
     * receivable produces a document that silently never reaches the books,
     * and the company's AR disagrees with its accountant's for good.
     */
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    await raw`update public.invoice set issued_on = '2026-01-15' where id = ${invoiceId}`;
    await accounting.sync(owner(), { provider: fakeProvider() });

    await billing.writeOff(owner(), { id: invoiceId, reason: "Uncollectable" });
    await accounting.closePeriod(owner(), { periodEnd: "2026-01-31", note: "Q1 filed." });

    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creates.filter((c) => c.kind === "credit_memo")).toHaveLength(1);
  });

  it("refuses to reopen a period nobody closed", async () => {
    await expect(accounting.reopenPeriod(owner(), { periodEnd: "2026-01-31", reason: "x" }))
      .rejects.toThrow(NotFoundError);
  });

  it("keeps the reopened close on the record rather than deleting it", async () => {
    await accounting.closePeriod(owner(), { periodEnd: "2026-01-31", note: "Q1 filed." });
    await accounting.reopenPeriod(owner(), { periodEnd: "2026-01-31", reason: "A credit memo arrived late." });

    const periods = await accounting.listPeriods(owner());
    expect(periods).toHaveLength(1);
    expect(periods[0]!.reopenedAt).not.toBeNull();
    expect(periods[0]!.reopenedReason).toBe("A credit memo arrived late.");
    expect(await accounting.status(owner()).then((s) => s.closedThrough)).toBeNull();
  });
});

/* --------------------------------------------------------------- status */

run("the status screen", () => {
  it("counts what is linked, pending and stuck", async () => {
    await mapEverything();
    await anInvoice();
    await accounting.sync(owner(), { provider: fakeProvider() });

    const state = await accounting.status(owner());
    expect(state.connected).toBe(true);
    expect(state.provider).toBe("quickbooks");
    expect(state.linkedDocuments).toBe(2);
    expect(state.failedDocuments).toBe(0);
    expect(state.lastRun).not.toBeNull();
    expect(state.lastRun!.recordsWritten).toBe(2);
  });

  it("needs accounting:sync to read", async () => {
    await expect(accounting.status(withoutSync())).rejects.toThrow(PermissionError);
  });
});

/* ----------------------------------------------------------- credit notes */

/**
 * Credit notes reached the books nowhere: a company that credited an invoice
 * and synced its books had to raise the matching credit memo over there by
 * hand, and an accountant reconciling AR found the difference.
 *
 * Every test here is one of the four documents a credit note becomes, or one
 * of the rules every other push already follows: once, after the close, by
 * the mapping, and never past a read it could not afford.
 */
async function aCreditNote(input: {
  invoiceId?: string; amount?: string; apply?: boolean; draft?: boolean;
}) {
  return creditNotes.create(owner(), {
    ...(input.invoiceId ? { invoiceId: input.invoiceId } : { customerId }),
    reason: "billing_error",
    lines: [{ name: "Overcharged for the trip", quantity: "1", unitPrice: input.amount ?? "100.00" }],
    draft: input.draft ?? false,
    apply: input.apply ?? false,
  });
}

/** The company's today: a void is dated in the books on the company's day. */
const today = () => companyToday();

run("credit notes into the books", () => {
  it("sends an issued credit note once, with its own lines on the revenue account the ledger debited", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    const note = await aCreditNote({ invoiceId });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    await accounting.sync(owner(), { provider });

    expect(provider.creditNotes).toHaveLength(1);
    const sent = provider.creditNotes[0]!;
    expect(sent.idempotencyKey).toBe(`CN${note.number}`);
    expect(sent.documentNumber).toBe(`CN${note.number}`);
    expect(sent.issuedOn).toBe(note.issuedOn);
    expect(sent.lines).toEqual([expect.objectContaining({
      description: "Overcharged for the trip",
      amount: { amount: "100.0000", currency: "USD" },
      accountExternalId: `qbo-${ledger.ACCOUNTS.REVENUE}`,
    })]);
    expect(sent.tax).toBeNull();
    const links = (await linkRows()).filter((l) => l.kind === "credit_note");
    expect(links).toEqual([expect.objectContaining({ state: "linked", entity_id: note.id, external_id: "credit_note-3" })]);
  });

  it("does not send a draft", async () => {
    await mapEverything();
    await aCreditNote({ draft: true });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creditNotes).toHaveLength(0);
  });

  it("refuses a credit note whose revenue account is not mapped, and names the account", async () => {
    const invoiceId = await anInvoice("400.00");
    await aCreditNote({ invoiceId });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });

    expect(provider.creditNotes).toHaveLength(0);
    const link = (await linkRows()).find((l) => l.kind === "credit_note")!;
    expect(link.state).toBe("failed");
    expect(link.last_error).toMatch(/4000 is not mapped/);
  });

  it("applies it to the invoice as a dated document of its own, after both are over there, once", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    const note = await aCreditNote({ invoiceId, apply: true });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    await accounting.sync(owner(), { provider });

    expect(provider.creates.map((c) => c.kind))
      .toEqual(["customer", "invoice", "credit_note", "credit_note_application"]);
    expect(provider.applications).toHaveLength(1);
    const links = await linkRows();
    const invoiceLink = links.find((l) => l.kind === "invoice")!;
    const noteLink = links.find((l) => l.kind === "credit_note")!;
    expect(provider.applications[0]).toMatchObject({
      creditNoteExternalId: noteLink.external_id,
      invoiceExternalId: invoiceLink.external_id,
      amount: { amount: "100.0000", currency: "USD" },
      appliedOn: note.applications[0]!.appliedOn,
    });
    expect(provider.applications[0]!.idempotencyKey).toBe(accounting.creditApplicationKey(note.applications[0]!.id));
  });

  it("holds an application back until the invoice it settles is in the books", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    await aCreditNote({ invoiceId, apply: true });
    const provider = fakeProvider({
      failKind: "invoice",
      pushFailure: { code: "6000", message: "line item is invalid", retryable: false, duplicate: false },
    });
    await accounting.sync(owner(), { provider });

    expect(provider.creditNotes).toHaveLength(1);
    expect(provider.applications).toHaveLength(0);
  });

  it("sends credit held on the account when it is used, and not before", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    const note = await aCreditNote({ amount: "50.00" });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.applications).toHaveLength(0);

    await creditNotes.apply(owner(), { id: note.id, applications: [{ invoiceId, amount: "50.00" }] });
    await accounting.sync(owner(), { provider });
    expect(provider.applications.map((a) => a.amount.amount)).toEqual(["50.0000"]);
  });

  it("takes a void back as an invoice for the same lines settled against the credit note, never as an edit", async () => {
    await mapEverything();
    await anInvoice("400.00");
    const note = await aCreditNote({ amount: "75.00" });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });

    await creditNotes.voidNote(owner(), { id: note.id, reason: "Raised against the wrong customer" });
    await accounting.sync(owner(), { provider });
    await accounting.sync(owner(), { provider });

    const reversal = provider.invoices.find((i) => i.idempotencyKey === `CNV${note.number}`)!;
    expect(reversal).toBeDefined();
    expect(reversal.documentNumber).toBe(`CNV${note.number}`);
    expect(reversal.issuedOn).toBe(today());
    expect(reversal.lines).toEqual([expect.objectContaining({
      amount: { amount: "75.0000", currency: "USD" },
      accountExternalId: `qbo-${ledger.ACCOUNTS.REVENUE}`,
    })]);

    const links = await linkRows();
    const noteLink = links.find((l) => l.kind === "credit_note")!;
    const voidLink = links.find((l) => l.kind === "credit_note_void")!;
    expect(voidLink).toMatchObject({ state: "linked", entity_id: note.id });
    expect(provider.applications).toEqual([expect.objectContaining({
      creditNoteExternalId: noteLink.external_id,
      invoiceExternalId: voidLink.external_id,
      amount: { amount: "75.0000", currency: "USD" },
      appliedOn: today(),
    })]);
    expect(links.find((l) => l.kind === "credit_note_application")).toMatchObject({
      state: "linked", entity_id: note.id,
    });
    /** Exactly the four documents, once each, however many passes run. */
    expect(provider.creates.map((c) => c.kind).sort()).toEqual(
      ["credit_note", "credit_note_application", "customer", "invoice", "invoice"].sort(),
    );
  });

  it("never sends a credit note voided before it reached the books", async () => {
    await mapEverything();
    const note = await aCreditNote({});
    await creditNotes.voidNote(owner(), { id: note.id, reason: "Typed in error" });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });

    expect(provider.creditNotes).toHaveLength(0);
    expect(provider.invoices).toHaveLength(0);
    expect(provider.applications).toHaveLength(0);
  });

  it("holds a credit note dated inside a closed period back without burning its attempts", async () => {
    await mapEverything();
    await aCreditNote({});
    await accounting.closePeriod(owner(), { periodEnd: today() });
    for (let pass = 0; pass < 6; pass += 1) await accounting.sync(owner(), { provider: fakeProvider() });
    expect((await linkRows()).filter((l) => l.kind === "credit_note")).toHaveLength(0);

    await accounting.reopenPeriod(owner(), { periodEnd: today(), reason: "Closed the wrong month." });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creditNotes).toHaveLength(1);
  });

  it("sends the void of a credit note from a closed quarter into the open period", async () => {
    await mapEverything();
    const note = await aCreditNote({});
    await accounting.sync(owner(), { provider: fakeProvider() });
    await raw`update public.credit_note set issued_on = '2026-01-15' where id = ${note.id}`;
    await creditNotes.voidNote(owner(), { id: note.id, reason: "Raised twice" });
    await accounting.closePeriod(owner(), { periodEnd: "2026-01-31", note: "Q1 filed." });

    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.invoices.map((i) => i.idempotencyKey)).toEqual([`CNV${note.number}`]);
    expect(provider.applications).toHaveLength(1);
  });

  it("finds an application whose answer was lost rather than sending a second one", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    const note = await aCreditNote({ invoiceId, apply: true });
    await accounting.sync(owner(), { provider: fakeProvider({ failKind: "credit_note_application",
      pushFailure: { code: "5020", message: "try again", retryable: true, duplicate: false } }) });

    /** As a process that died between the create and recording it: pending, and old. */
    const key = accounting.creditApplicationKey(note.applications[0]!.id);
    await raw`update public.accounting_entity_link set state = 'pending', updated_at = now() - interval '1 hour'
              where organization_id = ${ORG} and kind = 'credit_note_application'`;
    const existing = new Map<string, ExternalRef>([[`credit_note_application:${key}`, { externalId: "alloc-9", version: null }]]);
    const provider = fakeProvider({ existing });
    const outcome = await accounting.sync(owner(), { provider });

    expect(provider.creates.filter((c) => c.kind === "credit_note_application")).toHaveLength(0);
    expect(provider.lookups).toContainEqual({ kind: "credit_note_application", key });
    expect(outcome.adopted).toBe(1);
    expect((await linkRows()).find((l) => l.kind === "credit_note_application"))
      .toMatchObject({ state: "linked", external_id: "alloc-9" });
  });

  it("does not send an application it could not check for when the reads have run out", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    await aCreditNote({ invoiceId, apply: true });
    await accounting.sync(owner(), { provider: fakeProvider({ failKind: "credit_note_application",
      pushFailure: { code: "5020", message: "try again", retryable: true, duplicate: false } }) });
    await raw`update public.accounting_entity_link set state = 'pending', updated_at = now() - interval '1 hour'
              where organization_id = ${ORG} and kind = 'credit_note_application'`;

    const provider = fakeProvider({ readBudgetExhausted: true });
    const outcome = await accounting.sync(owner(), { provider });
    expect(provider.creates.filter((c) => c.kind === "credit_note_application")).toHaveLength(0);
    expect(outcome.blockedReason).toBe(accounting.READ_BUDGET_EXHAUSTED);
  });

  it("writes off what a credit left owing, not what the credit already took", async () => {
    await mapEverything();
    const invoiceId = await anInvoice("400.00");
    await aCreditNote({ invoiceId, amount: "100.00", apply: true });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    await billing.writeOff(owner(), { id: invoiceId, reason: "Uncollectable" });
    await accounting.sync(owner(), { provider });

    expect(provider.credits.map((c) => c.amount.amount)).toEqual(["300.0000"]);
  });

  it("stops believing a credit note exists once it is deleted over there", async () => {
    await mapEverything();
    await aCreditNote({});
    await accounting.sync(owner(), { provider: fakeProvider() });
    const noteLink = (await linkRows()).find((l) => l.kind === "credit_note")!;

    /** The feed calls it a credit memo, because over there that is what it is. */
    await accounting.sync(owner(), {
      provider: fakeProvider({
        changes: [{ kind: "credit_memo", externalId: noteLink.external_id!, version: "2", deleted: true, changedAt: new Date() }],
      }),
    });
    expect((await linkRows()).find((l) => l.kind === "credit_note")).toMatchObject({ state: "deleted" });
  });
});

run("a credit paid out, into the books", () => {
  it("goes once the credit note is there, out of the bank, on the day it was paid", async () => {
    await mapEverything();
    await accounting.setMapping(owner(), {
      accountCode: ledger.ACCOUNTS.AR, externalId: "qbo-ar", externalName: "Accounts Receivable", externalKind: "Account",
    });
    const note = await aCreditNote({ amount: "60.00" });
    await creditPayouts.payOut(owner(), { id: note.id, method: "check", amount: "45.00", reference: "2210" });
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    await accounting.sync(owner(), { provider });

    expect(provider.creditRefunds).toHaveLength(1);
    const [noteLink] = await raw<{ external_id: string }[]>`
      select external_id from public.accounting_entity_link
      where organization_id = ${ORG} and kind = 'credit_note' and entity_id = ${note.id}`;
    const payout = (await creditNotes.get(owner(), { id: note.id })).payouts[0]!;
    expect(provider.creditRefunds[0]).toEqual({
      idempotencyKey: accounting.creditPayoutKey(payout.id),
      customerExternalId: expect.any(String),
      creditNoteExternalId: noteLink!.external_id,
      paidOn: payout.paidOn,
      amount: { amount: "45.0000", currency: "USD" },
      bankAccountExternalId: `qbo-${ledger.ACCOUNTS.CASH}`,
      receivableAccountExternalId: "qbo-ar",
      memo: `Credit note ${note.number} paid back by cheque 2210`,
    });
    /** After the credit note itself, in the same pass. */
    const order = provider.creates.map((c) => c.kind);
    expect(order.indexOf("credit_note")).toBeLessThan(order.indexOf("credit_note_refund"));
  });

  it("waits for a card payout until the processor says the refund moved", async () => {
    await mapEverything();
    const note = await aCreditNote({ amount: "30.00" });
    const [payout] = await raw<{ id: string }[]>`
      insert into public.credit_note_payout (organization_id, credit_note_id, customer_id, method, status, amount)
      values (${ORG}, ${note.id}, ${customerId}, 'card', 'pending', 30) returning id`;
    const provider = fakeProvider();
    await accounting.sync(owner(), { provider });
    expect(provider.creditRefunds).toHaveLength(0);
    await raw`delete from public.credit_note_payout where id = ${payout!.id}`;
  });
});

run("credit notes, as each book is sent them", () => {
  const qbo = (calls: Call[], reply: (call: Call) => unknown) => createQuickBooksProvider(
    { realmId: "9", baseUrl: "https://qbo.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
    transportFor([(call) => (isTokenUrl(call.url)
      ? tokenOk
      : { status: 200, body: reply(call) })], calls),
  );
  const xero = (calls: Call[], reply: (call: Call) => unknown) => createXeroProvider(
    { tenantId: "t-1", baseUrl: "https://xero.test", tokenUrl: "https://token.test" }, CREDENTIAL, {},
    transportFor([(call) => (isTokenUrl(call.url)
      ? tokenOk
      : { status: 200, body: reply(call) })], calls),
  );

  const note: ExternalCreditNote = {
    idempotencyKey: "CN7",
    customerExternalId: "c-1",
    documentNumber: "CN7",
    issuedOn: "2026-10-01",
    currency: "USD",
    lines: [{
      description: "Overcharged for the trip", quantity: "1",
      unitPrice: { amount: "100.0000", currency: "USD" }, amount: { amount: "100.0000", currency: "USD" },
      accountExternalId: "item-4000", accountExternalKind: "Item",
    }],
    tax: { amount: { amount: "8.2500", currency: "USD" }, accountExternalId: "tax-2200" },
    memo: null,
  };
  const application: ExternalCreditApplication = {
    idempotencyKey: "OA0123456789abcdef",
    customerExternalId: "c-1",
    creditNoteExternalId: "cm-1",
    invoiceExternalId: "inv-1",
    appliedOn: "2026-10-02",
    amount: { amount: "108.2500", currency: "USD" },
  };

  it("goes to QuickBooks as a CreditMemo with the lines and tax an invoice would carry", async () => {
    const calls: Call[] = [];
    const result = await qbo(calls, () => ({ CreditMemo: { Id: "cm-1", SyncToken: "0" } })).pushCreditNote(note);
    expect(result).toMatchObject({ ok: true, externalId: "cm-1" });
    const sent = calls.filter((c) => !isTokenUrl(c.url));
    expect(new URL(sent[0]!.url).pathname).toBe("/v3/company/9/creditmemo");
    const body = JSON.parse(sent[0]!.body!) as Record<string, unknown> & { Line: Record<string, unknown>[] };
    expect(body["DocNumber"]).toBe("CN7");
    expect(body["TxnDate"]).toBe("2026-10-01");
    expect(body.Line).toEqual([
      expect.objectContaining({ Amount: 100, SalesItemLineDetail: expect.objectContaining({ ItemRef: { value: "item-4000" } }) }),
      expect.objectContaining({ Amount: 8.25, Description: "Sales tax" }),
    ]);
  });

  it("applies in QuickBooks through a zero payment linking the invoice and the credit memo", async () => {
    const calls: Call[] = [];
    const result = await qbo(calls, () => ({ Payment: { Id: "p-7", SyncToken: "0" } })).pushCreditApplication(application);
    expect(result).toMatchObject({ ok: true, externalId: "p-7" });
    const sent = calls.filter((c) => !isTokenUrl(c.url));
    expect(new URL(sent[0]!.url).pathname).toBe("/v3/company/9/payment");
    const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>;
    expect(body["TotalAmt"]).toBe(0);
    expect(body["PaymentRefNum"]).toBe(application.idempotencyKey);
    expect(body["DepositToAccountRef"]).toBeUndefined();
    expect(body["Line"]).toEqual([
      { Amount: 108.25, LinkedTxn: [{ TxnId: "inv-1", TxnType: "Invoice" }] },
      { Amount: 108.25, LinkedTxn: [{ TxnId: "cm-1", TxnType: "CreditMemo" }] },
    ]);
  });

  it("finds a lost QuickBooks application by the reference on its zero payment", async () => {
    const calls: Call[] = [];
    const found = await qbo(calls, () => ({ QueryResponse: { Payment: [{ Id: "p-7", SyncToken: "1" }] } }))
      .findCreditApplication(application, []);
    expect(found).toEqual({ ok: true, value: { externalId: "p-7", version: "1" } });
    const query = decodeURIComponent(new URL(calls.at(-1)!.url).searchParams.get("query") ?? "");
    expect(query).toContain(`from Payment where PaymentRefNum = '${application.idempotencyKey}'`);
  });

  it("goes to Xero as an authorised ACCRECCREDIT credit note with tax on its own line", async () => {
    const calls: Call[] = [];
    const result = await xero(calls, () => ({ CreditNotes: [{ CreditNoteID: "xcn-1" }] })).pushCreditNote(note);
    expect(result).toMatchObject({ ok: true, externalId: "xcn-1" });
    const sent = calls.filter((c) => !isTokenUrl(c.url));
    expect(sent[0]!.method).toBe("PUT");
    expect(new URL(sent[0]!.url).pathname).toBe("/CreditNotes");
    const body = (JSON.parse(sent[0]!.body!) as { CreditNotes: Record<string, unknown>[] }).CreditNotes[0]!;
    expect(body).toMatchObject({ Type: "ACCRECCREDIT", Status: "AUTHORISED", CreditNoteNumber: "CN7" });
    expect(body["LineItems"]).toEqual([
      expect.objectContaining({ LineAmount: 100, ItemCode: "item-4000", TaxType: "NONE" }),
      expect.objectContaining({ LineAmount: 8.25, AccountID: "tax-2200" }),
    ]);
    expect(sent[0]!.headers["Idempotency-Key"]).toBe("CN7");
  });

  /** A credit note that gave back tax at two of the company's rates. */
  const twoRates: ExternalCreditNote = {
    ...note,
    tax: {
      amount: { amount: "14.5000", currency: "USD" }, accountExternalId: "tax-2200",
      byRate: [
        { description: "Sales tax, Travis County 8.25%", amount: { amount: "8.2500", currency: "USD" } },
        { description: "Sales tax, State only 6.25%", amount: { amount: "6.2500", currency: "USD" } },
      ],
    },
  };

  it("sends tax at several rates to QuickBooks as one line per rate on the tax account", async () => {
    const calls: Call[] = [];
    await qbo(calls, () => ({ CreditMemo: { Id: "cm-2", SyncToken: "0" } })).pushCreditNote(twoRates);
    const sent = calls.filter((c) => new URL(c.url).host !== "token.test");
    const body = JSON.parse(sent[0]!.body!) as { Line: Record<string, unknown>[] };
    expect(body.Line.slice(1)).toEqual([
      expect.objectContaining({ Amount: 8.25, Description: "Sales tax, Travis County 8.25%", SalesItemLineDetail: { ItemRef: { value: "tax-2200" }, Qty: 1 } }),
      expect.objectContaining({ Amount: 6.25, Description: "Sales tax, State only 6.25%", SalesItemLineDetail: { ItemRef: { value: "tax-2200" }, Qty: 1 } }),
    ]);
  });

  it("sends tax at several rates to Xero as one line per rate, none of it worked out by Xero", async () => {
    const calls: Call[] = [];
    await xero(calls, () => ({ CreditNotes: [{ CreditNoteID: "xcn-2" }] })).pushCreditNote(twoRates);
    const sent = calls.filter((c) => new URL(c.url).host !== "token.test");
    const body = (JSON.parse(sent[0]!.body!) as { CreditNotes: Record<string, unknown>[] }).CreditNotes[0]!;
    expect((body["LineItems"] as unknown[]).slice(1)).toEqual([
      expect.objectContaining({ LineAmount: 8.25, AccountID: "tax-2200", TaxType: "NONE", Description: "Sales tax, Travis County 8.25%" }),
      expect.objectContaining({ LineAmount: 6.25, AccountID: "tax-2200", TaxType: "NONE", Description: "Sales tax, State only 6.25%" }),
    ]);
  });

  const paidBack: ExternalCreditNoteRefund = {
    idempotencyKey: "OP0123456789abcdef",
    customerExternalId: "c-1",
    creditNoteExternalId: "cm-1",
    paidOn: "2026-10-03",
    amount: { amount: "54.1300", currency: "USD" },
    bankAccountExternalId: "bank-1000",
    receivableAccountExternalId: "ar-1200",
    memo: "Credit note 7 paid back to the customer's card",
  };

  it("pays a credit out in QuickBooks as a cheque from the bank to the customer's receivable", async () => {
    const calls: Call[] = [];
    const result = await qbo(calls, () => ({ Purchase: { Id: "pu-3", SyncToken: "0" } })).pushCreditNoteRefund!(paidBack);
    expect(result).toMatchObject({ ok: true, externalId: "pu-3" });
    const sent = calls.filter((c) => new URL(c.url).host !== "token.test");
    expect(new URL(sent[0]!.url).pathname).toBe("/v3/company/9/purchase");
    const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      DocNumber: paidBack.idempotencyKey, TxnDate: "2026-10-03", PaymentType: "Check",
      AccountRef: { value: "bank-1000" }, EntityRef: { value: "c-1", type: "Customer" },
    });
    expect(body["Line"]).toEqual([expect.objectContaining({
      Amount: 54.13,
      AccountBasedExpenseLineDetail: { AccountRef: { value: "ar-1200" }, CustomerRef: { value: "c-1" } },
    })]);
    const refused = await qbo([], () => ({})).pushCreditNoteRefund!({ ...paidBack, receivableAccountExternalId: null });
    expect(refused).toMatchObject({ ok: false, code: "unmapped" });
  });

  it("pays a credit out in Xero as a payment against the credit note, found again by its reference", async () => {
    const calls: Call[] = [];
    const result = await xero(calls, () => ({ Payments: [{ PaymentID: "xp-9" }] })).pushCreditNoteRefund!(paidBack);
    expect(result).toMatchObject({ ok: true, externalId: "xp-9" });
    const sent = calls.filter((c) => new URL(c.url).host !== "token.test");
    expect(sent[0]!.method).toBe("PUT");
    expect(new URL(sent[0]!.url).pathname).toBe("/Payments");
    expect(JSON.parse(sent[0]!.body!)).toEqual({
      Payments: [{
        CreditNote: { CreditNoteID: "cm-1" }, Account: { AccountID: "bank-1000" },
        Date: "2026-10-03", Amount: 54.13, Reference: paidBack.idempotencyKey,
      }],
    });
    expect(sent[0]!.headers["Idempotency-Key"]).toBe(paidBack.idempotencyKey);

    const lookups: Call[] = [];
    await xero(lookups, () => ({ Payments: [{ PaymentID: "xp-9" }] })).findPushed("credit_note_refund", paidBack.idempotencyKey);
    const where = decodeURIComponent(new URL(lookups.at(-1)!.url).searchParams.get("where") ?? "");
    expect(new URL(lookups.at(-1)!.url).pathname).toBe("/Payments");
    expect(where).toContain(paidBack.idempotencyKey);
  });

  it("applies in Xero as an Allocation on the credit note", async () => {
    const calls: Call[] = [];
    const result = await xero(calls, () => ({ Allocations: [{ AllocationID: "al-1", Amount: 108.25 }] }))
      .pushCreditApplication(application);
    expect(result).toMatchObject({ ok: true, externalId: "al-1" });
    const sent = calls.filter((c) => !isTokenUrl(c.url));
    expect(sent[0]!.method).toBe("PUT");
    expect(new URL(sent[0]!.url).pathname).toBe("/CreditNotes/cm-1/Allocations");
    expect(JSON.parse(sent[0]!.body!)).toEqual({
      Allocations: [{ Invoice: { InvoiceID: "inv-1" }, Amount: 108.25, Date: "2026-10-02" }],
    });
  });

  it("finds a lost Xero allocation by invoice, amount and date, and not one already claimed", async () => {
    const reply = () => ({
      CreditNotes: [{
        CreditNoteID: "cm-1",
        Allocations: [
          { AllocationID: "al-1", Amount: 108.25, Date: "/Date(1790899200000+0000)/", Invoice: { InvoiceID: "inv-1" } },
          { AllocationID: "al-2", Amount: 108.25, Date: "/Date(1790899200000+0000)/", Invoice: { InvoiceID: "inv-1" } },
          { AllocationID: "al-3", Amount: 50, Date: "/Date(1790899200000+0000)/", Invoice: { InvoiceID: "inv-1" } },
        ],
      }],
    });
    const found = await xero([], reply).findCreditApplication(application, ["al-1"]);
    expect(found).toEqual({ ok: true, value: { externalId: "al-2", version: null } });

    const none = await xero([], reply).findCreditApplication(application, ["al-1", "al-2"]);
    expect(none).toEqual({ ok: true, value: null });
  });

  it("refuses to answer for a Xero allocation by key, rather than saying it is not there", async () => {
    const found = await xero([], () => ({})).findPushed("credit_note_application", "OA1");
    expect(found.ok).toBe(false);
  });
});
