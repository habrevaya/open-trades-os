import { type Money, add, subtract, zero, toString, isZero, isNegative, allocate, multiply, round, sum, compare, money } from "../money/index.js";

/**
 * POSTING TO THE LEDGER
 *
 * Every event that moves money produces a BALANCED SET of entries, built here
 * as pure data and written by the service layer in one transaction.
 *
 * The reason this is a separate, pure module rather than inline SQL: an
 * invoice posting and a payment posting have to agree with each other forever,
 * and the only way to be sure of that is to be able to test them together
 * without a database. Every function below returns entries that sum to zero,
 * and a property test asserts it for randomly generated inputs.
 *
 * ACCOUNT CODES follow a conventional chart of accounts. They are the default
 * rather than the law: a company maps them to their own chart during setup,
 * and the mapping lives in account_mapping.
 */
export const ACCOUNTS = {
  AR: "1200",                 // Accounts receivable
  CASH: "1000",               // Undeposited funds
  INVENTORY: "1300",
  CUSTOMER_DEPOSITS: "2300",  // Money held against work not yet done. A LIABILITY.
  DEFERRED_REVENUE: "2400",   // Unearned agreement revenue. A LIABILITY.
  TAX_PAYABLE: "2200",        // Sales tax collected, owed to a jurisdiction
  TIPS_PAYABLE: "2250",       // Tips collected, owed to a technician
  REVENUE: "4000",
  REVENUE_AGREEMENT: "4100",
  DISCOUNTS: "4900",          // Contra revenue
  COGS: "5000",
  PROCESSING_FEES: "6100",
  WRITE_OFF: "6900",
} as const;

export type Direction = "debit" | "credit";

export interface LedgerEntry {
  direction: Direction;
  accountCode: string;
  amount: Money;
  memo?: string;
  /** Carried onto the row so job level profitability is a query, not a join. */
  jobId?: string | undefined;
  customerId?: string | undefined;
}

export interface Posting {
  sourceType: string;
  sourceId: string;
  occurredAt: Date;
  entries: LedgerEntry[];
}

export class UnbalancedPostingError extends Error {
  constructor(public readonly imbalance: Money) {
    super(`Posting does not balance. Debits minus credits is ${toString(imbalance)}`);
    this.name = "UnbalancedPostingError";
  }
}

/**
 * Debits minus credits. Zero, or the posting is rejected before it reaches
 * the database, where a deferred constraint trigger would reject it anyway.
 * Failing here gives a far better error than failing at commit.
 */
export function imbalanceOf(entries: LedgerEntry[]): Money {
  if (entries.length === 0) return zero();
  const currency = entries[0]!.amount.currency;
  return entries.reduce(
    (acc, e) => (e.direction === "debit" ? add(acc, e.amount) : subtract(acc, e.amount)),
    zero(currency),
  );
}

export function assertBalanced(posting: Posting): Posting {
  const imbalance = imbalanceOf(posting.entries);
  if (!isZero(imbalance)) throw new UnbalancedPostingError(imbalance);
  return posting;
}

const dr = (accountCode: string, amount: Money, memo?: string, extra?: Partial<LedgerEntry>): LedgerEntry =>
  ({ direction: "debit", accountCode, amount, ...(memo ? { memo } : {}), ...extra });
const cr = (accountCode: string, amount: Money, memo?: string, extra?: Partial<LedgerEntry>): LedgerEntry =>
  ({ direction: "credit", accountCode, amount, ...(memo ? { memo } : {}), ...extra });

/** Entries with a zero amount are noise in a report. Dropped before balancing. */
const compact = (entries: LedgerEntry[]) => entries.filter((e) => !isZero(e.amount));

// ---------------------------------------------------------------------------
// Invoicing
// ---------------------------------------------------------------------------

export interface InvoiceTotals {
  subtotal: Money;
  discountTotal: Money;
  taxTotal: Money;
  total: Money;
}

export interface InvoiceLineInput {
  quantity: string;
  unitPrice: Money;
  discountAmount?: Money | undefined;
  taxable: boolean;
  taxRate: string;
}

export interface ComputedLine {
  lineSubtotal: Money;
  discountAmount: Money;
  taxableBase: Money;
  taxAmount: Money;
  lineTotal: Money;
}

/**
 * Line and document totals.
 *
 * Tax is computed on the SUM of taxable bases rather than per line and then
 * added up, because rounding once at the document is what an accountant
 * expects and what the customer's own arithmetic will produce. Per-line
 * rounding drifts by a cent on roughly a third of multi-line invoices, and
 * every one of those is a phone call.
 */
