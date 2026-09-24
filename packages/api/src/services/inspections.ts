import { and, asc, desc, eq, isNull, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inspection as insp, time } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf, type ServiceContext,
} from "./context";
import { audit } from "./customers";

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
export async function record(
  ctx: ServiceContext,
  input: {
    programId: string;
    propertyId: string;
    customerId: string;
    answers: insp.RecordedAnswer[];
    jobId?: string | null;
    visitId?: string | null;
    inspectorName?: string | null;
    inspectorLicense?: string | null;
    performedOn?: string;
  },
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const program = await loadProgram(tx, ctx.actor.organizationId, input.programId);

    const assessment = insp.assessInspection(templateFor(program), input.answers);
    if (!assessment.ok) throw new ConflictError(explainAssessment(assessment));

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const performedOn = input.performedOn ?? time.dateIn(new Date(), zone);

    const [row] = await tx.insert(schema.inspection).values({
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
    }).returning();

    /**
     * Findings become rows, so they outlive the visit and land on a backlog
     * somebody works. A deficiency that exists only inside one report is a
     * fault nobody follows up.
     */
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
      unanswered: assessment.unanswered,
      optionalSkipped: assessment.optionalSkipped,
      counts: assessment.counts,
      nextDueOn: row!.nextDueOn,
      deficiencies: assessment.deficiencies.length,
    };
  });
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
