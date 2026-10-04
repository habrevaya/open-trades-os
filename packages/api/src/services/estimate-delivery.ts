import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { branding as brand, money as m, type Actor } from "@opentradesos/core";
import type { ServiceContext } from "./context";
import * as email from "./email";
import { sendTransactional } from "./comms-send";
import { stateOf, type DeliveryState } from "./invoice-delivery";

/**
 * PUTTING AN ESTIMATE IN FRONT OF THE CUSTOMER
 *
 * `POST /v1/estimates/{id}/send` took `email`, `sms` or `link` as a channel
 * and did the same thing for all three: it issued a link and handed it back.
 * The office screen said so honestly and offered only the link, which meant
 * every estimate this product produced was texted from somebody's own phone,
 * and the conversation it started happened somewhere the office cannot see.
 *
 * THIS FILE IS THE COMPOSING AND THE RECORDING. The transport is the same
 * two functions everything else uses, `email.queue` and
 * `comms-send.sendTransactional`, which own consent, the suppression list,
 * the outbox and which number a text comes from. Both write the message into
 * the customer's conversation thread, which is the requirement the brief was
 * really about: a reply to the estimate text lands in the inbox beside it.
 *
 * WHAT IS ADDED HERE is the one fact neither transport can know: that this
 * message was this estimate. That is `estimate_delivery`, one row per
 * attempt, joined to the message, so "did they get it" is answerable from
 * the estimate and a bounce on Tuesday explains a quote nobody answered.
 */

export type EstimateChannel = "email" | "sms" | "link";

export interface Identity {
  name: string;
  /** The company's colour, for the button on the email. Null when none is set. */
  color: string | null;
  on: string | null;
}

/** The company's name and colour, read in the caller's transaction. */
export async function identityOf(tx: Database, organizationId: string): Promise<Identity> {
  const [org] = await tx.select({ name: schema.organization.name, color: schema.organization.brandColor })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const color = org?.color ? brand.parseColor(org.color) : null;
  return { name: org?.name ?? "", color, on: color ? brand.readableOn(color) : null };
}

export interface EstimateForMessage {
  number: number;
  title: string | null;
  customerName: string;
  /** Every option's total, for a line saying what is on offer. */
  totals: string[];
}

/** "3 options, from $4,200.00 to $9,800.00", or one figure for one option. */
export function offerLine(totals: readonly string[]): string | null {
  if (totals.length === 0) return null;
  const sorted = [...totals].sort((a, b) => m.compare(m.money(a), m.money(b)));
  const low = m.format(m.money(sorted[0]!));
  const high = m.format(m.money(sorted[sorted.length - 1]!));
  if (sorted.length === 1) return `Total: ${low}`;
  return low === high
    ? `${sorted.length} options, each ${low}`
    : `${sorted.length} options, from ${low} to ${high}`;
}

/**
 * The text message.
 *
 * Short, named and with the link last. A text with a link and no sender is
 * the exact shape carriers filter and customers are told never to tap, so it
 * opens with the company's name, says what the link is, and stays well under
 * two segments so it arrives as one message on every phone.
 */
export function composeText(input: {
  identity: Identity; estimate: EstimateForMessage; url: string; note: string | null;
}): string {
  const what = input.estimate.title ? `estimate for ${input.estimate.title}` : `estimate #${input.estimate.number}`;
  const first = input.estimate.customerName.split(" ")[0] || input.estimate.customerName;
  return [
    `Hi ${first}, it's ${input.identity.name}.`,
    ...(input.note ? [input.note] : []),
    `Your ${what} is ready to review and approve: ${input.url}`,
  ].join(" ");
}

/** Escaped at the point of interpolation, because the note and the names are typed by people. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The email, in both parts.
 *
 * Both parts always, for the reason `invoice-delivery.compose` gives: HTML
 * alone is a spam signal and the text part is what a screen reader reads.
 * The button is the company's colour, with the readable text colour core
 * works out for it, so the email looks like the proposal it opens.
 */
