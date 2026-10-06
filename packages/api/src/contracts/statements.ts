import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, CompanyContact } from "./common";

/**
 * A CUSTOMER STATEMENT
 *
 * "What do I owe you, in total?" is the commonest question an office gets
 * from a commercial customer, and the answer used to be a balance on a screen
 * and a list of invoices somebody added up. A statement is the document that
 * answers it: what they owed at the start of a period, every charge and every
 * payment or credit in it, and what they owe at the end, with the open
 * invoices aged underneath.
 *
 * READ FROM THE BOOKS. Every line is a posting in the ledger against the
 * customer's receivable or the money held for them, so a statement cannot
 * disagree with the receivables report, and moving money from one place to
 * another (applying a payment held earlier, using a credit) is not a line,
 * because nothing changed in what the customer owes.
 *
 * A PAYER'S STATEMENT. On commercial work the invoice goes to whoever pays:
 * a property manager, a warranty company. Invoices, voids and write offs land
 * on the payer's statement and not the tenant's.
 */
export const StatementLineKind = z.enum([
  "invoice", "payment", "refund", "void", "write_off", "credit_note", "credit_note_void",
  "deposit", "deposit_refund", "deposit_kept", "agreement",
]);

export const StatementLine = z.object({
  date: z.string().date(),
  kind: StatementLineKind,
  /** What the customer would call it: "Invoice 1048", "Payment, cheque 2209". */
  description: z.string(),
  /** The document behind it, when there is one to open. */
  invoiceId: Uuid.nullable(),
  /** Positive adds to what is owed, negative takes from it. */
  amount: MoneyString,
  charge: MoneyString.nullable(),
  credit: MoneyString.nullable(),
  /** What was owed after this line. Negative when the company owes the customer. */
  balance: MoneyString,
});

export const CustomerStatement = z.object({
  customerId: Uuid,
  customerName: z.string(),
  organizationName: z.string(),
  /** How the customer reaches the company, printed under its name. */
  organizationContact: CompanyContact,
  from: z.string().date(),
  to: z.string().date(),
  openingBalance: MoneyString,
  closingBalance: MoneyString,
  /** The two halves of the closing balance as of today. */
  owedOnInvoices: MoneyString,
  heldOnAccount: MoneyString,
  lines: z.array(StatementLine),
  aging: z.object({
    current: MoneyString,
    days1To30: MoneyString,
    days31To60: MoneyString,
    days61To90: MoneyString,
    over90: MoneyString,
  }),
  openInvoices: z.array(z.object({
    id: Uuid,
    number: z.number().int(),
    issuedOn: z.string().date().nullable(),
    dueOn: z.string().date().nullable(),
    total: MoneyString,
    balance: MoneyString,
    daysOverdue: z.number().int(),
  })),
});

export const getCustomerStatement = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/statement",
  summary: "A customer's statement over a period",
  description:
    "Opening balance, every charge, payment and credit in the period with a running balance, the closing balance, and the open invoices aged by days past due. Read from the ledger, so it agrees with the receivables report. Dates are the company's calendar days; the period defaults to the last ninety days and may not run past today.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({
    id: Uuid,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  output: CustomerStatement,
});

export const emailCustomerStatement = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/statement/email",
  summary: "Email a customer their statement",
  description:
    "To the address on the customer, or to `email` when given (a commercial customer's accounts mailbox is rarely the person who booked the work). The email carries a link to the statement on the customer's own account page for the period, and no amounts: the page reads the books when they open it, and a balance in an email is wrong the moment a cheque clears. A suppressed address or no email connection is recorded as refused, with the reason, rather than thrown. A retry with the same idempotency key is the same send.",
  module: "M13",
  permissions: ["invoice:send"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    email: z.string().optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  output: z.object({
    deliveryId: Uuid,
    customerId: Uuid,
    destination: z.string().nullable(),
    state: z.enum(["queued", "refused"]),
    explanation: z.string().nullable(),
    /** The link that went. Empty on a replay: the token exists once, when minted. */
    portalUrl: z.string(),
  }),
});

export const StatementDelivery = z.object({
  id: Uuid,
  customerId: Uuid,
  customerName: z.string(),
  /** `2026-09` on the monthly run, null on one sent by hand. */
  period: z.string().nullable(),
  periodFrom: z.string().date(),
  periodTo: z.string().date(),
  destination: z.string().nullable(),
  closingBalance: MoneyString.nullable(),
  /** The outbox's word for the message. Null when nothing was queued. */
  messageStatus: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const listStatementDeliveries = defineRoute({
  method: "get",
  path: "/v1/statement-deliveries",
  summary: "Statements emailed, by hand or by the monthly run",
  description:
    "Newest first, for one customer or everybody: the period, where it went, what the customer owed when it went, and the message's status, or why it was not sent.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({
    customerId: Uuid.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({ deliveries: z.array(StatementDelivery) }),
});

export const StatementSchedule = z.object({
  enabled: z.boolean(),
  dayOfMonth: z.number().int().min(1).max(28),
  /** `HH:MM` in the company's timezone. */
  time: z.string(),
  /** A customer owing this much or less is not sent one. */
  minimumBalance: MoneyString,
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});

export const getStatementSchedule = defineRoute({
  method: "get",
  path: "/v1/statement-schedule",
  summary: "Whether customers with a balance get a statement every month",
  description: "Off until somebody turns it on. When on: the day of the month, the time, and the smallest balance worth a statement.",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({}),
  output: StatementSchedule,
});

export const setStatementSchedule = defineRoute({
  method: "post",
  path: "/v1/statement-schedule",
  summary: "Turn monthly statements on or off",
  description:
    "On a day from 1 to 28 at a time in the company's timezone, every customer owing more than `minimumBalance` on open invoices (counted by whoever pays them) is emailed a link to their statement for the month before. Each customer is sent at most one per month, whatever the worker does. Off is a pause: the history stays.",
  module: "M13",
  permissions: ["invoice:send"],
  /** Setting a state: the same request twice leaves the same state. */
  idempotent: true,
  input: z.object({
    enabled: z.boolean(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    minimumBalance: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  }),
  output: StatementSchedule,
});

export const statementRoutes = {
  getCustomerStatement, emailCustomerStatement, listStatementDeliveries,
  getStatementSchedule, setStatementSchedule,
} as const;
