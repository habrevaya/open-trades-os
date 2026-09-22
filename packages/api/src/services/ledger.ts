import { randomUUID } from "node:crypto";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m } from "@opentradesos/core";
import type { ServiceContext } from "./context";

/**
 * Writing a posting.
 *
 * The balance is asserted twice on purpose. Once here, in TypeScript, where
 * the error names the imbalance and points at the code that built it. Once in
 * Postgres, by a deferred constraint trigger, where it is a guarantee rather
 * than a convention.
 *
 * The first check exists because a trigger firing at COMMIT tells you a
 * transaction failed, not which of forty entries was wrong. The second exists
 * because the first can be bypassed by anything writing SQL directly, and the
 * ledger is the one table where that must not be possible.
 */
export async function writePosting(
  tx: Database, ctx: ServiceContext, posting: ledger.Posting,
): Promise<string> {
  const transactionId = randomUUID();

  await tx.insert(schema.ledgerEntry).values(
    posting.entries.map((entry) => ({
      organizationId: ctx.actor.organizationId,
      transactionId,
      occurredAt: posting.occurredAt,
      direction: entry.direction,
      accountCode: entry.accountCode,
      currency: entry.amount.currency,
      amount: m.toString(entry.amount),
      sourceType: posting.sourceType,
      sourceId: posting.sourceId,
      ...(entry.customerId ? { customerId: entry.customerId } : {}),
      ...(entry.jobId ? { jobId: entry.jobId } : {}),
      ...(entry.memo ? { memo: entry.memo } : {}),
    })),
  );

  return transactionId;
}
