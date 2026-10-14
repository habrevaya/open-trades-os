import { and, desc, eq, gt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { voice, type telephony } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import * as phoneMenus from "./phone-menus";
import * as callQueues from "./call-queues";
import * as softphone from "./softphone";
import { BUSY_FOR_AT_MOST_HOURS } from "./queue-callbacks";
import { baseOf, carrierFor, DEFAULT_DEPS, voiceWebhookPath, type VoiceDeps } from "./voice-carrier";
import type { VoiceProvider } from "../voice/provider";

/**
 * HOLD AND PASSING A CALL ON, FROM THE BROWSER PHONE
 *
 * Somebody who picked a caller up in `/phone` can put them on hold with
 * music, take them back, or pass them to a colleague, a ring group or a
 * waiting line: straight away (cold), or after talking to the colleague first
 * (warm). This file is the office's side: who may, which call, and the
 * instruction to the carrier. What the caller hears at each step is in
 * `voice.ts` with the rest of a call.
 *
 * HOW, ON THE CARRIER. The caller's own leg of the call is moved by the
 * carrier's REST API to a new step, which ends the connection to the browser.
 * Hold is a carrier queue of one, named after the call, with music; taking
 * them back, or a colleague taking them, is dialling that queue. Passing on
 * cold sends the caller's leg where a menu option would send it. Passing on
 * warm holds the caller, rings the colleague from the browser, and on "Hand
 * over" moves the colleague's leg to the caller's queue, which also ends the
 * browser's call.
 *
 * WHO MAY. `call:place`, and only the person who has the caller now: the one
 * who picked them up, or the one they were last passed to. Nobody else can
 * take over somebody's call from here, whatever their role.
 *
 * WHICH CALLS. Calls that came in, and calls placed from the browser once
 * the person called has picked up. On a call that came in the caller's own
 * leg is the call, and that is what moves. On a call placed from the browser
 * the person called is on the dial's child leg, which names itself through
 * the status callback on the dial (`softphone-leg` in `voice.ts`); that leg
 * is what moves, and the browser's leg ends as it does on a call that came
 * in. From there the two are the same: a hold queue, a pass, a hand over.
 */

export type TransferRow = typeof schema.callTransfer.$inferSelect;
type CallRow = typeof schema.call.$inferSelect;
type Destination = telephony.RoutingDestination;

/** Open: the caller is on hold, or being passed on and not yet taken. */
export const OPEN_STATUSES = ["holding", "consulting", "handing_over"] as const;
const openSql = sql`${schema.callTransfer.status} in ('holding', 'consulting', 'handing_over')`;

/** The carrier's queue a held caller waits in: one per call, never shared. */
export const holdQueueName = (callId: string): string => `ots-hold-${callId}`.slice(0, 64);

/**
 * The longest a caller is left on hold before they go to voicemail, and the
 * office gets a task to call them. Fifteen minutes: past that, the person who
 * put them there has forgotten them.
 */
export const HOLD_MAX_SECONDS = 15 * 60;

export interface CurrentCall {
  id: string;
  /** Whether it came in, or was placed from the browser. */
  direction: "inbound" | "outbound";
  /** The other person's number: the caller's, or the number called on a call placed from the browser. */
  from: string;
  customerId: string | null;
  customerName: string | null;
  state: "talking" | "holding" | "consulting" | "handing_over";
  transferId: string | null;
  /** The colleague being talked to first, on a warm pass. */
  consultWith: string | null;
  /** Whether that colleague has picked up yet. */
  consultAnswered: boolean;
}

/** The other person on the call: the caller, or the person called from the browser. */
export const otherParty = (call: Pick<CallRow, "direction" | "fromE164" | "toE164">): string =>
  call.direction === "outbound" ? call.toE164 : call.fromE164;

/**
 * The call this person has: one that is not over, and that they picked up,
 * placed from the browser, or were passed, and have not since passed on.
 * A call placed from the browser counts once the person called has picked up
 * on a leg the carrier has named, because before that there is nobody to
 * hold. The newest, if there were somehow two.
 */
async function callOf(tx: Database, organizationId: string, userId: string, now: Date): Promise<CallRow | null> {
  const since = new Date(now.getTime() - BUSY_FOR_AT_MOST_HOURS * 3600_000);
  const [row] = await tx.select().from(schema.call).where(and(
    eq(schema.call.organizationId, organizationId),
    sql`(${schema.call.direction} = 'inbound' or (
      ${schema.call.direction} = 'outbound' and ${schema.call.calleeLegSid} is not null and ${schema.call.answeredAt} is not null
    ))`,
    sql`${schema.call.status} in ('ringing', 'in_progress')`,
    sql`${schema.call.endedAt} is null`,
    gt(schema.call.createdAt, since),
    /**
     * Once a call has been held or passed on, who has it is only ever what
     * was written when somebody took it; before that, whoever answered it
     * or placed it. The same reading as who a waiting line counts as busy.
     */
    sql`coalesce(${schema.call.handledByUserId}, case when exists (
      select 1 from public.call_transfer t where t.call_id = ${schema.call.id}
    ) then null else coalesce(${schema.call.answeredByUserId}, ${schema.call.placedByUserId}) end) = ${userId}::uuid`,
  )).orderBy(desc(schema.call.createdAt)).limit(1);
  return row ?? null;
}

async function openFor(tx: Database, callId: string): Promise<TransferRow | null> {
  const [row] = await tx.select().from(schema.callTransfer)
    .where(and(eq(schema.callTransfer.callId, callId), openSql)).limit(1);
  return row ?? null;
}

/** What `/phone` shows about the call this person has now, or null. */
export async function current(ctx: ServiceContext, now: Date = new Date()): Promise<CurrentCall | null> {
  return guardedRead(ctx, "call:place", async (tx) => {
    const call = await callOf(tx, ctx.actor.organizationId, ctx.actor.userId, now);
    if (!call) return null;
    const open = await openFor(tx, call.id);
    const [customer] = call.customerId
      ? await tx.select({ name: schema.customer.name }).from(schema.customer).where(eq(schema.customer.id, call.customerId)).limit(1)
      : [];
    const directory = open?.toUserId ? await phoneMenus.directoryFor(tx, ctx.actor.organizationId) : null;
    return {
      id: call.id,
      direction: call.direction === "outbound" ? "outbound" : "inbound",
      from: otherParty(call),
      customerId: call.customerId,
      customerName: customer?.name ?? null,
      state: open ? open.status as CurrentCall["state"] : "talking",
      transferId: open?.id ?? null,
      consultWith: open?.toUserId ? directory?.people.get(open.toUserId)?.name ?? "your colleague" : null,
      consultAnswered: Boolean(open?.consultLegSid),
    };
  });
}

export interface Targets {
  people: { userId: string; name: string; takingCalls: boolean }[];
  ringGroups: { id: string; name: string }[];
  queues: { id: string; name: string }[];
}

/**
 * Where a call can be passed: colleagues who can be rung (a number to ring
 * them on, or the browser phone on), and the ring groups and waiting lines by
 * name only. A narrow read for `call:place` holders, who mostly cannot read
 * the phone settings themselves.
 */
export async function targets(ctx: ServiceContext, now: Date = new Date()): Promise<Targets> {
  return guardedRead(ctx, "call:place", async (tx) => {
    const org = ctx.actor.organizationId;
    const directory = await phoneMenus.directoryFor(tx, org);
    const online = await softphone.onlineUsers(tx, org, now);
    const people = [...directory.people.entries()]
      .filter(([userId, person]) => userId !== ctx.actor.userId && (person.phone || online.has(userId)))
      .map(([userId, person]) => ({ userId, name: person.name, takingCalls: online.has(userId) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const byName = (map: ReadonlyMap<string, string>) => [...map.entries()]
      .map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    return { people, ringGroups: byName(directory.ringGroups), queues: byName(directory.queues) };
  });
}

/** The call, checked: theirs, still going, and on a leg the carrier can move. */
async function theirCall(tx: Database, ctx: ServiceContext, callId: string, now: Date): Promise<CallRow> {
  const call = await callOf(tx, ctx.actor.organizationId, ctx.actor.userId, now);
  if (!call || call.id !== callId) {
    const [any] = await tx.select({
      direction: schema.call.direction, placedBy: schema.call.placedByUserId, endedAt: schema.call.endedAt,
      answeredAt: schema.call.answeredAt,
      /** Named in full, as in `busyUsers`: unqualified, it would be the transfer's own id. */
      moved: sql<boolean>`exists (select 1 from public.call_transfer t where t.call_id = "call"."id")`,
    }).from(schema.call)
      .where(and(eq(schema.call.organizationId, ctx.actor.organizationId), eq(schema.call.id, callId))).limit(1);
    if (!any) throw new NotFoundError("Call");
    if (any.direction === "outbound" && any.placedBy === ctx.actor.userId && !any.endedAt && !any.answeredAt && !any.moved) {
      throw new ConflictError("They have not picked up yet. You can put them on hold or pass them on once they answer.");
    }
    throw new ConflictError("That call is not yours to move: only the person who has the caller now can put them on hold or pass them on.");
  }
  if (!call.providerCallId?.startsWith("twilio:")) {
    throw new ConflictError("That call did not come in through Twilio here, so it cannot be moved from the browser.");
  }
  return call;
}

/**
 * The leg that moves: the caller's own on a call that came in, the person
 * called's on a call placed from the browser (`callOf` only finds one of
 * those once that leg is named).
 */
const sidOf = (call: CallRow): string =>
  call.direction === "outbound" && call.calleeLegSid ? call.calleeLegSid : call.providerCallId!.slice("twilio:".length);

async function stepUrl(tx: Database, organizationId: string, deps: VoiceDeps, step: string, query: Record<string, string>) {
  const carrier = await carrierFor(tx, organizationId, deps);
  return {
    carrier,
    url: `${baseOf(deps)}${voiceWebhookPath(carrier.token, step)}?${new URLSearchParams(query)}`,
  };
}

/**
 * Put the caller on hold: their leg moves to a queue of its own with music,
 * and the browser's call ends. Pressing it twice holds once.
 */
export async function hold(ctx: ServiceContext, input: { id: string }, deps: VoiceDeps = DEFAULT_DEPS, now: Date = new Date()) {
  const planned = await guardedWrite(ctx, "call:place", async (tx) => {
    const call = await theirCall(tx, ctx, input.id, now);
    const open = await openFor(tx, call.id);
    if (open) return { transfer: open, redirect: null };
    const [made] = await tx.insert(schema.callTransfer).values({
      organizationId: ctx.actor.organizationId, callId: call.id, fromUserId: ctx.actor.userId,
      kind: "hold", status: "holding",
    }).onConflictDoNothing().returning();
    if (!made) {
      const again = await openFor(tx, call.id);
      if (again) return { transfer: again, redirect: null };
      throw new ConflictError("The call changed while you were putting it on hold. Try again.");
    }
    const { carrier, url } = await stepUrl(tx, ctx.actor.organizationId, deps, "hold", { c: call.id });
    await audit(tx, ctx, "call.held", "call", call.id, null, { transferId: made.id });
    return { transfer: made, redirect: { provider: carrier.provider, sid: sidOf(call), url } };
  });
  if (planned.redirect) await move(ctx, planned.transfer, planned.redirect, "put the caller on hold");
  return { id: planned.transfer.id, state: "holding" as const };
}

/**
 * Ask the carrier to move the caller's leg. A refusal undoes the row, so the
 * screen does not show a caller on hold who is in fact still connected.
 */
async function move(
  ctx: ServiceContext, transfer: TransferRow,
  redirect: { provider: VoiceProvider; sid: string; url: string },
  what: string,
): Promise<void> {
  const moved = await redirect.provider.redirectCall({ callSid: redirect.sid, url: redirect.url });
  if (moved.ok) return;
  await guardedWrite(ctx, "call:place", async (tx) => {
    await tx.update(schema.callTransfer).set({ status: "failed", endedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.callTransfer.id, transfer.id));
    /** A cold pass let go of the caller when it was asked for; they are still with this person. */
    if (transfer.kind === "cold") {
      await tx.update(schema.call).set({ handledByUserId: ctx.actor.userId, updatedAt: new Date() })
        .where(eq(schema.call.id, transfer.callId));
    }
  });
  throw new ConflictError(`Twilio would not ${what}: ${moved.message.replace(/\.$/, "")}. The caller is still with you.`);
}

export interface TransferInput {
  id: string;
  to: Destination;
  /** Talk to the colleague first. Only to a person. */
  warm?: boolean | undefined;
}

/**
 * Pass the caller on.
 *
 * Cold: the caller's leg goes where a menu option would send it, at once; to
 * a colleague it rings their browser when they are taking calls there, and
 * their phone otherwise. Warm, to a colleague only: the caller is held, and
 * the answer names the address the browser rings to talk to the colleague
 * first (`transfer:{id}`); "Hand over" then joins the two.
 */
export async function transfer(ctx: ServiceContext, input: TransferInput, deps: VoiceDeps = DEFAULT_DEPS, now: Date = new Date()) {
  const planned = await guardedWrite(ctx, "call:place", async (tx) => {
    const again = await replayed<{ id: string; state: string; consult: string | null }>(tx, ctx, "call_transfer");
    if (again) return { answer: again, redirect: null, transfer: null };
    const org = ctx.actor.organizationId;
    const call = await theirCall(tx, ctx, input.id, now);
    const to = input.to;
    const directory = await phoneMenus.directoryFor(tx, org);
    const online = await softphone.onlineUsers(tx, org, now);
    if (to.kind === "person") {
      const person = directory.people.get(to.userId);
      if (!person) throw new ConflictError("That person is no longer at the company.");
      if (to.userId === ctx.actor.userId) throw new ConflictError("The caller is already with you.");
      if (!person.phone && !online.has(to.userId)) {
        throw new ConflictError(`${person.name} has no number to ring and is not taking calls in the browser.`);
      }
    } else if (to.kind === "ring_group") {
      if (!(await phoneMenus.loadRingGroup(tx, org, to.id))) throw new ConflictError("That ring group no longer exists.");
    } else if (to.kind === "queue") {
      if (!(await callQueues.loadQueue(tx, org, to.id))) throw new ConflictError("That waiting line no longer exists.");
    } else {
      throw new ConflictError("A call can be passed to a colleague, a ring group or a waiting line.");
    }
    if (input.warm && to.kind !== "person") {
      throw new ConflictError("Talking to them first works with one colleague. A ring group or a waiting line is passed on straight away.");
    }
    const open = await openFor(tx, call.id);
    const describe = voice.describeIn(directory)(to);

    if (input.warm) {
      /** Held already: the same hold becomes the pass. Otherwise the caller is held first. */
      const [row] = open
        ? await tx.update(schema.callTransfer).set({
            kind: "warm", status: "consulting", toDestination: to as never, toUserId: to.kind === "person" ? to.userId : null,
            consultLegSid: null, updatedAt: now,
          }).where(eq(schema.callTransfer.id, open.id)).returning()
        : await tx.insert(schema.callTransfer).values({
            organizationId: org, callId: call.id, fromUserId: ctx.actor.userId, kind: "warm", status: "consulting",
            toDestination: to as never, toUserId: to.kind === "person" ? to.userId : null,
          }).returning();
      const transfer = row!;
      const answer = { id: transfer.id, state: "consulting", consult: `transfer:${transfer.id}` };
      await audit(tx, ctx, "call.transfer_started", "call", call.id, null, { transferId: transfer.id, to: describe, warm: true });
      await remember(tx, ctx, "call_transfer", transfer.id, answer);
      if (open) return { answer, redirect: null, transfer };
      const { carrier, url } = await stepUrl(tx, org, deps, "hold", { c: call.id });
      return { answer, transfer, redirect: { provider: carrier.provider, sid: sidOf(call), url } };
    }

    if (open) {
      await tx.update(schema.callTransfer).set({ status: "replaced", endedAt: now, updatedAt: now })
        .where(eq(schema.callTransfer.id, open.id));
    }
    const [transfer] = await tx.insert(schema.callTransfer).values({
      organizationId: org, callId: call.id, fromUserId: ctx.actor.userId, kind: "cold", status: "sent",
      toDestination: to as never, toUserId: to.kind === "person" ? to.userId : null, endedAt: now,
    }).returning();
    await tx.update(schema.call).set({ handledByUserId: null, updatedAt: now }).where(eq(schema.call.id, call.id));
    const { carrier, url } = await stepUrl(tx, org, deps, "transfer", { t: transfer!.id });
    const answer = { id: transfer!.id, state: "sent", consult: null };
    await audit(tx, ctx, "call.transferred", "call", call.id, null, { transferId: transfer!.id, to: describe, warm: false });
    await remember(tx, ctx, "call_transfer", transfer!.id, answer);
    return { answer, transfer: transfer!, redirect: { provider: carrier.provider, sid: sidOf(call), url } };
  });
  if (planned.redirect && planned.transfer) {
    await move(ctx, planned.transfer, planned.redirect, planned.answer.state === "sent" ? "pass the caller on" : "put the caller on hold");
  }
  return planned.answer as { id: string; state: "sent" | "consulting"; consult: string | null };
}

async function mine(tx: Database, ctx: ServiceContext, id: string): Promise<TransferRow> {
  const [row] = await tx.select().from(schema.callTransfer)
    .where(and(eq(schema.callTransfer.organizationId, ctx.actor.organizationId), eq(schema.callTransfer.id, id))).limit(1);
  if (!row) throw new NotFoundError("Call transfer");
  if (row.fromUserId !== ctx.actor.userId) throw new ConflictError("Only the person passing the call on can finish or cancel it.");
  return row;
}

/**
 * Hand the caller to the colleague being talked to: the colleague's leg moves
 * to the caller's queue, and the browser's call ends. Only once the colleague
 * has picked up.
 */
export async function complete(ctx: ServiceContext, input: { id: string }, deps: VoiceDeps = DEFAULT_DEPS) {
  const planned = await guardedWrite(ctx, "call:place", async (tx) => {
    const row = await mine(tx, ctx, input.id);
    if (row.status === "handing_over" || row.status === "handed_over") return { row, redirect: null };
    if (row.status !== "consulting") throw new ConflictError("That call is no longer waiting to be handed over.");
    if (!row.consultLegSid) throw new ConflictError("They have not picked up yet. Hand over once you have spoken to them.");
    const [after] = await tx.update(schema.callTransfer).set({ status: "handing_over", updatedAt: new Date() })
      .where(and(eq(schema.callTransfer.id, row.id), eq(schema.callTransfer.status, "consulting"))).returning();
    if (!after) throw new ConflictError("The call changed while you were handing it over. Try again.");
    const { carrier, url } = await stepUrl(tx, ctx.actor.organizationId, deps, "transfer-bridge", { t: row.id });
    await audit(tx, ctx, "call.transfer_completed", "call", row.callId, null, { transferId: row.id });
    return { row: after, redirect: { provider: carrier.provider, sid: row.consultLegSid, url } };
  });
  if (planned.redirect) {
    const moved = await planned.redirect.provider.redirectCall({ callSid: planned.redirect.sid, url: planned.redirect.url });
    if (!moved.ok) {
      await guardedWrite(ctx, "call:place", (tx) => tx.update(schema.callTransfer)
        .set({ status: "consulting", updatedAt: new Date() }).where(eq(schema.callTransfer.id, planned.row.id)));
      throw new ConflictError(`Twilio would not hand the caller over: ${moved.message.replace(/\.$/, "")}. The caller is still on hold.`);
    }
  }
  return { id: planned.row.id, state: "handing_over" as const };
}

/**
 * Not passing them on after all: the colleague's call is ended, and the
 * caller stays on hold for the browser to take back.
 */
export async function cancel(ctx: ServiceContext, input: { id: string }, deps: VoiceDeps = DEFAULT_DEPS) {
  const planned = await guardedWrite(ctx, "call:place", async (tx) => {
    const row = await mine(tx, ctx, input.id);
    if (row.status === "holding") return { row, end: null };
    if (row.status !== "consulting") throw new ConflictError("That call is no longer waiting to be handed over.");
    const [after] = await tx.update(schema.callTransfer).set({
      kind: "hold", status: "holding", toDestination: null, toUserId: null, consultLegSid: null, updatedAt: new Date(),
    }).where(eq(schema.callTransfer.id, row.id)).returning();
    await audit(tx, ctx, "call.transfer_cancelled", "call", row.callId, null, { transferId: row.id });
    const carrier = row.consultLegSid ? await carrierFor(tx, ctx.actor.organizationId, deps) : null;
    return { row: after!, end: carrier && row.consultLegSid ? { provider: carrier.provider, sid: row.consultLegSid } : null };
  });
  if (planned.end) await planned.end.provider.endCall(planned.end.sid);
  return { id: planned.row.id, state: "holding" as const };
}

export const handlers = {
  getSoftphoneCall: async (ctx: ServiceContext) => ({ call: await current(ctx) }),
  listTransferTargets: (ctx: ServiceContext) => targets(ctx),
  holdCall: (ctx: ServiceContext, input: { id: string }) => hold(ctx, input),
  transferCall: (ctx: ServiceContext, input: TransferInput) => transfer(ctx, input),
  completeCallTransfer: (ctx: ServiceContext, input: { id: string }) => complete(ctx, input),
  cancelCallTransfer: (ctx: ServiceContext, input: { id: string }) => cancel(ctx, input),
} as const;
