import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, inspection as insp, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf, type ServiceContext,
} from "./context";
import * as estimates from "./estimates";

/**
 * INSPECTIONS AND THE DEFICIENCY BACKLOG
 *
 * `packages/core/src/inspection` is thirteen hundred lines with forty three
 * exports and it had no caller. Not a thin one: none. Template validation,
 * reading evaluation against ranges, the completeness rollup that refuses to
 * call a half finished inspection a pass, the proposal builder that refuses
 * to price a finding with no evidence behind it, the backlog ageing. All of
 * it written, all of it tested in core, and nothing in the product could
 * reach a line.
 *
 * The three tables were the same story. `inspection` was touched by nothing
 * at all. `deficiency` and `visit_asset` were read by the equipment history
 * I wrote yesterday and written by nothing, which is why that screen's
 * faults section was always empty.
 *
 * So a company doing fire, backflow or boiler work, which is the half of
 * this trade that runs on inspections, had a database ready for it and no
 * way in.
 *
 * TWO SEVERITY VOCABULARIES, ONE OF THEM RIGHT
 *
 * The database enum says critical, major, minor, advisory. Core says safety,
 * failure, wear, recommendation, and attaches a response deadline to each:
 * a safety finding is today, a failure is thirty days, wear is a hundred and
 * eighty, a recommendation has no deadline at all.
 *
 * Core's is the one that decides anything, so it is the one the product
 * thinks in, and the mapping below is stated once rather than re-derived at
 * every call site. The database words survive because trade packs ship them
 * and an authority's own form uses them.
 */
const TO_CORE: Record<string, insp.Severity> = {
  critical: "safety",
  major: "failure",
  minor: "wear",
  advisory: "recommendation",
};
const FROM_CORE: Record<insp.Severity, "critical" | "major" | "minor" | "advisory"> = {
  safety: "critical",
  failure: "major",
  wear: "minor",
  recommendation: "advisory",
};

/**
 * The checkpoint list a trade pack ships, lifted into the template core
 * validates.
 *
 * DERIVED, NEVER STORED ALONGSIDE. Two representations of one programme is
 * the defect this codebase has already produced twice, once in the agreement
 * visit dates and once in the sending number. So `checkpoints` stays the one
 * stored form, this is the one derivation, and a checkpoint list that cannot
 * lift into a valid template is refused when the programme is SAVED rather
 * than discovered when somebody tries to inspect with it.
 *
 * One section, because a flat checkpoint list has no sections in it and
 * inventing them would be this function guessing at structure the author did
 * not write.
 */
export function templateFor(program: {
  name: string;
  standard: string | null;
  checkpoints: {
    key: string; label: string; assetCategory?: string | undefined;
    requiresReading?: boolean | undefined; unit?: string | undefined;
    range?: { min: number | null; max: number | null; borderlineWithin?: number | undefined } | undefined;
    remedies?: { priceBookItemKey: string; label: string; quantity: number; rationale: string }[] | undefined;
    failIsDeficiency?: boolean | undefined;
    severityOnFail?: "critical" | "major" | "minor" | "advisory" | undefined;
  }[];
}): insp.InspectionTemplate {
  return {
    key: "program",
    title: program.name,
    discipline: program.standard ?? "general",
    sections: [{
      key: "checkpoints",
      title: program.name,
      items: program.checkpoints.map((checkpoint) => ({
        key: checkpoint.key,
        prompt: checkpoint.label,
        answer: checkpoint.requiresReading
          ? {
              kind: "reading" as const,
              unit: checkpoint.unit ?? "",
              ...(checkpoint.range ? { range: checkpoint.range } : {}),
            }
          : { kind: "pass_fail" as const },
        /**
         * Only an item that CAN fail carries a failure severity, and core
         * refuses one that can fail without it. `failIsDeficiency: false`
         * is a checkpoint recorded for the record rather than judged, and
         * giving it a severity would manufacture a finding out of an
         * observation.
         */
        ...(checkpoint.remedies ? { remedies: checkpoint.remedies } : {}),
        ...(checkpoint.failIsDeficiency === false
          ? {}
          : { failureSeverity: TO_CORE[checkpoint.severityOnFail ?? "minor"]! }),
      })),
    }],
  };
}

/* ------------------------------------------------------------- programmes */

export interface ProgramInput {
  name: string;
  standard?: string | null | undefined;
  reportAudience?: "customer" | "authority" | "both" | undefined;
  authorityName?: string | null | undefined;
  frequencyMonths?: number | null | undefined;
  checkpoints: {
    key: string; label: string; assetCategory?: string | undefined;
    requiresReading?: boolean | undefined; unit?: string | undefined;
    range?: { min: number | null; max: number | null; borderlineWithin?: number | undefined } | undefined;
    remedies?: { priceBookItemKey: string; label: string; quantity: number; rationale: string }[] | undefined;
    failIsDeficiency?: boolean | undefined;
    severityOnFail?: "critical" | "major" | "minor" | "advisory" | undefined;
  }[];
}

export async function defineProgram(ctx: ServiceContext, input: ProgramInput) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    assertValid(input);

    const [row] = await tx.insert(schema.inspectionProgram).values({
      organizationId: ctx.actor.organizationId,
      name: input.name.trim(),
      standard: input.standard?.trim() || null,
      reportAudience: input.reportAudience ?? "customer",
      authorityName: input.authorityName?.trim() || null,
      frequencyMonths: input.frequencyMonths ?? null,
      checkpoints: input.checkpoints,
    }).returning();

    await audit(tx, ctx, "inspection_program.defined", "inspection_program", row!.id, null, row!);
    return row!;
  });
}

/**
 * Refused at the SAVE, which is the whole point of `validateTemplate` having
 * been written and never called.
 *
 * Its problems are about items that cannot be answered, items that can fail
 * with no stated meaning for the failure, ranges that exclude their own
 * limits. Every one of those is invisible until a technician is standing in
 * a plant room with a phone, and none of them is recoverable there.
 */
