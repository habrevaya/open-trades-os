import { type Money, add, subtract, zero, toString, isZero, isNegative, isPositive, allocate, multiply, round, sum, compare, money } from "../money/index.js";

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
 * and the mapping lives in account_mapping, one row per code per accounting
 * connection. That table did not exist when this sentence was first written,
 * which made this comment a claim about a table nobody could find; it exists
 * now, and the accounting bridge refuses to send a document whose code has no
 * mapping rather than defaulting to a plausible account.
 */
export const ACCOUNTS = {
  AR: "1200",                 // Accounts receivable
  /**
   * Retainage a customer is holding back on an application for payment:
   * earned and billed, owed when the job is done. An asset, and not the
   * receivable, because the customer does not owe it yet.
   */
  RETAINAGE_RECEIVABLE: "1210",
  CASH: "1000",               // Undeposited funds
  /**
   * Stock. In this product it holds ONE thing: freight and duty billed after
   * a delivery was received, on the parts still on a shelf. Receiving and
   * using stock do not post here (job costing reads material from the job's
   * lines, and stock value is the costing replay's), so this is not a
   * perpetual inventory and does not pretend to be. Each use relieves the
   * late freight it took, so the balance is always the late freight still on
   * a shelf, which the stock screens can prove.
   */
  INVENTORY: "1300",
  /**
   * Owed to a supplier. Only a late freight or duty bill posts here: it is the
   * one supplier bill this product records, because it has to be spread onto
   * stock and jobs. Paying it is the accountant's, in their own books.
   */
  ACCOUNTS_PAYABLE: "2000",
  CUSTOMER_DEPOSITS: "2300",  // Money held against work not yet done. A LIABILITY.
  DEFERRED_REVENUE: "2400",   // Unearned agreement revenue. A LIABILITY.
  TAX_PAYABLE: "2200",        // Sales tax collected, owed to a jurisdiction
  TIPS_PAYABLE: "2250",       // Tips collected, owed to a technician
  COMMISSION_PAYABLE: "2260", // Commission earned and not yet paid. A LIABILITY.
  REVENUE: "4000",
  REVENUE_AGREEMENT: "4100",
  DISCOUNTS: "4900",          // Contra revenue
  COGS: "5000",
  /**
   * Commission, kept OUT of cost of goods sold on purpose.
   *
   * It is a real cost of the sale and a reasonable chart could put it in COGS.
   * This one does not, because a margin based commission plan is computed from
   * gross margin: put the commission inside COGS and the margin a commission is
   * worked out from is reduced by the commission itself, so the number depends
   * on the order the two are computed in, and a second commission on the same
   * job would be smaller than the first for no reason anybody could explain.
   */
  COMMISSION_EXPENSE: "5100",
  PROCESSING_FEES: "6100",
  WRITE_OFF: "6900",
} as const;

export type Direction = "debit" | "credit";

/** The five things an account can be. Nothing else is a class. */
export type AccountClass = "asset" | "liability" | "equity" | "revenue" | "expense";

/**
 * What kind of account a code names, from the code itself.
 *
 * THE CHART IS NUMBERED ON PURPOSE AND NOTHING SAID SO UNTIL NOW. `ACCOUNTS`
 * above assigns 1xxx to assets, 2xxx to liabilities, 3xxx to equity, 4xxx to
 * revenue and 5xxx and 6xxx to expenses, which is the convention every
 * bookkeeper in this industry already reads. It was a convention held in the
 * ordering of a const and in nobody's head.
 *
 * It has to be a function because a trial balance cannot be computed without
 * it: whether a debit balance on an account is a positive or a negative
 * number depends entirely on which side that account normally sits, and
 * getting it wrong produces a report that balances perfectly and states the
 * opposite of the truth about every liability in the company.
 *
 * DERIVED FROM THE CODE RATHER THAN FROM A MAP OF THE CODES WE KNOW, because
 * `account_mapping` lets an operator post to a code of their own. A map would
 * answer "unknown" for every account a company added itself, and an unknown
 * class in a trial balance is a row that cannot be placed on either side.
 */
export function classOf(accountCode: string): AccountClass {
  switch (accountCode.trim().charAt(0)) {
    case "1": return "asset";
    case "2": return "liability";
    case "3": return "equity";
    case "4": return "revenue";
    default: return "expense";
  }
}

/**
 * Which side an account normally sits on.
 *
 * Assets and expenses are debit balances; liabilities, equity and revenue are
 * credit balances. This is accounting rather than a choice, and it is here so
 * that exactly one place in this codebase knows it.
 */
