import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * THE PEOPLE AT A PROPERTY, WHICH NOTHING COULD CREATE
 *
 * `contact` was written in the first migrations and read in exactly one
 * place: `notifiableAddress` in dispatch, the function that decides whose
 * phone gets the "your technician is on the way" text. That function carries
 * a careful four way ranking with a comment explaining why the property's own
 * contact beats the customer's:
 *
 *   "On a rental the customer is the landlord and the person who opens the
 *   door is the tenant, and texting the landlord that somebody is fifteen
 *   minutes away helps nobody standing outside a house."
 *
 * Nothing ever inserted a contact. So the ranking always sorted an empty
 * list, always fell through to the customer's own number, and on every rental
 * the landlord got the text and the tenant did not. The code describing the
 * failure was the code producing it.
 *
 * A CONTACT HANGS OFF SOMETHING. Customer, property, or both, and at least
 * one: a contact attached to neither is invisible to the only query that
 * reads this table, so it would sit in the database looking like somebody who
 * would be told.
 *
 * ONE PRIMARY, ENFORCED ON WRITE. `isPrimary` is a term in that ranking, so
 * two primaries on one customer means the recipient of a text is decided by
 * whichever row the index happened to return. Promoting one demotes the rest
 * in the same transaction.
 */

/**
 * How they would rather hear from us, which orders the ranking rather than
 * filtering it. Someone who prefers email is still worth texting when they
 * are the only person attached to the property.
 */
export const CHANNELS = ["sms", "email", "voice"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ContactInput {
  name: string;
  customerId?: string | null | undefined;
  propertyId?: string | null | undefined;
  title?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  preferredChannel?: Channel | undefined;
  isPrimary?: boolean | undefined;
}

function normalise(input: ContactInput) {
  const name = input.name.trim();
  const phone = (input.phone ?? "").trim();
  const email = (input.email ?? "").trim();
  const channel = input.preferredChannel ?? "sms";

  if (name === "") throw new ConflictError("A contact needs a name.");
  if (!input.customerId && !input.propertyId) {
    throw new ConflictError(
      "A contact has to belong to a customer or a property. One attached to neither is never found "
      + "when we work out who to tell that a technician is on the way.",
    );
  }
  if (phone === "" && email === "") {
    throw new ConflictError(
      "A contact needs a phone number or an email address. Without one there is no way to reach them, "
      + "which is the whole of what a contact is for.",
    );
  }
  if (!(CHANNELS as readonly string[]).includes(channel)) {
    throw new ConflictError(
      `"${channel}" is not a channel this product sends on. One of: ${CHANNELS.join(", ")}.`,
    );
  }
  /**
   * Preferring a channel you cannot be reached on is a preference that makes
   * the ranking rank somebody unreachable above somebody reachable. Refused
   * here rather than quietly corrected, because the correction would be a
   * guess about which of the two facts is the typo.
   */
  if (channel === "sms" && phone === "") {
    throw new ConflictError("They prefer texts and have no phone number on them.");
  }
  if (channel === "email" && email === "") {
    throw new ConflictError("They prefer email and have no email address on them.");
  }

  return { name, phone, email, channel };
}

async function assertSubjects(
  tx: Database,
  input: { customerId?: string | null | undefined; propertyId?: string | null | undefined },
) {
  if (input.customerId) {
    const [row] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(eq(schema.customer.id, input.customerId), isNull(schema.customer.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundError("Customer");
  }
  if (input.propertyId) {
    const [row] = await tx.select({ id: schema.property.id }).from(schema.property)
      .where(and(eq(schema.property.id, input.propertyId), isNull(schema.property.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundError("Property");
  }
}

/**
 * Demote every other primary for the same subject.
 *
 * Scoped to the customer AND to the property separately, because a contact
 * can carry both and the two are different questions: the primary person for
 * this landlord, and the primary person at this address. Demoting across one
 * scope only would leave the other with two.
 */
async function demoteOthers(
  tx: Database,
  organizationId: string,
  keep: string,
  subject: { customerId?: string | null | undefined; propertyId?: string | null | undefined },
) {
  const scopes = [
    subject.customerId ? eq(schema.contact.customerId, subject.customerId) : null,
    subject.propertyId ? eq(schema.contact.propertyId, subject.propertyId) : null,
  ].filter((clause): clause is NonNullable<typeof clause> => clause !== null);
  if (scopes.length === 0) return;

  await tx.update(schema.contact)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(and(
      eq(schema.contact.organizationId, organizationId),
      ne(schema.contact.id, keep),
      eq(schema.contact.isPrimary, true),
      isNull(schema.contact.deletedAt),
      scopes.length === 1 ? scopes[0]! : or(...scopes),
    ));
}

export async function create(ctx: ServiceContext, input: ContactInput) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const { name, phone, email, channel } = normalise(input);
    await assertSubjects(tx, input);

    const [row] = await tx.insert(schema.contact).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.customerId ?? null,
      propertyId: input.propertyId ?? null,
      name,
      title: input.title?.trim() || null,
      email: email || null,
      phone: phone || null,
      preferredChannel: channel,
      isPrimary: input.isPrimary ?? false,
    }).returning();

    if (row!.isPrimary) {
      await demoteOthers(tx, ctx.actor.organizationId, row!.id, {
        customerId: row!.customerId, propertyId: row!.propertyId,
      });
    }

    await audit(tx, ctx, "contact.created", "contact", row!.id, null, row!);
    return shape(row!);
  });
}

export async function update(
  ctx: ServiceContext,
  /**
   * `name` is optional here and required on create, because this is a patch:
   * a button that means "make this one primary" should not have to send the
   * name back, and a form that does send it back is a form that can overwrite
   * a fresh name with a stale one.
   */
  input: Partial<ContactInput> & { id: string },
) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const [before] = await tx.select().from(schema.contact)
      .where(and(
        eq(schema.contact.id, input.id),
        eq(schema.contact.organizationId, ctx.actor.organizationId),
        isNull(schema.contact.deletedAt),
      )).limit(1);
    if (!before) throw new NotFoundError("Contact");

    /**
     * Validated against the MERGED row, not the patch. A patch that clears
     * the phone number on somebody who prefers texts is only visibly wrong
     * once you look at what the row becomes, and checking the patch alone is
     * how a guard passes every field it was given and still leaves the record
     * in the state it exists to prevent.
     */
    const merged: ContactInput = {
      name: input.name ?? before.name,
      customerId: input.customerId !== undefined ? input.customerId : before.customerId,
      propertyId: input.propertyId !== undefined ? input.propertyId : before.propertyId,
      title: input.title !== undefined ? input.title : before.title,
      email: input.email !== undefined ? input.email : before.email,
      phone: input.phone !== undefined ? input.phone : before.phone,
      preferredChannel: input.preferredChannel ?? (before.preferredChannel as Channel),
      isPrimary: input.isPrimary ?? before.isPrimary,
    };
    const { name, phone, email, channel } = normalise(merged);
    await assertSubjects(tx, merged);

    const [after] = await tx.update(schema.contact).set({
      customerId: merged.customerId ?? null,
      propertyId: merged.propertyId ?? null,
      name,
      title: merged.title?.trim() || null,
      email: email || null,
      phone: phone || null,
      preferredChannel: channel,
      isPrimary: merged.isPrimary ?? false,
      updatedAt: new Date(),
    }).where(eq(schema.contact.id, input.id)).returning();

    if (after!.isPrimary) {
      await demoteOthers(tx, ctx.actor.organizationId, after!.id, {
        customerId: after!.customerId, propertyId: after!.propertyId,
      });
    }

    await audit(tx, ctx, "contact.updated", "contact", input.id, before, after!);
    return shape(after!);
  });
}

