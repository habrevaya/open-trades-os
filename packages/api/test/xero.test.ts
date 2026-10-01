import { describe, it, expect } from "vitest";
import {
  createXeroProvider, parseXeroDate, toProviderAmount, whereValue,
  XeroAmountError, XeroKeyError,
} from "../src/accounting/xero";
import { registeredProviders, createProvider } from "../src/accounting/index";
import type { HttpResponse } from "../src/accounting/provider";

/**
 * XERO, AND WHAT THE SEAM GOT WRONG ABOUT IT
 *
 * `accounting/provider.ts` was written with Xero in mind and names it four
 * times, which makes this adapter the only thing that could check those
 * claims. Two held. One did not: the seam said both QuickBooks and Xero
 * expose a change feed, and Xero exposes `If-Modified-Since` and nothing
 * else. The comment has been corrected in place and the method survived,
 * because what it actually needed was weaker than what it claimed.
 *
 * THE PROPERTIES THIS FILE IS ABOUT, in the order they would cost somebody
 * money:
 *
 *   A timestamp window must not lose a record written mid-request. There is
 *   no cursor to protect against it, so the boundary is the adapter's job and
 *   is the one thing here that fails silently and permanently.
 *
 *   A refresh token that rotates on every exchange must be handed back. Xero
 *   gives no grace period at all, so dropping it ends the connection on the
 *   next call rather than degrading it.
 *
 *   A 200 OK from Xero can contain a rejected document. Their default is to
 *   answer 200 with a mixture, and an adapter that trusts the status line
 *   records a rejected invoice as pushed and never tries again.
 *
 *   `UpdatedDateUTC` is not an ISO instant. It is `/Date(1573755038314)/`,
 *   which `new Date()` reads as Invalid Date, so an adapter that passes it
 *   through produces a sync that looks fine and orders nothing.
 */

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function transportFor(
  script: ((call: Call) => { status: number; body: unknown; headers?: Record<string, string> })[],
  calls: Call[],
) {
  let index = 0;
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = {
      url, method: init.method, headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    };
    calls.push(call);
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    const result = step!(call);
    const headers = result.headers ?? {};
    const response: HttpResponse = {
      status: result.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => (typeof result.body === "string" ? result.body : JSON.stringify(result.body)),
    };
    return response;
  };
}

const CREDENTIAL = JSON.stringify({
  refreshToken: "refresh-token-secret", clientId: "client-id", clientSecret: "client-secret",
});
const SETTINGS = {
  tenantId: "tenant-9", baseUrl: "https://xero.test", tokenUrl: "https://token.test",
};
const tokenOk = { status: 200, body: { access_token: "access-token-secret", expires_in: 1800 } };

const INVOICE = {
  idempotencyKey: "key-inv-1",
  customerExternalId: "contact-1",
  documentNumber: "INV-1042",
  issuedOn: "2026-03-01",
  dueOn: "2026-03-31",
  currency: "USD",
  lines: [{
    description: "Condenser replacement",
    quantity: "1",
    unitPrice: { amount: "1200.0000", currency: "USD" },
    amount: { amount: "1200.0000", currency: "USD" },
    accountExternalId: "acct-revenue",
    accountExternalKind: "Account",
  }],
  tax: { amount: { amount: "99.0000", currency: "USD" }, accountExternalId: "acct-tax" },
  memo: null,
};

/* ------------------------------------------------------ the money boundary */

describe("the money boundary", () => {
  it("takes four decimals on a unit amount and two on a line amount", () => {
    /**
     * THE ONE AXIS ON WHICH XERO IS BETTER THAN QUICKBOOKS, and it is in a
     * test because it is the sort of claim that rots. `unitdp=4` matches our
     * `numeric(14,4)` exactly, so a unit price of a third of a cent survives
     * where QuickBooks would refuse it. Line amounts and totals are still
     * two, so the same value is refused in the other position.
     */
    expect(toProviderAmount("0.3333", 4)).toBe(0.3333);
    expect(() => toProviderAmount("0.3333", 2)).toThrow(XeroAmountError);
    expect(toProviderAmount("1200.0000", 2)).toBe(1200);
    expect(toProviderAmount("-45.5000", 2)).toBe(-45.5);
  });

  it("uses the four-place rule on a unit price and the two-place rule on a line", async () => {
    /**
     * THE HELPER WAS TESTED AND THE CALL SITES WERE NOT, which is a different
     * thing and the gap a deliberate breakage found: widening `lineAmount` to
     * four places left every test above green, because none of them pushed a
     * document through it.
     *
     * So this goes through `pushInvoice`. A unit price of a third of a cent
     * is accepted, which is the whole of Xero's advantage over QuickBooks
     * here, and the SAME value as a line amount is refused, because Xero's
     * line amounts and totals hold two places whatever `unitdp` says.
     */
    const calls: Call[] = [];
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      () => tokenOk,
      () => ({ status: 200, body: { Invoices: [{ InvoiceID: "i" }] } }),
    ], calls));

    await provider.pushInvoice({
      ...INVOICE,
      tax: null,
      lines: [{
        ...INVOICE.lines[0]!,
        quantity: "3",
        unitPrice: { amount: "0.3333", currency: "USD" },
        amount: { amount: "1.0000", currency: "USD" },
      }],
    });
    const sent = JSON.parse(calls[1]!.body!) as {
      Invoices: { LineItems: Record<string, unknown>[] }[];
    };
    expect(sent.Invoices[0]!.LineItems[0]!["UnitAmount"]).toBe(0.3333);

    await expect(provider.pushInvoice({
      ...INVOICE,
      tax: null,
      lines: [{
        ...INVOICE.lines[0]!,
        unitPrice: { amount: "1.0000", currency: "USD" },
        amount: { amount: "1.0001", currency: "USD" },
      }],
    })).rejects.toThrow(XeroAmountError);

    // And the same rule on the tax line, which is a total rather than a unit.
    await expect(provider.pushInvoice({
      ...INVOICE,
      tax: { amount: { amount: "99.0001", currency: "USD" }, accountExternalId: "acct-tax" },
    })).rejects.toThrow(XeroAmountError);
  });

  it("refuses rather than rounding, in both positions", () => {
    /**
     * Truncating would mean the document in the books and the document in the
     * ledger differ by a fraction per line, which reconciles to nothing and
     * is found by an accountant rather than by us.
     */
    expect(() => toProviderAmount("10.005", 2)).toThrow(/without losing precision/);
    expect(() => toProviderAmount("10.00005", 4)).toThrow(XeroAmountError);
    expect(() => toProviderAmount("not money", 2)).toThrow(XeroAmountError);
  });
});

