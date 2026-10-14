import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema, type Database } from "@opentradesos/db";
import {
  SYSTEM_USER_ID, branding as brand, money as m, reporting, type Actor, type Permission,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf, type ServiceContext,
} from "./context";
import * as email from "./email";
import { sendTransactional } from "./comms-send";
import { mintGrant } from "./portal";
import { buildStatement } from "./statements";
import { statementFileWithin } from "./documents";

/**
 * A STATEMENT, EMAILED OR TEXTED
 *
 * The statement has been on the customer's own account page since it was
 * built, and nothing put it in front of them. This sends it: by hand from the
 * office's statement page, and once a month to every customer who owes more
 * than the company says is worth chasing.
 *
 * A LINK, AND A DATED COPY. The email says there is a statement and opens it
 * on the customer's account page, which reads the ledger when they open it.
 * The body still carries no amounts: a balance in the text of an email is the
 * first thing a preview pane shows anybody standing behind the customer. The
 * statement as it was on the day it went is attached as a PDF, because that is
 * what a bookkeeper files and what an accounts payable clerk will not click a
 * link to fetch; it says on its face that it is a copy as of that day, so a
 * cheque that clears tomorrow makes it out of date rather than wrong. The link
 * is a portal grant for that customer, minted through the portal's own token
 * mechanism, so it expires and can be revoked like every other link this
 * product hands out.
 *
 * THE AUTHORITY IS `invoice:send`, the permission for putting a bill in front
 * of a customer, and the transport's `message:send` is passed down beneath it
 * exactly as `invoice-delivery.ts` does, for the reason given there: the
 * finance role exists to send bills and does not hold `message:send`, and
 * granting it would mean letting them text customers.
 *
 * BY TEXT, THE LINK AND NOTHING ELSE, through `comms-send.sendTransactional`,
 * the one gate every text goes through: consent, a number that replied STOP,
 * quiet hours and which number it comes from are decided there and nowhere
 * here. By hand the office picks the channel. The monthly run texts a
 * customer whose main contact prefers texts only when the company turned
 * that on (`delivery_schedule.text_when_preferred`), and emails one whose
 * text cannot go, saying so on the row, because a customer who asked not to
 * be texted did not ask to stop getting their statement.
 *
 * EVERY ATTEMPT IS A ROW, whether it went or not. A customer with no address
 * on file, or one who asked not to be emailed, is a row saying so, which is
 * what lets the office see who did not get one rather than assume everybody
 * did.
 */

/** How long the link in a statement email or text opens the statement. */
const LINK_DAYS = 45;

export type StatementChannel = "email" | "sms";

export interface StatementSendResult {
  deliveryId: string;
  customerId: string;
  /** How it went, or how it was tried last when it did not. */
  channel: StatementChannel;
  destination: string | null;
  state: "queued" | "refused";
  /** Why it went another way than the customer prefers, when it did. */
  note: string | null;
  explanation: string | null;
  /** Empty on a replay: the token exists once, at the moment it is minted. */
  portalUrl: string;
  /** The copy to one more of the payer's own people, when one was asked for. */
  copy: StatementCopyResult | null;
}

/** How the copy went: to whom, where, and why not when it did not. */
export interface StatementCopyResult {
  contactId: string | null;
  contactName: string | null;
  destination: string | null;
  state: "queued" | "refused";
  explanation: string | null;
}

const usd = (value: string) => m.money(value, "USD");

/** `message:send` beneath `invoice:send`. A revocation still wins. */
function transportContext(ctx: ServiceContext, tx: Database): ServiceContext {
  const actor: Actor = { ...ctx.actor, grants: [...(ctx.actor.grants ?? []), "message:send"] };
  return { ...ctx, actor, db: tx };
}

async function identityOf(tx: Database, organizationId: string) {
  const [org] = await tx.select({ name: schema.organization.name, color: schema.organization.brandColor })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const color = org?.color ? brand.parseColor(org.color) : null;
  return { name: org?.name ?? "", color, on: color ? brand.readableOn(color) : null };
}

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const DAY = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const said = (date: string) => DAY.format(new Date(`${date}T12:00:00Z`));

/**
 * The email. Who it is from, what period, and the link. No amounts, on
 * purpose: see the top of this file.
 */
