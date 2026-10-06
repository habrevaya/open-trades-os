import { and, asc, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { rental as rt, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";

/**
 * A TRADE PACK THAT SHIPPED, AND THE THING IT RENTS
 *
 * `packs/dumpster-rental.ts` is one of eight packs a company can apply at
 * setup. It declares six job types whose capacity model is `asset_rental`,
 * thirty eight price book items built around container days and scale tickets,
 * two checklists written for a driver with a hook truck, and eight KPI
 * definitions precise enough to name how each one is usually computed wrongly.
 *
 * `rentable_asset` had no reader and no writer. Neither did `rental`. Neither
 * did `visit.rental_id` or `visit.rental_event`, the two columns that say which
 * hire a stop belongs to and whether the driver is dropping or collecting.
 *
 * So a roll off company could apply the pack, get the price book, the job types
 * and the checklists, and could not record one container. The pack's own first
 * paragraph says the scarce resource is a can rather than a person, and there
 * was nowhere to put a can.
 *
 * THREE THINGS IN HERE ARE THE TRADE RATHER THAN CRUD:
 *
 *   A SWAP CLOSES ONE RENTAL AND OPENS ANOTHER, linked. One stop takes the full
 *   can and leaves an empty one at the same address. `rental.asset_id` is a
 *   single column and the can physically changed, so it has to be two rows, and
 *   without the link a four week construction hire with three swaps reads as
 *   four unrelated week long rentals. The pack's average duration KPI says in
 *   so many words that a swap counts inside the parent rental.
 *
 *   THE UTILISATION DENOMINATOR INCLUDES THE YARD. Cans sitting in the yard are
 *   available and unrented, and leaving them out is the usual mistake: it makes
 *   a bloated fleet look fully booked, which is the one conclusion the metric
 *   exists to prevent. Only cans tagged out of service come out.
 *
 *   TWO BILLING METERS, NEITHER DERIVED FROM THE OTHER. Elapsed calendar days
 *   against an included period, and scale ticket tonnage against an included
 *   tonnage. A can that sat three weeks holding four hundred pounds owes days
 *   and no tons. The arithmetic is in `core/rental`.
 */

/* ------------------------------------------------------------- the fleet */

export interface AssetInput {
  /** "roll_off_container", "portable_toilet", "storage_container". The pack's own word. */
  assetType: string;
  /** The number painted on the side. Unique in the company, which the index holds. */
  identifier: string;
  /** "20 yard", "30 yard". Free text because a size is a label, not a measurement. */
  size?: string | null | undefined;
  homeLocationId?: string | null | undefined;
  purchaseCost?: string | null | undefined;
}

export function addAsset(ctx: ServiceContext, input: AssetInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const identifier = input.identifier.trim();
    if (identifier === "") {
      throw new ConflictError(
        "A container needs its number. It is what the driver reads off the side and the only "
        + "thing tying a scale ticket to a unit.",
      );
    }
    const assetType = input.assetType.trim();
    if (assetType === "") throw new ConflictError("Say what kind of unit this is.");

    if (input.homeLocationId) {
      const [found] = await tx.select({ id: schema.location.id }).from(schema.location)
        .where(and(
          eq(schema.location.organizationId, ctx.actor.organizationId),
          eq(schema.location.id, input.homeLocationId),
        ))
        .limit(1);
      if (!found) throw new NotFoundError("Location");
    }

    /**
     * The duplicate number is a refusal, not a crash. `services/duplicates.ts`
     * holds the reason and the class of bug it closes; a browser test found this
     * one, and the integration test that was supposed to had asserted
     * `rejects.toThrow()` with no message, which cannot tell the two apart.
     */
    const [row] = await refusingDuplicate(
      "rentable_asset_identifier_idx",
      `Container ${identifier} is already on the register. Two units with one number means a `
      + `scale ticket cannot be tied to either, so the number has to be unique. If the old one is `
      + `gone, retire it first.`,
      () => tx.insert(schema.rentableAsset).values({
        organizationId: ctx.actor.organizationId,
        assetType,
        identifier,
        size: input.size?.trim() ?? null,
        homeLocationId: input.homeLocationId ?? null,
        purchaseCost: input.purchaseCost ?? null,
        status: "available",
      }).returning(),
    );

    await audit(tx, ctx, "rentable_asset.create", "rentable_asset", row!.id, null, row);
    return assetView(row!);
  });
}

function assetView(row: typeof schema.rentableAsset.$inferSelect) {
  return {
    id: row.id,
    assetType: row.assetType,
    identifier: row.identifier,
    size: row.size,
    status: isStatus(row.status) ? row.status : "available",
    homeLocationId: row.homeLocationId,
    currentPropertyId: row.currentPropertyId,
    purchaseCost: row.purchaseCost,
    active: row.active,
  };
}

/**
 * The status column is `text`, not an enum, so it is narrowed on the way out.
 *
 * A row written before this service existed, or by a migration, can hold
 * anything. Casting would make the contract's own type a claim about a value
 * this process did not produce.
 */