export function normalBalance(accountClass: AccountClass): Direction {
  return accountClass === "asset" || accountClass === "expense" ? "debit" : "credit";
}

/**
 * The signed effect of one entry on its account's own balance.
 *
 * Positive means "more of what this account normally holds". A credit to
 * revenue is positive revenue; a debit to revenue is a reduction, which is
 * what a contra revenue account like DISCOUNTS collects. Returning a sign
 * relative to the account rather than relative to debit is the difference
 * between a trial balance a bookkeeper can read and a list of absolute
 * values with a column of direction words beside it.
 */
export function signedFor(direction: Direction, accountCode: string): 1 | -1 {
  return direction === normalBalance(classOf(accountCode)) ? 1 : -1;
}

export interface LedgerEntry {
  direction: Direction;
  accountCode: string;
  amount: Money;
  memo?: string;
  /** Carried onto the row so job level profitability is a query, not a join. */
  jobId?: string | undefined;
  customerId?: string | undefined;
  /**
   * The entry this one takes back, when it is a reversal. Only a manual
   * journal's reversal sets it today; the column has existed since the first
   * migration so that a correction can point at what it corrects.
   */
  reversesEntryId?: string | undefined;
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
  /**
   * The tax another system already charged on this line, for a document
   * being recorded rather than raised. See `computeInvoice` for what is
   * accepted; it is never simply believed.
   */
  taxAmount?: Money | undefined;
}

/**
 * A line whose stated tax is not what its own rate produces.
 *
 * Carries the line's index and both figures, because the caller is usually a
 * migration that has to say which line of which source invoice disagreed,
 * and "tax does not match" on a forty line invoice is a morning's work.
 */
export class TaxAsAppliedError extends Error {
  constructor(
    public readonly line: number,
    public readonly expected: Money,
    public readonly given: Money,
  ) {
    super(
      `Line ${line + 1} states tax of ${toString(given)}, and its rate on its taxable amount `
      + `is ${toString(expected)}. A stated tax may differ from that by rounding, never by more.`,
    );
    this.name = "TaxAsAppliedError";
  }
}

