import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

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
 * split across two rows, which is the exact thing it exists to end.
 */
type Ref = { table: string; column: string; label: string };

const MONEY: Ref[] = [
  { table: "invoice", column: "customer_id", label: "invoices" },
  { table: "invoice", column: "payer_customer_id", label: "invoices they pay for" },
  { table: "payment", column: "customer_id", label: "payments" },
  { table: "deposit", column: "customer_id", label: "deposits" },
  { table: "ledger_entry", column: "customer_id", label: "ledger entries" },
  { table: "agreement", column: "customer_id", label: "agreements" },
  { table: "service_contract", column: "customer_id", label: "contracts" },
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
  { table: "customer_property", column: "customer_id", label: "property links" },
  { table: "contact", column: "customer_id", label: "contacts" },
  { table: "conversation", column: "customer_id", label: "conversations" },
  { table: "call", column: "customer_id", label: "calls" },
  { table: "communication_consent", column: "customer_id", label: "consent records" },
  { table: "booking_request", column: "customer_id", label: "booking requests" },
  { table: "recurring_schedule", column: "customer_id", label: "recurring work" },
  { table: "review", column: "customer_id", label: "reviews" },
  { table: "review_request", column: "customer_id", label: "review requests" },
  { table: "marketing_touch", column: "customer_id", label: "marketing touches" },
  { table: "form_submission", column: "customer_id", label: "form submissions" },
  { table: "lead_offer", column: "customer_id", label: "lead offers" },
  { table: "portal_grant", column: "customer_id", label: "portal links" },
  { table: "portal_event", column: "customer_id", label: "portal events" },
  { table: "delivery", column: "customer_id", label: "deliveries" },
  { table: "deficiency", column: "customer_id", label: "deficiencies" },
  { table: "inspection", column: "customer_id", label: "inspections" },
  { table: "service_report", column: "customer_id", label: "service reports" },
];

async function countsFor(
  tx: Database, organizationId: string, customerId: string,
  refs: Ref[],
) {
  const found: { label: string; n: number }[] = [];
  for (const ref of refs) {
    const rows = await tx.execute(sql`
      select count(*)::int as n from ${sql.identifier(ref.table)}
      where ${sql.identifier(ref.column)} = ${customerId}
        and organization_id = ${organizationId}`);
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
 */
export async function merge(
  ctx: ServiceContext,
  input: { keepId: string; mergeId: string; reason?: string },
) {
  return guardedWrite(ctx, "customer:merge", async (tx) => {
    if (input.keepId === input.mergeId) {
      throw new ConflictError("Those are the same record.");
    }
    const keep = await load(tx, ctx.actor.organizationId, input.keepId);
    const loser = await load(tx, ctx.actor.organizationId, input.mergeId);

    const moved: { label: string; n: number }[] = [];
    for (const ref of [...MOVES, ...HISTORY]) {
      const rows = await tx.execute(sql`
        update ${sql.identifier(ref.table)}
        set ${sql.identifier(ref.column)} = ${input.keepId}
        where ${sql.identifier(ref.column)} = ${input.mergeId}
          and organization_id = ${ctx.actor.organizationId}
        returning 1`);
      const n = (rows as unknown as unknown[]).length;
      if (n > 0) moved.push({ label: ref.label, n });
    }

    /**
     * A property linked to both now has the same link twice. Deduplicated
     * here rather than left, because every screen listing a customer's
     * addresses would show the address twice and neither row is wrong.
     */
    await tx.execute(sql`
      delete from customer_property a
      using customer_property b
      where a.organization_id = ${ctx.actor.organizationId}
        and a.customer_id = ${input.keepId}
        and b.customer_id = ${input.keepId}
        and a.property_id = b.property_id
        and a.role = b.role
        and a.id > b.id`);

    /**
     * Fields the survivor is missing are taken from the loser. Never the
     * other way: a merge is a decision about which record is right, and
     * overwriting the survivor's name with the duplicate's would undo it.
     */
    const filled: Record<string, string> = {};
    for (const field of ["email", "phone", "leadSource"] as const) {
      if (!keep[field] && loser[field]) filled[field] = loser[field]!;
    }

    const [after] = await tx.update(schema.customer)
      .set({ ...filled, updatedAt: new Date() })
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

    await audit(tx, ctx, "customer.merged", "customer", input.keepId, loser, {
      keptId: input.keepId, mergedId: input.mergeId,
      moved, filled, reason: input.reason?.trim() || null,
    });

    return {
      keptId: input.keepId,
      mergedId: input.mergeId,
      name: after!.name,
      moved,
      /** Which blank fields on the survivor were filled from the duplicate. */
      filled: Object.keys(filled),
    };
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
