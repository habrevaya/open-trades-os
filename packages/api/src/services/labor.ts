import { and, eq, gte, lte, isNull, desc, asc, or, inArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { labor, money as m, time } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError, timezoneOf,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * TIME, AND WHAT IT COST
 *
 * `packages/core/src/labor` knows how to classify a week, apply overtime
 * without paying an hour twice under two rules, and price it. Nothing
 * connected it to the database, and the gap that left was not cosmetic.
 *
 * `timeclock_entry` carries `applied_base_rate`, `applied_fringe_rate` and
 * `applied_loaded_rate`, under a comment that reads "Frozen at close. The
 * scale can change; this entry's cost must not." Nothing ever wrote them. So
 * every entry's cost was null, every technician's hours cost nothing, and job
 * costing reported a gross margin that was missing its largest expense. A
 * contractor reading that screen would conclude their least profitable work
 * was their best.
 *
 * `wage_scale_id`, under a comment saying "THE FIELD THIS TABLE EXISTS FOR",
 * was also written by nothing.
 *
 * WHAT FREEZING MEANS, AND WHY IT IS NOT A CACHE. A rate is resolved once,
 * when the entry closes, from the scale that was in effect ON THE DAY THE
 * WORK HAPPENED, and then never recomputed. A rate read live at report time
 * changes retroactively when somebody edits a scale, so last quarter's job
 * costing moves after the quarter closed, and nobody can explain why the
 * number they wrote down is no longer the number on the screen.
 */

/** The company's policy, in the shape core takes. */
export async function policyFor(tx: Database, organizationId: string): Promise<labor.OvertimePolicy> {
  const [row] = await tx.select().from(schema.overtimePolicy)
    .where(and(
      eq(schema.overtimePolicy.organizationId, organizationId),
      eq(schema.overtimePolicy.active, true),
      isNull(schema.overtimePolicy.deletedAt),
    )).limit(1);

  if (!row) {
    /**
     * REFUSED rather than defaulted, and this is the most important line in
     * the file.
     *
     * Every plausible default is a legal position on somebody's wages. Forty
     * hours weekly at time and a half is the federal floor and is wrong in
     * California, where a ninth hour in a day is already overtime. Guessing
     * produces a timesheet that looks authoritative and underpays people, and
     * nobody discovers it by reading the screen, because the screen has no
     * way to say "these numbers rest on an assumption nobody made".
     */
    throw new ConflictError(
      "No overtime policy is set for this company. Set one before running a timesheet: "
      + "there is no safe default, because every default is a position on what somebody is owed.",
    );
  }

  return {
    label: row.label,
    timeZone: row.timeZone,
    weekStartsOn: row.weekStartsOn as labor.Weekday,
    dayAttribution: row.dayAttributionMode,
    weeklyThresholdMinutes: row.weeklyThresholdMinutes,
    weeklyDoubleTimeThresholdMinutes: row.weeklyDoubleTimeThresholdMinutes,
    dailyThresholdMinutes: row.dailyThresholdMinutes,
    dailyDoubleTimeThresholdMinutes: row.dailyDoubleTimeThresholdMinutes,
    overtimeMultiplier: row.overtimeMultiplier,
    doubleTimeMultiplier: row.doubleTimeMultiplier,
    onCallTreatment: row.onCallMode,
    punchRounding: row.roundingMinutes && row.roundingMode
      ? { toMinutes: row.roundingMinutes, mode: row.roundingMode }
      : null,
    ...(row.countsTowardOvertime
      ? { countsTowardOvertime: row.countsTowardOvertime as Partial<Record<labor.TimeEntryKind, boolean>> }
      : {}),
    note: row.note,
  };
}

/**
 * The scale in effect for this classification ON A GIVEN DAY.
 *
 * Dated on purpose. A scale row has `effective_from` and `effective_to`
 * because a union agreement raises rates on a date, and an entry worked
 * before that date must keep costing what it cost. Resolving by "the active
 * row" instead would reprice last year's jobs every time somebody loaded a
 * new agreement.
 */
export async function scaleOn(
  tx: Database, organizationId: string, classification: string, on: Date,
): Promise<typeof schema.wageScale.$inferSelect | null> {
  const day = on.toISOString().slice(0, 10);
  const [row] = await tx.select().from(schema.wageScale)
    .where(and(
      eq(schema.wageScale.organizationId, organizationId),
      eq(schema.wageScale.classification, classification),
      isNull(schema.wageScale.deletedAt),
      or(isNull(schema.wageScale.effectiveFrom), lte(schema.wageScale.effectiveFrom, day)),
      or(isNull(schema.wageScale.effectiveTo), gte(schema.wageScale.effectiveTo, day)),
    ))
    /**
     * The most recently effective wins where two overlap. Overlapping scales
     * are a data error rather than a state to model, and picking the newer
     * one is the answer an operator expects when they have just loaded a
     * correction on top of a mistake.
     */
    .orderBy(desc(schema.wageScale.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/**
 * Freeze what an entry cost, at the moment it closes.
 *
 * Called from the field sync when a punch out lands. Silent when there is no
 * classification and no scale: a company that does not run wage scales should
 * not have its punches refused, and an entry with no rate is visibly
 * unpriced rather than wrongly priced.
 */
export async function freezeRate(
  tx: Database, organizationId: string, entryId: string,
): Promise<void> {
  const [entry] = await tx.select({
    id: schema.timeclockEntry.id,
    technicianId: schema.timeclockEntry.technicianId,
    classification: schema.timeclockEntry.classification,
    startedAt: schema.timeclockEntry.startedAt,
    appliedBaseRate: schema.timeclockEntry.appliedBaseRate,
  }).from(schema.timeclockEntry)
    .where(eq(schema.timeclockEntry.id, entryId)).limit(1);
  if (!entry) return;

  /**
   * Never re-frozen. A second punch out on a corrected entry must not move a
   * rate that has already been used to cost a job, which is the whole meaning
   * of the word.
   */
  if (entry.appliedBaseRate) return;

  /**
   * The classification captured at the punch wins over the technician's
   * current one. Somebody promoted in March did not become a journeyman in
   * February's timesheet.
   */
  let classification = entry.classification;
  if (!classification) {
    const [tech] = await tx.select({ c: schema.technician.wageClassification })
      .from(schema.technician)
      .where(eq(schema.technician.id, entry.technicianId)).limit(1);
    classification = tech?.c ?? null;
  }
  if (!classification) return;

  const scale = await scaleOn(tx, organizationId, classification, entry.startedAt);
  if (!scale) return;

  await tx.update(schema.timeclockEntry).set({
    wageScaleId: scale.id,
    classification,
    appliedBaseRate: scale.baseRate,
    appliedFringeRate: scale.fringeRate,
    /**
     * Base plus fringe. NOT a burden multiplier, because this product does
     * not know this company's burden rate and inventing one would put a
     * number into job costing that nobody chose. When a burden rate is a real
     * setting, this is where it multiplies.
     */
    appliedLoadedRate: scale.fringeRate
      ? m.toString(m.add(m.money(scale.baseRate, "USD"), m.money(scale.fringeRate, "USD")))
      : scale.baseRate,
    updatedAt: new Date(),
  }).where(eq(schema.timeclockEntry.id, entryId));
}

export interface WeekRow {
  technicianId: string;
  technicianName: string;
  classification: string | null;
  regularHours: string;
  overtimeHours: string;
  doubleTimeHours: string;
  totalHours: string;
  /** Null when no rate was ever frozen onto the entries. */
  cost: string | null;
  openEntries: number;
  unapproved: number;
}

const hours = (seconds: number): string => (seconds / 3600).toFixed(2);

/**
 * A week, per person, classified by core.
 *
 * The classification is NOT stored. It is derived from the entries every time
 * it is asked for, for the same reason a stock level is: a stored overtime
 * total is a number somebody can edit, and a payroll figure nobody can
 * explain is the one thing worse than a wrong one. What IS stored is the rate
 * each entry was frozen at, because that is a fact about a day rather than a
 * conclusion about a week.
 */
export async function week(
  ctx: ServiceContext,
  input: { weekOf: string; technicianId?: string },
): Promise<{ policy: labor.OvertimePolicy; weekStart: string; rows: WeekRow[] }> {
  return guardedRead(ctx, "timesheet:read", async (tx) => {
    const policy = await policyFor(tx, ctx.actor.organizationId);
    const weekStart = labor.weekStartDate(input.weekOf, policy.weekStartsOn);

    /**
     * Bounded in the COMPANY's zone, and widened by a day on each side.
     *
     * A shift that starts at eleven at night on the last day of the week has
     * hours in the week and a `started_at` that a naive UTC bound can put
     * outside it. The widening costs one extra day of rows and is what stops
     * a night shift disappearing from the week it was worked.
     */
    const zone = policy.timeZone;
    const { start } = time.dayBoundsIn(weekStart, zone);
    const { end } = time.dayBoundsIn(
      new Date(Date.parse(`${weekStart}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10),
      zone,
    );

    const rows = await tx.select({
      entry: schema.timeclockEntry,
      technicianName: schema.technician.displayName,
    }).from(schema.timeclockEntry)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.timeclockEntry.technicianId))
      .where(and(
        eq(schema.timeclockEntry.organizationId, ctx.actor.organizationId),
        gte(schema.timeclockEntry.startedAt, new Date(start.getTime() - 864e5)),
        lte(schema.timeclockEntry.startedAt, new Date(end.getTime() + 864e5)),
        ...(input.technicianId
          ? [eq(schema.timeclockEntry.technicianId, input.technicianId)]
          : []),
      ))
      .orderBy(asc(schema.timeclockEntry.startedAt));

    const byPerson = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byPerson.get(row.entry.technicianId) ?? [];
      list.push(row);
      byPerson.set(row.entry.technicianId, list);
    }

    const out: WeekRow[] = [];
    for (const [technicianId, list] of byPerson) {
      const entries: labor.TimeEntry[] = list.map((row) => ({
        id: row.entry.id,
        personId: technicianId,
        kind: row.entry.kind as labor.TimeEntryKind,
        startedAt: row.entry.startedAt,
        endedAt: row.entry.endedAt,
        ...(row.entry.jobId ? { jobId: row.entry.jobId } : {}),
      }));

      /**
       * Open entries are EXCLUDED from the classification and counted
       * separately. Core refuses a week containing one, and it is right to:
       * an entry still running is worth an unknown amount, and paying an
       * unknown amount as zero is the failure it exists to prevent. The count
       * is what puts it on the screen instead.
       */
      const open = entries.filter((e) => e.endedAt === null).length;
      const closed = entries.filter((e) => e.endedAt !== null);

      const weeks = labor.classifyWeeks(closed, policy);
      const thisWeek = weeks.find((w) => w.weekStartDate === weekStart);

      const regular = thisWeek?.regularSeconds ?? 0;
      const overtime = thisWeek?.overtimeSeconds ?? 0;
      const doubleTime = thisWeek?.doubleTimeSeconds ?? 0;

      /**
       * Costed from the FROZEN rate on each entry, not from a rate looked up
       * now. An entry with no frozen rate contributes nothing and makes the
       * whole row's cost null rather than a smaller number, because a partial
       * total that looks complete is worse than a blank.
       */
      const priced = list.filter((row) => row.entry.endedAt && row.entry.appliedBaseRate);
      const anyUnpriced = list.some((row) => row.entry.endedAt && !row.entry.appliedBaseRate);

      let cost: string | null = null;
      if (priced.length > 0 && !anyUnpriced && thisWeek) {
        /**
         * One blended base rate for the week, weighted by the hours at each.
         *
         * Not exact where somebody worked two classifications in one week and
         * the overtime fell in the more expensive one. Saying so here rather
         * than implying a precision this does not have: an exact answer needs
         * overtime attributed back to the specific hours that caused it,
         * which is a policy question this product has not asked the operator
         * yet, and which differs by jurisdiction.
         */
        const totalSeconds = priced.reduce((t, row) => t + (row.entry.minutes ?? 0) * 60, 0);
        if (totalSeconds > 0) {
          let weighted = m.zero("USD");
          for (const row of priced) {
            const seconds = (row.entry.minutes ?? 0) * 60;
            weighted = m.add(weighted, m.multiply(
              m.money(row.entry.appliedLoadedRate ?? row.entry.appliedBaseRate ?? "0", "USD"),
              (seconds / totalSeconds).toFixed(6),
            ));
          }
          const base = weighted;
          cost = m.toString(m.add(
            m.add(labor.payFor(base, regular), labor.payFor(labor.overtimeRate(base, policy.overtimeMultiplier), overtime)),
            labor.payFor(labor.overtimeRate(base, policy.doubleTimeMultiplier), doubleTime),
          ));
        }
      }

      out.push({
        technicianId,
        technicianName: list[0]!.technicianName,
        classification: list.find((row) => row.entry.classification)?.entry.classification ?? null,
        regularHours: hours(regular),
        overtimeHours: hours(overtime),
        doubleTimeHours: hours(doubleTime),
        totalHours: hours(regular + overtime + doubleTime),
        cost,
        openEntries: open,
        unapproved: list.filter((row) => row.entry.endedAt && !row.entry.approvedAt).length,
      });
    }

    out.sort((a, b) => a.technicianName.localeCompare(b.technicianName));
    return { policy, weekStart, rows: out };
  });
}

/**
 * A supervisor signing off on somebody's hours.
 *
 * `approved_at` and `approved_by_user_id` were columns nothing wrote, which
 * meant a timesheet screen could show an approval state that was always the
 * same and always false.
 */
export async function approve(
  ctx: ServiceContext, input: { entryIds: string[] },
): Promise<{ approved: number }> {
  return guardedWrite(ctx, "timesheet:approve", async (tx) => {
    if (input.entryIds.length === 0) return { approved: 0 };

    const open = await tx.select({ id: schema.timeclockEntry.id })
      .from(schema.timeclockEntry)
      .where(and(
        eq(schema.timeclockEntry.organizationId, ctx.actor.organizationId),
        isNull(schema.timeclockEntry.endedAt),
        inArray(schema.timeclockEntry.id, input.entryIds),
      ));

    if (open.length > 0) {
      /**
       * An entry still running cannot be approved. Approving one means
       * signing off on hours that have not finished happening, and the number
       * it would be signed off at is whatever it reached at the moment
       * somebody clicked.
       */
      throw new ConflictError(
        `${open.length} of those are still running. Close them before approving.`,
      );
    }

    const updated = await tx.update(schema.timeclockEntry).set({
      approvedAt: new Date(),
      approvedByUserId: ctx.actor.userId,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.timeclockEntry.organizationId, ctx.actor.organizationId),
      isNull(schema.timeclockEntry.approvedAt),
      inArray(schema.timeclockEntry.id, input.entryIds),
    )).returning({ id: schema.timeclockEntry.id });

    /**
     * One audit entry naming the first row and the count, rather than one per
     * entry. A supervisor approving a fortnight would otherwise write eighty
     * audit rows for one click, which buries the things somebody searches the
     * audit log to find.
     */
    if (updated[0]) {
      await audit(tx, ctx, "timesheet.approved", "timeclock_entry", updated[0].id, null,
        { count: updated.length, entryIds: input.entryIds });
    }

    return { approved: updated.length };
  });
}

/** Entries for one person in one week, for the screen a supervisor drills into. */
export async function entriesFor(
  ctx: ServiceContext, input: { technicianId: string; weekOf: string },
) {
  return guardedRead(ctx, "timesheet:read", async (tx) => {
    const policy = await policyFor(tx, ctx.actor.organizationId);
    const weekStart = labor.weekStartDate(input.weekOf, policy.weekStartsOn);
    const { start } = time.dayBoundsIn(weekStart, policy.timeZone);
    const { end } = time.dayBoundsIn(
      new Date(Date.parse(`${weekStart}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10),
      policy.timeZone,
    );

    const rows = await tx.select().from(schema.timeclockEntry)
      .where(and(
        eq(schema.timeclockEntry.organizationId, ctx.actor.organizationId),
        eq(schema.timeclockEntry.technicianId, input.technicianId),
        gte(schema.timeclockEntry.startedAt, new Date(start.getTime() - 864e5)),
        lte(schema.timeclockEntry.startedAt, new Date(end.getTime() + 864e5)),
      ))
      .orderBy(asc(schema.timeclockEntry.startedAt));

    if (rows.length === 0) throw new NotFoundError("Timesheet");
    return { weekStart, entries: rows };
  });
}

/* --------------------------------------------------------------- handlers */

/**
 * The policy as the contract publishes it: the fields that explain the
 * numbers, spelled out rather than imported, so the handler table's inferred
 * type does not name core's internal module path. `punchRounding` and
 * `countsTowardOvertime` are deliberately left off the wire for now, because
 * a field published non-optionally and then found to be unwritten is the
 * defect this codebase spends most of its time removing.
 */
export interface PolicyOnTheWire {
  label: string;
  timeZone: string;
  weekStartsOn: number;
  dayAttribution: "shift_start" | "split_at_midnight";
  weeklyThresholdMinutes: number | null;
  weeklyDoubleTimeThresholdMinutes: number | null;
  dailyThresholdMinutes: number | null;
  dailyDoubleTimeThresholdMinutes: number | null;
  overtimeMultiplier: string;
  doubleTimeMultiplier: string;
  onCallTreatment: "separate_rate_not_hours_worked" | "hours_worked_at_base";
}

export const handlers = {
  /**
   * The policy is returned alongside the rows rather than left implicit,
   * because a week of hours means nothing without the rule that classified
   * it. Its type is spelled out here so this table does not name core's
   * internal module path.
   */
  getTimesheetWeek: (ctx: ServiceContext, input: {
    weekOf: string; technicianId?: string | undefined;
  }): Promise<{ weekStart: string; policy: PolicyOnTheWire; rows: WeekRow[] }> =>
    week(ctx, {
      weekOf: input.weekOf,
      ...(input.technicianId ? { technicianId: input.technicianId } : {}),
    }),

  listTimeEntries: (ctx: ServiceContext, input: { technicianId: string; weekOf: string }) =>
    entriesFor(ctx, input),

  approveTimeEntries: (ctx: ServiceContext, input: { entryIds: readonly string[] }) =>
    approve(ctx, { entryIds: [...input.entryIds] }),
} as const;
