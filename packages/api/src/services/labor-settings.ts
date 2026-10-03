import { and, asc, desc, eq, isNull, isNotNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { labor, money as m } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError, timezoneOf,
  type ServiceContext,
} from "./context";

/**
 * DECLARING WHAT PEOPLE ARE PAID, WHICH NOTHING COULD DO
 *
 * `policyFor` refuses to run a timesheet without an overtime policy, and the
 * refusal is right:
 *
 *   "No overtime policy is set for this company. Set one before running a
 *   timesheet: there is no safe default, because every default is a position
 *   on what somebody is owed."
 *
 * Nothing could set one. The timesheet screen therefore threw that message
 * for every company that ever opened it, and the message told them to do a
 * thing the product had no way of doing. An error naming an action nobody
 * can take is worse than a crash, because it reads as the reader's fault.
 *
 * `wage_scale` was the same story one layer down. `freezeRate` resolves the
 * scale in effect on the day a punch was worked, which is careful and dated
 * and correct, and it bailed at `if (!scale) return` every single time,
 * because no scale could exist. Every timeclock entry was unpriced and every
 * job's labour cost was zero.
 *
 * And `technician.wage_classification` says so in its own comment: "Nothing
 * supplied it, because the phone had nowhere to read it from, so it was
 * always null and the reconstruction it exists to avoid was the only option
 * available."
 *
 * Three columns, one broken path: a company could not be told what anybody
 * earns.
 */

/* ------------------------------------------------------------ idempotency */

/**
 * The answer a retried request already got, or null.
 *
 * Declaring a policy and loading a scale each write a NEW row by design, so
 * a request retried after a lost response would declare twice and load two
 * scales for one rate. The first answer is kept against the request's key
 * and handed back, whole, to the retry.
 */
async function answered<T>(tx: Database, ctx: ServiceContext, entityType: string): Promise<T | null> {
  if (!ctx.idempotencyKey) return null;
  const [seen] = await tx.select({ answer: schema.integrationEvent.responsePayload })
    .from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
      eq(schema.integrationEvent.entityType, entityType),
    )).limit(1);
  return (seen?.answer as T | undefined) ?? null;
}

async function remember<T extends { id: string }>(
  tx: Database, ctx: ServiceContext, entityType: string, eventType: string, answer: T,
): Promise<T> {
  if (ctx.idempotencyKey) {
    await tx.insert(schema.integrationEvent).values({
      organizationId: ctx.actor.organizationId,
      direction: "inbound", provider: "api", eventType,
      idempotencyKey: ctx.idempotencyKey, status: "succeeded",
      entityType, entityId: answer.id,
      responsePayload: answer as unknown as Record<string, unknown>,
    });
  }
  return answer;
}

/* ------------------------------------------------------- overtime policy */

export interface PolicyInput {
  label: string;
  /** Why this is the right declaration. Read by whoever approves payroll. */
  note: string;
  timeZone?: string | undefined;
  weekStartsOn?: number | undefined;
  dayAttribution?: "shift_start" | "split_at_midnight" | undefined;
  weeklyThresholdMinutes?: number | null | undefined;
  weeklyDoubleTimeThresholdMinutes?: number | null | undefined;
  dailyThresholdMinutes?: number | null | undefined;
  dailyDoubleTimeThresholdMinutes?: number | null | undefined;
  overtimeMultiplier?: string | undefined;
  doubleTimeMultiplier?: string | undefined;
  /** No default. Whether waiting is working is not guessed on anybody's behalf. */
  onCallTreatment: "separate_rate_not_hours_worked" | "hours_worked_at_base";
  roundingMinutes?: number | null | undefined;
  roundingMode?: "nearest" | "up" | "down" | null | undefined;
  countsTowardOvertime?: Record<string, boolean> | null | undefined;
}

