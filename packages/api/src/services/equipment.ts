import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { time } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf, type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * THE EQUIPMENT AT AN ADDRESS
 *
 * `equipment` has been in the schema since the first migrations and nine
 * other tables point at it: a job names the unit it is about, an entitlement
 * names the unit a warranty covers, a deficiency names the unit that failed,
 * a service report names the unit it describes.
 *
 * Two things touched it. The field app could record a unit found on site.
 * The property read could COUNT them. So the property screen said "12 units
 * here" and there was no way in the product to see what they were, how old
 * they were, or whether any of them were still under warranty. The count was
 * the whole feature.
 *
 * For a service trade that is not a missing screen, it is the missing
 * product. What is at this address, how old is it, is it covered, and what
 * did we do to it last time are the four questions every call starts with.
 *
 * THE SERIAL NUMBER IS THE IDENTITY, which the field sync already says:
 * "the only identifier that survives a customer moving out and the next
 * owner calling. Matching on anything softer produces a second record for
 * the same furnace and splits ten years of history down the middle."
 *
 * WARRANTY IS DERIVED FROM THE DATES, never a stored flag. A flag is a fact
 * that was true when somebody wrote it and is false now, and the answer to
 * "is this covered" is only ever about today.
 *
 * A UNIT THAT MOVES KEEPS ITS ROW. That is what `equipment_move` is for, and
 * it had no writer: a landlord moving a water heater between two rentals, or
 * a warranty swap, produced either a new record with no history or an edit
 * that silently rewrote where the old work happened.
 */

export const MOVE_REASONS = [
  "relocated", "swapped_under_warranty", "replaced", "removed", "returned",
] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];

export interface EquipmentInput {
  propertyId: string;
  category: string;
  tag?: string | null | undefined;
  manufacturer?: string | null | undefined;
  model?: string | null | undefined;
  serialNumber?: string | null | undefined;
  installedOn?: string | null | undefined;
  installedByUs?: boolean | undefined;
  warrantyPartsExpiresOn?: string | null | undefined;
  warrantyLaborExpiresOn?: string | null | undefined;
  location?: string | null | undefined;
  parentEquipmentId?: string | null | undefined;
  attributes?: Record<string, unknown> | undefined;
}

/* -------------------------------------------------------------- the register */

export async function register(ctx: ServiceContext, input: EquipmentInput) {
  return guardedWrite(ctx, "equipment:write", async (tx) => {
    const category = input.category.trim();
    if (category === "") {
      throw new ConflictError("Equipment needs a category. It is how a technician finds it on a list.");
    }

    const [property] = await tx.select({ id: schema.property.id }).from(schema.property)
      .where(and(eq(schema.property.id, input.propertyId), isNull(schema.property.deletedAt)))
      .limit(1);
    if (!property) throw new NotFoundError("Property");

    const serial = input.serialNumber?.trim() || null;
    if (serial) {
      /**
       * THE SPLIT HISTORY GUARD. Two records for the same furnace is the
       * failure this whole table exists to avoid, and it happens most often
       * when the office adds a unit the phone already recorded.
       */
      const [twin] = await tx.select({ id: schema.equipment.id, tag: schema.equipment.tag })
        .from(schema.equipment)
        .where(and(
          eq(schema.equipment.organizationId, ctx.actor.organizationId),
          eq(schema.equipment.propertyId, input.propertyId),
          eq(schema.equipment.serialNumber, serial),
          isNull(schema.equipment.deletedAt),
        )).limit(1);
      if (twin) {
        throw new ConflictError(
          `Serial ${serial} is already on file at this property${twin.tag ? ` as ${twin.tag}` : ""}. `
          + "Two records for one unit split its history down the middle. Edit the existing one instead.",
        );
      }
    }

    if (input.parentEquipmentId) await assertParent(tx, ctx, input.parentEquipmentId, input.propertyId);

    if (input.warrantyPartsExpiresOn && input.installedOn
        && input.warrantyPartsExpiresOn < input.installedOn) {
      throw new ConflictError("That parts warranty expires before the unit was installed.");
    }

    const [row] = await tx.insert(schema.equipment).values({
      organizationId: ctx.actor.organizationId,
      propertyId: input.propertyId,
      parentEquipmentId: input.parentEquipmentId ?? null,
      tag: input.tag?.trim() || null,
      category,
      manufacturer: input.manufacturer?.trim() || null,
      model: input.model?.trim() || null,
      serialNumber: serial,
      installedOn: input.installedOn ?? null,
      installedByUs: input.installedByUs ?? false,
      warrantyPartsExpiresOn: input.warrantyPartsExpiresOn ?? null,
      warrantyLaborExpiresOn: input.warrantyLaborExpiresOn ?? null,
      location: input.location?.trim() || null,
      attributes: input.attributes ?? {},
    }).returning();

    await audit(tx, ctx, "equipment.registered", "equipment", row!.id, null, row!);
    return row!;
  });
}

