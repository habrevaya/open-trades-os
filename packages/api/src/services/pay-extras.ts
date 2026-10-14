import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { payExtras as px, time } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, timezoneOf, ConflictError, type ServiceContext } from "./context";

/**
 * WHAT A COMPANY PAYS BESIDE HOURS, AS A COMPANY CHOICE
 *
 * The rate for a day away from home, and how a customer's tip is shared between
 * the people on a job. Both are statements about what people are owed, so
 * changing them is `payroll:configure`, the permission for declaring the
 * overtime rule and loading a wage scale.
 *
 * Kept in `organization.settings.payExtras` beside the company's other
 * settings and read through core, so a hand edited blob can only ever read as
 * the defaults: no per diem is paid, and a tip is shared evenly.
 *
 * A CHANGE APPLIES FROM THEN ON. A per diem day keeps the rate it was
 * recorded at, for the reason a punch keeps its wage. A tip is shared the
 * moment the customer pays it, with whatever rule is in force then, and the
 * rule is kept on each share, so a tip already split is never re-split by a
 * new choice.
 */

export async function settingsWithin(tx: Database, organizationId: string): Promise<px.PaySettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return px.readPaySettings(((row?.settings ?? {}) as Record<string, unknown>)["payExtras"]);
}

export interface PayExtrasView {
  /** What a day away is worth, in dollars and cents. Null until somebody sets it, which pays none. */
  perDiemRate: string | null;
  /** How a tip is shared between the people on the job it was left for, from the next tip on. */
  tipSplit: px.TipSplitRule;
  /** What each rule means, in the words the screen shows beside the choice. */
  rules: { rule: px.TipSplitRule; label: string }[];
  /** What one mile is paid, one line per starting day, oldest first. Empty pays none. */
  mileageRates: px.MileageRate[];
  /** The rate in force today in the company's zone, or null when none has started. */
  mileageRateToday: string | null;
}

const view = (settings: px.PaySettings, today: string): PayExtrasView => ({
  perDiemRate: settings.perDiemRate,
  tipSplit: settings.tipSplit,
  rules: px.TIP_SPLIT_RULES.map((rule) => ({ rule, label: px.TIP_SPLIT_LABEL[rule] })),
  mileageRates: settings.mileageRates,
  mileageRateToday: px.mileageRateOn(settings.mileageRates, today)?.perMile ?? null,
});

const todayOf = async (tx: Database, organizationId: string) => time.dateIn(new Date(), await timezoneOf(tx, organizationId));

/** Read with the timesheet, which is who needs to see what a day away is worth. */
export async function get(ctx: ServiceContext): Promise<PayExtrasView> {
  return guardedRead(ctx, "timesheet:read", async (tx) =>
    view(await settingsWithin(tx, ctx.actor.organizationId), await todayOf(tx, ctx.actor.organizationId)));
}

export interface PayExtrasInput {
  /** The day away rate, or null to stop paying one. Left out, it stays as it was. */
  perDiemRate?: string | null | undefined;
  /** Left out, it stays as it was. */
  tipSplit?: px.TipSplitRule | undefined;
}

export async function set(ctx: ServiceContext, input: PayExtrasInput): Promise<PayExtrasView> {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const before = await settingsWithin(tx, ctx.actor.organizationId);
    let perDiemRate = before.perDiemRate;
    if (input.perDiemRate !== undefined) {
      if (input.perDiemRate === null || input.perDiemRate.trim() === "") {
        perDiemRate = null;
      } else {
        const checked = px.checkPerDiemRate(input.perDiemRate);
        if (!checked.ok) throw new ConflictError(checked.reason);
        perDiemRate = checked.rate;
      }
    }
    const after: px.PaySettings = { perDiemRate, tipSplit: input.tipSplit ?? before.tipSplit, mileageRates: before.mileageRates };
    await write(tx, ctx, "pay_extras.set", before, after);
    return view(after, await todayOf(tx, ctx.actor.organizationId));
  });
}

async function write(tx: Database, ctx: ServiceContext, action: string, before: px.PaySettings, after: px.PaySettings) {
  await tx.update(schema.organization).set({
    settings: sql`${schema.organization.settings} || ${JSON.stringify({ payExtras: after })}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(schema.organization.id, ctx.actor.organizationId));
  await audit(tx, ctx, action, "organization", ctx.actor.organizationId, before, after);
}

/**
 * WHAT ONE MILE IS PAID, FROM A DAY.
 *
 * A history rather than one number: a claim for last month is worked out at the
 * rate in force last month. Each line is a company choice about what people are
 * owed, so `payroll:configure`. A claim keeps the rate it was worked out at
 * (`expense.mileage_rate`), so adding or taking off a line here never changes
 * one already made. Kept with the other pay settings and read through core, so a
 * hand edited blob reads as no rate, which pays no mileage.
 *
 * Mileage is a reimbursement and is exported as one; it is not posted to the
 * ledger, for the reason a receipt is not (see `services/expenses.ts`).
 */
export async function addMileageRate(ctx: ServiceContext, input: { from: string; perMile: string }): Promise<PayExtrasView> {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const before = await settingsWithin(tx, ctx.actor.organizationId);
    /** The same line sent again, by a caller that lost the answer, is the first one back and changes nothing. */
    const same = px.checkMileageRate(input);
    if (same.ok && before.mileageRates.some((r) => r.from === same.rate.from && r.perMile === same.rate.perMile)) {
      return view(before, await todayOf(tx, ctx.actor.organizationId));
    }
    const added = px.addMileageRate(before.mileageRates, input);
    if (!added.ok) throw new ConflictError(added.reason);
    const after: px.PaySettings = { ...before, mileageRates: added.rates };
    await write(tx, ctx, "mileage_rate.added", before, after);
    return view(after, await todayOf(tx, ctx.actor.organizationId));
  });
}

export async function removeMileageRate(ctx: ServiceContext, input: { from: string }): Promise<PayExtrasView> {
  return guardedWrite(ctx, "payroll:configure", async (tx) => {
    const before = await settingsWithin(tx, ctx.actor.organizationId);
    /** Nothing starts that day: taking it off again changes nothing, so a retry is not an error. */
    if (!before.mileageRates.some((r) => r.from === input.from)) {
      return view(before, await todayOf(tx, ctx.actor.organizationId));
    }
    const removed = px.removeMileageRate(before.mileageRates, input.from);
    if (!removed.ok) throw new ConflictError(removed.reason);
    const after: px.PaySettings = { ...before, mileageRates: removed.rates };
    await write(tx, ctx, "mileage_rate.removed", before, after);
    return view(after, await todayOf(tx, ctx.actor.organizationId));
  });
}

export const handlers = {
  getPayExtras: (ctx: ServiceContext) => get(ctx),
  setPayExtras: (ctx: ServiceContext, input: PayExtrasInput) => set(ctx, input),
  addMileageRate: (ctx: ServiceContext, input: { from: string; perMile: string }) => addMileageRate(ctx, input),
  removeMileageRate: (ctx: ServiceContext, input: { from: string }) => removeMileageRate(ctx, input),
} as const;
