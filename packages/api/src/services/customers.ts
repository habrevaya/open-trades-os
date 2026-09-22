import { and, eq, desc, lt, or, ilike, sql, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean, cleanAll,
  decodeCursor, paginate, NotFoundError, ConflictError,
} from "./context";
import type { CustomerCreate, listCustomers, getCustomer, createCustomer } from "../contracts/customers";

type ListInput = z.infer<typeof listCustomers.input>;
type CreateInput = z.infer<typeof CustomerCreate>;

/**
 * The exemplar service. Every other one follows this shape.
 */
export async function list(ctx: ServiceContext, input: ListInput) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);
    const where = and(
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
    return clean(ctx, "customer", row);
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

export async function update(ctx: ServiceContext, input: Partial<CreateInput> & { id: string }) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const [before] = await tx.select().from(schema.customer)
      .where(and(eq(schema.customer.id, input.id), isNull(schema.customer.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Customer");

    const [after] = await tx.update(schema.customer).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.leadSource !== undefined ? { leadSource: input.leadSource } : {}),
      ...(input.taxExempt !== undefined ? { taxExempt: input.taxExempt } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
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
    actorUserId: ctx.actor.userId,
    actorAgentId: ctx.agentId ?? ctx.actor.agentId ?? null,
    action,
    entityType,
    entityId,
    before: (before ?? null) as Record<string, unknown> | null,
    after: (after ?? null) as Record<string, unknown> | null,
  });
}

export { audit };
