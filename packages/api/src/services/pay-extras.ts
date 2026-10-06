import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { payExtras as px } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, ConflictError, type ServiceContext } from "./context";

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

export async function settingsWithin(tx: Database, organizationId: string): Promise<px.PayExtras> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return px.readPayExtras(((row?.settings ?? {}) as Record<string, unknown>)["payExtras"]);
}

export interface PayExtrasView {
  /** What a day away is worth, in dollars and cents. Null until somebody sets it, which pays none. */
  perDiemRate: string | null;
  /** How a tip is shared between the people on the job it was left for, from the next tip on. */
  tipSplit: px.TipSplitRule;
  /** What each rule means, in the words the screen shows beside the choice. */
  rules: { rule: px.TipSplitRule; label: string }[];
}

const view = (settings: px.PayExtras): PayExtrasView => ({
  perDiemRate: settings.perDiemRate,
  tipSplit: settings.tipSplit,
  rules: px.TIP_SPLIT_RULES.map((rule) => ({ rule, label: px.TIP_SPLIT_LABEL[rule] })),
});

/** Read with the timesheet, which is who needs to see what a day away is worth. */
export async function get(ctx: ServiceContext): Promise<PayExtrasView> {
  return guardedRead(ctx, "timesheet:read", async (tx) => view(await settingsWithin(tx, ctx.actor.organizationId)));
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
    const after: px.PayExtras = { perDiemRate, tipSplit: input.tipSplit ?? before.tipSplit };
    await tx.update(schema.organization).set({
      settings: sql`${schema.organization.settings} || ${JSON.stringify({ payExtras: after })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "pay_extras.set", "organization", ctx.actor.organizationId, before, after);
    return view(after);
  });
}

export const handlers = {
  getPayExtras: (ctx: ServiceContext) => get(ctx),
  setPayExtras: (ctx: ServiceContext, input: PayExtrasInput) => set(ctx, input),
} as const;