/**
 * Declare the policy.
 *
 * VALIDATED BY CORE, not here. `checkOvertimePolicy` already refuses a
 * rounding rule that only runs down, a double time threshold below the
 * overtime one, a multiplier under 1, and an undeclared on call treatment.
 * It had no caller outside its own tests, so every one of those refusals was
 * unreachable from the product. Writing a second set of checks here would
 * have made two rules about wages that can disagree.
 *
 * SUPERSEDED, NOT EDITED. The previous policy is deactivated and a new row
 * written, because this is a declaration about what people are owed and the
 * old one is the answer to "what were we operating under in March".
 *
 * The honest consequence, stated rather than hidden: overtime classification
 * is DERIVED on read, so a new policy reclassifies hours in weeks already
 * worked. Rates are frozen at the punch and do not move; the split between
 * straight time and overtime does. That is a real effect of changing a
 * declaration mid year, and the return value says how many approved weeks it
 * reaches so nobody finds out from a payroll run.
 */
export async function setPolicy(ctx: ServiceContext, input: PolicyInput) {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const seen = await answered<PolicyAnswer>(tx, ctx, "overtime_policy");
    if (seen) return seen;
    const zone = input.timeZone ?? await timezoneOf(tx, ctx.actor.organizationId);

    const candidate: labor.OvertimePolicy = {
      label: input.label.trim(),
      timeZone: zone,
      weekStartsOn: (input.weekStartsOn ?? 0) as labor.Weekday,
      dayAttribution: input.dayAttribution ?? "shift_start",
      weeklyThresholdMinutes: input.weeklyThresholdMinutes ?? null,
      weeklyDoubleTimeThresholdMinutes: input.weeklyDoubleTimeThresholdMinutes ?? null,
      dailyThresholdMinutes: input.dailyThresholdMinutes ?? null,
      dailyDoubleTimeThresholdMinutes: input.dailyDoubleTimeThresholdMinutes ?? null,
      overtimeMultiplier: input.overtimeMultiplier ?? "1.5",
      doubleTimeMultiplier: input.doubleTimeMultiplier ?? "2",
      onCallTreatment: input.onCallTreatment,
      punchRounding: input.roundingMinutes && input.roundingMode
        ? { toMinutes: input.roundingMinutes, mode: input.roundingMode }
        : null,
      note: input.note,
      ...(input.countsTowardOvertime
        ? { countsTowardOvertime: input.countsTowardOvertime as Partial<Record<labor.TimeEntryKind, boolean>> }
        : {}),
    };

    if (candidate.label === "") throw new ConflictError("A policy needs a name.");

    const verdict = labor.checkOvertimePolicy(candidate);
    if (!verdict.ok) {
      throw new ConflictError(verdict.refusals.map((r) => r.message).join(" "));
    }

    /**
     * How much already approved time this reaches. Counted BEFORE the
     * switch, because after it the old policy is gone and the number cannot
     * be produced.
     */
    const [approved] = await tx.select({
      id: schema.timeclockEntry.id,
    }).from(schema.timeclockEntry)
      .where(and(
        eq(schema.timeclockEntry.organizationId, ctx.actor.organizationId),
        isNotNull(schema.timeclockEntry.approvedAt),
      )).limit(1);

    const [previous] = await tx.select().from(schema.overtimePolicy)
      .where(and(
        eq(schema.overtimePolicy.organizationId, ctx.actor.organizationId),
        eq(schema.overtimePolicy.active, true),
        isNull(schema.overtimePolicy.deletedAt),
      )).limit(1);

    if (previous) {
      await tx.update(schema.overtimePolicy)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(schema.overtimePolicy.id, previous.id));
    }

    const [row] = await tx.insert(schema.overtimePolicy).values({
      organizationId: ctx.actor.organizationId,
      label: candidate.label,
      timeZone: candidate.timeZone,
      weekStartsOn: candidate.weekStartsOn,
      dayAttributionMode: candidate.dayAttribution,
      weeklyThresholdMinutes: candidate.weeklyThresholdMinutes,
      weeklyDoubleTimeThresholdMinutes: candidate.weeklyDoubleTimeThresholdMinutes,
      dailyThresholdMinutes: candidate.dailyThresholdMinutes,
      dailyDoubleTimeThresholdMinutes: candidate.dailyDoubleTimeThresholdMinutes,
      overtimeMultiplier: candidate.overtimeMultiplier,
      doubleTimeMultiplier: candidate.doubleTimeMultiplier,
      onCallMode: candidate.onCallTreatment,
      roundingMinutes: candidate.punchRounding?.toMinutes ?? null,
      roundingMode: candidate.punchRounding?.mode ?? null,
      countsTowardOvertime: input.countsTowardOvertime ?? null,
      note: candidate.note,
    }).returning();

    await audit(tx, ctx, "overtime_policy.declared", "overtime_policy",
      row!.id, previous ?? null, row!);

    return remember(tx, ctx, "overtime_policy", "overtime_policy.declare", {
      id: row!.id,
      label: row!.label,
      replaced: previous?.label ?? null,
      /**
       * True when approved time exists. Overtime classification is derived
       * on read, so this declaration changes the straight time and overtime
       * split on weeks already signed off. The rates themselves are frozen
       * at the punch and do not move.
       */
      reclassifiesApprovedTime: Boolean(approved) && Boolean(previous),
    });
  });
}

