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
  /** Credit on a credit note given back as money, which takes it off what is held for them. */
  "credit_payout",
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
    /** The branch's code the invoice was printed with ("HOU"), or null. */
    numberPrefix: z.string().nullable(),
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

/** One statement sent, or refused, by email or by text. */
export const StatementSent = z.object({
  deliveryId: Uuid,
  customerId: Uuid,
  /** How it went, or how it was tried. */
  channel: z.enum(["email", "sms"]),
  destination: z.string().nullable(),
  state: z.enum(["queued", "refused"]),
  /** Why it went another way than the customer prefers, when the monthly run emailed a text that could not go. */
  note: z.string().nullable(),
  explanation: z.string().nullable(),
  /** The link that went. Empty on a replay: the token exists once, when minted. */
  portalUrl: z.string(),
  /**
   * The copy to one more of the customer's own people, when one was asked
   * for: by email, as a message of its own, only once the statement went.
   * `refused` with why when it did not.
   */
  copy: z.object({
    contactId: Uuid.nullable(),
    contactName: z.string().nullable(),
    destination: z.string().nullable(),
    state: z.enum(["queued", "refused"]),
    explanation: z.string().nullable(),
  }).nullable(),
  /**
   * Every copy asked for, in order: by email or by text, to one of the
   * customer's own people or to an address the office typed (`typed`), each as
   * a message of its own, with where it went or why it did not. `copy` is the
   * first of these.
   */
  copies: z.array(z.object({
    contactId: Uuid.nullable(),
    contactName: z.string().nullable(),
    channel: z.enum(["email", "sms"]),
    destination: z.string().nullable(),
    typed: z.boolean(),
    state: z.enum(["queued", "refused"]),
    explanation: z.string().nullable(),
  })),
});

/**
 * One copy asked for: one of the customer's own people (`contactId`) or an
 * address the office types (`address`: an email address for `email`, a mobile
 * number for `sms`), never both.
 */
const CopyAsked = z.object({
  contactId: Uuid.optional(),
  address: z.string().trim().min(1).max(320).optional(),
  channel: z.enum(["email", "sms"]),
});

export const emailCustomerStatement = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/statement/email",
  summary: "Email a customer their statement",
  description:
    "To the address on the customer, or to `email` when given (a commercial customer's accounts mailbox is rarely the person who booked the work). With `copies` (five at most), each of the customer's own people (on the customer, not removed, with the address or mobile number the channel needs; refused otherwise) or each address the office types is sent a copy of their own, by email or by text, once the statement goes: a message each, refused or suppressed on its own, a text through the consent gate every text goes through. A copy to an address that was typed is audited on its own (`statement.copied_to_typed_address`) with the address. `copyContactId` is an email copy to that person, first in the list. All copies carry the link the statement went with. `copies` in the answer says where each went or why not. The email carries a link to the statement on the customer's own account page for the period, and no amounts: the page reads the books when they open it, and a balance in an email is wrong the moment a cheque clears. A suppressed address or no email connection is recorded as refused, with the reason, rather than thrown. A retry with the same idempotency key is the same send.",
  module: "M13",
  permissions: ["invoice:send"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    email: z.string().optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    copyContactId: Uuid.optional(),
    copies: z.array(CopyAsked).max(5).optional(),
  }),
  output: StatementSent,
});

export const textCustomerStatement = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/statement/text",
  summary: "Text a customer their statement",
  description:
    "The link to the statement on the customer's own account page, for the period, by text: to `phone` when given, or the customer's main contact's mobile, or the number on the customer. No amounts, for the reason the email carries none. It goes through the same consent gate as every text, so a number that replied STOP, a company with no number registered to text from, or no number at all is recorded as refused with the reason, rather than thrown, and the link minted for it is revoked. A retry with the same idempotency key is the same send.",
  module: "M13",
  permissions: ["invoice:send"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    phone: z.string().max(40).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    /** Copies, as on the email: by email or by text to the customer's own people or to an address typed. */
    copies: z.array(CopyAsked).max(5).optional(),
  }),
  output: StatementSent,
});

