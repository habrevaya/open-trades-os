import { and, eq, desc, lt, or, ilike, isNull, inArray, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { assertCan, tags as tagRules } from "@opentradesos/core";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean, cleanAll,
  decodeCursor, paginate, NotFoundError, ConflictError, scopeOf, audit,
} from "./context";
import { enforceWithin } from "./custom-fields";
import { assertUnclaimed, byExternal, provenance } from "./provenance";
import { customerScopeFilter } from "./scope";
import * as acquisition from "./acquisition";
import * as marketing from "./marketing";
import type { CustomerCreate, listCustomers, getCustomer, updateCustomer } from "../contracts/customers";

type ListInput = z.infer<typeof listCustomers.input>;
type CreateInput = z.infer<typeof CustomerCreate>;

/**
 * The row as the contract publishes it.
 *
 * The contract has promised a nested `billingAddress` and a numeric
 * `paymentTermsDays` since it was written, and the service returned the flat
 * columns and the numeric column's string, so every generated client read an
 * address that was always undefined and a number that was a string. The
 * flat columns stay alongside, for the screens that read them.
 */
function asCustomer<T extends Record<string, unknown>>(row: T) {
  const parts = {
    line1: row["billingAddressLine1"], line2: row["billingAddressLine2"], city: row["billingCity"],
    state: row["billingState"], postalCode: row["billingPostalCode"], country: row["billingCountry"],
  } as Record<string, string | null | undefined>;
  const present = ["line1", "city", "state", "postalCode"].some((k) => parts[k] != null);
  return {
    ...row,
    ...("paymentTermsDays" in row ? { paymentTermsDays: Number(row["paymentTermsDays"]) } : {}),
    billingAddress: present
      ? Object.fromEntries(Object.entries(parts).filter(([, v]) => v != null)) as Record<string, string>
      : null,
  };
}

/**
 * The customers carrying some or all of these tags.
 *
 * `tag` was on the contract from the start and nothing read it, so a caller
 * filtering by a tag got the whole book back and no sign anything was wrong.
 * Compared without case through the same key `core/tags` uses, so "vip"
 * finds the customers tagged "VIP".
 *
 * NO INDEX SERVES THIS, and that is a choice rather than an oversight. A GIN
 * index on `tags` answers exact spellings only, and the whole point of the
 * comparison is that the spelling may differ; the case blind check reads each
 * customer's short list, which for a company of ten thousand customers is a
 * few milliseconds. A book far larger than that wants a normalised tag table,
 * and the docs say so.
 */
