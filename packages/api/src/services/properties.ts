import { and, eq, desc, lt, or, ilike, isNull, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean, cleanAll,
  decodeCursor, paginate, NotFoundError,
} from "./context";
import { audit } from "./customers";
import type {
  listProperties, getProperty, createProperty, linkCustomerToProperty,
} from "../contracts/properties";

/**
 * PROPERTIES
 *
 * A property is a first class record, not an address field on a customer, and
 * the link between the two is its own row carrying a role and a validity
 * window.
 *
 * That shape costs a join on every read and buys the thing a ten year service
 * record is actually for. A house is sold and the furnace does not move. A
 * landlord holds forty addresses and the tenant at one of them is the person
 * who opens the door. A property manager is billed while the owner is not.
 * Flattening any of that into a column on the customer means the history
 * leaves with the customer, and the equipment record that says this coil was
 * replaced under warranty in 2019 becomes unreachable exactly when somebody
 * needs it.
 */

type ListInput = z.infer<typeof listProperties.input>;

/** The customers attached to a set of properties, in one query rather than N. */
interface LinkedCustomer { id: string; name: string; role: string }

async function linksFor(
  tx: Database,
  propertyIds: string[],
): Promise<Map<string, LinkedCustomer[]>> {
  const out = new Map<string, LinkedCustomer[]>();
  if (propertyIds.length === 0) return out;

  const rows = await tx.select({
    propertyId: schema.customerProperty.propertyId,
    id: schema.customer.id,
    name: schema.customer.name,
    role: schema.customerProperty.role,
    isPrimary: schema.customerProperty.isPrimary,
  })
    .from(schema.customerProperty)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.customerProperty.customerId))
    .where(and(
      inArray(schema.customerProperty.propertyId, propertyIds),
      // A link that has ended is history, not a current relationship. The row
      // stays so the history survives; it just stops answering "who owns this".
      isNull(schema.customerProperty.endedOn),
      isNull(schema.customerProperty.deletedAt),
    ))
    .orderBy(desc(schema.customerProperty.isPrimary));

  for (const row of rows) {
    const bucket = out.get(row.propertyId) ?? [];
    out.set(row.propertyId, bucket);
    bucket.push({ id: row.id, name: row.name, role: row.role });
  }
  return out;
}

/**
 * The contract nests the address; the table stores it flat.
 *
 * Generic over the row so callers keep the row's own type. An earlier version
 * took `Record<string, unknown>`, which compiled and quietly erased every
 * field: a test asking for `.id` on the result got a type error naming only
 * `address`, and any caller reading a column would have got `unknown`.
 */
function shape<T extends {
  addressLine1: string; addressLine2: string | null; city: string;
  state: string; postalCode: string; country: string;
}>(row: T) {
  return {
    ...row,
    address: {
      line1: row.addressLine1,
      line2: row.addressLine2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country,
    },
  };
}

export async function list(ctx: ServiceContext, input: ListInput) {
  return guardedRead(ctx, "property:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);

    /**
     * Filtering by customer goes through the link table, because "this
     * customer's properties" is a question about the relationship rather than
     * about the property. A landlord's forty addresses have nothing in common
     * on the property row itself.
     */
    const byCustomer = input.customerId
      ? inArray(
          schema.property.id,
          tx.select({ id: schema.customerProperty.propertyId })
            .from(schema.customerProperty)
            .where(and(
              eq(schema.customerProperty.customerId, input.customerId),
              isNull(schema.customerProperty.endedOn),
            )),
        )
      : undefined;

    const where = and(
      isNull(schema.property.deletedAt),
      byCustomer,
      input.territoryId ? eq(schema.property.territoryId, input.territoryId) : undefined,
      // What a dispatcher types: a street, a city, or a postal code.
      input.q
        ? or(
            ilike(schema.property.addressLine1, `%${input.q}%`),
            ilike(schema.property.city, `%${input.q}%`),
            ilike(schema.property.postalCode, `%${input.q}%`),
            ilike(schema.property.nickname, `%${input.q}%`),
          )
        : undefined,
      cursor ? lt(schema.property.createdAt, new Date(cursor)) : undefined,
    );

    const rows = await tx.select().from(schema.property)
      .where(where)
      .orderBy(desc(schema.property.createdAt))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.createdAt.toISOString());
    const links = await linksFor(tx, page.data.map((r) => r.id));

    return {
      ...page,
      data: cleanAll(ctx, "property", page.data).map((row) => ({
        ...shape(row),
        customers: links.get(row.id) ?? [],
      })),
    };
  });
}

