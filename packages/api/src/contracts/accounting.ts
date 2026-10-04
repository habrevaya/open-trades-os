import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE ACCOUNTING BRIDGE
 *
 * M14. The product writes balanced double entry postings and, until this
 * module, synced them nowhere.
 *
 * WHAT THIS SURFACE DELIBERATELY DOES NOT OFFER
 *
 * There is no "push this invoice now" endpoint taking an invoice id. Every
 * document goes through one pass with one claim per document, because an
 * endpoint that pushes on demand is a second path to the same side effect and
 * the two would have to agree about idempotency forever. They would not.
 *
 * There is no endpoint that returns a credential, a token or anything derived
 * from one. The refresh token is a reference into the secret store and it
 * never reaches a response body, so there is nowhere in this file for it to
 * appear.
 *
 * THE READ BUDGET IS PART OF THE CONTRACT. Two of these routes can come back
 * saying the accounting system has refused further reads until its metering
 * window rolls. That is not an error and it is not modelled as one: Intuit
 * charges for reads and blocks the overage with a 429 rather than billing it,
 * so running out is an ordinary state a caller has to be able to render.
 */

/** Present on every response that could have been stopped by the meter. */
export const ReadBlock = z.object({
  /** `read_budget_exhausted`, or null when the read happened. */
  blocked: z.string().nullable(),
  retryAfterSeconds: z.number().int().nullable(),
});

export const getAccountingStatus = defineRoute({
  method: "get",
  path: "/v1/accounting/status",
  summary: "Whether the books are connected and up to date",
  description:
    "The unmapped account codes are the important field. A code with no mapping stops every document that posts to it, by design, because guessing which income account a company's revenue belongs in is how a year gets misfiled.",
  module: "M14",
  permissions: ["accounting:sync"],
  input: z.object({}),
  output: z.object({
    connected: z.boolean(),
    provider: z.string().nullable(),
    unmappedAccountCodes: z.array(z.string()),
    pendingDocuments: z.number().int(),
    /** Failed, plus anything deleted over there. Both need a person. */
    failedDocuments: z.number().int(),
    linkedDocuments: z.number().int(),
    lastRun: z.object({
      id: Uuid,
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().nullable(),
      recordsRead: z.number().int(),
      recordsWritten: z.number().int(),
      cursor: z.string().nullable(),
      blockedReason: z.string().nullable(),
      error: z.string().nullable(),
    }).nullable(),
    closedThrough: z.string().nullable(),
  }),
});

export const listAccountingAccounts = defineRoute({
  method: "get",
  path: "/v1/accounting/accounts",
  summary: "The chart of accounts to map onto",
  description:
    "The only call in this module that reads the remote chart of accounts, and it runs when a person opens the mapping screen rather than on a worker tick. That is why the mapping stores a resolved id: the sync does a join and never pays for this.",
  module: "M14",
  permissions: ["accounting:sync"],
  input: z.object({}),
  output: ReadBlock.extend({
    accounts: z.array(z.object({
      externalId: z.string(),
      name: z.string(),
      /** The provider's own object type. A QuickBooks invoice line references an Item. */
      kind: z.string(),
      classification: z.enum(["income", "expense", "asset", "liability", "equity", "other"]),
      number: z.string().nullable(),
      active: z.boolean(),
    })),
    error: z.string().nullable(),
  }),
});

export const listAccountMappings = defineRoute({
  method: "get",
  path: "/v1/accounting/mappings",
  summary: "Which of our account codes point where",
  module: "M14",
  permissions: ["accounting:sync"],
  input: z.object({}),
  output: z.object({
    mappings: z.array(z.object({
      accountCode: z.string(),
      externalId: z.string(),
      externalName: z.string(),
      externalKind: z.string(),
    })),
  }),
});

export const setAccountMapping = defineRoute({
  method: "put",
  path: "/v1/accounting/mappings",
  summary: "Point one account code at an account over there",
  description:
    "Audited, because remapping moves where every future posting on that code lands. 'Revenue started going somewhere else in September' is a question with an answer only if somebody recorded that it happened and who did it.",
  module: "M14",
  permissions: ["accounting:sync"],
  idempotent: true,
  input: z.object({
    /** Ours. See ACCOUNTS in packages/core/src/ledger. */
    accountCode: z.string().min(1).max(50),
    externalId: z.string().min(1).max(200),
    /** What the operator saw when they chose it, frozen so the screen costs no reads. */
    externalName: z.string().min(1).max(500),
    externalKind: z.string().min(1).max(50),
  }),
  output: z.object({
    accountCode: z.string(),
    externalId: z.string(),
    externalName: z.string(),
    externalKind: z.string(),
  }),
});