/* ----------------------------------------------------- their date format */

describe("their timestamp, which is not an ISO instant", () => {
  it("reads Microsoft JSON dates, with and without an offset", () => {
    expect(parseXeroDate("/Date(1573755038314)/")?.toISOString())
      .toBe("2019-11-14T18:10:38.314Z");
    /**
     * The offset is IGNORED on purpose. The number in front of it is already
     * milliseconds since the epoch in UTC, so adding it would move every
     * timestamp by the organisation's own time zone, in the direction that
     * makes a change look newer than it is.
     */
    expect(parseXeroDate("/Date(1573755038314+1300)/")?.toISOString())
      .toBe("2019-11-14T18:10:38.314Z");
  });

  it("falls back to ISO, and refuses anything else", () => {
    expect(parseXeroDate("2026-03-01T10:00:00Z")?.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(parseXeroDate("/Date(nonsense)/")).toBeNull();
    expect(parseXeroDate("")).toBeNull();
    expect(parseXeroDate(undefined)).toBeNull();
  });

  it("is what a naive adapter would get wrong", () => {
    // The thing being defended against, stated as a fact about the platform
    // rather than as a sentence in a comment.
    expect(Number.isNaN(new Date("/Date(1573755038314)/").getTime())).toBe(true);
  });
});

/* -------------------------------------------------------- the filter value */

describe("looking a key up", () => {
  it("quotes a key for their filter syntax", () => {
    expect(whereValue("INV-1042")).toBe('"INV-1042"');
  });

  it("refuses a key their syntax cannot express", () => {
    /**
     * Xero publishes no escape for a double quote inside a `where` value. A
     * key containing one is refused rather than sent, because the
     * alternative is either a parse error that reads like an outage or, worse,
     * a query that parses into a different filter than the one intended.
     */
    expect(() => whereValue('Bob "The Pipe" Smith')).toThrow(XeroKeyError);
    expect(() => whereValue("back\\slash")).toThrow(XeroKeyError);
  });
});

/* ------------------------------------------------------------ the credential */

describe("the credential", () => {
  it("is named at construction when a field is missing", () => {
    expect(() => createXeroProvider(SETTINGS, "not json"))
      .toThrow(/refreshToken, clientId and clientSecret/);
    expect(() => createXeroProvider(SETTINGS, JSON.stringify({ clientId: "a", clientSecret: "b" })))
      .toThrow(/missing "refreshToken"/);
  });

  it("refuses a connection with no organisation named", () => {
    /**
     * One Xero authorisation can reach several organisations and the token
     * alone does not say which. A missing tenant id is not a request that
     * fails, it is a request that could go to the wrong company's books.
     */
    expect(() => createXeroProvider({ baseUrl: "https://xero.test" }, CREDENTIAL))
      .toThrow(/tenantId/);
  });
});

/* ------------------------------------------------------------ the token */

describe("the token, and the rotation that ends the connection if dropped", () => {
  it("refreshes before the first call and sends a bearer plus the tenant", async () => {
    const calls: Call[] = [];
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      () => tokenOk,
      () => ({ status: 200, body: { Contacts: [] } }),
    ], calls));

    await provider.findPushed("customer", "key-1");

    expect(calls[0]!.url).toBe("https://token.test");
    expect(calls[0]!.headers["Authorization"])
      .toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(calls[0]!.body).toContain("grant_type=refresh_token");

    expect(calls[1]!.headers["Authorization"]).toBe("Bearer access-token-secret");
    expect(calls[1]!.headers["xero-tenant-id"]).toBe("tenant-9");
  });

  it("hands the rotated refresh token back before it is needed again", async () => {
    /**
     * THE LINE THE WHOLE ADAPTER DEPENDS ON. Xero invalidates the old refresh
     * token the instant one is exchanged, with no grace period. Dropping the
     * new one does not degrade the connection, it ends it: the next refresh
     * presents a token Xero has already retired and the only fix is a human
     * going back through the consent screen.
     */
    const rotated: string[] = [];
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {
      onCredentialRotated: async (credential) => { rotated.push(credential); },
    }, transportFor([
      () => ({
        status: 200,
        body: { access_token: "a", expires_in: 1800, refresh_token: "refresh-token-the-second" },
      }),
      () => ({ status: 200, body: { Contacts: [] } }),
    ], []));

    await provider.findPushed("customer", "key-1");

    expect(rotated).toHaveLength(1);
    const saved = JSON.parse(rotated[0]!) as Record<string, string>;
    expect(saved["refreshToken"]).toBe("refresh-token-the-second");
    // All three fields together, so one write replaces the whole credential.
    expect(saved["clientId"]).toBe("client-id");
    expect(saved["clientSecret"]).toBe("client-secret");
  });

  it("does not write the credential back when it did not change", async () => {
    const rotated: string[] = [];
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {
      onCredentialRotated: async (credential) => { rotated.push(credential); },
    }, transportFor([
      () => ({
        status: 200,
        body: { access_token: "a", expires_in: 1800, refresh_token: "refresh-token-secret" },
      }),
      () => ({ status: 200, body: { Contacts: [] } }),
    ], []));

    await provider.findPushed("customer", "key-1");
    expect(rotated).toEqual([]);
  });

  it("keeps the refresh token out of the error when a refresh fails", async () => {
    /**
     * Xero echoes request parameters in some token failures, and the request
     * parameter here is the refresh token. An error message is the most
     * widely copied string in any system: logs, support tickets, screenshots
     * in a chat. A status code says as much as is safe to say.
     */
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      () => ({
        status: 400,
        body: { error: "invalid_grant", refresh_token: "refresh-token-secret" },
      }),
    ], []));

    await expect(provider.findPushed("customer", "k")).rejects.toThrow(/HTTP 400/);
    await expect(provider.findPushed("customer", "k")).rejects.not.toThrow(/refresh-token-secret/);
  });

  it("refreshes once and retries when a token goes stale mid-flight", async () => {
    const calls: Call[] = [];
    let served = 0;
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      (call) => {
        if (call.url === "https://token.test") return tokenOk;
        served += 1;
        return served === 1
          ? { status: 401, body: "" }
          : { status: 200, body: { Contacts: [{ ContactID: "c-1" }] } };
      },
    ], calls));

    const result = await provider.findPushed("customer", "key-1");
    expect(result.ok && result.value?.externalId).toBe("c-1");
    // Token, 401, token again, success.
    expect(calls.filter((c) => c.url === "https://token.test")).toHaveLength(2);
  });

  it("gives up after one retry rather than looping on a 401 that never clears", async () => {
    /**
     * THE TEST ABOVE CANNOT TELL ONE RETRY FROM AN ENDLESS ONE, which is how
     * a deliberate breakage found this gap: changing the retry guard from
     * `false` to `true` left it green, because its transport answers 401
     * exactly once and then succeeds whatever the caller does.
     *
     * A credential that is genuinely wrong answers 401 every time. Looping on
     * that is a worker spinning on the token endpoint, which is also the
     * fastest way to spend a rate limit on nothing, so it has to terminate
     * and say so.
     *
     * The transport throws past a small ceiling so a broken version fails
     * loudly here rather than hanging until the suite times out.
     */
    const calls: Call[] = [];
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      (call) => {
        if (calls.length > 6) throw new Error("the adapter is looping on a 401");
        return call.url === "https://token.test" ? tokenOk : { status: 401, body: "" };
      },
    ], calls));

    const result = await provider.findPushed("customer", "key-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("401");
    // Token, 401, token, 401, stop. Two attempts at the call and no more.
    expect(calls.filter((c) => c.url !== "https://token.test")).toHaveLength(2);
  });
});

