import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import * as phoneNumbers from "./phone-numbers";
import { comms, time } from "@opentradesos/core";

/**
 * THE ONE WAY A MESSAGE LEAVES THIS SYSTEM
 *
 * This file exists because there were nearly two. The inbox had a consent
 * decision in front of every send, and `dispatch.onMyWay` had none, because
 * onMyWay did not send anything at all: it wrote a row saying a notice had
 * gone out and returned ok, while the technician's button read "Text the
 * customer I am on my way". Wiring a second insert into `message` next to the
 * first would have given this codebase two outbound paths and one suppression
 * check, and the second one to be written is always the one that forgets.
 *
 * So the check and the send are the same function, and a caller cannot have
 * the send without the check.
 *
 * TWO PURPOSES, ONE GATE. `sendTransactional` is a claim about the message
 * rather than a setting: a person is on their way to a property, and that is
 * not marketing. `sendMarketing` is the other claim, and it lives in this file
 * for the reason above rather than in the campaign service, because a second
 * outbound path is a second place to forget the suppression check. What
 * separates them is not the file, it is three things the marketing gate adds:
 * a granted consent row with nothing implied, quiet hours, and a different
 * number to send from.
 */

/**
 * Whether this address can be texted right now, and what to send from.
 *
 * Exported because the inbox asks the same question before letting a person
 * type a reply, and asking it twice in two ways is how the answers diverge.
 */
export async function sendability(tx: Database, organizationId: string, typed: string) {
  /**
   * In E.164, whatever the caller held. A STOP arrives from the carrier as
   * "+15125550192"; the customer record says "(512) 555-0192". Compared as
   * typed, the STOP was not found and the text went anyway.
   */
  const address = comms.phoneAddress(typed);
  /**
   * WHICH NUMBER A TEXT COMES FROM IS A DECISION, and this used to make it by
   * taking whichever number was created last. That was harmless only while
   * tracking numbers could not exist. Now that they can, the newest
   * registered number is often one, and sending from a tracking number
   * poisons the measurement it exists for: the customer replies, the reply
   * lands on the campaign number, and the campaign is credited with a lead
   * that is a reply to our own text.
   *
   * The rule lives in one place so this and the workflow sender cannot
   * disagree about who a customer hears from.
   */
  const from = await phoneNumbers.senderFor(tx, organizationId, { smsRequired: true });

  const consents = await tx.select().from(schema.communicationConsent)
    .where(and(
      eq(schema.communicationConsent.organizationId, organizationId),
      eq(schema.communicationConsent.address, address),
      isNull(schema.communicationConsent.supersededAt),
    ));

  const suppressions = await tx.select().from(schema.suppression)
    .where(and(
      eq(schema.suppression.organizationId, organizationId),
      eq(schema.suppression.address, address),
      isNull(schema.suppression.liftedAt),
    ));

  const decision = comms.canSend({
    channel: "sms",
    purpose: "transactional",
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
    channelRegistered: Boolean(from?.smsRegistered),
  });

  return { ...decision, from };
}

/**
 * The thread this belongs to.
 *
 * By address rather than by the provider's own threading, which keys on the
 * number pair and therefore splits a conversation the moment a company sends
 * from a pool. The customer is attached when one is recognized, and left null
 * when not: an unrecognized number texting in is a lead, and dropping it
 * because it does not match a customer row is how leads are lost.
 */
