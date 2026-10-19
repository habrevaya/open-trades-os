import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customerMerge, tags as tagRules, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";

/**
 * REMOVING A CUSTOMER, AND JOINING TWO THAT ARE THE SAME PERSON
 *
 * `customer:delete` and `customer:merge` were both in the permission
 * catalogue from the first commit, both granted to the office manager
 * preset, and neither was ever asserted by anything. A permission on a
 * role's list that nothing checks is worse than an absent one: the owner
 * reading that list believes they have granted a capability, and the person
 * holding the role finds there is no button.
 *
 * What happens without them is not that nothing happens. A company that
 * mis-keys a customer, or takes two leads from the same person through two
 * forms, edits one of the rows into something else. That is how a CRM ends
 * up with a customer called "DO NOT USE" and another called "Smith (real
 * one)", and both of those carry history that is now attached to a lie.
 *
 * DELETING IS REFUSED WHEN ANYTHING FINANCIAL POINTS AT THEM, and the
 * refusal names what. An invoice, a payment, a deposit or a ledger entry is
 * a record of money, and a customer row is what makes it explicable six
 * years later when somebody asks what that receipt was. Those are the cases
 * where merge is the right answer and delete never is.
 *
 * MERGING MOVES EVERYTHING AND KEEPS THE LOSER. The duplicate is soft
 * deleted rather than removed, with a pointer to the survivor, because a
 * link somebody emailed, an integration holding the old id, and an audit
 * entry naming it all have to keep resolving. A merge that deleted the row
 * turns every one of those into a dead end.
 */

/**
 * Everything that points at a customer, grouped by whether it is money.
 *
 * Listed explicitly rather than discovered from the catalogue, because a new
 * table pointing at `customer` should have to come here and say which side
 * it falls on. A merge that silently missed a table would leave history
 * split across two rows, which is the exact thing it exists to end. The
 * guard in `test/customer-merge-coverage.integration.test.ts` reads every
 * foreign key to `customer` from the database and fails on one that is in
 * none of these lists, so a new table cannot be forgotten quietly.
 */
type Ref = {
  table: string;
  column: string;
  label: string;
  /**
   * Narrows a table whose column names more kinds of record than a customer
   * (a file or a task is about whatever its `entity_type` says). Written
   * against the row as `t`.
   */
  only?: SQL | undefined;
  /**
   * THE DUPLICATE'S ROWS THAT STAY WITH IT, given the kept record's id and
   * written against the row as `t`: the ones the kept record may hold only
   * one of and already does (a statement for the same month, a piece in the
   * same mailing). Moving them would be refused by the database, or worse,
   * make two of something there must be one of. `why` says so in words, on
   * the merge's answer and on the kept record's page.
   */
  unless?: ((keepId: string) => SQL) | undefined;
  why?: string | undefined;
};

const MONEY: Ref[] = [
  { table: "invoice", column: "customer_id", label: "invoices" },
  { table: "invoice", column: "payer_customer_id", label: "invoices they pay for" },
  { table: "payment", column: "customer_id", label: "payments" },
  { table: "deposit", column: "customer_id", label: "deposits" },
  { table: "ledger_entry", column: "customer_id", label: "ledger entries" },
  { table: "agreement", column: "customer_id", label: "agreements" },
  { table: "service_contract", column: "customer_id", label: "contracts" },
  /**
   * Money owed to them or by them that is not an invoice. Each stops a
   * removal for the reason an invoice does: a credit sitting on an account,
   * a refund paid out or a claim against a warranty company has to stay
   * explicable after the customer row is gone from every list.
   */
  { table: "credit_note", column: "customer_id", label: "credit notes" },
  { table: "credit_note_payout", column: "customer_id", label: "credit payouts" },
  { table: "card_on_file_charge", column: "customer_id", label: "card charges" },
  { table: "financing_application", column: "customer_id", label: "financing applications" },
  { table: "coverage_claim", column: "payer_customer_id", label: "coverage claims they pay" },
  {
    table: "referral_reward", column: "referrer_customer_id", label: "referral rewards",
    /** A reward for referring the kept record itself is a person referring themselves twice over. */
    unless: (keepId) => sql`t.referred_customer_id = ${keepId}`,
    why: "It was for referring the record kept, which is the same person.",
  },
  {
    table: "referral_reward", column: "referred_customer_id", label: "referral rewards for them",
    unless: (keepId) => sql`exists (select 1 from public.referral_reward x
      where x.organization_id = t.organization_id and x.referred_customer_id = ${keepId})`,
    why: "The record kept already earned whoever referred it a reward, and one person earns one.",
  },
];

/**
 * THE LEDGER DOES NOT MOVE, and the database said so before this code did.
 *
 * `ledger_entry` has a trigger refusing UPDATE, because it is append only
 * and a correction is a reversing entry rather than an edit. The first
 * version of this merge tried to re-parent those rows and was stopped by it.
 *
 * The trigger is right. A posting recorded against the duplicate WAS made
 * against the duplicate on the day it was made, and rewriting it would
 * change what the books say happened. The pointer left on the merged record
 * is what makes those entries resolve to the surviving customer, which is a
 * different thing from pretending they were always theirs.
 *
 * So the ledger blocks a delete and is skipped by a merge: it is the reason
 * that customer cannot simply vanish, and it is not ours to rewrite.
 */
const MOVES: Ref[] = MONEY.filter((ref) => ref.table !== "ledger_entry");