/* ------------------------------------------------------- rate limiting */

describe("which of their four limits a 429 was", () => {
  function on429(problem: string | undefined) {
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      () => tokenOk,
      () => ({
        status: 429,
        body: "",
        headers: {
          "retry-after": "42",
          ...(problem === undefined ? {} : { "x-rate-limit-problem": problem }),
        },
      }),
    ], []));
    return provider.accounts();
  }

  it("calls the daily limit budget exhaustion", async () => {
    const result = await on429("day");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.budgetExhausted).toBe(true);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it("does not call the minute, concurrent or app limits budget exhaustion", async () => {
    /**
     * All three clear in seconds. Reporting them as an exhausted budget would
     * put "wait for the quota window" on an operator's screen and hold the
     * sync back for a condition that has already passed.
     */
    for (const problem of ["minute", "concurrent", "appminute"]) {
      const result = await on429(problem);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.budgetExhausted, problem).toBe(false);
      expect(result.retryable, problem).toBe(true);
    }
  });

  it("assumes the daily limit when Xero does not say which", async () => {
    /**
     * The conservative reading. Guessing "minute" would have a worker hammer
     * a tenant that is actually out for the day, which is how an app gets its
     * whole-app limit cut.
     */
    const result = await on429(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.budgetExhausted).toBe(true);
  });
});

