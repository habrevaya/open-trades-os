import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, ledger, money as m, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import {
  AccountingNotConfiguredError, createProvider,
  type AccountingEntityKind, type AccountingProvider, type ExternalCreditApplication,
  type ExternalInvoiceLine, type ExternalRef, type ReadResult,
} from "../accounting/provider";

/**
 * THE ACCOUNTING BRIDGE
 *
 * The product has written balanced double entry postings since the first
 * migration and synced them nowhere. This is the half that gets a company's
 * invoices, payments and write-offs into the books their accountant actually
 * opens.
 *
 * THREE THINGS DECIDE THE SHAPE OF THIS FILE.
 *
 * 1. IDEMPOTENCY, which is the hard part and the one that costs real money
 *    when it is wrong. A sync that runs twice must not put two invoices in
 *    somebody's QuickBooks. The rule is stated in full above `claim` below
 *    and it is enforced by a unique index rather than by a check followed by
 *    an insert, because two workers both passing a check is not a rare race,
 *    it is what happens the first time a pass takes longer than the tick.
 *
 * 2. READS ARE METERED AND WRITES ARE NOT. Intuit charges for reads and
 *    refuses the overage with a 429 instead of billing it. So the sync never
 *    asks the accounting system what it already knows: "have I pushed this"
 *    is answered from `accounting_entity_link`, locally. The only reads on
 *    the outbound path are crash recovery, and the only read on the inbound
 *    path is one change feed request. Running out of reads is recorded on
 *    `sync_run.blocked_reason` and the pass keeps going, because the
 *    outbound half does not need reads at all.
 *
 * 3. NOTHING IS GUESSED ABOUT WHERE MONEY LANDS. An invoice line with no
 *    mapped account is refused by name rather than defaulted into an income
 *    account that looked plausible. A default here is a year of misfiled
 *    revenue that an accountant finds in March.
 *
 * `sync_run` has existed as a table since the first migration with nothing
 * reading or writing it. This file is the first thing that does.
 */

/** The accounting system's own limit on how many documents a pass moves.
 *  A pass that never finishes holds nothing open, but it does mean the next
 *  tick overlaps with this one, and overlap is what the claim exists for. */
const DEFAULT_PUSH_LIMIT = 100;

/**
 * How many times a document is offered before the sync stops offering it.
 *
 * Without a ceiling, a document QuickBooks will never accept, a line naming
 * a deleted item, say, is retried on every tick forever and the failure is
 * invisible because each pass looks like the last. With one, it stops and
 * shows up on the status screen as something a person has to look at.
 */
const MAX_ATTEMPTS = 5;

/** The one value `sync_run.blocked_reason` takes today. See the column. */
export const READ_BUDGET_EXHAUSTED = "read_budget_exhausted";

/**
 * How long a `pending` claim is assumed to belong to a worker that is still
 * working.
 *
 * The same argument as `STUCK_AFTER_MS` in the outbox, and the same window
 * for the same reason. A claim written seconds ago belongs to another pass
 * that is making the HTTP call RIGHT NOW, and treating it as a crash means
 * two workers both push the same invoice. A claim written half an hour ago
 * belongs to a process that died, and treating it as in flight means the
 * document never goes at all.
 *
 * Long on purpose. Recovering too eagerly creates the duplicate the claim
 * exists to prevent; recovering too late costs one pass.
 */
const IN_FLIGHT_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------- the actor */

/**
 * The worker's actor, with `accounting:sync` named as a grant rather than
 * carried by a role.
 *
 * Same pattern as the outbox: the background actor holds exactly the
 * permissions the background work needs and nothing else, so a bug in the
 * sync cannot reach anything a sync has no business reaching. It deliberately
 * does NOT hold `accounting:close`, because closing a period is a decision a
 * person makes and a worker must never make it.
 */
export function syncActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["accounting:sync"],
    agentId: "accounting-sync",
  };
}

/* --------------------------------------------------------- the connection */

export interface AccountingConnection {
  id: string;
  provider: string;
  credentialRef: string | null;
  settings: Record<string, unknown>;
}

/**
 * The accounting system this organization has connected.
 *
 * Resolved per organization rather than from an environment variable, because
 * a hosted deployment serves many companies and each brings their own books.
 * One connection: `integration_connection` is unique on organization,
 * capability and provider, and two connected accounting systems would mean
 * two sets of external ids with nothing choosing between them.
 */
export async function connectionFor(
  tx: Database, organizationId: string,
): Promise<AccountingConnection> {
  const [row] = await tx.select({
    id: schema.integrationConnection.id,
    provider: schema.integrationConnection.provider,
    credentialRef: schema.integrationConnection.credentialRef,
    settings: schema.integrationConnection.settings,
  })
    .from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "accounting"),
      eq(schema.integrationConnection.status, "connected"),
    ))
    .limit(1);

  if (!row) throw new AccountingNotConfiguredError("accounting");
  return row;
}

/**
 * The provider for this organization, with its credential fetched by
 * reference from wherever the deployment keeps secrets.
 *
 * `writeSecret` is not optional in spirit. OAuth refresh tokens rotate, and a
 * deployment that cannot persist the rotated one has a connection with a
 * lifespan measured in days. It is optional in the type only so that a
 * read-only caller does not have to supply one.
 */
export async function providerFor(
  tx: Database,
  organizationId: string,
  readSecret: (ref: string) => Promise<string>,
  writeSecret?: (ref: string, value: string) => Promise<void>,
): Promise<{ connection: AccountingConnection; provider: AccountingProvider }> {
  const connection = await connectionFor(tx, organizationId);
  const ref = connection.credentialRef;
  const secret = ref ? await readSecret(ref) : "";
  const provider = createProvider(connection.provider, connection.settings, secret, {
    ...(ref && writeSecret
      ? { onCredentialRotated: (credential: string) => writeSecret(ref, credential) }
      : {}),
  });
  return { connection, provider };
}

/* ------------------------------------------------------- account mapping */

/**
 * WHERE THE MAPPING LIVES, AND WHY THERE.
 *
 * In `account_mapping`, in Postgres, one row per (connection, account code).
 * Not a config file, not an environment variable, not a constant in this
 * repository, and not a jsonb blob on the connection.
 *
 * A file or an environment variable is edited by whoever can deploy. The
 * person who knows that this company's service revenue belongs in 40100 and
 * not 40000 is their bookkeeper, who has never opened a terminal. Putting the
 * mapping where only a deploy can change it means it does not get changed, it
 * gets worked around, and the workaround is journal entries somebody makes by
 * hand every month.
 *
 * A jsonb blob on `integration_connection.settings` would be closer but
 * cannot carry a unique index on a key inside it, so two mappings for one
 * account code are expressible and nothing would say which one won.
 *
 * Per CONNECTION rather than per organization, because a company that leaves
 * QuickBooks for Xero must start with an empty mapping. QuickBooks account
 * ids name nothing in Xero, and inheriting them would post a year of revenue
 * into whatever happened to share a number.
 *
 * Core has claimed since it was written that "the mapping lives in
 * account_mapping". There was no such table until now. That sentence is one
 * of the things this module makes true.
 */
export interface AccountMappingInput {
  accountCode: string;
  externalId: string;
  externalName: string;
  externalKind: string;
}

export async function setMapping(ctx: ServiceContext, input: AccountMappingInput) {
  return guardedWrite(ctx, "accounting:sync", async (tx) => {
    const connection = await connectionFor(tx, ctx.actor.organizationId);

    const [before] = await tx.select().from(schema.accountMapping)
      .where(and(
        eq(schema.accountMapping.connectionId, connection.id),
        eq(schema.accountMapping.accountCode, input.accountCode),
      )).limit(1);

    const values = {
      organizationId: ctx.actor.organizationId,
      connectionId: connection.id,
      accountCode: input.accountCode,
      externalId: input.externalId,
      externalName: input.externalName,
      externalKind: input.externalKind,
      updatedAt: new Date(),
    };

    const [row] = await tx.insert(schema.accountMapping).values(values)
      .onConflictDoUpdate({
        target: [schema.accountMapping.connectionId, schema.accountMapping.accountCode],
        set: {
          externalId: input.externalId,
          externalName: input.externalName,
          externalKind: input.externalKind,
          updatedAt: new Date(),
        },
      })
      .returning();

    /**
     * Audited, because remapping an account changes where every future
     * posting on that code lands. "Revenue moved to a different account in
     * September" is a question with an answer only if somebody wrote down
     * that it happened and who did it.
     */
    await audit(tx, ctx, "accounting.account_mapped", "account_mapping", row!.id, before ?? null, row!);

    return {
      accountCode: row!.accountCode,
      externalId: row!.externalId,
      externalName: row!.externalName,
      externalKind: row!.externalKind,
    };
  });
}

export async function listMappings(ctx: ServiceContext) {
  return guardedRead(ctx, "accounting:sync", async (tx) => {
    const connection = await connectionFor(tx, ctx.actor.organizationId);
    const rows = await tx.select().from(schema.accountMapping)
      .where(eq(schema.accountMapping.connectionId, connection.id))
      .orderBy(asc(schema.accountMapping.accountCode));
    return rows.map((row) => ({
      accountCode: row.accountCode,
      externalId: row.externalId,
      externalName: row.externalName,
      externalKind: row.externalKind,
    }));
  });
}

/**
 * The chart of accounts to choose from.
 *
 * The provider call happens OUTSIDE the transaction the permission check
 * opened. A metered HTTP request with a database transaction held open across
 * it pins a pooled connection for as long as Intuit takes to answer, and
 * Intuit under load takes seconds.
 *
 * This is the only code path that reads the remote chart of accounts, it runs
 * when a person opens the mapping screen, and it never runs on a worker tick.
 * That is the whole reason `account_mapping` stores the resolved id.
 */
