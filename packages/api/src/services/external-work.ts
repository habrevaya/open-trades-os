import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { externalWork as ew } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";

/**
 * WORKING SOMEBODY ELSE'S QUEUE
 *
 * `external_work_order` was written in the first migrations and reached by
 * nothing. It is the last table in this schema that was described in detail and
 * never touched, and its own comment says both what it is for and what the hard
 * part is: the external system is the system of record, and a local edit that
 * conflicts loses or escalates.
 *
 * In five segments a contractor is a vendor in somebody else's software. A
 * facilities network dispatches to them, a warranty administrator assigns them a
 * claim, a manufacturer sends a dealer a warranty job. The order arrives in that
 * portal, it is accepted or declined there, the status is pushed back at every
 * step, and the portal's view decides whether the invoice is paid.
 *
 * WHY THIS IS NOT A FEW COLUMNS ON `job`, which is the obvious cheaper thing:
 *
 *   An order can be REJECTED, and a rejected order must never become a job. Half
 *   of what arrives is declined, and modelling it as a job with a status would
 *   put work nobody is doing on the board and in the margin report.
 *
 *   The ids are theirs. `(source_system, external_id)` is the natural key and it
 *   is what an inbound sync is idempotent on. A job number is ours.
 *
 *   THE STATUS WE OWE THEM IS NOT THE STATUS OF OUR WORK. `pending_push` is a
 *   queue, and a status changed and never pushed is a contractor whose scorecard
 *   says they never responded. That queue has no home on a job row.
 *
 * WHAT THIS FILE DOES NOT DO: talk to any of those networks. There is no Corrigo
 * adapter and no ServiceChannel adapter, because each is a vendor approval and a
 * contract rather than code, and writing one against their documentation without
 * a sandbox produces something that looks finished and has never run. What is
 * here is the half that does not depend on them: the mirror, the state machine,
 * the conflict rule and the push queue, all reachable through the API so an
 * integration or a middleware can drive it today.
 */

/* ------------------------------------------------------------ the mirror */

export interface ReceiveInput {
  sourceSystem: string;
  externalId: string;
  externalNumber?: string | null | undefined;
  /** Their status string, verbatim. Never mapped on the way in. */
  externalStatus?: string | null | undefined;
  /** Their whole message, kept. The one field that survives their schema changing. */
  payload?: Record<string, unknown> | undefined;
  /** Overrides for the network's defaults, when the caller knows better. */
  acceptanceIsIrreversible?: boolean | undefined;
  acceptsViaInvoiceOnly?: boolean | undefined;
}

/**
 * Mirror an inbound work order, or update the one already here.
 *
 * IDEMPOTENT ON THEIR OWN KEY, which the unique index on
 * `(organization, source_system, external_id)` holds. A facilities network that
 * resends an order is the ordinary case rather than an error: they retry, they
 * replay a queue after an outage, and they send the same order to several
 * vendors and tell the losers later.
 *
 * ARRIVES AS `offered` AND NOTHING ELSE. A sync that could create an order
 * already accepted would let a middleware bug accept work on a contractor's
 * behalf, and the first anybody would know is a missed appointment.
 */
export function receive(ctx: ServiceContext, input: ReceiveInput) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const sourceSystem = input.sourceSystem.trim().toLowerCase();
    const externalId = input.externalId.trim();
    if (sourceSystem === "" || externalId === "") {
      throw new ConflictError(
        "An external work order needs the network it came from and their own id for it. Without "
        + "both there is nothing to be idempotent on, and a retry becomes a second order.",
      );
    }

    const defaults = ew.defaultsFor(sourceSystem);
    const existing = await findWithin(tx, ctx, sourceSystem, externalId);

    if (existing) {
      /**
       * A REPEAT DOES NOT RESET THE STATE. Their status and payload are updated
       * because they are theirs, and `state` is left alone: an order we accepted
       * and started does not go back to offered because their queue replayed.
       * The state only moves through `applyRemote`, which is the call that says
       * the client's system has decided something.
       */
      const [updated] = await tx.update(schema.externalWorkOrder).set({
        externalNumber: input.externalNumber?.trim() ?? existing.externalNumber,
        externalStatus: input.externalStatus?.trim() ?? existing.externalStatus,
        payload: input.payload ?? existing.payload,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.externalWorkOrder.id, existing.id)).returning();

      await audit(tx, ctx, "external_work_order.resync", "external_work_order", existing.id,
        existing, updated);
      return view(updated!);
    }

    const [row] = await tx.insert(schema.externalWorkOrder).values({
      organizationId: ctx.actor.organizationId,
      sourceSystem,
      externalId,
      externalNumber: input.externalNumber?.trim() ?? null,
      state: "offered",
      externalStatus: input.externalStatus?.trim() ?? null,
      externalIsSystemOfRecord: true,
      acceptanceIsIrreversible:
        input.acceptanceIsIrreversible ?? defaults.acceptanceIsIrreversible,
      acceptsViaInvoiceOnly: input.acceptsViaInvoiceOnly ?? defaults.acceptsViaInvoiceOnly,
      payload: input.payload ?? {},
      lastSyncedAt: new Date(),
      pendingPush: false,
    }).returning();

    await audit(tx, ctx, "external_work_order.receive", "external_work_order", row!.id, null, row);
    return view(row!);
  });
}

