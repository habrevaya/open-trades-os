/**
 * THE ACCOUNTING PROVIDER SEAM
 *
 * Same shape and same reason as `src/comms/provider.ts`: the product knows
 * about "this invoice belongs in the books" and nothing about QuickBooks, and
 * a self hoster who runs Xero writes an adapter rather than editing the sync.
 * Nothing under `src/services` names a provider.
 *
 * The interface below is shaped by one fact that is specific to this
 * capability and that governs every decision in this directory.
 *
 * INTUIT'S 2026 METERING CHARGES FOR READS, NOT WRITES, AND REFUSES THE
 * OVERAGE WITH A 429 RATHER THAN BILLING IT.
 *
 * Every consequence follows from that sentence:
 *
 *   - There is no `getInvoice`, no `listInvoices`, and no "does this already
 *     exist" method that the sync calls on the normal path. A sync that
 *     checks the remote system before every push spends one metered read per
 *     document per pass, which for a company issuing four hundred invoices a
 *     month is a wall it cannot pay through. Whether we have already pushed
 *     something is answered from `accounting_entity_link`, locally, for free.
 *
 *   - Inbound is `changes()` over an opaque resume point, never a scan from
 *     the beginning. QuickBooks has a real change feed at `/cdc`, which
 *     returns only what moved since an instant and issues the next resume
 *     point itself.
 *
 *     THIS COMMENT USED TO SAY "BOTH QUICKBOOKS AND XERO EXPOSE ONE" AND
 *     XERO DOES NOT. It has `If-Modified-Since` and nothing else: a
 *     timestamp window, no server-issued token, no change feed. The claim
 *     was written before the Xero adapter existed and the adapter is what
 *     disproved it; it is corrected here rather than left standing, because
 *     a sentence in the file somebody reads to find out what is true is
 *     exactly where a wrong one does damage.
 *
 *     The method survives unchanged, because what it actually requires is
 *     weaker than what the old comment claimed: the resume point is an
 *     OPAQUE STRING the service stores and hands back without reading. A
 *     cursor satisfies that and so does a timestamp, and the adapter is
 *     where the difference lives. What a timestamp costs is a boundary the
 *     adapter has to get right, and `accounting/xero.ts` says how.
 *
 *   - Every read returns a RESULT, not a thrown error, and the result has a
 *     `budgetExhausted` arm. Running out of reads is an ordinary state of a
 *     metered API. Modelling it as an exception means a worker either dies on
 *     it or catches it by string matching, and both of those turn a condition
 *     that clears by waiting into an outage.
 *
 * What breaks if this is ignored: the sync polls, Intuit starts answering
 * 429, the worker throws on the 429, the pass dies before it reaches the
 * outbound half, invoices stop reaching the books entirely, and the only
 * symptom anybody sees is that the accountant's QuickBooks is a week stale.
 * The failure is silent, it is total, and it is caused by reading too much.
 */

/**
 * The kinds of thing this bridge moves.
 *
 * Closed rather than open, because each one has a distinct posting meaning
 * and a provider has to be told which it is. An open string would let a
 * caller invent `"refund"` and have an adapter quietly ignore it.
 */
export type AccountingEntityKind =
  | "customer" | "invoice" | "payment" | "credit_memo" | "refund"
  | "credit_note" | "credit_note_application" | "credit_note_void" | "credit_note_refund" | "journal";

/** ISO 4217, carried on every amount for the same reason the schema carries it. */
export interface ExternalMoney {
  /** A decimal string. Never a float: see packages/core/src/money. */
  amount: string;
  currency: string;
}