const isStatus = (value: string): value is rt.AssetStatus =>
  (rt.ASSET_STATUSES as readonly string[]).includes(value);

export function listAssets(ctx: ServiceContext, input: {
  status?: rt.AssetStatus | undefined;
  assetType?: string | undefined;
  limit: number;
}) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const rows = await tx.select().from(schema.rentableAsset)
      .where(and(
        eq(schema.rentableAsset.organizationId, ctx.actor.organizationId),
        isNull(schema.rentableAsset.deletedAt),
        ...(input.status ? [eq(schema.rentableAsset.status, input.status)] : []),
        ...(input.assetType ? [eq(schema.rentableAsset.assetType, input.assetType)] : []),
      ))
      .orderBy(asc(schema.rentableAsset.assetType), asc(schema.rentableAsset.identifier))
      .limit(input.limit);

    /**
     * WHERE EACH ONE IS, not only what state it is in. "On site" is not an
     * answer to the question a dispatcher asks twenty times a day, and
     * `current_property_id` on its own is a uuid. One extra query rather than a
     * join because the property set is small and the join duplicates every
     * asset column.
     */
    const places = await addressesFor(tx, rows
      .map((row) => row.currentPropertyId)
      .filter((id): id is string => id !== null));

    return {
      data: rows.map((row) => ({
        ...assetView(row),
        currentAddress: row.currentPropertyId ? places.get(row.currentPropertyId) ?? null : null,
      })),
    };
  });
}

async function assetWithin(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.rentableAsset)
    .where(and(
      eq(schema.rentableAsset.organizationId, ctx.actor.organizationId),
      eq(schema.rentableAsset.id, id),
      isNull(schema.rentableAsset.deletedAt),
    ))
    .limit(1);
  if (!row) throw new NotFoundError("Container");
  return row;
}

async function moveAsset(
  tx: Database, ctx: ServiceContext,
  row: typeof schema.rentableAsset.$inferSelect,
  to: rt.AssetStatus,
  propertyId: string | null,
) {
  const from = isStatus(row.status) ? row.status : "available";
  if (!rt.canMove(from, to)) throw new ConflictError(rt.moveRefusal(from, to));
  await tx.update(schema.rentableAsset)
    .set({ status: to, currentPropertyId: propertyId, updatedAt: new Date() })
    .where(eq(schema.rentableAsset.id, row.id));
}

/**
 * Tag a container out for repair.
 *
 * THE ONLY THING THAT CHANGES THE UTILISATION DENOMINATOR, which is why it is
 * its own operation with its own reason rather than a status field on an
 * update. A can tagged out while it is still on a customer site is allowed and
 * is the ordinary case: the pickup checklist's last line is to record the
 * condition and tag it out if it needs repair.
 */
export function tagOutOfService(ctx: ServiceContext, input: { id: string; reason: string }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const row = await assetWithin(tx, ctx, input.id);
    const reason = input.reason.trim();
    if (reason === "") {
      throw new ConflictError(
        "Say what is wrong with it. A container tagged out with no reason is one nobody knows how "
        + "to put back, and it sits out of the utilisation figure indefinitely.",
      );
    }
    await moveAsset(tx, ctx, row, "out_of_service", null);
    await audit(tx, ctx, "rentable_asset.out_of_service", "rentable_asset", row.id, row, { reason });
    return assetView(await assetWithin(tx, ctx, input.id));
  });
}

export function returnToService(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const row = await assetWithin(tx, ctx, input.id);
    await moveAsset(tx, ctx, row, "available", null);
    await audit(tx, ctx, "rentable_asset.in_service", "rentable_asset", row.id, row, null);
    return assetView(await assetWithin(tx, ctx, input.id));
  });
}

/**
 * Take a unit out of the fleet for good.
 *
 * Soft, so every hire that unit ever ran still resolves to its number. A sold
 * or scrapped container has years of scale tickets behind it, and a report that
 * says "container 2041" rather than a uuid is the difference between an
 * answerable tonnage query and an unanswerable one.
 *
 * REFUSED WHILE IT IS ON A SITE. A retired unit leaves the utilisation
 * denominator, so retiring one that is out on hire would quietly remove a
 * container from the fleet count while it is still earning, and the utilisation
 * figure would go above a hundred per cent with nothing explaining why.
 *
 * `active` is not this. That flag is for a unit in the fleet and not currently
 * rentable, and `deleted_at` is for one that has left. Before this operation
 * existed nothing wrote `deleted_at` on this table while every read filtered on
 * it, which is a check that cannot fail.
 */
export function retireAsset(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const row = await assetWithin(tx, ctx, input.id);
    if (row.status === "on_site") {
      throw new ConflictError(
        `Container ${row.identifier} is on a customer site. Collect it before retiring it: a `
        + "retired unit leaves the fleet count, and one retired while still out puts the "
        + "utilisation rate above a hundred per cent.",
      );
    }
    await tx.update(schema.rentableAsset)
      .set({ deletedAt: new Date(), active: false, updatedAt: new Date() })
      .where(eq(schema.rentableAsset.id, input.id));
    await audit(tx, ctx, "rentable_asset.retire", "rentable_asset", input.id, row, null);
    return { id: input.id, retired: true as const };
  });
}

