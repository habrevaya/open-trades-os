import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, ledger, type Actor } from "@opentradesos/core";
import * as accounting from "../src/services/accounting";
import * as billing from "../src/services/billing";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import {
  AccountingNotConfiguredError, createProvider, registeredProviders,
  type AccountingEntityKind, type AccountingProvider, type ChangeSet,
  type ExternalAccount, type ExternalChange, type ExternalRef,
  type HttpResponse, type PushResult, type ReadResult,
} from "../src/accounting/provider";
import {
  AmountNotRepresentableError, createQuickBooksProvider, toProviderAmount,
} from "../src/accounting/quickbooks";
import "../src/accounting";
import { seedOrg, testDb, fixtureId } from "./helpers";

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
  options: FakeOptions;
}

function fakeProvider(options: FakeOptions = {}): Fake {
  const creates: { kind: AccountingEntityKind; key: string }[] = [];
  const lookups: { kind: AccountingEntityKind; key: string }[] = [];
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
    async pushInvoice(i) { return push("invoice", i.idempotencyKey); },
    async pushPayment(p) { return push("payment", p.idempotencyKey); },
    async pushCredit(c) { return push("credit_memo", c.idempotencyKey); },
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