export function computeInvoice(lines: InvoiceLineInput[]): { lines: ComputedLine[]; totals: InvoiceTotals } {
  const currency = lines[0]?.unitPrice.currency ?? "USD";

  const computed = lines.map((line) => {
    const gross = multiply(line.unitPrice, line.quantity);
    const discount = line.discountAmount ?? zero(currency);
    const net = subtract(gross, discount);
    return {
      lineSubtotal: gross,
      discountAmount: discount,
      taxableBase: line.taxable ? net : zero(currency),
      // Held at full precision here; the document rounds once below.
      taxAmount: line.taxable ? multiply(net, line.taxRate) : zero(currency),
      lineTotal: net,
    };
  });

  const subtotal = round(sum(computed.map((l) => l.lineSubtotal), currency), 2);
  const discountTotal = round(sum(computed.map((l) => l.discountAmount), currency), 2);
  const taxTotal = round(sum(computed.map((l) => l.taxAmount), currency), 2);
  const total = round(add(subtract(subtotal, discountTotal), taxTotal), 2);

  return {
    lines: computed.map((l) => ({ ...l, taxAmount: round(l.taxAmount, 2), lineTotal: round(l.lineTotal, 2) })),
    totals: { subtotal, discountTotal, taxTotal, total },
  };
}

/**
 * Issuing an invoice. Receivable goes up, revenue is earned, tax collected is
 * a liability owed to a jurisdiction rather than income.
 *
 * Discount is a DEBIT to contra revenue rather than a smaller credit to
 * revenue, so gross revenue and discounting are both visible. Netting the
 * discount away hides how much of it a company is doing, which is usually the
 * number they most need to see.
 */
export function postInvoice(input: {
  invoiceId: string;
  occurredAt: Date;
  totals: InvoiceTotals;
  customerId?: string | undefined;
  jobId?: string | undefined;
  isAgreementRevenue?: boolean | undefined;
}): Posting {
  const { totals } = input;
  const revenueAccount = input.isAgreementRevenue ? ACCOUNTS.REVENUE_AGREEMENT : ACCOUNTS.REVENUE;
  const tag = { jobId: input.jobId, customerId: input.customerId };

  return assertBalanced({
    sourceType: "invoice",
    sourceId: input.invoiceId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.AR, totals.total, "Invoice issued", tag),
      dr(ACCOUNTS.DISCOUNTS, totals.discountTotal, "Discount given", tag),
      cr(revenueAccount, totals.subtotal, "Revenue earned", tag),
      cr(ACCOUNTS.TAX_PAYABLE, totals.taxTotal, "Sales tax collected", tag),
    ]),
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Receiving a payment. Cash up, receivable down.
 *
 * A tip is NOT revenue. It is money held on behalf of a technician, so it is a
 * liability from the moment it is collected. Treating it as revenue overstates
 * the month and then understates it again when the tip is paid out, and it
 * makes every tip-heavy trade's numbers meaningless.
 *
 * The processing fee is recognised at collection rather than at payout,
 * because that is when it was incurred and because deferring it makes a
 * month's margin depend on when a processor happens to settle.
 */
export function postPayment(input: {
  paymentId: string;
  occurredAt: Date;
  /** Applied against invoices. Excludes tip and surcharge. */
  appliedAmount: Money;
  tipAmount?: Money | undefined;
  surchargeAmount?: Money | undefined;
  processingFee?: Money | undefined;
  customerId?: string | undefined;
}): Posting {
  const currency = input.appliedAmount.currency;
  const tip = input.tipAmount ?? zero(currency);
  const surcharge = input.surchargeAmount ?? zero(currency);
  const fee = input.processingFee ?? zero(currency);
  const tag = { customerId: input.customerId };

  const grossReceived = add(add(input.appliedAmount, tip), surcharge);
  const cashNet = subtract(grossReceived, fee);

  return assertBalanced({
    sourceType: "payment",
    sourceId: input.paymentId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CASH, cashNet, "Payment received", tag),
      dr(ACCOUNTS.PROCESSING_FEES, fee, "Processing fee", tag),
      cr(ACCOUNTS.AR, input.appliedAmount, "Applied to receivable", tag),
      cr(ACCOUNTS.TIPS_PAYABLE, tip, "Tip held for technician", tag),
      cr(ACCOUNTS.REVENUE, surcharge, "Surcharge", tag),
    ]),
  });
}