/**
 * Take somebody off, without losing that they were on.
 *
 * Soft, because an old text went to this person and a hard delete makes that
 * message's recipient unresolvable. The tenant moved out; the message you
 * sent them in March still happened.
 */
export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const [before] = await tx.select().from(schema.contact)
      .where(and(
        eq(schema.contact.id, input.id),
        eq(schema.contact.organizationId, ctx.actor.organizationId),
        isNull(schema.contact.deletedAt),
      )).limit(1);
    if (!before) throw new NotFoundError("Contact");

    const [after] = await tx.update(schema.contact)
      .set({ deletedAt: new Date(), isPrimary: false, updatedAt: new Date() })
      .where(eq(schema.contact.id, input.id))
      .returning();

    await audit(tx, ctx, "contact.removed", "contact", input.id, before, after!);
    return { id: input.id, removed: true as const };
  });
}

/**
 * Everybody attached to a customer or a property.
 *
 * Ordered the way the notice ranking orders them, so the top of this list is
 * the person who would actually be texted. A list sorted by name would be
 * tidier and would not answer the question people open it with.
 */
export async function list(
  ctx: ServiceContext,
  input: { customerId?: string | undefined; propertyId?: string | undefined },
) {
  return guardedRead(ctx, "customer:read", async (tx) => {
    const scopes = [
      input.customerId ? eq(schema.contact.customerId, input.customerId) : null,
      input.propertyId ? eq(schema.contact.propertyId, input.propertyId) : null,
    ].filter((clause): clause is NonNullable<typeof clause> => clause !== null);
    if (scopes.length === 0) {
      throw new ConflictError("Name a customer or a property. Every contact belongs to one.");
    }

    const rows = await tx.select().from(schema.contact)
      .where(and(
        eq(schema.contact.organizationId, ctx.actor.organizationId),
        isNull(schema.contact.deletedAt),
        scopes.length === 1 ? scopes[0]! : or(...scopes),
      ))
      .orderBy(asc(schema.contact.name));

    return rows
      .map((row) => ({
        ...shape(row),
        /**
         * The same ordering dispatch uses, computed here rather than
         * reimplemented: property before customer, primary before not,
         * preferred channel last. Shown so the screen can say who gets the
         * text instead of leaving somebody to work it out.
         */
        noticeRank:
          (input.propertyId && row.propertyId === input.propertyId ? 0 : 4)
          + (row.isPrimary ? 0 : 2)
          + (row.preferredChannel === "sms" ? 0 : 1),
      }))
      .sort((a, b) => a.noticeRank - b.noticeRank || a.name.localeCompare(b.name));
  });
}

function shape(row: typeof schema.contact.$inferSelect) {
  return {
    id: row.id,
    customerId: row.customerId,
    propertyId: row.propertyId,
    name: row.name,
    title: row.title,
    email: row.email,
    phone: row.phone,
    preferredChannel: row.preferredChannel,
    isPrimary: row.isPrimary,
  };
}