const HISTORY: Ref[] = [
  { table: "job", column: "customer_id", label: "jobs" },
  { table: "job_party", column: "customer_id", label: "job parties" },
  { table: "estimate", column: "customer_id", label: "estimates" },
  { table: "project", column: "customer_id", label: "projects" },
  { table: "customer_property", column: "customer_id", label: "property links" },
  { table: "contact", column: "customer_id", label: "contacts" },
  { table: "customer_note", column: "customer_id", label: "notes" },
  { table: "conversation", column: "customer_id", label: "conversations" },
  { table: "call", column: "customer_id", label: "calls" },
  { table: "communication_consent", column: "customer_id", label: "consent records" },
  {
    /** Run after a no to advertising has superseded a yes on the record kept (`merge`). */
    table: "advertising_consent", column: "customer_id", label: "advertising answers",
    unless: (keepId) => sql`t.superseded_at is null and exists (select 1 from public.advertising_consent x
      where x.customer_id = ${keepId} and x.superseded_at is null)`,
    why: "The record kept already has its own answer about advertising, and gave the same one or said no.",
  },
  { table: "booking_request", column: "customer_id", label: "booking requests" },
  { table: "recurring_schedule", column: "customer_id", label: "recurring work" },
  { table: "visit_change_request", column: "customer_id", label: "visit change requests" },
  { table: "review", column: "customer_id", label: "reviews" },
  { table: "review_request", column: "customer_id", label: "review requests" },
  { table: "marketing_touch", column: "customer_id", label: "marketing touches" },
  { table: "campaign_recipient", column: "customer_id", label: "campaign sends" },
  {
    table: "mail_piece", column: "customer_id", label: "mail pieces",
    unless: (keepId) => sql`exists (select 1 from public.mail_piece x
      where x.mail_campaign_id = t.mail_campaign_id and x.customer_id = ${keepId})`,
    why: "The record kept was sent a piece in the same mailing.",
  },
  { table: "ad_conversion_send", column: "customer_id", label: "ad conversions sent" },
  { table: "form_submission", column: "customer_id", label: "form submissions" },
  { table: "lead_offer", column: "customer_id", label: "lead offers" },
  { table: "portal_grant", column: "customer_id", label: "portal links" },
  { table: "portal_event", column: "customer_id", label: "portal events" },
  { table: "portal_sign_in", column: "customer_id", label: "portal sign ins" },
  {
    table: "statement_delivery", column: "customer_id", label: "statements sent",
    unless: (keepId) => sql`t.period is not null and exists (select 1 from public.statement_delivery x
      where x.organization_id = t.organization_id and x.customer_id = ${keepId} and x.period = t.period)`,
    why: "The record kept was sent its own statement for the same month.",
  },
  /**
   * SAVED CARDS: THE PROCESSOR'S REFERENCE MOVES, AND NOTHING ELSE EXISTS TO.
   *
   * The card itself is at the processor, filed under the processor's own
   * customer (`payment_profile`), and this product holds the references and
   * the four digits a person recognises it by. A charge names the card and
   * reaches the processor's customer through the card's own `profile_id`, so
   * a card moved to the record kept still charges where it was saved, whether
   * or not its processor record moved too.
   *
   * The processor record moves when the record kept has none at that
   * processor account, and stays otherwise: a customer has one there per
   * account, and the kept record's own is the one its next saved card uses.
   */
  {
    table: "payment_profile", column: "customer_id", label: "card processor records",
    unless: (keepId) => sql`exists (select 1 from public.payment_profile x
      where x.organization_id = t.organization_id and x.connection_id = t.connection_id and x.customer_id = ${keepId})`,
    why: "The record kept has its own record at the card processor. The duplicate's cards still moved, and charge through the duplicate's.",
  },
  /**
   * A card that pays the duplicate's bills automatically stays with the
   * duplicate, with its agreements, when the record kept already pays
   * automatically with a card of its own: one card pays each customer's bills
   * automatically, or every bill would be charged twice, and which of the two
   * the customer meant is theirs to say. They can save it again on the
   * record kept. Nothing can charge it from the duplicate, which has no bills.
   */
  {
    table: "saved_payment_method", column: "customer_id", label: "saved cards",
    unless: (keepId) => sql`exists (select 1 from public.payment_agreement a
        where a.saved_payment_method_id = t.id and a.withdrawn_at is null and a.autopay_at is not null)
      and exists (select 1 from public.payment_agreement k
        where k.organization_id = t.organization_id and k.customer_id = ${keepId}
          and k.withdrawn_at is null and k.autopay_at is not null)`,
    why: "The record kept already pays its bills automatically with a card of its own, so the duplicate's automatic card stayed with it. The customer can save it again.",
  },
  /** After the cards: an agreement goes where its card went, and nowhere else. */
  {
    table: "payment_agreement", column: "customer_id", label: "card payment agreements",
    unless: (keepId) => sql`not exists (select 1 from public.saved_payment_method s
      where s.id = t.saved_payment_method_id and s.customer_id = ${keepId})`,
    why: "Its card stayed with the duplicate.",
  },
  { table: "delivery", column: "customer_id", label: "deliveries" },
  { table: "deficiency", column: "customer_id", label: "deficiencies" },
  { table: "inspection", column: "customer_id", label: "inspections" },
  { table: "service_report", column: "customer_id", label: "service reports" },
  { table: "custom_object_record", column: "customer_id", label: "custom records" },
  { table: "container_hold", column: "customer_id", label: "container holds" },
  /** A file filed on the customer, which names it by kind and id rather than by a foreign key. */
  { table: "attachment", column: "entity_id", label: "files", only: sql`t.entity_type = 'customer'` },
  {
    table: "task", column: "entity_id", label: "tasks", only: sql`t.entity_type = 'customer'`,
    unless: (keepId) => sql`t.raised_by_run_id is not null and exists (select 1 from public.task x
      where x.organization_id = t.organization_id and x.raised_by_run_id = t.raised_by_run_id
        and x.entity_type = 'customer' and x.entity_id = ${keepId})`,
    why: "The same automation raised its own task about the record kept.",
  },
];

