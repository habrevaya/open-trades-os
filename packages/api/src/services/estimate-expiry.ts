import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, time, type Actor } from "@opentradesos/core";
import { audit, inTenant, timezoneOf, type ServiceContext } from "./context";

/**
 * AN ESTIMATE PAST ITS DATE IS MARKED EXPIRED, BY THE WORKER
 *
 * `expires_on` was a date the proposal printed under "Good until" and the
 * pipeline was meant to honour, and nothing ever acted on it: `expired` was a
 * status only an estimate migrated from another system could arrive with, so a
 * quote that went out in March was "sent" in October and sat in the unsold
 * list as work the company could still close.
 *
 * THE COMPANY'S DAY, NOT UTC'S. "Good until the 30th" means through the end of
 * the 30th where the company is. Compared against the UTC date, an estimate
 * for a company in Austin would expire at seven in the evening on the 30th,
 * with the customer's last evening still ahead of them. It is expired on the
 * company's first moment of the 31st.
 *
 * ONLY WHAT IS OPEN. A `sent` or `viewed` estimate is one the customer was
 * given and has not answered. A draft has not gone anywhere, so its date has
 * not started running; approved, declined and converted are decisions, and an
 * estimate the customer said yes to does not stop being agreed because the
 * date on the paper passed. They are never selected, so they are never
 * touched.
 *
 * IDEMPOTENT BECAUSE OF THE WHERE CLAUSE. The update selects only the open
 * statuses, so an estimate it already marked is not selected again, a pass
 * repeated or run by two workers marks each estimate once, and the audit line
 * is written for the rows that actually changed.
 *
 * WHAT EXPIRED DOES, said where the rules are: it leaves the unsold pipeline,
 * it is the label on every screen, and financing is not offered on it.
 * Nothing else is taken away. An expiry date is a nudge and not a cliff
 * (`DECIDABLE` in `estimates.ts`): a customer who says yes to a quote a week
 * late is still saying yes, and the office can still record it.
 */

/** What the worker acts as here: it reads and writes estimates and nothing else. */
function workerActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["estimate:read", "estimate:write"],
    agentId: "estimate-expiry",
  };
}

/** The statuses an estimate has when the customer has it and has not answered. */
export const OPEN_STATUSES = ["sent", "viewed"] as const;

export interface ExpiredEstimate { id: string; number: number; expiresOn: string }

/**
 * Mark this company's estimates past their date as expired, as of `now` in the
 * company's own calendar. Returns the ones it changed.
 */
export async function expireFor(
  db: Database, organizationId: string, now: Date = new Date(),
): Promise<ExpiredEstimate[]> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  return inTenant(ctx, async (tx) => expireWithin(tx, ctx, now));
}

/** The same, inside a transaction that is already in the tenant. */
export async function expireWithin(tx: Database, ctx: ServiceContext, now: Date): Promise<ExpiredEstimate[]> {
  const today = time.dateIn(now, await timezoneOf(tx, ctx.actor.organizationId));
  const changed = await tx.update(schema.estimate)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(
      eq(schema.estimate.organizationId, ctx.actor.organizationId),
      inArray(schema.estimate.status, [...OPEN_STATUSES]),
      isNotNull(schema.estimate.expiresOn),
      lt(schema.estimate.expiresOn, today),
    ))
    .returning({
      id: schema.estimate.id, number: schema.estimate.number, expiresOn: schema.estimate.expiresOn,
    });

  for (const row of changed) {
    await audit(tx, ctx, "estimate.expired", "estimate", row.id,
      { status: "open" }, { status: "expired", expiresOn: row.expiresOn, on: today });
  }
  return changed.map((row) => ({ id: row.id, number: row.number, expiresOn: row.expiresOn! }));
}

/** When this process last went round, so the worker's few second loop does not ask a date question every few seconds. */
let lastPass: number | null = null;

export interface ExpiryPassResult { organizationId: string; expired: ExpiredEstimate[]; failed: string | null }

/**
 * The worker's pass over every company holding an open estimate with a date.
 * One company's failure is recorded and the pass goes on, as the task pass does.
 */
export async function expiryPass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
): Promise<ExpiryPassResult[]> {
  /**
   * Once a minute at most, per process. A date that changes meaning at the
   * company's midnight gains nothing from being looked at every few seconds,
   * and the screens read the date themselves in the meantime.
   */
  const at = (options.now ?? new Date()).getTime();
  if (!options.force && lastPass !== null && at - lastPass < 60_000 && at >= lastPass) return [];
  lastPass = at;
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.estimate_expiry_organizations(${options.limit ?? 200}, ${new Date(at).toISOString().slice(0, 10)}::date)`,
  );
  const results: ExpiryPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    try {
      results.push({
        organizationId: row.organization_id,
        expired: await expireFor(db, row.organization_id, options.now),
        failed: null,
      });
    } catch (error) {
      results.push({ organizationId: row.organization_id, expired: [], failed: (error as Error).message });
    }
  }
  return results;
}
