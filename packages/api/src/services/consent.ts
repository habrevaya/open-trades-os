import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, ConflictError, type ServiceContext } from "./context";

/**
 * RECORDING CONSENT, WHICH NOTHING COULD DO
 *
 * `communication_consent` was written in the first migrations and read in
 * three places: the sending gate, the workflow sender, and the review
 * request's check for a revocation. Nothing inserted a row, ever.
 *
 * What that cost, precisely. `canSend` requires a `granted` row for anything
 * whose purpose is marketing, and nothing is ever implied there. So every
 * marketing message this product could send was refused with `no_consent`,
 * permanently, and the entire marketing module built on top of it could not
 * deliver one message. Transactional messages went out, because those are
 * implied by the work itself, which is why nobody noticed: the on my way text
 * arrived, and the campaign silently did not.
 *
 * The second half is worse and quieter. A revocation is a consent row too.
 * With no writer, "stop texting me about my appointments" could not be
 * recorded as anything: the STOP keyword writes a suppression, which is
 * carrier level and channel wide, but a customer who says it on the phone to
 * a dispatcher had nowhere for it to go. The system would keep texting them
 * and its own audit trail would say nothing was ever withdrawn.
 *
 * SUPERSEDING RATHER THAN UPDATING. A consent row is evidence, and evidence
 * is not edited. Granting or revoking stamps `superseded_at` on whatever was
 * current and inserts a new row, so the history reads as what was true when,
 * which is the only form in which it answers the question anybody asks of it:
 * were you allowed to send that, on that day.
 */

export type Channel = "sms" | "mms" | "voice" | "email" | "webchat";
export type Purpose = "transactional" | "marketing";
export type Method = "web_form" | "verbal" | "written" | "sms_reply" | "checkout" | "imported" | "api";

export const METHODS: readonly Method[] = [
  "web_form", "verbal", "written", "sms_reply", "checkout", "imported", "api",
];

export interface ConsentInput {
  address: string;
  channel: Channel;
  purpose: Purpose;
  method: Method;
  customerId?: string | null | undefined;
  contactId?: string | null | undefined;
  /** The exact wording presented or spoken. The part that is actually proof. */
  proofText?: string | null | undefined;
  /** Where it happened: a URL, a form id, a call recording id. */
  proofReference?: string | null | undefined;
  ipAddress?: string | null | undefined;
}

/**
 * Write a consent row, superseding whatever was current for the same address,
 * channel and purpose.
 *
 * Shared by grant and revoke because they differ in exactly one field, and
 * two copies of the supersede-then-insert dance is two places for the order
 * to be got wrong. Inserting before superseding would leave two current rows
 * for a moment, and `canSend` takes the most recent unsuperseded row: a
 * concurrent send in that window reads whichever one the index returned.
 */
export interface ConsentWriter {
  organizationId: string;
  /** Null for a caller with no user: the unsubscribe page has nobody signed in. */
  capturedByUserId: string | null;
}

/**
 * The supersede-then-insert, with no `ServiceContext` and no audit row.
 *
 * Split out for the one caller that has neither: the public unsubscribe page,
 * which runs with no session at all and cannot be given a fake one. The
 * alternative was a second copy of this dance over there, which is exactly
 * what the comment above warns about, and a withdrawn consent is the worst
 * place in this system for two writers to disagree about the order.
 */
export async function recordWithin(
  tx: Database,
  writer: ConsentWriter,
  input: ConsentInput,
  state: "granted" | "revoked",
) {
  if (input.address.trim() === "") {
    throw new ConflictError("Consent needs an address. There is nobody it is about otherwise.");
  }
  if (!METHODS.includes(input.method)) {
    throw new ConflictError(
      `"${input.method}" is not a way consent can be captured. One of: ${METHODS.join(", ")}.`,
    );
  }
  if (state === "granted" && !input.proofText && !input.proofReference) {
    throw new ConflictError(
      "A grant needs the wording that was used or a reference to where it happened. "
      + "A consent row with no proof on it is not evidence of anything.",
    );
  }

  const address = comms.phoneAddress(input.address);

  await tx.update(schema.communicationConsent)
    .set({ supersededAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(schema.communicationConsent.organizationId, writer.organizationId),
      eq(schema.communicationConsent.address, address),
      eq(schema.communicationConsent.channel, input.channel),
      eq(schema.communicationConsent.purpose, input.purpose),
      isNull(schema.communicationConsent.supersededAt),
    ));

  const [row] = await tx.insert(schema.communicationConsent).values({
    organizationId: writer.organizationId,
    customerId: input.customerId ?? null,
    contactId: input.contactId ?? null,
    address,
    channel: input.channel,
    purpose: input.purpose,
    state,
    method: input.method,
    proofText: input.proofText ?? null,
    proofReference: input.proofReference ?? null,
    capturedByUserId: writer.capturedByUserId,
    ipAddress: input.ipAddress ?? null,
  }).returning();

  return row!;
}

