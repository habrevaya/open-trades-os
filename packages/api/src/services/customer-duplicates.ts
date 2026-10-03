import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { tags as tagRules } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, decodeCursor, encodeCursor, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { DUPLICATE_REASONS, NAME_SIMILARITY } from "./customer-lifecycle";

/**
 * LIKELY DUPLICATES ACROSS THE WHOLE BOOK
 *
 * The per record matcher answers for the customer in front of you, which
 * finds a duplicate only when somebody happens to open one half of it. A
 * company that imported three spreadsheets and took leads through two forms
 * has dozens, and the first sign is a customer billed twice. This is the
 * same matcher run over every pair at once: the same three signals, the same
 * reasons in the same words, the same similarity threshold, so a pair this
 * lists is a pair that customer's own page lists, and the other way round.
 *
 * ONE QUERY, NOT ONE PER CUSTOMER. Asking the per record matcher for each of
 * four thousand customers is four thousand statements and every pair found
 * twice. The phone and email signals are equality joins, and the name signal
 * is pg_trgm's `%` against the trigram index on `customer.name`, with the
 * threshold set on the transaction to the matcher's own number, so each
 * customer probes the index rather than every other row.
 *
 * PAGED BY POSITION, NOT OFFSET. The order is strongest reason first, then
 * name, and the cursor is the last pair's place in that order, so merging
 * pairs off the first page while somebody works does not skip the ones that
 * slide up into it.
 *
 * "NOT A DUPLICATE" IS REMEMBERED. A landlord and the tenant whose bills she
 * pays share a number and are two people. Without a memory of that the pair
 * is back every morning, and a list that is mostly pairs already decided is
 * one people stop reading.
 */

