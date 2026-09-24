import { and, asc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { marketing as mk } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * THE NUMBERS A COMPANY CONTROLS
 *
 * Two columns on `phone_number` were read and written by nothing.
 *
 * `attribution_source` is what turns a number into a tracking number: the
 * marketing module maps an inbound call's destination to a lead source
 * through it. Nothing could set it, so the map was always empty and every
 * call resolved to `unknown`. A company running four tracking numbers got a
 * report saying every call came from nowhere.
 *
 * `released_at` is the other half. Every send filters on it and nothing
 * could set it, so a number handed back to the carrier stayed a number this
 * product would happily send from. The carrier reassigns it within weeks,
 * and the texts then go out from somebody else's phone number.
 *
 * WHICH NUMBER A TEXT COMES FROM IS A DECISION, and it was "whichever was
 * created last". That was harmless only while tracking numbers could not
 * exist. The moment they can, the newest registered number is often a
 * tracking number, and sending from one poisons the measurement it exists
 * for: the customer replies, the reply arrives on the campaign number, and
 * the campaign is credited with a lead that is a reply to our own text.
 * `senderFor` below is the rule, in one place, used by both senders.
 */

export const PURPOSES = ["main", "tracking", "user", "sending", "fax"] as const;
export type Purpose = (typeof PURPOSES)[number];

/**
 * What we will send a conversational text from, best first.
 *
 * `main` is the number on the truck and the invoice, which is the one a
 * customer recognises and the one they should be replying to. `sending` is a
 * pool built for outbound. `user` is a person's own line, which works and is
 * a worse default than the company's.
 *
 * `tracking` and `fax` are absent on purpose rather than ranked last:
 * ranking them last still picks one when it is all there is, and a text from
 * a tracking number is worse than no text, because it silently corrupts the
 * attribution report somebody makes spending decisions from.
 */
const SEND_ORDER: Purpose[] = ["main", "sending", "user"];

export async function senderFor(
  tx: Database,
  organizationId: string,
  input: { smsRequired: boolean },
) {
  const rows = await tx.select().from(schema.phoneNumber)
    .where(and(
      eq(schema.phoneNumber.organizationId, organizationId),
      isNull(schema.phoneNumber.releasedAt),
      ...(input.smsRequired ? [eq(schema.phoneNumber.smsRegistered, true)] : []),
    ))
    /**
     * Oldest first within a purpose, not newest. A company's main number is
     * the one they have had for eleven years; buying a second main number
     * should not silently change what every customer sees a text from.
     */
    .orderBy(asc(schema.phoneNumber.createdAt));

  const eligible = rows.filter((row) => SEND_ORDER.includes(row.purpose as Purpose));
  eligible.sort((a, b) =>
    SEND_ORDER.indexOf(a.purpose as Purpose) - SEND_ORDER.indexOf(b.purpose as Purpose));
  return eligible[0];
}

/* ------------------------------------------------------------- the table */

export interface NumberInput {
  e164: string;
  purpose?: Purpose | undefined;
  label?: string | null | undefined;
  /** Only meaningful on a tracking number. Validated against the lead source list. */
  attributionSource?: string | null | undefined;
  forwardsToE164?: string | null | undefined;
  smsRegistered?: boolean | undefined;
}

const E164 = /^\+[1-9]\d{6,14}$/;

function validate(input: NumberInput) {
  const e164 = input.e164.trim();
  if (!E164.test(e164)) {
    throw new ConflictError(
      `"${input.e164}" is not an E.164 number. It needs a plus and a country code: +15125550123.`,
    );
  }
  const purpose = input.purpose ?? "main";
  if (!(PURPOSES as readonly string[]).includes(purpose)) {
    throw new ConflictError(
      `"${purpose}" is not something a number can be for. One of: ${PURPOSES.join(", ")}.`,
    );
  }

  const source = input.attributionSource?.trim() || null;
  if (source !== null) {
    /**
     * VALIDATED HERE, not only where it is read.
     *
     * The marketing module already ignores a value it does not recognise, so
     * a typo could not corrupt a report. What it could do is nothing at all:
     * somebody types "spring mailer", the field saves, the screen shows it,
     * and the number is silently not a tracking number. Refusing at the
     * write is the difference between a mistake somebody is told about and
     * a measurement that quietly never starts.
     */
    if (!(mk.LEAD_SOURCE_KEYS as readonly string[]).includes(source)) {
      throw new ConflictError(
        `"${source}" is not a lead source this product reports on, so a call to this number would `
        + "attribute to nothing. Pick one of the sources on the marketing screen.",
      );
    }
    if (purpose !== "tracking") {
      /**
       * A source on a main number reads as attribution and is not: the
       * attribution map is only consulted for the number a call arrived on,
       * and every call to the main number is the main number.
       */
      throw new ConflictError(
        "Only a tracking number attributes calls. Set this number's purpose to tracking, or clear the source.",
      );
    }
  }

  if (purpose === "tracking" && source === null) {
    /**
     * A tracking number with nothing to attribute to is the state the
     * marketing module describes as "a measurement nobody set up". Refused
     * at the point somebody is looking at the form, rather than discovered
     * in a report three months later showing every call as unknown.
     */
    throw new ConflictError(
      "A tracking number needs a lead source, or it measures nothing and every call to it reports as unknown.",
    );
  }

  return { e164, purpose, source };
}

export async function add(ctx: ServiceContext, input: NumberInput) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const { e164, purpose, source } = validate(input);

    const [existing] = await tx.select({ id: schema.phoneNumber.id })
      .from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.organizationId, ctx.actor.organizationId),
        eq(schema.phoneNumber.e164, e164),
        isNull(schema.phoneNumber.releasedAt),
      )).limit(1);
    if (existing) throw new ConflictError("That number is already on file.");

    const [row] = await tx.insert(schema.phoneNumber).values({
      organizationId: ctx.actor.organizationId,
      e164,
      purpose,
      label: input.label?.trim() || null,
      attributionSource: source,
      forwardsToE164: input.forwardsToE164?.trim() || null,
      smsRegistered: input.smsRegistered ?? false,
    }).returning();

    await audit(tx, ctx, "phone_number.added", "phone_number", row!.id, null, row!);
    return shape(row!);
  });
}