export function composeStatementEmail(input: {
  organizationName: string;
  customerName: string;
  from: string;
  to: string;
  url: string;
  color: string | null;
  on: string | null;
  /**
   * The person a copy goes to, by name. The copy says whose statement it is
   * and why they have it, rather than greeting them as the customer.
   */
  copyTo?: string | undefined;
}): { subject: string; text: string; html: string } {
  const period = `${said(input.from)} to ${said(input.to)}`;
  const copy = input.copyTo !== undefined;
  const subject = copy
    ? `A copy of ${input.customerName}'s statement from ${input.organizationName}`
    : `Your statement from ${input.organizationName}`;
  const opening = copy
    ? `A copy of ${input.customerName}'s statement from ${input.organizationName} for ${period} is ready. `
      + `You have it as one of the people on their account.`
    : `Your statement from ${input.organizationName} for ${period} is ready.`;
  const text = [
    `Hello ${copy ? input.copyTo : input.customerName},`,
    "",
    opening,
    "It lists every invoice, payment and credit in that time, and what is still open.",
    "A copy as of today is attached as a PDF; the link always shows it as it is now.",
    "",
    `${copy ? "Open the statement" : "Open your statement"}: ${input.url}`,
    "",
    `${copy ? "The link opens their account without a password, so keep it to yourself." : "The link opens your account without a password."} Reply to this email if anything looks wrong.`,
    "",
    input.organizationName,
  ].join("\n");
  const fill = input.color ?? "#111827";
  const onFill = input.on ?? "#ffffff";
  const html = [
    `<div style="font-family:system-ui,sans-serif;color:#111827;max-width:560px">`,
    `<p>Hello ${escapeHtml(copy ? input.copyTo! : input.customerName)},</p>`,
    `<p>${escapeHtml(opening)} `
    + `It lists every invoice, payment and credit in that time, and what is still open.</p>`,
    `<p>A copy as of today is attached as a PDF; the link always shows it as it is now.</p>`,
    `<p><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:10px 16px;`
    + `background:${escapeHtml(fill)};color:${escapeHtml(onFill)};text-decoration:none;border-radius:6px">`
    + `${copy ? "Open the statement" : "Open your statement"}</a></p>`,
    `<p style="font-size:14px;color:#4b5563">${copy ? "The link opens their account without a password, so keep it to yourself." : "The link opens your account without a password."} `
    + `Reply to this email if anything looks wrong.</p>`,
    `<p style="font-size:14px;color:#4b5563">${escapeHtml(input.organizationName)}</p>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}

/**
 * The text. Who it is from, what period, and the link: no amounts, for the
 * reason the email carries none, and short enough to arrive as one message.
 * It opens with the company's name because a text with a link and no sender
 * is the shape carriers filter and customers are taught never to tap.
 */
export function composeStatementText(input: {
  organizationName: string; customerName: string; from: string; to: string; url: string;
}): string {
  const first = input.customerName.split(" ")[0] || input.customerName;
  return `Hi ${first}, it's ${input.organizationName}. Your statement for ${said(input.from)} to ${said(input.to)} `
    + `is ready to view: ${input.url}`;
}

/**
 * How a customer would rather hear from the company: their main contact's
 * preferred channel, and the number to text. The contact on the customer
 * record marked primary, or failing that the first one added; a customer with
 * no contacts at all has said nothing, and is emailed as before.
 */
export async function preferenceOf(tx: Database, customerId: string): Promise<{ prefersText: boolean; phone: string | null }> {
  const [contact] = await tx.select({
    phone: schema.contact.phone, preferredChannel: schema.contact.preferredChannel,
  }).from(schema.contact)
    .where(and(eq(schema.contact.customerId, customerId), isNull(schema.contact.deletedAt)))
    .orderBy(desc(schema.contact.isPrimary), schema.contact.createdAt)
    .limit(1);
  const [customer] = await tx.select({ phone: schema.customer.phone })
    .from(schema.customer).where(eq(schema.customer.id, customerId)).limit(1);
  const phone = (contact?.phone ?? "").trim() || (customer?.phone ?? "").trim() || null;
  return { prefersText: contact?.preferredChannel === "sms", phone };
}

/** Who a customer's statement goes to, and how they would rather get it. */
export interface Recipient {
  /** The contact it goes to, or null for the customer's own address. */
  contactId: string | null;
  contactName: string | null;
  prefersText: boolean;
  /** Where an email goes: the contact's own address, else the customer's. */
  email: string | null;
  /** Where a text goes: the contact's own number, else the customer's. */
  phone: string | null;
  /** Why it is this person, when there was a choice to make. */
  note: string | null;
}

/**
 * WHOEVER THE CUSTOMER'S BILLS ARE ADDRESSED TO.
 *
 * A customer's statement lists the bills they pay, so it goes to the person
 * those bills are addressed to (`invoice.payer_contact_id`): the accounts
 * clerk at a property manager rather than whoever booked the work, by the way
 * that person prefers, to their own address or number. When the open bills
 * are addressed to more than one person, the newest bill's decides, and the
 * row says so. When none is addressed to anybody, the customer's main contact
 * decides as before (`preferenceOf`), with the customer's own address.
 */
export async function recipientOf(tx: Database, customerId: string): Promise<Recipient> {
  const named = await tx.select({
    id: schema.contact.id, name: schema.contact.name, email: schema.contact.email, phone: schema.contact.phone,
    preferredChannel: schema.contact.preferredChannel,
  }).from(schema.invoice)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.invoice.payerContactId))
    .where(and(
      sql`coalesce(${schema.invoice.payerCustomerId}, ${schema.invoice.customerId}) = ${customerId}`,
      inArray(schema.invoice.status, ["open", "partially_paid"]),
      isNull(schema.invoice.deletedAt),
      isNull(schema.contact.deletedAt),
      eq(schema.contact.customerId, customerId),
    ))
    .orderBy(desc(schema.invoice.issuedOn), desc(schema.invoice.number));
  const [customer] = await tx.select({ email: schema.customer.email, phone: schema.customer.phone })
    .from(schema.customer).where(eq(schema.customer.id, customerId)).limit(1);
  const own = { email: (customer?.email ?? "").trim() || null, phone: (customer?.phone ?? "").trim() || null };

  const chosen = named[0];
  if (!chosen) {
    const main = await preferenceOf(tx, customerId);
    return { contactId: null, contactName: null, prefersText: main.prefersText, email: own.email, phone: main.phone, note: null };
  }
  const people = new Set(named.map((n) => n.id)).size;
  return {
    contactId: chosen.id,
    contactName: chosen.name,
    prefersText: chosen.preferredChannel === "sms",
    email: (chosen.email ?? "").trim() || own.email,
    phone: (chosen.phone ?? "").trim() || own.phone,
    note: people > 1
      ? `Their open bills are addressed to ${people} people; it went to ${chosen.name}, named on the newest.`
      : null,
  };
}