export interface ExternalCustomer {
  /**
   * The deterministic marker, written into a field the provider can be
   * queried on, so a push whose response was lost can be found again. See
   * `findPushed`.
   */
  idempotencyKey: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface ExternalInvoiceLine {
  description: string;
  quantity: string;
  unitPrice: ExternalMoney;
  amount: ExternalMoney;
  /**
   * The provider id this line's revenue lands on, already resolved from the
   * account mapping by the service.
   *
   * RESOLVED BY THE SERVICE, NOT BY THE ADAPTER, and that is deliberate. An
   * adapter that looked the account up would have to read the remote chart of
   * accounts to do it, which is the metered operation, and it would do it once
   * per line. The mapping is a local table precisely so that this is a join.
   */
  accountExternalId: string;
  /** What kind of object that id names over there: "Item", "Account". */
  accountExternalKind: string;
}

export interface ExternalInvoice {
  idempotencyKey: string;
  /** The provider's id for the customer, from a customer push that already ran. */
  customerExternalId: string;
  /** Our invoice number. Goes on the document so a bookkeeper can match it. */
  documentNumber: string;
  issuedOn: string;
  dueOn: string | null;
  currency: string;
  lines: ExternalInvoiceLine[];
  /** Total tax as one figure, with the account it is owed to. */
  tax: { amount: ExternalMoney; accountExternalId: string } | null;
  memo: string | null;
}

export interface ExternalPayment {
  idempotencyKey: string;
  customerExternalId: string;
  receivedOn: string;
  amount: ExternalMoney;
  /** Where the money landed: the mapped id for our cash account. */
  depositAccountExternalId: string;
  /**
   * Which documents it paid and how much of each.
   *
   * Applied rather than left unapplied, because an unapplied credit sitting
   * on a customer in QuickBooks looks exactly like an overpayment and the
   * receivable it was meant to clear stays open.
   */
  allocations: { invoiceExternalId: string; amount: ExternalMoney }[];
}

/**
 * Money given back against a payment that is already in the books.
 *
 * What our ledger posts for it is the whole specification: cash out, and the
 * customer's receivable back up by the part that had been applied to
 * invoices (`appliedAmount`) and their held credit down by the part that had
 * not (`heldAmount`). Revenue does not move. Revenue moves only if the
 * reopened invoice is then voided or written off, and that already reaches
 * the books as its own credit note, so an adapter that also reduced revenue
 * here would reduce it twice.
 */
export interface ExternalRefund {
  idempotencyKey: string;
  customerExternalId: string;
  /** The payment it comes back out of, as the books know it. */
  paymentExternalId: string;
  refundedOn: string;
  /** All of it: `appliedAmount` plus `heldAmount`. */
  amount: ExternalMoney;
  appliedAmount: ExternalMoney;
  heldAmount: ExternalMoney;
  /** The mapped id for our cash account, where the money left from. */
  bankAccountExternalId: string;
  /** Our receivable account's mapping, when there is one. */
  receivableAccountExternalId: string | null;
  /** Our customer deposits account's mapping, when there is one. */
  clearingAccountExternalId: string | null;
  memo: string;
}

export interface ExternalCredit {
  idempotencyKey: string;
  customerExternalId: string;
  issuedOn: string;
  amount: ExternalMoney;
  /** Where the reduction in revenue lands. A write-off is an expense, not a
   *  smaller sale: see ACCOUNTS.WRITE_OFF in packages/core/src/ledger. */
  accountExternalId: string;
  reason: string;
}

/**
 * A credit note this company issued: money taken off what a customer owes,
 * line by line, at the tax each line charged.
 *
 * Shaped like `ExternalInvoice` on purpose, because it is the same document
 * pointing the other way. Its lines land on the revenue account the ledger
 * debited when the credit note was issued, resolved by the service exactly as
 * an invoice's lines are, and its tax on the mapped tax account. Not
 * `ExternalCredit`, which is one line against the write off account: a void
 * or a write off is a loss, and a credit note is a smaller sale.
 */
export interface ExternalCreditNote {
  idempotencyKey: string;
  customerExternalId: string;
  /** Our credit note number, prefixed, which is also the key. */
  documentNumber: string;
  issuedOn: string;
  currency: string;
  lines: ExternalInvoiceLine[];
  tax: { amount: ExternalMoney; accountExternalId: string } | null;
  memo: string | null;
}

/**
 * A credit note put against an invoice, both of which are already in the
 * books.
 *
 * Separate from the credit note rather than carried on it, because a credit
 * is often issued before the invoice it ends up settling exists, and applied
 * in parts on different days. Each application is a dated fact of its own.
 */
export interface ExternalCreditApplication {
  idempotencyKey: string;
  customerExternalId: string;
  creditNoteExternalId: string;
  invoiceExternalId: string;
  appliedOn: string;
  amount: ExternalMoney;
}

/**
 * Credit on a credit note already in the books, paid out to the customer as
 * money: to their card or by cash or cheque. Our ledger posts customer
 * deposits down and cash down, and no invoice moves; over there the credit
 * note's unused credit is what goes, out of the bank.
 */
export interface ExternalCreditNoteRefund {
  idempotencyKey: string;
  customerExternalId: string;
  creditNoteExternalId: string;
  paidOn: string;
  amount: ExternalMoney;
  /** The mapped id for our cash account, where the money left from. */
  bankAccountExternalId: string;
  /** Our receivable account's mapping, when there is one. */
  receivableAccountExternalId: string | null;
  memo: string;
}

/**
 * A manual journal an accountant posted here: lines on accounts, each a debit
 * or a credit, balanced.
 *
 * The one thing this bridge sends that is not a document, and the comment on
 * `pushInvoice` says why the sync does not push postings: a journal in the
 * books does not age as a receivable or match a deposit. A manual journal has
 * no document behind it in either system, so a journal is exactly what it
 * is, over there as here. Every account is resolved from the mapping by the
 * service, and a journal with an unmapped account is refused by name.
 */
export interface ExternalJournal {
  idempotencyKey: string;
  /** Our journal number, for a bookkeeper matching it by eye. */
  number: number;
  postedOn: string;
  currency: string;
  memo: string;
  lines: { accountExternalId: string; direction: "debit" | "credit"; amount: ExternalMoney; description: string | null }[];
}

/** What the provider gave the thing we pushed. */
export interface ExternalRef {
  externalId: string;
  /** The provider's optimistic concurrency token, if it has one. */
  version: string | null;
}

export type PushResult =
  | ({ ok: true } & ExternalRef & {
    /**
     * True when the provider recognised the document as one it already had
     * rather than creating a second one.
     *
     * Separate from `ok` because the service records it differently: an
     * adoption means our local link table had drifted from the books, which
     * is worth counting, and it is NOT a write against the write quota.
     */
    adopted: boolean;
  })
  | {
    ok: false;
    code: string;
    message: string;
    /**
     * Same argument as `SendResult.retryable` in the comms seam. A throttle
     * and a rejected document both fail, and retrying the second one forever
     * is how a queue stops being a queue.
     */
    retryable: boolean;
    /**
     * The provider says a document like this one is already there. The
     * service answers this by asking `findPushed` for its id rather than by
     * giving up, because the alternative is an invoice that exists in the
     * books and is permanently unlinked in ours.
     */
    duplicate: boolean;
  };

/**
 * A read that may simply not be affordable right now.
 *
 * `budgetExhausted` is separate from `retryable` on purpose. Both mean "try
 * later", but only one of them means "and do not count this as a failure",
 * and the difference is what an operator sees on the sync screen: a metered
 * API that has run out for the hour is not a broken connection.
 */
export type ReadResult<T> =
  | { ok: true; value: T }
  | {
    ok: false;
    code: string;
    message: string;
    retryable: boolean;
    budgetExhausted: boolean;
    /** From the provider's own Retry-After, when it sent one. */
    retryAfterSeconds: number | null;
  };

/** One thing that moved over there since the cursor. */
export interface ExternalChange {
  kind: AccountingEntityKind;
  externalId: string;
  version: string | null;
  /** The provider says this document is gone. Ours must stop claiming it exists. */
  deleted: boolean;
  changedAt: Date;
}

export interface ChangeSet {
  /**
   * The cursor to store and resume from.
   *
   * Returned by the provider rather than computed by us. Deriving it from the
   * newest `changedAt` we saw looks equivalent and is not: a document written
   * during the request, with a timestamp inside the page we just read, is
   * skipped forever by a cursor built that way.
   */
  cursor: string;
  changes: ExternalChange[];
  /** The provider has more beyond this page. The next pass resumes immediately. */
  more: boolean;
}

/** A thing an account code can be mapped onto. */
export interface ExternalAccount {
  externalId: string;
  name: string;
  /** The provider's own object type: "Account", "Item". */
  kind: string;
  /** Normalized enough to sort a picker by, and no further. */
  classification: "income" | "expense" | "asset" | "liability" | "equity" | "other";
  /** The operator's own account number over there, when they keep one. */
  number: string | null;
  active: boolean;
}

/**
 * THE INTERFACE.
 *
 * Eleven methods, and the argument for each is the comment above it. The test
 * a new method has to pass before it is added: could Xero and Sage both
 * implement it without the service having to know which one it is talking to.
 */
export interface AccountingProvider {
  readonly name: string;

