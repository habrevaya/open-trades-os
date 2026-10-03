import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, max, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, field, time, type Actor } from "@opentradesos/core";
import { audit, inTenant, type ServiceContext } from "./context";
import { quietHoursFor } from "./comms-send";
import { ExpoPushProvider, type PushProvider, type PushTicket } from "../push/provider";

/**
 * TELLING THE PHONE, FROM THE WORKER
 *
 * The office changes somebody's day and the change is written as an event in
 * the same transaction (see `visit-notices.ts`). This reads those events from
 * its own place in each company's log, writes one `push_delivery` row per
 * phone per change, and hands the rows to the push service. Three steps, in
 * three short transactions, and the network is never called with a
 * transaction open: a push service that takes twenty seconds to answer must
 * not hold a lock on somebody's day while it does.
 *
 *   1. READ. Events past this consumer's cursor; a row per registered phone
 *      of each technician the event names; the cursor moved past what was
 *      read, all in one transaction. The rows are keyed on (event, device),
 *      so reading the same event twice writes nothing the second time.
 *
 *   2. SEND. Rows still queued are claimed, so a second worker running at
 *      the same time takes different ones, go to the push service in one
 *      request per hundred, and each row is marked with what came back.
 *
 *   3. RECEIPTS. A quarter of an hour later, the push service is asked what
 *      became of what it took. "The app is no longer on this phone" clears
 *      the phone's token, so it is not asked about on every change after.
 *
 * Stale is skipped, not sent. A change read more than twelve hours after it
 * was made (the worker was down, or this is the first pass on a log with a
 * history) is not news, and a phone buzzing at breakfast about last
 * Tuesday's board is how somebody learns to ignore it.
 */

/** Older than this, a change is history rather than news. */
export const STALE_HOURS = 12;
/** Tries at the push service before a row is given up on. */
export const MAX_ATTEMPTS = 5;
/** How long the push service is given before its receipt is asked for. */
export const RECEIPT_AFTER_MINUTES = 15;
/** How long a claim is held before a worker that took it is presumed dead. */
export const CLAIM_MINUTES = 5;

const CONSUMER = "push";
const READ_BATCH = 200;
const SEND_BATCH = 300;

/** What the worker acts as. Reads the log and devices, writes deliveries; nothing else. */
function pushActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: [],
    agentId: "push",
  };
}

export interface PushDeps {
  provider: PushProvider;
  now?: () => Date;
}

export interface PushPassResult {
  organizationId: string;
  /** Delivery rows written from events on this pass. */
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Phones whose token was cleared because the app is gone from them. */
  forgotten: number;
}

/**
 * One pass over every company with a change to read, a notice to send or a
 * receipt to ask for. Finding them is a cross tenant read, which goes through
 * `app.push_work_organizations` and returns ids and nothing else.
 */