/**
 * Send one customer their statement for one period, inside a transaction
 * that is already in the tenant. Shared by the button and the monthly run so
 * the two cannot write different emails or record different rows.
 *
 * The row is written whatever happens, and on the monthly run it is written
 * FIRST under the unique index on (customer, month), so a customer can never
 * be sent two statements for one month by two workers or a restart.
 */
async function sendOne(tx: Database, ctx: ServiceContext, input: {
  customerId: string;
  /** The way to try first. A text the consent gate refuses goes by email when `fallBack` says so. */
  channel: StatementChannel;
  address: string | null;
  from?: string | undefined;
  to?: string | undefined;
  period: string | null;
  scheduleId?: string | undefined;
  fallBack?: boolean | undefined;
  /** The person it goes to, when the monthly run chose one: their addresses, and why them. */
  recipient?: Recipient | undefined;
  /**
   * One more of the customer's own people to email a copy to. Checked here
   * whoever asked, because the monthly run asks with nobody watching: a
   * contact that is not this customer's, or has gone, gets no copy.
   */
  copyContactId?: string | null | undefined;
}): Promise<StatementSendResult | null> {
  const organizationId = ctx.actor.organizationId;
  const statement = await buildStatement(tx, organizationId, input.customerId, {
    ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}),
  });

  const [customer] = await tx.select({ email: schema.customer.email })
    .from(schema.customer).where(eq(schema.customer.id, input.customerId)).limit(1);
  const ownEmail = input.recipient ? input.recipient.email : customer?.email ?? null;
  const emailTo = (input.channel === "email" ? input.address ?? ownEmail ?? "" : ownEmail ?? "").trim();
  const textTo = input.channel === "sms"
    ? (input.address ?? (input.recipient ? input.recipient.phone : (await preferenceOf(tx, input.customerId)).phone) ?? "").trim()
    : "";

  const [row] = await tx.insert(schema.statementDelivery).values({
    organizationId,
    customerId: input.customerId,
    scheduleId: input.scheduleId ?? null,
    period: input.period,
    periodFrom: statement.from,
    periodTo: statement.to,
    channel: input.channel,
    destination: input.channel === "sms"
      ? (textTo === "" ? null : textTo)
      : (emailTo === "" ? null : email.normalizeAddress(emailTo)),
    closingBalance: statement.closingBalance,
    contactId: input.recipient?.contactId ?? null,
    sentByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
  }).onConflictDoNothing().returning({ id: schema.statementDelivery.id });
  if (!row) return null;

  const grant = await mintGrant(tx, {
    organizationId, customerId: input.customerId, scope: "customer",
    expiresInDays: LINK_DAYS, maxUses: null,
  });
  const url = `${grant.url}/statement?from=${statement.from}&to=${statement.to}`;
  const identity = await identityOf(tx, organizationId);
  const organizationName = identity.name || statement.organizationName;
  await tx.update(schema.statementDelivery).set({ portalGrantId: grant.row.id })
    .where(eq(schema.statementDelivery.id, row.id));

  /** The PDF, drawn once however many emails carry it. */
  let printedFile: Awaited<ReturnType<typeof statementFileWithin>> | null = null;
  const printedOnce = async () => (printedFile ??= await statementFileWithin(tx, organizationId, statement));

  /** The attempt by one channel: the message it became, or why it did not go. */
  const attemptBy = async (channel: StatementChannel): Promise<
    { sent: true; messageId: string; destination: string } | { sent: false; explanation: string }
  > => {
    if (channel === "sms") {
      if (textTo === "") {
        return { sent: false, explanation: `${statement.customerName} has no mobile number on file, so there was nowhere to text it.` };
      }
      /**
       * Through the one gate every text goes through (`comms-send`), which
       * asks consent, the suppression list and quiet hours, and picks the
       * number it comes from. A refusal is an answer, not an error.
       */
      const outcome = await sendTransactional(tx, {
        organizationId,
        address: textTo,
        body: composeStatementText({
          organizationName, customerName: statement.customerName, from: statement.from, to: statement.to, url,
        }),
        customerId: input.customerId,
        sentByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
      });
      return outcome.sent
        ? { sent: true, messageId: outcome.messageId, destination: textTo }
        : { sent: false, explanation: outcome.explanation };
    }
    if (emailTo === "") {
      return { sent: false, explanation: `${statement.customerName} has no email address on file, so there was nowhere to send it.` };
    }
    const composed = composeStatementEmail({
      organizationName,
      customerName: statement.customerName,
      from: statement.from, to: statement.to, url,
      color: identity.color, on: identity.on,
    });
    const printed = await printedOnce();
    const outcome = await email.queue(transportContext(ctx, tx), {
      to: emailTo,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      purpose: "transactional",
      customerId: input.customerId,
      attachments: [{ filename: printed.filename, contentType: "application/pdf", content: Buffer.from(printed.bytes) }],
    });
    return outcome.queued
      ? { sent: true, messageId: outcome.messageId, destination: email.normalizeAddress(emailTo) }
      : { sent: false, explanation: outcome.explanation };
  };

  let channel = input.channel;
  let textRefusal: string | null = null;
  let outcome = await attemptBy(channel);
  /**
   * A TEXT THAT CANNOT GO IS EMAILED INSTEAD, on the monthly run, and the row
   * says so. A customer who replied STOP to texts has not asked to stop
   * getting their statement, and a run that recorded "not sent" for every
   * texting customer without a number would leave the office to send each by
   * hand. By hand, the office chose the channel and is told it did not go.
   */
  if (!outcome.sent && channel === "sms" && input.fallBack) {
    textRefusal = outcome.explanation;
    channel = "email";
    outcome = await attemptBy("email");
  }
  const note = [input.recipient?.note ?? null, textRefusal ? `Not texted: ${textRefusal} Emailed instead.` : null]
    .filter((n): n is string => n !== null).join(" ") || null;

  /**
   * THE COPY, by email whichever way the statement went, as a message of its
   * own to the contact's own address: the email pipeline sends to one
   * person, and a copy that is its own message is refused or suppressed on
   * its own without taking the statement with it. Only once the statement
   * itself went, because the link they share is revoked when it did not.
   */
  const went = outcome;
  const copy = await (async (): Promise<StatementCopyResult | null> => {
    if (!input.copyContactId) return null;
    const [person] = await tx.select({
      id: schema.contact.id, name: schema.contact.name, email: schema.contact.email,
      customerId: schema.contact.customerId, deletedAt: schema.contact.deletedAt,
    }).from(schema.contact).where(eq(schema.contact.id, input.copyContactId)).limit(1);
    if (!person || person.customerId !== input.customerId) {
      return {
        contactId: null, contactName: null, destination: null, state: "refused",
        explanation: "The person named for the copy is not one of this customer's people, so no copy went.",
      };
    }
    const refusedCopy = (explanation: string, destination: string | null = null): StatementCopyResult => ({
      contactId: person.id, contactName: person.name, destination, state: "refused", explanation,
    });
    if (person.deletedAt !== null) return refusedCopy(`${person.name} has been removed from this customer, so no copy went.`);
    const address = (person.email ?? "").trim();
    if (address === "") return refusedCopy(`${person.name} has no email address on file, so no copy went.`);
    const destination = email.normalizeAddress(address);
    if (!went.sent) return refusedCopy("The statement itself did not go, so neither did the copy.", destination);
    if (channel === "email" && went.destination === destination) {
      return refusedCopy(`The statement went to ${person.name}'s own address, so no copy was needed.`, destination);
    }
    const composed = composeStatementEmail({
      organizationName,
      customerName: statement.customerName,
      from: statement.from, to: statement.to, url,
      color: identity.color, on: identity.on,
      copyTo: person.name,
    });
    const printed = await printedOnce();
    const queued = await email.queue(transportContext(ctx, tx), {
      to: address,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      purpose: "transactional",
      customerId: input.customerId,
      attachments: [{ filename: printed.filename, contentType: "application/pdf", content: Buffer.from(printed.bytes) }],
    });
    if (!queued.queued) return refusedCopy(queued.explanation, destination);
    await tx.update(schema.statementDelivery).set({ copyMessageId: queued.messageId })
      .where(eq(schema.statementDelivery.id, row.id));
    return { contactId: person.id, contactName: person.name, destination, state: "queued", explanation: null };
  })();
  if (copy) {
    await tx.update(schema.statementDelivery).set({
      copyContactId: copy.contactId, copyDestination: copy.destination, copyError: copy.explanation,
    }).where(eq(schema.statementDelivery.id, row.id));
  }

  if (!outcome.sent) {
    // A link that was never sent is a live key to somebody's account lying
    // in a table. Revoked, rather than left to expire in six weeks.
    await tx.update(schema.portalGrant).set({ revokedAt: new Date() })
      .where(eq(schema.portalGrant.id, grant.row.id));
    const explanation = textRefusal
      ? `Not texted: ${textRefusal} Not emailed: ${outcome.explanation}`
      : outcome.explanation;
    await tx.update(schema.statementDelivery).set({ error: explanation, channel })
      .where(eq(schema.statementDelivery.id, row.id));
    return {
      deliveryId: row.id, customerId: input.customerId, channel,
      destination: channel === "sms" ? (textTo || null) : (emailTo || null),
      state: "refused", note: null, explanation, portalUrl: "", copy,
    };
  }

  await tx.update(schema.statementDelivery).set({
    messageId: outcome.messageId, channel, destination: outcome.destination, note,
  }).where(eq(schema.statementDelivery.id, row.id));
  return {
    deliveryId: row.id, customerId: input.customerId, channel, destination: outcome.destination,
    state: "queued", note, explanation: null, portalUrl: url, copy,
  };
}