interface PolicyAnswer {
  id: string;
  label: string;
  replaced: string | null;
  reclassifiesApprovedTime: boolean;
}

/** Every policy this company has declared, current first. */
export async function policies(ctx: ServiceContext) {
  return guardedRead(ctx, "timesheet:read", async (tx) => {
    const rows = await tx.select().from(schema.overtimePolicy)
      .where(and(
        eq(schema.overtimePolicy.organizationId, ctx.actor.organizationId),
        isNull(schema.overtimePolicy.deletedAt),
      ))
      .orderBy(desc(schema.overtimePolicy.createdAt));

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      note: row.note,
      timeZone: row.timeZone,
      weekStartsOn: row.weekStartsOn,
      dayAttribution: row.dayAttributionMode,
      weeklyThresholdMinutes: row.weeklyThresholdMinutes,
      dailyThresholdMinutes: row.dailyThresholdMinutes,
      overtimeMultiplier: row.overtimeMultiplier,
      doubleTimeMultiplier: row.doubleTimeMultiplier,
      onCallTreatment: row.onCallMode,
      rounding: row.roundingMinutes && row.roundingMode
        ? `${row.roundingMinutes} minutes, ${row.roundingMode}`
        : null,
      active: row.active,
      declaredOn: row.createdAt.toISOString(),
    }));
  });
}

/* ----------------------------------------------------------- wage scales */

export const AUTHORITIES = [
  "employee_default", "collective_agreement", "wage_determination", "contract", "manual_override",
] as const;
export type WageAuthority = (typeof AUTHORITIES)[number];

export interface ScaleInput {
  classification: string;
  baseRate: string;
  authority?: WageAuthority | undefined;
  jurisdiction?: string | null | undefined;
  externalReference?: string | null | undefined;
  fringeRate?: string | null | undefined;
  overtimeMultiplier?: string | null | undefined;
  doubleTimeMultiplier?: string | null | undefined;
  apprenticeRatio?: string | null | undefined;
  effectiveFrom?: string | null | undefined;
  effectiveTo?: string | null | undefined;
}

/**
 * Load a scale.
 *
 * DATED, and the dates are the point. A union agreement raises rates on a
 * date, and an entry worked before that date must keep costing what it cost.
 * `scaleOn` resolves the row that was in effect on the day the punch
 * happened, which is why this writes a NEW row rather than editing the old
 * one: editing would reprice every job the old rate had already costed.
 */