/* -------------------------------------------------------------- the hire */

export interface DeliverInput {
  assetId: string;
  propertyId: string;
  /** The job this hire belongs to, when it has one. */
  jobId?: string | null | undefined;
  /** Opens the hire at this instant rather than at the clock. */
  deliveredAt?: string | undefined;
  includedDays?: number | null | undefined;
  dailyRate?: string | null | undefined;
  overageRate?: string | null | undefined;
  includedTons?: string | null | undefined;
  perTonRate?: string | null | undefined;
}

/**
 * Put a container on a site.
 *
 * `deliveredAt` comes from the caller rather than the clock, like every other
 * event in this codebase that a person records after the fact. A driver writing
 * up a day's drops at five in the evening would otherwise have every rental
 * start at five.
 */
export function deliver(ctx: ServiceContext, input: DeliverInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const asset = await assetWithin(tx, ctx, input.assetId);
    const [property] = await tx.select({ id: schema.property.id }).from(schema.property)
      .where(and(
        eq(schema.property.organizationId, ctx.actor.organizationId),
        eq(schema.property.id, input.propertyId),
        isNull(schema.property.deletedAt),
      ))
      .limit(1);
    if (!property) throw new NotFoundError("Property");

    if (input.jobId) await assertJob(tx, ctx, input.jobId);

    const deliveredAt = input.deliveredAt ? new Date(input.deliveredAt) : new Date();
    await moveAsset(tx, ctx, asset, "on_site", input.propertyId);

    const [row] = await tx.insert(schema.rental).values({
      organizationId: ctx.actor.organizationId,
      assetId: input.assetId,
      propertyId: input.propertyId,
      deliveredAt,
      includedDays: input.includedDays ?? null,
      dailyRate: input.dailyRate ?? null,
      overageRate: input.overageRate ?? null,
      includedTons: input.includedTons ?? null,
      perTonRate: input.perTonRate ?? null,
    }).returning();

    if (input.jobId) {
      await attachVisit(tx, ctx, { jobId: input.jobId, rentalId: row!.id, event: "delivery" });
    }

    await audit(tx, ctx, "rental.deliver", "rental", row!.id, null, row);
    return rentalViewWithin(tx, ctx, row!);
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
 * Point this job's open stop at the hire, and say which leg it is.
 *
 * `visit.rental_id` and `visit.rental_event` were written by nothing, and
 * without them the dispatch board cannot tell a driver whether they are
 * dropping or collecting at an address. The pack models delivery, pickup and
 * swap as three job types for exactly this reason: the driver has to arrive with
 * an empty can on the truck for a swap, which the router has to know.
 *
 * THE LATEST UNFINISHED STOP, and only if the job has one. A rental can exist
 * with no job behind it, which is ordinary for a standing container on a
 * commercial site, and inventing a visit so a column could be filled would put
 * a stop on a dispatch board that nobody is driving to.
 */
async function attachVisit(tx: Database, ctx: ServiceContext, input: {
  jobId: string; rentalId: string; event: "delivery" | "pickup" | "swap";
}) {
  /**
   * No `deleted_at` filter on the visit, and that is deliberate rather than an
   * omission. M10 cancels a visit rather than deleting one, on purpose, so
   * nothing in this product writes that column on a `visit` row and a filter on
   * it would be a check that cannot fail. The next reader would stop asking
   * whether the check exists.
   */
  const [visit] = await tx.select({ id: schema.visit.id }).from(schema.visit)
    .where(and(
      eq(schema.visit.organizationId, ctx.actor.organizationId),
      eq(schema.visit.jobId, input.jobId),
      isNull(schema.visit.rentalId),
    ))
    .orderBy(asc(schema.visit.sequence))
    .limit(1);
  if (!visit) return;

  await tx.update(schema.visit)
    .set({ rentalId: input.rentalId, rentalEvent: input.event, updatedAt: new Date() })
    .where(eq(schema.visit.id, visit.id));
}

export interface PickUpInput {
  id: string;
  pickedUpAt?: string | undefined;
  /** Net tonnage from the scale ticket. Gross less tare, never negative. */
  tons?: string | null | undefined;
  divertedTons?: string | null | undefined;
  ticketNumber?: string | null | undefined;
  facility?: string | null | undefined;
  materialType?: string | null | undefined;
  disposalFee?: string | null | undefined;
  /** False when the can went straight to the repair bay. */
  backInService?: boolean | undefined;
}

/**
 * Take it away, and record the ticket.
 *
 * The scale ticket is stored on the rental rather than only as a reading on the
 * visit, and that is deliberate. It is the support behind the largest line on
 * the invoice and the largest line in the cost of goods, the pack's retention
 * rule keeps it for three years from the haul, and a number living in a visit's
 * readings blob cannot be totalled, reconciled against the facility's account,
 * or found when a customer questions a tonnage charge.
 */
export function pickUp(ctx: ServiceContext, input: PickUpInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const hire = await rentalWithin(tx, ctx, input.id);
    if (hire.pickedUpAt !== null) {
      throw new ConflictError(
        "That container has already been collected. If it went back out, that is a new rental; "
        + "reopening this one would merge two hires into one period and bill neither correctly.",
      );
    }

    const pickedUpAt = input.pickedUpAt ? new Date(input.pickedUpAt) : new Date();
    if (hire.deliveredAt && pickedUpAt.getTime() < hire.deliveredAt.getTime()) {
      throw new ConflictError(
        "That pickup is before the delivery. A rental cannot end before it starts, and a negative "
        + "period bills as a credit.",
      );
    }
    assertTons(input.tons, "net");
    assertTons(input.divertedTons, "diverted");

    const asset = await assetWithin(tx, ctx, hire.assetId);
    await moveAsset(tx, ctx, asset, input.backInService === false ? "out_of_service" : "available", null);

    const [row] = await tx.update(schema.rental).set({
      pickedUpAt,
      weightTons: input.tons ?? null,
      divertedTons: input.divertedTons ?? null,
      disposalTicketNumber: input.ticketNumber?.trim() ?? null,
      disposalFacility: input.facility?.trim() ?? null,
      materialType: input.materialType?.trim() ?? null,
      disposalFee: input.disposalFee ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.rental.id, input.id)).returning();

    await audit(tx, ctx, "rental.pickup", "rental", input.id, hire, row);
    return rentalViewWithin(tx, ctx, row!);
  });
}

