import { and, eq, isNull, desc } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, history, time } from "@opentradesos/core";
import {
  type ServiceContext, ConflictError, UnprocessableError, timezoneOf,
} from "./context";

/**
 * WHO MAY SAY SOMETHING HAPPENED ON ANOTHER DAY
 *
 * The rules are in packages/core/src/history, where they can be tested
 * without a database. This file applies them to a request: it reads the
 * company's calendar, refuses the future, and asks for `data:import` before
 * accepting anything older than the late entry window.
 *
 * Every service that takes a business date goes through here, so the answer
 * to "can a bookkeeper date a payment to last March" is the same on every
 * route, and is one place to read.
 */

export interface AdmittedDate {
  /** Older than the late entry window. The caller held `data:import`. */
  historical: boolean;
  /** The company's zone, already read, for the caller's own arithmetic. */
  timeZone: string;
}

/**
 * A business date, as a `YYYY-MM-DD` in the company's calendar.
 *
 * `field` is the request field it came from, so a refusal names it the way
 * the dispatcher's own 422 does.
 */
export async function admitDate(
  tx: Database, ctx: ServiceContext, date: string, field: string,
): Promise<AdmittedDate> {
  const timeZone = await timezoneOf(tx, ctx.actor.organizationId);
  const today = time.dateIn(new Date(), timeZone);
  return admit(ctx, history.classifyDate(date, today), timeZone, field, date);
}

/** The same rules for an instant, read in the company's zone. */
export async function admitInstant(
  tx: Database, ctx: ServiceContext, at: Date, field: string,
): Promise<AdmittedDate> {
  const timeZone = await timezoneOf(tx, ctx.actor.organizationId);
  const kind = history.classifyInstant(at, new Date(), timeZone);
  return admit(ctx, kind, timeZone, field, at.toISOString());
}

function admit(
  ctx: ServiceContext, kind: history.DateClass, timeZone: string, field: string, shown: string,
): AdmittedDate {
  if (kind === "future") {
    throw new UnprocessableError(`${field} is in the future`, [{
      path: field,
      message: `${shown} has not happened yet. Record it when it does.`,
    }]);
  }
  if (kind === "historical") {
    /**
     * A PermissionError, so the answer is a 403 naming the permission. The
     * caller is not wrong about the shape of the request; they are asking
     * for something they have not been trusted with.
     */
    assertCan(ctx.actor, "data:import");
    return { historical: true, timeZone };
  }
  return { historical: false, timeZone };
}

/**
 * Taking a power that only history needs: choosing a document's number,
 * stating tax another system charged.
 */
export function requireImport(ctx: ServiceContext): void {
  assertCan(ctx.actor, "data:import");
}

/**
 * The last day the books are closed through, or null.
 *
 * Read directly rather than through the accounting service, which imports
 * the ledger writer and would make the two import each other. It is the same
 * query: the latest close that has not been reopened.
 */
export async function closedThrough(tx: Database, organizationId: string): Promise<string | null> {
  const [row] = await tx.select({ periodEnd: schema.accountingPeriod.periodEnd })
    .from(schema.accountingPeriod)
    .where(and(
      eq(schema.accountingPeriod.organizationId, organizationId),
      isNull(schema.accountingPeriod.reopenedAt),
    ))
    .orderBy(desc(schema.accountingPeriod.periodEnd))
    .limit(1);
  return row?.periodEnd ?? null;
}

/**
 * NOTHING POSTS INTO A CLOSED PERIOD.
 *
 * Closing a period used to stop only the accounting sync, so a quarter that
 * had been filed could still have an invoice issued into it here, and the
 * ledger this product reports from would disagree with the return. Now the
 * posting itself is refused, whoever asks and whatever permission they hold,
 * because a filed quarter is a fact about the books and not about the caller.
 *
 * A correction to something in a closed period is still possible, and is
 * what an accountant would do anyway: it is dated today, in the open period,
 * and says what it corrects.
 */
export async function assertPeriodOpen(
  tx: Database, organizationId: string, occurredAt: Date,
): Promise<void> {
  const closed = await closedThrough(tx, organizationId);
  if (closed === null) return;
  const timeZone = await timezoneOf(tx, organizationId);
  const date = time.dateIn(occurredAt, timeZone);
  if (history.isClosed(date, closed)) {
    throw new ConflictError(
      `The books are closed through ${closed}, so nothing can be posted on ${date}. `
      + "Reopen the period if it really has to change, or record the correction today.",
    );
  }
}