/**
 * A unit cannot be its own parent, nor a child of something at another
 * address. A riser at one building holding a valve at another is not a
 * mistake somebody recovers from by reading the screen.
 */
async function assertParent(
  tx: Database, ctx: ServiceContext, parentId: string, propertyId: string, selfId?: string,
) {
  if (selfId && parentId === selfId) {
    throw new ConflictError("A unit cannot be inside itself.");
  }
  const [parent] = await tx.select({
    id: schema.equipment.id, propertyId: schema.equipment.propertyId,
    parentEquipmentId: schema.equipment.parentEquipmentId,
  }).from(schema.equipment)
    .where(and(
      eq(schema.equipment.id, parentId),
      eq(schema.equipment.organizationId, ctx.actor.organizationId),
      isNull(schema.equipment.deletedAt),
    )).limit(1);
  if (!parent) throw new NotFoundError("Parent equipment");
  if (parent.propertyId !== propertyId) {
    throw new ConflictError("That parent is at a different property.");
  }
  /**
   * One step is enough to catch the loop somebody actually makes, which is
   * swapping a parent and a child. A deeper cycle needs a walk, and the walk
   * is below in `treeFor`, where it is bounded and cannot spin.
   */
  if (selfId && parent.parentEquipmentId === selfId) {
    throw new ConflictError("Those two are already nested the other way round.");
  }
}

export async function update(
  ctx: ServiceContext, input: Partial<EquipmentInput> & { id: string },
) {
  return guardedWrite(ctx, "equipment:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);

    const propertyId = input.propertyId ?? before.propertyId;
    if (input.propertyId && input.propertyId !== before.propertyId) {
      /**
       * MOVING A UNIT IS ITS OWN OPERATION, not a field on a patch. The
       * move record is the only thing that says where work happened before
       * today, and letting an edit quietly change the address means an
       * invoice from 2024 describes a job at an address the unit has never
       * been to.
       */
      throw new ConflictError(
        "Changing the property on a unit would rewrite where its past work happened. Record a move instead.",
      );
    }

    if (input.parentEquipmentId) {
      await assertParent(tx, ctx, input.parentEquipmentId, propertyId, input.id);
    }

    const serial = input.serialNumber !== undefined
      ? (input.serialNumber?.trim() || null) : before.serialNumber;
    if (serial && serial !== before.serialNumber) {
      const [twin] = await tx.select({ id: schema.equipment.id }).from(schema.equipment)
        .where(and(
          eq(schema.equipment.organizationId, ctx.actor.organizationId),
          eq(schema.equipment.propertyId, propertyId),
          eq(schema.equipment.serialNumber, serial),
          isNull(schema.equipment.deletedAt),
        )).limit(1);
      if (twin) throw new ConflictError(`Serial ${serial} is already on file at this property.`);
    }

    const [after] = await tx.update(schema.equipment).set({
      tag: input.tag !== undefined ? (input.tag?.trim() || null) : before.tag,
      category: input.category?.trim() || before.category,
      manufacturer: input.manufacturer !== undefined
        ? (input.manufacturer?.trim() || null) : before.manufacturer,
      model: input.model !== undefined ? (input.model?.trim() || null) : before.model,
      serialNumber: serial,
      installedOn: input.installedOn !== undefined ? input.installedOn : before.installedOn,
      installedByUs: input.installedByUs ?? before.installedByUs,
      warrantyPartsExpiresOn: input.warrantyPartsExpiresOn !== undefined
        ? input.warrantyPartsExpiresOn : before.warrantyPartsExpiresOn,
      warrantyLaborExpiresOn: input.warrantyLaborExpiresOn !== undefined
        ? input.warrantyLaborExpiresOn : before.warrantyLaborExpiresOn,
      location: input.location !== undefined ? (input.location?.trim() || null) : before.location,
      parentEquipmentId: input.parentEquipmentId !== undefined
        ? input.parentEquipmentId : before.parentEquipmentId,
      attributes: input.attributes ?? before.attributes,
      updatedAt: new Date(),
    }).where(eq(schema.equipment.id, input.id)).returning();

    await audit(tx, ctx, "equipment.updated", "equipment", input.id, before, after!);
    return after!;
  });
}