export async function listRemoteAccounts(
  ctx: ServiceContext, deps: { provider: AccountingProvider },
) {
  await guardedRead(ctx, "accounting:sync", (tx) => connectionFor(tx, ctx.actor.organizationId));

  const result = await deps.provider.accounts();
  if (!result.ok) {
    return {
      accounts: [],
      blocked: result.budgetExhausted ? READ_BUDGET_EXHAUSTED : null,
      error: result.budgetExhausted ? null : `${result.code}: ${result.message}`,
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }
  return {
    accounts: result.value,
    blocked: null,
    error: null,
    retryAfterSeconds: null,
  };
}

/** Every account code a posting in this organization has actually used, and
 *  whether it is mapped. The work list for the mapping screen. */
export async function unmappedAccountCodes(
  tx: Database, organizationId: string, connectionId: string,
): Promise<string[]> {
  const used = await tx.selectDistinct({ accountCode: schema.ledgerEntry.accountCode })
    .from(schema.ledgerEntry)
    .where(eq(schema.ledgerEntry.organizationId, organizationId));

  const mapped = await tx.select({ accountCode: schema.accountMapping.accountCode })
    .from(schema.accountMapping)
    .where(eq(schema.accountMapping.connectionId, connectionId));

  const known = new Set(mapped.map((row) => row.accountCode));
  return used.map((row) => row.accountCode).filter((code) => !known.has(code)).sort();
}

/* -------------------------------------------------------- period closing */

export class PeriodClosedError extends ConflictError {
  constructor(public readonly periodEnd: string, date: string) {
    super(
      `${date} falls in a period closed through ${periodEnd}. `
      + "Reopen the period or date the document after it.",
    );
    this.name = "PeriodClosedError";
  }
}

/**
 * The last day that has been closed, or null.
 *
 * A reopened close does not count, which is the point of keeping the row
 * rather than deleting it: "this quarter was closed and then reopened on the
 * 14th by Dana" is a fact an auditor asks for, and a deleted row cannot
 * answer it.
 */
export async function closedThrough(
  tx: Database, organizationId: string,
): Promise<string | null> {
  const [row] = await tx.select({ periodEnd: schema.accountingPeriod.periodEnd })
    .from(schema.accountingPeriod)
    .where(and(
      eq(schema.accountingPeriod.organizationId, organizationId),
      isNull(schema.accountingPeriod.reopenedAt),
    ))
    .orderBy(desc(schema.accountingPeriod.periodEnd))
    .limit(1);
  return row?.periodEnd ?? null;
}

/**
 * Close a period.
 *
 * `accounting:close` and not `accounting:sync`, because they are different
 * powers. Running the sync is operational and a bookkeeper or the worker does
 * it constantly. Closing a period says "this quarter is filed", and after it
 * the sync will refuse to touch anything dated inside it. A worker holds the
 * first and must never hold the second.
 */
export async function closePeriod(
  ctx: ServiceContext, input: { periodEnd: string; note?: string | undefined },
) {
  return guardedWrite(ctx, "accounting:close", async (tx) => {
    const existing = await closedThrough(tx, ctx.actor.organizationId);
    /**
     * Closing backwards is refused. A company closed through March that
     * closes February has said nothing, and a screen that accepted it would
     * imply March had been reopened. If that is what somebody meant, they
     * reopen March explicitly and it is on the record.
     */
    if (existing && existing >= input.periodEnd) {
      throw new ConflictError(
        `The books are already closed through ${existing}, which is on or after ${input.periodEnd}.`,
      );
    }

    const [row] = await tx.insert(schema.accountingPeriod).values({
      organizationId: ctx.actor.organizationId,
      periodEnd: input.periodEnd,
      closedAt: new Date(),
      closedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      note: input.note ?? null,
      reopenedAt: null,
      reopenedByUserId: null,
      reopenedReason: null,
    }).returning();

    await audit(tx, ctx, "accounting.period_closed", "accounting_period", row!.id, null, row!);
    return { id: row!.id, periodEnd: row!.periodEnd, closedAt: row!.closedAt };
  });
}

/**
 * Reopen one.
 *
 * Possible, and deliberately the same permission. A period closed by mistake
 * that cannot be reopened is not a control, it is an obstacle, and people get
 * around obstacles by back-dating documents into a period that is still open,
 * which is worse than the mistake and leaves no trace.
 *
 * The reason is required. A reopened quarter with no explanation is the
 * question an auditor asks first.
 */
export async function reopenPeriod(
  ctx: ServiceContext, input: { periodEnd: string; reason: string },
) {
  return guardedWrite(ctx, "accounting:close", async (tx) => {
    const [row] = await tx.select().from(schema.accountingPeriod)
      .where(and(
        eq(schema.accountingPeriod.organizationId, ctx.actor.organizationId),
        eq(schema.accountingPeriod.periodEnd, input.periodEnd),
        isNull(schema.accountingPeriod.reopenedAt),
      )).limit(1);
    if (!row) throw new NotFoundError("Closed period");

    const [updated] = await tx.update(schema.accountingPeriod).set({
      reopenedAt: new Date(),
      reopenedByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      reopenedReason: input.reason,
      updatedAt: new Date(),
    }).where(eq(schema.accountingPeriod.id, row.id)).returning();

    await audit(tx, ctx, "accounting.period_reopened", "accounting_period", row.id, row, updated!);
    return { id: updated!.id, periodEnd: updated!.periodEnd, reopenedAt: updated!.reopenedAt };
  });
}

export async function listPeriods(ctx: ServiceContext) {
  return guardedRead(ctx, "accounting:sync", async (tx) => {
    const rows = await tx.select().from(schema.accountingPeriod)
      .where(eq(schema.accountingPeriod.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.accountingPeriod.periodEnd));
    return rows.map((row) => ({
      id: row.id,
      periodEnd: row.periodEnd,
      closedAt: row.closedAt,
      note: row.note,
      reopenedAt: row.reopenedAt,
      reopenedReason: row.reopenedReason,
    }));
  });
}

/* ------------------------------------------------------ idempotency keys */

/**
 * A short, stable marker derived from our id.
 *
 * QuickBooks' `PaymentRefNum` holds twenty one characters, so a uuid does not
 * fit and truncating one is not deterministic enough to look up. A hash
 * prefix is both. `OT` in front so a bookkeeper looking at a reference in
 * their books can tell it came from here.
 */
export function shortKey(prefix: string, id: string): string {
  return prefix + createHash("sha256").update(id).digest("hex").slice(0, 16);
}

/**
 * THE MARKER THAT GOES ON THE DOCUMENT, per kind.
 *
 * It has to land in a field the accounting system can be QUERIED on, because
 * its whole job is to answer "did the push I lost the response to actually
 * land". A private note cannot be searched in QuickBooks, so the key goes
 * somewhere real and visible:
 *
 *   invoice      our invoice number, which the bookkeeper wanted there anyway
 *   credit memo  the same number with a C in front, so a credit and the
 *                invoice it reverses are legible side by side
 *   payment      a hash prefix, because the reference field is short
 *   customer     the customer's own name, because QuickBooks requires display
 *                names to be unique and a synthetic token there would show up
 *                on every invoice the customer receives
 */
export const invoiceKey = (number: number): string => String(number);
export const creditKey = (number: number): string => `C${number}`;
export const paymentKey = (paymentId: string): string => shortKey("OT", paymentId);
/** A refund's ledger transaction, hashed like a payment, `OR` for "our refund". */
export const refundKey = (transactionId: string): string => shortKey("OR", transactionId);
export const customerKey = (name: string): string => name.trim();
/**
 * A credit note's own number, `CN` in front. Not `C`, which is what an
 * invoice's void or write off carries with the INVOICE's number, and the two
 * sequences overlap: credit note 12 and invoice 12 are different documents.
 */
export const creditNoteKey = (number: number): string => `CN${number}`;
/** The invoice that reverses a voided credit note, numbered from it. */
export const creditNoteVoidKey = (number: number): string => `CNV${number}`;
/**
 * An application's zero payment or allocation, hashed like a payment, `OA`
 * for "our application". The settlement a void makes is keyed by the credit
 * note's own id through the same function, and no application row can share
 * a credit note's id.
 */
export const creditApplicationKey = (id: string): string => shortKey("OA", id);

/* ------------------------------------------------------------- the claim */

export type ClaimResult =
  | { kind: "claimed"; linkId: string; attempts: number }
  /** A previous pass got as far as the HTTP call and lost the answer. */
  | { kind: "recover"; linkId: string; attempts: number; idempotencyKey: string }
  | { kind: "linked"; linkId: string; externalId: string }
  | { kind: "busy" }
  | { kind: "exhausted"; linkId: string; lastError: string | null };

/**
 * THE IDEMPOTENCY RULE, STATED ONCE.
 *
 *   A local entity is pushed to the accounting system at most once per
 *   connection, and the thing that makes that true is a row in
 *   `accounting_entity_link` written and COMMITTED BEFORE the HTTP call,
 *   under a unique index on (connection_id, kind, entity_id).
 *
 * Three cases, and all three are covered by that one sentence:
 *
 *   ALREADY DONE. A `linked` row exists. Nothing is sent. This is the
 *   ordinary case on every pass after the first, and answering it locally is
 *   what keeps the sync inside a read budget it cannot pay past.
 *
 *   TWO WORKERS AT ONCE. Both try to insert. The unique index lets exactly
 *   one in; the other gets no row back from `on conflict do nothing` and
 *   skips. This is why the guard is an index and not a select followed by an
 *   insert: two transactions both reading "no row" and both inserting is not
 *   a rare interleaving, it is the normal outcome when a pass runs longer
 *   than the worker tick.
 *
 *   CRASHED MID-PUSH. The claim committed, the create succeeded, the process
 *   died before the response was stored. The row is `pending` with no
 *   external id, which is the one state that cannot be resolved locally,
 *   because from here "it never went" and "it went and I lost the receipt"
 *   look identical. That case, and only that case, spends one metered read
 *   asking the provider whether a document carrying our key exists.
 *
 * Note what is NOT relied on: the provider having its own idempotency key
 * header. QuickBooks has none, Xero's is scoped to twenty four hours, and a
 * guarantee that expires is not a guarantee for a document that failed over a
 * weekend.
 */
export async function claim(
  tx: Database,
  organizationId: string,
  connectionId: string,
  kind: AccountingEntityKind,
  entityId: string,
  idempotencyKey: string,
): Promise<ClaimResult> {
  const [existing] = await tx.select().from(schema.accountingEntityLink)
    .where(and(
      eq(schema.accountingEntityLink.connectionId, connectionId),
      eq(schema.accountingEntityLink.kind, kind),
      eq(schema.accountingEntityLink.entityId, entityId),
    )).limit(1);

  if (existing?.state === "linked" && existing.externalId) {
    return { kind: "linked", linkId: existing.id, externalId: existing.externalId };
  }

  if (existing?.state === "deleted") {
    /**
     * Removed in the accounting system by a person. Not offered again, or
     * the sync spends every tick recreating a document somebody deleted on
     * purpose. Putting it back is a deliberate act through `retryDocument`.
     */
    return { kind: "exhausted", linkId: existing.id, lastError: existing.lastError };
  }

  if (existing) {
    if (existing.attempts >= MAX_ATTEMPTS) {
      return { kind: "exhausted", linkId: existing.id, lastError: existing.lastError };
    }

    /**
     * A FRESH `pending` ROW IS ANOTHER WORKER, NOT A CRASH.
     *
     * Two passes overlapping is the ordinary case once a pass takes longer
     * than the tick. Treating the other worker's in flight claim as a crash
     * would send the same invoice twice, which is the exact failure this
     * table exists to prevent, so a young claim is left alone.
     */
    if (existing.state === "pending"
        && Date.now() - existing.updatedAt.getTime() < IN_FLIGHT_MS) {
      return { kind: "busy" };
    }

    const [bumped] = await tx.update(schema.accountingEntityLink).set({
      attempts: existing.attempts + 1,
      state: "pending",
      updatedAt: new Date(),
    }).where(eq(schema.accountingEntityLink.id, existing.id)).returning();

    /**
     * A row that was already `pending` before this pass touched it is the
     * crash case. A `failed` row is not: its push returned an answer, that
     * answer was "no", and there is nothing on the far side to find.
     */
    return existing.state === "pending"
      ? { kind: "recover", linkId: bumped!.id, attempts: bumped!.attempts, idempotencyKey: existing.idempotencyKey }
      : { kind: "claimed", linkId: bumped!.id, attempts: bumped!.attempts };
  }

  const inserted = await tx.insert(schema.accountingEntityLink).values({
    organizationId,
    connectionId,
    kind,
    entityId,
    idempotencyKey,
    state: "pending",
    externalId: null,
    externalVersion: null,
    attempts: 1,
    lastError: null,
    pushedAt: null,
  }).onConflictDoNothing({
    target: [
      schema.accountingEntityLink.connectionId,
      schema.accountingEntityLink.kind,
      schema.accountingEntityLink.entityId,
    ],
  }).returning();

  const row = inserted[0];
  /**
   * NO ROW MEANS SOMEBODY ELSE HAS IT. Not an error, and not something to
   * retry in this pass: the worker that won the insert is making the call
   * right now, and a second attempt here is the duplicate invoice.
   */
  if (!row) return { kind: "busy" };
  return { kind: "claimed", linkId: row.id, attempts: row.attempts };
}

/**
 * Record what came back.
 *
 * The external id is checked against the other links on this connection
 * first. QuickBooks requires customer display names to be unique, so two
 * local customers called "Smith Plumbing" resolve to ONE QuickBooks customer,
 * and silently pointing both of our records at it would merge two companies'
 * receivables. The second one is failed with a message naming the problem,
 * because the fix is a human renaming one of them.
 */
export async function link(
  tx: Database,
  linkId: string,
  connectionId: string,
  kind: AccountingEntityKind,
  ref: ExternalRef,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const [taken] = await tx.select({ id: schema.accountingEntityLink.id })
    .from(schema.accountingEntityLink)
    .where(and(
      eq(schema.accountingEntityLink.connectionId, connectionId),
      eq(schema.accountingEntityLink.kind, kind),
      eq(schema.accountingEntityLink.externalId, ref.externalId),
    )).limit(1);

  if (taken && taken.id !== linkId) {
    const message =
      `Another record already maps to ${kind} ${ref.externalId} in the accounting system. `
      + "QuickBooks requires customer names to be unique, so two customers with the same "
      + "name collapse into one over there. Rename one of them.";
    await tx.update(schema.accountingEntityLink).set({
      state: "failed", lastError: message, updatedAt: new Date(),
    }).where(eq(schema.accountingEntityLink.id, linkId));
    return { ok: false, message };
  }

  await tx.update(schema.accountingEntityLink).set({
    state: "linked",
    externalId: ref.externalId,
    externalVersion: ref.version,
    lastError: null,
    pushedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(schema.accountingEntityLink.id, linkId));
  return { ok: true };
}

export async function markFailed(tx: Database, linkId: string, message: string): Promise<void> {
  await tx.update(schema.accountingEntityLink).set({
    state: "failed", lastError: message, updatedAt: new Date(),
  }).where(eq(schema.accountingEntityLink.id, linkId));
}

/* ----------------------------------------------------------- the sync pass */

export interface SyncDeps {
  /** Injected, so a test never reaches Intuit and a deployment never fakes one. */
  provider: AccountingProvider;
}

export interface SyncOptions {
  limit?: number;
}

export interface SyncOutcome {
  runId: string;
  provider: string;
  pushed: number;
  /** Documents that turned out to already be there. See `claim`. */
  adopted: number;
  skipped: number;
  failed: number;
  reads: number;
  writes: number;
  cursor: string | null;
  changesSeen: number;
  /** The provider has more changes than one page held. */
  more: boolean;
  /** Set when reads ran out. NOT an error: see sync_run.blocked_reason. */
  blockedReason: string | null;
  error: string | null;
}

/** The cursor the last pass that read anything left behind. */
export async function lastCursor(
  tx: Database, connectionId: string,
): Promise<string | null> {
  const [row] = await tx.select({ cursor: schema.syncRun.cursor })
    .from(schema.syncRun)
    .where(and(
      eq(schema.syncRun.connectionId, connectionId),
      isNotNull(schema.syncRun.cursor),
    ))
    .orderBy(desc(schema.syncRun.startedAt))
    .limit(1);
  return row?.cursor ?? null;
}

/**
 * ONE SYNC PASS FOR ONE ORGANIZATION.
 *
 * The `sync_run` row is opened in its own transaction and closed in another,
 * with the provider calls in between and NO transaction held across them.
 *
 * Both halves of that matter. Holding a transaction across a metered HTTP
 * call pins a pooled database connection for however long Intuit takes. And
 * doing the whole pass in one transaction would mean a failure rolls back the
 * `sync_run` row that records the failure, so the one artifact an operator
 * needs in order to know the sync is broken is the one thing that does not
 * survive it.
 *
 * A failure is RECORDED AND RETURNED rather than thrown, for the same reason
 * the worker catches per step: one company's expired credential must not end
 * the pass for every company behind it in the loop.
 */
export async function sync(
  ctx: ServiceContext, deps: SyncDeps, options: SyncOptions = {},
): Promise<SyncOutcome> {
  const organizationId = ctx.actor.organizationId;
  const limit = options.limit ?? DEFAULT_PUSH_LIMIT;

  const { connection, cursor: startCursor, closedOn } = await guardedWrite(
    ctx, "accounting:sync", async (tx) => {
      const found = await connectionFor(tx, organizationId);
      return {
        connection: found,
        cursor: await lastCursor(tx, found.id),
        closedOn: await closedThrough(tx, organizationId),
      };
    },
  );

  const runId = await guardedWrite(ctx, "accounting:sync", async (tx) => {
    const [row] = await tx.insert(schema.syncRun).values({
      organizationId,
      connectionId: connection.id,
      direction: "bidirectional",
      /** What this pass covers. A pass that moved only invoices would say so. */
      entityType: "billing",
      cursor: startCursor,
      recordsRead: 0,
      recordsWritten: 0,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      blockedReason: null,
    }).returning({ id: schema.syncRun.id });
    return row!.id;
  });

  const state = {
    pushed: 0, adopted: 0, skipped: 0, failed: 0,
    reads: 0, writes: 0, changesSeen: 0,
    more: false,
    blockedReason: null as string | null,
    error: null as string | null,
    cursor: startCursor,
  };

  /**
   * Every metered read goes through here.
   *
   * Once the budget is gone it stays gone for the rest of the pass: asking
   * again produces another 429 and, under Intuit's own rules, another mark
   * against a limit that is already breached. The pass continues, because the
   * outbound half needs no reads at all, and that is the point of separating
   * the two.
   */
  const meteredRead: MeteredRead = async <T,>(
    run: () => Promise<ReadResult<T>>,
  ): Promise<{ read: true; value: T } | { read: false }> => {
    if (state.blockedReason) return { read: false };
    state.reads += 1;
    const result = await run();
    if (result.ok) return { read: true, value: result.value };
    if (result.budgetExhausted) {
      state.blockedReason = READ_BUDGET_EXHAUSTED;
      return { read: false };
    }
    state.error = state.error ?? `${result.code}: ${result.message}`;
    return { read: false };
  };

  try {
    await pushOutbound(ctx, deps, connection, state, closedOn, limit, meteredRead);

    /**
     * INBOUND LAST, and only if there are reads left.
     *
     * Outbound first is deliberate. If the budget is already gone when the
     * pass starts, a company still gets its invoices into its books; only
     * the change feed waits. The reverse order would let a metering ceiling
     * stop the half of the integration that does not depend on reads.
     */
    const changes = await meteredRead(() => deps.provider.changes(state.cursor));
    if (changes.read) {
      state.cursor = changes.value.cursor;
      state.changesSeen = changes.value.changes.length;
      state.more = changes.value.more;
      await applyChanges(ctx, connection.id, changes.value.changes);
    }
  } catch (error) {
    /**
     * Recorded on the row, not swallowed and not rethrown. Swallowing it
     * leaves a pass that did nothing and says nothing; rethrowing it takes
     * the worker's whole tick with it.
     */
    state.error = error instanceof Error ? error.message : String(error);
  }

  await guardedWrite(ctx, "accounting:sync", async (tx) => {
    await tx.update(schema.syncRun).set({
      /**
       * The cursor is written back UNCHANGED when the read did not happen.
       * Advancing it on a pass that read nothing would skip every change in
       * the window the pass could not afford to look at, permanently and
       * without any error anywhere.
       */
      cursor: state.cursor,
      recordsRead: state.reads,
      recordsWritten: state.writes,
      finishedAt: new Date(),
      error: state.error,
      blockedReason: state.blockedReason,
      updatedAt: new Date(),
    }).where(eq(schema.syncRun.id, runId));
  });

  return {
    runId,
    provider: deps.provider.name,
    pushed: state.pushed,
    adopted: state.adopted,
    skipped: state.skipped,
    failed: state.failed,
    reads: state.reads,
    writes: state.writes,
    cursor: state.cursor,
    changesSeen: state.changesSeen,
    more: state.more,
    blockedReason: state.blockedReason,
    error: state.error,
  };
}

/* --------------------------------------------------------- outbound push */

/** Counters the pass carries, mutated as it goes. */
interface PassState {
  pushed: number; adopted: number; skipped: number; failed: number;
  reads: number; writes: number; changesSeen: number;
  more: boolean;
  blockedReason: string | null;
  error: string | null;
  cursor: string | null;
}

type MeteredRead = <T>(
  run: () => Promise<ReadResult<T>>,
) => Promise<{ read: true; value: T } | { read: false }>;

/**
 * Push one document, under the claim.
 *
 * Returns the external id when the document is in the accounting system by
 * the time this returns, and null when it is not, for any reason. The caller
 * uses that to decide whether a dependent document, a payment against an
 * invoice, can go in this pass.
 */
async function pushOne(
  ctx: ServiceContext,
  connectionId: string,
  state: PassState,
  meteredRead: MeteredRead,
  item: {
    kind: AccountingEntityKind;
    entityId: string;
    idempotencyKey: string;
    send: () => Promise<PushResultLike>;
    find: (key: string) => Promise<ReadResult<ExternalRef | null>>;
  },
): Promise<string | null> {
  const claimed = await guardedWrite(ctx, "accounting:sync", (tx) =>
    claim(tx, ctx.actor.organizationId, connectionId, item.kind, item.entityId, item.idempotencyKey));

  if (claimed.kind === "linked") {
    /**
     * THE ORDINARY CASE ON EVERY PASS AFTER THE FIRST, and it costs one
     * local row read and nothing at all from the metered API. A sync that
     * asked the provider here instead would spend one read per document per
     * pass, which is the wall described at the top of this file.
     */
    state.skipped += 1;
    return claimed.externalId;
  }
  if (claimed.kind === "busy" || claimed.kind === "exhausted") {
    state.skipped += 1;
    return null;
  }

  if (claimed.kind === "recover") {
    const found = await meteredRead(() => item.find(claimed.idempotencyKey));
    if (found.read && found.value) {
      const linked = await guardedWrite(ctx, "accounting:sync", (tx) =>
        link(tx, claimed.linkId, connectionId, item.kind, found.value!));
      if (!linked.ok) { state.failed += 1; return null; }
      state.adopted += 1;
      return found.value.externalId;
    }
    if (!found.read) {
      /**
       * THE READ THAT WOULD HAVE TOLD US DID NOT HAPPEN, so we do not
       * create.
       *
       * This is the single most important branch in the file. A `pending`
       * row means a create may already be sitting in the customer's books.
       * Creating anyway, because the check was unaffordable, is exactly the
       * duplicate invoice the whole design exists to prevent. Waiting costs
       * a pass. Guessing costs a document that somebody has to find and
       * delete out of a filed quarter.
       */
      state.skipped += 1;
      return null;
    }
    // Read succeeded and found nothing: the earlier attempt never landed.
  }

  const result = await item.send();
  state.writes += 1;

  if (result.ok) {
    const linked = await guardedWrite(ctx, "accounting:sync", (tx) =>
      link(tx, claimed.linkId, connectionId, item.kind, result));
    if (!linked.ok) { state.failed += 1; return null; }
    state.pushed += 1;
    return result.externalId;
  }

  if (result.duplicate) {
    /**
     * The provider says it already has one. That means our link table and
     * their books disagree, which happens after a restore, after a manual
     * entry, or after the crash window above. Asking for the id is worth a
     * metered read, because the alternative is a document we can never
     * reference from a payment.
     */
    const found = await meteredRead(() => item.find(item.idempotencyKey));
    if (found.read && found.value) {
      const linked = await guardedWrite(ctx, "accounting:sync", (tx) =>
        link(tx, claimed.linkId, connectionId, item.kind, found.value!));
      if (linked.ok) { state.adopted += 1; return found.value.externalId; }
    }
  }

  await guardedWrite(ctx, "accounting:sync", (tx) =>
    markFailed(tx, claimed.linkId, `${result.code}: ${result.message}`));
  state.failed += 1;
  return null;
}

/** The push arms of `PushResult`, named so `pushOne` can stay generic. */
type PushResultLike =
  | { ok: true; externalId: string; version: string | null; adopted: boolean }
  | { ok: false; code: string; message: string; retryable: boolean; duplicate: boolean };

/**
 * WHERE AN INVOICE'S MONEY LANDS, taken from the ledger rather than guessed.
 *
 * The posting is the authority. `schema/billing.ts` rule 4 says every
 * financial report reads from the ledger and never from `invoice.total`, and
 * an export to somebody's books is the most consequential report there is.
 * Reading `invoice.total` here would let a drifted cache decide what a
 * company reports to a tax authority.
 *
 * A posting that credits more than one revenue account is REFUSED rather
 * than collapsed onto whichever account came first. The invoice lines cannot
 * be attributed between them from here, and an invoice split across two
 * revenue accounts arriving entirely in one of them is a misstatement that
 * balances, which is the kind nobody finds.
 */
async function invoiceAccounts(
  tx: Database, organizationId: string, connectionId: string, invoiceId: string,
): Promise<DocumentAccounts> {
  return postingAccounts(tx, organizationId, connectionId, {
    sourceType: "invoice", sourceId: invoiceId, direction: "credit", noun: "invoice",
  });
}

type DocumentAccounts =
  | { ok: true; revenue: { externalId: string; kind: string }; tax: { externalId: string; kind: string } | null }
  | { ok: false; message: string };

/**
 * The same question for any document whose posting moves revenue and tax.
 *
 * An invoice CREDITS revenue, a credit note DEBITS it back, and a voided
 * credit note credits it again; the side is the only difference, so one
 * function answers all three from the ledger and none of them can come to
 * disagree about which account a line belongs in.
 */
async function postingAccounts(
  tx: Database, organizationId: string, connectionId: string,
  source: { sourceType: string; sourceId: string; direction: "debit" | "credit"; noun: string },
): Promise<DocumentAccounts> {
  const entries = await tx.select({
    accountCode: schema.ledgerEntry.accountCode,
    amount: schema.ledgerEntry.amount,
  })
    .from(schema.ledgerEntry)
    .where(and(
      eq(schema.ledgerEntry.organizationId, organizationId),
      eq(schema.ledgerEntry.sourceType, source.sourceType),
      eq(schema.ledgerEntry.sourceId, source.sourceId),
      eq(schema.ledgerEntry.direction, source.direction),
    ));

  if (entries.length === 0) {
    return {
      ok: false,
      message: `This ${source.noun} has no ledger posting, so there is nothing that says where its revenue belongs.`,
    };
  }

  const verb = source.direction === "credit" ? "credits" : "debits";
  const revenueCodes = [...new Set(
    entries.filter((e) => e.accountCode !== ledger.ACCOUNTS.TAX_PAYABLE && Number(e.amount) !== 0)
      .map((e) => e.accountCode),
  )];
  if (revenueCodes.length === 0) {
    return { ok: false, message: `This ${source.noun}'s posting ${verb} no revenue account.` };
  }
  if (revenueCodes.length > 1) {
    return {
      ok: false,
      message:
        `This ${source.noun}'s posting ${verb} ${revenueCodes.length} revenue accounts `
        + `(${revenueCodes.join(", ")}) and the lines cannot be attributed between them.`,
    };
  }

  const hasTax = entries.some((e) => e.accountCode === ledger.ACCOUNTS.TAX_PAYABLE && Number(e.amount) !== 0);
  const wanted = hasTax ? [revenueCodes[0]!, ledger.ACCOUNTS.TAX_PAYABLE] : [revenueCodes[0]!];
  const mapped = await mappingsFor(tx, connectionId, wanted);
  if (!mapped.ok) return mapped;

  return {
    ok: true,
    revenue: mapped.value[revenueCodes[0]!]!,
    tax: hasTax ? mapped.value[ledger.ACCOUNTS.TAX_PAYABLE]! : null,
  };
}

/**
 * Account codes to provider ids, or a refusal naming the missing code.
 *
 * NOTHING IS DEFAULTED. A code with no mapping stops the document and says
 * which code it was, because the alternative, quietly posting to whichever
 * income account exists, produces books that balance and are wrong, and the
 * person who finds out is an accountant reconciling a year later.
 */
async function mappingsFor(
  tx: Database, connectionId: string, codes: string[],
): Promise<
  | { ok: true; value: Record<string, { externalId: string; kind: string }> }
  | { ok: false; message: string }
> {
  const rows = await tx.select({
    accountCode: schema.accountMapping.accountCode,
    externalId: schema.accountMapping.externalId,
    externalKind: schema.accountMapping.externalKind,
  })
    .from(schema.accountMapping)
    .where(and(
      eq(schema.accountMapping.connectionId, connectionId),
      inArray(schema.accountMapping.accountCode, codes),
    ));

  const found: Record<string, { externalId: string; kind: string }> = {};
  for (const row of rows) found[row.accountCode] = { externalId: row.externalId, kind: row.externalKind };

  const missing = codes.filter((code) => !found[code]);
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `Account ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not mapped to `
        + "anything in the accounting system. Map it on the accounting settings screen; "
        + "this document is not sent until you do.",
    };
  }
  return { ok: true, value: found };
}