/**
 * "Email statement" and "Text statement", from the office.
 *
 * To the customer's address or number, or one the office types: a commercial
 * customer's accounts payable mailbox is rarely the address of the person who
 * booked the work. The channel is the office's choice here, so a text that
 * cannot go is recorded as not sent, with why, rather than quietly emailed. A
 * retried request is the same send, by its idempotency key.
 */
function sendByHand(ctx: ServiceContext, input: {
  id: string;
  channel: StatementChannel;
  address?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  copyContactId?: string | undefined;
}): Promise<StatementSendResult> {
  return guardedWrite(ctx, "invoice:send", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "statement_delivery"),
        )).limit(1);
      if (seen?.entityId) return replay(tx, seen.entityId);
    }

    const [customer] = await tx.select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, input.id), isNull(schema.customer.deletedAt))).limit(1);
    if (!customer) throw new NotFoundError("Customer");

    const typed = input.address?.trim();
    if (typed && input.channel === "email" && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(typed)) {
      throw new ConflictError(`"${typed}" is not an email address.`);
    }
    if (typed && input.channel === "sms" && typed.replace(/\D/g, "").length < 10) {
      throw new ConflictError(`"${typed}" is not a phone number a text can go to.`);
    }
    /**
     * The copy is one of the customer's own people, chosen from their list,
     * and refused here before anything goes rather than recorded as a copy
     * that did not: the office is standing at the button and can choose again.
     * An address typed for the copy is not taken at all.
     */
    if (input.copyContactId) await assertCopyable(tx, customer.id, input.copyContactId);

    const result = await sendOne(tx, ctx, {
      customerId: customer.id,
      channel: input.channel,
      address: typed || null,
      from: input.from, to: input.to,
      period: null,
      copyContactId: input.copyContactId ?? null,
    });
    // A hand sent row has no period, so the unique index never applies to it.
    if (!result) throw new ConflictError("This statement could not be recorded.");

    await audit(tx, ctx, result.state === "queued" ? "statement.sent" : "statement.refused",
      "customer", customer.id, null, {
        deliveryId: result.deliveryId, channel: result.channel, to: result.destination, explanation: result.explanation,
        ...(result.copy ? { copyTo: result.copy.destination, copyExplanation: result.copy.explanation } : {}),
      });

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "statement.send",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "statement_delivery", entityId: result.deliveryId,
      });
    }
    return result;
  });
}