function assertTons(value: string | null | undefined, which: "net" | "diverted") {
  if (value === null || value === undefined) return;
  const tons = Number(value);
  if (!Number.isFinite(tons) || tons < 0) {
    throw new ConflictError(
      `"${value}" is not a weight. A scale ticket's ${which} tonnage is a positive number: the `
      + "gross less the tare.",
    );
  }
}

export interface SwapInput {
  id: string;
  /** The empty can the driver brought. */
  replacementAssetId: string;
  at?: string | undefined;
  tons?: string | null | undefined;
  ticketNumber?: string | null | undefined;
  facility?: string | null | undefined;
  materialType?: string | null | undefined;
}

/**
 * One stop that takes the full can and leaves an empty one.
 *
 * TWO ROWS, LINKED, and the link is the point. `rental.asset_id` is a single
 * column and the can physically changed, so a swap cannot be an update. Without
 * `previous_rental_id` a four week construction hire with three swaps reads as
 * four unrelated week long rentals, and the pack's average duration KPI, which
 * says a swap counts inside the parent rental, comes out at a quarter of the
 * truth.
 *
 * SAME PROPERTY, ALWAYS. A swap is defined by the address staying the same; a
 * can taken from one site and dropped at another is a pickup and a delivery,
 * and calling that a swap would chain two customers' hires together.
 */
export function swap(ctx: ServiceContext, input: SwapInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const hire = await rentalWithin(tx, ctx, input.id);
    if (hire.pickedUpAt !== null) {
      throw new ConflictError("That rental is already closed. There is nothing on site to swap.");
    }
    if (input.replacementAssetId === hire.assetId) {
      throw new ConflictError(
        "That is the same container. A swap leaves a different can behind; taking one away and "
        + "putting it back is a dump and return.",
      );
    }

    const at = input.at ? new Date(input.at) : new Date();
    if (hire.deliveredAt && at.getTime() < hire.deliveredAt.getTime()) {
      throw new ConflictError("That swap is before the delivery it would close.");
    }
    assertTons(input.tons, "net");

    const outgoing = await assetWithin(tx, ctx, hire.assetId);
    const incoming = await assetWithin(tx, ctx, input.replacementAssetId);

    await moveAsset(tx, ctx, outgoing, "available", null);
    await moveAsset(tx, ctx, incoming, "on_site", hire.propertyId);

    const [closed] = await tx.update(schema.rental).set({
      pickedUpAt: at,
      weightTons: input.tons ?? null,
      disposalTicketNumber: input.ticketNumber?.trim() ?? null,
      disposalFacility: input.facility?.trim() ?? null,
      materialType: input.materialType?.trim() ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.rental.id, input.id)).returning();

    /**
     * The new period carries the old terms forward. A swap mid hire does not
     * renegotiate the rate, and asking the caller to resend them would mean a
     * swap recorded without them silently puts the rest of the hire on no terms
     * at all, which is the `no_rate` refusal arriving weeks later at billing.
     */
    const [opened] = await tx.insert(schema.rental).values({
      organizationId: ctx.actor.organizationId,
      assetId: input.replacementAssetId,
      propertyId: hire.propertyId,
      deliveredAt: at,
      includedDays: hire.includedDays,
      dailyRate: hire.dailyRate,
      overageRate: hire.overageRate,
      includedTons: hire.includedTons,
      perTonRate: hire.perTonRate,
      previousRentalId: input.id,
    }).returning();

    await audit(tx, ctx, "rental.swap", "rental", opened!.id, closed, opened);
    return {
      closed: await rentalViewWithin(tx, ctx, closed!),
      opened: await rentalViewWithin(tx, ctx, opened!),
    };
  });
}

