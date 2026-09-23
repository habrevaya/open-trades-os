import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { Actor } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import {
  createProvider, ProviderNotConfiguredError,
  type DeliveryReport, type MessagingProvider,
} from "../comms/provider";

/**
 * THE OUTBOX
 *
 * `sendMessage` writes a message with status `queued` and stops there, on
 * purpose: a step that claimed to have sent something it had only written to
 * a table would make the whole log untrustworthy. This is the part that hands
 * it to a carrier.
 *
 * The property that matters is that a crash never sends a text twice. A
 * customer receiving the same appointment reminder three times is the failure
 * an operator hears about, and it is exactly what a naive "read the queue,
 * send, mark sent" loop produces the first time a process dies between the
 * second and third step.
 *
 * So the row is CLAIMED before the carrier is called. The claim is a
 * conditional update, which is atomic, so two workers cannot both claim the
 * same message and a worker that dies after claiming leaves a row in
 * `sending` that is visibly stuck rather than one that quietly goes out
 * again.
 */

/** A message stuck in `sending` for longer than this is treated as abandoned. */
const STUCK_AFTER_MS = 10 * 60 * 1000;

export interface SendOutcome {
  messageId: string;
  status: "sent" | "failed" | "skipped";
  reason?: string;
}

function outboxActor(organizationId: string): Actor {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    organizationId,
    roles: [],
    grants: [],
    agentId: "outbox",
  };
}

/**
 * Take ownership of one queued message.
 *
 * The `where` clause is the lock. Two workers issuing this at the same moment
 * both filter on `status = 'queued'`, and Postgres serializes the updates, so
 * exactly one of them sees a returned row.
 */
export async function claim(tx: Database, messageId: string): Promise<boolean> {
  const claimed = await tx.update(schema.message)
    .set({ status: "sending", updatedAt: new Date() })
    .where(and(
      eq(schema.message.id, messageId),
      eq(schema.message.status, "queued"),
    ))
    .returning({ id: schema.message.id });
  return claimed.length > 0;
}

/** `claim`, in its own transaction. Exported so the invariant it exists for
 *  can be asserted directly rather than by racing two workers and hoping. */
export async function claimOne(
  db: Database, organizationId: string, messageId: string,
): Promise<boolean> {
  return inTenant({ actor: outboxActor(organizationId), db }, async (tx) => claim(tx, messageId));
}

/**
 * The provider this organization has connected for messaging.
 *
 * Resolved per organization rather than from a global environment variable,
 * because a hosted deployment serves many companies and each brings their own
 * carrier account. The credential is fetched by reference from the secret
 * store; this layer never sees it in the database.
 */
export async function providerFor(
  tx: Database,
  organizationId: string,
  readSecret: (ref: string) => Promise<string>,
): Promise<MessagingProvider> {
  const [connection] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "messaging"),
      eq(schema.integrationConnection.status, "connected"),
    ))
    .limit(1);

  if (!connection) throw new ProviderNotConfiguredError("messaging");
  const secret = connection.credentialRef ? await readSecret(connection.credentialRef) : "";
  return createProvider(connection.provider, connection.settings, secret);
}

export interface OutboxDeps {
  /** Injected so a test never reaches a carrier and a deployment never fakes one. */
  provider: MessagingProvider;
}

/**
 * Send everything queued for one organization.
 *
 * Oldest first, because a reminder that is late is worth less every minute
 * and a backlog that serves newest first never clears the oldest at all.
 */