/**
 * Other records that name the duplicate as somebody, rather than belonging to
 * it: who referred a customer, who a review was matched to, who uploaded a
 * file. They follow the person to the record kept, but they are not the
 * duplicate's to lose, so a removal does not count them as going with it.
 */
const REFERENCES: Ref[] = [
  {
    table: "customer", column: "referred_by_customer_id", label: "customers they referred",
    unless: (keepId) => sql`t.id = ${keepId}`,
    why: "That is the record kept, which cannot have referred itself.",
  },
  { table: "marketing_touch", column: "referrer_customer_id", label: "referrals they made" },
  { table: "review", column: "suggested_customer_id", label: "reviews matched to them" },
  { table: "attachment", column: "uploaded_by_customer_id", label: "files they uploaded" },
];

/**
 * What names a customer and is deliberately left where it is by a merge, each
 * with why. Named so the coverage guard can tell a decision from an omission.
 */
export const MERGE_LEAVES: { table: string; column: string; why: string }[] = [
  { table: "ledger_entry", column: "customer_id", why: "Append only: a posting made against the duplicate was made against it." },
  { table: "customer_merge", column: "kept_customer_id", why: "The merge's own record." },
  { table: "customer_merge", column: "merged_customer_id", why: "The merge's own record." },
  { table: "customer_not_duplicate", column: "customer_a_id", why: "A judgement about a pair, which says nothing about the record kept." },
  { table: "customer_not_duplicate", column: "customer_b_id", why: "A judgement about a pair, which says nothing about the record kept." },
  { table: "customer_tag", column: "customer_id", why: "Written only by the database, from the customer's own list, which the merge joins." },
];

/** Every customer column a merge moves, in the order it moves them. */
export const MERGE_MOVES: readonly { table: string; column: string }[] = [...MOVES, ...HISTORY, ...REFERENCES]
  .map(({ table, column }) => ({ table, column }));

async function countsFor(
  tx: Database, organizationId: string, customerId: string,
  refs: Ref[],
) {
  const found: { label: string; n: number }[] = [];
  for (const ref of refs) {
    const rows = await tx.execute(sql`
      select count(*)::int as n from ${sql.identifier(ref.table)} as t
      where t.${sql.identifier(ref.column)} = ${customerId}
        and t.organization_id = ${organizationId}
        ${ref.only ? sql`and ${ref.only}` : sql``}`);
    const n = Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
    if (n > 0) found.push({ label: ref.label, n });
  }
  return found;
}

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.customer)
    .where(and(
      eq(schema.customer.id, id),
      eq(schema.customer.organizationId, organizationId),
      isNull(schema.customer.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("Customer");
  return row;
}

/**
 * What would stop this customer being deleted, before anybody clicks.
 *
 * Offered as its own read because the answer decides which button a screen
 * should show. A delete that is refused after the click, with a list of
 * reasons, is a worse version of the same information.
 */
export async function deletability(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    await load(tx, ctx.actor.organizationId, input.id);
    const money = await countsFor(tx, ctx.actor.organizationId, input.id, MONEY);
    const history = await countsFor(tx, ctx.actor.organizationId, input.id, HISTORY);

    return {
      deletable: money.length === 0,
      /** Records of money, which make delete the wrong answer rather than a risky one. */
      blockedBy: money,
      /** Everything else, which would go with them. Shown so nobody is surprised. */
      wouldRemove: history,
    };
  });
}

/**
 * Take a customer off the books.
 *
 * Soft, and never when money points at them. A hard delete would cascade
 * through the foreign keys and take the invoices with it; a soft delete on a
 * customer with invoices leaves a receivable nobody can explain. Both are
 * worse than refusing, so this refuses and says merge instead.
 */
export async function remove(
  ctx: ServiceContext, input: { id: string; reason: string },
) {
  return guardedWrite(ctx, "customer:delete", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    const reason = input.reason.trim();
    if (reason === "") {
      throw new ConflictError(
        "Removing a customer needs a reason. It is the only thing left to read when somebody asks "
        + "why this record is gone.",
      );
    }

    const money = await countsFor(tx, ctx.actor.organizationId, input.id, MONEY);
    if (money.length > 0) {
      throw new ConflictError(
        `This customer has ${money.map((m) => `${m.n} ${m.label}`).join(", ")}. `
        + "Money that has moved has to stay explicable, so they cannot be removed. "
        + "If this is a duplicate, merge them into the real one instead.",
      );
    }

    const [after] = await tx.update(schema.customer)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.customer.id, input.id))
      .returning();

    await audit(tx, ctx, "customer.removed", "customer", input.id,
      before, { ...after!, reason });

    return { id: input.id, removed: true as const, reason };
  });
}

/**
 * Join two records that are the same person.
 *
 * EVERYTHING MOVES, including the money. That is the difference between this
 * and delete: a merge does not discard a history, it re-parents one, so the
 * invoices that were raised against the duplicate become invoices against
 * the survivor and the balance is right for the first time.
 *
 * The loser is soft deleted and points at the survivor, because an id that
 * stops resolving breaks a link somebody emailed, an integration that stored
 * it, and every audit row naming it.
 *
 * WHAT MOVED IS WRITTEN DOWN, row by row, in `customer_merge`: the id of every
 * row re-parented, the address links taken out as doubles (whole), the blank
 * fields filled and the tags added. That record is what lets `undoMerge` move
 * exactly those back, and nothing the survivor gained since.
 */