/* ------------------------------------------------------------- the reads */

async function rentalWithin(tx: Database, ctx: ServiceContext, id: string) {
  /**
   * NO `deleted_at` FILTER ON A RENTAL, HERE OR ANYWHERE BELOW.
   *
   * A finished rental carries the scale ticket that is the support behind the
   * largest line on an invoice and the largest line in the cost of goods, and
   * the trade pack's retention rule keeps it for four years from the end of the
   * hire. Nothing in this service removes one, softly or otherwise, so a filter
   * on that column would be a check that cannot fail. A container entered by
   * mistake is retired from the fleet; a hire that happened stays.
   */
  const [row] = await tx.select().from(schema.rental)
    .where(and(
      eq(schema.rental.organizationId, ctx.actor.organizationId),
      eq(schema.rental.id, id),
    ))
    .limit(1);
  if (!row) throw new NotFoundError("Rental");
  return row;
}

/**
 * Addresses for a set of properties, in one query.
 *
 * WHERE IT IS, not which uuid it is at. `listRentableAssets` already made this
 * choice with a comment saying why: "on site" is not an answer to the question a
 * dispatcher asks twenty times a day. A hire list that answered it with an
 * identifier would make every caller, this product's own board included, do the
 * join itself.
 *
 * Batched and passed in rather than looked up per row, because a board showing
 * fifty open hires would otherwise make fifty round trips for fifty addresses,
 * and most of them are the same handful of sites.
 */
async function addressesFor(tx: Database, propertyIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(propertyIds)];
  const places = new Map<string, string>();
  if (unique.length === 0) return places;
  const found = await tx.select({
    id: schema.property.id,
    line1: schema.property.addressLine1,
    city: schema.property.city,
  })
    .from(schema.property)
    .where(inArray(schema.property.id, unique));
  for (const row of found) {
    places.set(row.id, [row.line1, row.city].filter((part) => part).join(", "));
  }
  return places;
}

async function rentalViewWithin(
  tx: Database, ctx: ServiceContext, row: typeof schema.rental.$inferSelect,
  addresses?: Map<string, string>,
) {
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  const [asset] = await tx.select({
    identifier: schema.rentableAsset.identifier,
    size: schema.rentableAsset.size,
  })
    .from(schema.rentableAsset)
    .where(eq(schema.rentableAsset.id, row.assetId))
    .limit(1);

  const places = addresses ?? await addressesFor(tx, [row.propertyId]);

  const days = row.deliveredAt === null
    ? null
    : rt.containerDays(row.deliveredAt, row.pickedUpAt ?? new Date(), zone);

  return {
    id: row.id,
    assetId: row.assetId,
    assetIdentifier: asset?.identifier ?? null,
    assetSize: asset?.size ?? null,
    propertyId: row.propertyId,
    propertyAddress: places.get(row.propertyId) ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    pickedUpAt: row.pickedUpAt?.toISOString() ?? null,
    /** Open when it has not been collected, whatever the dates say. */
    open: row.pickedUpAt === null,
    /**
     * Container days as the trade counts them: any part of a calendar day, in
     * the company's timezone. Counted to now while the hire is open, which is
     * what a dispatcher looking at a board wants, and is why the field is named
     * for what it is rather than called a duration.
     */
    daysSoFar: days,
    includedDays: row.includedDays,
    dailyRate: row.dailyRate,
    overageRate: row.overageRate,
    includedTons: row.includedTons,
    perTonRate: row.perTonRate,
    weightTons: row.weightTons,
    divertedTons: row.divertedTons,
    disposalTicketNumber: row.disposalTicketNumber,
    disposalFacility: row.disposalFacility,
    materialType: row.materialType,
    disposalFee: row.disposalFee,
    previousRentalId: row.previousRentalId,
    /** The stop that will collect it, once the collection scheduler has booked one. */
    collectionVisitId: row.collectionVisitId,
    /** When the customer agreed the collection should happen, when they agreed a time. */
    collectionAgreedStart: row.collectionAgreedStart?.toISOString() ?? null,
    collectionAgreedEnd: row.collectionAgreedEnd?.toISOString() ?? null,
    /** The invoice its period and meters went on, once raised. */
    invoiceId: row.invoiceId,
  };
}

export function getRental(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    return rentalViewWithin(tx, ctx, await rentalWithin(tx, ctx, input.id));
  });
}