function assertValid(input: ProgramInput) {
  if (input.name.trim() === "") throw new ConflictError("A programme needs a name.");
  if (input.checkpoints.length === 0) {
    throw new ConflictError(
      "A programme with no checkpoints inspects nothing and would report every visit as a pass.",
    );
  }
  const verdict = insp.validateTemplate(templateFor({
    name: input.name.trim(),
    standard: input.standard?.trim() ?? null,
    checkpoints: input.checkpoints,
  }));
  if (!verdict.ok) throw new ConflictError(insp.explainTemplateProblems(verdict.problems));
}

/**
 * Change a programme by publishing a new VERSION.
 *
 * An inspection records the version it was performed under, because a report
 * in a compliance file has to keep meaning what it meant. Editing the
 * checkpoints in place rewrites what every past inspection claims to have
 * checked, which is the one thing a compliance record must never do.
 */
export async function reviseProgram(
  ctx: ServiceContext, input: Partial<ProgramInput> & { id: string },
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const before = await loadProgram(tx, ctx.actor.organizationId, input.id);
    const merged: ProgramInput = {
      name: input.name ?? before.name,
      standard: input.standard !== undefined ? input.standard : before.standard,
      reportAudience: input.reportAudience
        ?? (before.reportAudience as "customer" | "authority" | "both"),
      authorityName: input.authorityName !== undefined ? input.authorityName : before.authorityName,
      frequencyMonths: input.frequencyMonths !== undefined
        ? input.frequencyMonths : before.frequencyMonths,
      checkpoints: input.checkpoints ?? before.checkpoints,
    };
    assertValid(merged);

    const [after] = await tx.update(schema.inspectionProgram).set({
      name: merged.name.trim(),
      standard: merged.standard?.trim() || null,
      reportAudience: merged.reportAudience ?? "customer",
      authorityName: merged.authorityName?.trim() || null,
      frequencyMonths: merged.frequencyMonths ?? null,
      checkpoints: merged.checkpoints,
      version: before.version + 1,
      updatedAt: new Date(),
    }).where(eq(schema.inspectionProgram.id, input.id)).returning();

    await audit(tx, ctx, "inspection_program.revised", "inspection_program", input.id, before, after!);
    return after!;
  });
}

export async function programs(ctx: ServiceContext) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select().from(schema.inspectionProgram)
      .where(and(
        eq(schema.inspectionProgram.organizationId, ctx.actor.organizationId),
        eq(schema.inspectionProgram.active, true),
      ))
      .orderBy(asc(schema.inspectionProgram.name));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      standard: row.standard,
      reportAudience: row.reportAudience,
      authorityName: row.authorityName,
      frequencyMonths: row.frequencyMonths,
      version: row.version,
      checkpointCount: row.checkpoints.length,
    }));
  });
}

/* ----------------------------------------------------------- an inspection */

/**
 * Record what was found, and let core decide what it adds up to.
 *
 * THE OUTCOME IS NOT AN INPUT. A technician says what they saw; whether that
 * is a pass is a conclusion from the template, and `assessInspection` is what
 * draws it. Accepting an outcome from the caller would let a half finished
 * inspection be filed as a pass, which is the single most dangerous artefact
 * this module can produce: that report goes in a compliance file, gets handed
 * to a buyer, gets shown to an insurer, and asserts that somebody looked at
 * things nobody looked at.
 */
export interface RecordInput {
  /**
   * The inspection's own id, when the caller made one. The phone does, offline,
   * because a signature taken on the same screen has to name the inspection
   * before the server has heard of it. A second filing under an id that
   * exists returns the first rather than filing twice.
   */
  id?: string | undefined;
  programId: string;
  propertyId: string;
  customerId: string;
  answers: insp.RecordedAnswer[];
  jobId?: string | null;
  visitId?: string | null;
  inspectorName?: string | null;
  inspectorLicense?: string | null;
  performedOn?: string;
  /** Who signed the report off, and the signature's upload from the phone. */
  signedByName?: string | null;
  signedAt?: Date | null;
  signatureUploadId?: string | null;
}

export async function record(ctx: ServiceContext, input: RecordInput) {
  return guardedWrite(ctx, "compliance:write", (tx) => recordIn(tx, ctx, input));
}

/**
 * The filing itself, inside a transaction somebody else opened. The field
 * sync files an inspection inside its own batch, in a savepoint, after
 * checking `compliance:write` itself; everything else comes through `record`.
 */
