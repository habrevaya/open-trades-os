import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { routing } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import * as once from "./once";

/**
 * EACH TRUCK ITS OWN KIND
 *
 * "Optimise route" used to plan every driver as if they drove the same
 * truck: one figure for how many containers it carries and one for how long
 * the yard takes, for the whole company. A hook lift that carries two small
 * cans and a roll off truck that carries one big one are different
 * machines, and a day ordered for the wrong one has the driver going back
 * to the yard when the truck could have carried on, or carrying on when it
 * could not.
 *
 * A KIND is how many containers a truck carries at once, which sizes it can
 * lift and how long the yard takes it. A COMPANY ASSET that is a vehicle
 * can be given one. The driver's truck for a day is the vehicle with a kind
 * that is in the technician's custody that day (`asset_custody`), which is
 * the same record that already says who has the van, so there is no second
 * place to say who drives what. The company's own figures
 * (`rentalDispatch`) stay as the default for a driver with no truck of a
 * kind, and the proposal says which figures it used.
 *
 * WHEN A TECHNICIAN HOLDS TWO TRUCKS WITH A KIND, the one they were handed
 * most recently is theirs: the other is most likely a spare or one on its
 * way back, and a plan has to pick one.
 */

export interface TruckKindView {
  id: string;
  name: string;
  containersCarried: number;
  containerSizes: number[];
  yardMinutes: number;
  notes: string | null;
  /** Trucks on the register that have this kind and have not been retired. */
  trucks: { id: string; label: string }[];
}

export interface TruckKindInput {
  name: string;
  containersCarried: number;
  containerSizes?: number[] | undefined;
  yardMinutes: number;
  notes?: string | null | undefined;
}

export interface TruckKindPatch {
  id: string;
  name?: string | undefined;
  containersCarried?: number | undefined;
  containerSizes?: number[] | undefined;
  yardMinutes?: number | undefined;
  notes?: string | null | undefined;
}

type KindRow = typeof schema.truckKind.$inferSelect;

const viewOf = (row: KindRow, trucks: { id: string; label: string }[]): TruckKindView => ({
  id: row.id, name: row.name, containersCarried: row.containersCarried,
  containerSizes: [...row.containerSizes].sort((a, b) => a - b),
  yardMinutes: row.yardMinutes, notes: row.notes, trucks,
});

/** The figures, checked the way the planner needs them and said in words when they are not. */
function checked(input: TruckKindInput) {
  const name = input.name.trim();
  if (name === "") throw new ConflictError("Give the kind of truck a name, like Roll off or Hook lift.");
  if (!Number.isInteger(input.containersCarried) || input.containersCarried < 1 || input.containersCarried > 4) {
    throw new ConflictError("A truck carries between one and four containers.");
  }
  if (!Number.isInteger(input.yardMinutes) || input.yardMinutes < 0 || input.yardMinutes > 120) {
    throw new ConflictError("Time at the yard is between none and two hours.");
  }
  const sizes = [...new Set(input.containerSizes ?? [])];
  if (sizes.some((s) => !Number.isInteger(s) || s < 1 || s > 100)) {
    throw new ConflictError("Container sizes are whole cubic yards, like 10, 20 or 30.");
  }
  if (sizes.length > 12) throw new ConflictError("A truck lifts at most twelve sizes of container.");
  return { name, containersCarried: input.containersCarried, containerSizes: sizes.sort((a, b) => a - b), yardMinutes: input.yardMinutes, notes: input.notes?.trim() || null };
}

const sameName = (name: string) =>
  `A kind of truck called ${name} is already on the list. Change that one, or name this one differently.`;

async function trucksOf(tx: Database, organizationId: string, kindIds: string[]): Promise<Map<string, { id: string; label: string }[]>> {
  const found = new Map<string, { id: string; label: string }[]>();
  if (kindIds.length === 0) return found;
  const rows = await tx.select({ kindId: schema.companyAsset.truckKindId, id: schema.companyAsset.id, label: schema.companyAsset.label })
    .from(schema.companyAsset)
    .where(and(
      eq(schema.companyAsset.organizationId, organizationId),
      inArray(schema.companyAsset.truckKindId, kindIds),
      isNull(schema.companyAsset.retiredOn),
    ))
    .orderBy(asc(schema.companyAsset.label));
  for (const row of rows) if (row.kindId) found.set(row.kindId, [...(found.get(row.kindId) ?? []), { id: row.id, label: row.label }]);
  return found;
}