export async function get(ctx: ServiceContext, input: z.infer<typeof getProperty.input>) {
  return guardedRead(ctx, "property:read", async (tx) => {
    const [row] = await tx.select().from(schema.property)
      .where(and(eq(schema.property.id, input.id), isNull(schema.property.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundError("Property");

    const links = await linksFor(tx, [row.id]);

    /**
     * A count rather than the equipment itself. The caller asking "what is at
     * this address" wants to know whether there is a register worth opening,
     * and a commercial site with two hundred rooftop units should not put all
     * of them in the response to a property read.
     */
    const [counted] = await tx.select({ n: sql<number>`count(*)::int` })
      .from(schema.equipment)
      .where(and(
        eq(schema.equipment.propertyId, row.id),
        isNull(schema.equipment.deletedAt),
      ));

    return {
      ...shape(clean(ctx, "property", row)),
      customers: links.get(row.id) ?? [],
      equipmentCount: counted?.n ?? 0,
    };
  });
}

export async function create(ctx: ServiceContext, input: z.infer<typeof createProperty.input>) {
  return guardedWrite(ctx, "property:write", async (tx) => {
    // Same idempotency contract as every other create: a retry from bad signal
    // must not leave two identical addresses for somebody to merge by hand.
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "property"),
        )).limit(1);
      if (seen?.entityId) {
        const [existing] = await tx.select().from(schema.property)
          .where(eq(schema.property.id, seen.entityId)).limit(1);
        if (existing) return shape(clean(ctx, "property", existing));
      }
    }

    const [property] = await tx.insert(schema.property).values({
      organizationId: ctx.actor.organizationId,
      nickname: input.nickname ?? null,
      addressLine1: input.address.line1,
      addressLine2: input.address.line2 ?? null,
      city: input.address.city,
      state: input.address.state,
      postalCode: input.address.postalCode,
      country: input.address.country,
      squareFeet: input.squareFeet ?? null,
      yearBuilt: input.yearBuilt ?? null,
      gateCode: input.gateCode ?? null,
      accessNotes: input.accessNotes ?? null,
      hazardNotes: input.hazardNotes ?? null,
      hasDog: input.hasDog,
      customFields: input.customFields,
    }).returning();

    /**
     * The link goes in the same transaction. A property created without one
     * is reachable by nobody: it has no customer, so it does not appear on any
     * customer's list, and finding it again means knowing its id.
     */
    if (input.customerId) {
      await tx.insert(schema.customerProperty).values({
        organizationId: ctx.actor.organizationId,
        customerId: input.customerId,
        propertyId: property!.id,
        role: input.customerRole,
        isPrimary: true,
      });
    }

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "property.create",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "property", entityId: property!.id,
      });
    }

    await audit(tx, ctx, "property.created", "property", property!.id, null, property!);
    return shape(clean(ctx, "property", property!));
  });
}

