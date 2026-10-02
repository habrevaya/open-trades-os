import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

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

export const statementRoutes = { getCustomerStatement } as const;
