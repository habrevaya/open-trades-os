import {
  registerProvider,
  type AccountingEntityKind, type AccountingProvider, type ChangeSet,
  type ExternalAccount, type ExternalChange, type ExternalCredit, type ExternalRefund,
  type ExternalCustomer, type ExternalInvoice, type ExternalMoney,
  type ExternalPayment, type ExternalRef, type HttpTransport,
  type ProviderHooks, type PushResult, type ReadResult,
} from "./provider";

/**
 * QUICKBOOKS ONLINE
 *
 * The first adapter, over `fetch`, no SDK. Same reasoning as the Twilio
 * adapter: the SDK is a large dependency for six endpoints, and a self hoster
 * auditing what leaves their network should be able to read this file.
 *
 * Nothing else in the codebase imports it. It registers itself, and a
 * deployment that uses Xero never loads it.
 *
 * THE ONE CONSTRAINT THAT SHAPED EVERY CHOICE BELOW
 *
 * Intuit's 2026 metering charges for READS and refuses the overage with a
 * 429 instead of billing for it. You cannot buy your way past the ceiling,
 * you can only wait for the window to roll.
 *
 * That makes three things true here that are not true of an ordinary REST
 * adapter:
 *
 *   1. Inbound goes through `/cdc`, the change data capture endpoint, which
 *      returns only what moved since an instant. A `/query` sweep over
 *      invoices modified this week returns the same hundreds of rows on every
 *      pass and is the thing that exhausts the budget.
 *
 *   2. A 429 ON A READ IS NOT AN ERROR. It is reported as
 *      `budgetExhausted`, the caller records it on `sync_run.blocked_reason`,
 *      the cursor is NOT advanced, and the next pass resumes from exactly
 *      where this one stopped. If this were thrown instead, the worker would
 *      catch it at the top of the pass, the outbound half of the sync would
 *      never run, and a company would stop pushing invoices to its books
 *      because it read too many.
 *
 *   3. A 429 ON A WRITE is ordinary throttling, because writes are not what
 *      is metered. It is retryable and it is NOT budget exhaustion, and
 *      conflating the two would put "wait for the quota window" on a screen
 *      when the truth is "try again in a second".
 */

interface QuickBooksSettings {
  /** The company id. Every API path contains it. */
  realmId: string;
  /** Sandbox or production. Overridable so a test never reaches Intuit. */
  baseUrl?: string;
  tokenUrl?: string;
  /**
   * Intuit pins response shapes to a minor version. Pinning it means a
   * field being added or removed on their side does not change what we parse
   * without anybody choosing that.
   */
  minorVersion?: string;
}

/**
 * The credential, as ONE opaque string in the secret store.
 *
 * All three fields together, rather than the client id and secret in
 * `integration_connection.settings` beside the token reference. The client
 * secret is a secret; `settings` is an ordinary jsonb column that turns up in
 * a database backup, in a support engineer's query and in any export of the
 * connection row. `credentialRef` exists precisely so that none of the secret
 * material is in the database, and splitting the credential would put two
 * thirds of it back.
 */