/**
 * Everything this organization owes the books, in dependency order.
 *
 * Customers before invoices because an invoice references a customer.
 * Invoices before payments because a payment references the invoices it
 * cleared. Credits after because a credit memo reverses an invoice that has to
 * be there first, and credit notes last because their applications point at
 * both a credit note and an invoice. Each step is skipped for a document whose dependency did
 * not make it, rather than pushed with a dangling reference.
 */
async function pushOutbound(
  ctx: ServiceContext,
  deps: SyncDeps,
  connection: AccountingConnection,
  state: PassState,
  closedOn: string | null,
  limit: number,
  meteredRead: MeteredRead,
): Promise<void> {
  const organizationId = ctx.actor.organizationId;

  const work = await guardedRead(ctx, "accounting:sync", async (tx) => ({
    invoices: await invoicesToPush(tx, connection.id, closedOn, limit),
    payments: await paymentsToPush(tx, connection.id, closedOn, limit),
    credits: await creditsToPush(tx, connection.id, closedOn, limit),
  }));

  /** Our customer id to its id over there, for the length of this pass. */
  const customers = new Map<string, string>();

  const customerRef = async (customerId: string): Promise<string | null> => {
    const known = customers.get(customerId);
    if (known) return known;

    const row = await guardedRead(ctx, "accounting:sync", async (tx) => {
      const [found] = await tx.select({
        id: schema.customer.id,
        name: schema.customer.name,
        email: schema.customer.email,
        phone: schema.customer.phone,
      }).from(schema.customer).where(eq(schema.customer.id, customerId)).limit(1);
      return found;
    });
    if (!row) return null;

    const key = customerKey(row.name);
    const externalId = await pushOne(ctx, connection.id, state, meteredRead, {
      kind: "customer",
      entityId: row.id,
      idempotencyKey: key,
      send: () => deps.provider.pushCustomer({
        idempotencyKey: key, name: row.name, email: row.email, phone: row.phone,
      }),
      find: (k) => deps.provider.findPushed("customer", k),
    });
    if (externalId) customers.set(customerId, externalId);
    return externalId;
  };

  /** Our invoice id to its id over there, so a payment can reference it. */
  const invoiceRefs = new Map<string, string>();

  for (const invoice of work.invoices) {
    const customerExternalId = await customerRef(invoice.customerId);
    if (!customerExternalId) { state.skipped += 1; continue; }

    const resolved = await guardedRead(ctx, "accounting:sync", async (tx) => ({
      accounts: await invoiceAccounts(tx, organizationId, connection.id, invoice.id),
      lines: await tx.select({
        name: schema.invoiceLine.name,
        description: schema.invoiceLine.description,
        quantity: schema.invoiceLine.quantity,
        unitPrice: schema.invoiceLine.unitPrice,
        lineTotal: schema.invoiceLine.lineTotal,
      })
        .from(schema.invoiceLine)
        .where(eq(schema.invoiceLine.invoiceId, invoice.id))
        .orderBy(asc(schema.invoiceLine.sortOrder)),
    }));

    if (!resolved.accounts.ok) {
      /**
       * Recorded against the document rather than dropped. An invoice that
       * will never reach the books without somebody mapping an account is
       * exactly the thing a person needs told, and a pass that silently
       * skipped it would look identical to a pass with nothing to do.
       */
      await recordRefusal(ctx, connection.id, "invoice", invoice.id, invoiceKey(invoice.number), resolved.accounts.message);
      state.failed += 1;
      continue;
    }
    const accounts = resolved.accounts;

    const lines: ExternalInvoiceLine[] = resolved.lines.map((line) => ({
      description: line.description ?? line.name,
      quantity: line.quantity,
      unitPrice: { amount: line.unitPrice, currency: invoice.currency },
      amount: { amount: line.lineTotal, currency: invoice.currency },
      accountExternalId: accounts.revenue.externalId,
      accountExternalKind: accounts.revenue.kind,
    }));

    const key = invoiceKey(invoice.number);
    const externalId = await pushOne(ctx, connection.id, state, meteredRead, {
      kind: "invoice",
      entityId: invoice.id,
      idempotencyKey: key,
      send: () => deps.provider.pushInvoice({
        idempotencyKey: key,
        customerExternalId,
        documentNumber: String(invoice.number),
        issuedOn: invoice.issuedOn ?? new Date().toISOString().slice(0, 10),
        dueOn: invoice.dueOn,
        currency: invoice.currency,
        lines,
        tax: accounts.tax && Number(invoice.taxTotal) !== 0
          ? {
            amount: { amount: invoice.taxTotal, currency: invoice.currency },
            accountExternalId: accounts.tax.externalId,
          }
          : null,
        memo: invoice.memo,
      }),
      find: (k) => deps.provider.findPushed("invoice", k),
    });
    if (externalId) invoiceRefs.set(invoice.id, externalId);
  }

  for (const payment of work.payments) {
    const customerExternalId = await customerRef(payment.customerId);
    if (!customerExternalId) { state.skipped += 1; continue; }

    const resolved = await guardedRead(ctx, "accounting:sync", async (tx) => ({
      cash: await mappingsFor(tx, connection.id, [ledger.ACCOUNTS.CASH]),
      allocations: await tx.select({
        invoiceId: schema.paymentAllocation.invoiceId,
        amount: schema.paymentAllocation.amount,
        externalId: schema.accountingEntityLink.externalId,
      })
        .from(schema.paymentAllocation)
        .leftJoin(schema.accountingEntityLink, and(
          eq(schema.accountingEntityLink.connectionId, connection.id),
          eq(schema.accountingEntityLink.kind, "invoice"),
          eq(schema.accountingEntityLink.entityId, schema.paymentAllocation.invoiceId),
          eq(schema.accountingEntityLink.state, "linked"),
        ))
        .where(eq(schema.paymentAllocation.paymentId, payment.id)),
    }));

    if (!resolved.cash.ok) {
      await recordRefusal(ctx, connection.id, "payment", payment.id, paymentKey(payment.id), resolved.cash.message);
      state.failed += 1;
      continue;
    }
    const cashAccount = resolved.cash.value[ledger.ACCOUNTS.CASH]!;

    /**
     * NETTED PER INVOICE. A refund recorded against a payment reopens what it
     * paid by adding a NEGATIVE allocation rather than editing the old one,
     * so the rows are a history and the books want the net: what this
     * payment still pays on each invoice, and nothing for an invoice it no
     * longer pays at all.
     */
    const net = new Map<string, { externalId: string | null; amount: m.Money }>();
    for (const row of resolved.allocations) {
      const prior = net.get(row.invoiceId);
      net.set(row.invoiceId, {
        externalId: prior?.externalId ?? row.externalId,
        amount: m.add(prior?.amount ?? m.money("0", payment.currency), m.money(row.amount, payment.currency)),
      });
    }
    const allocations = [...net.entries()]
      .filter(([, v]) => m.isPositive(v.amount))
      .map(([invoiceId, v]) => ({
        invoiceId,
        invoiceExternalId: v.externalId ?? invoiceRefs.get(invoiceId) ?? null,
        amount: { amount: m.toString(v.amount), currency: payment.currency },
      }));

    /**
     * A PAYMENT WAITS FOR ITS INVOICES rather than going over unapplied.
     *
     * An unapplied payment in QuickBooks looks exactly like an overpayment:
     * the receivable it was meant to clear stays open, the customer shows a
     * credit they do not have, and the AR aging report is wrong in both
     * directions at once. Waiting one pass costs nothing.
     */
    if (allocations.length === 0 || allocations.some((a) => !a.invoiceExternalId)) {
      state.skipped += 1;
      continue;
    }

    const key = paymentKey(payment.id);
    await pushOne(ctx, connection.id, state, meteredRead, {
      kind: "payment",
      entityId: payment.id,
      idempotencyKey: key,
      send: async () => {
        /**
         * WHAT THE COMPANY KEPT, decided at the moment of sending and written
         * down in the same breath.
         *
         * A refund made before this payment reached the books is netted out
         * of it, so the books are not handed a receipt larger than the money
         * that stayed. Every refund netted is recorded as a `refund` link
         * with no document of its own, under a lock on the payment row so no
         * refund can land between deciding the amount and recording what it
         * covered. A refund after this moment is not in the amount and has
         * no link, so it goes to the books as a refund once this payment is
         * there; one before it never goes twice.
         */
        const netted = await guardedWrite(ctx, "accounting:sync", (tx) =>
          nettedPayment(tx, organizationId, connection.id, payment.id, null));
        return deps.provider.pushPayment({
          idempotencyKey: key,
          customerExternalId,
          receivedOn: payment.receivedAt.toISOString().slice(0, 10),
          amount: { amount: m.toString(netted.kept), currency: payment.currency },
          depositAccountExternalId: cashAccount.externalId,
          allocations: netted.allocations.map(({ invoiceId, amount }) => ({
            invoiceExternalId: allocations.find((a) => a.invoiceId === invoiceId)?.invoiceExternalId
              ?? invoiceRefs.get(invoiceId)!,
            amount: { amount: m.toString(amount), currency: payment.currency },
          })),
        });
      },
      find: (k) => deps.provider.findPushed("payment", k),
    });
  }

  await pushRefunds(ctx, deps, connection, state, closedOn, limit, meteredRead, customerRef);

  for (const credit of work.credits) {
    const customerExternalId = await customerRef(credit.customerId);
    if (!customerExternalId) { state.skipped += 1; continue; }

    const resolved = await guardedRead(ctx, "accounting:sync", (tx) =>
      mappingsFor(tx, connection.id, [ledger.ACCOUNTS.WRITE_OFF]));
    if (!resolved.ok) {
      await recordRefusal(ctx, connection.id, "credit_memo", credit.id, creditKey(credit.number), resolved.message);
      state.failed += 1;
      continue;
    }

    const key = creditKey(credit.number);
    await pushOne(ctx, connection.id, state, meteredRead, {
      kind: "credit_memo",
      entityId: credit.id,
      idempotencyKey: key,
      send: () => deps.provider.pushCredit({
        idempotencyKey: key,
        customerExternalId,
        issuedOn: (credit.voidedAt ?? new Date()).toISOString().slice(0, 10),
        /**
         * What was written off or voided, which is what was still owed: a
         * partly paid invoice written off loses its balance, not its total,
         * and crediting the total would leave the customer a credit in the
         * books for money they had already paid.
         */
        /**
         * And less what credit notes already settled on it. Those reach the
         * books as applications of their own, and counting them here as well
         * would take the same money off the receivable twice.
         */
        amount: {
          amount: m.toString(m.subtract(
            m.subtract(m.money(credit.total, credit.currency), m.money(credit.amountPaid, credit.currency)),
            m.money(credit.amountCredited, credit.currency),
          )),
          currency: credit.currency,
        },
        accountExternalId: resolved.value[ledger.ACCOUNTS.WRITE_OFF]!.externalId,
        reason: credit.status === "void" ? "Invoice voided" : "Invoice written off",
      }),
      find: (k) => deps.provider.findPushed("credit_memo", k),
    });
  }

  await pushCreditNotes(ctx, deps, connection, state, closedOn, limit, meteredRead, customerRef);
}

