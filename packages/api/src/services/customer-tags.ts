import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { tags as tagRules } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { customerScopeFilter } from "./scope";
import { remember, replayed } from "./once";

/**
 * TAGS, AS SOMETHING THE COMPANY CAN USE
 *
 * `customer.tags` was written by the create and update calls and read back by
 * them, and nothing else touched it: no list of the tags in use, no filter,
 * no way to fix "vip" and "VIP" being two tags, and an audience rule in
 * campaigns that matched them exactly as typed. A segmentation nobody can
 * query is a free text field with extra steps.
 *
 * Every read here is of `customer_tag`, the tags one per row under an index
 * on the case blind key, which the database keeps equal to each live
 * customer's own list. Every write is to the list, and the table follows.
 *
 * What this adds, all through `core/tags` so the arithmetic is the same
 * everywhere:
 *
 *   The company's tags with how many customers carry each, for the screen
 *   and for a picker that offers the spelling already in use.
 *   Adding and removing tags on one customer, from their page.
 *   Renaming a tag, and merging several into one, across the whole book in
 *   one statement rather than a request per customer.
 *
 * A NEW TAG TAKES THE COMPANY'S SPELLING. Somebody typing "vip" on a customer
 * when the book already says "VIP" gets "VIP", because the campaign rule and
 * the list filter would otherwise have to guess, and the cheapest place to
 * stop five spellings of one tag is the moment the second one is typed.
 */

export interface TagCount {
  tag: string;
  customers: number;
}

/**
 * Every tag in use, with how many live customers carry it.
 *
 * Under the caller's scope, like the customer list: a technician who sees the
 * customers they were sent to sees the tags on those, and a count over the
 * whole book would be a way to learn its size.
 */
export async function list(ctx: ServiceContext): Promise<TagCount[]> {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const scope = customerScopeFilter(scopeOf(ctx, "customer"), ctx.actor);
    /**
     * From `customer_tag`, which holds live customers only, so the whole
     * book's counts are a walk of the key index and touch no customer row.
     * A reader with a narrower scope joins the customers, because the scope
     * is a condition on them.
     *
     * The spelling shown is the one most of those customers carry, ties
     * broken by a fixed byte order. It was `min(tag)`, whose answer depends
     * on the database's collation: "VIP" before "vip" under C, the other way
     * under en_US, so the same data showed a different tag on a different
     * server.
     */
    const rows = await tx.execute<{ tag: string; customers: number }>(sql`
      select mode() within group (order by btrim(ct.tag) collate "C") as tag,
             count(distinct ct.customer_id)::int as customers
      from public.customer_tag ct
      ${scope ? sql`join public.customer on ${schema.customer.id} = ct.customer_id and ${scope}` : sql``}
      group by ct.tag_key
      order by count(distinct ct.customer_id) desc, ct.tag_key`);
    return [...rows].map((row) => ({ tag: row.tag.trim(), customers: Number(row.customers) }));
  });
}

/**
 * The spelling the company already uses for each of these, where it has one.
 *
 * Read inside the write, so two people adding "vip" and "Vip" at the same
 * moment may still leave two spellings; the rename on the tag screen is the
 * repair, and the next tag typed converges on whichever came first.
 */
async function companySpellings(tx: Database, wanted: string[]): Promise<Map<string, string>> {
  if (wanted.length === 0) return new Map();
  const keys = wanted.map(tagRules.tagKey);
  const rows = await tx.execute<{ key: string; tag: string }>(sql`
    select distinct on (ct.tag_key) ct.tag_key as key, btrim(ct.tag) as tag
    from public.customer_tag ct
    join public.customer c on c.id = ct.customer_id
    where ct.tag_key = any(${sql.param(keys)}::text[])
    order by ct.tag_key, c.created_at, ct.position`);
  return new Map([...rows].map((row) => [row.key, row.tag]));
}

/** Clean each tag or refuse the lot in words, naming the one that is wrong. */
function cleaned(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of raw) {
    const verdict = tagRules.normalizeTag(value);
    if (!verdict.ok) throw new ConflictError(verdict.message);
    out.push(verdict.tag);
  }
  return out;
}

/**
 * Put tags on one customer, take tags off, or both.
 *
 * Naturally idempotent, so a retry is harmless without a key: adding a tag a
 * customer has is nothing, and taking off one they do not have is nothing.
 */
export async function setOnCustomer(
  ctx: ServiceContext,
  input: { customerId: string; add?: string[] | undefined; remove?: string[] | undefined },
): Promise<{ id: string; tags: string[] }> {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const [before] = await tx.select({ id: schema.customer.id, tags: schema.customer.tags })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, input.customerId), isNull(schema.customer.deletedAt)))
      .limit(1);
    if (!before) throw new NotFoundError("Customer");

    const adding = cleaned(input.add ?? []);
    const removing = cleaned(input.remove ?? []);
    if (adding.length === 0 && removing.length === 0) {
      throw new ConflictError("Say which tag to add or take off.");
    }

    const spelling = await companySpellings(tx, adding);
    const asTheCompanyWritesIt = adding.map((tag) => spelling.get(tagRules.tagKey(tag)) ?? tag);
    const after = tagRules.removeTags(tagRules.addTags(before.tags, asTheCompanyWritesIt), removing);

    if (after.length > tagRules.MAX_TAGS_PER_CUSTOMER) {
      throw new ConflictError(
        `A customer can carry ${tagRules.MAX_TAGS_PER_CUSTOMER} tags. This would be ${after.length}, `
        + "which is usually an import that put a notes field in the wrong column.",
      );
    }

    const unchanged = after.length === before.tags.length
      && after.every((tag, i) => tag === before.tags[i]);
    if (!unchanged) {
      await tx.update(schema.customer)
        .set({ tags: after, updatedAt: new Date() })
        .where(eq(schema.customer.id, input.customerId));
      await audit(tx, ctx, "customer.tags_changed", "customer", input.customerId,
        { tags: before.tags }, { tags: after });
    }
    return { id: input.customerId, tags: after };
  });
}

