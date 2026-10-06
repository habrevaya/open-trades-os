import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inventory as inv, time, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";
import { transferWithin, type UnitInput } from "./inventory";
import { restockWithin, type RestockView } from "./stock-units";

/**
 * TRUCK FILLS ON A CLOCK, PROPOSED BY THE WORKER AND CONFIRMED BY A PERSON
 *
 * A truck under its minimum has always had a suggestion on the truck stock
 * screen, which somebody had to open to see. Each night the worker now writes
 * the same suggestion down as a draft, one per truck, so the morning starts
 * with "the Ridgeline van needs these" instead of a screen nobody visited.
 *
 * NOTHING HERE MOVES STOCK BY ITSELF. A draft is a proposal; a person
 * confirms it, and the confirmation is the one transfer a hand typed move is,
 * all of a truck's lines in one transaction or none of them. A tracked part's
 * numbers are typed by the person confirming, because only somebody holding the
 * parts knows which serials are in their hand.
 *
 * AT MOST ONE OPEN DRAFT PER TRUCK, held by an index. The next night's pass
 * rewrites an open one to what the truck needs then, and withdraws it when the
 * truck needs nothing, so a draft nobody opened for a week is never a week old
 * ask. A draft somebody dismissed comes back the next night while the truck is
 * still under its minimum: dismissing says "not now", and the minimum still says
 * what the truck should carry.
 *
 * AT CONFIRMING, THE SHELF IS READ AGAIN. A draft is a night old by the time it
 * is used, and a technician may have taken the parts since. Each line moves the
 * least of what was drafted and what the truck needs now, from the warehouse
 * holding the most now, and a line the truck no longer needs is left alone and
 * said so. Moving the drafted figure without looking would overfill a truck or
 * ask for stock a warehouse gave away overnight.
 */

/** The overnight pass starts at one in the morning in the company's own calendar. */
const NIGHT_STARTS_MINUTE = 60;

/** What the worker acts as: it reads stock and writes drafts, and moves nothing. */
function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["inventory:read"],
    agentId: "truck-fills",
  };
}

export interface TruckFillLineView {
  id: string; itemId: string; itemName: string;
  quantity: string; onTruck: string;
  fromLocationId: string; fromLocationName: string;
  tracking: inv.TrackingMode | null;
  why: string;
}

export interface TruckFillView {
  id: string; truckId: string; truckName: string;
  proposedOn: string; refreshedAt: string;
  lines: TruckFillLineView[];
}

/* ------------------------------------------------------------- proposing */

export interface ProposeResult { created: number; refreshed: number; withdrawn: number }

/**
 * Write tonight's proposal inside a transaction: a draft per truck that is
 * under a minimum with something to move, an open draft rewritten, and an open
 * draft the truck has outgrown withdrawn. Moves nothing.
 */
export async function proposeWithin(
  tx: Database, ctx: ServiceContext, now: Date, by: string | null,
): Promise<ProposeResult> {
  const organizationId = ctx.actor.organizationId;
  const today = time.dateIn(now, await timezoneOf(tx, organizationId));
  const suggestions = (await restockWithin(tx))
    .filter((s) => s.fromLocationId !== null && inv.quantity(s.take) > inv.ZERO_QUANTITY);
  const byTruck = new Map<string, RestockView[]>();
  for (const s of suggestions) byTruck.set(s.truckId, [...(byTruck.get(s.truckId) ?? []), s]);

  const open = await tx.select().from(schema.truckFillDraft).where(eq(schema.truckFillDraft.status, "open"));
  const openOf = new Map(open.map((d) => [d.truckId, d]));
  const result: ProposeResult = { created: 0, refreshed: 0, withdrawn: 0 };

  for (const [truckId, lines] of byTruck) {
    let draft = openOf.get(truckId);
    let existing = draft !== undefined;
    if (!draft) {
      const [made] = await tx.insert(schema.truckFillDraft).values({
        organizationId, truckId, proposedOn: today, refreshedAt: now,
      }).onConflictDoNothing().returning();
      if (made) {
        draft = made;
        result.created += 1;
        await audit(tx, ctx, "truck_fill.proposed", "truck_fill_draft", made.id, null, {
          truckId, lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.take })),
        });
      } else {
        // Another pass wrote one a moment ago; rewrite that one rather than stack a second.
        [draft] = await tx.select().from(schema.truckFillDraft)
          .where(and(eq(schema.truckFillDraft.truckId, truckId), eq(schema.truckFillDraft.status, "open"))).limit(1);
        if (!draft) continue;
        existing = true;
      }
    }
    if (existing) {
      result.refreshed += 1;
      await tx.update(schema.truckFillDraft).set({ refreshedAt: now, updatedAt: now })
        .where(eq(schema.truckFillDraft.id, draft.id));
      await tx.delete(schema.truckFillLine).where(eq(schema.truckFillLine.draftId, draft.id));
    }
    await tx.insert(schema.truckFillLine).values(lines.map((l) => ({
      organizationId, draftId: draft!.id, itemId: l.itemId, fromLocationId: l.fromLocationId!,
      onTruck: l.onTruck, quantity: l.take, why: l.why,
    })));
  }

  for (const draft of open) {
    if (byTruck.has(draft.truckId)) continue;
    result.withdrawn += 1;
    await tx.update(schema.truckFillDraft).set({
      status: "withdrawn", decidedAt: now, decidedByName: by, updatedAt: now,
      outcome: "The truck no longer needs anything from a warehouse.",
    }).where(eq(schema.truckFillDraft.id, draft.id));
    await audit(tx, ctx, "truck_fill.withdrawn", "truck_fill_draft", draft.id, { status: "open" }, { status: "withdrawn" });
  }
  return result;
}