export async function update(
  ctx: ServiceContext,
  input: Partial<NumberInput> & { id: string },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);

    /**
     * Merged before validating, for the same reason contacts are: clearing
     * the source on a tracking number is unremarkable as a patch and leaves
     * a number that measures nothing, which is the state the rules above
     * exist to refuse.
     */
    const merged: NumberInput = {
      e164: input.e164 ?? before.e164,
      purpose: input.purpose ?? (before.purpose as Purpose),
      label: input.label !== undefined ? input.label : before.label,
      attributionSource: input.attributionSource !== undefined
        ? input.attributionSource : before.attributionSource,
      forwardsToE164: input.forwardsToE164 !== undefined
        ? input.forwardsToE164 : before.forwardsToE164,
      smsRegistered: input.smsRegistered ?? before.smsRegistered,
    };
    const { e164, purpose, source } = validate(merged);

    const [after] = await tx.update(schema.phoneNumber).set({
      e164,
      purpose,
      label: merged.label?.trim() || null,
      attributionSource: source,
      forwardsToE164: merged.forwardsToE164?.trim() || null,
      smsRegistered: merged.smsRegistered ?? false,
      updatedAt: new Date(),
    }).where(eq(schema.phoneNumber.id, input.id)).returning();

    await audit(tx, ctx, "phone_number.updated", "phone_number", input.id, before, after!);
    return shape(after!);
  });
}

/**
 * Hand it back to the carrier.
 *
 * Stamped rather than deleted, which the schema comment has always said and
 * nothing could do: a released number is reassigned to somebody else within
 * weeks, and a call from 2023 still has to say which campaign it arrived on.
 * Deleting the row would re-attribute years of history to whoever holds the
 * number next.
 *
 * Releasing the last number you can send from is ALLOWED and reported. A
 * company leaving a provider releases everything, and a product that refuses
 * the last one makes them edit the database. What it must not do is let that
 * happen silently: from that moment every text is refused with
 * `channel_not_registered`, and finding that out from a customer is worse
 * than being told here.
 */