export interface TagRewrite {
  /** The tag every customer now carries in place of the old ones. */
  tag: string;
  /** How many customers were changed. */
  customers: number;
}

/**
 * Every customer carrying any of `from` carries `into` instead.
 *
 * ONE STATEMENT for the write, with the arithmetic done by `core/tags` on the
 * rows the statement reads, rather than a request per customer from a
 * screen. A rename across four thousand customers that stopped at the eight
 * hundredth would leave the book with both tags and no record of which
 * customers were done.
 */
async function rewrite(
  tx: Database, ctx: ServiceContext, from: string[], into: string, action: string,
): Promise<TagRewrite> {
  const keys = from.map(tagRules.tagKey);
  const carrying = await tx.execute<{ id: string; tags: string[] }>(sql`
    select c.id, c.tags from public.customer c
    where c.id in (
      select ct.customer_id from public.customer_tag ct where ct.tag_key = any(${sql.param(keys)}::text[])
    )`);
  const changes = [...carrying]
    .map((row) => ({ id: row.id, before: row.tags, after: tagRules.replaceTags(row.tags, from, into) }))
    .filter((row) => JSON.stringify(row.before) !== JSON.stringify(row.after));

  if (changes.length > 0) {
    await tx.execute(sql`
      update public.customer c
      set tags = v.tags::jsonb, updated_at = now()
      from unnest(
        ${sql.param(changes.map((c) => c.id))}::uuid[],
        ${sql.param(changes.map((c) => JSON.stringify(c.after)))}::text[]
      ) as v(id, tags)
      where c.id = v.id`);
  }

  /**
   * ONE audit line for the operation rather than one per customer, with the
   * ids it touched. Four thousand rows saying "tags changed" is a log nobody
   * can read; one saying "merged vip and V.I.P. into VIP on these 4,000" is
   * the answer to the question somebody will actually ask.
   */
  await audit(tx, ctx, action, "customer_tag", ctx.actor.organizationId,
    { tags: from }, { tag: into, customers: changes.map((c) => c.id) });

  return { tag: into, customers: changes.length };
}

/**
 * Change what a tag is called.
 *
 * Refused when the new name is ALREADY a different tag, rather than quietly
 * merging the two: "rename Gold to VIP" when VIP already has three hundred
 * customers is a decision that the two segments are one, and that is the
 * merge, which says so. Changing only the case of a tag is a rename.
 */
export async function rename(
  ctx: ServiceContext, input: { from: string; to: string },
): Promise<TagRewrite> {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const seen = await replayed<TagRewrite>(tx, ctx, "customer_tag_rename");
    if (seen) return seen;

    const [from, to] = cleaned([input.from, input.to]) as [string, string];
    const inUse = await list({ ...ctx, db: tx });
    if (!inUse.some((t) => tagRules.tagKey(t.tag) === tagRules.tagKey(from))) {
      throw new NotFoundError(`Tag "${from}"`);
    }
    if (tagRules.tagKey(from) !== tagRules.tagKey(to)
        && inUse.some((t) => tagRules.tagKey(t.tag) === tagRules.tagKey(to))) {
      throw new ConflictError(
        `"${to}" is already a tag. Renaming "${from}" to it would join the two, so merge them instead, `
        + "which says that is what is happening.",
      );
    }
    const done = await rewrite(tx, ctx, [from], to, "customer.tag_renamed");
    await remember(tx, ctx, "customer_tag_rename", null, done);
    return done;
  });
}

/** Fold several tags into one, which may or may not exist yet. */
export async function merge(
  ctx: ServiceContext, input: { from: string[]; into: string },
): Promise<TagRewrite> {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const seen = await replayed<TagRewrite>(tx, ctx, "customer_tag_merge");
    if (seen) return seen;

    const from = tagRules.uniqueTags(cleaned(input.from));
    const [into] = cleaned([input.into]) as [string];
    const others = from.filter((tag) => tagRules.tagKey(tag) !== tagRules.tagKey(into));
    if (others.length === 0) {
      throw new ConflictError("Choose at least one other tag to fold into this one.");
    }
    /**
     * The spelling typed here wins, including over the company's own: a merge
     * is the moment somebody decides how the tag is written, and folding
     * "vip" and "V.I.P." into "VIP" has to leave "VIP" everywhere, the
     * customers who already had it in another case included.
     */
    const done = await rewrite(tx, ctx, [...from, into], into, "customer.tags_merged");
    await remember(tx, ctx, "customer_tag_merge", null, done);
    return done;
  });
}

export const handlers = {
  listCustomerTags: async (ctx: ServiceContext) => ({ tags: await list(ctx) }),
  setCustomerTags: (
    ctx: ServiceContext,
    input: { id: string; add?: string[] | undefined; remove?: string[] | undefined },
  ) => setOnCustomer(ctx, { customerId: input.id, add: input.add, remove: input.remove }),
  renameCustomerTag: (ctx: ServiceContext, input: { from: string; to: string }) => rename(ctx, input),
  mergeCustomerTags: (ctx: ServiceContext, input: { from: string[]; into: string }) => merge(ctx, input),
} as const;