/**
 * NO `deleted_at` FILTER ON A MIRRORED ORDER, HERE OR ANYWHERE BELOW.
 *
 * Nothing in this service removes one, softly or otherwise, so a filter on that
 * column would be a check that cannot fail. It is also the right answer on its
 * own terms: this table is the record of what a client's system sent us,
 * including what we declined, and the declined ones are half of it. A facilities
 * network's scorecard is partly a response-rate figure, and a contractor
 * disputing it needs the orders they said no to and when.
 */
async function findWithin(
  tx: Database, ctx: ServiceContext, sourceSystem: string, externalId: string,
) {
  const [row] = await tx.select().from(schema.externalWorkOrder)
    .where(and(
      eq(schema.externalWorkOrder.organizationId, ctx.actor.organizationId),
      eq(schema.externalWorkOrder.sourceSystem, sourceSystem),
      eq(schema.externalWorkOrder.externalId, externalId),
    ))
    .limit(1);
  return row;
}

async function loadWithin(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.externalWorkOrder)
    .where(and(
      eq(schema.externalWorkOrder.organizationId, ctx.actor.organizationId),
      eq(schema.externalWorkOrder.id, id),
    ))
    .limit(1);
  if (!row) throw new NotFoundError("External work order");
  return row;
}

function view(row: typeof schema.externalWorkOrder.$inferSelect) {
  const state = ew.isState(row.state) ? row.state : "offered";
  const profile = ew.sourceProfile(row.sourceSystem);
  return {
    id: row.id,
    sourceSystem: row.sourceSystem,
    sourceLabel: profile?.label ?? row.sourceSystem,
    externalId: row.externalId,
    externalNumber: row.externalNumber,
    state,
    /** Their word, verbatim. The only thing that survives their renaming a status. */
    externalStatus: row.externalStatus,
    externalIsSystemOfRecord: row.externalIsSystemOfRecord,
    acceptanceIsIrreversible: row.acceptanceIsIrreversible,
    acceptsViaInvoiceOnly: row.acceptsViaInvoiceOnly,
    jobId: row.jobId,
    payload: row.payload,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    /** True while the client's system has not been told what we last did. */
    pendingPush: row.pendingPush,
    lastPushError: row.lastPushError,
    /** What we may do next, worked out rather than left to a screen to guess. */
    weMayMoveTo: ew.STATES.filter((to) => ew.checkMove(state, to, flagsOf(row)).ok),
  };
}

const flagsOf = (row: typeof schema.externalWorkOrder.$inferSelect): ew.Flags => ({
  acceptanceIsIrreversible: row.acceptanceIsIrreversible,
  acceptsViaInvoiceOnly: row.acceptsViaInvoiceOnly,
});

/* ------------------------------------------------------------ our decisions */

export interface MoveInput {
  id: string;
  to: string;
  /** The job this order is being done as, when accepting. */
  jobId?: string | null | undefined;
  note?: string | undefined;
}

/**
 * Move an order from our side, and owe the client an update.
 *
 * Every move that is not `offered` sets `pending_push`, which is the queue the
 * index on `(organization, pending_push)` exists for and which nothing read
 * before this file. A status changed and never pushed is a contractor whose
 * scorecard says they never responded, and the scorecard decides the next
 * dispatch.
 */