export async function recordIn(tx: Database, ctx: ServiceContext, input: RecordInput) {
  {
    if (input.id) {
      const [existing] = await tx.select().from(schema.inspection)
        .where(and(eq(schema.inspection.id, input.id), eq(schema.inspection.organizationId, ctx.actor.organizationId)))
        .limit(1);
      if (existing) return summaryOf(tx, existing);
    }
    const program = await loadProgram(tx, ctx.actor.organizationId, input.programId);

    const assessment = insp.assessInspection(templateFor(program), input.answers);
    if (!assessment.ok) throw new ConflictError(explainAssessment(assessment));

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const performedOn = input.performedOn ?? time.dateIn(new Date(), zone);

    const [row] = await tx.insert(schema.inspection).values({
      ...(input.id ? { id: input.id } : {}),
      organizationId: ctx.actor.organizationId,
      programId: program.id,
      /**
       * Stamped with the version, because a report in a compliance file has
       * to keep meaning what it meant. Without it, revising a programme
       * silently changes what every past inspection claims to have checked.
       */
      programVersion: program.version,
      propertyId: input.propertyId,
      customerId: input.customerId,
      jobId: input.jobId ?? null,
      visitId: input.visitId ?? null,
      performedOn,
      result: toResult(assessment),
      inspectorName: input.inspectorName?.trim() || null,
      inspectorLicense: input.inspectorLicense?.trim() || null,
      nextDueOn: program.frequencyMonths
        ? addMonths(performedOn, program.frequencyMonths)
        : null,
      /**
       * The checkpoints and the answers, kept with the inspection, so the
       * report printed next year is printed from what was asked and what was
       * said, not from the programme as somebody has since revised it.
       */
      checkpoints: program.checkpoints,
      answers: input.answers.map((answer) => ({
        itemKey: answer.itemKey,
        value: { ...answer.value } as Record<string, unknown> & { kind: string },
        at: answer.at.toISOString(),
        by: answer.by,
        ...(answer.note !== undefined ? { note: answer.note } : {}),
        ...(answer.photoIds !== undefined ? { photoIds: [...answer.photoIds] } : {}),
        ...(answer.equipmentId !== undefined ? { equipmentId: answer.equipmentId } : {}),
      })),
      statement: assessment.statement,
      signedByName: input.signedByName?.trim() || null,
      signedAt: input.signedByName?.trim() ? input.signedAt ?? new Date() : null,
      signatureUploadId: input.signatureUploadId ?? null,
    }).returning();

    /**
     * Findings become rows, so they outlive the visit and land on a backlog
     * somebody works. A deficiency that exists only inside one report is a
     * fault nobody follows up.
     */
    /**
     * WHICH MACHINE EACH ANSWER WAS ABOUT, checked once against the register.
     *
     * `deficiency.equipment_id` had no writer, so the equipment history's
     * fault section was always empty and the column sat in
     * `unwritten-columns.test.ts` as a known gap. A checkpoint may now name
     * the unit it was about, and the finding carries it.
     *
     * Checked here rather than taken on trust, and in ONE query rather than
     * one per finding: an inspection of eight rooftop units produces a
     * reference per unit, and a per finding lookup would be eight round trips
     * inside a transaction a technician's phone is waiting on.
     *
     * At the property this inspection is about, not merely existing. A fault
     * attached to a machine at a different address is worse than no
     * attachment: it puts a repair on somebody else's equipment history.
     */
    const named = [...new Set(
      input.answers.map((a) => a.equipmentId).filter((id): id is string => typeof id === "string"),
    )];
    const here = new Set<string>();
    if (named.length > 0) {
      const rows = await tx.select({ id: schema.equipment.id }).from(schema.equipment)
        .where(and(
          eq(schema.equipment.organizationId, ctx.actor.organizationId),
          inArray(schema.equipment.id, named),
          eq(schema.equipment.propertyId, input.propertyId),
          isNull(schema.equipment.deletedAt),
        ));
      for (const row of rows) here.add(row.id);
      const stray = named.filter((id) => !here.has(id));
      if (stray.length > 0) {
        throw new ConflictError(
          `Equipment ${stray[0]} is not on the register at this property. A fault attached to `
          + "a machine at a different address puts a repair on somebody else's equipment "
          + "history.",
        );
      }
    }
    const unitOf = new Map(
      input.answers
        .filter((a) => typeof a.equipmentId === "string")
        .map((a) => [a.itemKey, a.equipmentId!]),
    );

    const byKey = new Map(program.checkpoints.map((c) => [c.key, c]));
    for (const found of assessment.deficiencies) {
      const checkpoint = byKey.get(found.itemKey);
      await tx.insert(schema.deficiency).values({
        organizationId: ctx.actor.organizationId,
        inspectionId: row!.id,
        propertyId: input.propertyId,
        customerId: input.customerId,
        severity: FROM_CORE[found.severity],
        checkpointKey: found.itemKey,
        /**
         * The unit the answer that produced this finding was about, or null
         * when the checkpoint was about the property. Half the checkpoints on
         * a real programme have no machine: "is the gas meter accessible" has
         * none, and inventing an equipment row for the building to satisfy a
         * column would be worse than the null.
         */
        equipmentId: unitOf.get(found.itemKey) ?? null,
        code: found.codeReference ?? null,
        description: found.summary,
        foundOn: performedOn,
        /**
         * The evidence, kept with the finding rather than only in the
         * report. Core refuses to price a deficiency with no observation,
         * and that refusal only means anything if the photo and the reading
         * survive the visit.
         */
        /** Frozen onto the finding, so revising the programme cannot rewrite an old quote. */
        remedies: [...found.remedies],
        observation: {
          itemKey: found.observation.itemKey,
          prompt: found.observation.prompt,
          recorded: found.observation.recorded,
          at: found.observation.at.toISOString(),
          by: found.observation.by,
          photoIds: [...found.observation.photoIds],
          ...(found.observation.reading ? { reading: found.observation.reading } : {}),
        },
        /**
         * The deadline comes from the severity scale rather than from a
         * field somebody fills in. A safety finding is today and a
         * recommendation has no deadline, and leaving that to be typed is
         * how every finding ends up with the same date.
         */
        correctByOn: deadlineFor(found.severity, performedOn),
        ...(checkpoint?.assetCategory ? {} : {}),
      });
    }

    await audit(tx, ctx, "inspection.recorded", "inspection", row!.id, null, {
      result: row!.result, deficiencies: assessment.deficiencies.length,
    });

    return {
      id: row!.id,
      result: row!.result,
      /** Core's own sentence, not one reassembled here. */
      statement: assessment.statement,
      complete: assessment.complete,
      unanswered: [...assessment.unanswered],
      optionalSkipped: [...assessment.optionalSkipped],
      counts: assessment.counts as Record<string, number>,
      nextDueOn: row!.nextDueOn,
      deficiencies: assessment.deficiencies.length,
    };
  }
}

/**
 * What a replayed filing gets back: the same summary, recomputed from what
 * was kept, so a phone retrying after a lost response sees what it filed.
 */
async function summaryOf(tx: Database, row: typeof schema.inspection.$inferSelect) {
  const template = templateFor({
    name: "", standard: null,
    checkpoints: row.checkpoints ?? [],
  });
  const assessment = insp.assessInspection(template, (row.answers ?? []).map(toRecorded));
  const [{ count } = { count: 0 }] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(schema.deficiency).where(eq(schema.deficiency.inspectionId, row.id));
  return {
    id: row.id,
    result: row.result,
    statement: row.statement ?? (assessment.ok ? assessment.statement : ""),
    complete: assessment.ok ? assessment.complete : false,
    unanswered: assessment.ok ? [...assessment.unanswered] : [],
    optionalSkipped: assessment.ok ? [...assessment.optionalSkipped] : [],
    counts: (assessment.ok ? assessment.counts : {}) as Record<string, number>,
    nextDueOn: row.nextDueOn,
    deficiencies: Number(count),
  };
}