export async function setScale(ctx: ServiceContext, input: ScaleInput) {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const seen = await answered<ReturnType<typeof shapeScale>>(tx, ctx, "wage_scale");
    if (seen) return seen;
    const classification = input.classification.trim();
    if (classification === "") {
      throw new ConflictError("A scale needs a classification. It is what an entry resolves against.");
    }

    const authority = input.authority ?? "employee_default";
    if (!(AUTHORITIES as readonly string[]).includes(authority)) {
      throw new ConflictError(
        `"${authority}" is not a wage authority. One of: ${AUTHORITIES.join(", ")}.`,
      );
    }

    const base = parseRate(input.baseRate, "base rate");
    if (!m.isPositive(base)) {
      throw new ConflictError("A base rate of zero is not a rate. Leave the scale off instead.");
    }
    if (input.fringeRate) parseRate(input.fringeRate, "fringe rate");

    if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      throw new ConflictError("That scale ends before it takes effect.");
    }

    /**
     * A prevailing wage or a collective agreement that cites nothing is a
     * number somebody typed. The whole reason those authorities are named
     * separately is that they can be checked against a document, and one
     * with no reference cannot be.
     */
    if ((authority === "wage_determination" || authority === "collective_agreement")
        && !input.externalReference?.trim()) {
      throw new ConflictError(
        `A ${authority.replace(/_/g, " ")} needs the reference it comes from, such as the determination `
        + "number or the agreement. Without one the rate cannot be checked against anything.",
      );
    }

    const [row] = await tx.insert(schema.wageScale).values({
      organizationId: ctx.actor.organizationId,
      authority,
      classification,
      jurisdiction: input.jurisdiction?.trim() || null,
      externalReference: input.externalReference?.trim() || null,
      baseRate: input.baseRate,
      fringeRate: input.fringeRate ?? null,
      overtimeMultiplier: input.overtimeMultiplier ?? null,
      doubleTimeMultiplier: input.doubleTimeMultiplier ?? null,
      apprenticeRatio: input.apprenticeRatio?.trim() || null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
    }).returning();

    await audit(tx, ctx, "wage_scale.loaded", "wage_scale", row!.id, null, row!);
    return remember(tx, ctx, "wage_scale", "wage_scale.load", shapeScale(row!));
  });
}

function parseRate(value: string, what: string) {
  try {
    const parsed = m.money(value, "USD");
    if (m.isNegative(parsed)) throw new Error("negative");
    return parsed;
  } catch {
    throw new ConflictError(`"${value}" is not a ${what}.`);
  }
}

/**
 * Close a scale off on a date rather than deleting it.
 *
 * A deleted scale unprices every entry that resolved against it, and those
 * entries have already been approved and paid. Closing it means "this stopped
 * being the rate on this day", which is what actually happened.
 */
export async function closeScale(
  ctx: ServiceContext, input: { id: string; effectiveTo: string },
) {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const [before] = await tx.select().from(schema.wageScale)
      .where(and(
        eq(schema.wageScale.id, input.id),
        eq(schema.wageScale.organizationId, ctx.actor.organizationId),
        isNull(schema.wageScale.deletedAt),
      )).limit(1);
    if (!before) throw new NotFoundError("Wage scale");

    if (before.effectiveFrom && input.effectiveTo < before.effectiveFrom) {
      throw new ConflictError("That would end the scale before it began.");
    }

    const [after] = await tx.update(schema.wageScale)
      .set({ effectiveTo: input.effectiveTo, active: false, updatedAt: new Date() })
      .where(eq(schema.wageScale.id, input.id))
      .returning();

    await audit(tx, ctx, "wage_scale.closed", "wage_scale", input.id, before, after!);
    return shapeScale(after!);
  });
}

/**
 * A new rate for a classification from a date, which is what "change the
 * scale" means: the old row closed the day before, a new row from that day
 * carrying everything else it said. One transaction, so there is never a
 * moment when the classification has no rate, or two.
 *
 * Where the old one stops is decided by core's `scaleRevision`, which
 * refuses a change dated before the scale began: that is a scale that was
 * wrong, and retiring it and loading the right one says so honestly.
 */