/* ---------------------------------------------------------------- pushing */

describe("pushing a document", () => {
  function pushing(
    response: { status: number; body: unknown },
    calls: Call[] = [],
  ) {
    return createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      () => tokenOk,
      () => response,
    ], calls));
  }

  it("creates with PUT, never with their update-or-create POST", async () => {
    /**
     * THE VERB MATTERS MORE THAN IT LOOKS. On these endpoints Xero's POST is
     * "update or create": a document whose number matches an existing one is
     * OVERWRITTEN. For a bridge whose job is to add documents to somebody's
     * books that is the wrong operation, because a retry or a reused number
     * silently rewrites a document that may already sit in a filed period.
     */
    const calls: Call[] = [];
    const provider = pushing(
      { status: 200, body: { Invoices: [{ InvoiceID: "inv-1" }] } }, calls,
    );
    await provider.pushInvoice(INVOICE);
    expect(calls[1]!.method).toBe("PUT");
  });

  it("asks them to fail loudly rather than returning a mixture", async () => {
    /**
     * `summarizeErrors` defaults to FALSE, and with it Xero answers 200 OK
     * carrying created objects and rejected ones together. The parameter is
     * sent explicitly on every write.
     */
    const calls: Call[] = [];
    const provider = pushing({ status: 200, body: { Invoices: [{ InvoiceID: "i" }] } }, calls);
    await provider.pushInvoice(INVOICE);
    expect(calls[1]!.url).toContain("summarizeErrors=true");
  });

  it("treats a 200 carrying validation errors as a rejection", async () => {
    /**
     * The belt to that parameter's braces. If their default ever changes, or
     * the parameter is ever ignored, the only thing making a rejected
     * document look like a pushed one is the status line. An adapter that
     * trusted it would store no id, report success, and never try again.
     */
    const provider = pushing({
      status: 200,
      body: {
        Invoices: [{
          ValidationErrors: [{ Message: "Invoice # must be unique" }],
        }],
      },
    });
    const result = await provider.pushInvoice(INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.duplicate).toBe(true);
    expect(result.message).toContain("must be unique");
  });

  it("recognises their uniqueness complaint as a duplicate", async () => {
    /**
     * Under-matching here costs a second copy of the document in somebody's
     * books on every pass forever; over-matching costs one wasted lookup
     * through findPushed. So this leans towards over-matching on purpose.
     */
    for (const message of [
      "Invoice # must be unique",
      "Contact Name already exists",
      "The Reference has already been used",
    ]) {
      const provider = pushing({
        status: 400,
        body: { Elements: [{ ValidationErrors: [{ Message: message }] }] },
      });
      const result = await provider.pushInvoice(INVOICE);
      expect(result.ok, message).toBe(false);
      if (result.ok) continue;
      expect(result.duplicate, message).toBe(true);
    }
  });

  it("does not call an ordinary rejection a duplicate", async () => {
    const provider = pushing({
      status: 400,
      body: { Elements: [{ ValidationErrors: [{ Message: "Account code 'X' is not valid" }] }] },
    });
    const result = await provider.pushInvoice(INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.duplicate).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("is not valid");
  });

  it("refuses a 200 with no id rather than storing an empty one", async () => {
    /**
     * Not retryable, because the document exists over there and trying again
     * would create a second. The service resolves it through findPushed,
     * which is the whole reason that method is on the seam.
     */
    const provider = pushing({ status: 200, body: { Invoices: [{}] } });
    const result = await provider.pushInvoice(INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_id");
    expect(result.retryable).toBe(false);
    expect(result.duplicate).toBe(true);
  });

  it("sends an idempotency key, inside their 128 character ceiling", async () => {
    const calls: Call[] = [];
    const provider = pushing({ status: 200, body: { Invoices: [{ InvoiceID: "i" }] } }, calls);
    await provider.pushInvoice({ ...INVOICE, idempotencyKey: "k".repeat(200) });
    expect(calls[1]!.headers["Idempotency-Key"]).toHaveLength(128);
  });

  it("marks an invoice authorised, carries the number and the key separately", async () => {
    const calls: Call[] = [];
    const provider = pushing({ status: 200, body: { Invoices: [{ InvoiceID: "inv-1" }] } }, calls);
    const result = await provider.pushInvoice(INVOICE);
    expect(result).toEqual({ ok: true, externalId: "inv-1", version: null, adopted: false });

    const sent = JSON.parse(calls[1]!.body!) as { Invoices: Record<string, unknown>[] };
    const invoice = sent.Invoices[0]!;
    /**
     * DRAFT would not appear on an AR report and could not be matched
     * against a payment, so a bridge that pushed drafts would move documents
     * and reconcile nothing.
     */
    expect(invoice["Status"]).toBe("AUTHORISED");
    expect(invoice["Type"]).toBe("ACCREC");
    // The number is what the customer was shown; the key is what makes a
    // lost response recoverable. An operator renumbering their invoices
    // should not break idempotency, so they are different fields.
    expect(invoice["InvoiceNumber"]).toBe("INV-1042");
    expect(invoice["Reference"]).toBe("key-inv-1");
    expect(invoice["LineAmountTypes"]).toBe("Exclusive");
  });

  it("asks for four decimal places on an invoice", async () => {
    const calls: Call[] = [];
    const provider = pushing({ status: 200, body: { Invoices: [{ InvoiceID: "i" }] } }, calls);
    await provider.pushInvoice(INVOICE);
    expect(calls[1]!.url).toContain("unitdp=4");
  });

  it("stops Xero computing its own tax, and puts ours on its own line", async () => {
    /**
     * Their engine would recompute from the organisation's rate tables, and
     * where that disagrees with the rate frozen on `invoice_line.tax_rate`
     * the books and the document the customer received would differ. The
     * invoice the customer holds is the authority.
     */
    const calls: Call[] = [];
    const provider = pushing({ status: 200, body: { Invoices: [{ InvoiceID: "i" }] } }, calls);
    await provider.pushInvoice(INVOICE);

    const sent = JSON.parse(calls[1]!.body!) as {
      Invoices: { LineItems: Record<string, unknown>[] }[];
    };
    const lines = sent.Invoices[0]!.LineItems;
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line["TaxType"]).toBe("NONE");
    expect(lines[1]!["AccountID"]).toBe("acct-tax");
    expect(lines[1]!["LineAmount"]).toBe(99);
  });

  it("puts a mapped item in ItemCode and a mapped account in AccountID", async () => {
    /**
     * Which field the operator's choice goes in is the adapter's knowledge
     * and nothing else's, which is why the mapping stores the kind of object
     * alongside the id.
     */
    const calls: Call[] = [];
    const provider = pushing({ status: 200, body: { Invoices: [{ InvoiceID: "i" }] } }, calls);
    await provider.pushInvoice({
      ...INVOICE,
      tax: null,
      lines: [{ ...INVOICE.lines[0]!, accountExternalKind: "Item", accountExternalId: "SERVICE-CALL" }],
    });
    const sent = JSON.parse(calls[1]!.body!) as {
      Invoices: { LineItems: Record<string, unknown>[] }[];
    };
    expect(sent.Invoices[0]!.LineItems[0]!["ItemCode"]).toBe("SERVICE-CALL");
    expect(sent.Invoices[0]!.LineItems[0]!["AccountID"]).toBeUndefined();
  });

  it("writes the key into a contact's name, which is what Xero can be filtered on", async () => {
    const calls: Call[] = [];
    const provider = pushing({ status: 200, body: { Contacts: [{ ContactID: "c-1" }] } }, calls);
    await provider.pushCustomer({
      idempotencyKey: "Acme Plumbing [ot-9f3]", name: "Acme Plumbing",
      email: "ops@acme.test", phone: "+15125550100",
    });
    const sent = JSON.parse(calls[1]!.body!) as { Contacts: Record<string, unknown>[] };
    expect(sent.Contacts[0]!["Name"]).toBe("Acme Plumbing [ot-9f3]");
    expect(sent.Contacts[0]!["IsCustomer"]).toBe(true);
  });
});