/** A stored answer back into core's shape. */
function toRecorded(answer: typeof schema.inspection.$inferSelect["answers"][number]): insp.RecordedAnswer {
  return {
    itemKey: answer.itemKey,
    value: answer.value as unknown as insp.AnswerValue,
    at: new Date(answer.at),
    by: answer.by,
    ...(answer.note !== undefined ? { note: answer.note } : {}),
    ...(answer.photoIds !== undefined ? { photoIds: answer.photoIds } : {}),
    ...(answer.equipmentId !== undefined ? { equipmentId: answer.equipmentId } : {}),
  };
}

function explainAssessment(refusal: insp.AssessmentRefusal): string {
  switch (refusal.reason) {
    case "invalid_template":
      return insp.explainTemplateProblems(refusal.problems);
    case "unknown_item":
      /**
       * The template changed under a technician who was offline, and the
       * work they did recording it is real. Naming the items is what lets
       * somebody put it somewhere rather than lose it.
       */
      return `This inspection answers items the programme no longer has: ${refusal.detail.join(", ")}. `
        + "The programme was revised after the work started. Those answers are still real, so they are "
        + "refused rather than dropped.";
    case "wrong_answer_kind":
      return `The wrong kind of answer was recorded for ${refusal.detail.join(", ")}.`;
  }
}

/**
 * Core's outcome, in the database's words.
 *
 * `incomplete` maps to `partial` rather than to `fail`, because they are
 * different facts and a compliance file needs to tell them apart: a failed
 * inspection says the thing is wrong, and a partial one says nobody has
 * finished looking.
 */
function toResult(assessment: insp.InspectionAssessment) {
  switch (assessment.outcome) {
    case "passed": return "pass" as const;
    case "passed_with_recommendations": return "pass_with_deficiencies" as const;
    case "failed": return "fail" as const;
    case "incomplete": return "partial" as const;
  }
}

function deadlineFor(severity: insp.Severity, from: string): string | null {
  const within = insp.SEVERITY[severity].respondWithinDays;
  return within === null ? null : shiftDays(from, within);
}

/* --------------------------------------------------------------- backlog */

/**
 * Everything found and not yet put right, worst and most overdue first.
 *
 * The ageing comes from core, against a `now` that is a parameter there for
 * a reason: a backlog report has to be reproducible, and one measured against
 * whenever it happened to run says something different every time it is run
 * for the same month end.
 */
export async function backlog(
  ctx: ServiceContext,
  input: { propertyId?: string; customerId?: string; includeSettled?: boolean; now?: Date } = {},
) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const now = input.now ?? new Date();

    const rows = await tx.select({
      deficiency: schema.deficiency,
      line1: schema.property.addressLine1,
      city: schema.property.city,
      customerName: schema.customer.name,
    }).from(schema.deficiency)
      .innerJoin(schema.property, eq(schema.property.id, schema.deficiency.propertyId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.deficiency.customerId))
      .where(and(
        eq(schema.deficiency.organizationId, ctx.actor.organizationId),
        ...(input.propertyId ? [eq(schema.deficiency.propertyId, input.propertyId)] : []),
        ...(input.customerId ? [eq(schema.deficiency.customerId, input.customerId)] : []),
        /**
         * Settled states are excluded in SQL, not after the fetch. Filtering
         * afterwards applies the limit first, so a company with five hundred
         * corrected faults would page through finished work and see an empty
         * backlog.
         */
        ...(input.includeSettled
          ? []
          : [sql`${schema.deficiency.status} not in ('corrected', 'declined', 'void')`]),
      ))
      .orderBy(desc(schema.deficiency.severity), asc(schema.deficiency.foundOn));

    return rows.map(({ deficiency, line1, city, customerName }) => {
      const severity = TO_CORE[deficiency.severity] ?? "wear";
      const standing = insp.backlogStanding({
        itemKey: deficiency.checkpointKey ?? deficiency.id,
        severity,
        foundAt: new Date(`${deficiency.foundOn ?? deficiency.createdAt.toISOString().slice(0, 10)}T00:00:00Z`),
      }, now);

      return {
        id: deficiency.id,
        status: deficiency.status,
        severity,
        /** The database's word too, because an authority's form asks for it. */
        recordedSeverity: deficiency.severity,
        description: deficiency.description,
        recommendedAction: deficiency.recommendedAction,
        equipmentId: deficiency.equipmentId,
        customerName,
        address: [line1, city].filter(Boolean).join(", "),
        foundOn: deficiency.foundOn,
        correctByOn: deficiency.correctByOn,
        ageDays: standing.ageDays,
        overdue: standing.overdue,
        /** The quote it became, once somebody quoted it. */
        estimateId: deficiency.estimateId,
        /** Whether the checkpoint declared a repair, so quoting it needs no typed price. */
        hasRemedy: deficiency.remedies.length > 0,
        /** Core's sentence. For the list, not for a chart. */
        statement: standing.statement,
      };
    }).sort((a, b) =>
      Number(b.overdue) - Number(a.overdue)
      || insp.compareSeverity(a.severity, b.severity)
      || b.ageDays - a.ageDays);
  });
}

/**
 * Move a finding along.
 *
 * The states that END it need a reason, and declining needs one most of all:
 * a customer who declined a safety finding is the single sentence somebody
 * will want in writing later, and a blank there is the record that was not
 * kept.
 */
