import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";

/**
 * THE UNITS ONE VISIT COVERS, AND WHAT HAPPENED TO EACH
 *
 * `visit_asset` shipped in the first migration and nothing wrote it. One
 * service read it, and the comment there says exactly what it was for:
 *
 *   "Visits that recorded an outcome against this unit, which is how
 *   inspection work touches equipment it is not the subject of: a job about
 *   one rooftop unit can carry readings for eight."
 *
 * So the equipment history had a section for per-unit outcomes that was
 * always empty, and `unwritten-columns.test.ts` carried
 * `visitAsset.completedAt` as a known gap: a query whose answer was decided
 * before it ran.
 *
 * WHY A JOB'S OWN `equipment_id` IS NOT ENOUGH, which is the whole reason
 * this table exists. A job names ONE unit: the one somebody rang about. A
 * commercial building with eight rooftop units has one maintenance job and
 * eight machines, each with its own filter, its own superheat and its own
 * verdict. Hanging that off `job.equipment_id` would record the visit against
 * one machine and lose seven, and hanging it off a service report's fields
 * would record the readings and not which unit was done, which is the
 * question a building manager asks.
 *
 * ON PERMISSIONS. `visit:read` and `visit:write`, both already in the
 * catalogue. This is a property of a visit rather than of a machine: it says
 * what the visit covers. Using an `equipment:*` permission would mean the
 * person who may plan a day cannot say what is on it.
 */

/**
 * What happened to one unit on one visit.
 *
 * A CLOSED SET, because an open string is how a report ends up with
 * "complete", "completed", "done" and "Done" as four different outcomes, and
 * any count over them is wrong in a way nobody can see. The five below are
 * the distinctions that change what somebody does next:
 *
 *   `serviced`     done, nothing wrong.
 *   `faults_found` done, and there is something to quote. The deficiency
 *                  rows carry what; this is the flag on the unit.
 *   `no_access`    could not get to it. The commonest outcome in commercial
 *                  work and the one that has to be distinguishable from
 *                  skipped, because it is somebody else's fault and it means
 *                  a return trip the customer may owe for.
 *   `skipped`      chose not to, with a note. A judgement rather than an
 *                  obstacle.
 *   `out_of_service` the machine is down and was not worked on.
 */
export const OUTCOMES = [
  "serviced", "faults_found", "no_access", "skipped", "out_of_service",
] as const;

export type Outcome = typeof OUTCOMES[number];

export interface VisitAssetView {
  id: string;
  visitId: string;
  equipmentId: string;
  /**
   * What the unit is called, so a list is readable without a second query.
   *
   * The tag, the category and the model joined: a tag alone means nothing to
   * anybody who has not been on the roof, and a model alone does not say
   * which of the eight.
   */
  equipmentLabel: string | null;
  sequence: number;
  outcome: Outcome | null;
  notes: string | null;
  completedAt: string | null;
  /** Faults recorded against this unit on this visit's inspection. */
  deficiencyCount: number;
}

/**
 * Say which units this visit covers.
 *
 * REPLACES THE WHOLE LIST rather than adding to it, and the order of the
 * argument is the order of the round: a technician works a roof in a
 * sequence, and `sequence` is what puts the list on the phone in the order
 * they will walk it.
 *
 * Units already recorded as done are NOT removed by a replan. That is the
 * one exception and it is the important one: a dispatcher tidying the list at
 * eleven must not delete the morning's work. They come back as refusals
 * naming what was kept.
 */