  /**
   * A customer, pushed first because an invoice cannot reference one that is
   * not there yet.
   *
   * Separate from `pushInvoice` rather than nested inside it, so the customer
   * gets its own row in the link table. Nesting would make an invoice retry
   * push the customer again, and a provider that does not dedupe on name
   * would then hold two of them with one invoice each.
   */
  pushCustomer(customer: ExternalCustomer): Promise<PushResult>;

  /**
   * An invoice. The unit a bookkeeper reconciles, so it is the unit here.
   *
   * We do not push our ledger postings directly, even though they are the
   * authoritative record, because a journal entry in QuickBooks does not age
   * on an AR report and cannot be matched against a bank deposit. The books
   * want documents.
   */
  pushInvoice(invoice: ExternalInvoice): Promise<PushResult>;

  /**
   * A payment, WITH its allocations.
   *
   * Allocation is part of the payment rather than a separate call because it
   * is not separable: a payment that lands unapplied has already produced the
   * wrong AR aging by the time a second call fixes it, and if the second call
   * never happens nothing anywhere says so.
   */
  pushPayment(payment: ExternalPayment): Promise<PushResult>;

  /**
   * A credit note. What a void or a write-off looks like over there.
   *
   * Not a delete and not an edit, for the same reason `ledger_entry` is
   * append only: a document that has been sent to a customer and reported in
   * a filed period is corrected by a new document, never by changing the old
   * one. Every accounting system in this class models it this way, so it is
   * in the interface rather than in an adapter.
   */
  pushCredit(credit: ExternalCredit): Promise<PushResult>;