export async function setDeficiencyStatus(
  ctx: ServiceContext,
  input: {
    id: string;
    status: "open" | "quoted" | "approved" | "scheduled" | "corrected" | "declined" | "deferred" | "void";
    reason?: string;
    jobId?: string | null;
    on?: string;
  },
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const [before] = await tx.select().from(schema.deficiency)
      .where(and(
        eq(schema.deficiency.id, input.id),
        eq(schema.deficiency.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!before) throw new NotFoundError("Deficiency");

    if (before.status === "corrected" && input.status !== "corrected") {
      throw new ConflictError(
        "That finding is already corrected. Reopening it would say the repair did not happen; "
        + "record a new finding instead.",
      );
    }

    const reason = input.reason?.trim() || null;
    if ((input.status === "declined" || input.status === "void") && !reason) {
      throw new ConflictError(
        `A ${input.status} finding needs a reason. A customer who declined a safety finding is the `
        + "sentence somebody wants in writing later.",
      );
    }

    const on = input.on ?? time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));

    const [after] = await tx.update(schema.deficiency).set({
      status: input.status,
      ...(input.status === "corrected"
        ? { correctedOn: on, correctedByJobId: input.jobId ?? before.correctedByJobId }
        : {}),
      ...(input.status === "declined" ? { declinedOn: on, declineReason: reason } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.deficiency.id, input.id)).returning();

    await audit(tx, ctx, "deficiency.status", "deficiency", input.id,
      { status: before.status }, { status: input.status, reason });

    return { id: input.id, status: after!.status };
  });
}

/**
 * What the open findings at a property would be quoted as.
 *
 * `proposeWork` refuses a finding with no observation and a remedy with no
 * rationale, which is the property this whole module exists to have: a price
 * with a story and no evidence is the artefact it is built to make
 * impossible. The refusal names the findings so somebody can go and attach
 * the photo or the reading they took.
 */
export async function proposal(ctx: ServiceContext, input: { propertyId: string }) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select().from(schema.deficiency)
      .where(and(
        eq(schema.deficiency.organizationId, ctx.actor.organizationId),
        eq(schema.deficiency.propertyId, input.propertyId),
        inArray(schema.deficiency.status, ["open", "deferred"]),
      ));

    if (rows.length === 0) {
      return { ok: false as const, reason: "nothing_to_propose" as const, detail: "Nothing open here." };
    }

    return insp.proposeWork(rows.map((row) => ({
      itemKey: row.checkpointKey ?? row.id,
      severity: TO_CORE[row.severity] ?? "wear",
      summary: row.description,
      /**
       * The observation the technician recorded, read back off the row. A
       * finding with none is refused by core rather than priced, and the
       * refusal is the feature: the office finds out before the customer
       * does, and the answer is to go and attach the photo.
       *
       * Findings entered by hand, and every finding written before the
       * column existed, have none. Those come back in the refusal by name,
       * which is exactly right: they are prices with no evidence.
       */
      ...(row.observation
        ? {
            observation: {
              itemKey: row.observation.itemKey,
              prompt: row.observation.prompt,
              recorded: row.observation.recorded,
              at: new Date(row.observation.at),
              by: row.observation.by,
              photoIds: row.observation.photoIds,
            },
          }
        : {}),
      remedies: row.remedies,
      ...(row.code ? { codeReference: row.code } : {}),
    })));
  });
}

/* ------------------------------------------------------------ the report */

export interface ReportItem {
  key: string;
  prompt: string;
  kind: "pass_fail" | "reading";
  unit: string | null;
  /** "350 to 450 psi", for a reading. */
  range: string | null;
  /** What was recorded, as words: "Pass", "412 psi", "Not applicable: no meter on site". */
  answer: string | null;
  /**
   * What it came to. `finding` carries a severity; `borderline` is a reading
   * inside its range and near the edge of it, which is NOT a failure.
   */
  verdict: "pass" | "borderline" | "finding" | "not_applicable" | "not_answered";
  severity: string | null;
  note: string | null;
  by: string | null;
  at: string | null;
  equipmentId: string | null;
  photos: { id: string; storageKey: string | null }[];
}

export interface InspectionReport {
  id: string;
  organizationName: string;
  program: {
    id: string | null; name: string; standard: string | null; reportAudience: string;
    authorityName: string | null; version: number | null;
  };
  customer: { id: string; name: string };
  property: { id: string; address: string };
  performedOn: string | null;
  result: string | null;
  statement: string | null;
  inspectorName: string | null;
  inspectorLicense: string | null;
  nextDueOn: string | null;
  submittedAt: Date | null;
  submissionReference: string | null;
  items: ReportItem[];
  deficiencies: {
    id: string; severity: insp.Severity; label: string; recordedSeverity: string; description: string;
    code: string | null; correctByOn: string | null; status: string; estimateId: string | null;
  }[];
  signature: { name: string; at: Date | null; storageKey: string | null } | null;
  /**
   * False for an inspection filed before its checkpoints were kept with it.
   * Its prompts then come from the programme as it is now, and the report
   * says so rather than passing them off as what was asked.
   */
  checkpointsKept: boolean;
}

/**
 * THE INSPECTION REPORT, FROM THE DATA HELD.
 *
 * Every checkpoint as it was asked, what was recorded against it, the range
 * a reading was judged against and what it came to, the findings with their
 * severity, code and correction date, the photographs, the inspector and
 * their licence, the signature, and when it is next due. The same document
 * whoever reads it; a programme whose report goes to an authority prints the
 * authority's name and the standard at the top, because that is the reader
 * the report is for.
 *
 * Rendered from the checkpoints and answers frozen on the inspection, so a
 * report reprinted after the programme was revised still says what was
 * asked. Each item's verdict is core's assessment again, not a word stored
 * at filing, so the report and the backlog cannot disagree about a reading.
 *
 * WHAT IT IS NOT: an authority's own form. A fire marshal's office that
 * insists on its form gets the same facts copied onto it; there is no per
 * authority formatter, and the module doc says so.
 */