export function composeEmail(input: {
  identity: Identity; estimate: EstimateForMessage; url: string; note: string | null;
}): { subject: string; text: string; html: string } {
  const { identity, estimate, url, note } = input;
  const subject = estimate.title
    ? `Your estimate from ${identity.name}: ${estimate.title}`
    : `Estimate ${estimate.number} from ${identity.name}`;
  const offer = offerLine(estimate.totals);
  const action = "Review and approve your estimate";

  const text = [
    `Hello ${estimate.customerName},`,
    "",
    `${identity.name} has prepared estimate ${estimate.number}${estimate.title ? ` for ${estimate.title}` : ""}.`,
    ...(offer ? [offer] : []),
    "",
    ...(note ? [note, ""] : []),
    `${action}:`,
    url,
    "",
    "This link opens your estimate without an account. You can choose an option, sign and approve it there, "
    + "or reply to this email with any questions.",
    identity.name,
  ].join("\n");

  const fill = identity.color ?? "#1f2937";
  const onFill = identity.on ?? "#ffffff";
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;`
    + `font-size:16px;line-height:1.5;color:#111827;max-width:560px">`,
    `<p>Hello ${escapeHtml(estimate.customerName)},</p>`,
    `<p>${escapeHtml(identity.name)} has prepared estimate ${estimate.number}`
    + `${estimate.title ? ` for ${escapeHtml(estimate.title)}` : ""}.`
    + `${offer ? `<br><strong>${escapeHtml(offer)}</strong>` : ""}</p>`,
    ...(note ? [`<p>${escapeHtml(note)}</p>`] : []),
    `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;`
    + `background:${escapeHtml(fill)};color:${escapeHtml(onFill)};text-decoration:none;`
    + `border-radius:6px">${escapeHtml(action)}</a></p>`,
    `<p style="font-size:14px;color:#4b5563">This link opens your estimate without an account. `
    + `You can choose an option, sign and approve it there, or reply to this email with any questions.</p>`,
    `<p style="font-size:14px;color:#4b5563">${escapeHtml(identity.name)}</p>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

/**
 * The transport's own permission, added for the length of this send.
 *
 * The authority for sending an estimate is `estimate:send`, checked by the
 * guard before anything here runs. `email.queue` asks for `message:send` as
 * well, and the reasoning `invoice-delivery.transportContext` gives applies
 * unchanged: requiring it separately would make a role that may send
 * estimates unable to, and an operator would fix that by granting the right
 * to text anybody about anything. It is ADDED to the grants rather than
 * applied some other way, so a company that has revoked `message:send` from
 * this person still wins, because revocation beats a grant.
 */
export function transportContext(ctx: ServiceContext, tx: Database): ServiceContext {
  const actor: Actor = { ...ctx.actor, grants: [...(ctx.actor.grants ?? []), "message:send"] };
  return { ...ctx, actor, db: tx };
}

export type Transported =
  | { sent: true; messageId: string; conversationId: string }
  | { sent: false; reason: string; explanation: string };

/**
 * Queue the email or the text, or say why it cannot go.
 *
 * A refusal is an answer rather than an error, for the reason both
 * transports give: "they replied STOP" is a fact about the customer that the
 * office needs to see, not a failure to roll back.
 */
export async function transport(
  tx: Database, ctx: ServiceContext,
  input: {
    channel: "email" | "sms"; to: string; customerId: string;
    identity: Identity; estimate: EstimateForMessage; url: string; note: string | null;
  },
): Promise<Transported> {
  if (input.channel === "sms") {
    const outcome = await sendTransactional(tx, {
      organizationId: ctx.actor.organizationId,
      address: input.to,
      body: composeText(input),
      customerId: input.customerId,
      sentByUserId: ctx.portalGrantId ? null : ctx.actor.userId,
    });
    return outcome.sent
      ? { sent: true, messageId: outcome.messageId, conversationId: outcome.conversationId }
      : { sent: false, reason: outcome.reason, explanation: outcome.explanation };
  }
  const composed = composeEmail(input);
  /**
   * TRANSACTIONAL, like an invoice: the customer asked for the quote, and an
   * unsubscribe control on it would offer a choice the company cannot honour
   * on the next one. A revocation or a suppression still stops it, inside
   * `email.queue`.
   */
  const outcome = await email.queue(transportContext(ctx, tx), {
    to: input.to,
    subject: composed.subject,
    text: composed.text,
    html: composed.html,
    purpose: "transactional",
    customerId: input.customerId,
  });
  return outcome.queued
    ? { sent: true, messageId: outcome.messageId, conversationId: outcome.conversationId }
    : { sent: false, reason: outcome.reason, explanation: outcome.explanation };
}

export interface EstimateDeliveryView {
  id: string;
  channel: EstimateChannel;
  destination: string | null;
  /** Derived from the message on every read, never stored. See `invoice-delivery.stateOf`. */
  state: DeliveryState;
  messageId: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * Every attempt to put this estimate in front of the customer, oldest first.
 *
 * The state is derived by the same function the invoice deliveries use, so
 * "bounced" means one thing on both screens. A link handed over by hand is
 * `link_issued` and nothing more is knowable about it.
 */
export async function deliveriesWithin(tx: Database, estimateId: string): Promise<EstimateDeliveryView[]> {
  const rows = await tx.select({
    id: schema.estimateDelivery.id,
    channel: schema.estimateDelivery.channel,
    destination: schema.estimateDelivery.destination,
    messageId: schema.estimateDelivery.messageId,
    error: schema.estimateDelivery.error,
    createdAt: schema.estimateDelivery.createdAt,
    messageStatus: schema.message.status,
  })
    .from(schema.estimateDelivery)
    .leftJoin(schema.message, eq(schema.message.id, schema.estimateDelivery.messageId))
    .where(eq(schema.estimateDelivery.estimateId, estimateId))
    .orderBy(asc(schema.estimateDelivery.createdAt));

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    destination: row.destination,
    state: stateOf({
      channel: row.channel === "link" ? "portal_link" : row.channel,
      submittedAt: row.channel === "link" ? row.createdAt : null,
      error: row.error,
      messageId: row.messageId,
      messageStatus: row.messageStatus,
    }),
    messageId: row.messageId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Withdraw one link, for a send that did not go. */
export async function withdraw(tx: Database, grantId: string): Promise<void> {
  await tx.update(schema.portalGrant).set({ revokedAt: new Date() })
    .where(and(eq(schema.portalGrant.id, grantId), isNull(schema.portalGrant.revokedAt)));
}
