import { eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";

/**
 * THE COMPANY'S WORKING DAY: when it starts and when it ends
 *
 * When the day starts is the dispatch travel setting (`dispatchTravel.dayStartsAt`)
 * and when it ends the working day setting (`dispatchWorkday.dayEndsAt`), both in
 * `organization.settings`, read and set by `dispatch-map.ts`. The defaults live
 * here so the board, which cannot import the map's planner, reads the same day
 * the planner plans: eight to five until the company says otherwise.
 */
export const DEFAULT_DAY_STARTS_AT = "08:00";
export const DEFAULT_DAY_ENDS_AT = "17:00";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function companyDayOf(tx: Database, organizationId: string): Promise<{ startsAt: string; endsAt: string }> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const settings = (row?.settings ?? {}) as Record<string, { dayStartsAt?: unknown; dayEndsAt?: unknown } | undefined>;
  const startsAt = settings["dispatchTravel"]?.dayStartsAt;
  const endsAt = settings["dispatchWorkday"]?.dayEndsAt;
  return {
    startsAt: typeof startsAt === "string" && HHMM.test(startsAt) ? startsAt : DEFAULT_DAY_STARTS_AT,
    endsAt: typeof endsAt === "string" && HHMM.test(endsAt) ? endsAt : DEFAULT_DAY_ENDS_AT,
  };
}