export const StatementDelivery = z.object({
  id: Uuid,
  customerId: Uuid,
  customerName: z.string(),
  /** `2026-09` on the monthly run, null on one sent by hand. */
  period: z.string().nullable(),
  periodFrom: z.string().date(),
  periodTo: z.string().date(),
  channel: z.enum(["email", "sms"]),
  destination: z.string().nullable(),
  /** The person at the customer it went to: the contact their open bills are addressed to, on the monthly run. */
  contactName: z.string().nullable().optional(),
  closingBalance: MoneyString.nullable(),
  /** The outbox's word for the message. Null when nothing was queued. */
  messageStatus: z.string().nullable(),
  error: z.string().nullable(),
  /** A text the run could not send and emailed instead, with why. */
  note: z.string().nullable(),
  /** Who it was copied to, where, the outbox's word for the copy, or why no copy went. Null when none was asked for. */
  copyContactName: z.string().nullable().optional(),
  copyDestination: z.string().nullable().optional(),
  copyMessageStatus: z.string().nullable().optional(),
  copyError: z.string().nullable().optional(),
  /** Every copy, the first included, by email or by text. */
  copies: z.array(z.object({
    contactName: z.string().nullable(),
    channel: z.enum(["email", "sms"]),
    destination: z.string().nullable(),
    typed: z.boolean(),
    messageStatus: z.string().nullable(),
    error: z.string().nullable(),
  })).optional(),
  createdAt: z.string().datetime(),
});

export const listStatementDeliveries = defineRoute({
  method: "get",
  path: "/v1/statement-deliveries",
  summary: "Statements emailed or texted, by hand or by the monthly run",
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
  /**
   * Text the statement to a customer whose main contact prefers texts, and
   * email it to everybody else. Off unless turned on. A text that cannot go
   * is emailed instead, and the list says so.
   */
  textWhenPreferred: z.boolean(),
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
    "On a day from 1 to 28 at a time in the company's timezone, every customer owing more than `minimumBalance` on open invoices (counted by whoever pays them) is sent a link to their statement for the month before. It goes to the person those open invoices are addressed to (`PUT /v1/invoices/{id}/bill-to`; the newest invoice's when they name several), else the customer's main contact: by email to that person's address, or with `textWhenPreferred` by text to their number when that person prefers texts, through the consent gate, and by email when the text cannot go. Each customer is sent at most one per month, whatever the worker does. Off is a pause: the history stays.",
  module: "M13",
  permissions: ["invoice:send"],
  /** Setting a state: the same request twice leaves the same state. */
  idempotent: true,
  input: z.object({
    enabled: z.boolean(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    minimumBalance: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    /** Left off, it stays as it was. */
    textWhenPreferred: z.boolean().optional(),
  }),
  output: StatementSchedule,
});

const StatementCopy = z.object({
  customerId: Uuid,
  /** Who the monthly run copies now. `usable` false: removed, or no address left, so the run copies nobody and says why. */
  monthly: z.object({
    contactId: Uuid,
    name: z.string(),
    email: z.string().nullable(),
    usable: z.boolean(),
  }).nullable(),
  /** The customer's own people with an email address: who a copy can go to. */
  candidates: z.array(z.object({ id: Uuid, name: z.string(), email: z.string() })),
  /** The same people with a mobile number: who a copy by text can go to. */
  textCandidates: z.array(z.object({ id: Uuid, name: z.string(), phone: z.string() })),
});

export const getStatementCopy = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/statement-copy",
  summary: "Who a customer's statement can be copied to, and who the monthly run copies",
  module: "M13",
  permissions: ["invoice:read"],
  input: z.object({ id: Uuid }),
  output: StatementCopy,
});

export const setStatementCopy = defineRoute({
  method: "put",
  path: "/v1/customers/{id}/statement-copy",
  summary: "Name the person the monthly statement is copied to",
  description:
    "One of the customer's own people with an email address, or null for nobody. The monthly run emails them a copy of their own once the statement goes, whichever way the statement went; it checks again when it sends, so somebody removed from the customer since is not copied, and the row says why. Audited.",
  module: "M13",
  permissions: ["invoice:send"],
  input: z.object({ id: Uuid, contactId: Uuid.nullable() }),
  output: z.object({ customerId: Uuid, contactId: Uuid.nullable(), name: z.string().nullable() }),
});

export const statementRoutes = {
  getCustomerStatement, emailCustomerStatement, textCustomerStatement, listStatementDeliveries,
  getStatementSchedule, setStatementSchedule, getStatementCopy, setStatementCopy,
} as const;