export async function report(ctx: ServiceContext, input: { id: string }): Promise<InspectionReport> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const [row] = await tx.select().from(schema.inspection)
      .where(and(eq(schema.inspection.id, input.id), eq(schema.inspection.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("Inspection");

    const [program] = row.programId
      ? await tx.select().from(schema.inspectionProgram).where(eq(schema.inspectionProgram.id, row.programId)).limit(1)
      : [];
    const checkpoints = row.checkpoints ?? program?.checkpoints ?? [];
    const template = templateFor({ name: program?.name ?? "", standard: program?.standard ?? null, checkpoints });
    const answers = row.answers ?? [];
    const assessment = insp.assessInspection(template, answers.map(toRecorded));

    const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    const [customer] = await tx.select({ id: schema.customer.id, name: schema.customer.name })
      .from(schema.customer).where(eq(schema.customer.id, row.customerId)).limit(1);
    const [property] = await tx.select().from(schema.property).where(eq(schema.property.id, row.propertyId)).limit(1);
    const deficiencies = await tx.select().from(schema.deficiency)
      .where(eq(schema.deficiency.inspectionId, row.id));

    const photoIds = [...new Set(answers.flatMap((a) => [
      ...(a.photoIds ?? []),
      ...(a.value.kind === "photo" && Array.isArray(a.value["photoIds"]) ? a.value["photoIds"] as string[] : []),
    ]))];
    const signatureIds = row.signatureUploadId ? [row.signatureUploadId] : [];
    const uploads = photoIds.length + signatureIds.length === 0 ? [] : await tx.select({
      clientId: schema.fieldUpload.clientId, storageKey: schema.fieldUpload.storageKey,
    }).from(schema.fieldUpload).where(inArray(schema.fieldUpload.clientId, [...photoIds, ...signatureIds]));
    const stored = new Map(uploads.map((u) => [u.clientId, u.storageKey]));

    const findings = assessment.ok ? new Map(assessment.deficiencies.map((d) => [d.itemKey, d])) : new Map();
    const notApplicable = new Set(assessment.ok ? assessment.notApplicable : []);
    const unanswered = new Set(assessment.ok ? [...assessment.unanswered, ...assessment.optionalSkipped] : []);
    const byKey = new Map(answers.map((a) => [a.itemKey, a]));

    const items: ReportItem[] = checkpoints.map((checkpoint) => {
      const answer = byKey.get(checkpoint.key);
      const reading = checkpoint.requiresReading === true;
      const finding = findings.get(checkpoint.key) as insp.Deficiency | undefined;
      const value = answer?.value;
      let verdict: ReportItem["verdict"] = "pass";
      if (notApplicable.has(checkpoint.key)) verdict = "not_applicable";
      else if (unanswered.has(checkpoint.key) || !answer) verdict = "not_answered";
      else if (finding && insp.SEVERITY[finding.severity].failsInspection) verdict = "finding";
      else if (finding && reading) verdict = "borderline";
      else if (finding) verdict = "finding";
      return {
        key: checkpoint.key,
        prompt: checkpoint.label,
        kind: reading ? "reading" : "pass_fail",
        unit: checkpoint.unit ?? null,
        range: reading && checkpoint.range ? insp.describeRange(checkpoint.range, checkpoint.unit ?? "") : null,
        answer: value ? describeAnswer(value, checkpoint.unit ?? null) : null,
        verdict,
        severity: finding ? insp.SEVERITY[finding.severity].label : null,
        note: answer?.note ?? null,
        by: answer?.by ?? null,
        at: answer?.at ?? null,
        equipmentId: answer?.equipmentId ?? null,
        photos: [
          ...(answer?.photoIds ?? []),
          ...(value?.kind === "photo" && Array.isArray(value["photoIds"]) ? value["photoIds"] as string[] : []),
        ].map((id) => ({ id, storageKey: stored.get(id) ?? null })),
      };
    });

    return {
      id: row.id,
      organizationName: org?.name ?? "",
      program: {
        id: program?.id ?? null,
        name: program?.name ?? "Inspection",
        standard: program?.standard ?? null,
        reportAudience: program?.reportAudience ?? "customer",
        authorityName: program?.authorityName ?? null,
        version: row.programVersion,
      },
      customer: { id: row.customerId, name: customer?.name ?? "" },
      property: {
        id: row.propertyId,
        address: property
          ? [property.addressLine1, property.city, [property.state, property.postalCode].filter(Boolean).join(" ")]
            .filter(Boolean).join(", ")
          : "",
      },
      performedOn: row.performedOn,
      result: row.result,
      statement: row.statement ?? (assessment.ok ? assessment.statement : null),
      inspectorName: row.inspectorName,
      inspectorLicense: row.inspectorLicense,
      nextDueOn: row.nextDueOn,
      submittedAt: row.submittedAt,
      submissionReference: row.submissionReference,
      items,
      deficiencies: deficiencies.map((d) => {
        const severity = TO_CORE[d.severity] ?? "wear";
        return {
          id: d.id, severity, label: insp.SEVERITY[severity].label, recordedSeverity: d.severity,
          description: d.description, code: d.code, correctByOn: d.correctByOn, status: d.status,
          estimateId: d.estimateId,
        };
      }).sort((a, b) => insp.compareSeverity(a.severity, b.severity)),
      signature: row.signedByName
        ? { name: row.signedByName, at: row.signedAt, storageKey: row.signatureUploadId ? stored.get(row.signatureUploadId) ?? null : null }
        : null,
      checkpointsKept: row.checkpoints !== null,
    };
  });
}

/** An answer as the report prints it. */
function describeAnswer(value: Record<string, unknown> & { kind: string }, unit: string | null): string {
  switch (value.kind) {
    case "pass_fail": return value["passed"] === true ? "Pass" : "Fail";
    case "reading": return value["raw"] === null || value["raw"] === undefined || value["raw"] === ""
      ? "No reading" : `${String(value["raw"])}${unit ? ` ${unit}` : ""}`;
    case "note": return String(value["text"] ?? "");
    case "count": return String(value["count"] ?? "");
    case "photo": {
      const count = Array.isArray(value["photoIds"]) ? value["photoIds"].length : 0;
      return `${count} ${count === 1 ? "photo" : "photos"}`;
    }
    case "not_applicable": return `Not applicable: ${String(value["why"] ?? "")}`;
    default: return "";
  }
}