  /**
   * A refund of a payment already in the books. See `ExternalRefund` for
   * what it must post; how is the adapter's, because the two systems allow
   * different documents to touch a receivable.
   */
  pushRefund(refund: ExternalRefund): Promise<PushResult>;

  /**
   * A credit note, as the provider's own credit document: a CreditMemo in
   * QuickBooks, an ACCRECCREDIT credit note in Xero. It lands unapplied, as
   * credit the customer holds, because that is what issuing one does here:
   * applying it is `pushCreditApplication`, a separate dated act.
   *
   * Taking one back is NOT a method of its own. It goes as `pushInvoice` for
   * the same lines dated the day of the void, then `pushCreditApplication`
   * settling the two, for the reason given above `pushOutbound` in the sync.
   */
  pushCreditNote(note: ExternalCreditNote): Promise<PushResult>;

  /**
   * A manual journal. OPTIONAL: a book that cannot take one leaves it out,
   * and the sync then leaves journals here and says so on the problems list
   * rather than sending them some other way.
   */
  pushJournal?(journal: ExternalJournal): Promise<PushResult>;

  /** One credit note against one invoice, by an amount, on a date. */
  pushCreditApplication(application: ExternalCreditApplication): Promise<PushResult>;

  /**
   * Credit on a credit note paid out as money. See `ExternalCreditNoteRefund`.
   * OPTIONAL, as a journal is: a book that cannot take one leaves it out, and
   * the sync then says so on the problems list for each payout rather than
   * sending it some other way.
   */
  pushCreditNoteRefund?(refund: ExternalCreditNoteRefund): Promise<PushResult>;

  /**
   * "Did this application already land?", for the crash window only.
   *
   * Its own method rather than `findPushed`, because an application is not a
   * document every provider can be searched for by a key. QuickBooks can,
   * through the reference on the zero payment. A Xero allocation carries no
   * reference at all, so the only way to find one is to read the credit note
   * it hangs off and match it by invoice, amount and date, which needs the
   * whole application rather than its key. `taken` is the external ids this
   * connection has already linked, so two identical applications on one day
   * cannot both claim the same allocation.
   */
  findCreditApplication(
    application: ExternalCreditApplication, taken: string[],
  ): Promise<ReadResult<ExternalRef | null>>;

  /**
   * Whether money a payment held unapplied reached the books with it.
   * QuickBooks takes a payment larger than its lines and holds the rest as
   * the customer's credit; a Xero batch payment carries only what is
   * applied. A refund of held money is sent only where the money went.
   */
  readonly heldMoneyReachesBooks: boolean;