export function listKinds(ctx: ServiceContext) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const rows = await tx.select().from(schema.truckKind)
      .where(and(eq(schema.truckKind.organizationId, ctx.actor.organizationId), isNull(schema.truckKind.deletedAt)))
      .orderBy(asc(schema.truckKind.name));
    const held = await trucksOf(tx, ctx.actor.organizationId, rows.map((r) => r.id));
    return { kinds: rows.map((r) => viewOf(r, held.get(r.id) ?? [])) };
  });
}

export function createKind(ctx: ServiceContext, input: TruckKindInput) {
  return guardedWrite(ctx, "asset:write", async (tx): Promise<TruckKindView> => {
    const seen = await once.replayed<TruckKindView>(tx, ctx, "truck_kind");
    if (seen) return seen;
    const figures = checked(input);
    const [row] = await refusingDuplicate("truck_kind_name_idx", sameName(figures.name), () =>
      tx.insert(schema.truckKind).values({ organizationId: ctx.actor.organizationId, ...figures }).returning());
    await audit(tx, ctx, "truck_kind.created", "truck_kind", row!.id, null, row!);
    const view = viewOf(row!, []);
    await once.remember(tx, ctx, "truck_kind", row!.id, view);
    return view;
  });
}

async function kindWithin(tx: Database, ctx: ServiceContext, id: string): Promise<KindRow> {
  const [row] = await tx.select().from(schema.truckKind)
    .where(and(
      eq(schema.truckKind.id, id), eq(schema.truckKind.organizationId, ctx.actor.organizationId),
      isNull(schema.truckKind.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("Kind of truck");
  return row;
}

/**
 * Change a kind. Every truck of it is planned on the new figures from the next
 * time somebody optimises a day, and a day already ordered is not reordered
 * behind anybody's back: a proposal is only ever made when asked for.
 */
export function updateKind(ctx: ServiceContext, input: TruckKindPatch) {
  return guardedWrite(ctx, "asset:write", async (tx): Promise<TruckKindView> => {
    const before = await kindWithin(tx, ctx, input.id);
    const figures = checked({
      name: input.name ?? before.name,
      containersCarried: input.containersCarried ?? before.containersCarried,
      containerSizes: input.containerSizes ?? before.containerSizes,
      yardMinutes: input.yardMinutes ?? before.yardMinutes,
      notes: input.notes === undefined ? before.notes : input.notes,
    });
    const [row] = await refusingDuplicate("truck_kind_name_idx", sameName(figures.name), () =>
      tx.update(schema.truckKind).set({ ...figures, updatedAt: new Date() })
        .where(eq(schema.truckKind.id, before.id)).returning());
    await audit(tx, ctx, "truck_kind.updated", "truck_kind", before.id, before, row!);
    const held = await trucksOf(tx, ctx.actor.organizationId, [before.id]);
    return viewOf(row!, held.get(before.id) ?? []);
  });
}

/** Take a kind off the list. Refused while a truck still has it, naming the trucks. */
export function retireKind(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const before = await kindWithin(tx, ctx, input.id);
    const using = await tx.select({ label: schema.companyAsset.label }).from(schema.companyAsset)
      .where(and(
        eq(schema.companyAsset.organizationId, ctx.actor.organizationId),
        eq(schema.companyAsset.truckKindId, before.id), isNull(schema.companyAsset.retiredOn),
      )).orderBy(asc(schema.companyAsset.label));
    if (using.length > 0) {
      throw new ConflictError(
        `${using.map((u) => u.label).join(", ")} ${using.length === 1 ? "is" : "are"} still a ${before.name}. `
        + "Give each another kind, or none, first.",
      );
    }
    await tx.update(schema.truckKind).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.truckKind.id, before.id));
    await audit(tx, ctx, "truck_kind.retired", "truck_kind", before.id, before, null);
    return { id: before.id, retired: true as const };
  });
}

/**
 * Say what kind of truck a vehicle is, or that it has no kind. Only a vehicle
 * can be a truck: a chipper or a torque wrench with a kind of truck would be a
 * register that says something untrue.
 */