export async function reviseScale(
  ctx: ServiceContext,
  input: { id: string; baseRate: string; fringeRate?: string | null | undefined; effectiveFrom: string },
) {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const seen = await answered<ReturnType<typeof shapeScale>>(tx, ctx, "wage_scale_revision");
    if (seen) return seen;

    const [before] = await tx.select().from(schema.wageScale)
      .where(and(
        eq(schema.wageScale.id, input.id),
        eq(schema.wageScale.organizationId, ctx.actor.organizationId),
        isNull(schema.wageScale.deletedAt),
      )).limit(1);
    if (!before) throw new NotFoundError("Wage scale");
    if (!before.active) {
      throw new ConflictError("This scale has been retired or already changed. Change the one that replaced it.");
    }

    const base = parseRate(input.baseRate, "base rate");
    if (!m.isPositive(base)) {
      throw new ConflictError("A base rate of zero is not a rate. Retire the scale instead.");
    }
    if (input.fringeRate) parseRate(input.fringeRate, "fringe rate");

    const plan = labor.scaleRevision(before, input.effectiveFrom);
    if (!plan.ok) throw new ConflictError(plan.reason);

    const [closed] = await tx.update(schema.wageScale)
      .set({ effectiveTo: plan.closeOn, active: false, updatedAt: new Date() })
      .where(eq(schema.wageScale.id, before.id))
      .returning();

    const [row] = await tx.insert(schema.wageScale).values({
      organizationId: ctx.actor.organizationId,
      authority: before.authority,
      classification: before.classification,
      jurisdiction: before.jurisdiction,
      externalReference: before.externalReference,
      baseRate: input.baseRate,
      fringeRate: input.fringeRate === undefined ? before.fringeRate : input.fringeRate,
      overtimeMultiplier: before.overtimeMultiplier,
      doubleTimeMultiplier: before.doubleTimeMultiplier,
      apprenticeRatio: before.apprenticeRatio,
      effectiveFrom: input.effectiveFrom,
      /** An end the old scale was already given still holds for the rate that replaces it. */
      effectiveTo: before.effectiveTo,
    }).returning();

    await audit(tx, ctx, "wage_scale.revised", "wage_scale", row!.id, before, { closed: closed!, opened: row! });
    return remember(tx, ctx, "wage_scale_revision", "wage_scale.revise", shapeScale(row!));
  });
}

export async function scales(ctx: ServiceContext, input: { classification?: string } = {}) {
  return guardedRead(ctx, "timesheet:read", async (tx) => {
    const rows = await tx.select().from(schema.wageScale)
      .where(and(
        eq(schema.wageScale.organizationId, ctx.actor.organizationId),
        isNull(schema.wageScale.deletedAt),
        ...(input.classification ? [eq(schema.wageScale.classification, input.classification)] : []),
      ))
      .orderBy(asc(schema.wageScale.classification), desc(schema.wageScale.effectiveFrom));

    return rows.map(shapeScale);
  });
}

function shapeScale(row: typeof schema.wageScale.$inferSelect) {
  return {
    id: row.id,
    authority: row.authority,
    classification: row.classification,
    jurisdiction: row.jurisdiction,
    externalReference: row.externalReference,
    baseRate: row.baseRate,
    fringeRate: row.fringeRate,
    apprenticeRatio: row.apprenticeRatio,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    active: row.active,
  };
}

/* ------------------------------------------------- who is paid at what */

/**
 * Set the classification a person is normally paid at.
 *
 * A NAME rather than a link to a scale, which the schema comment already
 * explains: a scale is dated, and "Journeyman Electrician" outlives the row
 * saying what a journeyman earned in 2025.
 *
 * REFUSED WHEN NO SCALE HAS EVER CARRIED THAT NAME. A typo here produces a
 * technician whose entries resolve against nothing and cost zero, and zero
 * labour cost on a job reads as a very profitable job rather than as a
 * misspelling. Past scales count, not only current ones: somebody being put
 * back on an old classification is ordinary.
 */