export function emailStatement(ctx: ServiceContext, input: {
  id: string; email?: string | undefined; from?: string | undefined; to?: string | undefined;
  copyContactId?: string | undefined;
}): Promise<StatementSendResult> {
  return sendByHand(ctx, {
    id: input.id, channel: "email", address: input.email, from: input.from, to: input.to, copyContactId: input.copyContactId,
  });
}

/**
 * A contact a copy may go to: this customer's own, still on the customer,
 * with an email address. Refused in words otherwise.
 */
async function assertCopyable(tx: Database, customerId: string, contactId: string) {
  const [person] = await tx.select({
    id: schema.contact.id, name: schema.contact.name, email: schema.contact.email,
  }).from(schema.contact)
    .where(and(
      eq(schema.contact.id, contactId), eq(schema.contact.customerId, customerId), isNull(schema.contact.deletedAt),
    )).limit(1);
  if (!person) {
    throw new ConflictError("A copy can go only to one of this customer's own people. Choose one from their list.");
  }
  if ((person.email ?? "").trim() === "") {
    throw new ConflictError(`${person.name} has no email address on file, so a copy cannot go to them. Add one on the customer first.`);
  }
  return person;
}

/**
 * The statement's link by text, to the customer's main contact's mobile or
 * the number on the customer, or one the office types.
 */