/**
 * A payment's refunds as of now, recorded as netted into it, and what the
 * payment still holds.
 *
 * Locks the payment row first. A refund updates that row in the same
 * transaction that writes its ledger posting and its negative allocation,
 * so with the lock held every refund is either fully visible here or cannot
 * commit until this has.
 *
 * `through` limits the netting to refunds made by then. It is how a payment
 * pushed before refunds were synced is settled: whatever was refunded
 * before its push was netted into it by the code of the day, and nothing
 * after was sent anywhere.
 */
async function nettedPayment(
  tx: Database, organizationId: string, connectionId: string, paymentId: string, through: Date | null,
): Promise<{ kept: m.Money; allocations: { invoiceId: string; amount: m.Money }[] }> {
  const [payment] = await tx.select({
    amount: schema.payment.amount, currency: schema.payment.currency,
  }).from(schema.payment).where(eq(schema.payment.id, paymentId)).for("update");
  if (!payment) throw new NotFoundError("Payment");

  const refunds = await tx.select({
    transactionId: schema.ledgerEntry.transactionId,
    amount: schema.ledgerEntry.amount,
  })
    .from(schema.ledgerEntry)
    .where(and(
      eq(schema.ledgerEntry.sourceType, "refund"),
      eq(schema.ledgerEntry.sourceId, paymentId),
      eq(schema.ledgerEntry.accountCode, ledger.ACCOUNTS.CASH),
      eq(schema.ledgerEntry.direction, "credit"),
      through ? sql`${schema.ledgerEntry.createdAt} <= ${through.toISOString()}::timestamptz` : undefined,
    ));

  if (refunds.length > 0) {
    await tx.insert(schema.accountingEntityLink).values(refunds.map((r) => ({
      organizationId,
      connectionId,
      kind: "refund" as const,
      entityId: r.transactionId,
      idempotencyKey: refundKey(r.transactionId),
      /**
       * Linked with no document: it is in the books inside the payment's
       * amount, and that is the whole of its presence there.
       */
      state: "linked" as const,
      externalId: null,
      lastError: null,
    }))).onConflictDoNothing();
  }
  await tx.update(schema.accountingEntityLink)
    .set({ refundsNettedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(schema.accountingEntityLink.connectionId, connectionId),
      eq(schema.accountingEntityLink.kind, "payment"),
      eq(schema.accountingEntityLink.entityId, paymentId),
    ));

  /** Netted against exactly the refunds recorded as netted, whatever pass recorded them. */
  const absorbed = await tx.select({ amount: schema.ledgerEntry.amount })
    .from(schema.ledgerEntry)
    .innerJoin(schema.accountingEntityLink, and(
      eq(schema.accountingEntityLink.connectionId, connectionId),
      eq(schema.accountingEntityLink.kind, "refund"),
      eq(schema.accountingEntityLink.entityId, schema.ledgerEntry.transactionId),
      isNull(schema.accountingEntityLink.externalId),
    ))
    .where(and(
      eq(schema.ledgerEntry.sourceType, "refund"),
      eq(schema.ledgerEntry.sourceId, paymentId),
      eq(schema.ledgerEntry.accountCode, ledger.ACCOUNTS.CASH),
      eq(schema.ledgerEntry.direction, "credit"),
    ));
  const zero = m.money("0", payment.currency);
  const refunded = absorbed.reduce((sum, r) => m.add(sum, m.money(r.amount, payment.currency)), zero);

  const rows = await tx.select({
    invoiceId: schema.paymentAllocation.invoiceId, amount: schema.paymentAllocation.amount,
  }).from(schema.paymentAllocation).where(eq(schema.paymentAllocation.paymentId, paymentId));
  const net = new Map<string, m.Money>();
  for (const row of rows) {
    net.set(row.invoiceId, m.add(net.get(row.invoiceId) ?? zero, m.money(row.amount, payment.currency)));
  }

  return {
    kept: m.subtract(m.money(payment.amount, payment.currency), refunded),
    allocations: [...net.entries()]
      .filter(([, amount]) => m.isPositive(amount))
      .map(([invoiceId, amount]) => ({ invoiceId, amount })),
  };
}

