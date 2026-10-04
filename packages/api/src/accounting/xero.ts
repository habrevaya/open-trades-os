import {
  registerProvider,
  type AccountingEntityKind, type AccountingProvider, type ChangeSet,
  type ExternalAccount, type ExternalChange, type ExternalCredit, type ExternalRefund,
  type ExternalCreditApplication, type ExternalCreditNote, type ExternalCreditNoteRefund, type ExternalCustomer, type ExternalInvoice, type ExternalMoney,
  type ExternalJournal, type ExternalPayment, type ExternalRef, type HttpTransport,
  type ProviderHooks, type PushResult, type ReadResult,
} from "./provider";

/**
 * XERO
 *
 * The second adapter on this seam, and the one the seam was written in
 * anticipation of: `provider.ts` names Xero four times, including a claim
 * about its refresh tokens and a claim about its change feed. Writing it is
 * the only way to find out whether those predictions were right.
 *
 * TWO WERE RIGHT AND ONE WAS WRONG, and the wrong one is worth stating here
 * because the seam's comment has been corrected rather than left standing.
 *
 *   RIGHT: refresh tokens rotate on every single exchange with no grace
 *   period. Xero invalidates the previous access AND refresh token the moment
 *   one is used. `onCredentialRotated` is therefore not an optimisation here
 *   the way it nearly is for QuickBooks: dropping the new refresh token kills
 *   the connection on the very next call, not days later.
 *
 *   RIGHT: the money boundary needs a precision rule. Xero is better than
 *   QuickBooks on exactly one axis, `unitdp=4`, which lets a unit price carry
 *   four decimals and matches `numeric(14,4)`. Line amounts are still two.
 *
 *   WRONG: XERO HAS NO CHANGE FEED. It has `If-Modified-Since`, which is a
 *   timestamp window and nothing else: no cursor, no server-issued token, no
 *   `/cdc` equivalent. The seam's comment said both providers expose a cursor
 *   and offered that as the reason `changes()` takes one. The method survives
 *   unchanged because an opaque string is a cursor OR a timestamp from the
 *   service's point of view, which is the property that actually mattered,
 *   but the stated reason was false and has been fixed in place.
 *
 * WHAT A TIMESTAMP WINDOW COSTS, since it is now the thing this adapter has
 * to be correct about rather than a detail: a document written DURING the
 * request carries a timestamp inside the window just read. A cursor built
 * from the newest `UpdatedDateUTC` in the page steps over it and loses it
 * forever. So the next window starts at the instant BEFORE the request went
 * out, taken from Xero's own `Date` response header where they send one. That
 * re-reads a few records across the boundary, which costs a comparison the
 * service already does, and it cannot lose one.
 *
 * NO SDK, over `fetch`, same reasoning as every other adapter in this tree.
 * Nothing else in the codebase imports this file; it registers itself, and a
 * deployment running QuickBooks never loads it.
 *
 * THE METERING STORY IS DIFFERENT FROM INTUIT'S AND THE SEAM SURVIVES IT.
 *
 * Xero does not charge for reads. It rate limits everything: 5 concurrent, 60
 * a minute, 5,000 a day per tenant, 10,000 a minute across the whole app. A
 * 429 therefore means one of four different things, and Xero says which in
 * `X-Rate-Limit-Problem`. That maps onto `budgetExhausted` more precisely
 * than QuickBooks' read/write split does:
 *
 *   day        the tenant is out until the window rolls. budgetExhausted.
 *   minute     clears in under a minute. retryable, not exhausted.
 *   concurrent too many in flight. retryable, not exhausted.
 *   appminute  our own app is the problem across all tenants, which no
 *              single tenant can fix by waiting longer. retryable.
 *
 * A 429 with no `X-Rate-Limit-Problem` is treated as the daily limit, which
 * is the conservative reading: calling it a minute limit would have the
 * worker hammer a tenant that is actually out for the day.
 */

interface XeroSettings {
  /**
   * Which Xero organisation. Required on every single request as a header,
   * because one authorisation can reach several organisations and the token
   * alone does not say which one this connection is for.
   */
  tenantId: string;
  /** Overridable so a test never reaches Xero. */
  baseUrl?: string;
  tokenUrl?: string;
}

/**
 * The credential, as ONE opaque string, for the reason the QuickBooks adapter
 * gives at length: `settings` is an ordinary jsonb column that appears in
 * backups and support queries, and splitting a credential across it and the
 * secret store puts two thirds of the secret back in the database.
 *
 * It matters more here. Xero rotates the refresh token on every exchange, so
 * this value changes constantly and all three fields have to travel together
 * through `onCredentialRotated` as one write.
 */
