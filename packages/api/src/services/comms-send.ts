import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import * as phoneNumbers from "./phone-numbers";
import { comms } from "@opentradesos/core";

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
 * TRANSACTIONAL ONLY. Everything here is `purpose: "transactional"`, which is
 * a claim about the message rather than a setting: a person is on their way to
 * a property, and that is not marketing. Anything that is marketing needs its
 * own consent and must not come through here.
 */

/**
 * Whether this address can be texted right now, and what to send from.
 *
 * Exported because the inbox asks the same question before letting a person
 * type a reply, and asking it twice in two ways is how the answers diverge.
 */
export async function sendability(tx: Database, organizationId: string, address: string) {
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
    const [found] = await tx.select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(
        eq(schema.customer.phone, input.address),
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

  const decision = await sendability(tx, input.organizationId, input.address);
  if (!decision.allowed || !decision.from) {
    const reason = decision.reason ?? "channel_unregistered";
    return { sent: false, reason, explanation: refusal(reason) };
  }

  const conversationId = await threadFor(tx, {
    organizationId: input.organizationId,
    address: input.address,
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
    toAddress: input.address,
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
 */
export function refusal(reason: string | undefined): string {
  switch (reason) {
    case "suppressed": return "They have replied STOP. You cannot text this number until they opt back in.";
    case "no_consent": return "No consent on record for this number.";
    case "revoked": return "They withdrew consent for this number.";
    case "channel_unregistered": return "No registered sending number. Register one before sending.";
    case "quiet_hours": return "Outside the hours this customer may be contacted.";
    case "empty": return "Nothing to send.";
    default: return reason ? `Cannot send: ${reason}` : "Cannot send to this number.";
  }
}
