import { and, eq, desc, lt, or, ilike, isNull, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan } from "@opentradesos/core";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean, cleanAll,
  decodeCursor, paginate, NotFoundError, ConflictError, scopeOf,
} from "./context";
import { customerScopeFilter } from "./scope";
import type { CustomerCreate, listCustomers, getCustomer, updateCustomer } from "../contracts/customers";

type ListInput = z.infer<typeof listCustomers.input>;
type CreateInput = z.infer<typeof CustomerCreate>;

/**
 * The exemplar service. Every other one follows this shape.
 */
export async function list(ctx: ServiceContext, input: ListInput) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);
    /**
     * A technician sees the people they have been sent to, not the company's
     * book. This is the filter the comment on the technician row in
     * `core/access/scopes.ts` has been promising, and until it existed a
     * departing technician could page through every customer.
     */
    const where = and(
      customerScopeFilter(scopeOf(ctx, "customer"), ctx.actor),
      isNull(schema.customer.deletedAt),
      input.type ? eq(schema.customer.type, input.type) : undefined,
      // Trigram search across the three things a CSR actually types while
      // somebody is on the phone. A pg_trgm index backs each of them.
      input.q
        ? or(
            ilike(schema.customer.name, `%${input.q}%`),
            ilike(schema.customer.email, `%${input.q}%`),
            ilike(schema.customer.phone, `%${input.q}%`),
          )
        : undefined,
      cursor ? lt(schema.customer.createdAt, new Date(cursor)) : undefined,
    );

    // One extra row tells us whether another page exists without a count(*),
    // which on a large table is the difference between fast and unusable.
    const rows = await tx.select().from(schema.customer)
      .where(where)
      .orderBy(desc(schema.customer.createdAt))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.createdAt.toISOString());
    return { ...page, data: cleanAll(ctx, "customer", page.data) };
  });
}

export async function get(ctx: ServiceContext, input: z.infer<typeof getCustomer.input>) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const [row] = await tx.select().from(schema.customer)
      .where(and(eq(schema.customer.id, input.id), isNull(schema.customer.deletedAt)))
      .limit(1);
    // RLS already scoped this to the tenant, so a miss is genuinely a miss
    // rather than a permission problem wearing a disguise.
    if (!row) throw new NotFoundError("Customer");

    /**
     * WHAT THEY OWE, COMPUTED ON EVERY READ.
     *
     * The contract has published `balance` since the beginning and nothing
     * ever produced it: there is no column, no service set one, and a
     * generated client's `customer.balance` was permanently undefined.
     *
     * Computed rather than stored, and that is the design rather than the
     * cheap option. A stored balance is a number two writers race to
     * update, and the one that loses leaves a customer owing money the
     * system believes they paid. The invoices are the record; this is a
     * sum over them.
     *
     * Summed by PAYER, not by the customer named on the job. A tenant whose
     * landlord is billed owes nothing, and a balance that ignored that
     * would have somebody chasing the wrong person.
     */
    const [owed] = await tx.select({
      total: sql<string>`coalesce(sum(${schema.invoice.balance}), 0)::text`,
    }).from(schema.invoice)
      .where(and(
        eq(schema.invoice.organizationId, ctx.actor.organizationId),
        sql`coalesce(${schema.invoice.payerCustomerId}, ${schema.invoice.customerId}) = ${input.id}`,
        inArray(schema.invoice.status, ["open", "partially_paid"]),
        isNull(schema.invoice.deletedAt),
      ));

    /**
     * Redaction runs over the merged row, so the balance is hidden from a
     * caller without `customer.financials:read` by the same rule that hides
     * the discount. Putting it on afterwards would have sent it to
     * everybody.
     */
    return clean(ctx, "customer", { ...row, balance: owed?.total ?? "0" });
  });
}

export async function create(ctx: ServiceContext, input: CreateInput) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    /**
     * Idempotency. A client on bad signal retries, and without this the
     * retry creates a second customer that somebody has to merge by hand.
     * The key is checked inside the same transaction as the insert, so two
     * simultaneous retries cannot both pass the check.
     */
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "customer"),
        ))
        .limit(1);
      if (seen?.entityId) {
        const [existing] = await tx.select().from(schema.customer)
          .where(eq(schema.customer.id, seen.entityId)).limit(1);
        if (existing) return clean(ctx, "customer", existing);
      }
    }

    const [customer] = await tx.insert(schema.customer).values({
      organizationId: ctx.actor.organizationId,
      type: input.type,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      billingAddressLine1: input.billingAddress?.line1 ?? null,
      billingAddressLine2: input.billingAddress?.line2 ?? null,
      billingCity: input.billingAddress?.city ?? null,
      billingState: input.billingAddress?.state ?? null,
      billingPostalCode: input.billingAddress?.postalCode ?? null,
      billingCountry: input.billingAddress?.country ?? "US",
      leadSource: input.leadSource ?? null,
      paymentTermsDays: String(input.paymentTermsDays),
      taxExempt: input.taxExempt,
      tags: input.tags,
      customFields: input.customFields,
    }).returning();

    /**
     * The first property goes in the same transaction on purpose. Splitting
     * it into a second call guarantees orphaned customers whenever the second
     * one fails, and somebody discovers them a year later.
     */
    if (input.property) {
      const [property] = await tx.insert(schema.property).values({
        organizationId: ctx.actor.organizationId,
        nickname: input.property.nickname ?? null,
        addressLine1: input.property.address.line1,
        addressLine2: input.property.address.line2 ?? null,
        city: input.property.address.city,
        state: input.property.address.state,
        postalCode: input.property.address.postalCode,
        country: input.property.address.country,
        accessNotes: input.property.accessNotes ?? null,
      }).returning({ id: schema.property.id });

      await tx.insert(schema.customerProperty).values({
        organizationId: ctx.actor.organizationId,
        customerId: customer!.id,
        propertyId: property!.id,
        role: "owner",
        isPrimary: true,
      });
    }

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound",
        provider: "api",
        eventType: "customer.create",
        idempotencyKey: ctx.idempotencyKey,
        status: "succeeded",
        entityType: "customer",
        entityId: customer!.id,
      });
    }

    await audit(tx, ctx, "customer.created", "customer", customer!.id, null, customer!);
    return clean(ctx, "customer", customer!);
  });
}