export async function plan(
  ctx: ServiceContext,
  input: { visitId: string; equipmentIds: string[] },
): Promise<{ planned: number; kept: number }> {
  return guardedWrite(ctx, "visit:write", async (tx) => {
    const visit = await loadVisit(tx, ctx.actor.organizationId, input.visitId);

    const wanted: string[] = [];
    const seen = new Set<string>();
    for (const id of input.equipmentIds) {
      /**
       * Deduplicated rather than refused, because the same unit twice is a
       * double tap on a picker rather than an intention, and the row carries
       * a unique outcome per unit so the second one could only overwrite the
       * first.
       */
      if (seen.has(id)) continue;
      seen.add(id);
      wanted.push(id);
    }

    if (wanted.length > 0) {
      const known = await tx.select({ id: schema.equipment.id }).from(schema.equipment)
        .where(and(
          eq(schema.equipment.organizationId, ctx.actor.organizationId),
          inArray(schema.equipment.id, wanted),
          isNull(schema.equipment.deletedAt),
        ));
      if (known.length !== wanted.length) {
        const found = new Set(known.map((k) => k.id));
        throw new NotFoundError(
          `Equipment ${wanted.filter((id) => !found.has(id))[0]}`,
        );
      }

      /**
       * Every unit has to be at the property the visit is going to.
       *
       * Refused rather than allowed, because the alternative is a visit that
       * records work on a machine nobody went to see. The equipment register
       * is per property for exactly this reason, and a job that genuinely
       * covers two addresses is two visits.
       */
      const elsewhere = await tx.select({ id: schema.equipment.id })
        .from(schema.equipment)
        .where(and(
          eq(schema.equipment.organizationId, ctx.actor.organizationId),
          inArray(schema.equipment.id, wanted),
          sql`${schema.equipment.propertyId} <> ${visit.propertyId}`,
        ));
      if (elsewhere.length > 0) {
        throw new ConflictError(
          "Some of that equipment is at a different property from this visit. A visit covers "
          + "one address: work at a second one is a second visit.",
        );
      }
    }

    const existing = await tx.select().from(schema.visitAsset)
      .where(and(
        eq(schema.visitAsset.organizationId, ctx.actor.organizationId),
        eq(schema.visitAsset.visitId, input.visitId),
      ));

    const done = existing.filter((row) => row.completedAt !== null);
    const keep = new Set(done.map((row) => row.equipmentId));

    const dropped = existing.filter((row) => row.completedAt === null
      && !wanted.includes(row.equipmentId));
    if (dropped.length > 0) {
      await tx.delete(schema.visitAsset)
        .where(and(
          eq(schema.visitAsset.organizationId, ctx.actor.organizationId),
          inArray(schema.visitAsset.id, dropped.map((row) => row.id)),
        ));
    }

    const already = new Map(existing.map((row) => [row.equipmentId, row]));
    let sequence = 0;
    for (const equipmentId of wanted) {
      const row = already.get(equipmentId);
      if (row) {
        await tx.update(schema.visitAsset)
          .set({ sequence, updatedAt: new Date() })
          .where(eq(schema.visitAsset.id, row.id));
      } else {
        await tx.insert(schema.visitAsset).values({
          organizationId: ctx.actor.organizationId,
          visitId: input.visitId,
          equipmentId,
          sequence,
        });
      }
      sequence += 1;
    }

    /**
     * Anything already done and not in the new list keeps its place at the
     * end, so the round is the new plan followed by what was finished before
     * it changed. Renumbered rather than left with its old sequence, because
     * two rows sharing one puts the phone's list in whichever order the
     * database returned them.
     */
    for (const row of done) {
      if (wanted.includes(row.equipmentId)) continue;
      await tx.update(schema.visitAsset)
        .set({ sequence, updatedAt: new Date() })
        .where(eq(schema.visitAsset.id, row.id));
      sequence += 1;
    }

    await audit(
      tx, ctx, "visit_asset.planned", "visit", input.visitId,
      { units: existing.length }, { units: sequence, kept: keep.size },
    );

    return { planned: wanted.length, kept: keep.size };
  });
}

/**
 * Record what happened to one unit.
 *
 * `completed_at` IS SET HERE AND ONLY HERE, which is what made it a known
 * gap: the equipment history ordered by it and nothing ever wrote one.
 *
 * Takes the moment from the caller rather than the clock, because the field
 * app records a round in a basement and syncs it an hour later. Taking
 * `now()` would stamp eight units with the moment the phone found signal and
 * lose the order they were actually done in, which on a roof is the order
 * somebody walked.
 */
export async function recordOutcome(
  ctx: ServiceContext,
  input: {
    visitId: string;
    equipmentId: string;
    outcome: Outcome;
    notes?: string | null | undefined;
    at?: string | undefined;
  },
): Promise<VisitAssetView> {
  return guardedWrite(ctx, "visit:write", async (tx) => {
    const [row] = await tx.select().from(schema.visitAsset)
      .where(and(
        eq(schema.visitAsset.organizationId, ctx.actor.organizationId),
        eq(schema.visitAsset.visitId, input.visitId),
        eq(schema.visitAsset.equipmentId, input.equipmentId),
      ));
    if (!row) {
      throw new ConflictError(
        "That unit is not on this visit. Add it to the visit first: recording an outcome "
        + "against a machine nobody planned to see is how a round ends up with work that "
        + "was never dispatched.",
      );
    }

    const notes = input.notes?.trim() || null;
    /**
     * `skipped` NEEDS A REASON AND THE OTHERS DO NOT.
     *
     * Every other outcome says what happened. Skipped says somebody decided
     * not to, and that decision is the one a customer asks about: a round
     * with three units skipped and no notes is a conversation nobody can
     * have. `no_access` deliberately does not require one, because the
     * reason is in the word.
     */
    if (input.outcome === "skipped" && notes === null) {
      throw new ConflictError(
        "Skipping a unit needs a note saying why. Every other outcome says what happened; "
        + "this one says somebody decided, and that is what gets asked about.",
      );
    }

    const at = input.at ? new Date(input.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      throw new ConflictError("That is not a time this platform can read.");
    }

    const [updated] = await tx.update(schema.visitAsset).set({
      outcome: input.outcome,
      notes,
      completedAt: at,
      updatedAt: new Date(),
    }).where(eq(schema.visitAsset.id, row.id)).returning();

    await audit(
      tx, ctx, "visit_asset.outcome_recorded", "visit_asset", row.id, row, updated!,
    );

    return (await viewsWithin(tx, ctx.actor.organizationId, input.visitId))
      .find((view) => view.equipmentId === input.equipmentId)!;
  });
}