async function nameOf(tx: Database, ctx: ServiceContext): Promise<string | null> {
  const [self] = await tx.select({ name: schema.user.name, email: schema.user.email }).from(schema.user)
    .where(eq(schema.user.id, ctx.actor.userId)).limit(1);
  return self?.name ?? self?.email ?? null;
}

/** "Check the trucks now": the same proposal the night makes, for somebody who has just set a minimum. */
export async function proposeNow(ctx: ServiceContext): Promise<ProposeResult> {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const seen = await replayed<ProposeResult>(tx, ctx, "truck_fill.checked");
    if (seen) return seen;
    const result = await proposeWithin(tx, ctx, new Date(), await nameOf(tx, ctx));
    await remember(tx, ctx, "truck_fill.checked", null, result);
    return result;
  });
}

/* ------------------------------------------------------------ the night */

/** When this process last went round, so the worker's few second loop does not ask a date question every few seconds. */
let lastPass: number | null = null;

/** Mark that a company's night has been done, in its own calendar, inside the proposal's own transaction. */
async function markNight(tx: Database, organizationId: string, today: string): Promise<void> {
  await tx.update(schema.organization).set({
    settings: sql`${schema.organization.settings} || ${JSON.stringify({ truckFills: { lastRunOn: today } })}::jsonb`,
  }).where(eq(schema.organization.id, organizationId));
}

async function lastRunOn(tx: Database, organizationId: string): Promise<string | null> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const blob = ((row?.settings ?? {}) as Record<string, unknown>)["truckFills"];
  const day = blob && typeof blob === "object" ? (blob as Record<string, unknown>)["lastRunOn"] : undefined;
  return typeof day === "string" ? day : null;
}

export interface NightResult {
  organizationId: string; ran: boolean; proposed: ProposeResult | null; failed: string | null;
}

/**
 * The worker's pass: every company with a truck minimum, once per day of its
 * own calendar and not before one in the morning there. The mark that tonight
 * has been done is written in the same transaction as the drafts, so a pass
 * that dies halfway writes neither and the next one tries again.
 */