/* ------------------------------------------------------------- payments */

describe("a payment, which is the one place Xero forced a decision", () => {
  const PAYMENT = {
    idempotencyKey: "key-pay-1",
    customerExternalId: "contact-1",
    receivedOn: "2026-03-05",
    amount: { amount: "1500.0000", currency: "USD" },
    depositAccountExternalId: "acct-bank",
    allocations: [
      { invoiceExternalId: "inv-1", amount: { amount: "1000.0000", currency: "USD" } },
      { invoiceExternalId: "inv-2", amount: { amount: "500.0000", currency: "USD" } },
    ],
  };

  function pushing(response: { status: number; body: unknown }, calls: Call[] = []) {
    return createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      () => tokenOk, () => response,
    ], calls));
  }

  it("applies one receipt across several invoices as one batch payment", async () => {
    /**
     * A Xero `Payment` references exactly ONE invoice, and our payment row
     * carries allocations across several because M13 applies a receipt to the
     * oldest balance first. Creating N payments and returning the first id
     * would leave the link table naming one of N documents with nothing
     * anywhere saying the others exist, and a reconciliation built on that
     * link is wrong and looks right.
     */
    const calls: Call[] = [];
    const provider = pushing(
      { status: 200, body: { BatchPayments: [{ BatchPaymentID: "batch-1" }] } }, calls,
    );
    const result = await provider.pushPayment(PAYMENT);
    expect(result.ok && result.externalId).toBe("batch-1");

    expect(calls[1]!.url).toContain("/BatchPayments");
    const sent = JSON.parse(calls[1]!.body!) as {
      BatchPayments: { Account: Record<string, string>; Payments: Record<string, unknown>[] }[];
    };
    const batch = sent.BatchPayments[0]!;
    expect(batch.Account["AccountID"]).toBe("acct-bank");
    expect(batch.Payments).toHaveLength(2);
    expect(batch.Payments[0]!["Amount"]).toBe(1000);
    expect(batch.Payments[1]!["Amount"]).toBe(500);
  });

  it("uses a batch of one for a single invoice too", async () => {
    /**
     * Rather than a plain Payment, because mixing the two would put
     * `PaymentID` and `BatchPaymentID` in the same column and `findPushed`
     * could not know which endpoint to ask. One of ours is always one of
     * theirs.
     */
    const calls: Call[] = [];
    const provider = pushing(
      { status: 200, body: { BatchPayments: [{ BatchPaymentID: "batch-2" }] } }, calls,
    );
    await provider.pushPayment({ ...PAYMENT, allocations: [PAYMENT.allocations[0]!] });
    expect(calls[1]!.url).toContain("/BatchPayments");
    expect(calls[1]!.url).not.toContain("/Payments?");
  });

  it("looks a payment up on the batch endpoint, with the key in Reference", async () => {
    const calls: Call[] = [];
    const provider = pushing(
      { status: 200, body: { BatchPayments: [{ BatchPaymentID: "batch-1" }] } }, calls,
    );
    await provider.findPushed("payment", "key-pay-1");
    expect(decodeURIComponent(calls[1]!.url)).toContain('BatchPayments?where=Reference=="key-pay-1"');
  });
});