/** Inspections filed, newest first, for the list beside the backlog. */
export async function recent(
  ctx: ServiceContext, input: { propertyId?: string | undefined; visitId?: string | undefined; limit?: number | undefined } = {},
) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select({
      inspection: schema.inspection,
      programName: schema.inspectionProgram.name,
      customerName: schema.customer.name,
      line1: schema.property.addressLine1,
      city: schema.property.city,
    }).from(schema.inspection)
      .leftJoin(schema.inspectionProgram, eq(schema.inspectionProgram.id, schema.inspection.programId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.inspection.customerId))
      .innerJoin(schema.property, eq(schema.property.id, schema.inspection.propertyId))
      .where(and(
        eq(schema.inspection.organizationId, ctx.actor.organizationId),
        ...(input.propertyId ? [eq(schema.inspection.propertyId, input.propertyId)] : []),
        ...(input.visitId ? [eq(schema.inspection.visitId, input.visitId)] : []),
      ))
      .orderBy(desc(schema.inspection.performedOn), desc(schema.inspection.createdAt))
      .limit(input.limit ?? 50);
    return rows.map((r) => ({
      id: r.inspection.id,
      programName: r.programName ?? "Inspection",
      performedOn: r.inspection.performedOn,
      result: r.inspection.result,
      customerName: r.customerName,
      address: [r.line1, r.city].filter(Boolean).join(", "),
      visitId: r.inspection.visitId,
      nextDueOn: r.inspection.nextDueOn,
    }));
  });
}

/* ---------------------------------------------------------- one action quote */

/**
 * TURN ONE FINDING INTO A QUOTE, IN ONE ACTION.
 *
 * The remedies the checkpoint declared, frozen on the finding, become the
 * lines of a new estimate for the customer at that property, priced from
 * the contractor's own price book by item code through the estimate
 * service's own pricing. The evidence goes with it: what was seen, by whom
 * and when, and why each line follows from it, in the option's description
 * the customer reads. The finding moves to quoted with the estimate and the
 * amount on it, so the backlog shows it is in front of the customer.
 *
 * REFUSED, in words, when:
 *
 *   The finding has no observation. Core's proposal builder refuses a price
 *   with no evidence, and that refusal is the reason the module exists.
 *
 *   A remedy names a price book code this company does not have. The quote
 *   would be missing the line that fixes the problem.
 *
 *   The checkpoint declared no remedy and no price was given. There is then
 *   nothing to price; give the price for correcting it and that becomes the
 *   line.
 *
 * A finding already quoted returns its estimate rather than writing a
 * second, which is what makes the button safe to press twice.
 */