export async function nightlyPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<NightResult[]> {
  const now = options.now ?? new Date();
  const at = now.getTime();
  if (!options.force && lastPass !== null && at - lastPass < 60_000 && at >= lastPass) return [];
  lastPass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.truck_fill_organizations(${options.limit ?? 200})`,
  );
  const results: NightResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const organizationId = row.organization_id;
    const ctx: ServiceContext = { actor: workerActor(organizationId), db };
    try {
      const outcome = await inTenant(ctx, async (tx) => {
        const zone = await timezoneOf(tx, organizationId);
        const today = time.dateIn(now, zone);
        if (time.minutesInDay(now, zone) < NIGHT_STARTS_MINUTE) return null;
        if ((await lastRunOn(tx, organizationId)) === today) return null;
        const proposed = await proposeWithin(tx, ctx, now, null);
        await markNight(tx, organizationId, today);
        return proposed;
      });
      results.push({ organizationId, ran: outcome !== null, proposed: outcome, failed: null });
    } catch (error) {
      results.push({ organizationId, ran: false, proposed: null, failed: (error as Error).message });
    }
  }
  return results;
}

/* --------------------------------------------------------------- reading */

export async function listWithin(tx: Database): Promise<TruckFillView[]> {
  const drafts = await tx.select().from(schema.truckFillDraft)
    .where(eq(schema.truckFillDraft.status, "open")).orderBy(asc(schema.truckFillDraft.createdAt));
  if (drafts.length === 0) return [];
  const lines = await tx.select().from(schema.truckFillLine)
    .where(inArray(schema.truckFillLine.draftId, drafts.map((d) => d.id)));
  const places = await tx.select({ id: schema.location.id, name: schema.location.name }).from(schema.location);
  const placeOf = new Map(places.map((p) => [p.id, p.name]));
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const names = new Map<string, string>();
  if (itemIds.length > 0) {
    const versions = await tx.select({ itemId: schema.priceBookItemVersion.itemId, name: schema.priceBookItemVersion.name })
      .from(schema.priceBookItemVersion).where(inArray(schema.priceBookItemVersion.itemId, itemIds))
      .orderBy(asc(schema.priceBookItemVersion.version));
    for (const v of versions) names.set(v.itemId, v.name);
  }
  const tracked = await tx.select({ itemId: schema.stockTracking.itemId, mode: schema.stockTracking.mode }).from(schema.stockTracking);
  const modeOf = new Map(tracked.map((t) => [t.itemId, t.mode]));
  return drafts.map((d) => ({
    id: d.id, truckId: d.truckId, truckName: placeOf.get(d.truckId) ?? "",
    proposedOn: d.proposedOn, refreshedAt: d.refreshedAt.toISOString(),
    lines: lines.filter((l) => l.draftId === d.id)
      .map((l) => ({
        id: l.id, itemId: l.itemId, itemName: names.get(l.itemId) ?? "",
        quantity: inv.quantityLabel(inv.quantity(l.quantity)), onTruck: inv.quantityLabel(inv.quantity(l.onTruck)),
        fromLocationId: l.fromLocationId, fromLocationName: placeOf.get(l.fromLocationId) ?? "",
        tracking: modeOf.get(l.itemId) ?? null, why: l.why,
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName)),
  })).sort((a, b) => a.truckName.localeCompare(b.truckName));
}

export function list(ctx: ServiceContext): Promise<TruckFillView[]> {
  return guardedRead(ctx, "inventory:read", (tx) => listWithin(tx));
}

/* ------------------------------------------------------------- deciding */

export interface ConfirmInput {
  id: string;
  /** Numbers for a tracked part's line, by part. */
  units?: readonly { itemId: string; units: readonly UnitInput[] }[] | undefined;
}

export interface ConfirmAnswer {
  id: string; status: "confirmed" | "withdrawn";
  moved: { itemId: string; itemName: string; quantity: string; from: string }[];
  left: { itemId: string; itemName: string; reason: string }[];
}

const decided = (status: string) => status === "confirmed" ? "confirmed" : status === "dismissed" ? "dismissed" : "withdrawn";

async function lockOpen(tx: Database, id: string) {
  const [draft] = await tx.select().from(schema.truckFillDraft)
    .where(eq(schema.truckFillDraft.id, id)).limit(1).for("update");
  if (!draft) throw new NotFoundError("Truck fill");
  if (draft.status !== "open") {
    throw new ConflictError(`This fill was already ${decided(draft.status)}. Check the trucks again for a fresh one.`);
  }
  return draft;
}

/**
 * Move what a draft proposes, as the transfer a hand typed move is. All of its
 * lines or none: a line the warehouse cannot cover any more, or a tracked part
 * with no numbers, refuses the whole confirmation and leaves the draft open.
 */
export async function confirm(ctx: ServiceContext, input: ConfirmInput): Promise<ConfirmAnswer> {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const seen = await replayed<ConfirmAnswer>(tx, ctx, "truck_fill.confirmed");
    if (seen) return seen;
    const draft = await lockOpen(tx, input.id);
    const lines = await tx.select().from(schema.truckFillLine).where(eq(schema.truckFillLine.draftId, draft.id));
    const live = (await restockWithin(tx)).filter((s) => s.truckId === draft.truckId);

    const moved: ConfirmAnswer["moved"] = [];
    const left: ConfirmAnswer["left"] = [];
    for (const line of lines) {
      const now = live.find((s) => s.itemId === line.itemId);
      const itemName = now?.itemName ?? (await listNames(tx, [line.itemId])).get(line.itemId) ?? "";
      if (!now) {
        left.push({ itemId: line.itemId, itemName, reason: "The truck is no longer under its minimum for this part." });
        continue;
      }
      if (!now.fromLocationId || inv.quantity(now.take) <= inv.ZERO_QUANTITY) {
        left.push({ itemId: line.itemId, itemName, reason: "No warehouse has any to move now." });
        continue;
      }
      const drafted = inv.quantity(line.quantity);
      const live1 = inv.quantity(now.take);
      const quantity = live1 < drafted ? live1 : drafted;
      try {
        await transferWithin(tx, ctx, {
          itemId: line.itemId, fromLocationId: now.fromLocationId, toLocationId: draft.truckId,
          quantity: inv.quantityToString(quantity),
          units: input.units?.find((u) => u.itemId === line.itemId)?.units,
        });
      } catch (error) {
        if (error instanceof ConflictError) throw new ConflictError(`${itemName}: ${error.message}`);
        throw error;
      }
      moved.push({
        itemId: line.itemId, itemName, quantity: inv.quantityLabel(quantity), from: now.fromLocationName ?? "",
      });
    }

    const status = moved.length > 0 ? "confirmed" as const : "withdrawn" as const;
    const outcome = [
      ...moved.map((m) => `Moved ${m.quantity} ${m.itemName} from ${m.from}.`),
      ...left.map((l) => `${l.itemName}: ${l.reason}`),
    ].join(" ");
    const by = await nameOf(tx, ctx);
    await tx.update(schema.truckFillDraft).set({
      status, decidedAt: new Date(), decidedByName: by, outcome, updatedAt: new Date(),
    }).where(eq(schema.truckFillDraft.id, draft.id));
    await audit(tx, ctx, "truck_fill.confirmed", "truck_fill_draft", draft.id, { status: "open" }, { status, moved, left });
    const answer: ConfirmAnswer = { id: draft.id, status, moved, left };
    await remember(tx, ctx, "truck_fill.confirmed", draft.id, answer);
    return answer;
  });
}

async function listNames(tx: Database, itemIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const versions = await tx.select({ itemId: schema.priceBookItemVersion.itemId, name: schema.priceBookItemVersion.name })
    .from(schema.priceBookItemVersion).where(inArray(schema.priceBookItemVersion.itemId, itemIds))
    .orderBy(asc(schema.priceBookItemVersion.version));
  for (const v of versions) names.set(v.itemId, v.name);
  return names;
}

/** "Not now". Nothing moves, and the next night proposes again while the truck is still under its minimum. */
export async function dismiss(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; status: "dismissed" }> {
  return guardedWrite(ctx, "inventory:adjust", async (tx) => {
    const seen = await replayed<{ id: string; status: "dismissed" }>(tx, ctx, "truck_fill.dismissed");
    if (seen) return seen;
    const draft = await lockOpen(tx, input.id);
    await tx.update(schema.truckFillDraft).set({
      status: "dismissed", decidedAt: new Date(), decidedByName: await nameOf(tx, ctx), updatedAt: new Date(),
      outcome: "Left for now. Nothing was moved.",
    }).where(eq(schema.truckFillDraft.id, draft.id));
    await audit(tx, ctx, "truck_fill.dismissed", "truck_fill_draft", draft.id, { status: "open" }, { status: "dismissed" });
    const answer = { id: draft.id, status: "dismissed" as const };
    await remember(tx, ctx, "truck_fill.dismissed", draft.id, answer);
    return answer;
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listTruckFills: async (ctx: ServiceContext): Promise<{ fills: TruckFillView[] }> => ({ fills: await list(ctx) }),
  checkTruckFills: (ctx: ServiceContext): Promise<ProposeResult> => proposeNow(ctx),
  confirmTruckFill: (ctx: ServiceContext, input: ConfirmInput): Promise<ConfirmAnswer> => confirm(ctx, input),
  dismissTruckFill: (ctx: ServiceContext, input: { id: string }): Promise<{ id: string; status: "dismissed" }> => dismiss(ctx, input),
} as const;