/**
 * Take a unit off the register, without losing that it was there.
 *
 * Soft, because an invoice, a deficiency and a service report all name it.
 * A hard delete leaves those describing work on nothing, which is a worse
 * record than one that says the unit was removed in March.
 */
export async function retire(
  ctx: ServiceContext, input: { id: string; reason: string; on?: string },
) {
  return guardedWrite(ctx, "equipment:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    const reason = input.reason.trim();
    if (reason === "") {
      throw new ConflictError("Retiring a unit needs a reason. It is what the next technician reads.");
    }

    const [child] = await tx.select({ id: schema.equipment.id }).from(schema.equipment)
      .where(and(
        eq(schema.equipment.parentEquipmentId, input.id),
        isNull(schema.equipment.deletedAt),
      )).limit(1);
    if (child) {
      /**
       * Retiring a riser while its valves are live leaves them parented to
       * something the register no longer shows, so they vanish from the
       * tree and stay in the table.
       */
      throw new ConflictError(
        "Other units are inside this one. Retire or re-parent them first, or they disappear from the register.",
      );
    }

    const on = input.on ?? time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));

    await tx.insert(schema.equipmentMove).values({
      organizationId: ctx.actor.organizationId,
      equipmentId: input.id,
      fromPropertyId: before.propertyId,
      toPropertyId: null,
      reason: "removed",
      movedOn: on,
      notes: reason,
    });

    const [after] = await tx.update(schema.equipment)
      .set({ active: false, deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.equipment.id, input.id))
      .returning();

    await audit(tx, ctx, "equipment.retired", "equipment", input.id, before, after!);
    return { id: input.id, retired: true as const, on, reason };
  });
}

/**
 * Record that a unit went somewhere.
 *
 * `equipment_move` was written in the first migrations and had no writer, so
 * a landlord moving a water heater between two rentals, or a warranty swap,
 * produced either a second record with no history or an edit that silently
 * rewrote where the old work happened.
 *
 * The ROW MOVES AND THE HISTORY STAYS. Every job, invoice and deficiency
 * still points at the same unit, and the move record is what explains why a
 * 2024 service call was at a different address.
 */