/** One cent, the most a stated tax may differ from its rate by. */
const ONE_CENT = (currency: string): Money => money("0.01", currency);

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

  const computed = lines.map((line, index) => {
    const gross = multiply(line.unitPrice, line.quantity);
    const discount = line.discountAmount ?? zero(currency);
    const net = subtract(gross, discount);
    // Held at full precision here; the document rounds once below.
    const owed = line.taxable ? multiply(net, line.taxRate) : zero(currency);
    return {
      lineSubtotal: gross,
      discountAmount: discount,
      taxableBase: line.taxable ? net : zero(currency),
      taxAmount: line.taxAmount === undefined ? owed : statedTax(index, line, owed),
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
 * TAX AS ANOTHER SYSTEM CHARGED IT.
 *
 * A historical invoice charged what it charged, and the system it came from
 * rounded per line, or per jurisdiction, or by a rule nobody can now
 * recover. Recomputing it here would produce a document that disagrees with
 * the customer's copy by a cent on a third of invoices, which is exactly the
 * phone call the round-once rule above exists to prevent.
 *
 * So a stated tax is accepted, and only within rounding of what its own rate
 * gives: strictly less than a cent away from the exact product. That admits
 * every rounding rule anybody uses and refuses a number somebody made up. A
 * line that is not taxable may not carry tax at all, because a stated tax on
 * an exempt line is not rounding, it is a different document.
 */
function statedTax(index: number, line: InvoiceLineInput, owed: Money): Money {
  const given = line.taxAmount!;
  if (!line.taxable) {
    if (!isZero(given)) throw new TaxAsAppliedError(index, owed, given);
    return given;
  }
  const gap = subtract(given, owed);
  const distance = isNegative(gap) ? subtract(owed, given) : gap;
  if (compare(distance, ONE_CENT(given.currency)) >= 0) {
    throw new TaxAsAppliedError(index, owed, given);
  }
  return given;
}

/**
 * Where a caller's own totals disagree with the ones computed here.
 *
 * A cross check, never an input. The totals on a document are computed from
 * its lines by the code above and nothing else, and a caller that sends its
 * own is telling us what it expects so that a disagreement is refused rather
 * than stored. For a migration that is the whole point: an invoice that
 * loads at a different total from the one the customer was sent is worse
 * than one that does not load, because nobody notices it.
 *
 * Compared to the cent. Each field is optional, so a caller who only knows
 * the source's grand total can still check it.
 */
export function totalsMismatch(
  computed: InvoiceTotals,
  expected: Partial<Record<keyof InvoiceTotals, Money>>,
): Array<{ field: keyof InvoiceTotals; expected: string; computed: string }> {
  const out: Array<{ field: keyof InvoiceTotals; expected: string; computed: string }> = [];
  for (const field of ["subtotal", "discountTotal", "taxTotal", "total"] as const) {
    const want = expected[field];
    if (want === undefined) continue;
    if (compare(round(want, 2), computed[field]) !== 0) {
      out.push({ field, expected: toString(round(want, 2)), computed: toString(computed[field]) });
    }
  }
  return out;
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
  /**
   * Received and applied to nothing: a deposit on work not started, or a
   * customer paying ahead. See below for where it goes.
   */
  unappliedAmount?: Money | undefined;
  tipAmount?: Money | undefined;
  surchargeAmount?: Money | undefined;
  processingFee?: Money | undefined;
  customerId?: string | undefined;
}): Posting {
  const currency = input.appliedAmount.currency;
  const unapplied = input.unappliedAmount ?? zero(currency);
  const tip = input.tipAmount ?? zero(currency);
  const surcharge = input.surchargeAmount ?? zero(currency);
  const fee = input.processingFee ?? zero(currency);
  const tag = { customerId: input.customerId };

  /**
   * MONEY APPLIED TO NOTHING IS STILL MONEY.
   *
   * This posting used to debit cash with the applied amount alone, so a
   * payment of a hundred with sixty allocated put sixty in the bank and the
   * other forty nowhere: the payment row said a hundred, the ledger said
   * sixty, and the difference was not a liability, an asset or anything
   * else. The unapplied part is now held the way a deposit is held, as a
   * liability to the customer, because that is what it is until it is
   * applied to an invoice or given back.
   */
  const grossReceived = add(add(add(input.appliedAmount, unapplied), tip), surcharge);
  const cashNet = subtract(grossReceived, fee);

  return assertBalanced({
    sourceType: "payment",
    sourceId: input.paymentId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CASH, cashNet, "Payment received", tag),
      dr(ACCOUNTS.PROCESSING_FEES, fee, "Processing fee", tag),
      cr(ACCOUNTS.AR, input.appliedAmount, "Applied to receivable", tag),
      cr(ACCOUNTS.CUSTOMER_DEPOSITS, unapplied, "Unapplied payment held", tag),
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
 *
 * Money given back comes out of one of two places. The part of a payment that
 * was applied to invoices puts the receivable back: the customer owes it
 * again until the invoice is voided, written off or paid another way. The
 * part that was never applied, `heldAmount`, comes out of the liability it
 * was held in, because returning a credit nobody had used reverses nothing
 * that was ever owed.
 */
export function postRefund(input: {
  refundId: string;
  occurredAt: Date;
  amount: Money;
  /** How much of `amount` was unapplied money held for the customer. */
  heldAmount?: Money | undefined;
  customerId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  const held = input.heldAmount ?? zero(input.amount.currency);
  return assertBalanced({
    sourceType: "refund",
    sourceId: input.refundId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CUSTOMER_DEPOSITS, held, "Unapplied credit returned", tag),
      dr(ACCOUNTS.AR, subtract(input.amount, held), "Refund issued", tag),
      cr(ACCOUNTS.CASH, input.amount, "Refund paid out", tag),
    ]),
  });
}

/**
 * Applying money a customer paid earlier and nobody applied.
 *
 * The same shape as applying a deposit, for the same reason: the cash
 * arrived when the payment did and revenue was recognised when the invoice
 * was, so all that moves now is the liability, discharged against the
 * receivable. No cash moves.
 */
export function postCreditApplication(input: {
  paymentId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "credit_application",
    sourceId: input.paymentId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CUSTOMER_DEPOSITS, input.amount, "Unapplied payment applied", tag),
      cr(ACCOUNTS.AR, input.amount, "Applied to receivable", tag),
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

/**
 * A CREDIT NOTE, WHICH IS THE THIRD WAY A BALANCE GOES AWAY AND THE ONE THAT
 * WAS MISSING.
 *
 * A write off says the money is owed and will not arrive: the revenue stays and
 * a bad debt expense appears beside it. A void says the invoice should never
 * have existed. A credit note says the invoice asked for too much: the work
 * happened and some of it should not have been billed, or the company chose to
 * give something back.
 *
 * So it reverses the revenue and the tax for the credited amount, exactly as a
 * void does, and the only difference is that it is PARTIAL and it leaves the
 * original invoice standing. That matters for the tax line above all: the
 * company collected sales tax it is no longer owed, and a credit note that left
 * `TAX_PAYABLE` alone would have the company remitting tax on revenue it gave
 * back.
 *
 * ISSUING IT DOES NOT TOUCH THE INVOICE. Issuing creates the credit; applying it
 * is the second posting below, and the two are separate because a credit can be
 * issued today and applied to an invoice raised next month, or never applied at
 * all and refunded instead. Collapsing them would make an unapplied credit
 * invisible, which is money a company owes a customer and does not know about.
 */
export function postCreditNote(input: {
  creditNoteId: string;
  occurredAt: Date;
  /** Only the amounts being credited, never the original invoice's. */
  totals: { subtotal: Money; taxTotal: Money; total: Money };
  customerId?: string | undefined;
  /**
   * The job of the invoice it credits, so a job's revenue (the ledger's
   * revenue lines carrying its id) is net of what was credited back, as
   * every report and the ad platforms' values say it is.
   */
  jobId?: string | undefined;
  invoiceId?: string | undefined;
  isAgreementRevenue?: boolean | undefined;
}): Posting {
  const { totals } = input;
  const revenueAccount = input.isAgreementRevenue ? ACCOUNTS.REVENUE_AGREEMENT : ACCOUNTS.REVENUE;
  const tag = { customerId: input.customerId, jobId: input.jobId };

  return assertBalanced({
    sourceType: "credit_note",
    sourceId: input.creditNoteId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(revenueAccount, totals.subtotal, "Revenue credited back", tag),
      dr(ACCOUNTS.TAX_PAYABLE, totals.taxTotal, "Sales tax credited back", tag),
      /**
       * The other side sits in customer deposits, which is where unapplied money
       * owed to a customer already lives in this chart. It is a liability and it
       * is the right one: until the credit is applied, the company owes the
       * customer something.
       */
      cr(ACCOUNTS.CUSTOMER_DEPOSITS, totals.total, "Credit owed to the customer", tag),
    ]),
  });
}

/**
 * Putting a credit against an invoice.
 *
 * Identical in shape to applying an unapplied payment, because it is the same
 * movement: a liability the company owed the customer is settled by reducing
 * what the customer owes the company. No cash is involved in either.
 */
export function postCreditNoteApplication(input: {
  creditNoteId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
  invoiceId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "credit_note_application",
    sourceId: input.creditNoteId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CUSTOMER_DEPOSITS, input.amount, "Credit applied", tag),
      cr(ACCOUNTS.AR, input.amount, "Applied to receivable", tag),
    ]),
  });
}