/* ------------------------------------------------------------ findPushed */

describe("finding a document whose response was lost", () => {
  function looking(response: { status: number; body: unknown }, calls: Call[] = []) {
    return createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      () => tokenOk, () => response,
    ], calls));
  }

  it("filters on the field the key was written into, per kind", async () => {
    const cases: [Parameters<ReturnType<typeof looking>["findPushed"]>[0], string][] = [
      ["customer", 'Contacts?where=Name=="k"'],
      ["invoice", 'Invoices?where=InvoiceNumber=="k"'],
      ["credit_memo", 'CreditNotes?where=CreditNoteNumber=="k"'],
    ];
    for (const [kind, expected] of cases) {
      const calls: Call[] = [];
      await looking({ status: 200, body: {} }, calls).findPushed(kind, "k");
      expect(decodeURIComponent(calls[1]!.url), kind).toContain(expected);
    }
  });

  it("answers null when Xero does not have one", async () => {
    const result = await looking({ status: 200, body: { Invoices: [] } })
      .findPushed("invoice", "k");
    expect(result).toEqual({ ok: true, value: null });
  });

  it("fails rather than answering null when the key cannot be expressed", async () => {
    /**
     * THE DISTINCTION THIS TEST EXISTS FOR. `null` means "Xero does not have
     * one", and answering that for a question nobody managed to ask would
     * have the service create a second document. A lookup that could not be
     * built is a failure, and it is not retryable because retrying produces
     * the same unquotable key.
     */
    const calls: Call[] = [];
    const result = await looking({ status: 200, body: {} }, calls)
      .findPushed("customer", 'Bob "The Pipe" Smith');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unquotable_key");
    expect(result.retryable).toBe(false);
    // And nothing was sent: not even a token was fetched for it.
    expect(calls).toEqual([]);
  });
});

/* -------------------------------------------------------------- changes */