export const runAccountingSync = defineRoute({
  method: "post",
  path: "/v1/accounting/sync",
  summary: "Run one sync pass now",
  description:
    "Idempotent in the way that matters: a document already in the books is skipped from a local row, not re-sent, and running this twice in a row cannot produce two invoices. `blockedReason` set to read_budget_exhausted means the accounting system refused further reads, which is not a failure: the outbound half still ran and the cursor was not advanced.",
  module: "M14",
  permissions: ["accounting:sync"],
  idempotent: true,
  input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
  output: z.object({
    runId: Uuid,
    provider: z.string(),
    pushed: z.number().int(),
    adopted: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    reads: z.number().int(),
    writes: z.number().int(),
    cursor: z.string().nullable(),
    changesSeen: z.number().int(),
    more: z.boolean(),
    blockedReason: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const listAccountingRuns = defineRoute({
  method: "get",
  path: "/v1/accounting/runs",
  summary: "Sync history",
  description:
    "What an operator opens when somebody says the books look stale. A run that read nothing and was blocked says so, so a metering ceiling is distinguishable from a broken credential.",
  module: "M14",
  permissions: ["accounting:sync"],
  input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  output: z.object({
    runs: z.array(z.object({
      id: Uuid,
      direction: z.string(),
      entityType: z.string().nullable(),
      cursor: z.string().nullable(),
      recordsRead: z.number().int(),
      recordsWritten: z.number().int(),
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().nullable(),
      blockedReason: z.string().nullable(),
      error: z.string().nullable(),
    })),
  }),
});

/**
 * What a document in the books can be. `credit_memo` is a void or a write off
 * of an invoice; `credit_note` and the three after it are the credit notes this
 * company issues, applies, takes back and pays out as money.
 */
const AccountingDocumentKind = z.enum([
  "customer", "invoice", "payment", "credit_memo", "refund",
  "credit_note", "credit_note_application", "credit_note_void", "credit_note_refund", "journal",
]);

export const listAccountingProblems = defineRoute({
  method: "get",
  path: "/v1/accounting/problems",
  summary: "Documents that need a person",
  description:
    "A document stops being retried after five attempts, so a line naming a deleted item does not sit in a loop forever looking like nothing is wrong. Everything that stopped is here with the reason it stopped.",
  module: "M14",
  permissions: ["accounting:sync"],
  input: z.object({}),
  output: z.object({
    problems: z.array(z.object({
      id: Uuid,
      kind: AccountingDocumentKind,
      entityId: Uuid,
      idempotencyKey: z.string(),
      attempts: z.number().int(),
      lastError: z.string().nullable(),
      updatedAt: z.string().datetime(),
    })),
  }),
});

export const retryAccountingDocument = defineRoute({
  method: "post",
  path: "/v1/accounting/problems/{id}/retry",
  summary: "Offer a failed document again",
  description:
    "Resets the attempt counter and nothing else. The claim row, and therefore the guarantee that this document cannot be created twice, survives the retry.",
  module: "M14",
  permissions: ["accounting:sync"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    kind: AccountingDocumentKind,
    attempts: z.number().int(),
  }),
});

export const listAccountingPeriods = defineRoute({
  method: "get",
  path: "/v1/accounting/periods",
  summary: "Which periods are closed",
  module: "M14",
  permissions: ["accounting:sync"],
  input: z.object({}),
  output: z.object({
    periods: z.array(z.object({
      id: Uuid,
      periodEnd: z.string(),
      closedAt: z.string().datetime(),
      note: z.string().nullable(),
      reopenedAt: z.string().datetime().nullable(),
      reopenedReason: z.string().nullable(),
    })),
  }),
});

export const closeAccountingPeriod = defineRoute({
  method: "post",
  path: "/v1/accounting/periods/close",
  summary: "Declare a period filed",
  description:
    "A different permission from running the sync, because they are different powers. After a close, the sync will not push anything dated inside the period, so a late invoice cannot change a number that has already gone to a tax authority. The worker holds accounting:sync and deliberately does not hold this.",
  module: "M14",
  permissions: ["accounting:close"],
  idempotent: true,
  input: z.object({
    /** The last day the close covers. Everything on or before it is frozen. */
    periodEnd: z.string().date(),
    note: z.string().max(2000).optional(),
  }),
  output: z.object({
    id: Uuid,
    periodEnd: z.string(),
    closedAt: z.string().datetime(),
  }),
});

export const reopenAccountingPeriod = defineRoute({
  method: "post",
  path: "/v1/accounting/periods/reopen",
  summary: "Reopen a period that was closed by mistake",
  description:
    "Same permission as closing, and the reason is required. A close that cannot be undone is not a control, it is an obstacle, and people get around obstacles by back-dating documents into a period that is still open, which is worse and leaves no trace.",
  module: "M14",
  permissions: ["accounting:close"],
  idempotent: true,
  input: z.object({
    periodEnd: z.string().date(),
    reason: z.string().min(1).max(2000),
  }),
  output: z.object({
    id: Uuid,
    periodEnd: z.string(),
    reopenedAt: z.string().datetime().nullable(),
  }),
});

export const accountingRoutes = {
  getAccountingStatus, listAccountingAccounts, listAccountMappings, setAccountMapping,
  runAccountingSync, listAccountingRuns, listAccountingProblems, retryAccountingDocument,
  listAccountingPeriods, closeAccountingPeriod, reopenAccountingPeriod,
} as const;