export async function pushPass(
  db: Database,
  options: { provider?: PushProvider; now?: () => Date; shouldStop?: () => boolean } = {},
): Promise<PushPassResult[]> {
  const provider = options.provider ?? new ExpoPushProvider();
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.push_work_organizations(50)`,
  );
  const results: PushPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push(await pushFor(db, row.organization_id, {
        provider, ...(options.now ? { now: options.now } : {}),
      }));
    } catch (error) {
      /** One company's failure must not stop everybody else's notices. */
      console.error(`[worker] push ${row.organization_id}:`, (error as Error).message);
    }
  }
  return results;
}

/** Read, send and ask, for one company. */
export async function pushFor(db: Database, organizationId: string, deps: PushDeps): Promise<PushPassResult> {
  const now = deps.now ?? (() => new Date());
  const ctx: ServiceContext = { actor: pushActor(organizationId), db };
  const result: PushPassResult = { organizationId, queued: 0, sent: 0, failed: 0, skipped: 0, forgotten: 0 };

  result.queued = await readEvents(ctx, now());
  await send(ctx, deps.provider, now(), result);
  await askReceipts(ctx, deps.provider, now(), result);
  return result;
}

/* ------------------------------------------------------------------ read */

async function readEvents(ctx: ServiceContext, now: Date): Promise<number> {
  const organizationId = ctx.actor.organizationId;
  return inTenant(ctx, async (tx) => {
    const staleBefore = new Date(now.getTime() - STALE_HOURS * 3_600_000);
    const cursor = await cursorFor(tx, organizationId, staleBefore);

    /**
     * Only the four changes a phone is told about, from the name index, so a
     * company busy with invoices and texts costs this pass nothing. The cursor
     * moves to the last of them read; the events between are not this
     * consumer's business.
     */
    const events = await tx.select().from(schema.domainEvent)
      .where(and(
        gt(schema.domainEvent.sequence, cursor),
        inArray(schema.domainEvent.name, Object.keys(field.NOTICE_FOR_EVENT)),
      ))
      .orderBy(asc(schema.domainEvent.sequence))
      .limit(READ_BATCH);
    if (events.length === 0) return 0;

    const quiet = await quietHoursFor(tx, organizationId, now);
    const localMinutes = time.minutesInDay(now, quiet.zone);
    let written = 0;

    for (const event of events) {
      const kind = field.NOTICE_FOR_EVENT[event.name]!;
      if (event.occurredAt < staleBefore) continue;

      const payload = event.payload;
      const technicianIds = Array.isArray(payload["technicianIds"])
        ? (payload["technicianIds"] as unknown[]).filter((id): id is string => typeof id === "string")
        : [];
      if (technicianIds.length === 0) continue;

      const devices = await tx.select({
        id: schema.device.id,
        technicianId: schema.device.technicianId,
      }).from(schema.device)
        .where(and(
          inArray(schema.device.technicianId, technicianIds),
          isNull(schema.device.revokedAt),
          isNotNull(schema.device.pushToken),
        ));
      if (devices.length === 0) continue;

      const windowStart = dateOf(payload["windowStart"]);
      const notice = field.visitNotice({
        kind,
        jobNumber: Number(payload["jobNumber"] ?? 0),
        customerName: String(payload["customerName"] ?? "A customer"),
        windowStart,
        windowEnd: dateOf(payload["windowEnd"]),
        previousWindowStart: dateOf(payload["previousWindowStart"]),
        timezone: quiet.zone,
      });
      const urgency = field.pushUrgency({
        localMinutes, now, window: quiet.window, visitStartsAt: windowStart,
      });

      const inserted = await tx.insert(schema.pushDelivery).values(devices.map((device) => ({
        organizationId,
        eventId: event.id,
        deviceId: device.id,
        technicianId: device.technicianId,
        visitId: event.entityId,
        kind,
        title: notice.title,
        body: notice.body,
        quiet: urgency === "quiet",
      }))).onConflictDoNothing().returning({ id: schema.pushDelivery.id });
      written += inserted.length;
    }

    await advance(tx, organizationId, events[events.length - 1]!.sequence);
    return written;
  });
}

/**
 * Where this consumer is in the company's log.
 *
 * A company read for the first time starts at the last event older than the
 * stale line, not at the beginning. Starting at zero would read years of
 * history to send nothing, and the events before the line would be skipped
 * as stale anyway.
 */
async function cursorFor(tx: Database, organizationId: string, staleBefore: Date): Promise<number> {
  const [row] = await tx.select({ last: schema.eventCursor.lastSequence })
    .from(schema.eventCursor)
    .where(and(
      eq(schema.eventCursor.organizationId, organizationId),
      eq(schema.eventCursor.consumer, CONSUMER),
    )).limit(1);
  if (row) return row.last;

  const [old] = await tx.select({ last: max(schema.domainEvent.sequence) })
    .from(schema.domainEvent)
    .where(lt(schema.domainEvent.occurredAt, staleBefore));
  return old?.last ?? 0;
}

/** Forward only, like the workflow cursor, so two workers cannot move it back. */
async function advance(tx: Database, organizationId: string, to: number): Promise<void> {
  await tx.insert(schema.eventCursor)
    .values({ organizationId, consumer: CONSUMER, lastSequence: to, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.eventCursor.organizationId, schema.eventCursor.consumer],
      set: {
        lastSequence: sql`greatest(${schema.eventCursor.lastSequence}, excluded.last_sequence)`,
        updatedAt: new Date(),
      },
    });
}

/* ------------------------------------------------------------------ send */

async function send(ctx: ServiceContext, provider: PushProvider, now: Date, result: PushPassResult) {
  const staleBefore = new Date(now.getTime() - STALE_HOURS * 3_600_000);

  const due = await inTenant(ctx, async (tx) => {
    /**
     * A claim a worker took and never finished, because it died mid request,
     * goes back in the queue. Whether that phone got the notice is unknown,
     * and a second buzz is the smaller harm than none for "do not go".
     */
    await tx.update(schema.pushDelivery)
      .set({ status: "queued", updatedAt: now })
      .where(and(
        eq(schema.pushDelivery.status, "sending"),
        lt(schema.pushDelivery.updatedAt, new Date(now.getTime() - CLAIM_MINUTES * 60_000)),
      ));

    /**
     * Claimed in one statement, so two workers running at once take
     * different rows: `skip locked` passes over a row another worker's claim
     * is holding rather than waiting for it and then sending it again.
     */
    const claimed = await tx.execute<{ id: string }>(sql`
      update public.push_delivery set status = 'sending', updated_at = ${now.toISOString()}::timestamptz
       where id in (
         select id from public.push_delivery
          where status = 'queued'
          order by created_at
          limit ${SEND_BATCH}
          for update skip locked
       )
      returning id
    `);
    const ids = claimed.map((row) => row.id);
    if (ids.length === 0) return [];

    const rows = await tx.select({
      id: schema.pushDelivery.id,
      deviceId: schema.pushDelivery.deviceId,
      visitId: schema.pushDelivery.visitId,
      kind: schema.pushDelivery.kind,
      title: schema.pushDelivery.title,
      body: schema.pushDelivery.body,
      quiet: schema.pushDelivery.quiet,
      attempts: schema.pushDelivery.attempts,
      createdAt: schema.pushDelivery.createdAt,
      token: schema.device.pushToken,
      revokedAt: schema.device.revokedAt,
    }).from(schema.pushDelivery)
      .innerJoin(schema.device, eq(schema.device.id, schema.pushDelivery.deviceId))
      .where(inArray(schema.pushDelivery.id, ids))
      .orderBy(asc(schema.pushDelivery.createdAt));

    /**
     * Said on the row rather than dropped. The phone was signed out or taken
     * away between the change and the send, or the notice waited past the
     * stale line; either way the row says why nobody was told.
     */
    const gone = rows.filter((r) => !r.token || r.revokedAt);
    const stale = rows.filter((r) => r.token && !r.revokedAt && r.createdAt < staleBefore);
    await markSkipped(tx, gone.map((r) => r.id), "The phone was signed out or taken away before it could be told.");
    await markSkipped(tx, stale.map((r) => r.id), `Not sent within ${STALE_HOURS} hours, so it was no longer news.`);
    result.skipped += gone.length + stale.length;

    return rows.filter((r) => r.token && !r.revokedAt && r.createdAt >= staleBefore);
  });
  if (due.length === 0) return;

  let tickets: PushTicket[];
  try {
    tickets = await provider.send(due.map((row) => ({
      to: row.token!,
      title: row.title,
      body: row.body,
      data: { visitId: row.visitId, kind: row.kind },
      quiet: row.quiet,
    })));
  } catch (error) {
    /** No answer at all. Nothing is known about any phone, so each is tried again. */
    const message = error instanceof Error ? error.message : String(error);
    tickets = due.map(() => ({ ok: false as const, error: message, gone: false, retryable: true }));
  }

  await inTenant(ctx, async (tx) => {
    for (const [i, row] of due.entries()) {
      const ticket = tickets[i] ?? { ok: false as const, error: "No answer for this notice.", gone: false, retryable: true };
      if (ticket.ok) {
        await tx.update(schema.pushDelivery).set({
          status: "sent", ticketId: ticket.id, sentAt: now, attempts: row.attempts + 1,
          error: null, updatedAt: now,
        }).where(eq(schema.pushDelivery.id, row.id));
        result.sent += 1;
        continue;
      }

      const attempts = row.attempts + 1;
      const giveUp = !ticket.retryable || attempts >= MAX_ATTEMPTS;
      await tx.update(schema.pushDelivery).set({
        status: giveUp ? "failed" : "queued", attempts, error: ticket.error.slice(0, 500), updatedAt: now,
      }).where(eq(schema.pushDelivery.id, row.id));
      if (giveUp) result.failed += 1;
      if (ticket.gone) result.forgotten += await forgetToken(tx, ctx, row.deviceId, ticket.error);
    }
  });
}

async function markSkipped(tx: Database, ids: string[], reason: string): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(schema.pushDelivery)
    .set({ status: "skipped", error: reason, updatedAt: new Date() })
    .where(inArray(schema.pushDelivery.id, ids));
}

/* -------------------------------------------------------------- receipts */

async function askReceipts(ctx: ServiceContext, provider: PushProvider, now: Date, result: PushPassResult) {
  const askBefore = new Date(now.getTime() - RECEIPT_AFTER_MINUTES * 60_000);
  const owed = await inTenant(ctx, async (tx) => tx.select({
    id: schema.pushDelivery.id,
    deviceId: schema.pushDelivery.deviceId,
    ticketId: schema.pushDelivery.ticketId,
  }).from(schema.pushDelivery)
    .where(and(
      eq(schema.pushDelivery.status, "sent"),
      isNotNull(schema.pushDelivery.ticketId),
      isNull(schema.pushDelivery.receiptCheckedAt),
      lt(schema.pushDelivery.sentAt, askBefore),
    ))
    .limit(1000));
  if (owed.length === 0) return;

  let receipts: Awaited<ReturnType<PushProvider["receipts"]>>;
  try {
    receipts = await provider.receipts(owed.map((row) => row.ticketId!));
  } catch {
    // Asked again on the next pass. A receipt is a courtesy, not the notice.
    return;
  }

  await inTenant(ctx, async (tx) => {
    for (const row of owed) {
      const receipt = receipts[row.ticketId!];
      if (receipt && !receipt.ok) {
        await tx.update(schema.pushDelivery).set({
          status: "failed", error: receipt.error.slice(0, 500), receiptCheckedAt: now, updatedAt: now,
        }).where(eq(schema.pushDelivery.id, row.id));
        result.failed += 1;
        if (receipt.gone) result.forgotten += await forgetToken(tx, ctx, row.deviceId, receipt.error);
        continue;
      }
      /**
       * Checked, whether or not a receipt came back. Expo keeps receipts for
       * a day, and a ticket it has forgotten would otherwise be asked about
       * on every pass for the rest of time.
       */
      await tx.update(schema.pushDelivery).set({ receiptCheckedAt: now, updatedAt: now })
        .where(eq(schema.pushDelivery.id, row.id));
    }
  });
}

/**
 * The app is gone from this phone, so stop telling it things. The device row
 * stays, because it is still the record of what that phone sent; only the
 * token goes, and the app registers a new one the next time it is signed in.
 */
async function forgetToken(tx: Database, ctx: ServiceContext, deviceId: string, reason: string): Promise<number> {
  const cleared = await tx.update(schema.device)
    .set({ pushToken: null, updatedAt: new Date() })
    .where(and(eq(schema.device.id, deviceId), isNotNull(schema.device.pushToken)))
    .returning({ id: schema.device.id });
  if (cleared.length === 0) return 0;
  await audit(tx, ctx, "device.push_forgotten", "device", deviceId, null, { reason });
  return 1;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