export function listRentals(ctx: ServiceContext, input: {
  open?: boolean | undefined;
  propertyId?: string | undefined;
  assetId?: string | undefined;
  limit: number;
}) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const rows = await tx.select().from(schema.rental)
      .where(and(
        eq(schema.rental.organizationId, ctx.actor.organizationId),
        ...(input.open === true ? [isNull(schema.rental.pickedUpAt)] : []),
        ...(input.open === false ? [isNotNull(schema.rental.pickedUpAt)] : []),
        ...(input.propertyId ? [eq(schema.rental.propertyId, input.propertyId)] : []),
        ...(input.assetId ? [eq(schema.rental.assetId, input.assetId)] : []),
      ))
      .orderBy(desc(schema.rental.deliveredAt))
      .limit(input.limit);

    const addresses = await addressesFor(tx, rows.map((row) => row.propertyId));
    return {
      data: await Promise.all(rows.map((row) => rentalViewWithin(tx, ctx, row, addresses))),
    };
  });
}

/* ------------------------------------------------------------- the billing */

/**
 * What this rental owes beyond its quoted price, as two separate meters.
 *
 * A READ, NOT A WRITE, and it does not raise an invoice. Pricing a line is
 * `billing`'s job and the price book items are in the pack (`OVR-DAY-SM`,
 * `OVR-TON-CD` and the rest); this answers what the meters read, which is the
 * part that is arithmetic rather than policy. An operator who disputes a figure
 * needs to see the days and the tons separately, and a single total cannot show
 * either.
 */
export function overage(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const hire = await rentalWithin(tx, ctx, input.id);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);

    if (hire.deliveredAt === null) {
      throw new ConflictError("That rental has no delivery date, so there is no period to bill.");
    }
    if (hire.pickedUpAt === null) {
      /**
       * A refusal rather than a figure counted to now. An open hire's overage
       * changes every midnight, and a number that does that on a screen beside
       * an invoice is one somebody will put on the invoice.
       */
      throw new ConflictError(
        "That container is still on site. The period is not final until it is collected, and a "
        + "figure that changes every midnight is not something to bill from.",
      );
    }

    const verdict = rt.bill({
      deliveredAt: hire.deliveredAt,
      pickedUpAt: hire.pickedUpAt,
      zone,
      period: { includedDays: hire.includedDays, overageRate: hire.overageRate },
      weight: { includedTons: hire.includedTons, perTonRate: hire.perTonRate },
      tons: hire.weightTons,
    });

    if (!verdict.ok) {
      throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));
    }
    return {
      rentalId: hire.id,
      days: verdict.days,
      lines: verdict.lines,
      total: verdict.total,
    };
  });
}

/* ------------------------------------------------------------- the metrics */

export interface FleetReport {
  from: string;
  to: string;
  windowDays: number;
  utilisationRate: string | null;
  rentedDays: number;
  availableDays: number;
  outOfServiceUnits: number;
  averageDurationDays: string | null;
  rentalsEnded: number;
  averageTonsPerHaul: string | null;
  haulsWithTicket: number;
  haulsWithoutTicket: number;
  overageCaptureRate: string | null;
  exceededRentals: number;
  billableRentals: number;
}

/**
 * The four KPIs this data can answer exactly as the pack defines them.
 *
 * The pack declares eight. Four of them need joins this module does not have:
 * `revenue_per_container_month` and `disposal_cost_pct` need invoiced revenue
 * and facility cost attributed per container, `hauls_per_truck_day` needs truck
 * days from the driver timeclock rather than the roster, and `turnaround_hours`
 * needs the moment a can was emptied at the facility, which nothing records.
 * They are absent rather than approximated, because a KPI computed from the
 * nearest available number is one an owner makes a fleet purchase on.
 *
 * EVERY EXCLUSION THE PACK NAMES IS IMPLEMENTED AND TESTED, because each one is
 * the way the metric is usually got wrong.
 */
