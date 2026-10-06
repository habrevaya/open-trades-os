import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * FOUR PERMISSIONS GRANTED TO ROLES AND CHECKED BY NOTHING
 *
 * `permissions-enforced.test.ts` keeps a list of permissions the catalogue
 * declares and no code enforces, each with the module that owes it. The list
 * is the honest version of a backlog: a permission on a role's list that
 * nothing checks is a restriction the owner believes they applied.
 *
 * Four of its entries said the same thing in different words: the data is
 * written and nothing reads it back.
 *
 *   `audit:read`    every mutation writes a before and after, and the module
 *                   page claims "a customer can replay their entire history
 *                   from the log". No screen could read it.
 *   `ledger:read`   postings are written, append only and trigger enforced,
 *                   and no trial balance or journal existed. The whole
 *                   argument for double entry is that it is auditable.
 *   `payment:read`  payments are taken and allocated. "What came in this
 *                   week" went to the card processor's dashboard, which does
 *                   not know about the cheques.
 *   `deposit:read`  deposits are requested, received, applied and refunded,
 *                   and nothing listed what was still held, which is a
 *                   LIABILITY and the number that bankrupts a contractor who
 *                   reads their bank balance as profit.
 *
 * `ledger:post` is NOT here and stays owed on purpose. A posting in this
 * product is a consequence of a guarded business action, never a bare entry.
 * An operator who can post freely can make the books say anything with no
 * document behind it.
 */

/* ------------------------------------------------------------- audit log */