/**
 * Taking a deposit.
 *
 * Cash goes up and a LIABILITY goes up. Nothing is earned. The company is
 * holding the customer's money against work it has promised and not yet done,
 * and if it went out of business tomorrow it would owe that money back.
 *
 * Booking it as revenue is the single most common accounting error in this
 * industry, and it compounds: the month is overstated, commission is paid on
 * work that has not happened, and a company taking 50% up front cannot tell
 * from its own P&L what it has actually earned. This function exists so that
 * getting it right is the path of least resistance.
 *
 * No tax is recognised here either. Sales tax is owed when the sale is
 * recognised, not when cash arrives.
 */
export function postDeposit(input: {
  depositId: string;
  occurredAt: Date;
  amount: Money;
  processingFee?: Money | undefined;
  customerId?: string | undefined;
  jobId?: string | undefined;
}): Posting {
  const currency = input.amount.currency;
  const fee = input.processingFee ?? zero(currency);
  const tag = { customerId: input.customerId, jobId: input.jobId };

  return assertBalanced({
    sourceType: "deposit",
    sourceId: input.depositId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CASH, subtract(input.amount, fee), "Deposit received", tag),
      dr(ACCOUNTS.PROCESSING_FEES, fee, "Processing fee", tag),
      cr(ACCOUNTS.CUSTOMER_DEPOSITS, input.amount, "Deposit held", tag),
    ]),
  });
}

/**
 * Applying a held deposit to an invoice.
 *
 * The liability is discharged against the receivable the invoice created. No
 * cash moves, because the cash arrived when the deposit was taken; revenue was
 * already recognised by `postInvoice`. This posting is what connects the two.
 *
 * Skipping it and simply marking the invoice paid leaves the deposit sitting
 * on the balance sheet forever as money the company still owes, which is how a
 * growing company ends up with a customer deposits balance that only ever
 * climbs.
 */
export function postDepositApplication(input: {
  depositId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
  jobId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId, jobId: input.jobId };
  return assertBalanced({
    sourceType: "deposit_application",
    sourceId: input.depositId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CUSTOMER_DEPOSITS, input.amount, "Deposit applied", tag),
      cr(ACCOUNTS.AR, input.amount, "Applied to receivable", tag),
    ]),
  });
}

/**
 * Returning a deposit for work that will not happen.
 *
 * The liability goes away and so does the cash. Distinct from `postRefund`,
 * which reverses a sale: nothing was ever sold here, so there is no revenue or
 * tax to reverse, and treating the two the same produces a negative revenue
 * line for a job that never existed.
 *
 * A forfeited deposit is NOT this function. Forfeiture earns the money, so it
 * moves from the liability to revenue, which `postDepositForfeiture` does.
 */
export function postDepositRefund(input: {
  depositId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "deposit_refund",
    sourceId: input.depositId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CUSTOMER_DEPOSITS, input.amount, "Deposit returned", tag),
      cr(ACCOUNTS.CASH, input.amount, "Cash out", tag),
    ]),
  });
}

/**
 * A customer cancels late and the deposit is kept under the terms they agreed
 * to. The company has now earned it, so the liability becomes revenue. No cash
 * moves; it arrived when the deposit was taken.
 */
export function postDepositForfeiture(input: {
  depositId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "deposit_forfeiture",
    sourceId: input.depositId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CUSTOMER_DEPOSITS, input.amount, "Deposit forfeited", tag),
      cr(ACCOUNTS.REVENUE, input.amount, "Forfeited deposit earned", tag),
    ]),
  });
}

/**
 * A refund is not a negative payment. It is its own posting with its own
 * entries, so both appear in the register and a reversal can be audited.
 */
export function postRefund(input: {
  refundId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "refund",
    sourceId: input.refundId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.AR, input.amount, "Refund issued", tag),
      cr(ACCOUNTS.CASH, input.amount, "Refund paid out", tag),
    ]),
  });
}

/**
 * VOIDING AN INVOICE, WHICH IS NOT THE SAME THING AS WRITING IT OFF.
 *
 * A write off says the money is owed and will not arrive: the receivable
 * goes and a loss is recognised, so the revenue stays on the books and the
 * bad debt sits beside it. A void says the invoice should never have
 * existed: the revenue was never earned, the tax was never collected, and
 * nothing is lost because nothing was ever really owed.
 *
 * Getting the two the wrong way round is not a rounding error. A voided
 * invoice written off leaves revenue the company never earned in its
 * accounts and a bad debt expense it never suffered, and both of those are
 * numbers a tax return is built on.
 *
 * So this REVERSES the original posting line for line rather than moving the
 * balance somewhere. The tag carries the same job and customer, so the
 * reversal lands on the same rows a report groups by.
 */