/**
 * Taking a credit note back, before any of it was applied.
 *
 * The reverse of issuing it. Refused by the service once any of it has been
 * applied, because the application has its own posting and unwinding both from
 * here would be two reversals pretending to be one.
 */
export function postCreditNoteVoid(input: {
  creditNoteId: string;
  occurredAt: Date;
  totals: { subtotal: Money; taxTotal: Money; total: Money };
  customerId?: string | undefined;
  /**
   * The job of the invoice it credits, so a job's revenue (the ledger's
   * revenue lines carrying its id) is net of what was credited back, as
   * every report and the ad platforms' values say it is.
   */
  jobId?: string | undefined;
  isAgreementRevenue?: boolean | undefined;
}): Posting {
  const { totals } = input;
  const revenueAccount = input.isAgreementRevenue ? ACCOUNTS.REVENUE_AGREEMENT : ACCOUNTS.REVENUE;
  const tag = { customerId: input.customerId, jobId: input.jobId };

  return assertBalanced({
    sourceType: "credit_note_void",
    sourceId: input.creditNoteId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CUSTOMER_DEPOSITS, totals.total, "Credit withdrawn", tag),
      cr(revenueAccount, totals.subtotal, "Revenue restored", tag),
      cr(ACCOUNTS.TAX_PAYABLE, totals.taxTotal, "Sales tax restored", tag),
    ]),
  });
}