export const AuditRow = z.object({
  id: Uuid,
  /** Null for the system, the worker, a workflow or the portal. */
  actorUserId: Uuid.nullable(),
  /** Set when a model acted, which is a different fact from a person acting. */
  actorAgentId: z.string().nullable(),
  actorPortalGrantId: Uuid.nullable(),
  /** The contact on the customer who held that grant, when a contact signed in as the customer. */
  actorContactId: Uuid.nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: Uuid.nullable(),
  before: z.unknown(),
  after: z.unknown(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  at: z.string(),
});

export const readAuditLog = defineRoute({
  method: "get",
  path: "/v1/audit",
  summary: "Who did what to what",
  description:
    "Keyset paged on time rather than offset, because this is the one table that grows while somebody reads it and an offset cursor shows rows twice while missing others. There is no delete and no edit: an audit log that can be corrected is not one.",
  module: "M01",
  permissions: ["audit:read"],
  input: z.object({
    entityType: z.string().max(60).optional(),
    entityId: Uuid.optional(),
    actorUserId: Uuid.optional(),
    action: z.string().max(80).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({ rows: z.array(AuditRow), nextBefore: z.string().nullable() }),
});

export const getRecordHistory = defineRoute({
  method: "get",
  path: "/v1/audit/history",
  summary: "One record's whole history, oldest first",
  description:
    "Forwards, because the order is the point: 'what happened to this invoice' is read forwards, and a caller who has to remember to flip the sort will describe a history backwards to a customer.",
  module: "M01",
  permissions: ["audit:read"],
  input: z.object({
    entityType: z.string().min(1).max(60),
    entityId: Uuid,
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({ rows: z.array(AuditRow) }),
});

/* ---------------------------------------------------------- the ledger */

const AccountClass = z.enum(["asset", "liability", "equity", "revenue", "expense"]);
/** A branch's id, or "none" for the entries that carry no branch. */
const LedgerBranch = z.union([Uuid, z.literal("none")]);
const Direction = z.enum(["debit", "credit"]);

export const getTrialBalance = defineRoute({
  method: "get",
  path: "/v1/ledger/trial-balance",
  summary: "Every account, both sides, and its balance",
  description:
    "The whole company, or one branch with businessUnitId (an id, or \"none\" for the entries that carry no branch). Every posting made since branches were carried on postings has the branch of the invoice or job it came from; older ones have none, and so do the postings that belong to the company (payroll, the release of deferred revenue) or to two branches at once. `branch` says how many entries in the window carry no branch, what their debits add up to, and the first day any entry carries one, so a branch's figures are never read as the whole of its books. Balances are signed towards each account's own normal side, so a positive number always means more of what that account holds and a contra revenue account comes back negative. Total debits and credits are reported rather than asserted: a trigger already refuses an unbalanced posting, and printing both is how a reader confirms that instead of taking the schema's word for it. That is the whole company's claim: one branch's totals need not be equal, because a journal can give each of its lines a branch of its own.",
  module: "M14",
  permissions: ["ledger:read"],
  input: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    businessUnitId: LedgerBranch.optional(),
  }),
  output: z.object({
    rows: z.array(z.object({
      accountCode: z.string(),
      accountClass: AccountClass,
      normalBalance: Direction,
      debits: MoneyString,
      credits: MoneyString,
      balance: MoneyString,
      currency: z.string(),
    })),
    totalDebits: MoneyString,
    totalCredits: MoneyString,
    balanced: z.boolean(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    branch: z.object({
      filter: z.string().nullable(),
      entries: z.number().int(),
      withoutBranch: z.number().int(),
      withoutBranchDebits: MoneyString,
      firstBranchedOn: z.string().nullable(),
    }),
  }),
});

export const listJournal = defineRoute({
  method: "get",
  path: "/v1/ledger/journal",
  summary: "Postings, grouped by transaction",
  description:
    "Grouped rather than a flat list of entries, and paged by transaction rather than by row. Double entry is only readable when the two sides of one event sit next to each other, and a page boundary in the middle of a posting shows a reader half an event and invites them to conclude the books do not balance.",
  module: "M14",
  permissions: ["ledger:read"],
  input: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    jobId: Uuid.optional(),
    customerId: Uuid.optional(),
    accountCode: z.string().max(20).optional(),
    businessUnitId: LedgerBranch.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({
    transactions: z.array(z.object({
      transactionId: Uuid,
      occurredAt: z.string(),
      sourceType: z.string(),
      sourceId: Uuid,
      lines: z.array(z.object({
        direction: Direction,
        accountCode: z.string(),
        accountClass: AccountClass,
        amount: MoneyString,
        currency: z.string(),
        memo: z.string().nullable(),
        jobId: Uuid.nullable(),
        customerId: Uuid.nullable(),
        businessUnitId: Uuid.nullable(),
        reversesEntryId: Uuid.nullable(),
      })),
      totalDebits: MoneyString,
      totalCredits: MoneyString,
    })),
  }),
});

/* --------------------------------------------------------------- payments */

/**
 * Payments are listed by `listPayments` in `./billing`, which carries the
 * per-method totals this file first declared alongside the paging, the
 * `externalRef` lookup and the held-money filter a migration reads back with.
 * Two routes on `GET /v1/payments` arrived from two branches at once, and one
 * path can only answer one way.
 */

/* --------------------------------------------------------------- deposits */

export const listDeposits = defineRoute({
  method: "get",
  path: "/v1/deposits",
  summary: "Money held against work not yet done",
  description:
    "Outstanding is computed from received less applied less refunded rather than stored, because a fifth column can disagree with the four it comes from and the one it would disagree with is the liability on the balance sheet.",
  module: "M13",
  permissions: ["deposit:read"],
  input: z.object({
    customerId: Uuid.optional(),
    jobId: Uuid.optional(),
    estimateId: Uuid.optional(),
    status: z.string().max(40).optional(),
    outstandingOnly: z.boolean().optional(),
  }),
  output: z.object({
    deposits: z.array(z.object({
      id: Uuid,
      customerId: Uuid,
      estimateId: Uuid.nullable(),
      jobId: Uuid.nullable(),
      appliedInvoiceId: Uuid.nullable(),
      status: z.string(),
      currency: z.string(),
      amountRequested: MoneyString,
      amountReceived: MoneyString,
      amountApplied: MoneyString,
      amountRefunded: MoneyString,
      outstanding: MoneyString,
      requestedAt: z.string(),
      receivedAt: z.string().nullable(),
      appliedAt: z.string().nullable(),
    })),
    totalOutstanding: MoneyString,
  }),
});

export const readbackRoutes = {
  readAuditLog,
  getRecordHistory,
  getTrialBalance,
  listJournal,
  listDeposits,
} as const;