export function setTruckKind(ctx: ServiceContext, input: { assetId: string; truckKindId: string | null }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const [asset] = await tx.select().from(schema.companyAsset)
      .where(and(eq(schema.companyAsset.id, input.assetId), eq(schema.companyAsset.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!asset) throw new NotFoundError("Asset");
    if (input.truckKindId !== null) {
      if (asset.kind !== "vehicle") {
        throw new ConflictError(`${asset.label} is not a vehicle. Only a vehicle can be a truck that hauls containers.`);
      }
      if (asset.retiredOn !== null) {
        throw new ConflictError(`${asset.label} has been retired, so it is not a truck anyone drives.`);
      }
      await kindWithin(tx, ctx, input.truckKindId);
    }
    const [row] = await tx.update(schema.companyAsset)
      .set({ truckKindId: input.truckKindId, updatedAt: new Date() })
      .where(eq(schema.companyAsset.id, asset.id)).returning();
    await audit(tx, ctx, "asset.truck_kind_set", "company_asset", asset.id,
      { truckKindId: asset.truckKindId }, { truckKindId: row!.truckKindId });
    return { id: asset.id, label: asset.label, truckKindId: row!.truckKindId };
  });
}

/* -------------------------------------------------------------- the planner */

export interface DriversTruck {
  /** What the driver's day is planned on. */
  figures: routing.TruckFigures;
  /** The truck those figures are from; null when the company's figures were used. */
  truck: { assetId: string; label: string; kindName: string } | null;
}

/**
 * The truck a technician is driving on a day and the figures it plans on.
 *
 * The vehicle with a kind that is in their custody that day: held from a day
 * on or before it and not handed back until after it (custody is half open, so
 * the day it is handed back is the next driver's). A vehicle retired by then is
 * not a truck anyone drives. With none, or a kind since retired, the company's
 * figures.
 */
export async function truckOf(
  tx: Database, organizationId: string, technicianId: string, date: string,
  company: { containersPerTruck: number; yardMinutes: number },
): Promise<DriversTruck> {
  const [held] = await tx.select({
    assetId: schema.companyAsset.id, label: schema.companyAsset.label,
    kind: schema.truckKind.name, containers: schema.truckKind.containersCarried,
    sizes: schema.truckKind.containerSizes, yardMinutes: schema.truckKind.yardMinutes,
  }).from(schema.assetCustody)
    .innerJoin(schema.companyAsset, eq(schema.companyAsset.id, schema.assetCustody.assetId))
    .innerJoin(schema.truckKind, eq(schema.truckKind.id, schema.companyAsset.truckKindId))
    .where(and(
      eq(schema.assetCustody.organizationId, organizationId),
      eq(schema.assetCustody.custodianKind, "technician"),
      eq(schema.assetCustody.custodianId, technicianId),
      lte(schema.assetCustody.heldFrom, date),
      or(isNull(schema.assetCustody.heldUntil), gt(schema.assetCustody.heldUntil, date)),
      or(isNull(schema.companyAsset.retiredOn), gt(schema.companyAsset.retiredOn, date)),
      isNull(schema.truckKind.deletedAt),
    ))
    .orderBy(desc(schema.assetCustody.heldFrom), asc(schema.companyAsset.id))
    .limit(1);
  if (!held) return { figures: routing.truckFigures(company, null), truck: null };
  return {
    figures: routing.truckFigures(company, { containers: held.containers, yardMinutes: held.yardMinutes, sizes: held.sizes }),
    truck: { assetId: held.assetId, label: held.label, kindName: held.kind },
  };
}

export const handlers = {
  listTruckKinds: (ctx: ServiceContext) => listKinds(ctx),
  createTruckKind: (ctx: ServiceContext, input: TruckKindInput) => createKind(ctx, input),
  updateTruckKind: (ctx: ServiceContext, input: TruckKindPatch) => updateKind(ctx, input),
  retireTruckKind: (ctx: ServiceContext, input: { id: string }) => retireKind(ctx, input),
  setAssetTruckKind: (ctx: ServiceContext, input: { assetId: string; truckKindId: string | null }) => setTruckKind(ctx, input),
} as const;
