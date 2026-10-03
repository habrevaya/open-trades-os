import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { ServiceContext } from "./context";

/**
 * A REPLAYED REQUEST GETS THE FIRST ANSWER BACK
 *
 * The same shape every idempotent write here uses (`integration_event`, keyed
 * by the caller's idempotency key and an entity type), with one difference:
 * the answer itself is kept on the row, in `response_payload`. For a write
 * that creates one record the record can be read back by id; for a rename
 * across four hundred customers or a price change across a whole category
 * there is no single record to read, and re-running the write on a retry is
 * the thing a key exists to stop. A rename whose replay ran again would find
 * the old tag gone and report that it renamed nothing.
 *
 * Inside the caller's transaction, both halves, so a write that rolls back
 * leaves no memory of having happened.
 */
export async function replayed<T>(tx: Database, ctx: ServiceContext, entityType: string): Promise<T | null> {
  if (!ctx.idempotencyKey) return null;
  const [row] = await tx.select({ payload: schema.integrationEvent.responsePayload })
    .from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
      eq(schema.integrationEvent.entityType, entityType),
    )).limit(1);
  return row?.payload ? (row.payload as T) : null;
}

export async function remember(
  tx: Database, ctx: ServiceContext, entityType: string, entityId: string | null, answer: object,
): Promise<void> {
  if (!ctx.idempotencyKey) return;
  await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId,
    idempotencyKey: ctx.idempotencyKey,
    entityType,
    entityId,
    direction: "inbound",
    provider: "api",
    eventType: `${entityType}.written`,
    status: "succeeded",
    responsePayload: answer as Record<string, unknown>,
  });
}