export function textStatement(ctx: ServiceContext, input: {
  id: string; phone?: string | undefined; from?: string | undefined; to?: string | undefined;
}): Promise<StatementSendResult> {
  return sendByHand(ctx, { id: input.id, channel: "sms", address: input.phone, from: input.from, to: input.to });
}

async function replay(tx: Database, deliveryId: string): Promise<StatementSendResult> {
  const [row] = await tx.select().from(schema.statementDelivery)
    .where(eq(schema.statementDelivery.id, deliveryId)).limit(1);
  if (!row) throw new NotFoundError("Statement delivery");
  const [copied] = row.copyContactId
    ? await tx.select({ name: schema.contact.name }).from(schema.contact)
      .where(eq(schema.contact.id, row.copyContactId)).limit(1)
    : [];
  const asked = row.copyContactId !== null || row.copyError !== null;
  return {
    deliveryId: row.id, customerId: row.customerId, channel: row.channel as StatementChannel,
    destination: row.destination, state: row.messageId ? "queued" : "refused", note: row.note,
    explanation: row.error, portalUrl: "",
    copy: asked ? {
      contactId: row.copyContactId, contactName: copied?.name ?? null, destination: row.copyDestination,
      state: row.copyMessageId ? "queued" : "refused", explanation: row.copyError,
    } : null,
  };
}

/* ------------------------------------------------------------ the monthly run */

/** What the monthly run is allowed to do, named rather than assumed. */
const RUN_GRANTS: Permission[] = ["invoice:read", "invoice:send", "message:send", "message:read"];

export interface StatementRunResult {
  month: string;
  /** Customers owing more than the threshold. */
  owing: number;
  queued: number;
  refused: number;
  /** Already sent for this month, by an earlier attempt. */
  alreadySent: number;
  /** Of `queued`, how many went by text. */
  texted: number;
  /** Of `queued`, how many were meant to be texted and were emailed because the text could not go. */
  emailedInstead: number;
  /** Copies emailed to the second person a customer record names. */
  copied: number;
}

/**
 * The monthly run: every customer owing more than the threshold gets their
 * statement for the month before.
 *
 * Who owes is read from the open invoices by whoever PAYS them, the same rule
 * the statement itself follows, so a property manager paying a tenant's
 * invoices is sent the statement and the tenant is not.
 */