/**
 * Refunds made after their payment reached the books.
 *
 * Each is its own document, dated when the money went back, because the
 * payment over there is a filed fact about the day it arrived and editing
 * it would move cash between periods. A refund that was netted into its
 * payment already has a link and is not in this set; a refund of a payment
 * that has not reached the books yet waits, and is netted into it when it
 * goes.
 */
async function pushRefunds(
  ctx: ServiceContext,
  deps: SyncDeps,
  connection: AccountingConnection,
  state: PassState,
  closedOn: string | null,
  limit: number,
  meteredRead: MeteredRead,
  customerRef: (customerId: string) => Promise<string | null>,
): Promise<void> {
  const organizationId = ctx.actor.organizationId;

  /**
   * A payment pushed before refunds were synced has no record of which of
   * its refunds it netted. Settled once, from the time it was pushed, so
   * none of them is sent as a refund on top of a payment already net of it.
   */
  const unsettled = await guardedRead(ctx, "accounting:sync", (tx) =>
    tx.select({
      entityId: schema.accountingEntityLink.entityId,
      pushedAt: schema.accountingEntityLink.pushedAt,
      updatedAt: schema.accountingEntityLink.updatedAt,
    }).from(schema.accountingEntityLink).where(and(
      eq(schema.accountingEntityLink.connectionId, connection.id),
      eq(schema.accountingEntityLink.kind, "payment"),
      eq(schema.accountingEntityLink.state, "linked"),
      isNull(schema.accountingEntityLink.refundsNettedAt),
    )).limit(limit));
  for (const row of unsettled) {
    await guardedWrite(ctx, "accounting:sync", (tx) =>
      nettedPayment(tx, organizationId, connection.id, row.entityId, row.pushedAt ?? row.updatedAt));
  }

  const work = await guardedRead(ctx, "accounting:sync", async (tx) => ({
    refunds: await refundsToPush(tx, connection.id, closedOn, limit),
    accounts: await tx.select({
      accountCode: schema.accountMapping.accountCode,
      externalId: schema.accountMapping.externalId,
    }).from(schema.accountMapping).where(and(
      eq(schema.accountMapping.connectionId, connection.id),
      inArray(schema.accountMapping.accountCode, [
        ledger.ACCOUNTS.CASH, ledger.ACCOUNTS.AR, ledger.ACCOUNTS.CUSTOMER_DEPOSITS,
      ]),
    )),
  }));
  const mapped = (code: string) => work.accounts.find((a) => a.accountCode === code)?.externalId ?? null;

  for (const refund of work.refunds) {
    const key = refundKey(refund.transactionId);
    const currency = refund.currency;
    const zero = m.money("0", currency);
    const held = m.money(refund.held ?? "0", currency);
    const applied = m.money(refund.applied ?? "0", currency);
    /** What of it the books ever saw. See `heldMoneyReachesBooks`. */
    const toSend = deps.provider.heldMoneyReachesBooks ? m.add(applied, held) : applied;

    if (!m.isPositive(toSend)) {
      /**
       * Nothing over there to give back: the money came in and went out
       * without the books ever holding it. Recorded so it is not offered
       * again, with no document.
       */
      await guardedWrite(ctx, "accounting:sync", (tx) =>
        tx.insert(schema.accountingEntityLink).values({
          organizationId, connectionId: connection.id, kind: "refund",
          entityId: refund.transactionId, idempotencyKey: key, state: "linked",
        }).onConflictDoNothing());
      state.skipped += 1;
      continue;
    }

    const cash = mapped(ledger.ACCOUNTS.CASH);
    if (!cash) {
      await recordRefusal(ctx, connection.id, "refund", refund.transactionId, key,
        `Account ${ledger.ACCOUNTS.CASH} is not mapped to anything in the accounting system. Map it on `
        + "the accounting settings screen; this refund is not sent until you do.");
      state.failed += 1;
      continue;
    }

    const customerExternalId = await customerRef(refund.customerId);
    if (!customerExternalId) { state.skipped += 1; continue; }

    const money = (value: m.Money) => ({ amount: m.toString(value), currency });
    await pushOne(ctx, connection.id, state, meteredRead, {
      kind: "refund",
      entityId: refund.transactionId,
      idempotencyKey: key,
      send: () => deps.provider.pushRefund({
        idempotencyKey: key,
        customerExternalId,
        paymentExternalId: refund.paymentExternalId,
        refundedOn: refund.occurredAt.toISOString().slice(0, 10),
        amount: money(toSend),
        appliedAmount: money(applied),
        heldAmount: money(deps.provider.heldMoneyReachesBooks ? held : zero),
        bankAccountExternalId: cash,
        receivableAccountExternalId: mapped(ledger.ACCOUNTS.AR),
        clearingAccountExternalId: mapped(ledger.ACCOUNTS.CUSTOMER_DEPOSITS),
        memo: `Refund of payment ${refund.paymentExternalId}`,
      }),
      find: (k) => deps.provider.findPushed("refund", k),
    });
  }
}

/**
 * Refund postings whose payment is in the books and which have not gone
 * themselves. One row per refund: the ledger transaction, with its cash,
 * receivable and held-credit legs summed out of its entries.
 */
async function refundsToPush(
  tx: Database, connectionId: string, closedOn: string | null, limit: number,
) {
  const paymentLink = alias(schema.accountingEntityLink, "refunded_payment_link");
  const refundLink = alias(schema.accountingEntityLink, "refund_link");
  const leg = (code: string, direction: "debit" | "credit") =>
    sql<string | null>`sum(case when ${schema.ledgerEntry.accountCode} = ${code}
      and ${schema.ledgerEntry.direction} = ${direction} then ${schema.ledgerEntry.amount} end)::text`;
  return tx.select({
    transactionId: schema.ledgerEntry.transactionId,
    paymentId: schema.ledgerEntry.sourceId,
    occurredAt: sql<Date>`min(${schema.ledgerEntry.occurredAt})`.mapWith((v) => new Date(v as string)),
    customerId: schema.payment.customerId,
    currency: schema.payment.currency,
    paymentExternalId: sql<string>`min(${paymentLink.externalId})`,
    applied: leg(ledger.ACCOUNTS.AR, "debit"),
    held: leg(ledger.ACCOUNTS.CUSTOMER_DEPOSITS, "debit"),
  })
    .from(schema.ledgerEntry)
    .innerJoin(schema.payment, eq(schema.payment.id, schema.ledgerEntry.sourceId))
    .innerJoin(paymentLink, and(
      eq(paymentLink.connectionId, connectionId),
      eq(paymentLink.kind, "payment"),
      eq(paymentLink.entityId, schema.payment.id),
      eq(paymentLink.state, "linked"),
      isNotNull(paymentLink.externalId),
      isNotNull(paymentLink.refundsNettedAt),
    ))
    .leftJoin(refundLink, and(
      eq(refundLink.connectionId, connectionId),
      eq(refundLink.kind, "refund"),
      eq(refundLink.entityId, schema.ledgerEntry.transactionId),
    ))
    .where(and(
      eq(schema.ledgerEntry.sourceType, "refund"),
      offerable(refundLink.id, refundLink.state),
      closedOn ? sql`${schema.ledgerEntry.occurredAt}::date > ${closedOn}` : undefined,
    ))
    .groupBy(schema.ledgerEntry.transactionId, schema.ledgerEntry.sourceId,
      schema.payment.customerId, schema.payment.currency)
    .orderBy(sql`min(${schema.ledgerEntry.occurredAt})`)
    .limit(limit);
}