export interface SweepSide {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

export interface DuplicatePair {
  a: SweepSide;
  b: SweepSide;
  /** Why, in the words the per record matcher uses. */
  because: (typeof DUPLICATE_REASONS)[number];
}

type Cursor = [number, string, string, string];

/**
 * The pairs, strongest reason first.
 *
 * `customer:merge`, not `customer:read`. This is a read across the entire
 * book, which a reader whose scope is the customers they were sent to must
 * not get, and the list exists to be acted on by somebody who can merge.
 */
export async function sweep(
  ctx: ServiceContext, input: { limit?: number | undefined; cursor?: string | undefined } = {},
): Promise<{ data: DuplicatePair[]; hasMore: boolean; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let after: Cursor | null = null;
  try {
    const decoded = decodeCursor(input.cursor);
    after = decoded ? JSON.parse(decoded) as Cursor : null;
  } catch {
    after = null;
  }

  return guardedRead(ctx, "customer:merge", async (tx) => {
    /**
     * `%` reads its threshold from this setting. Set to the per record
     * matcher's number, local to the transaction, so the index answers the
     * same question the matcher's `similarity(...) >= 0.45` does, and the
     * explicit comparison below stays as the definition.
     */
    await tx.execute(sql`select set_config('pg_trgm.similarity_threshold', ${String(NAME_SIMILARITY)}, true)`);

    const position = after
      ? sql`and (p.strength, lower(a.name), a.id::text, b.id::text)
              > (${after[0]}::int, ${after[1]}::text, ${after[2]}::text, ${after[3]}::text)`
      : sql``;

    const rows = await tx.execute<{
      strength: number;
      a_id: string; a_name: string; a_phone: string | null; a_email: string | null;
      b_id: string; b_name: string; b_phone: string | null; b_email: string | null;
    }>(sql`
      with matched as (
        select a.id as a_id, b.id as b_id, 0 as strength
        from public.customer a
        join public.customer b on b.phone = a.phone and a.id < b.id
        where a.deleted_at is null and b.deleted_at is null and a.phone is not null
        union all
        select a.id, b.id, 1
        from public.customer a
        join public.customer b on lower(b.email) = lower(a.email) and a.id < b.id
        where a.deleted_at is null and b.deleted_at is null and a.email is not null
        union all
        select a.id, b.id, 2
        from public.customer a
        join public.customer b on a.name % b.name and a.id < b.id
        where a.deleted_at is null and b.deleted_at is null
          and similarity(a.name, b.name) >= ${NAME_SIMILARITY}::real
      ),
      pairs as (
        select a_id, b_id, min(strength) as strength from matched group by a_id, b_id
      )
      select p.strength,
        a.id as a_id, a.name as a_name, a.phone as a_phone, a.email as a_email,
        b.id as b_id, b.name as b_name, b.phone as b_phone, b.email as b_email
      from pairs p
      join public.customer a on a.id = p.a_id
      join public.customer b on b.id = p.b_id
      where not exists (
        select 1 from public.customer_not_duplicate d
        where d.customer_a_id = p.a_id and d.customer_b_id = p.b_id
      )
      ${position}
      order by p.strength, lower(a.name), a.id::text, b.id::text
      limit ${limit + 1}`);

    const list = [...rows];
    const hasMore = list.length > limit;
    const page = hasMore ? list.slice(0, limit) : list;
    const last = page[page.length - 1];

    return {
      data: page.map((row) => ({
        a: { id: row.a_id, name: row.a_name, phone: row.a_phone, email: row.a_email },
        b: { id: row.b_id, name: row.b_name, phone: row.b_phone, email: row.b_email },
        because: DUPLICATE_REASONS[Number(row.strength)] ?? "Similar name",
      })),
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor(JSON.stringify([Number(last.strength), last.a_name.toLowerCase(), last.a_id, last.b_id]))
        : null,
    };
  });
}

/**
 * Two records somebody looked at and said are two people.
 *
 * Stored once whichever way round it was said, and a second press is
 * nothing: the unique index on the ordered pair takes it, which is also why
 * the route needs no idempotency key to be safe to retry.
 */
export async function dismiss(
  ctx: ServiceContext, input: { customerId: string; otherId: string; reason?: string | undefined },
): Promise<{ customerAId: string; customerBId: string; dismissed: true }> {
  return guardedWrite(ctx, "customer:merge", async (tx) => {
    if (input.customerId === input.otherId) {
      throw new ConflictError("That is one record, not two.");
    }
    const found = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(
        inArray(schema.customer.id, [input.customerId, input.otherId]),
        isNull(schema.customer.deletedAt),
      ));
    if (found.length !== 2) throw new NotFoundError("Customer");

    const [a, b] = tagRules.orderedPair(input.customerId, input.otherId);
    const inserted = await tx.insert(schema.customerNotDuplicate).values({
      organizationId: ctx.actor.organizationId,
      customerAId: a,
      customerBId: b,
      reason: input.reason?.trim() || null,
      decidedByUserId: ctx.actor.userId,
    }).onConflictDoNothing().returning({ id: schema.customerNotDuplicate.id });

    if (inserted[0]) {
      await audit(tx, ctx, "customer.not_duplicate", "customer", a, null,
        { otherId: b, reason: input.reason?.trim() || null });
    }
    return { customerAId: a, customerBId: b, dismissed: true as const };
  });
}

/** How many pairs have been set aside, so the screen can say the list is shorter on purpose. */
export async function dismissedCount(ctx: ServiceContext): Promise<number> {
  return guardedRead(ctx, "customer:merge", async (tx) => {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` })
      .from(schema.customerNotDuplicate)
      .where(eq(schema.customerNotDuplicate.organizationId, ctx.actor.organizationId));
    return Number(row?.n ?? 0);
  });
}

export const handlers = {
  listCustomerDuplicatePairs: (
    ctx: ServiceContext, input: { limit?: number | undefined; cursor?: string | undefined },
  ) => sweep(ctx, input),
  dismissCustomerDuplicate: (
    ctx: ServiceContext, input: { customerId: string; otherId: string; reason?: string | undefined },
  ) => dismiss(ctx, input),
} as const;