export function fleetReport(ctx: ServiceContext, input: { from: string; to: string }) {
  return guardedRead(ctx, "asset:read", async (tx): Promise<FleetReport> => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    if (!time.isZone(zone)) throw new ConflictError(`"${zone}" is not a timezone.`);
    const window = { start: time.startOfDayIn(input.from, zone), end: time.dayBoundsIn(input.to, zone).end };
    if (window.end.getTime() <= window.start.getTime()) {
      throw new ConflictError("The end of the window is on or before its start.");
    }
    const windowDays = rt.containerDays(window.start, new Date(window.end.getTime() - 1), zone);

    const assets = await tx.select({
      id: schema.rentableAsset.id,
      status: schema.rentableAsset.status,
    })
      .from(schema.rentableAsset)
      .where(and(
        eq(schema.rentableAsset.organizationId, ctx.actor.organizationId),
        isNull(schema.rentableAsset.deletedAt),
        eq(schema.rentableAsset.active, true),
      ));

    const outOfService = assets.filter((a) => a.status === "out_of_service").length;
    /**
     * THE DENOMINATOR, AND THE ONE LINE THE WHOLE METRIC TURNS ON. Every active
     * container that is not tagged out, times the days in the window. Cans in
     * the yard are in it. Leaving them out is the usual mistake and it makes a
     * bloated fleet look fully booked.
     */
    const availableDays = (assets.length - outOfService) * windowDays;

    /**
     * Rented days, clipped to the window. A hire that started in March and was
     * collected in May contributes only April's days to April's figure, and the
     * clipping is in SQL because doing it in TypeScript would mean reading every
     * rental the company has ever had.
     */
    /**
     * ISO strings with an explicit cast rather than Date objects.
     *
     * Drizzle infers a parameter's type from the column it is compared against,
     * and in a raw expression like `least(coalesce(...), $1)` there is no column
     * to infer from, so the driver is handed a Date it does not know how to
     * encode and the query fails at runtime with "the string argument must be of
     * type string". Nine tests found it at once, which is the only reason it is
     * worth a comment: the same mistake inside a WHERE against a timestamp
     * column works fine, so it looks like it should.
     */
    const windowStart = window.start.toISOString();
    const windowEnd = window.end.toISOString();
    /**
     * THE LAST INSTANT OF THE WINDOW, NOT ITS EXCLUSIVE END.
     *
     * `dayBoundsIn` returns midnight at the start of the day after, which is
     * right for a half open comparison and wrong inside the `+ 1` below: for
     * April that end is 1 May, so the subtraction gives thirty and the inclusive
     * `+ 1` makes thirty one days in a thirty day month. Every long hire's
     * utilisation came out a day high, and in a thirty day window where one can
     * was out the whole time, over a hundred per cent.
     */
    const windowLast = new Date(window.end.getTime() - 1).toISOString();
    /**
     * `at time zone` before `::date`, on both ends.
     *
     * A bare `::date` on a timestamptz converts in the SESSION's timezone, which
     * is UTC here and is not the company's. A delivery at 7pm Central on 31
     * March is 1 April in UTC, so the count would start a day late for every
     * evening drop, which is exactly the mistake `containerDays` exists to
     * avoid in TypeScript. The two have to agree or the report and the rental
     * page disagree about the same hire.
     */
    const [rented] = await tx.execute<{ days: string }>(sql`
      select coalesce(sum(
        ((least(coalesce(r.picked_up_at, ${windowLast}::timestamptz), ${windowLast}::timestamptz)
          at time zone ${zone})::date
         - (greatest(r.delivered_at, ${windowStart}::timestamptz) at time zone ${zone})::date) + 1
      ), 0)::text as days
      from public.rental r
      where r.delivered_at is not null
        and r.delivered_at < ${windowEnd}::timestamptz
        and coalesce(r.picked_up_at, ${windowEnd}::timestamptz) >= ${windowStart}::timestamptz
    `);

    /**
     * Rentals that ENDED in the window, which the pack says and is the reason
     * this is not "rentals that overlap it". Including open hires at "so far"
     * makes the same average move for no reason anybody can explain.
     *
     * A swap's rows are folded into the placement they belong to: a chain is
     * followed back through `previous_rental_id`, so a four week hire with three
     * swaps counts once, at four weeks, rather than four times at a week each.
     */
    const ended = await tx.select({
      id: schema.rental.id,
      deliveredAt: schema.rental.deliveredAt,
      pickedUpAt: schema.rental.pickedUpAt,
      previousRentalId: schema.rental.previousRentalId,
      weightTons: schema.rental.weightTons,
      includedDays: schema.rental.includedDays,
      includedTons: schema.rental.includedTons,
      overageRate: schema.rental.overageRate,
      perTonRate: schema.rental.perTonRate,
    })
      .from(schema.rental)
      .where(and(
        eq(schema.rental.organizationId, ctx.actor.organizationId),
        /**
         * NO `isNotNull` ON THE PICKUP, AND THERE WAS ONE.
         *
         * It read as the thing excluding open hires, and the sweep proved it was
         * not: a NULL in `pickedUpAt >= $start` evaluates to NULL rather than
         * true, so the range comparison below already excludes every open hire.
         * Removing the extra clause changed no test and no row.
         *
         * Deleted rather than kept, because a clause that reads as the guard
         * while the guard is somewhere else is how the real one gets removed by
         * somebody tidying up. What excludes an open hire is the comparison.
         */
        sql`${schema.rental.pickedUpAt} >= ${windowStart}::timestamptz`,
        sql`${schema.rental.pickedUpAt} < ${windowEnd}::timestamptz`,
      ));

    /**
     * A placement's start, walking back through the swap chain.
     *
     * One query for the whole chain rather than a recursive CTE, because the
     * rows are already loaded for the rest of this report and a chain in this
     * trade is three or four links, not three thousand.
     */
    const chainStarts = await startsFor(tx, ctx, ended);

    const placementDays: number[] = [];
    for (const row of ended) {
      if (!row.pickedUpAt) continue;
      /**
       * A row that something else swapped FROM is a link in the middle of a
       * placement, not the end of one, so it contributes nothing of its own.
       */
      if (isSwappedFrom(ended, row.id)) continue;
      const start = chainStarts.get(row.id) ?? row.deliveredAt;
      if (!start) continue;
      placementDays.push(rt.containerDays(start, row.pickedUpAt, zone));
    }

    const tickets = ended.map((row) => row.weightTons);
    const tons = rt.averageTons(tickets);

    let exceededCount = 0;
    let billableCount = 0;
    for (const row of ended) {
      if (!row.deliveredAt || !row.pickedUpAt) continue;
      const days = rt.containerDays(row.deliveredAt, row.pickedUpAt, zone);
      const over = rt.exceeded({
        days,
        includedDays: row.includedDays,
        tons: row.weightTons,
        includedTons: row.includedTons,
      });
      if (!over.either) continue;
      exceededCount += 1;
      /**
       * Billable, not billed, and the distinction is the whole metric. A rental
       * that went over its period with no daily rate on it is work already done
       * that nobody can invoice, which is what the pack calls billing leakage.
       * Counting it as billed would report a hundred per cent capture on a fleet
       * giving away days.
       */
      const canBillDays = !over.days || row.overageRate !== null;
      const canBillTons = !over.tons || row.perTonRate !== null;
      if (canBillDays && canBillTons) billableCount += 1;
    }

    return {
      from: input.from,
      to: input.to,
      windowDays,
      utilisationRate: rt.utilisation({ rentedDays: Number(rented?.days ?? "0"), availableDays }),
      rentedDays: Number(rented?.days ?? "0"),
      availableDays,
      outOfServiceUnits: outOfService,
      averageDurationDays: rt.averageDuration(placementDays),
      rentalsEnded: placementDays.length,
      averageTonsPerHaul: tons.average,
      haulsWithTicket: tons.withTicket,
      haulsWithoutTicket: tons.withoutTicket,
      overageCaptureRate: rt.overageCapture({ exceeded: exceededCount, billed: billableCount }),
      exceededRentals: exceededCount,
      billableRentals: billableCount,
    };
  });
}