export async function release(ctx: ServiceContext, input: { id: string; reason?: string }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    if (before.releasedAt) throw new ConflictError("That number is already released.");

    const [after] = await tx.update(schema.phoneNumber)
      .set({ releasedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.phoneNumber.id, input.id))
      .returning();

    const sender = await senderFor(tx, ctx.actor.organizationId, { smsRequired: true });

    await audit(tx, ctx, "phone_number.released", "phone_number", input.id, before, after!);
    return {
      id: input.id,
      released: true as const,
      /** Null means nothing can be texted from any more, which is worth saying. */
      nowSendingFrom: sender?.e164 ?? null,
      reason: input.reason?.trim() || null,
    };
  });
}

export async function list(ctx: ServiceContext, input: { includeReleased?: boolean } = {}) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.organizationId, ctx.actor.organizationId),
        ...(input.includeReleased ? [] : [isNull(schema.phoneNumber.releasedAt)]),
      ))
      .orderBy(asc(schema.phoneNumber.createdAt));

    const sender = await senderFor(tx, ctx.actor.organizationId, { smsRequired: true });

    return rows.map((row) => ({
      ...shape(row),
      /**
       * Which one texts come from, marked on the row. It is a consequence of
       * purpose, registration and age, and nobody works that out by looking
       * at three columns.
       */
      isSender: row.id === sender?.id,
    }));
  });
}

/**
 * A CORRELATED SUBQUERY HAS TO NAME ITS TABLES, and drizzle will not do it.
 *
 * Interpolating a column into a `sql` fragment renders the BARE name:
 * `${schema.call.phoneNumberId}` becomes `"phone_number_id"`, not
 * `"call"."phone_number_id"`. Inside a subquery both sides then resolve
 * against the inner table, so `${schema.call.phoneNumberId} = ${schema.phoneNumber.id}`
 * renders as `"phone_number_id" = "id"`, which Postgres reads as
 * `call.phone_number_id = call.id`.
 *
 * That is valid SQL, runs without a warning, and is never true. The count
 * comes back zero for every row, which reads as "this tracking number has
 * taken no calls" rather than as a broken query. Written out with explicit
 * identifiers so it says what it means.
 */
/** How many calls each tracking number has actually brought in, so a dead one is visible. */
export async function trackingUsage(ctx: ServiceContext, input: { since?: Date } = {}) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    /**
     * As an ISO string with an explicit cast, because this goes into a
     * correlated subquery rather than through a column comparison, and a
     * JavaScript Date has no binding there.
     */
    const since = (input.since ?? new Date(Date.now() - 90 * 86_400_000)).toISOString();

    const rows = await tx.select({
      id: schema.phoneNumber.id,
      e164: schema.phoneNumber.e164,
      label: schema.phoneNumber.label,
      source: schema.phoneNumber.attributionSource,
      calls: sql<number>`(
        select count(*)::int from "call" c
        where c.phone_number_id = "phone_number"."id"
          and c.direction = 'inbound'
          and c.created_at >= ${since}::timestamptz
      )`,
    }).from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.organizationId, ctx.actor.organizationId),
        isNull(schema.phoneNumber.releasedAt),
        isNotNull(schema.phoneNumber.attributionSource),
      ))
      .orderBy(asc(schema.phoneNumber.createdAt));

    return rows;
  });
}

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.phoneNumber)
    .where(and(
      eq(schema.phoneNumber.id, id),
      eq(schema.phoneNumber.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Phone number");
  return row;
}

function shape(row: typeof schema.phoneNumber.$inferSelect) {
  return {
    id: row.id,
    e164: row.e164,
    label: row.label,
    purpose: row.purpose,
    attributionSource: row.attributionSource,
    forwardsToE164: row.forwardsToE164,
    smsRegistered: row.smsRegistered,
    releasedAt: row.releasedAt?.toISOString() ?? null,
  };
}