  /**
   * "Did a document carrying this key already land?"
   *
   * THE ONLY READ ON THE PUSH PATH, and it is called only to close the crash
   * window: claim written, create succeeded, process died before the response
   * was stored. On the ordinary path the answer comes from
   * `accounting_entity_link` and costs nothing.
   *
   * It takes the key rather than our uuid because the key is what was written
   * into a field the provider can be queried on. Most of these systems cannot
   * be searched on a private note, so the key goes somewhere real: an invoice
   * number, a payment reference, a display name.
   */
  findPushed(kind: AccountingEntityKind, idempotencyKey: string): Promise<ReadResult<ExternalRef | null>>;

  /**
   * What changed over there since the cursor.
   *
   * An OPAQUE resume point rather than a caller-computed window, because
   * this is the expensive half of the integration and only the adapter knows
   * what its provider can resume from. QuickBooks wants an ISO instant on
   * its `cdc` endpoint and issues the next one itself; Xero has no cursor at
   * all and the adapter builds a timestamp boundary that cannot lose a
   * record written mid-request. The service stores whatever string comes back
   * on `sync_run.cursor` and never reads it, which is what makes both
   * possible behind one method.
   *
   * `null` means "never synced". The adapter decides what that means, which
   * for QuickBooks is a bounded window rather than all of history, because
   * `cdc` refuses a `changedSince` older than thirty days.
   */
  changes(cursor: string | null): Promise<ReadResult<ChangeSet>>;

  /**
   * The chart of accounts, for the mapping screen.
   *
   * Called when a human is choosing, never on a sync pass. That is the whole
   * reason `account_mapping` stores the resolved id: the sync does a join,
   * and the metered read happens once, in front of somebody who asked for it.
   */
  accounts(): Promise<ReadResult<ExternalAccount[]>>;
}

/**
 * A minimal HTTP shape, so a test can hand the adapter a transport and never
 * reach Intuit.
 *
 * Declared here rather than in the adapter because every adapter needs it and
 * because a test for a Xero adapter should be able to use the same fake. It
 * is a subset of `fetch`, so the real `fetch` satisfies it without a wrapper.
 */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /**
   * The bytes, for the one answer that is not text: a report handed back as a
   * zip. Optional so every fake that answers JSON stays as it is; `fetch`
   * has it.
   */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type HttpTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

/**
 * CALLBACKS INTO THE DEPLOYMENT, and the first one is not optional in
 * practice even though it is optional in the type.
 *
 * OAuth refresh tokens ROTATE. QuickBooks issues a new refresh token roughly
 * every time one is used and expires the old one after a grace period; Xero
 * rotates on every single refresh with no grace at all. An adapter that gets
 * a new refresh token and does not persist it works for exactly one
 * deployment lifetime and then the connection is dead and needs a human to
 * reauthorize it, at which point the symptom is "the accounting sync stopped"
 * and the cause is a value that was thrown away days earlier.
 *
 * So the seam carries a way to hand the new credential back to whoever owns
 * the secret store. It takes the opaque credential string, not a token, so a
 * provider whose credential is three fields in a JSON document can rotate all
 * three at once.
 */
export interface ProviderHooks {
  onCredentialRotated?: (credential: string) => Promise<void>;
}

export class AccountingNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No accounting provider configured for "${provider}"`);
    this.name = "AccountingNotConfiguredError";
  }
}

/**
 * Providers register themselves, exactly as carriers do.
 *
 * A self hoster adding Xero writes one file and imports it. Nothing in
 * `services/accounting.ts` gains a branch, and a deployment that never
 * connects QuickBooks never loads the QuickBooks adapter or anything it
 * imports.
 */
export type ProviderFactory = (
  settings: Record<string, unknown>,
  secret: string,
  hooks: ProviderHooks,
) => AccountingProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.set(name, factory);
}

export function createProvider(
  name: string,
  settings: Record<string, unknown>,
  secret: string,
  hooks: ProviderHooks = {},
): AccountingProvider {
  const factory = registry.get(name);
  if (!factory) throw new AccountingNotConfiguredError(name);
  return factory(settings, secret, hooks);
}

export const registeredProviders = (): string[] => [...registry.keys()];