export function postVoid(input: {
  invoiceId: string;
  occurredAt: Date;
  totals: InvoiceTotals;
  customerId?: string | undefined;
  jobId?: string | undefined;
  isAgreementRevenue?: boolean | undefined;
}): Posting {
  const { totals } = input;
  const revenueAccount = input.isAgreementRevenue ? ACCOUNTS.REVENUE_AGREEMENT : ACCOUNTS.REVENUE;
  const tag = { jobId: input.jobId, customerId: input.customerId };

  return assertBalanced({
    sourceType: "void",
    sourceId: input.invoiceId,
    occurredAt: input.occurredAt,
    entries: compact([
      // Every line of `postInvoice`, the other way up.
      cr(ACCOUNTS.AR, totals.total, "Invoice voided", tag),
      cr(ACCOUNTS.DISCOUNTS, totals.discountTotal, "Discount reversed", tag),
      dr(revenueAccount, totals.subtotal, "Revenue reversed", tag),
      dr(ACCOUNTS.TAX_PAYABLE, totals.taxTotal, "Sales tax reversed", tag),
    ]),
  });
}

/** Writing off a balance. The receivable goes, and the loss is recognised. */
export function postWriteOff(input: {
  invoiceId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "write_off",
    sourceId: input.invoiceId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.WRITE_OFF, input.amount, "Balance written off", tag),
      cr(ACCOUNTS.AR, input.amount, "Receivable removed", tag),
    ]),
  });
}

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------

/**
 * Billing an agreement up front creates a LIABILITY, not revenue. The cash and
 * receivable move normally; what would have been revenue sits in deferred
 * revenue until the obligation is delivered.
 */
export function postAgreementBilling(input: {
  invoiceId: string;
  occurredAt: Date;
  amount: Money;
  taxAmount?: Money | undefined;
  customerId?: string | undefined;
}): Posting {
  const currency = input.amount.currency;
  const tax = input.taxAmount ?? zero(currency);
  const tag = { customerId: input.customerId };

  return assertBalanced({
    sourceType: "agreement_billing",
    sourceId: input.invoiceId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.AR, add(input.amount, tax), "Agreement billed", tag),
      cr(ACCOUNTS.DEFERRED_REVENUE, input.amount, "Unearned agreement revenue", tag),
      cr(ACCOUNTS.TAX_PAYABLE, tax, "Sales tax collected", tag),
    ]),
  });
}

/** Delivering an included visit earns a slice of it. Liability down, revenue up. */
export function postAgreementRecognition(input: {
  agreementVisitId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
  jobId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId, jobId: input.jobId };
  return assertBalanced({
    sourceType: "agreement_recognition",
    sourceId: input.agreementVisitId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.DEFERRED_REVENUE, input.amount, "Obligation delivered", tag),
      cr(ACCOUNTS.REVENUE_AGREEMENT, input.amount, "Agreement revenue earned", tag),
    ]),
  });
}

/**
 * Splitting the term price across the visits it owes.
 *
 * Allocated at cent precision so the parts are already whole cents and still
 * sum exactly to the term price. Dividing and rounding each share
 * independently loses a cent on most terms, and that cent sits in deferred
 * revenue forever with nothing to release it.
 */
export function recognitionSchedule(termPrice: Money, visitCount: number): Money[] {
  if (visitCount < 1) return [];
  return allocate(termPrice, Array.from({ length: visitCount }, () => "1"), 2);
}

/** Cancelling early releases whatever has not been earned. */
export function postDeferredRelease(input: {
  agreementId: string;
  occurredAt: Date;
  amount: Money;
  toRevenue: boolean;
  customerId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "deferred_release",
    sourceId: input.agreementId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.DEFERRED_REVENUE, input.amount, "Deferred balance released", tag),
      input.toRevenue
        ? cr(ACCOUNTS.REVENUE_AGREEMENT, input.amount, "Recognised on cancellation", tag)
        : cr(ACCOUNTS.AR, input.amount, "Credited back to the customer", tag),
    ]),
  });
}

export { toString as formatAmount, money as parseAmount, compare as compareAmount, isNegative };