/** The round, in the order it is to be walked. */
export async function forVisit(
  ctx: ServiceContext, input: { visitId: string },
): Promise<{ units: VisitAssetView[] }> {
  return guardedRead(ctx, "visit:read", async (tx) =>
    ({ units: await viewsWithin(tx, ctx.actor.organizationId, input.visitId) }));
}

async function viewsWithin(
  tx: Database, organizationId: string, visitId: string,
): Promise<VisitAssetView[]> {
  const rows = await tx.select({
    unit: schema.visitAsset,
    /**
     * The tag the company put on the machine, plus what it is.
     *
     * `equipment` has no single "name": a rooftop unit is identified by the
     * tag somebody stencilled on it (RTU-3) and described by its category and
     * model. Both, because a tag alone is meaningless to anyone who has not
     * been on the roof and a model alone does not say which of the eight.
     */
    tag: schema.equipment.tag,
    category: schema.equipment.category,
    model: schema.equipment.model,
  }).from(schema.visitAsset)
    .leftJoin(schema.equipment, eq(schema.equipment.id, schema.visitAsset.equipmentId))
    .where(and(
      eq(schema.visitAsset.organizationId, organizationId),
      eq(schema.visitAsset.visitId, visitId),
    ))
    .orderBy(asc(schema.visitAsset.sequence));

  if (rows.length === 0) return [];

  /**
   * Faults per unit, from the inspection this visit recorded.
   *
   * Counted in one grouped query rather than per unit, because a roof with
   * eight machines would otherwise be eight round trips on a screen a
   * technician opens between two of them.
   */
  const faults = await tx.select({
    equipmentId: schema.deficiency.equipmentId,
    n: sql<number>`count(*)::int`,
  }).from(schema.deficiency)
    .innerJoin(schema.inspection, eq(schema.inspection.id, schema.deficiency.inspectionId))
    .where(and(
      eq(schema.deficiency.organizationId, organizationId),
      eq(schema.inspection.visitId, visitId),
      inArray(schema.deficiency.equipmentId, rows.map((r) => r.unit.equipmentId)),
    ))
    .groupBy(schema.deficiency.equipmentId);
  const faultsOf = new Map(faults.map((f) => [f.equipmentId, f.n]));

  return rows.map(({ unit, tag, category, model }) => ({
    id: unit.id,
    visitId: unit.visitId,
    equipmentId: unit.equipmentId,
    equipmentLabel: [tag, category, model].filter((part) => part).join(" ") || null,
    sequence: unit.sequence,
    /**
     * Narrowed on the way out rather than trusted. The column is `text` and
     * the set is closed here, so a row written before the set existed, or by
     * hand, reads as unrecorded rather than as a sixth outcome nothing can
     * interpret.
     */
    outcome: isOutcome(unit.outcome) ? unit.outcome : null,
    notes: unit.notes,
    completedAt: unit.completedAt?.toISOString() ?? null,
    deficiencyCount: faultsOf.get(unit.equipmentId) ?? 0,
  }));
}

const isOutcome = (value: string | null): value is Outcome =>
  value !== null && (OUTCOMES as readonly string[]).includes(value);

async function loadVisit(tx: Database, organizationId: string, visitId: string) {
  const [row] = await tx.select({
    id: schema.visit.id,
    propertyId: schema.job.propertyId,
    status: schema.visit.status,
  }).from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .where(and(
      eq(schema.visit.organizationId, organizationId),
      eq(schema.visit.id, visitId),
    ));
  if (!row) throw new NotFoundError("Visit");
  return row;
}

export const handlers = {
  planVisitUnits: (ctx: ServiceContext, input: { visitId: string; equipmentIds: string[] }): Promise<{
    planned: number; kept: number;
  }> => plan(ctx, input),
  recordUnitOutcome: (ctx: ServiceContext, input: {
    visitId: string; equipmentId: string; outcome: Outcome;
    notes?: string | null | undefined; at?: string | undefined;
  }): Promise<VisitAssetView> => recordOutcome(ctx, input),
  getVisitUnits: (ctx: ServiceContext, input: { visitId: string }): Promise<{
    units: VisitAssetView[];
  }> => forVisit(ctx, input),
} as const;