/**
 * PAYING A CREDIT OUT AS MONEY.
 *
 * The credit note's issue left what the company owes the customer in customer
 * deposits, and this is the company handing it over: back to the card they
 * paid with, or as cash or a cheque. The liability goes and the cash goes with
 * it. Nothing else moves: the revenue and tax came off when the credit note
 * was issued, and no invoice is settled or reopened.
 *
 * NOT `postRefund`. A refund of a payment puts the receivable back up, because
 * it gives back money that paid an invoice, and the customer owes that invoice
 * again. Paying out a credit gives back money the company already owed, so the
 * receivable is not touched, even when the money goes back through the very
 * card payment that paid the invoice the credit was raised against.
 */
export function postCreditNotePayout(input: {
  payoutId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
}): Posting {
  if (!isPositive(input.amount)) {
    throw new RangeError(`postCreditNotePayout takes the amount paid out, and was given ${toString(input.amount)}.`);
  }
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "credit_note_payout",
    sourceId: input.payoutId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.CUSTOMER_DEPOSITS, input.amount, "Credit paid out to the customer", tag),
      cr(ACCOUNTS.CASH, input.amount, "Cash out", tag),
    ]),
  });
}

/**
 * RETAINAGE HELD OR RELEASED ON AN APPLICATION FOR PAYMENT.
 *
 * The invoice an application becomes carries what is due now, net of the
 * retainage held this period, and `postInvoice` books that as revenue. The
 * work was done in full, so the share held back is revenue too, owed later:
 * `change` positive debits the retainage receivable and credits revenue for
 * it. When retainage is released, the release is a line on that period's
 * invoice and `postInvoice` books it as revenue again, so `change` negative
 * takes it off the retainage receivable and back off revenue: the customer
 * now owes it on the invoice, and it was earned once, when it was billed.
 *
 * `reversal` marks the posting that takes an application's retainage back
 * when its invoice is voided, so the register says why it moved.
 */
export function postRetainage(input: {
  applicationId: string;
  occurredAt: Date;
  /** Held now less what is already on the books: positive held, negative released. */
  change: Money;
  customerId?: string | undefined;
  reversal?: boolean | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  const held = !isNegative(input.change);
  const amount = held ? input.change : subtract(zero(input.change.currency), input.change);
  return assertBalanced({
    sourceType: input.reversal ? "retainage_reversal" : "retainage",
    sourceId: input.applicationId,
    occurredAt: input.occurredAt,
    entries: compact(held
      ? [
        dr(ACCOUNTS.RETAINAGE_RECEIVABLE, amount, input.reversal ? "Released retainage put back" : "Retainage held by the customer", tag),
        cr(ACCOUNTS.REVENUE, amount, input.reversal ? "Revenue restored" : "Revenue earned on retainage held", tag),
      ]
      : [
        dr(ACCOUNTS.REVENUE, amount, input.reversal ? "Revenue on voided retainage reversed" : "Retainage released, earned when billed", tag),
        cr(ACCOUNTS.RETAINAGE_RECEIVABLE, amount, input.reversal ? "Retainage voided" : "Retainage released onto the invoice", tag),
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
// Stock: freight billed after the delivery
// ---------------------------------------------------------------------------

/**
 * A FREIGHT OR DUTY BILL THAT ARRIVED AFTER THE DELIVERY.
 *
 * Owed to the carrier in full, and spread by `inventory.planLateLandedCost`:
 * the share on parts still on a shelf is stock, the share on parts already
 * used is each job's cost of goods sold (tagged with the job, so job costing
 * reads it), and the share on parts already scrapped, short or sent back is a
 * cost with no job. The amounts come in already allocated to the cent and
 * must add up to the bill, which `assertBalanced` proves.
 */
export function postLateLandedCost(input: {
  billId: string;
  occurredAt: Date;
  total: Money;
  onShelf: Money;
  byJob: readonly { jobId: string; amount: Money }[];
  onGone: Money;
}): Posting {
  return assertBalanced({
    sourceType: "landed_cost_bill",
    sourceId: input.billId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.INVENTORY, input.onShelf, "Late freight on stock still on hand"),
      ...input.byJob.map((job) => dr(ACCOUNTS.COGS, job.amount, "Late freight on parts used on this job", { jobId: job.jobId })),
      dr(ACCOUNTS.COGS, input.onGone, "Late freight on stock no longer on hand"),
      cr(ACCOUNTS.ACCOUNTS_PAYABLE, input.total, "Freight or duty bill owed"),
    ]),
  });
}

/**
 * Parts carrying late freight leave a shelf: used on a job, scrapped, short
 * on a count or sent back to the vendor. The late freight they carried leaves
 * stock for cost of goods sold, on the job when there is one.
 */
export function postLateCostRelief(input: {
  movementId: string;
  occurredAt: Date;
  amount: Money;
  jobId?: string | null | undefined;
}): Posting {
  const tag = input.jobId ? { jobId: input.jobId } : undefined;
  return assertBalanced({
    sourceType: "stock_movement",
    sourceId: input.movementId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.COGS, input.amount, input.jobId ? "Late freight on parts used on this job" : "Late freight on stock that left", tag),
      cr(ACCOUNTS.INVENTORY, input.amount, "Late freight leaving stock"),
    ]),
  });
}