export async function threadFor(tx: Database, input: {
  organizationId: string; address: string; phoneNumberId: string; customerId?: string | null;
}): Promise<string> {
  const [existing] = await tx.select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(and(
      eq(schema.conversation.organizationId, input.organizationId),
      eq(schema.conversation.externalAddress, input.address),
      isNull(schema.conversation.deletedAt),
    ))
    .orderBy(desc(schema.conversation.createdAt))
    .limit(1);
  if (existing) return existing.id;

  /**
   * The caller's customer wins over the lookup.
   *
   * An outbound notice already knows whose job it is. Matching on the number
   * would attach the thread to whoever happens to hold that number on their
   * customer record, and on a rental that is the landlord while the person
   * being texted is the tenant.
   */
  let customerId = input.customerId ?? null;
  if (!customerId) {
    /**
     * By the digits, because the record holds the number as it was typed and
     * the carrier hands us E.164: a reply from "+15125550192" is the customer
     * whose record says "(512) 555-0192", and an exact match said nobody.
     */
    const digits = comms.phoneAddress(input.address).startsWith("+") ? input.address.replace(/\D/g, "") : "";
    const forms = digits.length === 11 && digits.startsWith("1") ? [digits, digits.slice(1)] : [digits];
    const [found] = digits.length < 7 ? [] : await tx.select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(
        inArray(sql`regexp_replace(${schema.customer.phone}, '[^0-9]', '', 'g')`, forms),
        isNull(schema.customer.deletedAt),
      ))
      .limit(1);
    customerId = found?.id ?? null;
  }

  const [created] = await tx.insert(schema.conversation).values({
    organizationId: input.organizationId,
    channel: "sms",
    externalAddress: input.address,
    phoneNumberId: input.phoneNumberId,
    customerId,
    status: "open",
  }).returning({ id: schema.conversation.id });
  return created!.id;
}

export type SendOutcome =
  | { sent: true; messageId: string; conversationId: string }
  | { sent: false; reason: string; explanation: string };

/**
 * Queue one transactional text, or say why it cannot go.
 *
 * Returns a refusal rather than throwing, and that is the important part of
 * the shape. The callers are a technician tapping a button from a van and a
 * workflow step: for both of them, "they replied STOP" is an answer, not an
 * error. Throwing would roll back the record that the technician said they
 * were on their way, which is a fact worth keeping whether or not the customer
 * could be reached, and would tell the person in the van only that something
 * failed.
 *
 * QUEUED, never sent. The outbox hands it to the carrier and records what came
 * back. Writing "sent" here would make the log claim something the company
 * cannot stand behind.
 */
export async function sendTransactional(tx: Database, input: {
  organizationId: string;
  address: string;
  body: string;
  customerId?: string | null;
  sentByUserId?: string | null;
}): Promise<SendOutcome> {
  const body = input.body.trim();
  if (body === "") return { sent: false, reason: "empty", explanation: "Nothing to send." };

  /**
   * One form of the number for the decision, the thread and the carrier.
   * The callers hand over what is on the customer or contact record, which
   * is however somebody typed it; queued as typed, the carrier is asked to
   * send to "512-555-0192", and the customer's reply, which arrives from
   * "+15125550192", opens a second conversation nobody is watching.
   */
  const address = comms.phoneAddress(input.address);
  const decision = await sendability(tx, input.organizationId, address);
  if (!decision.allowed || !decision.from) {
    /**
     * TWO DIFFERENT FAILURES, and they were collapsed into one stale string.
     *
     * A refused decision means consent says no. `!decision.from` means
     * consent is fine and this company has no number registered to send
     * from, which is a settings problem rather than a customer one. The
     * fallback here was `"channel_unregistered"`, a value `canSend` has never
     * returned and `refusal` has never had a case for, so the operator got
     * the identifier printed at them either way.
     */
    const reason: comms.SendRefusal = decision.allowed
      ? "channel_not_registered"
      : decision.reason;
    return { sent: false, reason, explanation: refusal(reason) };
  }

  const conversationId = await threadFor(tx, {
    organizationId: input.organizationId,
    address,
    phoneNumberId: decision.from.id,
    customerId: input.customerId ?? null,
  });

  const [message] = await tx.insert(schema.message).values({
    organizationId: input.organizationId,
    conversationId,
    direction: "outbound",
    channel: "sms",
    purpose: "transactional",
    fromAddress: decision.from.e164,
    toAddress: address,
    body,
    status: "queued",
    sentByUserId: input.sentByUserId ?? null,
  }).returning({ id: schema.message.id });

  await tx.update(schema.conversation).set({
    lastMessageAt: new Date(),
    lastMessagePreview: body.slice(0, 200),
    status: "open",
    updatedAt: new Date(),
  }).where(eq(schema.conversation.id, conversationId));

  return { sent: true, messageId: message!.id, conversationId };
}

/* ------------------------------------------------------------- marketing */