interface QuickBooksCredential {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

const DEFAULT_BASE = "https://quickbooks.api.intuit.com";
const DEFAULT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const DEFAULT_MINOR_VERSION = "75";

/**
 * How far back a first sync reaches.
 *
 * Intuit refuses a `changedSince` older than thirty days on `/cdc`. Asking
 * for twenty nine leaves room for clock skew between us and them, because the
 * failure mode of being one minute over is a 400 on every single pass and a
 * connection that never syncs at all.
 *
 * What this means, said plainly rather than left for somebody to discover:
 * connecting QuickBooks does NOT import history. It picks up changes from
 * here. Backfilling history is a different job with a different budget and it
 * does not belong on a five minute worker tick.
 */
const FIRST_SYNC_WINDOW_DAYS = 29;

/** The entities the bridge moves, in the order `/cdc` wants them. */
const CDC_ENTITIES = ["Customer", "Invoice", "Payment", "CreditMemo"] as const;

const KIND_BY_ENTITY: Record<string, AccountingEntityKind> = {
  Customer: "customer",
  Invoice: "invoice",
  Payment: "payment",
  CreditMemo: "credit_memo",
};

/** Where the deterministic key lives on each kind, and it has to be a field
 *  QuickBooks can be queried on. A private note cannot be searched. */
const KEY_FIELD: Record<AccountingEntityKind, { entity: string; field: string }> = {
  customer: { entity: "Customer", field: "DisplayName" },
  invoice: { entity: "Invoice", field: "DocNumber" },
  payment: { entity: "Payment", field: "PaymentRefNum" },
  credit_memo: { entity: "CreditMemo", field: "DocNumber" },
  refund: { entity: "Purchase", field: "DocNumber" },
};

/**
 * Intuit fault codes that mean "you already have one of these".
 *
 * A set of codes AND a message check, because the codes are not documented
 * exhaustively and a duplicate that is not recognised as one is the worst
 * outcome available here: the service gives up on linking, the next pass
 * tries to create it again, and the customer's books collect one copy per
 * pass. Over-matching costs a single wasted lookup; under-matching costs
 * duplicates forever.
 */
const DUPLICATE_CODES = new Set(["6240", "6140", "6000"]);

/** Faults worth another attempt. Everything else is a decision Intuit made
 *  about this document, and retrying it is how a queue fills with garbage. */
const RETRYABLE_CODES = new Set([
  "3200", // token expired mid-flight, which the refresh below fixes
  "5020", // Intuit's own "operation could not be completed at this time"
  "6210", // stale object, resolved by re-reading the sync token
]);

export class AmountNotRepresentableError extends Error {
  constructor(value: string) {
    super(
      `"${value}" cannot be sent to QuickBooks without losing precision. `
      + "Amounts are numeric(14,4) here and QuickBooks holds two decimal places.",
    );
    this.name = "AmountNotRepresentableError";
  }
}

/**
 * A decimal string as a JSON number, or a refusal.
 *
 * Money is a string everywhere in this codebase because floats lose cents.
 * JSON has only doubles, so the boundary is here, and the rule at the
 * boundary is that NOTHING IS SILENTLY ROUNDED.
 *
 * Our column is numeric(14,4) and QuickBooks holds two decimal places. An
 * amount with a non-zero third or fourth decimal is refused rather than
 * truncated. Truncating it would mean the invoice in the books and the
 * invoice in the ledger differ by a fraction of a cent per line, which
 * reconciles to nothing and is found by an accountant, not by us.
 *
 * The round trip is asserted rather than assumed. Every two decimal value a
 * trades company will ever invoice survives a double exactly, but "will
 * ever" is a claim, and a claim the code does not check is a defect.
 */
export function toProviderAmount(value: string): number {
  const match = /^(-?)(\d{1,13})(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) throw new AmountNotRepresentableError(value);

  const fraction = (match[3] ?? "").padEnd(4, "0");
  if (fraction.slice(2) !== "00") throw new AmountNotRepresentableError(value);

  const canonical = `${match[1]}${match[2]}.${fraction.slice(0, 2)}`;
  const parsed = Number(canonical);
  if (!Number.isFinite(parsed) || parsed.toFixed(2) !== canonical) {
    throw new AmountNotRepresentableError(value);
  }
  return parsed;
}

const amountOf = (money: ExternalMoney): number => toProviderAmount(money.amount);

/**
 * A value inside a QuickBooks query string.
 *
 * The keys we look up are generated by this codebase, so this is not
 * defending against a hostile caller. It is defending against an apostrophe
 * in a company name, which is common, and which without this produces a query
 * Intuit rejects with a parse error that reads like an outage.
 */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

interface Fault { code: string; message: string }

function faultOf(payload: Record<string, unknown>): Fault | null {
  const fault = payload["Fault"] as { Error?: { code?: string; Message?: string; Detail?: string }[] } | undefined;
  const first = fault?.Error?.[0];
  if (!first) return null;
  return {
    code: String(first.code ?? ""),
    // Detail is the sentence a person can act on; Message is a category.
    message: String(first.Detail ?? first.Message ?? "QuickBooks rejected the request"),
  };
}

const isDuplicate = (fault: Fault): boolean =>
  DUPLICATE_CODES.has(fault.code) || /duplicate/i.test(fault.message);

function retryAfterOf(response: { headers: { get(name: string): string | null } }): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function createQuickBooksProvider(
  settings: Record<string, unknown>,
  secret: string,
  hooks: ProviderHooks = {},
  transport: HttpTransport = globalThis.fetch as unknown as HttpTransport,
): AccountingProvider {
  const config = settings as unknown as QuickBooksSettings;
  const base = config.baseUrl ?? DEFAULT_BASE;
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const minorVersion = config.minorVersion ?? DEFAULT_MINOR_VERSION;

  const credential = parseCredential(secret);

  /**
   * The access token, in memory only.
   *
   * Never written to the database and never returned from any method on this
   * object. The only thing that persists across a restart is the refresh
   * token in the secret store, which is the one value a leak would actually
   * cost something.
   */
  let access: { token: string; expiresAt: number } | null = null;

  async function refresh(): Promise<void> {
    const response = await transport(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.clientId}:${credential.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }).toString(),
    });

    const body = await response.text();
    if (response.status < 200 || response.status >= 300) {
      /**
       * The body is NOT included in the error.
       *
       * Intuit echoes request parameters in some token failures, and the
       * request parameter here is the refresh token. An error message is the
       * single most widely copied string in any system: it goes into logs, it
       * goes into a support ticket, it goes into a screenshot in a chat. A
       * status code says as much as is safe to say.
       */
      throw new Error(`QuickBooks refused the token refresh with HTTP ${response.status}`);
    }

    const payload = JSON.parse(body) as {
      access_token?: string; expires_in?: number; refresh_token?: string;
    };
    if (!payload.access_token) throw new Error("QuickBooks returned no access token");

    access = {
      token: payload.access_token,
      /**
       * Sixty seconds early. A token that expires between the check and the
       * request produces a 401 on a write that has already been counted, and
       * the retry then has to decide whether the write happened.
       */
      expiresAt: Date.now() + Math.max(0, (payload.expires_in ?? 3600) - 60) * 1000,
    };

    /**
     * ROTATION. Intuit issues a new refresh token on most refreshes and
     * retires the old one. Dropping it here is the bug that kills the
     * connection days later, in the middle of a night, with no error anybody
     * saw at the time.
     */
    if (payload.refresh_token && payload.refresh_token !== credential.refreshToken) {
      credential.refreshToken = payload.refresh_token;
      await hooks.onCredentialRotated?.(JSON.stringify(credential));
    }
  }

  async function token(): Promise<string> {
    if (!access || access.expiresAt <= Date.now()) await refresh();
    return access!.token;
  }

  interface Call {
    path: string;
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    /** Reads are the metered half. The flag is what makes a 429 mean two
     *  different things in the two branches below. */
    metered: boolean;
  }

  type Raw =
    | { ok: true; payload: Record<string, unknown> }
    | {
      ok: false; code: string; message: string;
      retryable: boolean; budgetExhausted: boolean; retryAfterSeconds: number | null;
    };

  async function call(request: Call, allowRetry = true): Promise<Raw> {
    const separator = request.path.includes("?") ? "&" : "?";
    const url = `${base}/v3/company/${config.realmId}${request.path}${separator}minorversion=${minorVersion}`;

    const response = await transport(url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: "application/json",
        ...(request.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });

    if (response.status === 401 && allowRetry) {
      // The token went stale mid-flight. One refresh, one retry, and if it
      // fails again the credential is genuinely wrong and says so.
      access = null;
      return call(request, false);
    }

    if (response.status === 429) {
      return {
        ok: false,
        code: "429",
        message: request.metered
          ? "QuickBooks has refused further reads until the metering window rolls."
          : "QuickBooks throttled this request.",
        retryable: true,
        /**
         * THE WHOLE POINT OF THE `metered` FLAG.
         *
         * Intuit meters reads and refuses the overage; writes are throttled
         * but not metered. Reporting a throttled write as an exhausted read
         * budget would tell an operator to wait for a quota window that is
         * not the problem, and would stop the sync advancing its cursor for
         * a reason that has nothing to do with reading.
         */
        budgetExhausted: request.metered,
        retryAfterSeconds: retryAfterOf(response),
      };
    }

    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }

    const fault = faultOf(payload);
    if (fault) {
      return {
        ok: false,
        code: fault.code,
        message: fault.message,
        retryable: RETRYABLE_CODES.has(fault.code) || response.status >= 500,
        budgetExhausted: false,
        retryAfterSeconds: null,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        code: String(response.status),
        message: `QuickBooks returned HTTP ${response.status}`,
        // A 5xx is Intuit's problem, not the document's.
        retryable: response.status >= 500,
        budgetExhausted: false,
        retryAfterSeconds: null,
      };
    }

    return { ok: true, payload };
  }

  /** A create, and the shape every one of the four pushes shares. */
  async function create(entity: string, body: Record<string, unknown>): Promise<PushResult> {
    const result = await call({ path: `/${entity.toLowerCase()}`, method: "POST", body, metered: false });

    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        retryable: result.retryable,
        duplicate: isDuplicate({ code: result.code, message: result.message }),
      };
    }

    const created = result.payload[entity] as { Id?: string; SyncToken?: string } | undefined;
    if (!created?.Id) {
      return {
        ok: false,
        code: "no_id",
        message: `QuickBooks accepted the ${entity} and returned no id`,
        // Retrying would create a second document, because the first one
        // exists. The service resolves this through findPushed instead.
        retryable: false,
        duplicate: true,
      };
    }

    return {
      ok: true,
      externalId: created.Id,
      version: created.SyncToken ?? null,
      adopted: false,
    };
  }

  function readFailure<T>(result: Extract<Raw, { ok: false }>): ReadResult<T> {
    return {
      ok: false,
      code: result.code,
      message: result.message,
      retryable: result.retryable,
      budgetExhausted: result.budgetExhausted,
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }

  return {
    name: "quickbooks",

    async pushCustomer(customer: ExternalCustomer): Promise<PushResult> {
      return create("Customer", {
        /**
         * DisplayName is unique in QuickBooks and is what the key is written
         * into, so `findPushed` can find it again. It is also what a
         * bookkeeper sees, which is why the key for a customer is the
         * customer's own name rather than an opaque token.
         */
        DisplayName: customer.idempotencyKey,
        ...(customer.email ? { PrimaryEmailAddr: { Address: customer.email } } : {}),
        ...(customer.phone ? { PrimaryPhone: { FreeFormNumber: customer.phone } } : {}),
      });
    },

    async pushInvoice(invoice: ExternalInvoice): Promise<PushResult> {
      const lines = invoice.lines.map((line) => ({
        Amount: amountOf(line.amount),
        DetailType: "SalesItemLineDetail",
        Description: line.description,
        SalesItemLineDetail: {
          /**
           * A QuickBooks invoice line references an Item, and the Item
           * carries the income account behind it. That is why the mapping
           * stores an opaque id plus the kind of object it names: our "4000"
           * maps to whatever the operator picked, and this adapter is the
           * only code that knows the picked thing goes in `ItemRef`.
           */
          ItemRef: { value: line.accountExternalId },
          Qty: Number(line.quantity),
          UnitPrice: amountOf(line.unitPrice),
        },
      }));

      /**
       * Tax as one line against the mapped liability account, rather than
       * QuickBooks' own automated sales tax.
       *
       * Their engine would recompute the tax from the customer's address and
       * its own rate tables, and where it disagrees with the rate frozen on
       * `invoice_line.tax_rate` the books and the document we actually sent
       * the customer would differ. The invoice the customer holds is the
       * authority; see rule 3 at the top of schema/billing.ts.
       */
      const taxLine = invoice.tax
        ? [{
          Amount: amountOf(invoice.tax.amount),
          DetailType: "SalesItemLineDetail",
          Description: "Sales tax",
          SalesItemLineDetail: { ItemRef: { value: invoice.tax.accountExternalId }, Qty: 1 },
        }]
        : [];

      return create("Invoice", {
        DocNumber: invoice.idempotencyKey,
        CustomerRef: { value: invoice.customerExternalId },
        TxnDate: invoice.issuedOn,
        ...(invoice.dueOn ? { DueDate: invoice.dueOn } : {}),
        CurrencyRef: { value: invoice.currency },
        Line: [...lines, ...taxLine],
        ...(invoice.memo ? { CustomerMemo: { value: invoice.memo } } : {}),
      });
    },

    async pushPayment(payment: ExternalPayment): Promise<PushResult> {
      return create("Payment", {
        PaymentRefNum: payment.idempotencyKey,
        CustomerRef: { value: payment.customerExternalId },
        TxnDate: payment.receivedOn,
        TotalAmt: amountOf(payment.amount),
        DepositToAccountRef: { value: payment.depositAccountExternalId },
        Line: payment.allocations.map((allocation) => ({
          Amount: amountOf(allocation.amount),
          LinkedTxn: [{ TxnId: allocation.invoiceExternalId, TxnType: "Invoice" }],
        })),
      });
    },

    async pushCredit(credit: ExternalCredit): Promise<PushResult> {
      return create("CreditMemo", {
        DocNumber: credit.idempotencyKey,
        CustomerRef: { value: credit.customerExternalId },
        TxnDate: credit.issuedOn,
        Line: [{
          Amount: amountOf(credit.amount),
          DetailType: "SalesItemLineDetail",
          Description: credit.reason,
          SalesItemLineDetail: { ItemRef: { value: credit.accountExternalId }, Qty: 1 },
        }],
      });
    },

    /**
     * AN EXPENSE FROM THE BANK, CATEGORISED TO ACCOUNTS RECEIVABLE.
     *
     * Intuit's own instructions for refunding a paid invoice are three
     * documents: a credit memo, an expense categorised to Accounts
     * Receivable, and a receive-payment linking the two ("Refund your
     * customer for a paid invoice", QuickBooks Online help). The credit memo
     * is the decision that the customer no longer owes the money, and in
     * this product that decision is a void or a write-off of the reopened
     * invoice, which already reaches the books as a credit memo of its own.
     * What a refund is here is the middle document: cash out of the bank,
     * the customer's receivable back up. That is exactly the `refund`
     * posting in our ledger, held money included, because QuickBooks keeps a
     * payment's unapplied remainder as a credit in the same receivable.
     *
     * Not a RefundReceipt. A RefundReceipt is a negative sale: its lines are
     * items and it takes the money out of income. Sending one would reduce
     * revenue for a refund our ledger books against the receivable, and
     * reduce it a second time when the reopened invoice is written off.
     */
    async pushRefund(refund: ExternalRefund): Promise<PushResult> {
      if (!refund.receivableAccountExternalId) {
        return {
          ok: false,
          code: "unmapped",
          message: "Map the accounts receivable account to QuickBooks' Accounts Receivable before refunds can be sent: "
            + "a refund puts the money back on what the customer owes.",
          retryable: false,
          duplicate: false,
        };
      }
      return create("Purchase", {
        DocNumber: refund.idempotencyKey,
        TxnDate: refund.refundedOn,
        PaymentType: "Check",
        AccountRef: { value: refund.bankAccountExternalId },
        EntityRef: { value: refund.customerExternalId, type: "Customer" },
        CurrencyRef: { value: refund.amount.currency },
        PrivateNote: refund.memo,
        Line: [{
          Amount: amountOf(refund.amount),
          DetailType: "AccountBasedExpenseLineDetail",
          Description: refund.memo,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: refund.receivableAccountExternalId },
            CustomerRef: { value: refund.customerExternalId },
          },
        }],
      });
    },

    heldMoneyReachesBooks: true,

    async findPushed(
      kind: AccountingEntityKind, idempotencyKey: string,
    ): Promise<ReadResult<ExternalRef | null>> {
      const target = KEY_FIELD[kind];
      const query = `select Id, SyncToken from ${target.entity} where ${target.field} = ${quote(idempotencyKey)}`;
      const result = await call({
        path: `/query?query=${encodeURIComponent(query)}`,
        method: "GET",
        metered: true,
      });
      if (!result.ok) return readFailure(result);

      const response = result.payload["QueryResponse"] as Record<string, unknown> | undefined;
      const rows = (response?.[target.entity] ?? []) as { Id?: string; SyncToken?: string }[];
      const first = rows[0];
      if (!first?.Id) return { ok: true, value: null };
      return { ok: true, value: { externalId: first.Id, version: first.SyncToken ?? null } };
    },

    async changes(cursor: string | null): Promise<ReadResult<ChangeSet>> {
      /**
       * A first sync reaches back a bounded window, not to the beginning of
       * the company. Intuit refuses a `changedSince` over thirty days old,
       * and asking for everything would be the most expensive possible first
       * request against a budget measured in reads.
       */
      const since = cursor ?? new Date(Date.now() - FIRST_SYNC_WINDOW_DAYS * 86_400_000).toISOString();

      const result = await call({
        path: `/cdc?entities=${CDC_ENTITIES.join(",")}&changedSince=${encodeURIComponent(since)}`,
        method: "GET",
        metered: true,
      });
      if (!result.ok) return readFailure(result);

      const changes: ExternalChange[] = [];
      let sawFullPage = false;

      const responses = (result.payload["CDCResponse"] ?? []) as { QueryResponse?: Record<string, unknown>[] }[];
      for (const entry of responses) {
        for (const group of entry.QueryResponse ?? []) {
          for (const entity of CDC_ENTITIES) {
            const rows = group[entity] as {
              Id?: string; SyncToken?: string; status?: string;
              MetaData?: { LastUpdatedTime?: string };
            }[] | undefined;
            if (!rows) continue;
            /**
             * QuickBooks caps `/cdc` at a thousand objects and does not say
             * when it truncated. A full page is the only signal available, so
             * it is reported as `more` and the next pass runs immediately
             * rather than waiting for the tick. Treating a full page as the
             * end would silently drop everything past the thousandth change.
             */
            if (rows.length >= 1000) sawFullPage = true;
            for (const row of rows) {
              if (!row.Id) continue;
              changes.push({
                kind: KIND_BY_ENTITY[entity]!,
                externalId: row.Id,
                version: row.SyncToken ?? null,
                deleted: row.status === "Deleted",
                changedAt: row.MetaData?.LastUpdatedTime
                  ? new Date(row.MetaData.LastUpdatedTime)
                  : new Date(),
              });
            }
          }
        }
      }

      /**
       * The cursor comes from Intuit's own `time`, not from the newest change
       * we saw. A document written while this request was in flight carries a
       * timestamp inside the page we just read, and a cursor derived from the
       * data would step past it and lose it permanently.
       */
      const nextCursor = typeof result.payload["time"] === "string"
        ? result.payload["time"] as string
        : since;

      return { ok: true, value: { cursor: nextCursor, changes, more: sawFullPage } };
    },

    async accounts(): Promise<ReadResult<ExternalAccount[]>> {
      /**
       * Accounts AND Items, in two reads, because an invoice line references
       * an Item and a payment references an Account. Offering only one of
       * them would make half the mapping screen impossible to fill in.
       *
       * This is the only place in the adapter that deliberately spends two
       * metered reads, and it runs when a person opens the mapping screen,
       * never on a worker tick.
       */
      const accountsResult = await call({
        path: `/query?query=${encodeURIComponent("select * from Account maxresults 1000")}`,
        method: "GET",
        metered: true,
      });
      if (!accountsResult.ok) return readFailure(accountsResult);

      const itemsResult = await call({
        path: `/query?query=${encodeURIComponent("select * from Item maxresults 1000")}`,
        method: "GET",
        metered: true,
      });
      if (!itemsResult.ok) return readFailure(itemsResult);

      const accountRows = ((accountsResult.payload["QueryResponse"] as Record<string, unknown> | undefined)?.
        ["Account"] ?? []) as {
          Id?: string; Name?: string; AcctNum?: string; Active?: boolean; Classification?: string;
        }[];
      const itemRows = ((itemsResult.payload["QueryResponse"] as Record<string, unknown> | undefined)?.
        ["Item"] ?? []) as { Id?: string; Name?: string; Active?: boolean }[];

      const accounts: ExternalAccount[] = [];
      for (const row of accountRows) {
        if (!row.Id) continue;
        accounts.push({
          externalId: row.Id,
          name: row.Name ?? row.Id,
          kind: "Account",
          classification: classify(row.Classification),
          number: row.AcctNum ?? null,
          active: row.Active !== false,
        });
      }
      for (const row of itemRows) {
        if (!row.Id) continue;
        accounts.push({
          externalId: row.Id,
          name: row.Name ?? row.Id,
          kind: "Item",
          /**
           * An Item is what revenue lands through, so it is offered as
           * income. Reading its own income account would be one more metered
           * read per item, and the operator picking from this list already
           * knows what their items are.
           */
          classification: "income",
          number: null,
          active: row.Active !== false,
        });
      }
      return { ok: true, value: accounts };
    },
  };
}

function classify(value: string | undefined): ExternalAccount["classification"] {
  switch (value) {
    case "Revenue": return "income";
    case "Expense": return "expense";
    case "Asset": return "asset";
    case "Liability": return "liability";
    case "Equity": return "equity";
    default: return "other";
  }
}

/**
 * The credential, parsed strictly.
 *
 * A vague parse here fails at the token endpoint with an opaque 400 hours
 * after somebody set the connection up. Naming the missing field at
 * construction is the difference between a five minute fix and an afternoon.
 */
export function parseCredential(secret: string): QuickBooksCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error(
      "The QuickBooks credential must be a JSON document with refreshToken, clientId and clientSecret",
    );
  }
  const value = parsed as Partial<QuickBooksCredential>;
  for (const field of ["refreshToken", "clientId", "clientSecret"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`The QuickBooks credential is missing "${field}"`);
    }
  }
  return {
    refreshToken: value.refreshToken!,
    clientId: value.clientId!,
    clientSecret: value.clientSecret!,
  };
}

registerProvider("quickbooks", (settings, secret, hooks) =>
  createQuickBooksProvider(settings, secret, hooks));