/**
 * A unit back off a job, the reverse of what its use posted: the late
 * freight it carried goes back into stock and off the job's cost.
 */
export function postLateCostReturn(input: {
  movementId: string;
  occurredAt: Date;
  amount: Money;
  jobId: string;
}): Posting {
  const tag = { jobId: input.jobId };
  return assertBalanced({
    sourceType: "stock_movement",
    sourceId: input.movementId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.INVENTORY, input.amount, "Late freight back into stock"),
      cr(ACCOUNTS.COGS, input.amount, "Late freight off the job: the part came back", tag),
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

/**
 * BREAKAGE: what a term owed and the member never took, earned when the term
 * ends.
 *
 * A member pays for a year of cover that includes visits. A visit not taken
 * by the end of the year is still paid for, and the company has been ready
 * to deliver it all year, so on the day the term ends its slice is earned.
 * Not before: a visit skipped in March can be put back in June, and revenue
 * recognised in March for it would need reversing against a closed month.
 * Liability down, agreement revenue up, the same accounts delivering a visit
 * moves, sourced to the term so a second pass finds it already done.
 */
export function postAgreementBreakage(input: {
  agreementTermId: string;
  occurredAt: Date;
  amount: Money;
  customerId?: string | undefined;
}): Posting {
  const tag = { customerId: input.customerId };
  return assertBalanced({
    sourceType: "agreement_breakage",
    sourceId: input.agreementTermId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.DEFERRED_REVENUE, input.amount, "Term ended with visits not taken", tag),
      cr(ACCOUNTS.REVENUE_AGREEMENT, input.amount, "Agreement revenue earned at the end of the term", tag),
    ]),
  });
}

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

/**
 * EARNING A COMMISSION.
 *
 * An expense is incurred and a LIABILITY goes up. No cash moves, because none
 * has: the technician has not been paid, and will not be until the payroll run
 * clears this liability with `postCommissionPayment` below.
 *
 * This is the same error as booking a deposit as revenue, with the sign the
 * other way round, and it is made just as often. A product that records
 * commission as a column on a job and nothing else has a company whose own
 * accounts never show what it owes its technicians. The month a large install
 * lands reads as far more profitable than it was, because the expense that
 * install created has not been recognised anywhere, and it will land in
 * whichever month somebody happens to run payroll.
 *
 * Recognised when EARNED rather than when paid, for the reason every accrual
 * exists: the expense belongs to the period that caused it. Deferring it to
 * the payout makes a month's margin depend on which side of a fortnight
 * boundary the payroll calendar happens to fall.
 */
export function postCommissionEarned(input: {
  commissionEventId: string;
  occurredAt: Date;
  amount: Money;
  jobId?: string | undefined;
  customerId?: string | undefined;
}): Posting {
  const tag = { jobId: input.jobId, customerId: input.customerId };
  return assertBalanced({
    sourceType: "commission",
    sourceId: input.commissionEventId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.COMMISSION_EXPENSE, input.amount, "Commission earned", tag),
      cr(ACCOUNTS.COMMISSION_PAYABLE, input.amount, "Commission owed to a technician", tag),
    ]),
  });
}

/**
 * THE COMMISSION COMING BACK OFF.
 *
 * The invoice was refunded, credited or written off, so the company was never
 * paid for the work and the commission on it was never really earned. The
 * liability goes down and the expense comes back off.
 *
 * `amount` is a MAGNITUDE, not the negative figure the clawback carries.
 * Passing the negative would produce a posting with two negative legs that
 * balances perfectly and reads, on a trial balance, as a second commission
 * being earned. The caller takes the absolute value and the parameter is named
 * so that it is obvious which one is wanted.
 *
 * This is a separate posting rather than a smaller original, for the reason
 * `postRefund` is not a negative payment: both appear in the register, and a
 * reversal somebody can see is a reversal somebody can audit.
 */