describe("the change window, which has no cursor behind it", () => {
  const BATCH = { status: 200, body: {} };

  function changing(
    script: ((call: Call) => { status: number; body: unknown; headers?: Record<string, string> })[],
    calls: Call[] = [],
  ) {
    return createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor(
      [() => tokenOk, ...script], calls,
    ));
  }

  it("sends the window as the header Xero actually reads", async () => {
    /**
     * `If-Modified-Since` is a header on these endpoints and there is no
     * query parameter equivalent. A window sent as a parameter is silently
     * ignored, and an ignored window means every pass reads the whole
     * organisation and reports all of it as changed: a sync that looks busy
     * and is wrong about everything.
     */
    const calls: Call[] = [];
    await changing([() => BATCH], calls).changes("2026-03-01T00:00:00.000Z");
    expect(calls[1]!.headers["If-Modified-Since"]).toBe("2026-03-01T00:00:00.000Z");
  });

  it("asks each of the four endpoints once when every page is short", async () => {
    const calls: Call[] = [];
    await changing([() => BATCH], calls).changes(null);
    const paths = calls.slice(1).map((c) => new URL(c.url).pathname);
    expect(paths).toEqual(["/Contacts", "/Invoices", "/BatchPayments", "/CreditNotes"]);
  });

  it("starts a first sync inside a bounded window, not at the beginning of time", async () => {
    /**
     * The bound is OURS, not Xero's: they will happily answer
     * `If-Modified-Since: 1970`, and doing that on a ten year old
     * organisation is the most expensive request available against a five
     * thousand call daily ceiling. Connecting Xero picks up changes from
     * here; it does not import history.
     */
    const calls: Call[] = [];
    const before = Date.now();
    await changing([() => BATCH], calls).changes(null);
    const sent = new Date(calls[1]!.headers["If-Modified-Since"]!).getTime();
    const days = (before - sent) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("takes the next window from Xero's clock, not from the newest record", async () => {
    /**
     * THE FAILURE THIS WHOLE BLOCK EXISTS FOR, and the only one here that is
     * both silent and permanent.
     *
     * A document written DURING the request carries a timestamp inside the
     * window just read. A cursor built from the newest `UpdatedDateUTC` in
     * the page steps over it and loses it forever. So the next window starts
     * before this pass went out, taken from their `Date` header so the
     * boundary sits in their clock: ours running a minute fast would skip a
     * minute of changes on every pass with nothing ever reporting it.
     */
    const result = await changing([() => ({
      status: 200,
      headers: { date: "Tue, 03 Mar 2026 09:00:00 GMT" },
      body: {
        Invoices: [{
          InvoiceID: "inv-1",
          Status: "AUTHORISED",
          // Newer than the server date, which is exactly the case a
          // data-derived cursor gets wrong.
          UpdatedDateUTC: "/Date(1900000000000)/",
        }],
      },
    })]).changes(null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cursor).toBe("2026-03-03T09:00:00.000Z");
  });

  it("falls back to its own start time when Xero sends no date", async () => {
    const before = Date.now();
    const result = await changing([() => BATCH]).changes(null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cursor = new Date(result.value.cursor).getTime();
    expect(cursor).toBeGreaterThanOrEqual(before - 1000);
    expect(cursor).toBeLessThanOrEqual(Date.now());
  });

  it("reads their date format on each change", async () => {
    const result = await changing([(call) => (
      new URL(call.url).pathname === "/Invoices"
        ? {
          status: 200,
          body: {
            Invoices: [{
              InvoiceID: "inv-1", Status: "AUTHORISED",
              UpdatedDateUTC: "/Date(1573755038314)/",
            }],
          },
        }
        : BATCH
    )]).changes(null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const change = result.value.changes.find((c) => c.externalId === "inv-1")!;
    expect(change.changedAt.toISOString()).toBe("2019-11-14T18:10:38.314Z");
    expect(change.kind).toBe("invoice");
  });

  it("reports a deleted or voided document as gone", async () => {
    for (const status of ["DELETED", "VOIDED"]) {
      const result = await changing([(call) => (
        new URL(call.url).pathname === "/Invoices"
          ? { status: 200, body: { Invoices: [{ InvoiceID: "i", Status: status }] } }
          : BATCH
      )]).changes(null);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.changes[0]?.deleted, status).toBe(true);
    }
  });

  it("does not report an archived contact as gone", async () => {
    /**
     * ARCHIVED is a contact the organisation no longer uses and still has.
     * Calling it deleted would have our side drop a customer who is merely
     * out of date, which for a company whose customer went quiet for a year
     * is their history disappearing. GDPRREQUEST is one Xero has erased, and
     * that one is gone.
     */
    const result = await changing([(call) => (
      new URL(call.url).pathname === "/Contacts"
        ? {
          status: 200,
          body: {
            Contacts: [
              { ContactID: "c-archived", ContactStatus: "ARCHIVED" },
              { ContactID: "c-erased", ContactStatus: "GDPRREQUEST" },
            ],
          },
        }
        : BATCH
    )]).changes(null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.changes.map((c) => [c.externalId, c.deleted]));
    expect(byId.get("c-archived")).toBe(false);
    expect(byId.get("c-erased")).toBe(true);
  });

  it("pages a full result and stops at the ceiling with more still to come", async () => {
    /**
     * A ceiling rather than a loop to exhaustion, because the daily limit is
     * shared with the push half of the sync. A first pass that drained the
     * whole allowance reading would leave nothing to push invoices with, and
     * the symptom would be an empty Xero with reads as the cause.
     */
    const calls: Call[] = [];
    const full = Array.from({ length: 100 }, (_, i) => ({
      InvoiceID: `inv-${i}`, Status: "AUTHORISED",
    }));
    const result = await changing([(call) => (
      new URL(call.url).pathname === "/Invoices"
        ? { status: 200, body: { Invoices: full } }
        : { status: 200, body: {} }
    )], calls).changes(null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.more).toBe(true);
    const invoicePages = calls.filter((c) => new URL(c.url).pathname === "/Invoices");
    expect(invoicePages).toHaveLength(5);
    expect(invoicePages.map((c) => new URL(c.url).searchParams.get("page")))
      .toEqual(["1", "2", "3", "4", "5"]);
  });

  it("stops on a short page without claiming there is more", async () => {
    const calls: Call[] = [];
    const result = await changing([(call) => (
      new URL(call.url).pathname === "/Invoices"
        ? { status: 200, body: { Invoices: [{ InvoiceID: "i", Status: "AUTHORISED" }] } }
        : { status: 200, body: {} }
    )], calls).changes(null);
    expect(result.ok && result.value.more).toBe(false);
    expect(calls.filter((c) => new URL(c.url).pathname === "/Invoices")).toHaveLength(1);
  });

  it("refuses a resume point that is not a time rather than reading everything", async () => {
    /**
     * The alternative is `new Date("nonsense")`, which is Invalid Date, which
     * serialises to an `If-Modified-Since` Xero ignores. An ignored window is
     * a full scan of the organisation reported as all-changed, which is the
     * single most expensive mistake this method can make.
     */
    const result = await changing([() => BATCH]).changes("not a time");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("bad_cursor");
    expect(result.retryable).toBe(false);
  });

  it("resumes from a cursor in their own date format as well as ISO", async () => {
    const calls: Call[] = [];
    await changing([() => BATCH], calls).changes("/Date(1573755038314)/");
    expect(calls[1]!.headers["If-Modified-Since"]).toBe("2019-11-14T18:10:38.314Z");
  });
});

/* ------------------------------------------------------- the chart of accounts */

describe("the mapping screen's list", () => {
  it("offers accounts and items, with their own numbers where they keep one", async () => {
    const provider = createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
      () => tokenOk,
      () => ({
        status: 200,
        body: {
          Accounts: [
            { AccountID: "a-1", Name: "Sales", Code: "200", Type: "REVENUE", Status: "ACTIVE" },
            { AccountID: "a-2", Name: "Old sales", Code: "201", Type: "REVENUE", Status: "ARCHIVED" },
            { AccountID: "a-3", Name: "Business account", Code: "090", Type: "BANK", Status: "ACTIVE" },
          ],
        },
      }),
      () => ({ status: 200, body: { Items: [{ Code: "SERVICE-CALL", Name: "Service call" }] } }),
    ], []));

    const result = await provider.accounts();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.value.map((a) => [a.externalId, a]));
    expect(byId.get("a-1")).toMatchObject({ classification: "income", number: "200", active: true });
    expect(byId.get("a-2")?.active).toBe(false);
    expect(byId.get("a-3")?.classification).toBe("asset");
    /**
     * An item is referenced by its CODE in Xero, not by a uuid, which is why
     * `ExternalAccount.externalId` is a string on the seam rather than a
     * uuid. An adapter that put a uuid here would make every item unusable.
     */
    expect(byId.get("SERVICE-CALL")).toMatchObject({ kind: "Item", classification: "income" });
  });

  it("sorts their account types onto the five the screen groups by", async () => {
    const cases: [string, string][] = [
      ["REVENUE", "income"], ["SALES", "income"], ["OTHERINCOME", "income"],
      ["DIRECTCOSTS", "expense"], ["OVERHEADS", "expense"],
      ["BANK", "asset"], ["FIXED", "asset"],
      ["CURRLIAB", "liability"], ["TERMLIAB", "liability"],
      ["EQUITY", "equity"],
      ["SOMETHING-NEW", "other"],
    ];
    for (const [type, expected] of cases) {
      const provider = createXeroProvider(SETTINGS, CREDENTIAL, {}, transportFor([
        () => tokenOk,
        () => ({ status: 200, body: { Accounts: [{ AccountID: "a", Name: "n", Type: type }] } }),
        () => ({ status: 200, body: { Items: [] } }),
      ], []));
      const result = await provider.accounts();
      expect(result.ok, type).toBe(true);
      if (!result.ok) continue;
      expect(result.value[0]!.classification, type).toBe(expected);
    }
  });
});