function tagFilter(input: ListInput) {
  const wanted = [...(input.tags ?? []), ...(input.tag ? [input.tag] : [])]
    .map(tagRules.tagKey)
    .filter((key) => key !== "");
  if (wanted.length === 0) return undefined;
  const keys = sql`${sql.param([...new Set(wanted)])}::text[]`;
  const held = sql`(select coalesce(array_agg(lower(btrim(t.tag))), '{}') from jsonb_array_elements_text(${schema.customer.tags}) as t(tag))`;
  return input.tagMatch === "all" ? sql`${held} @> ${keys}` : sql`${held} && ${keys}`;
}

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
      byExternal(schema.customer, input),
      // Trigram search across the three things a CSR actually types while
      // somebody is on the phone. A pg_trgm index backs each of them.
      input.q
        ? or(
            ilike(schema.customer.name, `%${input.q}%`),
            ilike(schema.customer.email, `%${input.q}%`),
            ilike(schema.customer.phone, `%${input.q}%`),
          )
        : undefined,
      tagFilter(input),
      cursor ? lt(schema.customer.createdAt, new Date(cursor)) : undefined,
    );

    // One extra row tells us whether another page exists without a count(*),
    // which on a large table is the difference between fast and unusable.
    const rows = await tx.select().from(schema.customer)
      .where(where)
      .orderBy(desc(schema.customer.createdAt))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.createdAt.toISOString());
    return { ...page, data: cleanAll(ctx, "customer", page.data).map(asCustomer) };
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
    return asCustomer(clean(ctx, "customer", { ...row, balance: owed?.total ?? "0" }));
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
        if (existing) return asCustomer(clean(ctx, "customer", existing));
      }
    }

    await enforceWithin(
      tx, ctx.actor.organizationId, "customer", input.customFields,
    );
    await assertUnclaimed(tx, "customer", input.externalRef);

    /**
     * WHERE THEY CAME FROM, checked against the channel list. A key, a
     * channel or a tracking campaign are each enough; a word nothing can
     * place is refused, which is the whole reason this stopped being a text
     * box three people type differently. A customer arriving from another
     * system keeps whatever its old system said.
     */
    const imported = input.externalRef !== undefined;
    const { declared, verbatim } = await acquisition.declaredOrVerbatim(tx, ctx.actor.organizationId, {
      leadSource: input.leadSource, channelId: input.channelId, campaignId: input.campaignId,
    }, imported);

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
      leadSource: declared?.sourceKey ?? verbatim,
      leadSourceOrigin: declared ? (imported ? "imported" : "manual") : verbatim ? "imported" : null,
      channelId: declared?.channelId ?? null,
      acquisitionCampaignId: declared?.campaignId ?? null,
      paymentTermsDays: String(input.paymentTermsDays),
      taxExempt: input.taxExempt,
      tags: input.tags,
      customFields: input.customFields,
      ...provenance(input.externalRef),
    }).returning();

    /**
     * The first property goes in the same transaction on purpose. Splitting
     * it into a second call guarantees orphaned customers whenever the second
     * one fails, and somebody discovers them a year later.
     */
    if (input.property) {
      await enforceWithin(
        tx, ctx.actor.organizationId, "property", input.property.customFields ?? {}, undefined,
        "property.customFields",
      );
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
        customFields: input.property.customFields ?? {},
      }).returning({ id: schema.property.id });

      await tx.insert(schema.customerProperty).values({
        organizationId: ctx.actor.organizationId,
        customerId: customer!.id,
        propertyId: property!.id,
        role: "owner",
        isPrimary: true,
      });
    }

    /**
     * The calls they made before anybody knew who they were become theirs,
     * matched on the number normalised to E.164. Then the source: theirs
     * when somebody chose one, as a declared touch the reports can weigh;
     * otherwise derived from what was just stitched, and marked so.
     */
    await marketing.identifyCaller(tx, ctx.actor.organizationId, {
      phone: customer!.phone, customerId: customer!.id,
    });
    if (declared && !imported) {
      await marketing.declareSource(tx, ctx.actor.organizationId, {
        declared, customerId: customer!.id, userId: ctx.actor.userId,
      });
    }
    const derived = declared || verbatim
      ? null
      : await marketing.deriveCustomerSource(tx, ctx.actor.organizationId, customer!.id);
    if (!derived) {
      await acquisition.assertLeadSourceGiven(
        tx, ctx.actor.organizationId, declared, "customer", imported,
      );
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

    const [saved] = await tx.select().from(schema.customer).where(eq(schema.customer.id, customer!.id)).limit(1);
    await audit(tx, ctx, "customer.created", "customer", customer!.id, null, saved!);
    return asCustomer(clean(ctx, "customer", saved!));
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
    if (input.customFields !== undefined) {
      await enforceWithin(
        tx, ctx.actor.organizationId, "customer", input.customFields, before.customFields,
      );
    }

    /**
     * A lead source changed by hand is checked against the channel list and
     * written as `manual`, and recorded as a declared touch so the change
     * reaches the reports rather than only the page. Clearing it (null)
     * clears the columns and records nothing: a blank is not evidence.
     */
    const changingSource = input.leadSource !== undefined || input.channelId !== undefined
      || input.campaignId !== undefined;
    const declared = changingSource
      ? await acquisition.resolveDeclared(tx, ctx.actor.organizationId, {
        leadSource: input.leadSource, channelId: input.channelId, campaignId: input.campaignId,
      })
      : null;
    const sourceColumns = !changingSource ? {} : declared
      ? {
        leadSource: declared.sourceKey, leadSourceOrigin: "manual",
        channelId: declared.channelId, acquisitionCampaignId: declared.campaignId,
      }
      : { leadSource: null, leadSourceOrigin: null, channelId: null, acquisitionCampaignId: null };

    const [after] = await tx.update(schema.customer).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...sourceColumns,
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

    if (declared) {
      await marketing.declareSource(tx, ctx.actor.organizationId, {
        declared, customerId: input.id, userId: ctx.actor.userId,
      });
    }
    /** A new phone number claims the calls already made from it. */
    if (input.phone !== undefined && input.phone !== before.phone) {
      await marketing.identifyCaller(tx, ctx.actor.organizationId, { phone: input.phone, customerId: input.id });
    }

    await audit(tx, ctx, "customer.updated", "customer", input.id, before, after!);
    return asCustomer(clean(ctx, "customer", after!));
  });
}

/** Defined in `context.ts`, beside the guard every caller of it is already inside. */
/**
 * `audit` IS NO LONGER RE-EXPORTED FROM HERE.
 *
 * It lives in `./context` and always has. This file re-exported it, and
 * thirty six services imported it from here rather than from where it is
 * defined, which meant every one of them pulled the whole customer service
 * and everything it imports into its own module graph to get one function.
 *
 * That is not only waste. It is the import cycle this codebase has tripped
 * over before: a service that `customers.ts` itself needs, importing
 * `audit` from `customers.ts`, is a cycle whose symptom is an undefined
 * function at module-evaluation time rather than a compile error.
 *
 * Nothing imports it from here now. The line is a comment rather than a
 * deletion so the next person who looks for it is told where it went.
 */