/**
 * Takes the contract's own input type rather than a hand-rolled
 * `Partial<CreateInput>`. Under exactOptionalPropertyTypes those are different
 * types: `Partial<T>` makes a field optional without allowing `undefined`,
 * while the contract's optional fields allow it, so the hand-rolled version
 * silently rejects exactly the shape the API validates and accepts.
 */
export async function update(ctx: ServiceContext, input: z.infer<typeof updateCustomer.input>) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const [before] = await tx.select().from(schema.customer)
      .where(and(eq(schema.customer.id, input.id), isNull(schema.customer.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Customer");

    /**
     * A standing discount is a price change on every future invoice, so it
     * needs the permission that sees prices rather than the one that edits
     * a phone number. Refused rather than ignored: silently dropping it
     * would be the defect this whole function was rewritten to remove.
     */
    if (input.discountRate !== undefined) {
      assertCan(ctx.actor, "customer.financials:write");
    }

    /**
     * A customer nobody may work for, with no reason recorded, is a decision
     * the next person cannot evaluate and will not overturn. The reason is
     * required when the flag goes ON, and cleared with it, so a customer
     * reinstated in March does not keep last year's note.
     */
    if (input.doNotService === true) {
      const reason = input.doNotServiceReason ?? before.doNotServiceReason;
      if (!reason || reason.trim() === "") {
        throw new ConflictError(
          "Say why this customer should not be serviced. Without a reason the next person cannot judge whether it still applies, so it never gets lifted.",
        );
      }
    }

    /**
     * EVERY FIELD THE CONTRACT ACCEPTS IS WRITTEN HERE.
     *
     * It used to write seven of them. `paymentTermsDays`, `billingAddress`
     * and `customFields` were accepted by the input schema, validated,
     * answered with a 200 and thrown away: the caller sent a value, got a
     * success, and read back the old one they were trying to replace. That
     * is quieter than an unknown field, which at least fails validation.
     *
     * `patch-writes.integration.test.ts` sends every accepted field and
     * asserts the row changed, so the next one added to the contract and
     * not to this list fails a test rather than a customer's account terms.
     */
    const [after] = await tx.update(schema.customer).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.leadSource !== undefined ? { leadSource: input.leadSource } : {}),
      ...(input.taxExempt !== undefined ? { taxExempt: input.taxExempt } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      /** Stored as text, because net terms arrive from imports as "30 days". */
      ...(input.paymentTermsDays !== undefined
        ? { paymentTermsDays: String(input.paymentTermsDays) } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      ...(input.billingAddress !== undefined ? {
        billingAddressLine1: input.billingAddress.line1 ?? null,
        billingAddressLine2: input.billingAddress.line2 ?? null,
        billingCity: input.billingAddress.city ?? null,
        billingState: input.billingAddress.state ?? null,
        billingPostalCode: input.billingAddress.postalCode ?? null,
        ...(input.billingAddress.country ? { billingCountry: input.billingAddress.country } : {}),
      } : {}),
      ...(input.doNotService !== undefined ? {
        doNotService: input.doNotService,
        /** Cleared with the flag, so a reinstated customer keeps no stale note. */
        doNotServiceReason: input.doNotService
          ? (input.doNotServiceReason ?? before.doNotServiceReason)
          : null,
      } : {}),
      ...(input.doNotServiceReason !== undefined && input.doNotService === undefined
        ? { doNotServiceReason: input.doNotServiceReason } : {}),
      ...(input.discountRate !== undefined ? { discountRate: input.discountRate } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.customer.id, input.id)).returning();

    await audit(tx, ctx, "customer.updated", "customer", input.id, before, after!);
    return clean(ctx, "customer", after!);
  });
}

/**
 * Every mutation writes here, and an AI agent is named as the actor when one
 * is acting. Being able to answer "what did the agent do, and when" is what
 * makes an agent layer something an owner will actually turn on.
 */
async function audit(
  tx: Database, ctx: ServiceContext, action: string,
  entityType: string, entityId: string,
  before: unknown, after: unknown,
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    organizationId: ctx.actor.organizationId,
    // A portal caller has no user. Writing the synthetic id into a uuid column
    // fails loudly, which is better than a column of fake users, but the real
    // answer is to name the grant.
    actorUserId: ctx.portalGrantId ? null : ctx.actor.userId,
    actorPortalGrantId: ctx.portalGrantId ?? null,
    actorAgentId: ctx.agentId ?? ctx.actor.agentId ?? null,
    action,
    entityType,
    entityId,
    before: (before ?? null) as Record<string, unknown> | null,
    after: (after ?? null) as Record<string, unknown> | null,
  });
}

export { audit };
