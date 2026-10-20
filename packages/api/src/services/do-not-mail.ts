import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { directMail as dm } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";

/**
 * THE DO NOT MAIL LIST
 *
 * Who must never be posted to, whatever mailing they are in. The rules for
 * comparing addresses and for the words a stopped piece carries are core's
 * (`directMail.addressKeys`, `doNotMailEntryFor`, `doNotMailWords`); this is
 * the list itself and the one place the mailing reads it from.
 *
 * TWO KINDS OF ENTRY. A customer is listed with their address as it stands
 * (the house the work is at, else the billing address): they are then never
 * mailed wherever they move to, and nobody else at the address they were
 * listed at is either, because the same household is so often two customer
 * records. An address is typed in with no customer at all and holds whoever
 * lives there. Taking a name off is a soft delete, so the page can say who took
 * it off and when; putting it back is a new entry.
 */

const MAX_REASON = 200;

type Row = typeof schema.doNotMail.$inferSelect;

/** An address as the list reads it back: one line. */
const lineOf = (row: Pick<Row, "addressLine1" | "addressLine2" | "city" | "state" | "postalCode">): string | null => {
  const text = [row.addressLine1, row.addressLine2, row.city, row.state, row.postalCode].filter(Boolean).join(", ");
  return text === "" ? null : text;
};

const entryOf = (row: Row): dm.DoNotMailEntry => ({
  id: row.id, customerId: row.customerId, building: row.building, unit: row.unit, name: row.name, reason: row.reason,
});

/** Every live entry, as core compares them. Read by the mailing when it freezes and again before each batch. */
export async function entriesWithin(tx: Database, organizationId: string): Promise<dm.DoNotMailEntry[]> {
  const rows = await tx.select().from(schema.doNotMail).where(and(
    eq(schema.doNotMail.organizationId, organizationId), isNull(schema.doNotMail.deletedAt),
  ));
  return rows.map(entryOf);
}

/** The words for a piece an entry stops, with the address it would have gone to. */
export function wordsFor(hit: { entry: dm.DoNotMailEntry; by: "customer" | "address" }, address: dm.MailAddress): string {
  return dm.doNotMailWords(hit, [address.line1, address.city, address.state, address.postalCode].filter(Boolean).join(", "));
}

/**
 * Where a customer would be mailed: the house the work is at, else the billing
 * address, whichever can be posted to (the mailing makes the same choice), and
 * whatever there is of either when neither can.
 */
async function addressOf(tx: Database, customerId: string): Promise<dm.MailAddress & { name: string }> {
  const [row] = await tx.execute<{
    name: string;
    p_line1: string | null; p_line2: string | null; p_city: string | null; p_state: string | null; p_postal: string | null;
    b_line1: string | null; b_line2: string | null; b_city: string | null; b_state: string | null; b_postal: string | null;
  }>(sql`
    select c.name,
           p.address_line1 as p_line1, p.address_line2 as p_line2, p.city as p_city, p.state as p_state, p.postal_code as p_postal,
           c.billing_address_line1 as b_line1, c.billing_address_line2 as b_line2, c.billing_city as b_city,
           c.billing_state as b_state, c.billing_postal_code as b_postal
      from public.customer c
      left join lateral (
        select pr.* from public.customer_property cpr
          join public.property pr on pr.id = cpr.property_id
         where cpr.customer_id = c.id and pr.deleted_at is null
         order by cpr.is_primary desc, cpr.created_at asc
         limit 1
      ) p on true
     where c.id = ${customerId} and c.deleted_at is null`);
  if (!row) throw new NotFoundError("Customer");
  const property: dm.MailAddress = { name: row.name, line1: row.p_line1, line2: row.p_line2, city: row.p_city, state: row.p_state, postalCode: row.p_postal };
  const billing: dm.MailAddress = { name: row.name, line1: row.b_line1, line2: row.b_line2, city: row.b_city, state: row.b_state, postalCode: row.b_postal };
  const use = dm.checkAddress(property).ok || !dm.checkAddress(billing).ok && row.p_line1 !== null ? property : billing;
  return { ...use, name: row.name };
}

export interface DoNotMailInput {
  /** A customer to list. Give this or `address`, not both. */
  customerId?: string | undefined;
  /** An address to list, for somebody who is not a customer here. */
  address?: {
    name?: string | undefined;
    line1: string; line2?: string | undefined; city: string; state: string; postalCode: string;
  } | undefined;
  /** Why, in the words of whoever is adding it. Printed on every piece it stops. */
  reason?: string | undefined;
}

/**
 * `customer:write`, not `campaign:write`: whoever takes the call from a customer
 * who wants the postcards to stop (the office, the front desk) must be able to
 * put it on the list, and putting a name on it only ever stops mail. Taking one
 * off, which lets mail go, is `campaign:write` like sending a mailing is.
 */
