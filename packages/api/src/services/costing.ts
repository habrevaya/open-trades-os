import { and, asc, eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { costing as c, money as m, time, SYSTEM_USER_ID } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, timezoneOf,
  ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";

/**
 * M15. THE RATES BEHIND THE FULLY LOADED MARGIN
 *
 * Labour burden (payroll taxes, benefits, workers' compensation) and overhead,
 * each a history of dated rates. Read here and on the settings screen; applied
 * to the job costing report and every job's statement by the SQL in
 * `report-catalogue.ts`, which reads this same table, so a rate saved here is
 * in the next report anybody runs.
 *
 * `finance:configure` to change one, because a rate changes what every
 * fully loaded margin in the company says. `job.cost:read` to read them,
 * because a burden rate is a cost.
 */

export interface RateView {
  id: string;
  component: c.Component;
  componentLabel: string;
  basis: c.Basis;
  basisLabel: string;
  rate: string;
  effectiveFrom: string;
  note: string | null;
  /** In effect today, as opposed to past or scheduled. */
  current: boolean;
  createdAt: string;
}

/** The overhead charged today, part by part, for the settings screen to say in a sentence. */
export interface OverheadNow {
  effectiveFrom: string;
  parts: { basis: c.OverheadBasis; label: string; rate: string }[];
}

export async function list(ctx: ServiceContext): Promise<{ rates: RateView[]; today: string; overheadNow: OverheadNow | null }> {
  return guardedRead(ctx, "job.cost:read", async (tx) => {
    const rows = await tx.select().from(schema.costingRate)
      .where(eq(schema.costingRate.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.costingRate.component), asc(schema.costingRate.effectiveFrom));
    const today = time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const all = rows.map(toRate);
    const currentIds = new Set(c.BURDEN_COMPONENTS
      .map((component) => {
        const hit = c.rateOn(all, component, today);
        return hit ? rows.find((r) => r.component === component && r.effectiveFrom === hit.effectiveFrom)?.id : undefined;
      })
      .filter((id): id is string => !!id));
    /** Overhead is in effect as a whole mix: every row on its latest day. */
    const mix = c.overheadMixOn(all, today);
    for (const r of rows) {
      if (r.component === "overhead" && mix.some((x) => x.effectiveFrom === r.effectiveFrom)) currentIds.add(r.id);
    }
    return {
      today,
      overheadNow: mix.length === 0 ? null : {
        effectiveFrom: mix[0]!.effectiveFrom,
        parts: c.OVERHEAD_BASES.flatMap((basis) => mix.filter((x) => x.basis === basis)
          .map((x) => ({ basis, label: c.OVERHEAD_PART_LABEL[basis], rate: trim(x.rate) }))),
      },
      rates: rows.map((r) => ({
        id: r.id,
        component: r.component,
        componentLabel: c.COMPONENT_LABEL[r.component],
        basis: r.basis,
        basisLabel: c.BASIS_LABEL[r.basis],
        rate: trim(r.rate),
        effectiveFrom: r.effectiveFrom,
        note: r.note,
        current: currentIds.has(r.id),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}

const view = (row: typeof schema.costingRate.$inferSelect): RateView => ({
  id: row.id, component: row.component, componentLabel: c.COMPONENT_LABEL[row.component],
  basis: row.basis, basisLabel: c.BASIS_LABEL[row.basis], rate: trim(row.rate),
  effectiveFrom: row.effectiveFrom, note: row.note, current: false, createdAt: row.createdAt.toISOString(),
});

const toRate = (r: typeof schema.costingRate.$inferSelect): c.CostingRate => ({
  component: r.component, basis: r.basis, rate: r.rate, effectiveFrom: r.effectiveFrom,
});

/** "7.6500" back to "7.65" for reading; the column keeps four places. */
const trim = (value: string) => value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/**
 * Add a rate from a date.
 *
 * A second rate for the same component on the same day is refused in words
 * rather than left to `costing_rate_part_day_idx`: "which rate applied on the
 * 1st" must have one answer, and changing the one already there is a delete
 * and a new rate, so the history says it was changed.
 *
 * Overhead is the exception by basis: an overhead rate on a day that already
 * has overhead by ANOTHER basis is a second part of that day's mix, and is
 * added. The same basis twice is still two answers.
 */
export async function set(
  ctx: ServiceContext,
  input: { component: string; basis: string; rate: string; effectiveFrom: string; note?: string | undefined },
): Promise<RateView> {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const checked = c.checkRate(input);
    if (!checked.ok) throw new UnprocessableError("That rate cannot be saved", [{ path: checked.field, message: checked.reason }]);
    const component = input.component as c.Component;

    const [clash] = await tx.select().from(schema.costingRate)
      .where(and(
        eq(schema.costingRate.organizationId, ctx.actor.organizationId),
        eq(schema.costingRate.component, component),
        eq(schema.costingRate.effectiveFrom, input.effectiveFrom),
        ...(component === "overhead" ? [eq(schema.costingRate.basis, input.basis as c.Basis)] : []),
      )).limit(1);
    /**
     * The same rate sent again is the same request, retried: it returns what
     * is there. A different rate on that day is a second answer to "which
     * rate applied on the 1st", and is refused.
     */
    if (clash && clash.basis === input.basis
      && m.compare(m.money(clash.rate), m.money(input.rate.trim())) === 0) {
      return view(clash);
    }
    if (clash) {
      throw new ConflictError(
        `${c.COMPONENT_LABEL[component]} already has a rate from ${input.effectiveFrom}. `
        + "Remove that one first, or start the new rate on a different day.",
      );
    }

    const [row] = await tx.insert(schema.costingRate).values({
      organizationId: ctx.actor.organizationId,
      component,
      basis: input.basis as c.Basis,
      rate: m.toString(m.money(input.rate.trim())),
      effectiveFrom: input.effectiveFrom,
      note: input.note?.trim() || null,
      createdByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    }).returning();
    await audit(tx, ctx, "costing.rate_set", "costing_rate", row!.id, null, row!);
    return view(row!);
  });
}

/**
 * Remove a rate, for one entered by mistake. The margins it fed are worked
 * out again on the next read, because nothing stores a fully loaded figure:
 * that is the point of keeping the arithmetic in one SQL fragment.
 */
export async function remove(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const [row] = await tx.delete(schema.costingRate)
      .where(and(eq(schema.costingRate.id, input.id), eq(schema.costingRate.organizationId, ctx.actor.organizationId)))
      .returning();
    if (!row) throw new NotFoundError("Rate");
    await audit(tx, ctx, "costing.rate_removed", "costing_rate", row.id, row, null);
    return { id: row.id, removed: true };
  });
}

/**
 * Overhead from a date, as a mix: per paid hour, per job, as a share of
 * revenue or of material cost, per visit and per truck day, any of them left
 * empty. The settings screen's form,
 * and the way to change a mix, because a mix is replaced whole on a new day
 * (see `costing.overheadMixOn` in core): what was charged before keeps being
 * charged to the jobs of its own days.
 *
 * A day that already has overhead is refused in words unless the same mix is
 * sent again, which is a retried request and returns what is there. Changing a
 * day's mix is removing its parts and setting it again, so the history says
 * so.
 */
export async function setOverhead(
  ctx: ServiceContext,
  input: {
    effectiveFrom: string; perHour?: string | undefined; perJob?: string | undefined;
    percentOfRevenue?: string | undefined; percentOfMaterial?: string | undefined;
    perVisit?: string | undefined; perTruck?: string | undefined; note?: string | undefined;
  },
): Promise<{ effectiveFrom: string; rates: RateView[] }> {
  return guardedWrite(ctx, "finance:configure", async (tx) => {
    const checked = c.checkOverheadMix(input);
    if (!checked.ok) throw new UnprocessableError("That overhead cannot be saved", [{ path: checked.field, message: checked.reason }]);

    const there = await tx.select().from(schema.costingRate)
      .where(and(
        eq(schema.costingRate.organizationId, ctx.actor.organizationId),
        eq(schema.costingRate.component, "overhead"),
        eq(schema.costingRate.effectiveFrom, input.effectiveFrom),
      ));
    if (there.length > 0) {
      const same = there.length === checked.parts.length && checked.parts.every((part) => there.some((row) =>
        row.basis === part.basis && m.compare(m.money(row.rate), m.money(part.rate)) === 0));
      if (same) return { effectiveFrom: input.effectiveFrom, rates: there.map(view) };
      throw new ConflictError(
        `Overhead already has rates from ${input.effectiveFrom}. Remove those first, or start the new overhead on a different day.`,
      );
    }

    const rows = await tx.insert(schema.costingRate).values(checked.parts.map((part) => ({
      organizationId: ctx.actor.organizationId,
      component: "overhead" as const,
      basis: part.basis,
      rate: m.toString(m.money(part.rate)),
      effectiveFrom: input.effectiveFrom,
      note: input.note?.trim() || null,
      createdByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    }))).returning();
    for (const row of rows) await audit(tx, ctx, "costing.rate_set", "costing_rate", row.id, null, row);
    return { effectiveFrom: input.effectiveFrom, rates: rows.map(view) };
  });
}

/** What an hour costs at a wage, today, for the settings screen to show beside the rates. */
export async function hour(ctx: ServiceContext, input: { baseRate: string; on?: string | undefined }) {
  return guardedRead(ctx, "job.cost:read", async (tx) => {
    if (!/^\d{1,4}(\.\d{1,4})?$/.test(input.baseRate)) {
      throw new UnprocessableError("Not a wage", [{ path: "baseRate", message: "A wage is an amount an hour." }]);
    }
    const rows = await tx.select().from(schema.costingRate)
      .where(eq(schema.costingRate.organizationId, ctx.actor.organizationId));
    const on = input.on ?? time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));
    const priced = c.hourAt(input.baseRate, on, rows.map(toRate));
    return {
      on,
      wage: m.toString(priced.wage),
      burden: m.toString(m.round(priced.burden)),
      overhead: m.toString(priced.overhead),
      total: m.toString(m.round(priced.total)),
    };
  });
}

export const handlers = {
  listCostingRates: (ctx: ServiceContext) => list(ctx),
  setCostingRate: (ctx: ServiceContext, input: {
    component: string; basis: string; rate: string; effectiveFrom: string; note?: string | undefined;
  }) => set(ctx, input),
  removeCostingRate: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
  setOverheadMix: (ctx: ServiceContext, input: {
    effectiveFrom: string; perHour?: string | undefined; perJob?: string | undefined;
    percentOfRevenue?: string | undefined; percentOfMaterial?: string | undefined;
    perVisit?: string | undefined; perTruck?: string | undefined; note?: string | undefined;
  }) => setOverhead(ctx, input),
} as const;