export function postCommissionReversal(input: {
  commissionReversalId: string;
  occurredAt: Date;
  /** Positive. What comes back. */
  amount: Money;
  jobId?: string | undefined;
  customerId?: string | undefined;
}): Posting {
  if (isNegative(input.amount)) {
    throw new RangeError(
      `postCommissionReversal takes the magnitude coming back, and was given ${toString(input.amount)}. `
      + "A negative here posts two negative legs, balances, and reads on a trial balance as a second commission being earned.",
    );
  }
  const tag = { jobId: input.jobId, customerId: input.customerId };
  return assertBalanced({
    sourceType: "commission_reversal",
    sourceId: input.commissionReversalId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.COMMISSION_PAYABLE, input.amount, "Commission reversed", tag),
      cr(ACCOUNTS.COMMISSION_EXPENSE, input.amount, "Commission expense reversed", tag),
    ]),
  });
}

/**
 * PAYING IT, which is a different event from earning it.
 *
 * The liability is discharged and cash leaves. Nothing is expensed here: the
 * expense was recognised when the commission was earned, and recognising it
 * again at payout would double the cost of every sale.
 *
 * Skipping this posting and simply marking the commission paid leaves the
 * liability on the balance sheet forever as money the company still owes its
 * technicians, which is how a growing company ends up with a commission
 * payable balance that only ever climbs.
 */
export function postCommissionPayment(input: {
  payrollRunId: string;
  occurredAt: Date;
  amount: Money;
}): Posting {
  return assertBalanced({
    sourceType: "commission_payment",
    sourceId: input.payrollRunId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.COMMISSION_PAYABLE, input.amount, "Commission paid"),
      cr(ACCOUNTS.CASH, input.amount, "Cash out"),
    ]),
  });
}

/**
 * PAYING OUT TIPS, the only thing that ever happens to them on the books.
 *
 * A tip is credited to `TIPS_PAYABLE` the moment it arrives with a payment
 * (see `postPayment`), because it was never the company's money: it was
 * handed to the company to pass on. Passing it on discharges that liability
 * against cash and touches nothing else. No revenue on the way in and no
 * expense on the way out, which is what keeps a tip heavy month from reading
 * as a good month followed by a bad one.
 *
 * Without this posting a company that tips its technicians through payroll
 * would carry every tip ever given as a liability for ever, and its balance
 * sheet would say it still owed technicians money they were paid years ago.
 */
export function postTipPayout(input: {
  payrollRunId: string;
  occurredAt: Date;
  amount: Money;
}): Posting {
  if (isNegative(input.amount)) {
    throw new RangeError(`postTipPayout takes the amount paid out, and was given ${toString(input.amount)}.`);
  }
  return assertBalanced({
    sourceType: "tip_payout",
    sourceId: input.payrollRunId,
    occurredAt: input.occurredAt,
    entries: compact([
      dr(ACCOUNTS.TIPS_PAYABLE, input.amount, "Tips paid to technicians"),
      cr(ACCOUNTS.CASH, input.amount, "Cash out"),
    ]),
  });
}

// ---------------------------------------------------------------------------
// Manual journals
// ---------------------------------------------------------------------------

/**
 * ACCOUNTS A JOURNAL MAY NOT TOUCH, and why each one.
 *
 * Each of these is kept in step with a set of documents by the product: the
 * receivable with open invoices, customer deposits with deposits held and
 * unapplied money, tips and commission with the people they are owed to,
 * deferred revenue with an agreement's visits. A journal straight to one
 * makes the account disagree with its documents, and every report reading
 * either side (aging, a customer's statement, payroll) is then wrong in a way
 * no screen explains. Xero refuses a manual journal to its receivable for the
 * same reason. The correction goes through the document: a credit note, a
 * refund, a deposit refund, a payroll adjustment.
 */
export const CONTROL_ACCOUNTS: Readonly<Record<string, string>> = {
  [ACCOUNTS.AR]: "Accounts receivable follows the invoices. Correct it with a credit note, a write off or a payment.",
  [ACCOUNTS.RETAINAGE_RECEIVABLE]: "Retainage receivable follows the applications for payment. It moves when retainage is held on one and when it is released.",
  [ACCOUNTS.CUSTOMER_DEPOSITS]: "Customer deposits follows the deposits and unapplied payments held. Apply, refund or forfeit the deposit instead.",
  [ACCOUNTS.TIPS_PAYABLE]: "Tips payable follows the tips owed to technicians. It is cleared through payroll.",
  [ACCOUNTS.COMMISSION_PAYABLE]: "Commission payable follows the commission records. Adjust those instead.",
  [ACCOUNTS.DEFERRED_REVENUE]: "Deferred revenue follows the agreements' visits. It is released as visits are done.",
};