export function move(ctx: ServiceContext, input: MoveInput) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const row = await loadWithin(tx, ctx, input.id);
    const from = ew.isState(row.state) ? row.state : "offered";
    if (!ew.isState(input.to)) {
      throw new ConflictError(
        `"${input.to}" is not a state a work order can be in. One of: ${ew.STATES.join(", ")}.`,
      );
    }

    const verdict = ew.checkMove(from, input.to, flagsOf(row));
    if (!verdict.ok) throw new ConflictError(verdict.refusal.message);

    if (input.jobId) {
      /**
       * A REJECTED ORDER MUST NEVER CARRY A JOB. Half of what arrives on a
       * facilities network is declined, and a job attached to a declined order
       * is work nobody is doing sitting on the board and in the margin report.
       */
      if (input.to === "rejected") {
        throw new ConflictError(
          "A declined work order does not get a job. Nobody is going to do it, and a job on the "
          + "board that nobody is doing is a dispatcher's problem and a margin report's.",
        );
      }
      await assertJob(tx, ctx, input.jobId);
    }

    const [updated] = await tx.update(schema.externalWorkOrder).set({
      state: input.to,
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      pendingPush: ew.owesPush(input.to),
      /**
       * Cleared on every move of ours. A failure recorded against the status we
       * pushed last week says nothing about the one we are pushing now, and
       * leaving it would make a stale error look like a current one.
       */
      lastPushError: null,
      updatedAt: new Date(),
    }).where(eq(schema.externalWorkOrder.id, input.id)).returning();

    await audit(tx, ctx, `external_work_order.${input.to}`, "external_work_order", input.id,
      row, { ...updated, note: input.note ?? null });
    return view(updated!);
  });
}

async function assertJob(tx: Database, ctx: ServiceContext, jobId: string) {
  const [found] = await tx.select({ id: schema.job.id }).from(schema.job)
    .where(and(
      eq(schema.job.organizationId, ctx.actor.organizationId),
      eq(schema.job.id, jobId),
      isNull(schema.job.deletedAt),
    ))
    .limit(1);
  if (!found) throw new NotFoundError("Job");
}

/**
 * Take an order on a network that has no accept call.
 *
 * A manufacturer's dealer network takes a warranty job by receiving the claim,
 * not by accepting a dispatch. `move(..., "accepted")` is refused on those
 * networks, and this is the call that does what accepting means there: it
 * records that the invoice is what we sent, and moves straight to `invoiced`.
 *
 * It exists as its own operation rather than as a flag on `move` because the two
 * are different acts. One says "we will do this"; the other says "we have done
 * it and here is the bill", and a network that only accepts the second one is
 * not a network where a dispatcher should be clicking Accept.
 */
export function acceptViaInvoice(ctx: ServiceContext, input: { id: string; invoiceId: string }) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const row = await loadWithin(tx, ctx, input.id);
    if (!row.acceptsViaInvoiceOnly) {
      throw new ConflictError(
        "This network has an accept call, so accepting is how an order is taken. Submitting an "
        + "invoice for work the client has not been told we accepted is how a payment gets held.",
      );
    }

    const [invoice] = await tx.select({ id: schema.invoice.id }).from(schema.invoice)
      .where(and(
        eq(schema.invoice.organizationId, ctx.actor.organizationId),
        eq(schema.invoice.id, input.invoiceId),
        isNull(schema.invoice.deletedAt),
      ))
      .limit(1);
    if (!invoice) throw new NotFoundError("Invoice");

    const [updated] = await tx.update(schema.externalWorkOrder).set({
      state: "invoiced",
      pendingPush: true,
      lastPushError: null,
      payload: { ...row.payload, invoicedWith: input.invoiceId },
      updatedAt: new Date(),
    }).where(eq(schema.externalWorkOrder.id, input.id)).returning();

    await audit(tx, ctx, "external_work_order.accept_via_invoice", "external_work_order",
      input.id, row, updated);
    return view(updated!);
  });
}

/* ------------------------------------------------------- their decisions */