/* ------------------------------------------------------------ credit notes */

/**
 * CREDIT NOTES, AND WHAT THEY BECOME IN THE BOOKS.
 *
 * Four kinds of document, in dependency order, and each waits for the one
 * before it rather than going with a dangling reference:
 *
 *   ISSUED   a QuickBooks CreditMemo or a Xero ACCRECCREDIT credit note,
 *            with the credit note's own lines on the revenue account the
 *            ledger debited and its tax on the mapped tax account. It lands
 *            unapplied, as credit the customer holds, because that is what
 *            issuing one does here.
 *
 *   APPLIED  one per `credit_note_application` row, dated the day it was
 *            applied: a zero payment linking the invoice and the credit memo
 *            in QuickBooks, an Allocation in Xero. Waits for both the credit
 *            note and the invoice to be over there.
 *
 *   VOIDED   an invoice for the same lines, dated the day of the void, and
 *            then that invoice settled against the credit note exactly as an
 *            application is. NEITHER BOOK'S OWN VOID IS USED, and the reason
 *            is the one `pushCredit` already lives by: a document that may sit
 *            in a filed period is corrected by a new document dated now,
 *            never by changing the old one. QuickBooks' API offers no void
 *            for a credit memo at all, only a delete, and Xero's void takes
 *            the credit out of the period it was issued in, which this
 *            company may have closed. Our ledger posts the void on the day it
 *            happened, and the reversing invoice is that posting as a
 *            document: revenue and tax back on the day of the void, the
 *            credit used up, nothing left open on either side.
 *
 * A credit note voided before it ever reached the books never goes, exactly
 * as an invoice voided before its push never goes: there is nothing over
 * there to take back. The one exception is a push that may already be in
 * the books (a `pending` claim), which is still offered so the crash window
 * is closed and the void then follows it.
 *
 * Every set is read AFTER the one before it has been pushed, so a credit
 * note issued and applied since the last pass reaches the books whole in one
 * pass rather than an application at a time.
 */
async function pushCreditNotes(
  ctx: ServiceContext,
  deps: SyncDeps,
  connection: AccountingConnection,
  state: PassState,
  closedOn: string | null,
  limit: number,
  meteredRead: MeteredRead,
  customerRef: (customerId: string) => Promise<string | null>,
): Promise<void> {
  const organizationId = ctx.actor.organizationId;
  const money = (amount: string, currency: string) => ({ amount, currency });

  /** Lines and accounts for a document built from a credit note's lines. */
  const documentFor = async (
    noteId: string, currency: string, posting: { sourceType: string; direction: "debit" | "credit"; noun: string },
  ) => guardedRead(ctx, "accounting:sync", async (tx) => {
    const accounts = await postingAccounts(tx, organizationId, connection.id, {
      ...posting, sourceId: noteId,
    });
    if (!accounts.ok) return accounts;
    const rows = await tx.select({
      name: schema.creditNoteLine.name,
      description: schema.creditNoteLine.description,
      quantity: schema.creditNoteLine.quantity,
      unitPrice: schema.creditNoteLine.unitPrice,
      lineTotal: schema.creditNoteLine.lineTotal,
    })
      .from(schema.creditNoteLine)
      .where(eq(schema.creditNoteLine.creditNoteId, noteId))
      .orderBy(asc(schema.creditNoteLine.sortOrder));
    /** Mapped the way an invoice's lines are, by the same rule. */
    const lines: ExternalInvoiceLine[] = rows.map((line) => ({
      description: line.description ?? line.name,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice, currency),
      amount: money(line.lineTotal, currency),
      accountExternalId: accounts.revenue.externalId,
      accountExternalKind: accounts.revenue.kind,
    }));
    return { ok: true as const, lines, tax: accounts.tax };
  });

  /** Push one application, or the settlement of one void, which is the same document. */
  const pushApplication = async (entityId: string, application: ExternalCreditApplication) =>
    pushOne(ctx, connection.id, state, meteredRead, {
      kind: "credit_note_application",
      entityId,
      idempotencyKey: application.idempotencyKey,
      send: () => deps.provider.pushCreditApplication(application),
      find: async () => {
        const taken = await guardedRead(ctx, "accounting:sync", async (tx) => {
          const rows = await tx.select({ externalId: schema.accountingEntityLink.externalId })
            .from(schema.accountingEntityLink)
            .where(and(
              eq(schema.accountingEntityLink.connectionId, connection.id),
              eq(schema.accountingEntityLink.kind, "credit_note_application"),
              isNotNull(schema.accountingEntityLink.externalId),
            ));
          return rows.map((row) => row.externalId!);
        });
        return deps.provider.findCreditApplication(application, taken);
      },
    });

  /* Issued. */
  const notes = await guardedRead(ctx, "accounting:sync", (tx) =>
    creditNotesToPush(tx, connection.id, closedOn, limit));
  for (const note of notes) {
    const key = creditNoteKey(note.number);
    const customerExternalId = await customerRef(note.customerId);
    if (!customerExternalId) { state.skipped += 1; continue; }

    const document = await documentFor(note.id, note.currency, {
      sourceType: "credit_note", direction: "debit", noun: "credit note",
    });
    if (!document.ok) {
      await recordRefusal(ctx, connection.id, "credit_note", note.id, key, document.message);
      state.failed += 1;
      continue;
    }

    await pushOne(ctx, connection.id, state, meteredRead, {
      kind: "credit_note",
      entityId: note.id,
      idempotencyKey: key,
      send: () => deps.provider.pushCreditNote({
        idempotencyKey: key,
        customerExternalId,
        documentNumber: key,
        issuedOn: note.issuedOn!,
        currency: note.currency,
        lines: document.lines,
        tax: document.tax && Number(note.taxTotal) !== 0
          ? { amount: money(note.taxTotal, note.currency), accountExternalId: document.tax.externalId }
          : null,
        memo: note.note,
      }),
      find: (k) => deps.provider.findPushed("credit_note", k),
    });
  }

  /* Applied. */
  const applications = await guardedRead(ctx, "accounting:sync", (tx) =>
    applicationsToPush(tx, connection.id, closedOn, limit));
  for (const application of applications) {
    const customerExternalId = await customerRef(application.customerId);
    if (!customerExternalId) { state.skipped += 1; continue; }
    await pushApplication(application.id, {
      idempotencyKey: creditApplicationKey(application.id),
      customerExternalId,
      creditNoteExternalId: application.creditNoteExternalId!,
      invoiceExternalId: application.invoiceExternalId!,
      appliedOn: application.appliedOn,
      amount: money(application.amount, application.currency),
    });
  }

  /* Voided: the reversing invoice. */
  const voids = await guardedRead(ctx, "accounting:sync", (tx) =>
    voidsToPush(tx, connection.id, closedOn, limit));
  for (const note of voids) {
    const key = creditNoteVoidKey(note.number);
    const customerExternalId = await customerRef(note.customerId);
    if (!customerExternalId) { state.skipped += 1; continue; }

    const document = await documentFor(note.id, note.currency, {
      sourceType: "credit_note_void", direction: "credit", noun: "voided credit note",
    });
    if (!document.ok) {
      await recordRefusal(ctx, connection.id, "credit_note_void", note.id, key, document.message);
      state.failed += 1;
      continue;
    }

    const voidedOn = (note.voidedAt ?? new Date()).toISOString().slice(0, 10);
    await pushOne(ctx, connection.id, state, meteredRead, {
      kind: "credit_note_void",
      entityId: note.id,
      idempotencyKey: key,
      send: () => deps.provider.pushInvoice({
        idempotencyKey: key,
        customerExternalId,
        documentNumber: key,
        issuedOn: voidedOn,
        dueOn: voidedOn,
        currency: note.currency,
        lines: document.lines,
        tax: document.tax && Number(note.taxTotal) !== 0
          ? { amount: money(note.taxTotal, note.currency), accountExternalId: document.tax.externalId }
          : null,
        memo: `Reverses credit note ${note.number}, which was voided.`,
      }),
      find: (k) => deps.provider.findPushed("credit_note_void", k),
    });
  }

  /* Voided: the reversing invoice settled against the credit note. */
  const settlements = await guardedRead(ctx, "accounting:sync", (tx) =>
    voidSettlementsToPush(tx, connection.id, closedOn, limit));
  for (const note of settlements) {
    const customerExternalId = await customerRef(note.customerId);
    if (!customerExternalId) { state.skipped += 1; continue; }
    await pushApplication(note.id, {
      idempotencyKey: creditApplicationKey(note.id),
      customerExternalId,
      creditNoteExternalId: note.creditNoteExternalId!,
      invoiceExternalId: note.reversalExternalId!,
      appliedOn: (note.voidedAt ?? new Date()).toISOString().slice(0, 10),
      /**
       * The whole credit note, because nothing of it was ever applied: the
       * void is refused here once any of it has been.
       */
      amount: money(note.total, note.currency),
    });
  }
}

/**
 * Issued credit notes that have not reached the books, dated after the
 * close by their own issue date.
 */
async function creditNotesToPush(
  tx: Database, connectionId: string, closedOn: string | null, limit: number,
) {
  const link = alias(schema.accountingEntityLink, "credit_note_link");
  return tx.select({
    id: schema.creditNote.id,
    number: schema.creditNote.number,
    customerId: schema.creditNote.customerId,
    issuedOn: schema.creditNote.issuedOn,
    currency: schema.creditNote.currency,
    taxTotal: schema.creditNote.taxTotal,
    note: schema.creditNote.note,
  })
    .from(schema.creditNote)
    .leftJoin(link, and(
      eq(link.connectionId, connectionId),
      eq(link.kind, "credit_note"),
      eq(link.entityId, schema.creditNote.id),
    ))
    .where(and(
      /**
       * A DRAFT IS NOT SENT, for the reason a draft invoice is not. A void
       * one is sent only when a push of it may already have landed.
       */
      or(
        inArray(schema.creditNote.status, ["open", "partially_applied", "applied"]),
        and(eq(schema.creditNote.status, "void"), eq(link.state, "pending")),
      ),
      isNotNull(schema.creditNote.issuedOn),
      offerable(link.id, link.state),
      afterClose(schema.creditNote.issuedOn, closedOn),
    ))
    .orderBy(asc(schema.creditNote.number))
    .limit(limit);
}

/**
 * Applications whose credit note AND invoice are both in the books, dated
 * after the close by the day they were applied. An application against an
 * invoice that never reached the books waits for it, as a payment does.
 */
async function applicationsToPush(
  tx: Database, connectionId: string, closedOn: string | null, limit: number,
) {
  const noteLink = alias(schema.accountingEntityLink, "applied_note_link");
  const invoiceLink = alias(schema.accountingEntityLink, "applied_invoice_link");
  const applicationLink = alias(schema.accountingEntityLink, "application_link");
  return tx.select({
    id: schema.creditNoteApplication.id,
    amount: schema.creditNoteApplication.amount,
    /**
     * The day it was applied, or the day the row was written for one an
     * older build saved without a date. Written by the service on every
     * application since the column existed, so this is a fallback, and it
     * is the same day in all but a migration.
     */
    appliedOn: sql<string>`coalesce(${schema.creditNoteApplication.appliedOn}, ${schema.creditNoteApplication.createdAt}::date)::text`,
    customerId: schema.creditNote.customerId,
    currency: schema.creditNote.currency,
    creditNoteExternalId: noteLink.externalId,
    invoiceExternalId: invoiceLink.externalId,
  })
    .from(schema.creditNoteApplication)
    .innerJoin(schema.creditNote, eq(schema.creditNote.id, schema.creditNoteApplication.creditNoteId))
    .innerJoin(noteLink, and(
      eq(noteLink.connectionId, connectionId),
      eq(noteLink.kind, "credit_note"),
      eq(noteLink.entityId, schema.creditNote.id),
      eq(noteLink.state, "linked"),
      isNotNull(noteLink.externalId),
    ))
    .innerJoin(invoiceLink, and(
      eq(invoiceLink.connectionId, connectionId),
      eq(invoiceLink.kind, "invoice"),
      eq(invoiceLink.entityId, schema.creditNoteApplication.invoiceId),
      eq(invoiceLink.state, "linked"),
      isNotNull(invoiceLink.externalId),
    ))
    .leftJoin(applicationLink, and(
      eq(applicationLink.connectionId, connectionId),
      eq(applicationLink.kind, "credit_note_application"),
      eq(applicationLink.entityId, schema.creditNoteApplication.id),
    ))
    .where(and(
      offerable(applicationLink.id, applicationLink.state),
      closedOn
        ? sql`coalesce(${schema.creditNoteApplication.appliedOn}, ${schema.creditNoteApplication.createdAt}::date) > ${closedOn}`
        : undefined,
    ))
    .orderBy(asc(schema.creditNoteApplication.createdAt))
    .limit(limit);
}