/**
 * THE QUIET HOURS BRANCH THAT HAD NEVER FIRED
 *
 * `comms.canSend` has refused `quiet_hours` since it was written. It does so
 * only when the caller passes both a window and a local hour, and no caller
 * ever passed either: not this file, not the workflow executor, not the email
 * queue, not the consent screen. `inQuietHours` is tested in core and was
 * unreachable from the product, both `refusal` functions carry a sentence for
 * a reason neither could ever be handed, and the one check in this system that
 * exists specifically to stop a marketing text landing at eleven at night did
 * nothing.
 *
 * The window is the company's, from `organization.settings.quietHours`, and
 * the default below is not a guess at good manners. Calling or texting a
 * consumer outside 8am to 9pm local time is what the TCPA prohibits, and a
 * product whose default is "any time" makes that the operator's problem by
 * omission.
 *
 * LOCAL TO THE COMPANY, not to the recipient, and that is a limitation worth
 * naming rather than hiding. The right hour is the one where the phone is, and
 * this product does not know that: a number's area code stopped predicting
 * location when porting became free. The company's own zone is the closest
 * honest answer, and it is right for the overwhelming majority of a trades
 * company's list, because they drive to it.
 */
export const DEFAULT_QUIET_HOURS = { startHour: 21, endHour: 8 } as const;

export interface QuietHours { startHour: number; endHour: number }

/**
 * The window this company will not send marketing in, and the recipient's
 * local hour at the given instant.
 *
 * `null` for the window means the company has deliberately turned quiet hours
 * off, which is a thing a B2B contractor texting facilities managers may
 * legitimately want. It is not the same as the column being absent, which
 * takes the default.
 */
export async function quietHoursFor(tx: Database, organizationId: string, at: Date): Promise<{
  window: QuietHours | null;
  localHour: number;
  zone: string;
}> {
  const [row] = await tx.execute<{ timezone: string | null; settings: Record<string, unknown> | null }>(
    sql`select timezone, settings from public.organization where id = ${organizationId} limit 1`,
  );
  const zone = row?.timezone && time.isZone(row.timezone) ? row.timezone : "America/Chicago";
  const localHour = Math.floor(time.minutesInDay(at, zone) / 60);

  const configured = (row?.settings ?? {})["quietHours"];
  if (configured === null) return { window: null, localHour, zone };
  if (configured && typeof configured === "object") {
    const candidate = configured as { startHour?: unknown; endHour?: unknown };
    const startHour = candidate.startHour;
    const endHour = candidate.endHour;
    if (Number.isInteger(startHour) && Number.isInteger(endHour)
      && (startHour as number) >= 0 && (startHour as number) <= 23
      && (endHour as number) >= 0 && (endHour as number) <= 23) {
      return { window: { startHour: startHour as number, endHour: endHour as number }, localHour, zone };
    }
    /**
     * A malformed window falls back to the legal default rather than to no
     * window at all. The failure mode of the other choice is a typo in a
     * settings blob quietly removing the only thing stopping a two in the
     * morning send.
     */
  }
  return { window: { ...DEFAULT_QUIET_HOURS }, localHour, zone };
}

/**
 * Whether this address can be sent MARKETING right now, and what to send from.
 *
 * Separate from `sendability` rather than a flag on it, because every one of
 * the three differences is a thing that must not be switchable by accident:
 * the purpose the consent is checked against, the window, and the number.
 */
export async function marketability(tx: Database, organizationId: string, typed: string, at: Date) {
  const address = comms.phoneAddress(typed);
  const from = await phoneNumbers.senderFor(tx, organizationId, {
    smsRequired: true, purpose: "marketing",
  });
  const quiet = await quietHoursFor(tx, organizationId, at);

  const consents = await tx.select().from(schema.communicationConsent)
    .where(and(
      eq(schema.communicationConsent.organizationId, organizationId),
      eq(schema.communicationConsent.address, address),
      isNull(schema.communicationConsent.supersededAt),
    ));

  const suppressions = await tx.select().from(schema.suppression)
    .where(and(
      eq(schema.suppression.organizationId, organizationId),
      eq(schema.suppression.address, address),
      isNull(schema.suppression.liftedAt),
    ));

  const decision = comms.canSend({
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
    channelRegistered: Boolean(from?.smsRegistered),
    ...(quiet.window ? { quietHours: quiet.window, localHour: quiet.localHour } : {}),
  });

  return { ...decision, from, quiet };
}