export async function quoteDeficiency(
  ctx: ServiceContext, input: { id: string; price?: string | null | undefined },
): Promise<{ deficiencyId: string; estimateId: string; amount: string | null; created: boolean }> {
  assertCan(ctx.actor, "estimate:write");
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const [row] = await tx.select().from(schema.deficiency)
      .where(and(eq(schema.deficiency.id, input.id), eq(schema.deficiency.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("Deficiency");
    if (row.estimateId) {
      return { deficiencyId: row.id, estimateId: row.estimateId, amount: row.quotedAmount, created: false };
    }
    if (row.status !== "open" && row.status !== "deferred") {
      throw new ConflictError(`That finding is ${row.status}, so there is nothing to quote.`);
    }

    const proposal = insp.proposeWork([{
      itemKey: row.checkpointKey ?? row.id,
      severity: TO_CORE[row.severity] ?? "wear",
      summary: row.description,
      ...(row.observation ? {
        observation: {
          itemKey: row.observation.itemKey, prompt: row.observation.prompt,
          recorded: row.observation.recorded, at: new Date(row.observation.at),
          by: row.observation.by, photoIds: row.observation.photoIds,
        },
      } : {}),
      remedies: row.remedies,
      ...(row.code ? { codeReference: row.code } : {}),
    }]);
    if (!proposal.ok) {
      throw new ConflictError(
        proposal.reason === "unobserved_deficiency"
          ? "This finding has no observation behind it: no reading, no note, no photo. A price with no evidence is "
            + "the one thing this will not write. Record what was seen first."
          : proposal.reason === "unjustified_remedy"
            ? `A repair on this finding's checkpoint cannot be priced: ${proposal.detail.join(" ")}`
            : String(proposal.detail),
      );
    }

    const lines = proposal.groups.flatMap((g) => g.lines);
    const codes = [...new Set(lines.map((l) => l.priceBookItemKey))];
    const items = codes.length === 0 ? [] : await tx.select({ id: schema.priceBookItem.id, code: schema.priceBookItem.code })
      .from(schema.priceBookItem)
      .where(and(eq(schema.priceBookItem.organizationId, ctx.actor.organizationId), inArray(schema.priceBookItem.code, codes)));
    const byCode = new Map(items.map((i) => [i.code, i.id]));
    const missing = codes.filter((code) => !byCode.has(code));
    if (missing.length > 0) {
      throw new ConflictError(
        `The repair for this finding names ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in your price book. `
        + "Add the item, or correct the code on the programme, so the quote has the line that fixes the problem.",
      );
    }

    const estimateLines: { priceBookItemId?: string; name: string; description?: string; quantity: string; unitPrice: string;
      discountAmount: string; taxable: boolean; isOptional: boolean; isSelected: boolean }[] =
      lines.map((line) => ({
        priceBookItemId: byCode.get(line.priceBookItemKey)!,
        name: line.label,
        description: line.rationale,
        quantity: String(line.quantity),
        unitPrice: "0",
        discountAmount: "0",
        taxable: true,
        isOptional: false,
        isSelected: false,
      }));
    if (estimateLines.length === 0) {
      if (input.price === undefined || input.price === null || input.price === "") {
        throw new ConflictError(
          "No repair is declared on this finding's checkpoint, so there is nothing to price it from. "
          + "Give the price for correcting it and that becomes the line.",
        );
      }
      const price = String(input.price).trim();
      if (!/^\d+(\.\d{1,4})?$/.test(price)) throw new ConflictError(`${input.price} is not an amount of money.`);
      estimateLines.push({
        name: `Correct: ${row.description}`, quantity: "1", unitPrice: price,
        discountAmount: "0", taxable: true, isOptional: false, isSelected: false,
      });
    }

    const evidence = row.observation
      ? `Found ${row.foundOn ?? row.observation.at.slice(0, 10)} by ${row.observation.by}: ${row.observation.recorded}`
      : row.description;
    const estimate = await estimates.create({ ...ctx, db: tx, idempotencyKey: `deficiency-quote:${row.id}` }, {
      customerId: row.customerId,
      propertyId: row.propertyId,
      title: `Correct: ${row.description}`.slice(0, 200),
      taxRate: "0",
      options: [{
        name: insp.SEVERITY[TO_CORE[row.severity] ?? "wear"].heading.slice(0, 100),
        description: [evidence, row.code ? `Code reference: ${row.code}.` : null].filter(Boolean).join(" ").slice(0, 2000),
        isRecommended: true,
        lines: estimateLines,
      }],
    });
    const total = estimate.options[0]?.total ?? null;

    await tx.update(schema.deficiency).set({
      status: "quoted", estimateId: estimate.id, quotedAmount: total, updatedAt: new Date(),
    }).where(eq(schema.deficiency.id, row.id));
    await audit(tx, ctx, "deficiency.quoted", "deficiency", row.id,
      { status: row.status }, { status: "quoted", estimateId: estimate.id, amount: total });
    return { deficiencyId: row.id, estimateId: estimate.id, amount: total, created: true };
  });
}

/* ---------------------------------------------------------------- helpers */

async function loadProgram(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.inspectionProgram)
    .where(and(
      eq(schema.inspectionProgram.id, id),
      eq(schema.inspectionProgram.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Inspection programme");
  return row;
}

const DAY = 86_400_000;
const shiftDays = (date: string, by: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10);

/** Clamped to the end of a short month, same rule as the agreement schedules. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export const handlers = {
  listInspectionPrograms: async (ctx: ServiceContext) => ({ programs: await programs(ctx) }),

  recordInspection: (
    ctx: ServiceContext,
    input: {
      programId: string; propertyId: string; customerId: string;
      answers: {
        itemKey: string;
        /**
         * Spelled out rather than `insp.AnswerValue`, which carries readonly
         * arrays: the contract infers mutable ones and the two are not assignable
         * in that direction. Widening core's type to satisfy a handler would be
         * the wrong end to fix it.
         */
        value:
          | { kind: "pass_fail"; passed: boolean }
          | { kind: "reading"; raw: string | number | null }
          | { kind: "photo"; photoIds: string[] }
          | { kind: "note"; text: string }
          | { kind: "count"; count: number }
          | { kind: "not_applicable"; why: string };
        at: string;
        by: string;
        note?: string | undefined;
        photoIds?: string[] | undefined;
        equipmentId?: string | undefined;
      }[];
      jobId?: string | null | undefined;
      visitId?: string | null | undefined;
      inspectorName?: string | null | undefined;
      inspectorLicense?: string | null | undefined;
      performedOn?: string | undefined;
      signedByName?: string | null | undefined;
    },
  ) => record(ctx, {
    programId: input.programId,
    propertyId: input.propertyId,
    customerId: input.customerId,
    /**
     * `at` becomes a Date here and nowhere else.
     *
     * The wire carries an instant as a string because JSON has no date, and core
     * takes a `Date` because it compares them. Parsing at the edge rather than
     * inside the assessment keeps the decision clock-free: core is handed the
     * moment the device recorded, never one this process invented.
     */
    answers: input.answers.map((answer) => ({
      itemKey: answer.itemKey,
      value: answer.value,
      at: new Date(answer.at),
      by: answer.by,
      ...(answer.note !== undefined ? { note: answer.note } : {}),
      ...(answer.photoIds !== undefined ? { photoIds: answer.photoIds } : {}),
      ...(answer.equipmentId !== undefined ? { equipmentId: answer.equipmentId } : {}),
    })),
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ...(input.visitId !== undefined ? { visitId: input.visitId } : {}),
    ...(input.inspectorName !== undefined ? { inspectorName: input.inspectorName } : {}),
    ...(input.inspectorLicense !== undefined ? { inspectorLicense: input.inspectorLicense } : {}),
    ...(input.performedOn !== undefined ? { performedOn: input.performedOn } : {}),
    ...(input.signedByName !== undefined ? { signedByName: input.signedByName } : {}),
  }),

  listDeficiencies: async (
    ctx: ServiceContext,
    input: {
      propertyId?: string | undefined; customerId?: string | undefined;
      includeSettled?: boolean | undefined; now?: string | undefined;
    },
  ) => ({
    deficiencies: await backlog(ctx, {
      ...(input.propertyId !== undefined ? { propertyId: input.propertyId } : {}),
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.includeSettled !== undefined ? { includeSettled: input.includeSettled } : {}),
      ...(input.now !== undefined ? { now: new Date(input.now) } : {}),
    }),
  }),

  getInspectionReport: (ctx: ServiceContext, input: { id: string }) => report(ctx, input),
  listInspections: async (ctx: ServiceContext, input: { propertyId?: string | undefined; limit?: number | undefined }) =>
    ({ inspections: await recent(ctx, input) }),
  quoteDeficiency: (ctx: ServiceContext, input: { id: string; price?: string | null | undefined }) =>
    quoteDeficiency(ctx, input),

  setDeficiencyStatus: (
    ctx: ServiceContext,
    input: {
      id: string;
      status: "open" | "quoted" | "approved" | "scheduled" | "corrected" | "declined" | "deferred" | "void";
      reason?: string | undefined;
      jobId?: string | null | undefined;
      on?: string | undefined;
    },
  ) => setDeficiencyStatus(ctx, {
    id: input.id,
    status: input.status,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ...(input.on !== undefined ? { on: input.on } : {}),
  }),
} as const;