export async function move(
  ctx: ServiceContext,
  input: {
    id: string; reason: MoveReason; toPropertyId?: string | null;
    movedOn?: string; jobId?: string | null; notes?: string | null;
  },
) {
  return guardedWrite(ctx, "equipment:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);

    if (!(MOVE_REASONS as readonly string[]).includes(input.reason)) {
      throw new ConflictError(
        `"${input.reason}" is not a reason a unit moves. One of: ${MOVE_REASONS.join(", ")}.`,
      );
    }

    const goesSomewhere = input.reason === "relocated"
      || input.reason === "swapped_under_warranty" || input.reason === "returned";
    if (goesSomewhere && !input.toPropertyId) {
      throw new ConflictError(`A unit that was ${input.reason.replace(/_/g, " ")} went somewhere. Name the property.`);
    }
    if (input.toPropertyId) {
      const [target] = await tx.select({ id: schema.property.id }).from(schema.property)
        .where(and(eq(schema.property.id, input.toPropertyId), isNull(schema.property.deletedAt)))
        .limit(1);
      if (!target) throw new NotFoundError("Property");
      if (input.toPropertyId === before.propertyId) {
        throw new ConflictError("That is where it already is.");
      }
    }

    const on = input.movedOn ?? time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));

    const [record] = await tx.insert(schema.equipmentMove).values({
      organizationId: ctx.actor.organizationId,
      equipmentId: input.id,
      fromPropertyId: before.propertyId,
      toPropertyId: input.toPropertyId ?? null,
      reason: input.reason,
      movedOn: on,
      jobId: input.jobId ?? null,
      notes: input.notes?.trim() || null,
    }).returning();

    /**
     * Children go with it. A riser's valves do not stay at the old address
     * when the riser leaves, and leaving them would put a parent and its
     * children at two properties, which `assertParent` refuses to create
     * and this would create anyway.
     */
    const moved = input.toPropertyId
      ? await tx.update(schema.equipment)
          .set({ propertyId: input.toPropertyId, updatedAt: new Date() })
          .where(and(
            eq(schema.equipment.organizationId, ctx.actor.organizationId),
            sql`(${schema.equipment.id} = ${input.id} or ${schema.equipment.parentEquipmentId} = ${input.id})`,
            isNull(schema.equipment.deletedAt),
          ))
          .returning({ id: schema.equipment.id })
      : [];

    /**
     * Replaced and removed both mean it is not working there any more, so
     * the register stops showing it. Relocated does not: it is still ours
     * and still live, at a different address.
     */
    if (input.reason === "replaced" || input.reason === "removed") {
      await tx.update(schema.equipment)
        .set({ active: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.equipment.id, input.id));
    }

    await audit(tx, ctx, "equipment.moved", "equipment", input.id, before, record!);
    return {
      id: input.id,
      reason: input.reason,
      movedOn: on,
      /** Includes the children that went with it, so a screen can say how many. */
      unitsMoved: moved.length,
    };
  });
}

/* -------------------------------------------------------------- reading it */

/**
 * The register at a property, nested.
 *
 * `parent_equipment_id` exists because assets nest: a riser has valves, a
 * rooftop unit has a compressor. A flat list of two hundred rows at a
 * commercial site is a list nobody reads, and the nesting is the difference
 * between a register and a dump.
 */
export async function atProperty(
  ctx: ServiceContext, input: { propertyId: string; on?: string },
) {
  return guardedRead(ctx, "equipment:read", async (tx) => {
    const today = input.on ?? time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));

    const rows = await tx.select().from(schema.equipment)
      .where(and(
        eq(schema.equipment.organizationId, ctx.actor.organizationId),
        eq(schema.equipment.propertyId, input.propertyId),
        isNull(schema.equipment.deletedAt),
      ))
      .orderBy(asc(schema.equipment.category), asc(schema.equipment.tag));

    return treeFor(rows.map((row) => shape(row, today)));
  });
}

export interface EquipmentView extends ReturnType<typeof shape> {
  children?: EquipmentView[];
}

/**
 * Nest the flat rows, with a bound.
 *
 * `parent_equipment_id` has no foreign key to itself in the schema, so a
 * cycle is possible in the data however carefully the writes are guarded,
 * and a recursive build over a cycle does not return. Depth is capped and
 * anything left over is emitted at the top rather than dropped: a unit
 * nobody can see is worse than one shown in the wrong place.
 */
function treeFor(rows: ReturnType<typeof shape>[]): EquipmentView[] {
  const byId = new Map(rows.map((row) => [row.id, { ...row } as EquipmentView]));

  /**
   * ROOTEDNESS IS DECIDED BEFORE ANYTHING IS LINKED.
   *
   * The first version of this nested first and checked afterwards, which
   * cannot work: by the time the check runs the cycle is already in the
   * object graph, and the read throws on serialisation rather than
   * returning a wrong shape. A page that 500s because two rows point at
   * each other is worse than one that shows them side by side.
   */
  const rooted = new Set<string>();
  const looping = new Set<string>();
  for (const row of byId.values()) {
    const path = new Set<string>();
    let current: EquipmentView | undefined = row;
    let depth = 0;
    while (current && current.parentEquipmentId && depth < 32) {
      if (path.has(current.id)) break;
      path.add(current.id);
      const next: EquipmentView | undefined = byId.get(current.parentEquipmentId);
      if (!next || next.id === current.id) break;
      if (path.has(next.id)) { for (const id of path) looping.add(id); break; }
      current = next;
      depth += 1;
    }
    if (!looping.has(row.id)) rooted.add(row.id);
  }

  const top: EquipmentView[] = [];
  for (const row of byId.values()) {
    const parent = row.parentEquipmentId ? byId.get(row.parentEquipmentId) : undefined;
    /**
     * A unit in a cycle is shown at the top with its parent link intact,
     * rather than dropped. A unit nobody can see is worse than one in the
     * wrong place, and the link is what somebody needs to fix it.
     */
    if (!parent || parent.id === row.id || looping.has(row.id) || !rooted.has(row.id)) {
      top.push(row);
      continue;
    }
    (parent.children ??= []).push(row);
  }
  return top;
}