export async function flush(
  db: Database,
  organizationId: string,
  deps: OutboxDeps,
  limit = 50,
): Promise<SendOutcome[]> {
  const ctx: ServiceContext = { actor: outboxActor(organizationId), db };

  const pending = await inTenant(ctx, async (tx) =>
    tx.select({
      id: schema.message.id,
      to: schema.message.toAddress,
      from: schema.message.fromAddress,
      body: schema.message.body,
      media: schema.message.media,
    })
      .from(schema.message)
      .where(and(
        eq(schema.message.status, "queued"),
        eq(schema.message.direction, "outbound"),
      ))
      .orderBy(asc(schema.message.createdAt))
      .limit(limit));

  const outcomes: SendOutcome[] = [];

  for (const row of pending) {
    const mine = await inTenant(ctx, async (tx) => claim(tx, row.id));
    if (!mine) {
      outcomes.push({ messageId: row.id, status: "skipped", reason: "claimed_elsewhere" });
      continue;
    }

    const result = await deps.provider.send({
      to: row.to,
      from: row.from,
      body: row.body ?? "",
      media: (row.media ?? []).map((m) => m.url),
      reference: row.id,
    });

    await inTenant(ctx, async (tx) => {
      if (result.ok) {
        await tx.update(schema.message).set({
          /**
           * `sent`, not `delivered`. The carrier has accepted it and nothing
           * more is known yet. Claiming delivery here would make the delivery
           * receipt that arrives later either redundant or contradictory.
           */
          status: "sent",
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(schema.message.id, row.id));
      } else {
        await tx.update(schema.message).set({
          /**
           * A retryable failure goes back to `queued` so the next pass picks
           * it up. A permanent one stays failed: retrying a wrong number
           * forever is how a queue silently stops being a queue.
           */
          status: result.retryable ? "queued" : "failed",
          errorCode: result.code,
          errorMessage: result.message,
          updatedAt: new Date(),
        }).where(eq(schema.message.id, row.id));
      }
    });

    outcomes.push(result.ok
      ? { messageId: row.id, status: "sent" }
      : { messageId: row.id, status: "failed", reason: result.code });
  }

  return outcomes;
}

/**
 * Put abandoned claims back.
 *
 * A worker killed between claiming and sending leaves `sending` forever. The
 * alternative to this is a message that silently never goes, which reads to
 * an operator as the automation not working.
 *
 * The window is long on purpose. Recovering too eagerly sends a second text
 * while the first is still in flight, which is the exact failure the claim
 * exists to prevent.
 */
export async function recoverStuck(
  db: Database,
  organizationId: string,
  olderThanMs = STUCK_AFTER_MS,
): Promise<number> {
  const ctx: ServiceContext = { actor: outboxActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const rows = await tx.update(schema.message)
      .set({ status: "queued", updatedAt: new Date() })
      .where(and(
        eq(schema.message.status, "sending"),
        isNull(schema.message.providerMessageId),
        sql`${schema.message.updatedAt} < now() - make_interval(secs => ${olderThanMs / 1000})`,
      ))
      .returning({ id: schema.message.id });
    return rows.length;
  });
}

/**
 * Record a delivery receipt.
 *
 * Matched on our own reference when the provider carried it, and on the
 * provider's id otherwise. Both, because a callback can arrive before the
 * send's own write commits, and then the provider id is not in the table yet.
 */
export async function recordDelivery(
  db: Database,
  organizationId: string,
  report: DeliveryReport,
): Promise<boolean> {
  const ctx: ServiceContext = { actor: outboxActor(organizationId), db };

  return inTenant(ctx, async (tx) => {
    const [row] = await tx.select({ id: schema.message.id, status: schema.message.status })
      .from(schema.message)
      .where(report.reference
        ? eq(schema.message.id, report.reference)
        : eq(schema.message.providerMessageId, report.providerMessageId))
      .limit(1);
    if (!row) return false;

    /**
     * Receipts arrive out of order. `sent` landing after `delivered` must not
     * move the message backwards, or a customer support screen shows "sending"
     * for a text that arrived an hour ago.
     */
    const rank: Record<string, number> = {
      queued: 0, sending: 1, sent: 2, delivered: 3,
      undelivered: 3, failed: 3, received: 3,
    };
    if ((rank[report.status] ?? 0) <= (rank[row.status] ?? 0)) return false;

    await tx.update(schema.message).set({
      status: report.status,
      providerMessageId: report.providerMessageId,
      ...(report.status === "delivered" ? { deliveredAt: new Date() } : {}),
      ...(report.errorCode ? { errorCode: report.errorCode } : {}),
      ...(report.errorMessage ? { errorMessage: report.errorMessage } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.message.id, row.id));
    return true;
  });
}