export async function deliverStatements(tx: Database, input: {
  organizationId: string;
  scheduleId: string;
  at: Date;
  minimumBalance: string | null;
  /** Text the customers whose main contact prefers texts, rather than emailing everybody. */
  textWhenPreferred?: boolean | undefined;
}): Promise<StatementRunResult> {
  const timezone = await timezoneOf(tx, input.organizationId);
  const month = reporting.statementMonth(input.at, timezone);
  const threshold = input.minimumBalance ?? "0";

  const owing = await tx.execute<{ customer_id: string }>(sql`
    select coalesce(i.payer_customer_id, i.customer_id) as customer_id
    from public.invoice i
    join public.customer c on c.id = coalesce(i.payer_customer_id, i.customer_id)
    where i.status in ('open', 'partially_paid')
      and i.deleted_at is null
      and c.deleted_at is null
    group by 1
    having sum(i.balance) > ${threshold}::numeric
    order by 1
  `);

  const ctx: ServiceContext = {
    actor: {
      userId: SYSTEM_USER_ID, organizationId: input.organizationId, roles: [],
      grants: RUN_GRANTS, agentId: "statement-run",
    },
    db: tx,
  };

  const result: StatementRunResult = {
    month: month.key, owing: owing.length, queued: 0, refused: 0, alreadySent: 0, texted: 0, emailedInstead: 0, copied: 0,
  };
  for (const { customer_id: customerId } of owing) {
    /** The person their bills are addressed to, and the way that person prefers. */
    const recipient = await recipientOf(tx, customerId);
    const texts = input.textWhenPreferred === true && recipient.prefersText;
    /** The copy the customer record names, if any: checked again inside the send, never taken on trust. */
    const [named] = await tx.select({ copyContactId: schema.customer.statementCopyContactId })
      .from(schema.customer).where(eq(schema.customer.id, customerId)).limit(1);
    const sent = await sendOne(tx, ctx, {
      customerId, channel: texts ? "sms" : "email", address: null, from: month.from, to: month.to,
      period: month.key, scheduleId: input.scheduleId, fallBack: true, recipient,
      copyContactId: named?.copyContactId ?? null,
    });
    if (sent?.copy?.state === "queued") result.copied += 1;
    if (!sent) result.alreadySent += 1;
    else if (sent.state === "queued") {
      result.queued += 1;
      if (sent.channel === "sms") result.texted += 1;
      if (texts && sent.channel === "email") result.emailedInstead += 1;
    } else result.refused += 1;
  }
  return result;
}

/* ----------------------------------------------------------------- reading */

export interface StatementDeliveryRecord {
  id: string;
  customerId: string;
  customerName: string;
  period: string | null;
  periodFrom: string;
  periodTo: string;
  channel: StatementChannel;
  destination: string | null;
  /** The person at the customer it went to, when it went to one. */
  contactName: string | null;
  closingBalance: string | null;
  /** The outbox's own word for the message, or null when nothing was queued. */
  messageStatus: string | null;
  error: string | null;
  note: string | null;
  /** The second person it was copied to, when one was asked for, and how that went. */
  copyContactName: string | null;
  copyDestination: string | null;
  copyMessageStatus: string | null;
  copyError: string | null;
  createdAt: Date;
}

const copyContact = alias(schema.contact, "copy_contact");
const copyMessage = alias(schema.message, "copy_message");

/** Statements sent, newest first, for one customer or for everybody. */
export function deliveries(ctx: ServiceContext, input: { customerId?: string | undefined; limit?: number | undefined } = {}) {
  return guardedRead(ctx, "invoice:read", async (tx): Promise<StatementDeliveryRecord[]> => {
    const rows = await tx.select({
      row: schema.statementDelivery,
      customerName: schema.customer.name,
      messageStatus: schema.message.status,
      contactName: schema.contact.name,
      copyContactName: copyContact.name,
      copyMessageStatus: copyMessage.status,
    })
      .from(schema.statementDelivery)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.statementDelivery.customerId))
      .leftJoin(schema.message, eq(schema.message.id, schema.statementDelivery.messageId))
      .leftJoin(schema.contact, eq(schema.contact.id, schema.statementDelivery.contactId))
      .leftJoin(copyContact, eq(copyContact.id, schema.statementDelivery.copyContactId))
      .leftJoin(copyMessage, eq(copyMessage.id, schema.statementDelivery.copyMessageId))
      .where(input.customerId ? eq(schema.statementDelivery.customerId, input.customerId) : undefined)
      .orderBy(desc(schema.statementDelivery.createdAt))
      .limit(Math.min(input.limit ?? 50, 200));
    return rows.map(({ row, customerName, messageStatus, contactName, copyContactName, copyMessageStatus }) => ({
      id: row.id,
      customerId: row.customerId,
      customerName,
      period: row.period,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      channel: row.channel as StatementChannel,
      destination: row.destination,
      contactName: contactName ?? null,
      closingBalance: row.closingBalance === null ? null : m.toString(m.round(usd(row.closingBalance), 2)),
      messageStatus: messageStatus ?? null,
      error: row.error,
      note: row.note,
      copyContactName: copyContactName ?? null,
      copyDestination: row.copyDestination,
      copyMessageStatus: copyMessageStatus ?? null,
      copyError: row.copyError,
      createdAt: row.createdAt,
    }));
  });
}