export async function link(ctx: ServiceContext, input: z.infer<typeof linkCustomerToProperty.input>) {
  return guardedWrite(ctx, "property:write", async (tx) => {
    const [property] = await tx.select({ id: schema.property.id })
      .from(schema.property)
      .where(and(eq(schema.property.id, input.id), isNull(schema.property.deletedAt)))
      .limit(1);
    if (!property) throw new NotFoundError("Property");

    const [customer] = await tx.select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, input.customerId), isNull(schema.customer.deletedAt)))
      .limit(1);
    // Checked rather than left to the foreign key. The constraint would also
    // catch it, with a message naming an index, and this endpoint is one an
    // integration calls with ids from somewhere else.
    if (!customer) throw new NotFoundError("Customer");

    /**
     * An existing OPEN link for the same customer and role is updated rather
     * than duplicated. Re-running an import, or a retried call, otherwise
     * leaves a property owned twice by the same person, and every screen that
     * lists owners then shows them twice.
     *
     * A link that has already ended is left alone: it is history, and closing
     * a sale in 2019 is a different fact from owning the place now.
     */
    const [existing] = await tx.select({ id: schema.customerProperty.id })
      .from(schema.customerProperty)
      .where(and(
        eq(schema.customerProperty.propertyId, input.id),
        eq(schema.customerProperty.customerId, input.customerId),
        eq(schema.customerProperty.role, input.role),
        isNull(schema.customerProperty.endedOn),
        isNull(schema.customerProperty.deletedAt),
      )).limit(1);

    if (existing) {
      await tx.update(schema.customerProperty).set({
        isPrimary: input.isPrimary,
        startedOn: input.startedOn ?? null,
        endedOn: input.endedOn ?? null,
        updatedAt: new Date(),
      }).where(eq(schema.customerProperty.id, existing.id));
    } else {
      await tx.insert(schema.customerProperty).values({
        organizationId: ctx.actor.organizationId,
        customerId: input.customerId,
        propertyId: input.id,
        role: input.role,
        isPrimary: input.isPrimary,
        startedOn: input.startedOn ?? null,
        endedOn: input.endedOn ?? null,
      });
    }

    /**
     * One primary per property, so a newly primary link demotes the others.
     * Two primaries means every screen that picks "the" customer picks
     * whichever the database returned first, which changes between reads.
     */
    if (input.isPrimary) {
      await tx.update(schema.customerProperty)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(
          eq(schema.customerProperty.propertyId, input.id),
          isNull(schema.customerProperty.endedOn),
          sql`${schema.customerProperty.customerId} <> ${input.customerId}`,
        ));
    }

    await audit(tx, ctx, "property.customer_linked", "property", input.id, null, {
      customerId: input.customerId, role: input.role, isPrimary: input.isPrimary,
    });
    return { ok: true as const };
  });
}

/**
 * Edit a property.
 *
 * There was no update path, which made `territoryId` a filter whose only
 * possible answer was none, and left a gate code that changed or a hazard
 * found on the third visit with nowhere to go.
 *
 * THE ADDRESS IS NOT HERE. A property IS its address and the service record
 * is what makes it worth anything; letting somebody retype it turns one
 * house into another with ten years of history attached.
 */
export async function update(
  ctx: ServiceContext,
  input: {
    id: string;
    nickname?: string | null | undefined;
    territoryId?: string | null | undefined;
    squareFeet?: string | null | undefined;
    yearBuilt?: string | null | undefined;
    gateCode?: string | null | undefined;
    accessNotes?: string | null | undefined;
    hazardNotes?: string | null | undefined;
    hasDog?: boolean | undefined;
    customFields?: Record<string, unknown> | undefined;
  },
) {
  return guardedWrite(ctx, "property:write", async (tx) => {
    const [before] = await tx.select().from(schema.property)
      .where(and(eq(schema.property.id, input.id), isNull(schema.property.deletedAt)))
      .limit(1);
    if (!before) throw new NotFoundError("Property");

    /**
     * A territory from another company is already invisible to this query
     * under RLS, so the lookup simply misses. Checked anyway so a bad id
     * comes back as "no such territory" rather than as a silent null that
     * quietly takes the property off every route.
     */
    if (input.territoryId) {
      const [territory] = await tx.select({ id: schema.territory.id })
        .from(schema.territory)
        .where(eq(schema.territory.id, input.territoryId)).limit(1);
      if (!territory) throw new NotFoundError("Territory");
    }

    const [after] = await tx.update(schema.property).set({
      ...(input.nickname !== undefined ? { nickname: input.nickname } : {}),
      ...(input.territoryId !== undefined ? { territoryId: input.territoryId } : {}),
      ...(input.squareFeet !== undefined ? { squareFeet: input.squareFeet } : {}),
      ...(input.yearBuilt !== undefined ? { yearBuilt: input.yearBuilt } : {}),
      ...(input.gateCode !== undefined ? { gateCode: input.gateCode } : {}),
      ...(input.accessNotes !== undefined ? { accessNotes: input.accessNotes } : {}),
      ...(input.hazardNotes !== undefined ? { hazardNotes: input.hazardNotes } : {}),
      ...(input.hasDog !== undefined ? { hasDog: input.hasDog } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.property.id, input.id)).returning();

    await audit(tx, ctx, "property.updated", "property", input.id, before, after!);
    return after!;
  });
}