export interface RemoteInput {
  id: string;
  /** Their state, mapped by whatever is syncing. */
  state: string;
  /** Their status string, verbatim. */
  externalStatus?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface RemoteResult {
  order: ReturnType<typeof view>;
  /** Null when nothing of ours was overtaken. */
  conflict: { lost: string; note: string } | null;
}

/**
 * Record what the client's system says, which wins.
 *
 * THE INVARIANT THE TABLE WAS WRITTEN FOR. Their portal is the system of record
 * and this is the call that honours it, including when it contradicts us.
 *
 * A CONTRADICTION IS NOT A MERGE AND IS NOT SILENT. When we were still holding a
 * change they have not seen, theirs replaces it and ours is written down: the
 * audit line carries both states and a sentence saying what was lost. "We marked
 * it complete on the 4th and their portal says it was still open on the 11th" is
 * a dispute somebody has to be able to reconstruct, and it is the dispute that
 * decides who pays for the trip.
 *
 * NO STATE VALIDATION ON THE WAY IN, deliberately. Their portal has states we
 * have never seen, renames them between releases and skips ours. Refusing an
 * inbound update because its status was unfamiliar is the one failure this table
 * exists to prevent, so anything that maps to one of our nine is taken, and
 * anything that does not is kept verbatim in `external_status` with our state
 * left where it was.
 */
export function applyRemote(ctx: ServiceContext, input: RemoteInput) {
  return guardedWrite(ctx, "contract:write", async (tx): Promise<RemoteResult> => {
    const row = await loadWithin(tx, ctx, input.id);
    const ours = ew.isState(row.state) ? row.state : "offered";
    const status = input.externalStatus?.trim() ?? null;

    if (!ew.isState(input.state)) {
      /**
       * A status we cannot place is RECORDED rather than refused. Their word goes
       * in verbatim, our state stays where it was, and the sync keeps working:
       * the alternative is a vendor whose integration stops on the day the client
       * renames "Dispatched" to "Assigned".
       */
      const [updated] = await tx.update(schema.externalWorkOrder).set({
        externalStatus: status ?? input.state,
        payload: input.payload ?? row.payload,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.externalWorkOrder.id, input.id)).returning();

      await audit(tx, ctx, "external_work_order.unmapped_status", "external_work_order", input.id,
        row, { externalStatus: status ?? input.state });
      return { order: view(updated!), conflict: null };
    }

    const resolution = ew.reconcile({
      ours, theirs: input.state, pendingPush: row.pendingPush,
    });

    const conflict = resolution.outcome === "ours_lost"
      ? {
        lost: resolution.lost,
        note: ew.conflictNote({
          lost: resolution.lost, theirs: resolution.state, theirStatus: status,
        }),
      }
      : null;

    const [updated] = await tx.update(schema.externalWorkOrder).set({
      state: resolution.state,
      externalStatus: status ?? row.externalStatus,
      payload: input.payload ?? row.payload,
      lastSyncedAt: new Date(),
      /**
       * Cleared either way, and that is the honest answer in both cases. If they
       * agreed with us, the conversation is up to date. If they overtook us, the
       * thing we were going to say is no longer true, and pushing it would be
       * arguing with the system of record.
       */
      pendingPush: false,
      updatedAt: new Date(),
    }).where(eq(schema.externalWorkOrder.id, input.id)).returning();

    await audit(
      tx, ctx,
      conflict ? "external_work_order.conflict" : "external_work_order.remote",
      "external_work_order", input.id, row,
      { ...updated, ...(conflict ? { lost: conflict.lost, conflict: conflict.note } : {}) },
    );

    return { order: view(updated!), conflict };
  });
}

/* ------------------------------------------------------------- the queue */

/**
 * What the client's systems have not been told.
 *
 * The reader the `(organization, pending_push)` index was built for and which
 * nothing used. A worker drains this; until there is one, an integration polls
 * it, which is why it is an ordinary route rather than something internal.
 */
export function pending(ctx: ServiceContext, input: { limit: number }) {
  return guardedRead(ctx, "contract:read", async (tx) => {
    const rows = await tx.select().from(schema.externalWorkOrder)
      .where(and(
        eq(schema.externalWorkOrder.organizationId, ctx.actor.organizationId),
        eq(schema.externalWorkOrder.pendingPush, true),
      ))
      .orderBy(schema.externalWorkOrder.updatedAt)
      .limit(input.limit);
    return { data: rows.map(view) };
  });
}

/**
 * The client's system has been told.
 *
 * Separate from `move` because they are different events with different failure
 * modes: one is a dispatcher deciding something, the other is a network
 * accepting it. Collapsing them would mean a push that failed left the order
 * looking as though nobody had decided anything.
 */
export function pushed(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const row = await loadWithin(tx, ctx, input.id);
    const [updated] = await tx.update(schema.externalWorkOrder).set({
      pendingPush: false,
      lastPushError: null,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.externalWorkOrder.id, input.id)).returning();
    await audit(tx, ctx, "external_work_order.pushed", "external_work_order", input.id, row,
      updated);
    return view(updated!);
  });
}

/**
 * The push failed, and the order STAYS in the queue.
 *
 * `pending_push` is deliberately not cleared. A network that was down has to be
 * told when it comes back, and an error that quietly removed the order from the
 * queue would turn a retryable outage into a status the client never hears,
 * which costs the next dispatch rather than this one.
 */