export async function merge(
  ctx: ServiceContext,
  input: { keepId: string; mergeId: string; reason?: string },
) {
  return guardedWrite(ctx, "customer:merge", async (tx) => {
    const seen = await replayed<MergeAnswer>(tx, ctx, "customer_merge");
    if (seen) return seen;
    if (input.keepId === input.mergeId) {
      throw new ConflictError("Those are the same record.");
    }
    /**
     * Both rows locked, in a fixed order, before anything is read: the order
     * an undo takes them in, so a merge and an undo touching one customer
     * queue rather than deadlock, and two merges of one duplicate into two
     * records cannot both move its history.
     */
    await tx.execute(sql`select id from public.customer
      where id in (${input.keepId}, ${input.mergeId}) and organization_id = ${ctx.actor.organizationId}
      order by id for update`);
    const keep = await load(tx, ctx.actor.organizationId, input.keepId);
    const loser = await load(tx, ctx.actor.organizationId, input.mergeId);

    /**
     * A NO TO ADVERTISING WINS. When the duplicate's live answer is no and
     * the kept record's is yes, the yes is superseded and the no comes
     * across as the live answer: one person said no to their details being
     * used for advertising, and joining their two records must not turn that
     * into a yes. The conservative reading; the superseded yes is written on
     * the merge's record, and an undo makes it live again.
     */
    const overruled = await tx.execute<{ id: string }>(sql`
      update public.advertising_consent k
      set superseded_at = now(), updated_at = now()
      where k.organization_id = ${ctx.actor.organizationId}
        and k.customer_id = ${input.keepId}
        and k.superseded_at is null
        and k.choice = 'granted'
        and exists (select 1 from public.advertising_consent d
          where d.organization_id = ${ctx.actor.organizationId} and d.customer_id = ${input.mergeId}
            and d.superseded_at is null and d.choice = 'refused')
      returning k.id`);
    const superseded = [...overruled].length > 0
      ? [{ table: "advertising_consent", ids: [...overruled].map((row) => String(row.id)) }]
      : [];

    const moved: { label: string; n: number }[] = [];
    const recorded: MovedRows[] = [];
    const stayed: StayedRows[] = [];
    for (const ref of [...MOVES, ...HISTORY, ...REFERENCES]) {
      const only = ref.only ? sql`and ${ref.only}` : sql``;
      const rows = await tx.execute<{ id: string }>(sql`
        update ${sql.identifier(ref.table)} as t
        set ${sql.identifier(ref.column)} = ${input.keepId}
        where t.${sql.identifier(ref.column)} = ${input.mergeId}
          and t.organization_id = ${ctx.actor.organizationId}
          ${only}
          ${ref.unless ? sql`and not (${ref.unless(input.keepId)})` : sql``}
        returning t.id`);
      const ids = [...rows].map((row) => String(row.id));
      if (ids.length > 0) {
        moved.push({ label: ref.label, n: ids.length });
        recorded.push({ table: ref.table, column: ref.column, label: ref.label, ids });
      }
      if (ref.unless) {
        const left = await tx.execute<{ id: string }>(sql`
          select t.id from ${sql.identifier(ref.table)} as t
          where t.${sql.identifier(ref.column)} = ${input.mergeId}
            and t.organization_id = ${ctx.actor.organizationId}
            ${only}`);
        const leftIds = [...left].map((row) => String(row.id));
        if (leftIds.length > 0) {
          stayed.push({ table: ref.table, column: ref.column, label: ref.label, ids: leftIds, why: ref.why ?? "" });
        }
      }
    }

    /**
     * A property linked to both now has the same link twice. Deduplicated
     * here rather than left, because every screen listing a customer's
     * addresses would show the address twice and neither row is wrong.
     *
     * Each link taken out is kept whole on the merge's record, with whose it
     * was before the merge, so an undo can put it back as it was.
     */
    const movedLinks = new Set(recorded.find((r) => r.table === "customer_property")?.ids ?? []);
    const removed = await tx.execute<{ id: string; row: Record<string, unknown> }>(sql`
      delete from customer_property a
      using customer_property b
      where a.organization_id = ${ctx.actor.organizationId}
        and a.customer_id = ${input.keepId}
        and b.customer_id = ${input.keepId}
        and a.property_id = b.property_id
        and a.role = b.role
        and a.id > b.id
      returning a.id, to_jsonb(a) as row`);
    const removedLinks = [...removed].map((r) => ({
      customerId: movedLinks.has(String(r.id)) ? input.mergeId : input.keepId,
      row: r.row,
    }));

    /**
     * Fields the survivor is missing are taken from the loser. Never the
     * other way: a merge is a decision about which record is right, and
     * overwriting the survivor's name with the duplicate's would undo it.
     */
    const filled: Record<string, string> = {};
    for (const field of ["email", "phone", "leadSource"] as const) {
      if (!keep[field] && loser[field]) filled[field] = loser[field]!;
    }

    /**
     * The duplicate's tags join the survivor's list, after its own, each
     * only when the survivor has no tag that compares equal. A merged record
     * is in no tag count, so a "VIP" on the duplicate would otherwise
     * vanish from every list the company keeps by tag.
     */
    const keys = new Set(keep.tags.map(tagRules.tagKey));
    const tagsAdded = tagRules.uniqueTags(loser.tags)
      .filter((tag) => !keys.has(tagRules.tagKey(tag)))
      .slice(0, Math.max(0, tagRules.MAX_TAGS_PER_CUSTOMER - keep.tags.length));

    const [after] = await tx.update(schema.customer)
      .set({
        ...filled,
        ...(tagsAdded.length > 0 ? { tags: [...keep.tags, ...tagsAdded] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.customer.id, input.keepId))
      .returning();

    await tx.update(schema.customer).set({
      deletedAt: new Date(),
      /**
       * The pointer home. `mergedIntoId` is why the loser is kept rather
       * than removed: an old link, a stored id and an audit row all still
       * resolve, and they resolve to an answer rather than to a 404.
       */
      mergedIntoId: input.keepId,
      updatedAt: new Date(),
    }).where(eq(schema.customer.id, input.mergeId));

    const [record] = await tx.insert(schema.customerMerge).values({
      organizationId: ctx.actor.organizationId,
      keptCustomerId: input.keepId,
      mergedCustomerId: input.mergeId,
      mergedByUserId: ctx.actor.userId,
      reason: input.reason?.trim() || null,
      moved: recorded,
      stayed,
      superseded,
      removedLinks,
      filled,
      tagsAdded,
    }).returning({ id: schema.customerMerge.id });

    await audit(tx, ctx, "customer.merged", "customer", input.keepId, loser, {
      keptId: input.keepId, mergedId: input.mergeId, mergeRecordId: record!.id,
      moved, filled, tagsAdded, reason: input.reason?.trim() || null,
      stayed: stayed.map(({ label, ids, why }) => ({ label, n: ids.length, why })),
      superseded,
    });

    const answer: MergeAnswer = {
      keptId: input.keepId,
      mergedId: input.mergeId,
      mergeRecordId: record!.id,
      name: after!.name,
      moved,
      stayed: stayed.map(({ label, ids, why }) => ({ label, n: ids.length, why })),
      /** Which blank fields on the survivor were filled from the duplicate. */
      filled: Object.keys(filled),
      tagsAdded,
    };
    await remember(tx, ctx, "customer_merge", record!.id, answer);
    return answer;
  });
}

type MovedRows = { table: string; column: string; label: string; ids: string[] };
type StayedRows = MovedRows & { why: string };

/** Rows of the duplicate a merge left with it, counted, with why. */
export interface Stayed { label: string; n: number; why: string }

export interface MergeAnswer {
  keptId: string;
  mergedId: string;
  /** The merge's own record, which is what undoing it names. */
  mergeRecordId: string;
  name: string;
  moved: { label: string; n: number }[];
  /** What stayed with the duplicate, and why: never silently. */
  stayed: Stayed[];
  filled: string[];
  tagsAdded: string[];
}

/* ------------------------------------------------------- taking a merge back */

/**
 * Money that may have been written to the survivor since a merge. Anything
 * here created after the merge, on the survivor, blocks an undo: an invoice,
 * a payment or a ledger posting cannot be split back between two customers by
 * a guess, and putting one on the wrong person's account is worse than a
 * merge that stands. The ledger is here because a payment, a void or a
 * refund on an invoice the merge moved posts to it.
 *
 * An agreement to charge a saved card is here too, though it is not money
 * yet: given since, for a card the merge moved, it would stay with the
 * survivor while its card went back, an agreement to charge a card that is
 * no longer theirs.
 */
const MONEY_SINCE: Ref[] = [
  ...MONEY,
  { table: "payment_agreement", column: "customer_id", label: "card payment agreements" },
];

type MergeRow = typeof schema.customerMerge.$inferSelect;

/**
 * What stands in the way of taking this merge back, as sentences, and the
 * records it would move back. Read inside the caller's transaction, so the
 * undo checks exactly what it then does.
 */
async function undoPlan(tx: Database, ctx: ServiceContext, merge: MergeRow, now: Date) {
  const zone = await timezoneOf(tx, ctx.actor.organizationId);
  const day = (at: Date) => time.dateIn(at, zone);
  const [kept] = await tx.select().from(schema.customer).where(eq(schema.customer.id, merge.keptCustomerId)).limit(1);
  const [dupe] = await tx.select().from(schema.customer).where(eq(schema.customer.id, merge.mergedCustomerId)).limit(1);
  const names = { kept: kept?.name ?? "the record kept", duplicate: dupe?.name ?? "the duplicate" };
  const blockers: customerMerge.Blockers = {};

  if (merge.undoneAt) blockers.undoneOn = day(merge.undoneAt);
  if (!customerMerge.withinWindow(merge.createdAt, now)) blockers.tooOld = day(merge.createdAt);
  if (!kept || kept.deletedAt) {
    blockers.keptGone = kept?.mergedIntoId
      ? `${names.kept} has since been merged into another record. Undo that merge first.`
      : `${names.kept} has since been taken off the books.`;
  }
  if (!dupe || !dupe.deletedAt || dupe.mergedIntoId !== merge.keptCustomerId) blockers.duplicateMoved = true;

  if (!merge.undoneAt) {
    const moneySince: customerMerge.Count[] = [];
    for (const ref of MONEY_SINCE) {
      const [row] = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from ${sql.identifier(ref.table)}
        where ${sql.identifier(ref.column)} = ${merge.keptCustomerId}
          and organization_id = ${ctx.actor.organizationId}
          and created_at > ${merge.createdAt.toISOString()}::timestamptz`);
      if (Number(row?.n ?? 0) > 0) moneySince.push({ label: ref.label, n: Number(row!.n) });
    }
    blockers.moneySince = moneySince;

    /**
     * Every row the merge moved has to still be the survivor's. One moved on
     * since (a contact moved to another customer, a link taken off an
     * address) is something an undo would have to guess about. A link the
     * merge itself took out as a double is not expected back here: it is put
     * back whole.
     */
    const removedIds = new Set(merge.removedLinks.map((link) => String(link.row["id"])));
    const movedAway: customerMerge.Count[] = [];
    for (const group of merge.moved) {
      const ids = group.ids.filter((id) => !removedIds.has(id));
      if (ids.length === 0) continue;
      const [row] = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from ${sql.identifier(group.table)}
        where id = any(${sql.param(ids)}::uuid[])
          and ${sql.identifier(group.column)} = ${merge.keptCustomerId}`);
      const missing = ids.length - Number(row?.n ?? 0);
      if (missing > 0) movedAway.push({ label: group.label, n: missing });
    }
    blockers.movedAway = movedAway;

    /**
     * Work booked for the survivor since, at an address that goes back with
     * the duplicate: undone, that job would be the survivor's at a place that
     * is not theirs. Which customer it was really for is somebody's call.
     */
    const returning = await returningAddresses(tx, merge);
    const work: customerMerge.Count[] = [];
    if (returning.length > 0) {
      for (const ref of [
        { table: "job", label: "jobs" }, { table: "estimate", label: "estimates" },
      ]) {
        const [row] = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from ${sql.identifier(ref.table)}
          where customer_id = ${merge.keptCustomerId}
            and property_id = any(${sql.param(returning)}::uuid[])
            and created_at > ${merge.createdAt.toISOString()}::timestamptz`);
        if (Number(row?.n ?? 0) > 0) work.push({ label: ref.label, n: Number(row!.n) });
      }
    }
    blockers.workAtReturningAddress = work;
  }

  return { reasons: customerMerge.reasons(blockers, names), kept, dupe, names };
}

/**
 * The addresses that leave the survivor on an undo: those the duplicate
 * brought with it that the survivor has no link of its own to.
 */
async function returningAddresses(tx: Database, merge: MergeRow): Promise<string[]> {
  const linkIds = merge.moved.find((g) => g.table === "customer_property")?.ids ?? [];
  const removedBack = merge.removedLinks.filter((l) => l.customerId === merge.mergedCustomerId)
    .map((l) => String(l.row["property_id"]));
  if (linkIds.length === 0 && removedBack.length === 0) return [];
  const rows = await tx.execute<{ property_id: string }>(sql`
    select distinct property_id::text as property_id from public.customer_property
    where id = any(${sql.param(linkIds)}::uuid[])`);
  const theirs = new Set([...[...rows].map((r) => r.property_id), ...removedBack]);
  const stays = await tx.execute<{ property_id: string }>(sql`
    select distinct property_id::text as property_id from public.customer_property
    where customer_id = ${merge.keptCustomerId}
      and not (id = any(${sql.param(linkIds)}::uuid[]))`);
  for (const row of stays) theirs.delete(row.property_id);
  return [...theirs];
}

async function loadMerge(tx: Database, ctx: ServiceContext, id: string): Promise<MergeRow> {
  const [row] = await tx.select().from(schema.customerMerge)
    .where(and(eq(schema.customerMerge.id, id), eq(schema.customerMerge.organizationId, ctx.actor.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Merge");
  return row;
}

export interface MergeView {
  id: string;
  keptCustomerId: string;
  merged: { id: string; name: string };
  mergedAt: string;
  by: { userId: string; name: string | null } | null;
  reason: string | null;
  moved: { label: string; n: number }[];
  stayed: Stayed[];
  filled: string[];
  tagsAdded: string[];
  undone: { at: string; by: { userId: string; name: string | null } | null; reason: string | null } | null;
  /** Until when it can be undone, whatever else is in the way. */
  undoableUntil: string;
  /** Whether it can be undone now, and every reason it cannot. */
  canUndo: boolean;
  blockedBy: string[];
}

/**
 * The merges into this customer, newest first, each with whether it can be
 * undone now and, when not, every reason why in words. Behind
 * `customer:merge`, because it is read to act on.
 */
export async function merges(ctx: ServiceContext, input: { id: string }): Promise<{ merges: MergeView[] }> {
  return guardedRead(ctx, "customer:merge", async (tx) => {
    const [customer] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(eq(schema.customer.id, input.id), eq(schema.customer.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const rows = await tx.select().from(schema.customerMerge)
      .where(and(
        eq(schema.customerMerge.organizationId, ctx.actor.organizationId),
        eq(schema.customerMerge.keptCustomerId, input.id),
      ))
      .orderBy(desc(schema.customerMerge.createdAt))
      .limit(50);
    const people = await tx.execute<{ user_id: string; name: string | null; email: string }>(
      sql`select user_id, name, email from app.organization_people()`,
    );
    const nameOf = new Map([...people].map((p) => [p.user_id, p.name ?? p.email]));
    const who = (userId: string | null) => (userId ? { userId, name: nameOf.get(userId) ?? null } : null);
    const now = new Date();
    const out: MergeView[] = [];
    for (const row of rows) {
      const plan = await undoPlan(tx, ctx, row, now);
      out.push({
        id: row.id,
        keptCustomerId: row.keptCustomerId,
        merged: { id: row.mergedCustomerId, name: plan.names.duplicate },
        mergedAt: row.createdAt.toISOString(),
        by: who(row.mergedByUserId),
        reason: row.reason,
        moved: row.moved.map((g) => ({ label: g.label, n: g.ids.length })),
        stayed: row.stayed.map((g) => ({ label: g.label, n: g.ids.length, why: g.why })),
        filled: Object.keys(row.filled),
        tagsAdded: row.tagsAdded,
        undone: row.undoneAt
          ? { at: row.undoneAt.toISOString(), by: who(row.undoneByUserId), reason: row.undoReason }
          : null,
        undoableUntil: customerMerge.undoableUntil(row.createdAt).toISOString(),
        canUndo: plan.reasons.length === 0,
        blockedBy: plan.reasons,
      });
    }
    return { merges: out };
  });
}

export interface UndoAnswer {
  mergeRecordId: string;
  keptId: string;
  /** The duplicate, a customer of its own again. */
  restoredId: string;
  restoredName: string;
  movedBack: { label: string; n: number }[];
  /** Blank fields the merge filled that were cleared again. */
  filledCleared: string[];
  /** Fields the merge filled that somebody has changed since, left as they are. */
  filledKept: string[];
  tagsRemoved: string[];
}

/**
 * Take a merge back: every row it moved goes back to the duplicate, the
 * address links it took out as doubles are put back as they were, the blank
 * fields it filled are blank again where nobody has changed them since, the
 * tags it added come off, and the duplicate is a customer of its own again.
 *
 * Refused, naming every reason at once, when the merge is older than the
 * window, already undone, or anything has happened since that cannot be put
 * back: money written to the survivor, a moved record that has moved on,
 * work booked at an address that would go back, either record merged or
 * removed since. Anything else written to the survivor since (a note, a new
 * contact, a job at its own address) stays with the survivor, which is who
 * it was written to.
 */
export async function undoMerge(
  ctx: ServiceContext, input: { id: string; reason?: string | undefined },
): Promise<UndoAnswer> {
  return guardedWrite(ctx, "customer:merge", async (tx) => {
    const seen = await replayed<UndoAnswer>(tx, ctx, "customer_merge_undo");
    if (seen) return seen;
    const merge = await loadMerge(tx, ctx, input.id);
    /** Taken in a fixed order, so two undos of merges into one customer queue rather than deadlock. */
    await tx.execute(sql`select id from public.customer where id in (${merge.keptCustomerId}, ${merge.mergedCustomerId}) order by id for update`);
    const now = new Date();
    const plan = await undoPlan(tx, ctx, merge, now);
    if (plan.reasons.length > 0) throw new ConflictError(plan.reasons.join(" "));
    const kept = plan.kept!;

    const movedBack: { label: string; n: number }[] = [];
    for (const group of merge.moved) {
      const rows = await tx.execute<{ id: string }>(sql`
        update ${sql.identifier(group.table)}
        set ${sql.identifier(group.column)} = ${merge.mergedCustomerId}
        where id = any(${sql.param(group.ids)}::uuid[])
          and ${sql.identifier(group.column)} = ${merge.keptCustomerId}
          and organization_id = ${ctx.actor.organizationId}
        returning id`);
      const n = [...rows].length;
      if (n > 0) movedBack.push({ label: group.label, n });
    }

    /** The doubles the merge took out, as they were, each to whose it was. */
    for (const link of merge.removedLinks) {
      await tx.execute(sql`
        insert into public.customer_property
        select (jsonb_populate_record(null::public.customer_property,
          ${JSON.stringify({ ...link.row, customer_id: link.customerId })}::jsonb)).*
        on conflict (id) do nothing`);
    }

    /**
     * A yes to advertising the merge superseded with the duplicate's no is
     * the kept record's live answer again, now the no has gone back with the
     * duplicate. Unless somebody recorded a new answer on the kept record
     * since: that one is live, and it stands.
     */
    let answersRestored = 0;
    for (const group of merge.superseded) {
      if (group.table !== "advertising_consent") continue;
      const rows = await tx.execute<{ id: string }>(sql`
        update public.advertising_consent k
        set superseded_at = null, updated_at = now()
        where k.id = any(${sql.param(group.ids)}::uuid[])
          and k.customer_id = ${merge.keptCustomerId}
          and k.organization_id = ${ctx.actor.organizationId}
          and not exists (select 1 from public.advertising_consent x
            where x.customer_id = ${merge.keptCustomerId} and x.superseded_at is null)
        returning k.id`);
      answersRestored += [...rows].length;
    }

    const filledCleared: string[] = [];
    const filledKept: string[] = [];
    const clear: Record<string, null> = {};
    for (const [field, value] of Object.entries(merge.filled)) {
      const current = (kept as Record<string, unknown>)[field];
      if (current === value) {
        clear[field] = null;
        filledCleared.push(field);
      } else {
        filledKept.push(field);
      }
    }
    const addedKeys = new Set(merge.tagsAdded.map(tagRules.tagKey));
    const tagsRemoved = kept.tags.filter((tag) => addedKeys.has(tagRules.tagKey(tag)));
    await tx.update(schema.customer).set({
      ...clear,
      ...(tagsRemoved.length > 0 ? { tags: kept.tags.filter((tag) => !addedKeys.has(tagRules.tagKey(tag))) } : {}),
      updatedAt: now,
    }).where(eq(schema.customer.id, merge.keptCustomerId));

    const [restored] = await tx.update(schema.customer).set({
      deletedAt: null, mergedIntoId: null, updatedAt: now,
    }).where(eq(schema.customer.id, merge.mergedCustomerId)).returning();

    await tx.update(schema.customerMerge).set({
      undoneAt: now, undoneByUserId: ctx.actor.userId, undoReason: input.reason?.trim() || null, updatedAt: now,
    }).where(eq(schema.customerMerge.id, merge.id));

    const answer: UndoAnswer = {
      mergeRecordId: merge.id,
      keptId: merge.keptCustomerId,
      restoredId: merge.mergedCustomerId,
      restoredName: restored!.name,
      movedBack,
      filledCleared,
      filledKept,
      tagsRemoved,
    };
    await audit(tx, ctx, "customer.merge_undone", "customer", merge.keptCustomerId, null, {
      ...answer, answersRestored, reason: input.reason?.trim() || null, mergedAt: merge.createdAt.toISOString(),
    });
    await remember(tx, ctx, "customer_merge_undo", merge.id, answer);
    return answer;
  });
}

/**
 * Where a merged customer went.
 *
 * The read that makes keeping the loser worth anything. Without it the
 * pointer is a column nobody follows, and the old id resolving to a soft
 * deleted row is the same dead end as deleting it.
 */
export async function mergedInto(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const [row] = await tx.select({
      id: schema.customer.id,
      mergedIntoId: schema.customer.mergedIntoId,
      deletedAt: schema.customer.deletedAt,
    }).from(schema.customer)
      .where(and(
        eq(schema.customer.id, input.id),
        eq(schema.customer.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!row) throw new NotFoundError("Customer");
    if (!row.mergedIntoId) return null;

    const [target] = await tx.select({
      id: schema.customer.id, name: schema.customer.name,
    }).from(schema.customer)
      .where(and(
        eq(schema.customer.id, row.mergedIntoId),
        ne(schema.customer.id, input.id),
      )).limit(1);

    return target ?? null;
  });
}

/**
 * THE RECORDS THAT LOOK LIKE THE SAME PERSON
 *
 * Merging needs two ids and a screen cannot ask somebody to type the second one.
 * A picker over every customer is no better: a company with four thousand of them
 * is a dropdown nobody can use, and browsing is not how a duplicate is found
 * anyway. A duplicate is found by matching.
 *
 * Three signals, strongest first, and each one says WHY so the person deciding
 * can see it rather than trusting a score:
 *
 *   The same phone number, which for a household is the strongest signal there
 *   is: two records with one number is almost always one person entered twice.
 *   The same email address, for the same reason.
 *   A similar name, by trigram similarity, which catches "Robert Smith" against
 *   "Bob Smith" and "Smith, Robert" and is the one that needs a human to confirm.
 *
 * NO SCORE AND NO RANKING ACROSS SIGNALS. A single number would have to weigh a
 * shared phone against a 0.6 name similarity, and whatever weighting was chosen
 * would be wrong for somebody. The reason is the output.
 *
 * Soft deleted rows are excluded, so a record already merged away does not come
 * back as a candidate for merging again.
 */
export const NAME_SIMILARITY = 0.45;

/**
 * The three reasons, strongest first, in the words a person deciding reads.
 * Exported so the company wide sweep in `customer-duplicates.ts` says exactly
 * what this per record matcher says about the same pair.
 */
export const DUPLICATE_REASONS = ["Same phone number", "Same email address", "Similar name"] as const;

export interface DuplicateCandidate {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** Why this one is here, in the words a person deciding would use. */
  because: string;
}

export async function likelyDuplicates(
  ctx: ServiceContext, input: { id: string; limit?: number },
): Promise<DuplicateCandidate[]> {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const subject = await load(tx, ctx.actor.organizationId, input.id);
    const limit = Math.min(input.limit ?? 10, 50);

    /**
     * One query rather than three, because three would have to be merged in
     * TypeScript and a record matching on both phone and name would arrive twice.
     * The `case` picks the strongest reason, which is also what orders the result.
     */
    /**
     * EVERY PARAMETER IS CAST, and the nullable ones are why.
     *
     * A bare parameter in `$1 is not null` gives Postgres nothing to infer a type
     * from, and it refuses the statement with "could not determine data type of
     * parameter $1" rather than guessing. That is the right behaviour and it is
     * not a Drizzle quirk: the same SQL typed by hand is refused the same way.
     */
    const phone = sql`${subject.phone}::text`;
    const email = sql`${subject.email}::text`;
    const name = sql`${subject.name}::text`;

    const rows = await tx.execute<{
      id: string; name: string; phone: string | null; email: string | null; because: string;
    }>(sql`
      select c.id, c.name, c.phone, c.email,
        case
          when ${phone} is not null and c.phone = ${phone}
            then 'Same phone number'
          when ${email} is not null and lower(c.email) = lower(${email})
            then 'Same email address'
          else 'Similar name'
        end as because
      from public.customer c
      where c.organization_id = ${ctx.actor.organizationId}
        and c.id <> ${input.id}
        and c.deleted_at is null
        /**
         * Not a pair somebody already looked at and said are two people. The
         * sweep remembers that decision, and a matcher that ignored it would
         * offer the landlord as the tenant's duplicate on every visit to her
         * page, which is the noise that makes people stop reading the list.
         */
        and not exists (
          select 1 from public.customer_not_duplicate d
          where (d.customer_a_id = c.id and d.customer_b_id = ${input.id})
             or (d.customer_b_id = c.id and d.customer_a_id = ${input.id})
        )
        and (
          (${phone} is not null and c.phone = ${phone})
          or (${email} is not null and lower(c.email) = lower(${email}))
          or similarity(c.name, ${name}) >= ${NAME_SIMILARITY}::real
        )
      order by
        case
          when ${phone} is not null and c.phone = ${phone} then 0
          when ${email} is not null and lower(c.email) = lower(${email}) then 1
          else 2
        end,
        similarity(c.name, ${name}) desc,
        c.name
      limit ${limit}`);

    return [...rows] as DuplicateCandidate[];
  });
}

export const handlers = {
  getCustomerDuplicates: async (ctx: ServiceContext, input: { id: string; limit?: number | undefined }) => ({
    candidates: await likelyDuplicates(ctx, {
      id: input.id, ...(input.limit ? { limit: input.limit } : {}),
    }),
  }),

  getCustomerDeletability: (ctx: ServiceContext, input: { id: string }) =>
    deletability(ctx, input),

  removeCustomer: (ctx: ServiceContext, input: { id: string; reason: string }) =>
    remove(ctx, input),

  mergeCustomers: (
    ctx: ServiceContext,
    input: { keepId: string; mergeId: string; reason?: string | undefined },
  ) => merge(ctx, {
    keepId: input.keepId,
    mergeId: input.mergeId,
    ...(input.reason ? { reason: input.reason } : {}),
  }),

  getCustomerMerges: (ctx: ServiceContext, input: { id: string }) => merges(ctx, input),

  undoCustomerMerge: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    undoMerge(ctx, input),

  /**
   * Wrapped in an object rather than returned bare.
   *
   * A route whose whole body is `null` is indistinguishable from a route that
   * answered nothing, and a generated client types it as `unknown`. `into: null`
   * is an answer: this customer was never merged.
   */
  getCustomerMergedInto: async (ctx: ServiceContext, input: { id: string }) => ({
    into: await mergedInto(ctx, input),
  }),
} as const;