/** One unit, with everything known about it. */
export async function get(ctx: ServiceContext, input: { id: string; on?: string }) {
  return guardedRead(ctx, "equipment:read", async (tx) => {
    const row = await load(tx, ctx.actor.organizationId, input.id, { includeRetired: true });
    const today = input.on ?? time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));

    const moves = await tx.select({
      id: schema.equipmentMove.id,
      reason: schema.equipmentMove.reason,
      movedOn: schema.equipmentMove.movedOn,
      fromPropertyId: schema.equipmentMove.fromPropertyId,
      toPropertyId: schema.equipmentMove.toPropertyId,
      notes: schema.equipmentMove.notes,
    }).from(schema.equipmentMove)
      .where(eq(schema.equipmentMove.equipmentId, input.id))
      .orderBy(desc(schema.equipmentMove.movedOn));

    return { ...shape(row, today), moves };
  });
}

/**
 * What we have done to this unit.
 *
 * From the jobs that named it and the visits that worked it, rather than
 * from a log nobody writes. The question a technician asks standing in front
 * of a furnace is "what happened last time", and the answer already exists
 * scattered across two tables that both carry the equipment id and that
 * nothing has ever joined.
 */
export async function history(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "equipment:read", async (tx) => {
    await load(tx, ctx.actor.organizationId, input.id, { includeRetired: true });

    const jobs = await tx.select({
      id: schema.job.id,
      number: schema.job.number,
      summary: schema.job.summary,
      status: schema.job.status,
      completedAt: schema.job.completedAt,
      createdAt: schema.job.createdAt,
    }).from(schema.job)
      .where(and(
        eq(schema.job.organizationId, ctx.actor.organizationId),
        eq(schema.job.equipmentId, input.id),
        isNull(schema.job.deletedAt),
      ))
      .orderBy(desc(schema.job.createdAt));

    /**
     * Visits that recorded an outcome against this unit, which is how
     * inspection work touches equipment it is not the subject of: a job
     * about one rooftop unit can carry readings for eight.
     */
    const inspected = await tx.select({
      visitId: schema.visitAsset.visitId,
      outcome: schema.visitAsset.outcome,
      notes: schema.visitAsset.notes,
      completedAt: schema.visitAsset.completedAt,
      jobId: schema.visit.jobId,
    }).from(schema.visitAsset)
      .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAsset.visitId))
      .where(and(
        eq(schema.visitAsset.organizationId, ctx.actor.organizationId),
        eq(schema.visitAsset.equipmentId, input.id),
      ))
      .orderBy(desc(schema.visitAsset.completedAt));

    const deficiencies = await tx.select({
      id: schema.deficiency.id,
      status: schema.deficiency.status,
      severity: schema.deficiency.severity,
      code: schema.deficiency.code,
      createdAt: schema.deficiency.createdAt,
    }).from(schema.deficiency)
      .where(and(
        eq(schema.deficiency.organizationId, ctx.actor.organizationId),
        eq(schema.deficiency.equipmentId, input.id),
      ))
      .orderBy(desc(schema.deficiency.createdAt));

    return { jobs, inspected, deficiencies };
  });
}

/**
 * Units whose warranty runs out soon, or just has.
 *
 * The list worth acting on, which a stored flag could never produce: it
 * changes every day without anything being written. The window looks BACK as
 * well as forward, because a warranty that lapsed last month is the call
 * worth making, and a report that only looks forward silently stops
 * mentioning anything the moment it expires.
 */