export async function add(ctx: ServiceContext, input: DoNotMailInput) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const again = await replayed<ReturnType<typeof present>>(tx, ctx, "do_not_mail");
    if (again) return again;
    const org = ctx.actor.organizationId;

    const reason = input.reason?.trim() ? input.reason.trim().slice(0, MAX_REASON) : null;
    if (input.reason && input.reason.trim().length > MAX_REASON) {
      throw new ConflictError(`Keep the reason to ${MAX_REASON} characters: it is printed on every piece it stops.`);
    }
    if ((input.customerId === undefined) === (input.address === undefined)) {
      throw new ConflictError("Say who to leave off the list: a customer, or an address, not both and not neither.");
    }

    let values: Omit<typeof schema.doNotMail.$inferInsert, "organizationId">;
    if (input.customerId) {
      const address = await addressOf(tx, input.customerId);
      const keys = dm.addressKeys(address);
      values = {
        customerId: input.customerId, name: address.name,
        addressLine1: address.line1, addressLine2: address.line2, city: address.city, state: address.state, postalCode: address.postalCode,
        building: keys?.building ?? null, unit: keys?.unit ?? "",
        reason, addedByUserId: ctx.actor.userId,
      };
    } else {
      const typed = input.address!;
      const mailable: dm.MailAddress = {
        name: typed.name ?? "", line1: typed.line1.trim(), line2: typed.line2?.trim() || null,
        city: typed.city.trim(), state: typed.state.trim().toUpperCase(), postalCode: typed.postalCode.trim(),
      };
      const keys = dm.addressKeys(mailable);
      if (!keys) {
        throw new ConflictError("Give the street, the town, the two letter state and the ZIP code. Without all four there is no telling whether a card is going to this address.");
      }
      values = {
        customerId: null, name: typed.name?.trim() || null,
        addressLine1: mailable.line1, addressLine2: mailable.line2, city: mailable.city, state: mailable.state, postalCode: mailable.postalCode,
        building: keys.building, unit: keys.unit,
        reason, addedByUserId: ctx.actor.userId,
      };
    }

    const [clash] = await tx.select({ id: schema.doNotMail.id }).from(schema.doNotMail).where(and(
      eq(schema.doNotMail.organizationId, org), isNull(schema.doNotMail.deletedAt),
      input.customerId
        ? eq(schema.doNotMail.customerId, input.customerId)
        : and(
          isNull(schema.doNotMail.customerId),
          eq(schema.doNotMail.building, values.building!), eq(schema.doNotMail.unit, values.unit!),
        ),
    )).limit(1);
    if (clash) {
      throw new ConflictError(input.customerId
        ? `${values.name} is already on your do not mail list.`
        : `${lineOf(values as Row)} is already on your do not mail list.`);
    }

    const [row] = await tx.insert(schema.doNotMail).values({
      organizationId: org,
      customerId: values.customerId ?? null,
      name: values.name ?? null,
      addressLine1: values.addressLine1 ?? null,
      addressLine2: values.addressLine2 ?? null,
      city: values.city ?? null,
      state: values.state ?? null,
      postalCode: values.postalCode ?? null,
      building: values.building ?? null,
      unit: values.unit ?? "",
      reason: values.reason ?? null,
      addedByUserId: ctx.actor.userId,
    }).returning();
    await audit(tx, ctx, "do_not_mail.added", "do_not_mail", row!.id, null, {
      customerId: row!.customerId, address: lineOf(row!), reason: row!.reason,
    });
    const answer = present(row!, row!.name);
    await remember(tx, ctx, "do_not_mail", row!.id, answer);
    return answer;
  });
}

function present(row: Row, customerName: string | null) {
  return {
    id: row.id,
    kind: row.customerId ? "customer" as const : "address" as const,
    customerId: row.customerId,
    customerName,
    name: row.name,
    address: lineOf(row),
    unit: row.unit,
    reason: row.reason,
    addedOn: row.createdAt.toISOString(),
  };
}

/**
 * The list, newest first. With a customer, only what stops that customer: an
 * entry for them, or for the address they would be mailed at, so the customer's
 * own page can say they are listed and why.
 */
export async function list(ctx: ServiceContext, input: { customerId?: string | undefined } = {}) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    const org = ctx.actor.organizationId;
    const rows = await tx.select({ row: schema.doNotMail, customerName: schema.customer.name })
      .from(schema.doNotMail)
      .leftJoin(schema.customer, eq(schema.customer.id, schema.doNotMail.customerId))
      .where(and(eq(schema.doNotMail.organizationId, org), isNull(schema.doNotMail.deletedAt)))
      .orderBy(desc(schema.doNotMail.createdAt)).limit(1000);
    if (!input.customerId) return rows.map((r) => present(r.row, r.customerName ?? r.row.name));

    const address = await addressOf(tx, input.customerId);
    const stops = (entry: dm.DoNotMailEntry) => dm.doNotMailEntryFor([entry], { customerId: input.customerId!, address }) !== null;
    return rows.filter((r) => stops(entryOf(r.row))).map((r) => present(r.row, r.customerName ?? r.row.name));
  });
}

/** Taken off the list. The name is kept on the row, with who took it off and when, and a mailing not yet posted no longer skips them. */
export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const [row] = await tx.select().from(schema.doNotMail).where(and(
      eq(schema.doNotMail.id, input.id), eq(schema.doNotMail.organizationId, ctx.actor.organizationId),
    )).limit(1);
    if (!row) throw new NotFoundError("Do not mail entry");
    /** A retry of a removal that went through is answered, not refused. */
    if (row.deletedAt) return { id: row.id, removed: true as const };
    await tx.update(schema.doNotMail).set({ deletedAt: new Date(), removedByUserId: ctx.actor.userId, updatedAt: new Date() })
      .where(eq(schema.doNotMail.id, row.id));
    await audit(tx, ctx, "do_not_mail.removed", "do_not_mail", row.id, {
      customerId: row.customerId, address: lineOf(row), reason: row.reason,
    }, null);
    return { id: row.id, removed: true as const };
  });
}

export const handlers = {
  listDoNotMail: async (ctx: ServiceContext, input: { customerId?: string | undefined }) => ({ entries: await list(ctx, input) }),
  addDoNotMail: (ctx: ServiceContext, input: DoNotMailInput) => add(ctx, input),
  removeDoNotMail: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
} as const;