export async function setClassification(
  ctx: ServiceContext,
  input: { technicianId: string; classification: string | null },
) {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const [before] = await tx.select().from(schema.technician)
      .where(and(
        eq(schema.technician.id, input.technicianId),
        eq(schema.technician.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!before) throw new NotFoundError("Technician");

    const classification = input.classification?.trim() || null;

    if (classification) {
      const [known] = await tx.select({ id: schema.wageScale.id }).from(schema.wageScale)
        .where(and(
          eq(schema.wageScale.organizationId, ctx.actor.organizationId),
          eq(schema.wageScale.classification, classification),
          isNull(schema.wageScale.deletedAt),
        )).limit(1);
      if (!known) {
        throw new ConflictError(
          `No wage scale has ever been loaded for "${classification}", so this person's time would cost `
          + "nothing, and a job with no labour cost on it reads as a very profitable job. "
          + "Load the scale first.",
        );
      }
    }

    const [after] = await tx.update(schema.technician)
      .set({ wageClassification: classification, updatedAt: new Date() })
      .where(eq(schema.technician.id, input.technicianId))
      .returning();

    await audit(tx, ctx, "technician.classification_set", "technician",
      input.technicianId, before, after!);

    return { id: after!.id, displayName: after!.displayName, classification: after!.wageClassification };
  });
}

/**
 * Who would cost what, and who would cost nothing.
 *
 * The second half is the reason this exists. A technician with no
 * classification, or one no scale covers today, produces entries that freeze
 * no rate, and the only symptom is a job that looks unusually profitable.
 */
export async function crewRates(ctx: ServiceContext, input: { on?: Date } = {}) {
  return guardedRead(ctx, "timesheet:read", async (tx) => {
    const on = input.on ?? new Date();
    const day = on.toISOString().slice(0, 10);

    const rows = await tx.select({
      id: schema.technician.id,
      displayName: schema.technician.displayName,
      classification: schema.technician.wageClassification,
      active: schema.technician.active,
    }).from(schema.technician)
      .where(eq(schema.technician.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.technician.displayName));

    const all = await tx.select().from(schema.wageScale)
      .where(and(
        eq(schema.wageScale.organizationId, ctx.actor.organizationId),
        isNull(schema.wageScale.deletedAt),
      ));

    /** The same rule `scaleOn` uses, so this screen cannot disagree with the freeze. */
    const inEffect = (classification: string) => all
      .filter((s) => s.classification === classification
        && (!s.effectiveFrom || s.effectiveFrom <= day)
        && (!s.effectiveTo || s.effectiveTo >= day))
      .sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""))[0];

    return rows.map((row) => {
      const scale = row.classification ? inEffect(row.classification) : undefined;
      return {
        id: row.id,
        displayName: row.displayName,
        active: row.active,
        classification: row.classification,
        baseRate: scale?.baseRate ?? null,
        fringeRate: scale?.fringeRate ?? null,
        /** Why their time would not be costed, in words, or null when it would. */
        unpricedBecause: row.classification === null
          ? "No classification set, so nothing is resolved when they punch out."
          : scale === undefined
            ? `No scale for "${row.classification}" is in effect today.`
            : null,
      };
    });
  });
}

/* -------------------------------------------------------------- the routes */

export const handlers = {
  listOvertimePolicies: async (ctx: ServiceContext) => ({ policies: await policies(ctx) }),
  declareOvertimePolicy: (ctx: ServiceContext, input: PolicyInput) => setPolicy(ctx, input),
  listWageScales: async (ctx: ServiceContext, input: { classification?: string | undefined }) =>
    ({ scales: await scales(ctx, input.classification ? { classification: input.classification } : {}) }),
  loadWageScale: (ctx: ServiceContext, input: ScaleInput) => setScale(ctx, input),
  reviseWageScale: (
    ctx: ServiceContext,
    input: { id: string; baseRate: string; fringeRate?: string | null | undefined; effectiveFrom: string },
  ) => reviseScale(ctx, input),
  retireWageScale: (ctx: ServiceContext, input: { id: string; effectiveTo: string }) => closeScale(ctx, input),
  listCrewRates: async (ctx: ServiceContext) => ({ people: await crewRates(ctx) }),
  setWageClassification: (
    ctx: ServiceContext, input: { technicianId: string; classification: string | null },
  ) => setClassification(ctx, input),
} as const;