const isSwappedFrom = (
  rows: readonly { previousRentalId: string | null }[], id: string,
) => rows.some((row) => row.previousRentalId === id);

/**
 * Where each placement began, following `previous_rental_id` back.
 *
 * Loads the ancestors that are not already in hand, which matters because a
 * chain can start before the report's window: a container delivered in March,
 * swapped in April and collected in May is one placement that started in March,
 * and a report for May that stopped at the April row would call it a one month
 * hire.
 */
async function startsFor(
  tx: Database,
  ctx: ServiceContext,
  rows: readonly { id: string; deliveredAt: Date | null; previousRentalId: string | null }[],
): Promise<Map<string, Date | null>> {
  const known = new Map<string, { deliveredAt: Date | null; previousRentalId: string | null }>();
  for (const row of rows) {
    known.set(row.id, { deliveredAt: row.deliveredAt, previousRentalId: row.previousRentalId });
  }

  /** Bounded, because a cycle in the chain must not hang a report. */
  for (let depth = 0; depth < 50; depth += 1) {
    const missing = [...known.values()]
      .map((row) => row.previousRentalId)
      .filter((id): id is string => id !== null && !known.has(id));
    if (missing.length === 0) break;
    const found = await tx.select({
      id: schema.rental.id,
      deliveredAt: schema.rental.deliveredAt,
      previousRentalId: schema.rental.previousRentalId,
    })
      .from(schema.rental)
      .where(and(
        eq(schema.rental.organizationId, ctx.actor.organizationId),
        inArray(schema.rental.id, [...new Set(missing)]),
      ));
    if (found.length === 0) break;
    for (const row of found) {
      known.set(row.id, { deliveredAt: row.deliveredAt, previousRentalId: row.previousRentalId });
    }
  }

  const starts = new Map<string, Date | null>();
  for (const row of rows) {
    let cursor: string | null = row.id;
    let start: Date | null = row.deliveredAt;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node: { deliveredAt: Date | null; previousRentalId: string | null } | undefined =
        known.get(cursor);
      if (!node) break;
      if (node.deliveredAt) start = node.deliveredAt;
      cursor = node.previousRentalId;
    }
    starts.set(row.id, start);
  }
  return starts;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  addRentableAsset: (ctx: ServiceContext, input: AssetInput) => addAsset(ctx, input),
  listRentableAssets: listAssets,
  tagAssetOutOfService: (ctx: ServiceContext, input: { id: string; reason: string }) =>
    tagOutOfService(ctx, input),
  returnAssetToService: (ctx: ServiceContext, input: { id: string }) => returnToService(ctx, input),
  retireRentableAsset: (ctx: ServiceContext, input: { id: string }) => retireAsset(ctx, input),
  deliverRental: (ctx: ServiceContext, input: DeliverInput) => deliver(ctx, input),
  pickUpRental: (ctx: ServiceContext, input: PickUpInput) => pickUp(ctx, input),
  swapRental: (ctx: ServiceContext, input: SwapInput) => swap(ctx, input),
  getRental,
  listRentals,
  getRentalOverage: (ctx: ServiceContext, input: { id: string }) => overage(ctx, input),
  getFleetReport: (ctx: ServiceContext, input: { from: string; to: string }) =>
    fleetReport(ctx, input),
} as const;