export function pushFailed(ctx: ServiceContext, input: { id: string; error: string }) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const row = await loadWithin(tx, ctx, input.id);
    const message = input.error.trim();
    if (message === "") {
      throw new ConflictError(
        "Record what went wrong. A failed push with no reason is one nobody can act on, and the "
        + "order sits in the queue retrying the same thing.",
      );
    }
    const [updated] = await tx.update(schema.externalWorkOrder).set({
      lastPushError: message.slice(0, 2000),
      updatedAt: new Date(),
    }).where(eq(schema.externalWorkOrder.id, input.id)).returning();
    await audit(tx, ctx, "external_work_order.push_failed", "external_work_order", input.id,
      row, { error: message });
    return view(updated!);
  });
}

/* -------------------------------------------------------------- the reads */

export function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "contract:read", async (tx) => view(await loadWithin(tx, ctx, input.id)));
}

export function list(ctx: ServiceContext, input: {
  state?: string | undefined;
  sourceSystem?: string | undefined;
  pendingPush?: boolean | undefined;
  limit: number;
}) {
  return guardedRead(ctx, "contract:read", async (tx) => {
    if (input.state !== undefined && !ew.isState(input.state)) {
      throw new ConflictError(
        `"${input.state}" is not a state a work order can be in. One of: ${ew.STATES.join(", ")}.`,
      );
    }
    const rows = await tx.select().from(schema.externalWorkOrder)
      .where(and(
        eq(schema.externalWorkOrder.organizationId, ctx.actor.organizationId),
        ...(input.state ? [eq(schema.externalWorkOrder.state, input.state)] : []),
        ...(input.sourceSystem
          ? [eq(schema.externalWorkOrder.sourceSystem, input.sourceSystem.trim().toLowerCase())]
          : []),
        ...(input.pendingPush !== undefined
          ? [eq(schema.externalWorkOrder.pendingPush, input.pendingPush)]
          : []),
      ))
      .orderBy(desc(schema.externalWorkOrder.createdAt))
      .limit(input.limit);
    return { data: rows.map(view) };
  });
}

/**
 * The networks this is built for, and what to know about each.
 *
 * A read with no rows behind it, which is unusual here and is the point: a
 * contractor setting this up needs to know that a warranty administrator's
 * acceptance is final before they click it, not after. The defaults a network
 * gets are the same ones `receive` applies.
 */
export function sources(ctx: ServiceContext, _input: Record<string, never>) {
  void _input;
  return guardedRead(ctx, "contract:read", async (tx) => {
    /**
     * Which of them this company actually sees work from, counted, so the list
     * is ordered by what matters to them rather than alphabetically.
     */
    const counts = await tx.execute<{ source_system: string; n: string }>(sql`
      select source_system, count(*)::text as n
      from public.external_work_order
      group by source_system
    `);
    const seen = new Map(counts.map((row) => [row.source_system, Number(row.n)]));

    return {
      data: ew.SOURCES.map((source) => ({
        key: source.key,
        label: source.label,
        note: source.note,
        acceptanceIsIrreversible: source.defaults.acceptanceIsIrreversible,
        acceptsViaInvoiceOnly: source.defaults.acceptsViaInvoiceOnly,
        orders: seen.get(source.key) ?? 0,
      })),
      /**
       * Networks this company works that have no profile here. The list above is
       * documentation rather than a gate, and a regional warranty administrator
       * nobody here has heard of is as real as Corrigo.
       */
      unprofiled: [...seen.keys()]
        .filter((key) => !ew.sourceProfile(key))
        .map((key) => ({ key, orders: seen.get(key) ?? 0 })),
      cautiousDefaults: ew.CAUTIOUS,
    };
  });
}

export const handlers = {
  receiveExternalWorkOrder: (ctx: ServiceContext, input: ReceiveInput) => receive(ctx, input),
  moveExternalWorkOrder: (ctx: ServiceContext, input: MoveInput) => move(ctx, input),
  acceptExternalWorkOrderViaInvoice: (ctx: ServiceContext, input: {
    id: string; invoiceId: string;
  }) => acceptViaInvoice(ctx, input),
  applyExternalWorkOrderRemote: (ctx: ServiceContext, input: RemoteInput) =>
    applyRemote(ctx, input),
  listPendingExternalPushes: (ctx: ServiceContext, input: { limit: number }) =>
    pending(ctx, input),
  markExternalWorkOrderPushed: (ctx: ServiceContext, input: { id: string }) => pushed(ctx, input),
  markExternalWorkOrderPushFailed: (ctx: ServiceContext, input: { id: string; error: string }) =>
    pushFailed(ctx, input),
  getExternalWorkOrder: get,
  listExternalWorkOrders: list,
  listExternalWorkSources: sources,
} as const;