/* ------------------------------------------------------- the monthly copy */

/**
 * Who on a customer a statement can be copied to, and who the monthly run
 * copies now. The people are the customer's own, still on it, with an email
 * address, because a copy goes by email and only to them. Read with
 * `invoice:read`, the statement's own permission, so whoever reads a
 * statement can see who else gets it.
 */
export function statementCopies(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const [customer] = await tx.select({ id: schema.customer.id, copyContactId: schema.customer.statementCopyContactId })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, input.id), isNull(schema.customer.deletedAt))).limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const people = await tx.select({ id: schema.contact.id, name: schema.contact.name, email: schema.contact.email })
      .from(schema.contact)
      .where(and(eq(schema.contact.customerId, customer.id), isNull(schema.contact.deletedAt)))
      .orderBy(desc(schema.contact.isPrimary), asc(schema.contact.name));
    const candidates = people
      .filter((p) => (p.email ?? "").trim() !== "")
      .map((p) => ({ id: p.id, name: p.name, email: email.normalizeAddress(p.email!) }));
    const [named] = customer.copyContactId
      ? await tx.select({ id: schema.contact.id, name: schema.contact.name, email: schema.contact.email, deletedAt: schema.contact.deletedAt })
        .from(schema.contact).where(eq(schema.contact.id, customer.copyContactId)).limit(1)
      : [];
    return {
      customerId: customer.id,
      monthly: named ? {
        contactId: named.id,
        name: named.name,
        email: (named.email ?? "").trim() || null,
        /** Removed from the customer, or left with no address, since it was named: the run sends no copy and says why. */
        usable: named.deletedAt === null && (named.email ?? "").trim() !== "",
      } : null,
      candidates,
    };
  });
}

/**
 * Name the person the monthly run copies on this customer's statement, or
 * nobody. One of the customer's own people with an email address, under
 * `invoice:send` like the monthly run's own setting, and audited.
 */
export function setStatementCopy(ctx: ServiceContext, input: { id: string; contactId: string | null }) {
  return guardedWrite(ctx, "invoice:send", async (tx) => {
    const [customer] = await tx.select({ id: schema.customer.id, copyContactId: schema.customer.statementCopyContactId })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, input.id), isNull(schema.customer.deletedAt))).limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const person = input.contactId ? await assertCopyable(tx, customer.id, input.contactId) : null;
    await tx.update(schema.customer).set({ statementCopyContactId: person?.id ?? null, updatedAt: new Date() })
      .where(eq(schema.customer.id, customer.id));
    await audit(tx, ctx, "customer.statement_copy_set", "customer", customer.id,
      { statementCopyContactId: customer.copyContactId }, { statementCopyContactId: person?.id ?? null });
    return { customerId: customer.id, contactId: person?.id ?? null, name: person?.name ?? null };
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  emailCustomerStatement: (ctx: ServiceContext, input: {
    id: string; email?: string | undefined; from?: string | undefined; to?: string | undefined;
    copyContactId?: string | undefined;
  }) => emailStatement(ctx, input),
  getStatementCopy: (ctx: ServiceContext, input: { id: string }) => statementCopies(ctx, input),
  setStatementCopy: (ctx: ServiceContext, input: { id: string; contactId: string | null }) => setStatementCopy(ctx, input),
  textCustomerStatement: (ctx: ServiceContext, input: {
    id: string; phone?: string | undefined; from?: string | undefined; to?: string | undefined;
  }) => textStatement(ctx, input),
  listStatementDeliveries: async (ctx: ServiceContext, input: { customerId?: string | undefined; limit?: number | undefined }) =>
    ({ deliveries: await deliveries(ctx, input) }),
} as const;