interface XeroCredential {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

const DEFAULT_BASE = "https://api.xero.com/api.xro/2.0";
const DEFAULT_TOKEN_URL = "https://identity.xero.com/connect/token";

/**
 * How far back a first sync reaches.
 *
 * THIS BOUND IS OURS, NOT XERO'S, and the difference is worth stating. Intuit
 * refuses a `changedSince` older than thirty days, so the QuickBooks adapter
 * has no choice. Xero will happily answer `If-Modified-Since: 1970`, and
 * doing that on a ten year old organisation is the most expensive request
 * available: every invoice ever issued, paged sixty at a time, against a
 * five thousand call daily ceiling.
 *
 * So, said plainly rather than left for somebody to discover: connecting Xero
 * does NOT import history. It picks up changes from here. A backfill is a
 * different job with a different budget and it does not belong on a worker
 * tick.
 */
const FIRST_SYNC_WINDOW_DAYS = 30;

/** Xero's page size ceiling on the endpoints this adapter reads. */
const PAGE_SIZE = 100;

/**
 * How many pages one `changes()` call will walk per entity before reporting
 * `more` and letting the next pass continue.
 *
 * A ceiling rather than a loop to exhaustion, because the daily limit is
 * shared with the push half of the sync. A first pass over a busy
 * organisation that drained the whole day's allowance reading would leave
 * nothing to push invoices with, and the symptom would be "the accountant's
 * Xero is empty" with reads as the cause.
 */
const MAX_PAGES_PER_PASS = 5;

/** The four kinds, and the endpoint each lives behind. */
const ENTITIES = [
  { kind: "customer", path: "Contacts", collection: "Contacts" },
  { kind: "invoice", path: "Invoices", collection: "Invoices" },
  { kind: "payment", path: "BatchPayments", collection: "BatchPayments" },
  { kind: "credit_memo", path: "CreditNotes", collection: "CreditNotes" },
] as const satisfies readonly { kind: AccountingEntityKind; path: string; collection: string }[];

/**
 * Where the deterministic key lives on each kind, and the field has to be one
 * Xero's `where` filter can match on. A note or a description cannot be.
 */
const KEY_FIELD: Record<Exclude<AccountingEntityKind, "credit_note_application">, {
  path: string; collection: string; field: string; id: string;
}> = {
  customer: { path: "Contacts", collection: "Contacts", field: "Name", id: "ContactID" },
  invoice: { path: "Invoices", collection: "Invoices", field: "InvoiceNumber", id: "InvoiceID" },
  payment: { path: "BatchPayments", collection: "BatchPayments", field: "Reference", id: "BatchPaymentID" },
  credit_memo: {
    path: "CreditNotes", collection: "CreditNotes", field: "CreditNoteNumber", id: "CreditNoteID",
  },
  /** The cash half of a refund, which is the half that says it happened. See `pushRefund`. */
  refund: {
    path: "BankTransactions", collection: "BankTransactions", field: "Reference", id: "BankTransactionID",
  },
  credit_note: {
    path: "CreditNotes", collection: "CreditNotes", field: "CreditNoteNumber", id: "CreditNoteID",
  },
  /** The invoice that reverses a voided credit note. See `pushOutbound` in the sync. */
  credit_note_void: { path: "Invoices", collection: "Invoices", field: "InvoiceNumber", id: "InvoiceID" },
  /** A credit note's credit paid out: a payment against the credit note, found by its reference. */
  credit_note_refund: { path: "Payments", collection: "Payments", field: "Reference", id: "PaymentID" },
  /**
   * A manual journal. It has no number or reference field at all, so the key
   * opens the narration and `findPushed` searches for a narration starting
   * with it (see there).
   */
  journal: { path: "ManualJournals", collection: "ManualJournals", field: "Narration", id: "ManualJournalID" },
  /**
   * `credit_note_application` is absent, and on purpose: an Allocation has
   * no reference field and no endpoint of its own to search. It is found by
   * `findCreditApplication`, which reads the credit note it hangs off.
   */
};

/** The receivable half of a refund. Numbered from the refund's key so a retry finds it. */
const REFUND_CHARGE = { path: "Invoices", collection: "Invoices", id: "InvoiceID" } as const;

/**
 * What Xero says when it already has one.
 *
 * Message patterns rather than codes, because Xero's uniqueness failures
 * arrive as validation errors whose only machine readable part is the text.
 * Over-matching costs one wasted lookup through `findPushed`; under-matching
 * costs a second copy of the document in somebody's books on every pass
 * forever, so this leans deliberately towards over-matching.
 */
const DUPLICATE_PATTERNS = [
  /must be unique/i,
  /already exists/i,
  /already been used/i,
  /duplicate/i,
];

export class XeroAmountError extends Error {
  constructor(value: string, places: number) {
    super(
      `"${value}" cannot be sent to Xero without losing precision. `
      + `Amounts are numeric(14,4) here and this field holds ${places} decimal places.`,
    );
    this.name = "XeroAmountError";
  }
}

/**
 * A decimal string as a JSON number, at a stated number of decimal places, or
 * a refusal.
 *
 * Money is a string everywhere in this codebase because floats lose cents.
 * JSON has only doubles, so the boundary is here, and the rule at the
 * boundary is that NOTHING IS SILENTLY ROUNDED. An amount with a non-zero
 * digit past the limit is refused rather than truncated, because truncating
 * means the document in the books and the document in the ledger differ by a
 * fraction per line, which reconciles to nothing and is found by an
 * accountant rather than by us.
 *
 * `places` is a parameter rather than a constant because Xero is genuinely
 * different in the two positions: `UnitAmount` takes four with `unitdp=4`,
 * which is exactly our column, and `LineAmount` and every total take two.
 */
export function toProviderAmount(value: string, places: 2 | 4): number {
  const match = /^(-?)(\d{1,13})(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) throw new XeroAmountError(value, places);

  const fraction = (match[3] ?? "").padEnd(4, "0");
  if (fraction.slice(places) !== "0".repeat(4 - places)) throw new XeroAmountError(value, places);

  const canonical = `${match[1]}${match[2]}.${fraction.slice(0, places)}`;
  const parsed = Number(canonical);
  /**
   * The round trip is asserted rather than assumed. Every value a trades
   * company will ever invoice survives a double exactly, but "will ever" is a
   * claim and a claim the code does not check is a defect.
   */
  if (!Number.isFinite(parsed) || parsed.toFixed(places) !== canonical) {
    throw new XeroAmountError(value, places);
  }
  return parsed;
}

const lineAmount = (money: ExternalMoney): number => toProviderAmount(money.amount, 2);
const unitAmount = (money: ExternalMoney): number => toProviderAmount(money.amount, 4);

export class XeroKeyError extends Error {
  constructor(value: string) {
    super(
      `"${value}" cannot be looked up in Xero: their filter syntax has no escape for a `
      + "double quote or a backslash, so a key containing one cannot be expressed as a query.",
    );
    this.name = "XeroKeyError";
  }
}

/**
 * A value inside a Xero `where` filter.
 *
 * Xero's filter language takes `Field=="value"` and publishes NO escape for a
 * double quote inside the value. So a key containing one is refused rather
 * than sent, because the alternative is a query Xero rejects with a parse
 * error that reads like an outage, or worse, one that parses into a different
 * filter than the one intended.
 *
 * A refusal rather than a stripped character, and not a `null` meaning "not
 * found" either: a lookup that could not be expressed is not evidence that
 * the document is absent, and treating it as such would have the service
 * create a second one.
 */
export function whereValue(value: string): string {
  if (value.includes('"') || value.includes("\\")) throw new XeroKeyError(value);
  return `"${value}"`;
}

/**
 * Xero's `UpdatedDateUTC`, which is NOT an ISO instant.
 *
 * It is Microsoft JSON date format, `/Date(1573755038314)/`, sometimes with a
 * trailing offset: `/Date(1573755038314+0000)/`. `new Date()` on that string
 * returns Invalid Date, so an adapter that passes it straight through
 * produces an invalid date on every single change, every comparison against
 * it is false, and the sync looks like it is working while ordering nothing.
 *
 * The offset is deliberately ignored when present. The number before it is
 * already milliseconds since the Unix epoch in UTC, so adding the offset
 * would move every timestamp by the organisation's own time zone.
 *
 * Falls back to parsing the value as ISO, because Xero also exposes
 * `UpdatedDateUTCString` in that form on some objects and a future version
 * changing which one it sends should degrade to correct rather than to
 * invalid.
 */
export function parseXeroDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw === "") return null;
  const ms = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(raw.trim());
  if (ms) {
    const value = Number(ms[1]);
    return Number.isFinite(value) ? new Date(value) : null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Xero's own account types, onto the five the mapping screen sorts by. */
function classify(type: string | undefined): ExternalAccount["classification"] {
  switch (type) {
    case "REVENUE": case "SALES": case "OTHERINCOME":
      return "income";
    case "EXPENSE": case "DIRECTCOSTS": case "OVERHEADS": case "DEPRECIATN":
      return "expense";
    case "BANK": case "CURRENT": case "FIXED": case "INVENTORY":
    case "NONCURRENT": case "PREPAYMENT":
      return "asset";
    case "CURRLIAB": case "LIABILITY": case "TERMLIAB": case "PAYG":
      return "liability";
    case "EQUITY":
      return "equity";
    default:
      return "other";
  }
}

/**
 * Which of Xero's four limits a 429 was.
 *
 * Only `day` is budget exhaustion. The other three clear in seconds, and
 * reporting them as an exhausted budget would put "wait for the quota window"
 * on an operator's screen and stop the sync advancing for a condition that
 * has already passed.
 */
function exhausted(problem: string | null): boolean {
  if (!problem) return true;
  return problem.trim().toLowerCase() === "day";
}

export function createXeroProvider(
  settings: Record<string, unknown>,
  secret: string,
  hooks: ProviderHooks = {},
  transport: HttpTransport = globalThis.fetch as unknown as HttpTransport,
): AccountingProvider {
  const config = settings as unknown as XeroSettings;
  const base = config.baseUrl ?? DEFAULT_BASE;
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const credential = parseCredential(secret);
  if (typeof config.tenantId !== "string" || config.tenantId === "") {
    throw new Error(
      "The Xero connection needs a tenantId. One authorisation can reach several "
      + "organisations and nothing but this says which one this connection is for.",
    );
  }

  /**
   * The access token, in memory only. Never written to the database and never
   * returned from any method here. The only thing that survives a restart is
   * the refresh token in the secret store.
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
       * The body is NOT included in the error, for the reason the QuickBooks
       * adapter gives: the request parameter here is the refresh token, and
       * an error message is the most widely copied string in any system. It
       * goes into logs, into a support ticket, into a screenshot in a chat.
       */
      throw new Error(`Xero refused the token refresh with HTTP ${response.status}`);
    }

    const payload = JSON.parse(body) as {
      access_token?: string; expires_in?: number; refresh_token?: string;
    };
    if (!payload.access_token) throw new Error("Xero returned no access token");

    access = {
      token: payload.access_token,
      /**
       * Sixty seconds early, so a token cannot expire between the check and
       * the request. The failure that avoids is a 401 on a write that has
       * already been counted, after which the retry has to decide whether the
       * write happened.
       */
      expiresAt: Date.now() + Math.max(0, (payload.expires_in ?? 1800) - 60) * 1000,
    };

    /**
     * ROTATION, AND THIS IS THE LINE THE WHOLE ADAPTER DEPENDS ON.
     *
     * Xero issues a new refresh token on EVERY exchange and invalidates the
     * old one immediately. There is no grace period and no second chance.
     * Dropping this value does not degrade the connection, it ends it: the
     * next refresh presents a token Xero has already retired, gets
     * `invalid_grant`, and the only fix is a human going back through the
     * consent screen.
     *
     * Written back unconditionally when it differs, before anything else
     * happens, so a crash after this point still leaves a usable credential.
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
    method: "GET" | "PUT";
    body?: Record<string, unknown>;
    /** Sent on writes. Xero dedupes on it for a window of its own choosing. */
    idempotencyKey?: string;
    /**
     * Anything else this one call needs, which today is `If-Modified-Since`.
     *
     * It is a HEADER on these endpoints and there is no query parameter
     * equivalent, so the transport has to be able to carry one. Putting the
     * window in the path instead would be a parameter Xero ignores, and an
     * ignored window means every pass reads the whole organisation and
     * reports it all as changed.
     */
    headers?: Record<string, string>;
  }

  type Raw =
    | { ok: true; payload: Record<string, unknown>; serverDate: Date | null }
    | {
      ok: false; code: string; message: string;
      retryable: boolean; budgetExhausted: boolean; retryAfterSeconds: number | null;
    };

  async function call(request: Call, allowRetry = true): Promise<Raw> {
    const response = await transport(`${base}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        "xero-tenant-id": config.tenantId,
        Accept: "application/json",
        ...(request.body ? { "Content-Type": "application/json" } : {}),
        /**
         * 128 characters is their documented ceiling. A key over it is
         * truncated rather than refused, because the consequence of a
         * truncated key is a slightly wider dedupe window and the
         * consequence of refusing the write is an invoice that never reaches
         * the books. Our keys are invoice numbers and uuids, so this does not
         * fire in practice; it is here so that it cannot start firing.
         */
        ...(request.idempotencyKey
          ? { "Idempotency-Key": request.idempotencyKey.slice(0, 128) }
          : {}),
        ...request.headers,
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
      const problem = response.headers.get("x-rate-limit-problem");
      const isDay = exhausted(problem);
      return {
        ok: false,
        code: "429",
        message: isDay
          ? "Xero has refused further calls for this organisation until the daily window rolls."
          : `Xero throttled this request (${problem ?? "rate limit"}).`,
        retryable: true,
        budgetExhausted: isDay,
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

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        code: String(payload["ErrorNumber"] ?? response.status),
        message: problemOf(payload) ?? `Xero returned HTTP ${response.status}`,
        // A 5xx is Xero's problem, not the document's.
        retryable: response.status >= 500,
        budgetExhausted: false,
        retryAfterSeconds: null,
      };
    }

    return { ok: true, payload, serverDate: headerDate(response) };
  }

  /**
   * A create, and the shape all four pushes share.
   *
   * PUT rather than POST, which is the opposite of what the verbs suggest and
   * is the whole point. On these endpoints Xero's POST is "update or create":
   * a document whose number matches an existing one is OVERWRITTEN. That is
   * the wrong operation for a bridge whose job is to add documents to
   * somebody's books, because a retry, a replayed job or a reused number
   * silently rewrites a document that may already be in a filed period. PUT
   * creates, and tells us when it will not.
   *
   * `summarizeErrors=true` for a reason that is not cosmetic. The default is
   * FALSE, and with it Xero answers 200 OK carrying a mixture of created
   * objects and rejected ones. An adapter that trusted the status code would
   * record a rejected invoice as pushed, store no id for it, and never try
   * again. The per-object `ValidationErrors` are checked as well, below,
   * because trusting one query parameter to protect against that is one
   * change on their side away from being wrong.
   */
  async function create(
    entity: { path: string; collection: string; id: string },
    body: Record<string, unknown>,
    idempotencyKey: string,
    extraQuery = "",
  ): Promise<PushResult> {
    const result = await call({
      path: `/${entity.path}?summarizeErrors=true${extraQuery}`,
      method: "PUT",
      body,
      idempotencyKey,
    });

    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        retryable: result.retryable,
        duplicate: DUPLICATE_PATTERNS.some((p) => p.test(result.message)),
      };
    }

    const rows = (result.payload[entity.collection] ?? []) as Record<string, unknown>[];
    const first = rows[0];

    /**
     * The belt to `summarizeErrors`' braces. A 200 carrying validation errors
     * is a rejection, and the only thing that makes it look like a success is
     * the status line.
     */
    const invalid = validationMessage(first);
    if (invalid) {
      return {
        ok: false,
        code: "validation",
        message: invalid,
        retryable: false,
        duplicate: DUPLICATE_PATTERNS.some((p) => p.test(invalid)),
      };
    }

    const id = first?.[entity.id];
    if (typeof id !== "string" || id === "") {
      return {
        ok: false,
        code: "no_id",
        message: `Xero accepted the ${entity.path} and returned no id`,
        /**
         * Not retryable: the document exists over there, so trying again
         * creates a second one. The service resolves this through
         * `findPushed`, which is what that method is for.
         */
        retryable: false,
        duplicate: true,
      };
    }

    return {
      ok: true,
      externalId: id,
      /**
       * Xero has no optimistic concurrency token on these objects. Stated as
       * null rather than filled with `UpdatedDateUTC`, which would read as a
       * version the next write could present and nothing would honour.
       */
      version: null,
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

  /** A line, with the mapped account resolved into whichever field it names. */
  function lineOf(line: ExternalInvoice["lines"][number]): Record<string, unknown> {
    return {
      Description: line.description,
      Quantity: Number(line.quantity),
      UnitAmount: unitAmount(line.unitPrice),
      LineAmount: lineAmount(line.amount),
      /**
       * `AccountID` for an account and `ItemCode` for an item, which is why
       * the mapping stores the kind of object alongside the id. This adapter
       * is the only code that knows which field the operator's choice goes
       * in, exactly as the QuickBooks adapter is the only code that knows it
       * goes in `ItemRef`.
       */
      ...(line.accountExternalKind === "Item"
        ? { ItemCode: line.accountExternalId }
        : { AccountID: line.accountExternalId }),
      /**
       * NONE, so Xero computes no tax of its own.
       *
       * Their engine would recompute from the organisation's rates, and where
       * that disagrees with the rate frozen on `invoice_line.tax_rate` the
       * books and the document the customer actually received would differ.
       * The invoice the customer holds is the authority: rule 3 at the top of
       * schema/billing.ts. Tax goes on its own line, below, against the
       * account the operator mapped it to.
       */
      TaxType: "NONE",
      TaxAmount: 0,
    };
  }

  /** Tax as its own line against the mapped account, for the reason `lineOf` gives. */
  function taxLineOf(tax: ExternalInvoice["tax"]): Record<string, unknown>[] {
    return tax
      ? [{
        Description: "Sales tax",
        Quantity: 1,
        UnitAmount: lineAmount(tax.amount),
        LineAmount: lineAmount(tax.amount),
        AccountID: tax.accountExternalId,
        TaxType: "NONE",
        TaxAmount: 0,
      }]
      : [];
  }

  async function findPushed(
    kind: AccountingEntityKind, idempotencyKey: string,
  ): Promise<ReadResult<ExternalRef | null>> {
    if (kind === "credit_note_application") {
      /**
       * Refused rather than answered with `null`, which would mean "Xero does
       * not have one" and have the service send a second allocation on the
       * strength of a question nobody asked.
       */
      return {
        ok: false,
        code: "unsearchable",
        message: "A Xero allocation carries no reference to search by. It is found through its credit note.",
        retryable: false,
        budgetExhausted: false,
        retryAfterSeconds: null,
      };
    }
    const target = KEY_FIELD[kind];
    let filter: string;
    try {
      filter = kind === "journal"
        ? `${target.field}.StartsWith(${whereValue(`${idempotencyKey}:`)})`
        : `${target.field}==${whereValue(idempotencyKey)}`;
    } catch (error) {
      /**
       * A key that cannot be expressed as a filter is reported as a failure
       * rather than as `null`. `null` means "Xero does not have one", and
       * answering that here would have the service create a second
       * document on the strength of a question nobody managed to ask.
       */
      return {
        ok: false,
        code: "unquotable_key",
        message: error instanceof Error ? error.message : "The key cannot be looked up",
        retryable: false,
        budgetExhausted: false,
        retryAfterSeconds: null,
      };
    }

    const result = await call({
      path: `/${target.path}?where=${encodeURIComponent(filter)}`,
      method: "GET",
    });
    if (!result.ok) return readFailure(result);

    const rows = (result.payload[target.collection] ?? []) as Record<string, unknown>[];
    const id = rows[0]?.[target.id];
    if (typeof id !== "string" || id === "") return { ok: true, value: null };
    return { ok: true, value: { externalId: id, version: null } };
  }

  return {
    name: "xero",

    async pushCustomer(customer: ExternalCustomer): Promise<PushResult> {
      return create(KEY_FIELD.customer, {
        Contacts: [{
          /**
           * `Name` is unique in Xero and is where the key is written, so
           * `findPushed` can find it again. It is also what a bookkeeper
           * sees, which is why a customer's key is the customer's own name
           * rather than an opaque token.
           */
          Name: customer.idempotencyKey,
          IsCustomer: true,
          ...(customer.email ? { EmailAddress: customer.email } : {}),
          ...(customer.phone
            ? { Phones: [{ PhoneType: "DEFAULT", PhoneNumber: customer.phone }] }
            : {}),
        }],
      }, customer.idempotencyKey);
    },

    async pushInvoice(invoice: ExternalInvoice): Promise<PushResult> {
      const lines = invoice.lines.map(lineOf);

      const taxLine = taxLineOf(invoice.tax);

      return create(KEY_FIELD.invoice, {
        Invoices: [{
          Type: "ACCREC",
          Contact: { ContactID: invoice.customerExternalId },
          InvoiceNumber: invoice.documentNumber,
          /**
           * The key goes in `Reference` as well as the number going in
           * `InvoiceNumber`, because the two are not the same thing. The
           * number is what the customer was shown and the key is what makes a
           * lost response recoverable, and an operator who renumbers their
           * invoices should not break idempotency.
           */
          Reference: invoice.idempotencyKey,
          Date: invoice.issuedOn,
          ...(invoice.dueOn ? { DueDate: invoice.dueOn } : {}),
          CurrencyCode: invoice.currency,
          /**
           * Exclusive, stated rather than relying on the default, because the
           * default is a sentence in their documentation and this is the
           * difference between an invoice total that matches ours and one
           * that is out by the tax.
           */
          LineAmountTypes: "Exclusive",
          /**
           * AUTHORISED, not DRAFT. A draft invoice does not appear on an AR
           * report and cannot be matched against a payment, so pushing drafts
           * would produce a bridge that moves documents and reconciles
           * nothing. The invoice has already been issued to the customer by
           * the time it reaches here.
           */
          Status: "AUTHORISED",
          LineItems: [...lines, ...taxLine],
        }],
      }, invoice.idempotencyKey, "&unitdp=4");
    },

    async pushPayment(payment: ExternalPayment): Promise<PushResult> {
      /**
       * EVERY PAYMENT BECOMES A BATCH PAYMENT, INCLUDING A BATCH OF ONE, AND
       * THIS IS THE ONE PLACE XERO FORCED A REAL DECISION.
       *
       * A Xero `Payment` references exactly ONE invoice. Our `payment` row
       * carries allocations across several, because M13 applies a receipt to
       * the oldest balance first, so one of ours is N of theirs. The seam
       * returns a single `ExternalRef`, which means something has to give.
       *
       * Three options and why this is the one:
       *
       *   Refuse a multi-allocation payment. That is most of them, so the
       *   bridge would be useless for the ordinary case.
       *
       *   Create N payments and return the first one's id. The link table
       *   would then name one of N documents, and nothing anywhere would say
       *   the other N-1 exist. A reconciliation built on that link is wrong
       *   and looks right.
       *
       *   A BatchPayment, which is Xero's own object for exactly this: one
       *   sum of money arriving, applied across several invoices, appearing as
       *   one line on the bank reconciliation. One of ours maps to one of
       *   theirs, and the link table holds one kind of id.
       *
       * So a single-allocation payment is a batch of one rather than a plain
       * Payment, because mixing the two would put `PaymentID` and
       * `BatchPaymentID` in the same column and `findPushed` could not know
       * which endpoint to ask.
       *
       * What this costs the operator, and it is on the website rather than
       * only here: payments show on the Xero bank reconciliation as batch
       * payments, and batch payments require the deposit account to be a bank
       * account with payments enabled.
       */
      return create(KEY_FIELD.payment, {
        BatchPayments: [{
          Account: { AccountID: payment.depositAccountExternalId },
          Reference: payment.idempotencyKey,
          Date: payment.receivedOn,
          Payments: payment.allocations.map((allocation) => ({
            Invoice: { InvoiceID: allocation.invoiceExternalId },
            Amount: lineAmount(allocation.amount),
          })),
        }],
      }, payment.idempotencyKey);
    },

    async pushCredit(credit: ExternalCredit): Promise<PushResult> {
      return create(KEY_FIELD.credit_memo, {
        CreditNotes: [{
          Type: "ACCRECCREDIT",
          Contact: { ContactID: credit.customerExternalId },
          CreditNoteNumber: credit.idempotencyKey,
          Date: credit.issuedOn,
          Status: "AUTHORISED",
          LineAmountTypes: "Exclusive",
          LineItems: [{
            Description: credit.reason,
            Quantity: 1,
            UnitAmount: lineAmount(credit.amount),
            LineAmount: lineAmount(credit.amount),
            /**
             * A write-off is an expense, not a smaller sale, which is why the
             * service resolves it against ACCOUNTS.WRITE_OFF rather than
             * against the revenue account the invoice used.
             */
            AccountID: credit.accountExternalId,
            TaxType: "NONE",
            TaxAmount: 0,
          }],
        }],
      }, credit.idempotencyKey, "&unitdp=4");
    },

    /**
     * An ACCRECCREDIT credit note with the credit note's own lines, keyed by
     * its number, AUTHORISED for the reason an invoice is: a draft credit
     * note sits on no report and can be allocated to nothing.
     *
     * Its lines carry the revenue account the ledger debited and its tax
     * goes on its own line, exactly as an invoice's do, through the same
     * `lineOf`. Not through `pushCredit`'s single line against the write off
     * account: a credit note is a smaller sale, not a loss.
     */
    async pushCreditNote(note: ExternalCreditNote): Promise<PushResult> {
      return create(KEY_FIELD.credit_note, {
        CreditNotes: [{
          Type: "ACCRECCREDIT",
          Contact: { ContactID: note.customerExternalId },
          CreditNoteNumber: note.documentNumber,
          Reference: note.idempotencyKey,
          Date: note.issuedOn,
          CurrencyCode: note.currency,
          LineAmountTypes: "Exclusive",
          Status: "AUTHORISED",
          LineItems: [...note.lines.map(lineOf), ...taxLineOf(note.tax)],
        }],
      }, note.idempotencyKey, "&unitdp=4");
    },

    /**
     * AN ALLOCATION, which is Xero's own word for exactly this: part of a
     * credit note put against an invoice, on a date, moving no money.
     *
     * PUT on the credit note's `Allocations`, with the key as the request's
     * idempotency key. An allocation has no id of its own on some versions
     * of the API, so when none comes back the link is given one built from
     * the credit note and our key, which is unique per application and is
     * what `findCreditApplication` produces for the same allocation.
     */
    async pushCreditApplication(application: ExternalCreditApplication): Promise<PushResult> {
      const result = await call({
        path: `/CreditNotes/${encodeURIComponent(application.creditNoteExternalId)}/Allocations?summarizeErrors=true`,
        method: "PUT",
        body: {
          Allocations: [{
            Invoice: { InvoiceID: application.invoiceExternalId },
            Amount: lineAmount(application.amount),
            Date: application.appliedOn,
          }],
        },
        idempotencyKey: application.idempotencyKey,
      });
      if (!result.ok) {
        return {
          ok: false,
          code: result.code,
          message: result.message,
          retryable: result.retryable,
          duplicate: false,
        };
      }
      const first = ((result.payload["Allocations"] ?? []) as Record<string, unknown>[])[0];
      const invalid = validationMessage(first);
      if (invalid) {
        return { ok: false, code: "validation", message: invalid, retryable: false, duplicate: false };
      }
      const id = first?.["AllocationID"];
      return {
        ok: true,
        externalId: typeof id === "string" && id !== ""
          ? id
          : allocationRef(application.creditNoteExternalId, application.idempotencyKey),
        version: null,
        adopted: false,
      };
    },

    /**
     * Read the credit note and look for an allocation to this invoice, for
     * this amount, on this date, that no other application of ours already
     * claims. One read, against the daily limit like any other.
     */
    async findCreditApplication(
      application: ExternalCreditApplication, taken: string[],
    ): Promise<ReadResult<ExternalRef | null>> {
      const result = await call({
        path: `/CreditNotes/${encodeURIComponent(application.creditNoteExternalId)}`,
        method: "GET",
      });
      if (!result.ok) return readFailure(result);

      const note = ((result.payload["CreditNotes"] ?? []) as Record<string, unknown>[])[0];
      const allocations = (note?.["Allocations"] ?? []) as Record<string, unknown>[];
      const amount = lineAmount(application.amount);
      for (const allocation of allocations) {
        const invoice = allocation["Invoice"] as { InvoiceID?: unknown } | undefined;
        const on = parseXeroDate(allocation["Date"]);
        if (invoice?.InvoiceID !== application.invoiceExternalId) continue;
        if (Number(allocation["Amount"]) !== amount) continue;
        if (on && on.toISOString().slice(0, 10) !== application.appliedOn) continue;
        const id = typeof allocation["AllocationID"] === "string" && allocation["AllocationID"] !== ""
          ? allocation["AllocationID"] as string
          : allocationRef(application.creditNoteExternalId, application.idempotencyKey);
        if (taken.includes(id)) continue;
        return { ok: true, value: { externalId: id, version: null } };
      }
      return { ok: true, value: null };
    },

    /**
     * TWO DOCUMENTS, BECAUSE XERO WILL NOT LET ONE DO IT.
     *
     * A refund here posts cash out and the customer's receivable back up.
     * Xero's Accounts Receivable is a system account: no bank transaction
     * and no manual journal may touch it, and the only thing that debits it
     * is a sales invoice. Xero's own refund instrument, a cash refund of a
     * credit note or an overpayment, posts against revenue or against a
     * credit the customer holds, neither of which is what happened.
     *
     * So the receivable goes up on an ACCREC invoice to the customer for the
     * refunded amount, coded to the account mapped for customer deposits,
     * and the cash goes out on a Spend Money transaction from the bank coded
     * to that same account. The deposits account nets to nothing; what is
     * left is cash down and the customer owing it again, which is the
     * ledger's posting. The invoice is numbered with the refund's key and
     * sent with its own idempotency key, so a retry after the first call
     * lands on the same invoice, and the Spend Money carries the key as its
     * reference, which is what `findPushed` asks for.
     *
     * Only what had been applied to invoices is sent. Money a payment held
     * unapplied never reached Xero, because a batch payment carries only its
     * applications, so giving it back moves nothing there.
     */
    async pushRefund(refund: ExternalRefund): Promise<PushResult> {
      if (!refund.clearingAccountExternalId) {
        return {
          ok: false,
          code: "unmapped",
          message: "Map the customer deposits account before refunds can be sent to Xero: it carries a refund "
            + "between the invoice that puts it back on what the customer owes and the bank payment that sends it.",
          retryable: false,
          duplicate: false,
        };
      }
      const amount = lineAmount(refund.appliedAmount);
      const line = {
        Description: refund.memo,
        Quantity: 1,
        UnitAmount: amount,
        LineAmount: amount,
        AccountID: refund.clearingAccountExternalId,
        TaxType: "NONE",
        TaxAmount: 0,
      };

      const charge = await create(REFUND_CHARGE, {
        Invoices: [{
          Type: "ACCREC",
          Contact: { ContactID: refund.customerExternalId },
          InvoiceNumber: refund.idempotencyKey,
          Reference: `Refund of payment ${refund.paymentExternalId}`,
          Date: refund.refundedOn,
          DueDate: refund.refundedOn,
          Status: "AUTHORISED",
          LineAmountTypes: "NoTax",
          LineItems: [line],
        }],
      }, `${refund.idempotencyKey}-charge`, "&unitdp=4");
      // Already there from an attempt that died before the cash half: carry on.
      if (!charge.ok && !charge.duplicate) return charge;

      return create(KEY_FIELD.refund, {
        BankTransactions: [{
          Type: "SPEND",
          Contact: { ContactID: refund.customerExternalId },
          BankAccount: { AccountID: refund.bankAccountExternalId },
          Date: refund.refundedOn,
          Reference: refund.idempotencyKey,
          Status: "AUTHORISED",
          LineAmountTypes: "NoTax",
          LineItems: [line],
        }],
      }, refund.idempotencyKey, "&unitdp=4");
    },

    /**
     * A CASH REFUND OF A CREDIT NOTE, which is Xero's own instrument for
     * exactly this: a payment against the credit note out of a bank account.
     * The credit note's remaining credit goes down by the amount and the bank
     * by the same, and no invoice is touched, which is our posting: customer
     * deposits down, cash down. The key is the payment's reference, which is
     * what `findPushed` asks for.
     */
    async pushCreditNoteRefund(refund: ExternalCreditNoteRefund): Promise<PushResult> {
      return create(KEY_FIELD.credit_note_refund, {
        Payments: [{
          CreditNote: { CreditNoteID: refund.creditNoteExternalId },
          Account: { AccountID: refund.bankAccountExternalId },
          Date: refund.paidOn,
          Amount: lineAmount(refund.amount),
          Reference: refund.idempotencyKey,
        }],
      }, refund.idempotencyKey);
    },

    /**
     * A manual journal, posted. Xero takes one signed amount per line,
     * positive for a debit and negative for a credit, and the lines must sum
     * to zero, which the ledger guarantees. The account is sent by id, as
     * every other line this adapter writes is.
     */
    async pushJournal(journal: ExternalJournal): Promise<PushResult> {
      return create(KEY_FIELD.journal, {
        ManualJournals: [{
          Narration: `${journal.idempotencyKey}: Journal ${journal.number}, ${journal.memo}`.slice(0, 4000),
          Date: journal.postedOn,
          Status: "POSTED",
          LineAmountTypes: "NoTax",
          JournalLines: journal.lines.map((line) => ({
            LineAmount: line.direction === "debit" ? lineAmount(line.amount) : -lineAmount(line.amount),
            AccountID: line.accountExternalId,
            Description: (line.description ?? journal.memo).slice(0, 4000),
          })),
        }],
      }, journal.idempotencyKey);
    },

    heldMoneyReachesBooks: false,

    findPushed,

    async changes(cursor: string | null): Promise<ReadResult<ChangeSet>> {
      /**
       * THE NEXT WINDOW STARTS BEFORE THIS REQUEST WENT OUT, NOT AT THE
       * NEWEST RECORD IN IT.
       *
       * Taken from Xero's own `Date` response header where they send one, so
       * the boundary is in their clock rather than ours. A timestamp window
       * compared across two machines is the one place a clock difference
       * silently loses data: ours running a minute fast would skip a minute
       * of changes on every single pass, and nothing would ever report it.
       *
       * Captured BEFORE the first call, so a document written during the pass
       * falls inside the next window rather than between the two.
       */
      const startedAt = new Date();
      const since = cursor
        ? parseXeroDate(cursor) ?? new Date(cursor)
        : new Date(Date.now() - FIRST_SYNC_WINDOW_DAYS * 86_400_000);

      if (Number.isNaN(since.getTime())) {
        return {
          ok: false,
          code: "bad_cursor",
          message: `"${cursor ?? ""}" is not a time this adapter can resume from.`,
          retryable: false,
          budgetExhausted: false,
          retryAfterSeconds: null,
        };
      }

      const changes: ExternalChange[] = [];
      let more = false;
      let serverDate: Date | null = null;

      for (const entity of ENTITIES) {
        for (let page = 1; page <= MAX_PAGES_PER_PASS; page += 1) {
          const result = await call({
            path: `/${entity.path}?page=${page}&pageSize=${PAGE_SIZE}`,
            method: "GET",
            /**
             * The window, as the header Xero actually reads. There is no
             * query parameter for it, so sending one would be silently
             * ignored and every pass would read the entire organisation and
             * report all of it as changed.
             */
            headers: { "If-Modified-Since": since.toISOString() },
          });
          if (!result.ok) return readFailure(result);
          serverDate ??= result.serverDate;

          const rows = (result.payload[entity.collection] ?? []) as Record<string, unknown>[];
          for (const row of rows) {
            const id = row[KEY_FIELD[entity.kind].id];
            if (typeof id !== "string" || id === "") continue;
            changes.push({
              kind: entity.kind,
              externalId: id,
              version: null,
              deleted: isGone(entity.kind, row),
              /**
               * Their timestamp when it parses, and the start of this pass
               * when it does not. Never `new Date()` at the moment of
               * parsing: that would be later than the cursor this pass is
               * about to store, so a record whose date was unreadable would
               * be ordered after changes that came later.
               */
              changedAt: parseXeroDate(row["UpdatedDateUTC"])
                ?? parseXeroDate(row["UpdatedDateUTCString"])
                ?? startedAt,
            });
          }

          /**
           * A short page is the end. A full one means there is at least one
           * more, and once the page ceiling is reached the rest is left for
           * the next pass rather than read now, so one busy entity cannot
           * spend the day's allowance that the push half also needs.
           */
          if (rows.length < PAGE_SIZE) break;
          if (page === MAX_PAGES_PER_PASS) more = true;
        }
      }

      return {
        ok: true,
        value: {
          cursor: (serverDate ?? startedAt).toISOString(),
          changes,
          more,
        },
      };
    },

    async accounts(): Promise<ReadResult<ExternalAccount[]>> {
      /**
       * Accounts AND Items, in two calls, because an invoice line can
       * reference either and offering one of them would make half the mapping
       * screen impossible to fill in. This runs when a person opens that
       * screen, never on a worker tick.
       */
      const accountsResult = await call({ path: "/Accounts", method: "GET" });
      if (!accountsResult.ok) return readFailure(accountsResult);

      const itemsResult = await call({ path: "/Items", method: "GET" });
      if (!itemsResult.ok) return readFailure(itemsResult);

      const out: ExternalAccount[] = [];

      const accountRows = (accountsResult.payload["Accounts"] ?? []) as {
        AccountID?: string; Name?: string; Code?: string; Type?: string; Status?: string;
      }[];
      for (const row of accountRows) {
        if (!row.AccountID) continue;
        out.push({
          externalId: row.AccountID,
          name: row.Name ?? row.Code ?? row.AccountID,
          kind: "Account",
          classification: classify(row.Type),
          /**
           * Xero's `Code` is the operator's own account number, which is what
           * they will recognise on the mapping screen. It is optional on
           * their side, so it is nullable here.
           */
          number: row.Code ?? null,
          active: row.Status !== "ARCHIVED" && row.Status !== "DELETED",
        });
      }

      const itemRows = (itemsResult.payload["Items"] ?? []) as {
        Code?: string; Name?: string; IsSold?: boolean;
      }[];
      for (const row of itemRows) {
        if (!row.Code) continue;
        out.push({
          /**
           * An item is referenced by its CODE in Xero, not by a uuid, so the
           * code is the external id. That is why `ExternalAccount.externalId`
           * is a string rather than a uuid in the seam.
           */
          externalId: row.Code,
          name: row.Name ?? row.Code,
          kind: "Item",
          /**
           * Offered as income because an item is what revenue lands through.
           * Reading each item's own account would be one more call per item
           * against a sixty a minute ceiling, and the operator picking from
           * this list already knows what their items are.
           */
          classification: "income",
          number: row.Code,
          active: row.IsSold !== false,
        });
      }

      return { ok: true, value: out };
    },
  };
}

/**
 * Has Xero stopped claiming this document exists.
 *
 * Per kind, because the word differs and two of the words do not mean this.
 * An ARCHIVED contact is one the organisation no longer uses and still has;
 * calling that deleted would have our side drop a customer who is merely out
 * of date. GDPRREQUEST is a contact Xero has actually erased.
 */
function isGone(kind: AccountingEntityKind, row: Record<string, unknown>): boolean {
  if (kind === "customer") return row["ContactStatus"] === "GDPRREQUEST";
  const status = row["Status"];
  return status === "DELETED" || status === "VOIDED";
}

/**
 * What an allocation is called in the link table when Xero gave it no id of
 * its own: the credit note it hangs off and our key, which together name one
 * application and nothing else.
 */
function allocationRef(creditNoteId: string, idempotencyKey: string): string {
  return `${creditNoteId}:${idempotencyKey}`;
}

/** Xero's `Date` response header, which is their clock rather than ours. */
function headerDate(response: { headers: { get(name: string): string | null } }): Date | null {
  const raw = response.headers.get("date");
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function retryAfterOf(response: { headers: { get(name: string): string | null } }): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * The sentence a person can act on, out of either error shape Xero uses.
 *
 * Their validation failures arrive as `Elements[].ValidationErrors[].Message`
 * and their other failures as a top level `Detail` or `Message`, and an
 * adapter that reads only one of them reports "Xero returned HTTP 400" for
 * the half it does not understand.
 */
function problemOf(payload: Record<string, unknown>): string | null {
  const elements = payload["Elements"];
  if (Array.isArray(elements)) {
    const messages: string[] = [];
    for (const element of elements) {
      const found = validationMessage(element as Record<string, unknown> | undefined);
      if (found) messages.push(found);
    }
    if (messages.length > 0) return messages.join(" ");
  }
  for (const field of ["Detail", "Message", "Title", "detail", "error_description"] as const) {
    const value = payload[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** The validation messages on one returned object, joined, or null. */
function validationMessage(row: Record<string, unknown> | undefined): string | null {
  const errors = row?.["ValidationErrors"];
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const messages = errors
    .map((error) => (error as { Message?: unknown }).Message)
    .filter((message): message is string => typeof message === "string" && message !== "");
  return messages.length > 0 ? messages.join(" ") : "Xero rejected the document";
}

/**
 * The credential, parsed strictly.
 *
 * A vague parse here fails at the token endpoint with an opaque 400 hours
 * after somebody set the connection up. Naming the missing field at
 * construction is the difference between a five minute fix and an afternoon.
 */
export function parseCredential(secret: string): XeroCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error(
      "The Xero credential must be a JSON document with refreshToken, clientId and clientSecret",
    );
  }
  const value = parsed as Partial<XeroCredential>;
  for (const field of ["refreshToken", "clientId", "clientSecret"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`The Xero credential is missing "${field}"`);
    }
  }
  return {
    refreshToken: value.refreshToken!,
    clientId: value.clientId!,
    clientSecret: value.clientSecret!,
  };
}

registerProvider("xero", (settings, secret, hooks) => createXeroProvider(settings, secret, hooks));
