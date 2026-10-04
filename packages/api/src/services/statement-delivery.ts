import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
}): { subject: string; text: string; html: string } {
  const period = `${said(input.from)} to ${said(input.to)}`;
  const subject = `Your statement from ${input.organizationName}`;
  const text = [
    `Hello ${input.customerName},`,
    "",
    `Your statement from ${input.organizationName} for ${period} is ready.`,
    "It lists every invoice, payment and credit in that time, and what is still open.",
    "A copy as of today is attached as a PDF; the link always shows it as it is now.",
    "",
    `Open your statement: ${input.url}`,
    "",
    "The link opens your account without a password. Reply to this email if anything looks wrong.",
    "",
    input.organizationName,
  ].join("\n");
  const fill = input.color ?? "#111827";
  const onFill = input.on ?? "#ffffff";
  const html = [
    `<div style="font-family:system-ui,sans-serif;color:#111827;max-width:560px">`,
    `<p>Hello ${escapeHtml(input.customerName)},</p>`,
    `<p>Your statement from ${escapeHtml(input.organizationName)} for ${escapeHtml(period)} is ready. `
    + `It lists every invoice, payment and credit in that time, and what is still open.</p>`,
    `<p>A copy as of today is attached as a PDF; the link always shows it as it is now.</p>`,
    `<p><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:10px 16px;`
    + `background:${escapeHtml(fill)};color:${escapeHtml(onFill)};text-decoration:none;border-radius:6px">`
    + `Open your statement</a></p>`,
    `<p style="font-size:14px;color:#4b5563">The link opens your account without a password. `
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
}): Promise<StatementSendResult | null> {
  const organizationId = ctx.actor.organizationId;
  const statement = await buildStatement(tx, organizationId, input.customerId, {
    ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}),
  });

  const [customer] = await tx.select({ email: schema.customer.email })
    .from(schema.customer).where(eq(schema.customer.id, input.customerId)).limit(1);
  const emailTo = (input.channel === "email" ? input.address ?? customer?.email ?? "" : customer?.email ?? "").trim();
  const textTo = input.channel === "sms"
    ? (input.address ?? (await preferenceOf(tx, input.customerId)).phone ?? "").trim()
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
    const printed = await statementFileWithin(tx, organizationId, statement);
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
  const note = textRefusal ? `Not texted: ${textRefusal} Emailed instead.` : null;

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
      state: "refused", note: null, explanation, portalUrl: "",
    };
  }

  await tx.update(schema.statementDelivery).set({
    messageId: outcome.messageId, channel, destination: outcome.destination, note,
  }).where(eq(schema.statementDelivery.id, row.id));
  return {
    deliveryId: row.id, customerId: input.customerId, channel, destination: outcome.destination,
    state: "queued", note, explanation: null, portalUrl: url,
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

    const result = await sendOne(tx, ctx, {
      customerId: customer.id,
      channel: input.channel,
      address: typed || null,
      from: input.from, to: input.to,
      period: null,
    });
    // A hand sent row has no period, so the unique index never applies to it.
    if (!result) throw new ConflictError("This statement could not be recorded.");

    await audit(tx, ctx, result.state === "queued" ? "statement.sent" : "statement.refused",
      "customer", customer.id, null, {
        deliveryId: result.deliveryId, channel: result.channel, to: result.destination, explanation: result.explanation,
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
}): Promise<StatementSendResult> {
  return sendByHand(ctx, { id: input.id, channel: "email", address: input.email, from: input.from, to: input.to });
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
  return {
    deliveryId: row.id, customerId: row.customerId, channel: row.channel as StatementChannel,
    destination: row.destination, state: row.messageId ? "queued" : "refused", note: row.note,
    explanation: row.error, portalUrl: "",
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
    month: month.key, owing: owing.length, queued: 0, refused: 0, alreadySent: 0, texted: 0, emailedInstead: 0,
  };
  for (const { customer_id: customerId } of owing) {
    const texts = input.textWhenPreferred === true && (await preferenceOf(tx, customerId)).prefersText;
    const sent = await sendOne(tx, ctx, {
      customerId, channel: texts ? "sms" : "email", address: null, from: month.from, to: month.to,
      period: month.key, scheduleId: input.scheduleId, fallBack: true,
    });
    if (!sent) result.alreadySent += 1;
    else if (sent.state === "queued") {
      result.queued += 1;
      if (sent.channel === "sms") result.texted += 1;
      if (sent.note) result.emailedInstead += 1;
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
  closingBalance: string | null;
  /** The outbox's own word for the message, or null when nothing was queued. */
  messageStatus: string | null;
  error: string | null;
  note: string | null;
  createdAt: Date;
}

/** Statements sent, newest first, for one customer or for everybody. */
export function deliveries(ctx: ServiceContext, input: { customerId?: string | undefined; limit?: number | undefined } = {}) {
  return guardedRead(ctx, "invoice:read", async (tx): Promise<StatementDeliveryRecord[]> => {
    const rows = await tx.select({
      row: schema.statementDelivery,
      customerName: schema.customer.name,
      messageStatus: schema.message.status,
    })
      .from(schema.statementDelivery)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.statementDelivery.customerId))
      .leftJoin(schema.message, eq(schema.message.id, schema.statementDelivery.messageId))
      .where(input.customerId ? eq(schema.statementDelivery.customerId, input.customerId) : undefined)
      .orderBy(desc(schema.statementDelivery.createdAt))
      .limit(Math.min(input.limit ?? 50, 200));
    return rows.map(({ row, customerName, messageStatus }) => ({
      id: row.id,
      customerId: row.customerId,
      customerName,
      period: row.period,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      channel: row.channel as StatementChannel,
      destination: row.destination,
      closingBalance: row.closingBalance === null ? null : m.toString(m.round(usd(row.closingBalance), 2)),
      messageStatus: messageStatus ?? null,
      error: row.error,
      note: row.note,
      createdAt: row.createdAt,
    }));
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  emailCustomerStatement: (ctx: ServiceContext, input: {
    id: string; email?: string | undefined; from?: string | undefined; to?: string | undefined;
  }) => emailStatement(ctx, input),
  textCustomerStatement: (ctx: ServiceContext, input: {
    id: string; phone?: string | undefined; from?: string | undefined; to?: string | undefined;
  }) => textStatement(ctx, input),
  listStatementDeliveries: async (ctx: ServiceContext, input: { customerId?: string | undefined; limit?: number | undefined }) =>
    ({ deliveries: await deliveries(ctx, input) }),
} as const;