/**
 * Credit notes voided after they reached the books, dated after the close by
 * the day of the void, which is the period the reversal belongs in for the
 * reason `creditsToPush` gives for a write off.
 */
async function voidsToPush(
  tx: Database, connectionId: string, closedOn: string | null, limit: number,
) {
  const noteLink = alias(schema.accountingEntityLink, "voided_note_link");
  const voidLink = alias(schema.accountingEntityLink, "credit_note_void_link");
  return tx.select({
    id: schema.creditNote.id,
    number: schema.creditNote.number,
    customerId: schema.creditNote.customerId,
    currency: schema.creditNote.currency,
    taxTotal: schema.creditNote.taxTotal,
    voidedAt: schema.creditNote.voidedAt,
  })
    .from(schema.creditNote)
    .innerJoin(noteLink, and(
      eq(noteLink.connectionId, connectionId),
      eq(noteLink.kind, "credit_note"),
      eq(noteLink.entityId, schema.creditNote.id),
      eq(noteLink.state, "linked"),
      isNotNull(noteLink.externalId),
    ))
    .leftJoin(voidLink, and(
      eq(voidLink.connectionId, connectionId),
      eq(voidLink.kind, "credit_note_void"),
      eq(voidLink.entityId, schema.creditNote.id),
    ))
    .where(and(
      eq(schema.creditNote.status, "void"),
      offerable(voidLink.id, voidLink.state),
      closedOn ? sql`${schema.creditNote.voidedAt}::date > ${closedOn}` : undefined,
    ))
    .orderBy(asc(schema.creditNote.number))
    .limit(limit);
}

/** Voids whose reversing invoice is over there and not yet settled against the credit note. */
async function voidSettlementsToPush(
  tx: Database, connectionId: string, closedOn: string | null, limit: number,
) {
  const noteLink = alias(schema.accountingEntityLink, "settled_note_link");
  const voidLink = alias(schema.accountingEntityLink, "settled_void_link");
  const settlementLink = alias(schema.accountingEntityLink, "void_settlement_link");
  return tx.select({
    id: schema.creditNote.id,
    customerId: schema.creditNote.customerId,
    currency: schema.creditNote.currency,
    total: schema.creditNote.total,
    voidedAt: schema.creditNote.voidedAt,
    creditNoteExternalId: noteLink.externalId,
    reversalExternalId: voidLink.externalId,
  })
    .from(schema.creditNote)
    .innerJoin(noteLink, and(
      eq(noteLink.connectionId, connectionId),
      eq(noteLink.kind, "credit_note"),
      eq(noteLink.entityId, schema.creditNote.id),
      eq(noteLink.state, "linked"),
      isNotNull(noteLink.externalId),
    ))
    .innerJoin(voidLink, and(
      eq(voidLink.connectionId, connectionId),
      eq(voidLink.kind, "credit_note_void"),
      eq(voidLink.entityId, schema.creditNote.id),
      eq(voidLink.state, "linked"),
      isNotNull(voidLink.externalId),
    ))
    .leftJoin(settlementLink, and(
      eq(settlementLink.connectionId, connectionId),
      eq(settlementLink.kind, "credit_note_application"),
      eq(settlementLink.entityId, schema.creditNote.id),
    ))
    .where(and(
      eq(schema.creditNote.status, "void"),
      offerable(settlementLink.id, settlementLink.state),
      closedOn ? sql`${schema.creditNote.voidedAt}::date > ${closedOn}` : undefined,
    ))
    .orderBy(asc(schema.creditNote.number))
    .limit(limit);
}

/**
 * A document this pass refuses to send, written down where somebody can read
 * it.
 *
 * It takes the claim like a push does, so the refusal counts against
 * `attempts` and a document nothing can fix stops being retried forever. The
 * message is the one the operator sees.
 */
async function recordRefusal(
  ctx: ServiceContext,
  connectionId: string,
  kind: AccountingEntityKind,
  entityId: string,
  idempotencyKey: string,
  message: string,
): Promise<void> {
  await guardedWrite(ctx, "accounting:sync", async (tx) => {
    const claimed = await claim(tx, ctx.actor.organizationId, connectionId, kind, entityId, idempotencyKey);
    if (claimed.kind === "claimed" || claimed.kind === "recover") {
      await markFailed(tx, claimed.linkId, message);
    }
  });
}

/* --------------------------------------------------------------- inbound */

/**
 * What the change feed is FOR, and what it is deliberately not for.
 *
 * It keeps our link table honest about documents we pushed: a version bumped
 * over there is recorded so a later update does not have to pay for a read,
 * and a document DELETED over there stops being something this sync believes
 * exists.
 *
 * It does NOT create work in this product from documents created in the
 * accounting system. An invoice typed straight into QuickBooks has no job, no
 * property and no visit behind it, and materializing a customer and a job
 * from one would put work on a dispatch board that nobody scheduled. This
 * product is the system of record for work; the books are the system of
 * record for accounts. Changes flow back as facts about documents, not as new
 * documents.
 */
/**
 * The kinds a change feed entry can be, per kind it reports.
 *
 * A provider's feed names its own object types, and three of ours share one:
 * a credit note is a CreditMemo like a write off is, a voided credit note's
 * reversal is an Invoice, and a QuickBooks application is a Payment. Without
 * this a credit note deleted over there would be looked for as a write off,
 * found nowhere, and still believed in here.
 */
const SAME_DOCUMENT: Partial<Record<AccountingEntityKind, AccountingEntityKind[]>> = {
  credit_memo: ["credit_memo", "credit_note"],
  invoice: ["invoice", "credit_note_void"],
  payment: ["payment", "credit_note_application"],
};

async function applyChanges(
  ctx: ServiceContext,
  connectionId: string,
  changes: { kind: AccountingEntityKind; externalId: string; version: string | null; deleted: boolean }[],
): Promise<void> {
  if (changes.length === 0) return;

  await guardedWrite(ctx, "accounting:sync", async (tx) => {
    for (const change of changes) {
      const [row] = await tx.select({ id: schema.accountingEntityLink.id })
        .from(schema.accountingEntityLink)
        .where(and(
          eq(schema.accountingEntityLink.connectionId, connectionId),
          inArray(schema.accountingEntityLink.kind, SAME_DOCUMENT[change.kind] ?? [change.kind]),
          eq(schema.accountingEntityLink.externalId, change.externalId),
        )).limit(1);
      /** A document we never pushed. Counted, and otherwise none of our business. */
      if (!row) continue;

      if (change.deleted) {
        /**
         * The row is KEPT and marked `deleted`, rather than removed.
         *
         * Removing it would make the next pass treat the invoice as never
         * pushed and create it again, which is the sync arguing with the
         * bookkeeper whose books these are. Keeping it means the entity is
         * not re-sent, the reason is on the record, and putting it back is a
         * decision somebody makes.
         */
        await tx.update(schema.accountingEntityLink).set({
          state: "deleted",
          lastError: "This document was deleted in the accounting system.",
          updatedAt: new Date(),
        }).where(eq(schema.accountingEntityLink.id, row.id));
        continue;
      }

      await tx.update(schema.accountingEntityLink).set({
        externalVersion: change.version,
        updatedAt: new Date(),
      }).where(eq(schema.accountingEntityLink.id, row.id));
    }
  });
}

/* ---------------------------------------------------------- the work sets */

/**
 * A document dated inside a closed period is NOT in any of these sets.
 *
 * Excluded by the query rather than refused per document, deliberately. A
 * refusal takes a claim and counts against `attempts`, so five passes after a
 * quarter is closed every old invoice would be permanently `failed` and
 * reopening the quarter would not bring them back. The count is reported by
 * `status` instead, so "eleven documents are held back by the March close" is
 * on the screen without anything being burned.
 */
function afterClose(column: PgColumn, closedOn: string | null) {
  return closedOn ? sql`${column} > ${closedOn}` : undefined;
}

/**
 * Whether a document is still worth offering, from the link row alone.
 *
 * No link at all, or a link that is not `linked` and not `deleted`. A
 * `failed` document IS offered again, because most failures are a missing
 * account mapping or a throttle and the fix is somebody mapping an account;
 * `claim` is what stops that becoming an infinite retry, by counting
 * attempts. A `deleted` document is never offered, because a person removed
 * it on purpose.
 *
 * Leaving `failed` out of this was a real bug while it lasted: a document
 * that failed once was never selected again, so the attempt ceiling could
 * never be reached and a transient throttle was permanent.
 */
function offerable(linkId: PgColumn, state: PgColumn) {
  return or(isNull(linkId), inArray(state, ["pending", "failed"]));
}

/** Issued invoices that have not landed in the books yet. */
async function invoicesToPush(
  tx: Database, connectionId: string, closedOn: string | null, limit: number,
) {
  const link = alias(schema.accountingEntityLink, "invoice_link");
  return tx.select({
    id: schema.invoice.id,
    number: schema.invoice.number,
    customerId: schema.invoice.customerId,
    issuedOn: schema.invoice.issuedOn,
    dueOn: schema.invoice.dueOn,
    currency: schema.invoice.currency,
    taxTotal: schema.invoice.taxTotal,
    memo: schema.invoice.memo,
  })
    .from(schema.invoice)
    .leftJoin(link, and(
      eq(link.connectionId, connectionId),
      eq(link.kind, "invoice"),
      eq(link.entityId, schema.invoice.id),
    ))
    .where(and(
      /**
       * A DRAFT IS NOT SENT. It has no number a bookkeeper can rely on, it
       * can still change, and an accounting system has no concept of a
       * document that might become something else.
       */
      inArray(schema.invoice.status, ["open", "partially_paid", "paid"]),
      offerable(link.id, link.state),
      afterClose(schema.invoice.issuedOn, closedOn),
    ))
    .orderBy(asc(schema.invoice.number))
    .limit(limit);
}

/** Payments that cleared and have not been recorded over there. */
async function paymentsToPush(
  tx: Database, connectionId: string, closedOn: string | null, limit: number,
) {
  const link = alias(schema.accountingEntityLink, "payment_link");
  return tx.select({
    id: schema.payment.id,
    customerId: schema.payment.customerId,
    amount: schema.payment.amount,
    refundedAmount: schema.payment.refundedAmount,
    currency: schema.payment.currency,
    receivedAt: schema.payment.receivedAt,
  })
    .from(schema.payment)
    .leftJoin(link, and(
      eq(link.connectionId, connectionId),
      eq(link.kind, "payment"),
      eq(link.entityId, schema.payment.id),
    ))
    .where(and(
      /**
       * `succeeded` only. A pending card authorization is not money and a
       * failed one never was; recording either as cash received overstates
       * the bank and then has to be reversed.
       */
      /**
       * And `partially_refunded`, which is money that arrived and some of
       * which went back. Leaving it out meant a payment refunded in part
       * before its first sync never reached the books at all, and the
       * per-invoice netting below, written for exactly that payment, could
       * never run. A payment refunded in full is not sent: what came in went
       * back out, and the books are left with nothing to record.
       */
      inArray(schema.payment.status, ["succeeded", "partially_refunded"]),
      offerable(link.id, link.state),
      closedOn ? sql`${schema.payment.receivedAt}::date > ${closedOn}` : undefined,
    ))
    .orderBy(asc(schema.payment.receivedAt))
    .limit(limit);
}

/**
 * Invoices that were voided or written off AFTER they reached the books.
 *
 * Only those. An invoice voided before it was ever pushed simply never goes:
 * there is nothing over there to reverse, and sending a credit memo against
 * a document that does not exist is how a customer ends up with a floating
 * credit.
 */