export interface JournalLineInput {
  accountCode: string;
  /** A positive decimal string on exactly one of the two sides. */
  debit?: string | undefined;
  credit?: string | undefined;
  memo?: string | undefined;
}

export type JournalCheck =
  | { ok: true; entries: LedgerEntry[]; total: Money }
  | { ok: false; problems: { line: number | null; message: string }[] };

const JOURNAL_ACCOUNT = /^[1-9]\d{2,9}$/;

/**
 * Whether a set of lines is a journal that may be posted, with every problem
 * named against its line rather than the first one thrown.
 *
 * An accountant entering eight lines wants to know that line three has both
 * sides filled in AND that the whole thing is off by forty dollars, in one
 * answer. The imbalance is stated as an amount and a side, because "does not
 * balance" alone sends somebody adding up a column by hand.
 */
export function checkJournal(lines: readonly JournalLineInput[], currency = "USD"): JournalCheck {
  const problems: { line: number | null; message: string }[] = [];
  const entries: LedgerEntry[] = [];

  if (lines.length < 2) problems.push({ line: null, message: "A journal has at least two lines: a debit and a credit." });

  lines.forEach((line, index) => {
    const n = index + 1;
    const code = line.accountCode.trim();
    if (!JOURNAL_ACCOUNT.test(code)) {
      problems.push({ line: n, message: `"${line.accountCode}" is not an account code.` });
      return;
    }
    const control = CONTROL_ACCOUNTS[code];
    if (control) {
      problems.push({ line: n, message: `Account ${code} cannot take a journal. ${control}` });
      return;
    }
    const debit = (line.debit ?? "").trim();
    const credit = (line.credit ?? "").trim();
    if ((debit === "") === (credit === "")) {
      problems.push({ line: n, message: "Put an amount in the debit or the credit, not both and not neither." });
      return;
    }
    const raw = debit !== "" ? debit : credit;
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      problems.push({ line: n, message: `"${raw}" is not an amount.` });
      return;
    }
    const amount = money(raw, currency);
    if (isZero(amount)) {
      problems.push({ line: n, message: "A line of zero moves nothing. Remove it." });
      return;
    }
    const memo = line.memo?.trim();
    entries.push({
      direction: debit !== "" ? "debit" : "credit",
      accountCode: code,
      amount,
      ...(memo ? { memo } : {}),
    });
  });

  if (problems.length === 0) {
    const imbalance = imbalanceOf(entries);
    if (!isZero(imbalance)) {
      const side = isNegative(imbalance) ? "credits" : "debits";
      const by = isNegative(imbalance) ? subtract(zero(currency), imbalance) : imbalance;
      problems.push({
        line: null,
        message: `Debits and credits must be equal. The ${side} are more by ${toString(round(by, 4))}.`,
      });
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  const total = sum(entries.filter((e) => e.direction === "debit").map((e) => e.amount), currency);
  return { ok: true, entries, total };
}

/** A manual journal, as a posting. Checked and balanced, or it throws. */
export function postJournal(input: { journalId: string; occurredAt: Date; entries: LedgerEntry[] }): Posting {
  return assertBalanced({
    sourceType: "journal",
    sourceId: input.journalId,
    occurredAt: input.occurredAt,
    entries: input.entries,
  });
}

/**
 * The reversal of a journal: every line on the other side, each pointing at
 * the entry it takes back.
 *
 * A reversal and not an edit, because the ledger is append only and because
 * "what did the books say on the 31st" must still have its old answer after
 * somebody corrects them on the 3rd.
 */
export function reverseJournal(input: {
  journalId: string;
  occurredAt: Date;
  original: readonly { id: string; direction: Direction; accountCode: string; amount: Money; memo?: string | null }[];
  memo: string;
}): Posting {
  return assertBalanced({
    sourceType: "journal",
    sourceId: input.journalId,
    occurredAt: input.occurredAt,
    entries: input.original.map((entry) => ({
      direction: entry.direction === "debit" ? "credit" : "debit",
      accountCode: entry.accountCode,
      amount: entry.amount,
      memo: input.memo,
      reversesEntryId: entry.id,
    })),
  });
}

export { toString as formatAmount, money as parseAmount, compare as compareAmount, isNegative };