async function record(
  tx: Database,
  ctx: ServiceContext,
  input: ConsentInput,
  state: "granted" | "revoked",
) {
  /**
   * PROOF IS REQUIRED FOR A GRANT AND NOT FOR A REVOCATION, which is not an
   * oversight and is checked in `recordWithin`. A grant is the thing somebody
   * has to defend later, so it needs the wording or a reference to where it
   * happened. A revocation needs no defending: if a customer says stop and the
   * record is thin, the thin record is not the problem.
   */
  const row = await recordWithin(
    tx,
    { organizationId: ctx.actor.organizationId, capturedByUserId: ctx.actor.userId },
    input,
    state,
  );
  await audit(tx, ctx, `consent.${state}`, "communication_consent", row.id, null, row);
  return row;
}

export function grant(ctx: ServiceContext, input: ConsentInput) {
  return guardedWrite(ctx, "message:send", (tx) => record(tx, ctx, input, "granted"));
}

/**
 * Withdraw it.
 *
 * Takes the same shape as a grant rather than an id, because the person doing
 * this is on the phone with somebody saying "take me off your list" and does
 * not have a row id. Looking one up first would mean a revocation fails when
 * there was never a grant, and "we have no record of you consenting" is not a
 * reason to keep texting somebody who asked you not to.
 */
export function revoke(ctx: ServiceContext, input: ConsentInput) {
  return guardedWrite(ctx, "message:send", (tx) => record(tx, ctx, input, "revoked"));
}

/**
 * What is on record for an address, current first.
 *
 * The whole history, not only what is current, because the question this
 * answers is usually about a message that already went out: were we allowed
 * to send that, on that day. A list of current states cannot answer it.
 */
export async function history(ctx: ServiceContext, input: { address: string }) {
  return guardedRead(ctx, "message:read", async (tx) => {
    const rows = await tx.select().from(schema.communicationConsent)
      .where(and(
        eq(schema.communicationConsent.organizationId, ctx.actor.organizationId),
        eq(schema.communicationConsent.address, comms.phoneAddress(input.address)),
      ))
      .orderBy(desc(schema.communicationConsent.capturedAt));

    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      purpose: row.purpose,
      state: row.state,
      method: row.method,
      proofText: row.proofText,
      proofReference: row.proofReference,
      capturedAt: row.capturedAt.toISOString(),
      supersededAt: row.supersededAt?.toISOString() ?? null,
      /** True for the row that governs a send today. */
      current: row.supersededAt === null,
    }));
  });
}

/**
 * Whether a marketing message may go to this address right now, and why not.
 *
 * Asks `canSend` rather than reimplementing the rule, because the whole point
 * of that function living in core is that the office screen and the sender
 * cannot disagree about who may be contacted.
 */
export async function marketable(ctx: ServiceContext, input: { address: string }) {
  return guardedRead(ctx, "message:read", async (tx) => {
    const address = comms.phoneAddress(input.address);

    const consents = await tx.select().from(schema.communicationConsent)
      .where(and(
        eq(schema.communicationConsent.organizationId, ctx.actor.organizationId),
        eq(schema.communicationConsent.address, address),
        isNull(schema.communicationConsent.supersededAt),
      ));

    const suppressions = await tx.select().from(schema.suppression)
      .where(and(
        eq(schema.suppression.organizationId, ctx.actor.organizationId),
        eq(schema.suppression.address, address),
        isNull(schema.suppression.liftedAt),
      ));

    const [from] = await tx.select({ registered: schema.phoneNumber.smsRegistered })
      .from(schema.phoneNumber)
      .where(and(
        eq(schema.phoneNumber.organizationId, ctx.actor.organizationId),
        isNull(schema.phoneNumber.releasedAt),
        eq(schema.phoneNumber.smsRegistered, true),
      ))
      .limit(1);

    return comms.canSend({
      channel: "sms",
      purpose: "marketing",
      consents: consents.map((c) => ({
        channel: c.channel as comms.Channel,
        purpose: c.purpose as comms.Purpose,
        state: c.state as comms.ConsentState,
        capturedAt: c.capturedAt,
        supersededAt: c.supersededAt,
      })),
      suppressions: suppressions.map((s) => ({
        channel: s.channel as comms.Channel,
        purpose: s.purpose as comms.Purpose | null,
        liftedAt: s.liftedAt,
      })),
      channelRegistered: Boolean(from?.registered),
    });
  });
}

/* --------------------------------------------------------------- handlers */

const shapeRow = (row: typeof schema.communicationConsent.$inferSelect) => ({
  id: row.id,
  channel: row.channel,
  purpose: row.purpose,
  state: row.state,
  method: row.method,
  proofText: row.proofText,
  proofReference: row.proofReference,
  capturedAt: row.capturedAt.toISOString(),
  supersededAt: row.supersededAt?.toISOString() ?? null,
  current: row.supersededAt === null,
});

export const handlers = {
  getConsent: async (ctx: ServiceContext, input: { address: string }) => {
    const decision = await marketable(ctx, input);
    return {
      history: await history(ctx, input),
      marketing: decision.allowed
        ? { allowed: true as const, reason: null }
        : { allowed: false as const, reason: decision.reason },
    };
  },
  grantConsent: async (ctx: ServiceContext, input: ConsentInput) => shapeRow(await grant(ctx, input)),
  revokeConsent: async (ctx: ServiceContext, input: ConsentInput) => shapeRow(await revoke(ctx, input)),
} as const;