async function creditsToPush(
  tx: Database, connectionId: string, closedOn: string | null, limit: number,
) {
  const pushed = alias(schema.accountingEntityLink, "credited_invoice_link");
  const credit = alias(schema.accountingEntityLink, "credit_memo_link");
  return tx.select({
    id: schema.invoice.id,
    number: schema.invoice.number,
    customerId: schema.invoice.customerId,
    status: schema.invoice.status,
    total: schema.invoice.total,
    amountPaid: schema.invoice.amountPaid,
    amountCredited: schema.invoice.amountCredited,
    currency: schema.invoice.currency,
    voidedAt: schema.invoice.voidedAt,
    updatedAt: schema.invoice.updatedAt,
  })
    .from(schema.invoice)
    .innerJoin(pushed, and(
      eq(pushed.connectionId, connectionId),
      eq(pushed.kind, "invoice"),
      eq(pushed.entityId, schema.invoice.id),
      eq(pushed.state, "linked"),
    ))
    .leftJoin(credit, and(
      eq(credit.connectionId, connectionId),
      eq(credit.kind, "credit_memo"),
      eq(credit.entityId, schema.invoice.id),
    ))
    .where(and(
      inArray(schema.invoice.status, ["void", "written_off"]),
      offerable(credit.id, credit.state),
      /**
       * THE CREDIT'S OWN DATE, NOT THE INVOICE'S.
       *
       * A credit memo reversing an invoice from a filed quarter belongs in
       * the period it was raised in, which is open. Filtering on the
       * invoice's issue date instead would mean that writing off an old
       * receivable produces a credit memo that silently never reaches the
       * books, and the company's AR would then disagree with its accountant's
       * for good, with nothing anywhere saying why.
       *
       * `voided_at` where there is one, `updated_at` otherwise: `writeOff`
       * sets neither a void date nor anything else dated, so the moment the
       * row changed is the best evidence of when the decision was made. The
       * same coalesce is used to date the document itself, so the filter and
       * the document cannot disagree.
       */
      closedOn
        ? sql`coalesce(${schema.invoice.voidedAt}, ${schema.invoice.updatedAt})::date > ${closedOn}`
        : undefined,
    ))
    .orderBy(asc(schema.invoice.number))
    .limit(limit);
}

/* ---------------------------------------------------------------- status */

export interface AccountingStatus {
  connected: boolean;
  provider: string | null;
  unmappedAccountCodes: string[];
  /** Documents claimed and not yet linked. A healthy number is zero or small. */
  pendingDocuments: number;
  /** Documents that failed and stopped being retried. Somebody has to look. */
  failedDocuments: number;
  linkedDocuments: number;
  lastRun: {
    id: string;
    startedAt: Date;
    finishedAt: Date | null;
    recordsRead: number;
    recordsWritten: number;
    cursor: string | null;
    blockedReason: string | null;
    error: string | null;
  } | null;
  closedThrough: string | null;
}

export async function status(ctx: ServiceContext): Promise<AccountingStatus> {
  return guardedRead(ctx, "accounting:sync", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const closed = await closedThrough(tx, organizationId);

    let connection: AccountingConnection | null = null;
    try {
      connection = await connectionFor(tx, organizationId);
    } catch (error) {
      /**
       * Not connected is an ORDINARY STATE and the screen has to be able to
       * render it. Throwing here would make "you have not set this up yet"
       * arrive as a 500.
       */
      if (!(error instanceof AccountingNotConfiguredError)) throw error;
    }

    if (!connection) {
      return {
        connected: false, provider: null, unmappedAccountCodes: [],
        pendingDocuments: 0, failedDocuments: 0, linkedDocuments: 0,
        lastRun: null, closedThrough: closed,
      };
    }

    const counts = await tx.select({
      state: schema.accountingEntityLink.state,
      count: sql<number>`count(*)::int`,
    })
      .from(schema.accountingEntityLink)
      .where(eq(schema.accountingEntityLink.connectionId, connection.id))
      .groupBy(schema.accountingEntityLink.state);

    const by = (state: string) => counts.find((row) => row.state === state)?.count ?? 0;
    /** Deleted over there counts as something a person has to look at. */
    const needingAttention = by("failed") + by("deleted");

    const [run] = await tx.select({
      id: schema.syncRun.id,
      startedAt: schema.syncRun.startedAt,
      finishedAt: schema.syncRun.finishedAt,
      recordsRead: schema.syncRun.recordsRead,
      recordsWritten: schema.syncRun.recordsWritten,
      cursor: schema.syncRun.cursor,
      blockedReason: schema.syncRun.blockedReason,
      error: schema.syncRun.error,
    })
      .from(schema.syncRun)
      .where(eq(schema.syncRun.connectionId, connection.id))
      .orderBy(desc(schema.syncRun.startedAt))
      .limit(1);

    return {
      connected: true,
      provider: connection.provider,
      unmappedAccountCodes: await unmappedAccountCodes(tx, organizationId, connection.id),
      pendingDocuments: by("pending"),
      failedDocuments: needingAttention,
      linkedDocuments: by("linked"),
      lastRun: run ?? null,
      closedThrough: closed,
    };
  });
}

/** The history. What an operator opens when somebody says the books look stale. */
export async function listRuns(ctx: ServiceContext, input: { limit?: number | undefined } = {}) {
  return guardedRead(ctx, "accounting:sync", async (tx) => {
    const connection = await connectionFor(tx, ctx.actor.organizationId);
    const rows = await tx.select({
      id: schema.syncRun.id,
      direction: schema.syncRun.direction,
      entityType: schema.syncRun.entityType,
      cursor: schema.syncRun.cursor,
      recordsRead: schema.syncRun.recordsRead,
      recordsWritten: schema.syncRun.recordsWritten,
      startedAt: schema.syncRun.startedAt,
      finishedAt: schema.syncRun.finishedAt,
      blockedReason: schema.syncRun.blockedReason,
      error: schema.syncRun.error,
    })
      .from(schema.syncRun)
      .where(eq(schema.syncRun.connectionId, connection.id))
      .orderBy(desc(schema.syncRun.startedAt))
      .limit(Math.min(input.limit ?? 20, 100));
    return rows;
  });
}

/** Documents a person has to do something about. */
export async function listProblems(ctx: ServiceContext) {
  return guardedRead(ctx, "accounting:sync", async (tx) => {
    const connection = await connectionFor(tx, ctx.actor.organizationId);
    const rows = await tx.select({
      id: schema.accountingEntityLink.id,
      kind: schema.accountingEntityLink.kind,
      entityId: schema.accountingEntityLink.entityId,
      idempotencyKey: schema.accountingEntityLink.idempotencyKey,
      attempts: schema.accountingEntityLink.attempts,
      lastError: schema.accountingEntityLink.lastError,
      updatedAt: schema.accountingEntityLink.updatedAt,
    })
      .from(schema.accountingEntityLink)
      .where(and(
        eq(schema.accountingEntityLink.connectionId, connection.id),
        /** Both states a person has to decide about. See `offerable`. */
        inArray(schema.accountingEntityLink.state, ["failed", "deleted"]),
      ))
      .orderBy(desc(schema.accountingEntityLink.updatedAt))
      .limit(100);
    return rows;
  });
}

/**
 * Put a failed document back in the queue.
 *
 * The attempt counter is reset, not the link: the external id stays null and
 * the key stays the same, so a retry after the operator maps the missing
 * account is still covered by the same claim and still cannot duplicate.
 */
export async function retryDocument(ctx: ServiceContext, input: { linkId: string }) {
  return guardedWrite(ctx, "accounting:sync", async (tx) => {
    const [row] = await tx.select().from(schema.accountingEntityLink)
      .where(eq(schema.accountingEntityLink.id, input.linkId)).limit(1);
    if (!row) throw new NotFoundError("Accounting document");
    if (row.state === "linked") {
      throw new ConflictError("This document is already in the accounting system.");
    }

    const [updated] = await tx.update(schema.accountingEntityLink).set({
      /**
       * `failed`, not `pending`. A `pending` row means a push may be in
       * flight and triggers the metered recovery read on the next pass. This
       * one is known not to be in flight, so the next pass can simply send.
       */
      state: "failed",
      attempts: 0,
      lastError: null,
      /**
       * The external id is cleared along with it. On a `deleted` row it names
       * a document that is gone, and leaving it there would make the partial
       * unique index reserve an id nothing can use and would make the next
       * pass believe the document is already over there.
       */
      externalId: null,
      externalVersion: null,
      updatedAt: new Date(),
    }).where(eq(schema.accountingEntityLink.id, row.id)).returning();

    await audit(tx, ctx, "accounting.document_retried", "accounting_entity_link", row.id, row, updated!);
    return { id: updated!.id, kind: updated!.kind, attempts: updated!.attempts };
  });
}

/* --------------------------------------------------------- the secret store */

/**
 * WHERE THE REFRESH TOKEN LIVES.
 *
 * `integration_connection.credentialRef` is a reference, never the secret.
 * The deployment decides what it references: Supabase Vault, a KMS, a file
 * the orchestrator mounted. The default reads an environment variable named
 * by the ref, which is the smallest thing that works and keeps the secret out
 * of the database.
 *
 * `write` exists because OAuth refresh tokens ROTATE. A deployment that
 * cannot persist the new one has a connection that dies within days, and the
 * default here can only hold it for the life of the process, so it says so
 * out loud rather than failing quietly at three in the morning.
 */
export interface SecretStore {
  read(ref: string): Promise<string>;
  write(ref: string, value: string): Promise<void>;
}

let warnedAboutRotation = false;

export const environmentSecretStore: SecretStore = {
  async read(ref: string): Promise<string> {
    const value = process.env[ref];
    if (!value) throw new Error(`No secret in the environment for "${ref}"`);
    return value;
  },
  async write(ref: string, value: string): Promise<void> {
    process.env[ref] = value;
    if (!warnedAboutRotation) {
      warnedAboutRotation = true;
      console.warn(
        `[accounting] The accounting credential rotated and was kept in this process only. `
        + `Configure a real secret store, or the connection will need reauthorizing after `
        + `the next restart.`,
      );
    }
  },
};

let secrets: SecretStore = environmentSecretStore;

/** A deployment points this at its own vault once, at startup. */
export function useSecretStore(store: SecretStore): void {
  secrets = store;
}

/** The provider for this request's organization, using the configured store. */
export async function resolveProvider(
  ctx: ServiceContext,
): Promise<{ connection: AccountingConnection; provider: AccountingProvider }> {
  return guardedRead(ctx, "accounting:sync", (tx) =>
    providerFor(
      tx,
      ctx.actor.organizationId,
      (ref) => secrets.read(ref),
      (ref, value) => secrets.write(ref, value),
    ));
}

/* -------------------------------------------------------------- handlers */

export const handlers = {
  getAccountingStatus: (ctx: ServiceContext) => status(ctx),

  listAccountingAccounts: async (ctx: ServiceContext) => {
    const { provider } = await resolveProvider(ctx);
    return listRemoteAccounts(ctx, { provider });
  },

  listAccountMappings: async (ctx: ServiceContext): Promise<{
    mappings: { accountCode: string; externalId: string; externalName: string; externalKind: string }[];
  }> => ({ mappings: await listMappings(ctx) }),

  setAccountMapping: (ctx: ServiceContext, input: AccountMappingInput) => setMapping(ctx, input),

  runAccountingSync: async (ctx: ServiceContext, input: { limit?: number | undefined }) => {
    const { provider } = await resolveProvider(ctx);
    return sync(ctx, { provider }, input.limit === undefined ? {} : { limit: input.limit });
  },

  listAccountingRuns: async (ctx: ServiceContext, input: { limit?: number | undefined }) => ({
    runs: await listRuns(ctx, input),
  }),

  listAccountingProblems: async (ctx: ServiceContext) => ({ problems: await listProblems(ctx) }),

  retryAccountingDocument: (ctx: ServiceContext, input: { id: string }) =>
    retryDocument(ctx, { linkId: input.id }),

  listAccountingPeriods: async (ctx: ServiceContext) => ({ periods: await listPeriods(ctx) }),

  closeAccountingPeriod: (ctx: ServiceContext, input: { periodEnd: string; note?: string | undefined }) =>
    closePeriod(ctx, input),

  reopenAccountingPeriod: (ctx: ServiceContext, input: { periodEnd: string; reason: string }) =>
    reopenPeriod(ctx, input),
} as const;