export async function warrantyWatch(
  ctx: ServiceContext, input: { withinDays?: number; on?: string } = {},
) {
  return guardedRead(ctx, "equipment:read", async (tx) => {
    const today = input.on ?? time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const days = input.withinDays ?? 90;
    const from = shiftDays(today, -days);
    const to = shiftDays(today, days);

    const rows = await tx.select({
      equipment: schema.equipment,
      line1: schema.property.addressLine1,
      city: schema.property.city,
    }).from(schema.equipment)
      .innerJoin(schema.property, eq(schema.property.id, schema.equipment.propertyId))
      .where(and(
        eq(schema.equipment.organizationId, ctx.actor.organizationId),
        isNull(schema.equipment.deletedAt),
        sql`(
          (${schema.equipment.warrantyPartsExpiresOn} between ${from} and ${to})
          or (${schema.equipment.warrantyLaborExpiresOn} between ${from} and ${to})
        )`,
      ));

    return rows
      .map(({ equipment, line1, city }) => ({
        ...shape(equipment, today),
        address: [line1, city].filter(Boolean).join(", "),
      }))
      .sort((a, b) => (a.warranty.soonestExpiry ?? "").localeCompare(b.warranty.soonestExpiry ?? ""));
  });
}

/* ------------------------------------------------------------------ shape */

function shape(row: typeof schema.equipment.$inferSelect, today: string) {
  /**
   * WARRANTY IS COMPUTED HERE AND STORED NOWHERE. A boolean written into a
   * column is a fact that was true on the day somebody wrote it, and the
   * only question anybody asks of a warranty is about today.
   *
   * Parts and labour are separate because they expire separately, and a
   * single "under warranty" would make somebody quote a free repair whose
   * labour is not covered. That conversation is why the two columns exist.
   */
  const parts = row.warrantyPartsExpiresOn;
  const labour = row.warrantyLaborExpiresOn;

  /**
   * THE NEXT EXPIRY, not the earliest date on the row.
   *
   * A furnace whose labour cover ended in 2019 and whose parts cover runs to
   * 2028 has one date worth acting on and it is 2028. Taking the minimum of
   * both gave 2019, so the unit read as "lapsed nine years ago" on a
   * worklist sorted by urgency, and every unit with an expired labour
   * warranty crowded the top of a list of things about to lose cover.
   *
   * When everything has already lapsed the MOST RECENT past date wins, so a
   * unit that went out of cover last month sorts above one that went out in
   * 2014.
   */
  const dates = [parts, labour].filter((d): d is string => d !== null);
  const future = dates.filter((d) => d >= today).sort();
  const past = dates.filter((d) => d < today).sort();
  const soonest = future[0] ?? past[past.length - 1] ?? null;

  return {
    id: row.id,
    propertyId: row.propertyId,
    parentEquipmentId: row.parentEquipmentId,
    tag: row.tag,
    category: row.category,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serialNumber,
    installedOn: row.installedOn,
    installedByUs: row.installedByUs,
    location: row.location,
    attributes: row.attributes,
    active: row.active,
    retired: row.deletedAt !== null,
    /** Whole years, floor. Nobody says a furnace is eleven and a half. */
    ageYears: row.installedOn ? yearsBetween(row.installedOn, today) : null,
    warranty: {
      partsExpiresOn: parts,
      labourExpiresOn: labour,
      partsCovered: parts !== null && parts >= today,
      labourCovered: labour !== null && labour >= today,
      soonestExpiry: soonest,
      /** Negative once past, so one number sorts a worklist in both directions. */
      daysUntilSoonest: soonest ? dayDiff(soonest, today) : null,
    },
  };
}

async function load(
  tx: Database, organizationId: string, id: string,
  options: { includeRetired?: boolean } = {},
) {
  const [row] = await tx.select().from(schema.equipment)
    .where(and(
      eq(schema.equipment.id, id),
      eq(schema.equipment.organizationId, organizationId),
      ...(options.includeRetired ? [] : [isNull(schema.equipment.deletedAt)]),
    )).limit(1);
  if (!row) throw new NotFoundError("Equipment");
  return row;
}

const DAY = 86_400_000;
const shiftDays = (date: string, by: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10);
const dayDiff = (later: string, earlier: string): number =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY);

function yearsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  let years = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) years -= 1;
  return Math.max(0, years);
}