/* ------------------------------------------------------------- the seam */

describe("the seam this adapter was built to test", () => {
  it("is reachable by name, with nothing importing the file", () => {
    expect(registeredProviders()).toContain("xero");
    expect(registeredProviders()).toContain("quickbooks");
    expect(createProvider("xero", SETTINGS, CREDENTIAL).name).toBe("xero");
  });

  it("required no change to the sync, which is the claim worth checking", async () => {
    /**
     * `provider.ts` says a self hoster adding Xero writes one file and
     * nothing in `services/accounting.ts` gains a branch. Asserted by reading
     * the service for a provider name in a string literal, which is the only
     * form a branch on one can take, rather than by saying so in a commit
     * message.
     *
     * A MENTION IS ALLOWED AND A LITERAL IS NOT. The first version of this
     * test, in the JustCall suite next door, refused any occurrence and went
     * red on a comment using a vendor as a worked example, which would be a
     * test that stops the codebase explaining itself.
     */
    const { readFile } = await import("node:fs/promises");
    const service = await readFile(
      new URL("../src/services/accounting.ts", import.meta.url), "utf8",
    );
    expect(service).not.toMatch(/["'`](xero|quickbooks)["'`]/i);
    expect(service).not.toMatch(/from\s+["'][^"']*accounting\/(xero|quickbooks)["']/i);
  });
});