/**
 * Queue one marketing text, or say why it cannot go.
 *
 * Returns a refusal rather than throwing, like its transactional sibling, and
 * here the reason is the whole product rather than a convenience: a campaign
 * sending to two thousand people will refuse some of them, and every refusal
 * is a row on the campaign with a reason on it. Throwing would abandon the
 * send at the first person who had replied STOP.
 *
 * ATTACHED TO A CONVERSATION, deliberately. A marketing text that a customer
 * cannot reply to is a worse version of a letter. The replies are the point,
 * and they have to land in the inbox somebody is watching rather than on a
 * number nobody reads.
 */
export async function sendMarketing(tx: Database, input: {
  organizationId: string;
  address: string;
  body: string;
  customerId?: string | null;
  sentByUserId?: string | null;
  at?: Date;
}): Promise<SendOutcome> {
  const body = input.body.trim();
  if (body === "") return { sent: false, reason: "empty", explanation: "Nothing to send." };

  const address = comms.phoneAddress(input.address);
  const decision = await marketability(tx, input.organizationId, address, input.at ?? new Date());
  if (!decision.allowed || !decision.from) {
    const reason: comms.SendRefusal = decision.allowed
      ? "channel_not_registered"
      : decision.reason;
    return { sent: false, reason, explanation: refusal(reason) };
  }

  const conversationId = await threadFor(tx, {
    organizationId: input.organizationId,
    address,
    phoneNumberId: decision.from.id,
    customerId: input.customerId ?? null,
  });

  const [message] = await tx.insert(schema.message).values({
    organizationId: input.organizationId,
    conversationId,
    direction: "outbound",
    channel: "sms",
    purpose: "marketing",
    fromAddress: decision.from.e164,
    toAddress: address,
    body,
    status: "queued",
    sentByUserId: input.sentByUserId ?? null,
  }).returning({ id: schema.message.id });

  await tx.update(schema.conversation).set({
    lastMessageAt: new Date(),
    lastMessagePreview: body.slice(0, 200),
    status: "open",
    updatedAt: new Date(),
  }).where(eq(schema.conversation.id, conversationId));

  return { sent: true, messageId: message!.id, conversationId };
}

/**
 * The refusal in words an operator can act on.
 *
 * "Forbidden" sends somebody to support. "They replied STOP" tells them what
 * happened and that there is nothing to fix.
 *
 * TWO OF THESE CASES USED TO BE DEAD, AND THE TYPE IS WHY THEY COULD BE.
 *
 * This took `string | undefined` and switched on `"revoked"` and
 * `"channel_unregistered"`, while `canSend` has always answered
 * `"consent_revoked"` and `"channel_not_registered"`. Both fell through to
 * the default, so a customer who withdrew consent produced "Cannot send:
 * consent_revoked" on a technician's screen, and the one screen where a
 * plain sentence matters most showed an identifier instead.
 *
 * Nothing caught it because a wider parameter type made every branch look
 * plausible. Taking `SendRefusal` means the compiler now rejects a case that
 * cannot happen and, more usefully, the exhaustiveness check below fails to
 * build the day somebody adds a refusal reason and forgets to write its
 * sentence. A list of strings that has to agree with another list of strings,
 * with nothing making them agree, is how this got here.
 *
 * `undefined` is still accepted because a caller can have no reason at all,
 * which is not the same as a reason nobody wrote words for.
 */
export function refusal(reason: comms.SendRefusal | undefined): string {
  switch (reason) {
    case "suppressed": return "They have replied STOP. You cannot text this number until they opt back in.";
    case "no_consent": return "No consent on record for this number.";
    case "consent_revoked": return "They withdrew consent for this number.";
    case "channel_not_registered": return "No registered sending number. Register one before sending.";
    case "quiet_hours": return "Outside the hours this customer may be contacted.";
    case undefined: return "Cannot send to this number.";
    default: {
      /**
       * Unreachable while every reason above is covered, and a build error
       * the moment one is not. That is the whole point: the sentences and the
       * union cannot drift apart silently again.
       */
      const unwritten: never = reason;
      return `Cannot send: ${String(unwritten)}`;
    }
  }
}
