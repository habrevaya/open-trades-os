import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { branding as brand, money as m, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import * as email from "./email";
import * as payments from "./payments";
import {
  consume, inGrant, mintGrant, peek, requireScope, type ResolvedGrant,
} from "./portal";

/**
 * ACTUALLY SENDING AN INVOICE
 *
 * `invoice_delivery` has been in the schema since the first migration. Nothing
 * had ever written a row, which meant a company using this product could raise
 * an invoice and then had no way to put it in front of the person who owes the
 * money. The permission `invoice:send` was on the Finance, Office Manager and
 * Customer Service roles and nothing asserted it, so an owner reading those
 * role lists believed they had granted something that did not exist.
 *
 * THIS SERVICE IS A COMPOSER, NOT A TRANSPORT. The email goes out through
 * `services/email.ts`, which already owns consent, the suppression list, the
 * outbox and the provider callbacks. Writing a second path to a mail provider
 * would be a second place to forget the suppression check, which is the exact
 * failure `comms-send.ts` was written to prevent. Likewise the link is a
 * portal grant, minted by `portal.mintGrant`, because a second token mechanism
 * is a second chance to get entropy, hashing or expiry wrong.
 *
 * WHAT IT ADDS is the one thing neither of those can know: that this
 * particular email was an invoice, which invoice, and therefore that a bounce
 * on Tuesday explains an unpaid balance on Friday.
 *
 * TWO CHANNELS, AND THE ONES THAT ARE NOT HERE
 *
 * `email` is the whole path: compose, queue, record, and follow the outcome.
 * `portal_link` mints the link and records that it was handed over, for the
 * case where email is suppressed or the customer asks for it another way. The
 * enum also carries `fm_network_api`, `cxml`, `edi`, `mail` and `manual`,
 * which are the commercial submission routes. Those are not built, and the
 * columns they need (`external_reference`, `accepted_at`, `disputed_at`,
 * `dispute_reason`) are deliberately left null by this service rather than
 * repurposed: an acceptance and a dispute are events those networks report
 * back, and email has neither.
 *
 * SMS IS NOT A CHANNEL HERE, AND THAT IS A DECISION.
 *
 * `comms-send.sendTransactional` exists and would work, and people do want an
 * invoice by text. It is not supported for two reasons. The enum on this
 * table has no `sms` value, which is the schema saying the same thing: what a
 * text can carry is a link, not a document, and a link handed out by text is
 * already expressible as a `portal_link` delivery that the operator pastes
 * into the thread. And an unexpected text containing a short link that asks
 * for a card payment is the exact shape of the message carriers filter and
 * that consumers are told never to tap, so sending one is a good way to get a
 * company's number blocked and its customers trained to ignore it.
 *
 * STATEMENTS ARE OUT OF SCOPE, SAID OUT LOUD.
 *
 * Sending several invoices at once is a real thing a commercial book needs,
 * and it is not half built here. A statement is a different document with its
 * own period, its own ageing columns and its own opening balance, it needs a
 * grant scope that can cover a customer rather than one invoice, and the
 * payment behind it allocates across invoices rather than settling one. Each
 * of those is a decision, and a loop over `send` would produce one email per
 * invoice, which is not a statement, it is a mailshot.
 */

/* ------------------------------------------------------------- the state */

/**
 * What happened to one attempt, as a single word.
 *
 * Derived on read from the delivery row and the message it points at, and
 * NEVER stored. A status column here would be a second copy of a fact that
 * `services/email.ts` owns and updates from provider callbacks, and the copy
 * is always the one being read on the day it is wrong.
 */
export type DeliveryState =
  /** A row exists and nothing was ever handed to a transport. See `send`. */
  | "interrupted"
  /** The transport refused before anything left: suppressed, no consent, no provider. */
  | "refused"
  /** A link was minted and given to the operator. Nothing more is knowable. */
  | "link_issued"
  /** In the outbox. No provider has seen it yet. */
  | "queued"
  /** A provider accepted it. On an SMTP relay this is the last thing ever known. */
  | "sent"
  /** A receiving server accepted it. */
  | "delivered"
  /** The receiving end refused it. The customer did not get their invoice. */
  | "bounced"
  /** We never got as far as a conversation with the receiving end. */
  | "failed";

/**
 * The states that mean the customer may never have seen this invoice.
 *
 * `queued` and `sent` are not here. Queued is in flight, and `sent` is all an
 * SMTP relay will ever say, so treating either as a problem would fill an
 * operator's list with every invoice they send through a self hosted relay
 * and teach them to ignore the list.
 */
const NOT_RECEIVED: readonly DeliveryState[] = [
  "interrupted", "refused", "bounced", "failed",
];

export const isUndelivered = (state: DeliveryState): boolean =>
  NOT_RECEIVED.includes(state);

interface DeliveryRowShape {
  channel: string;
  submittedAt: Date | null;
  error: string | null;
  messageId: string | null;
  messageStatus: string | null;
}

/**
 * The derivation, in one place, used by every read in this file.
 *
 * Exported so a test can drive it over every message status without a
 * database, and because two call sites deciding separately what "bounced"
 * means is how a list screen and a detail screen come to disagree about the
 * same row.
 */
export function stateOf(row: DeliveryRowShape): DeliveryState {
  /**
   * The refusal wins over everything. A row with an error was refused before
   * a transport saw it, so there is no message to ask and no later fact that
   * can overtake it.
   */
  if (row.error !== null) return "refused";
  if (row.channel === "portal_link") {
    return row.submittedAt === null ? "interrupted" : "link_issued";
  }
  /**
   * No message and no error means `send` wrote the attempt and then did not
   * finish. That is the state this whole shape exists to make visible: the
   * alternative is an invoice nobody sent, nobody knows was not sent, and
   * nobody chases.
   */
  if (row.messageId === null || row.messageStatus === null) return "interrupted";

  switch (row.messageStatus) {
    case "queued": case "sending": return "queued";
    case "sent": return "sent";
    case "delivered": return "delivered";
    case "undelivered": return "bounced";
    case "failed": return "failed";
    /**
     * `received` is an inbound status and cannot appear on a message this
     * service created. Answering `sent` rather than throwing keeps a list
     * screen rendering if one ever does, since a wrong word on one row is
     * better than a screen that will not open.
     */
    default: return "sent";
  }
}

/* -------------------------------------------------------------- composing */

/** Default life of an invoice link, in days. */
const LINK_DAYS = 60;

/**
 * Long, and deliberately longer than most payment terms.
 *
 * A link that expires before the invoice is due is a customer who opens it on
 * the day they meant to pay and cannot, and the company hears about that as a
 * late payment rather than as a broken link. The ceiling is a year because a
 * document that can be opened forever by anyone holding a forwarded email is
 * not a document anybody wanted to publish.
 */
const MAX_LINK_DAYS = 365;

interface InvoiceForSend {
  id: string;
  number: number;
  customerId: string;
  jobId: string | null;
  status: string;
  currency: string;
  total: string;
  balance: string;
  dueOn: string | null;
  issuedOn: string | null;
  customerName: string;
  customerEmail: string | null;
  payerEmail: string | null;
  payerCustomerId: string | null;
}

async function loadForSend(tx: Database, invoiceId: string): Promise<InvoiceForSend> {
  const [row] = await tx.select({
    id: schema.invoice.id,
    number: schema.invoice.number,
    customerId: schema.invoice.customerId,
    jobId: schema.invoice.jobId,
    status: schema.invoice.status,
    currency: schema.invoice.currency,
    total: schema.invoice.total,
    balance: schema.invoice.balance,
    dueOn: schema.invoice.dueOn,
    issuedOn: schema.invoice.issuedOn,
    payerCustomerId: schema.invoice.payerCustomerId,
    customerName: schema.customer.name,
    customerEmail: schema.customer.email,
  })
    .from(schema.invoice)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
    .where(and(eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt)))
    .limit(1);

  if (!row) throw new NotFoundError("Invoice");

  /**
   * THE PAYER IS FREQUENTLY NOT THE CUSTOMER.
   *
   * A warranty company, an insurer, a property manager or a builder paying on
   * draws is who owes the money, and the invoice already carries that in
   * `payer_customer_id`. Sending to the customer on a warranty job means the
   * homeowner gets a bill they do not owe and the company that does owe it
   * never sees one.
   */
  let payerEmail: string | null = null;
  if (row.payerCustomerId) {
    const [payer] = await tx.select({ email: schema.customer.email })
      .from(schema.customer)
      .where(eq(schema.customer.id, row.payerCustomerId))
      .limit(1);
    payerEmail = payer?.email ?? null;
  }

  return { ...row, payerEmail };
}

/** The company's own name and colour, read in the caller's transaction. */
async function identityOf(tx: Database, organizationId: string) {
  const [org] = await tx.select({
    name: schema.organization.name,
    color: schema.organization.brandColor,
  })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);

  /**
   * `branding.current` is not called, although this is its subject, because
   * it opens its own transaction and this runs inside one. The derivation is
   * core's, same as there, so the button on an invoice email is the same
   * colour as the button in the application.
   */
  const color = org?.color ? brand.parseColor(org.color) : null;
  return {
    name: org?.name ?? "",
    color,
    on: color ? brand.readableOn(color) : null,
  };
}

const money = (value: string, currency: string) =>
  m.format(m.money(value, currency));

/**
 * The date as written, not reformatted.
 *
 * `due_on` is a Postgres `date`, which has no time and therefore no zone. Any
 * conversion to a Date here would attach one and move the day for roughly
 * half the planet, and a due date that is off by one is a late fee somebody
 * has to argue about.
 */
function dueLine(dueOn: string | null): string | null {
  if (!dueOn) return null;
  const parts = dueOn.split("-");
  const [year, month, day] = [parts[0], parts[1], parts[2]];
  if (!year || !month || !day) return dueOn;
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}, ${year}`;
}

/** Escaped at the point of interpolation, because the note is operator typed. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

interface Composed {
  subject: string;
  text: string;
  html: string;
}

/**
 * The document, in both parts.
 *
 * BOTH PARTS ALWAYS. `email.queue` refuses HTML with no plain text
 * alternative, and it is right to: HTML alone is one of the strongest spam
 * signals there is, and the text part is what a screen reader and a watch
 * face actually read out. Generating the text by stripping tags would produce
 * something unreadable and call it an alternative, so it is written here.
 */
function compose(input: {
  invoice: InvoiceForSend;
  organizationName: string;
  color: string | null;
  on: string | null;
  url: string;
  note: string | null;
  payable: boolean;
}): Composed {
  const { invoice, organizationName, url, note, payable } = input;
  const balance = money(invoice.balance, invoice.currency);
  const total = money(invoice.total, invoice.currency);
  const due = dueLine(invoice.dueOn);

  const subject = `Invoice ${invoice.number} from ${organizationName}`;

  const action = payable ? "View and pay your invoice" : "View your invoice";
  const amountLine = payable
    ? `Amount due: ${balance}${due ? ` by ${due}` : ""}`
    : `Invoice total: ${total}. Nothing is outstanding.`;

  const text = [
    `Hello ${invoice.customerName},`,
    "",
    `Invoice ${invoice.number} from ${organizationName} is ready.`,
    amountLine,
    "",
    ...(note ? [note, ""] : []),
    `${action}:`,
    url,
    "",
    /**
     * Named rather than left implicit. A customer who cannot open a link
     * needs to know who to ring, and an invoice email with no sender in the
     * body reads as a phishing attempt even when it is not.
     */
    `This link opens your invoice without an account. Reply to this email if anything looks wrong.`,
    organizationName,
  ].join("\n");

  const fill = input.color ?? "#1f2937";
  const onFill = input.on ?? "#ffffff";
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;`
    + `font-size:16px;line-height:1.5;color:#111827;max-width:560px">`,
    `<p>Hello ${escapeHtml(invoice.customerName)},</p>`,
    `<p>Invoice ${invoice.number} from ${escapeHtml(organizationName)} is ready.<br>`,
    `<strong>${escapeHtml(amountLine)}</strong></p>`,
    ...(note ? [`<p>${escapeHtml(note)}</p>`] : []),
    `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;`
    + `background:${escapeHtml(fill)};color:${escapeHtml(onFill)};text-decoration:none;`
    + `border-radius:6px">${escapeHtml(action)}</a></p>`,
    `<p style="font-size:14px;color:#4b5563">This link opens your invoice without an `
    + `account. Reply to this email if anything looks wrong.</p>`,
    `<p style="font-size:14px;color:#4b5563">${escapeHtml(organizationName)}</p>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

/* ------------------------------------------------------------- the sending */

export interface SendInvoiceInput {
  invoiceId: string;
  /**
   * Where to send it, when it is not the address on the customer record. A
   * commercial client's accounts payable mailbox is rarely the one on the
   * contact who booked the work.
   */
  to?: string | undefined;
  /**
   * `email` composes and queues the document. `portal_link` mints the link
   * and records that it was handed over, for the customer who asks for it
   * another way or whose address is suppressed. Defaults to email.
   */
  channel?: "email" | "portal_link" | undefined;
  /**
   * An acknowledgement, not a flag. See the comment on the double send guard
   * below: without it a second send of the same invoice is refused.
   */
  resend?: boolean | undefined;
  /** One line from the operator, placed above the link. */
  note?: string | undefined;
  linkExpiresInDays?: number | undefined;
}

export interface SendInvoiceResult {
  deliveryId: string;
  invoiceId: string;
  channel: "email" | "portal_link";
  /** Which attempt this is for this invoice, counting from one. */
  attempt: number;
  destination: string | null;
  state: DeliveryState;
  portalUrl: string;
  messageId: string | null;
  /** Set when the transport refused. Null on a send that was handed over. */
  reason: string | null;
  explanation: string | null;
}

/**
 * The transport's own permission, added to the caller's.
 *
 * `email.queue` is guarded by `message:send`, and THE FINANCE ROLE DOES NOT
 * HOLD IT. Look at `ROLE_PRESETS.accountant`: it holds `invoice:read`,
 * `invoice:write`, `invoice:send`, `invoice:void` and `invoice:writeoff`, and
 * neither `message:send` nor `portal:grant`. That role exists to send
 * invoices. Requiring the transport's permission as well would mean the one
 * role whose job this is cannot do it, and an operator would fix it by
 * granting Finance the ability to text customers, which is not what they
 * wanted to grant.
 *
 * So the authority for this action is `invoice:send`, asserted by the guard
 * on `send` before anything here runs, and the transport permission is passed
 * down as an implementation detail. It is added to `grants` rather than
 * applied some other way, so a company that has explicitly REVOKED
 * `message:send` from this person still wins: revocation beats a grant in
 * `permissionsFor`, and somebody who was deliberately barred from messaging
 * customers should stay barred.
 *
 * The actor's user id is unchanged, so the audit line still names the person
 * who clicked send rather than a synthetic sender.
 */
function transportContext(ctx: ServiceContext, tx: Database): ServiceContext {
  const actor: Actor = {
    ...ctx.actor,
    grants: [...(ctx.actor.grants ?? []), "message:send"],
  };
  return { ...ctx, actor, db: tx };
}

/**
 * Send one invoice to one address, and record the attempt.
 *
 * EVERYTHING HAPPENS IN ONE TRANSACTION, including the queueing of the email.
 * `email.queue` opens a nested transaction, which drizzle implements as a
 * savepoint on the connection this one already holds, so the delivery row and
 * the message row commit together or neither exists. That is what makes the
 * two bad outcomes different sizes:
 *
 * A DOUBLE SEND IS AN ANNOYANCE AND IS MADE VISIBLE. Every attempt is its own
 * row, numbered, with its own address and its own outcome, and a second send
 * of an invoice that has already gone out is REFUSED unless the caller passes
 * `resend: true`. So a double click cannot produce a second email by
 * accident, and a deliberate resend is a row somebody can point at.
 *
 * AN INVOICE NOBODY SENT IS A RECEIVABLE NOBODY CHASES, AND IS MADE
 * IMPOSSIBLE. A refusal from the transport is not thrown away and is not
 * thrown as an error either: it is written to `invoice_delivery.error`, the
 * result says `state: "refused"`, and `undelivered` below lists it beside the
 * money still outstanding. If this process dies mid send, the row either does
 * not exist at all, in which case the invoice reads as never sent, or it
 * exists with no message and reads as `interrupted`. There is no arrangement
 * of failures that produces a silent success.
 */
export function send(ctx: ServiceContext, input: SendInvoiceInput): Promise<SendInvoiceResult> {
  return guardedWrite(ctx, "invoice:send", async (tx): Promise<SendInvoiceResult> => {
    /**
     * A retried request is the same send, not a second one. Same mechanism
     * `billing.create` uses, on the same table, so a lost response from a
     * phone on bad signal does not mail the customer twice.
     */
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "invoice_delivery"),
        )).limit(1);
      if (seen?.entityId) return replay(tx, seen.entityId);
    }

    const invoice = await loadForSend(tx, input.invoiceId);

    /**
     * A DRAFT IS NOT A DOCUMENT. Numbers on a draft are still being edited,
     * and an invoice a customer has already received cannot be quietly
     * changed afterwards without the two copies disagreeing.
     */
    if (invoice.status === "draft") {
      throw new ConflictError(
        "This invoice is still a draft. Issue it before sending it: a customer holding a "
        + "copy of a document that is still being edited is two invoices that disagree.",
      );
    }
    if (invoice.status === "void") {
      throw new ConflictError("This invoice has been voided. There is nothing to collect.");
    }

    const channel = input.channel ?? "email";
    const prior = await attemptsFor(tx, invoice.id);

    /**
     * THE DOUBLE SEND GUARD.
     *
     * A previous attempt that was refused or interrupted does NOT block a
     * retry, and that asymmetry is the point. Refusing to retry a send that
     * never left would turn a transient configuration problem into an
     * invoice that can never be sent, which is the failure this service
     * exists to end. Refusing to repeat a send that DID leave is cheap, and
     * the caller says `resend: true` when they mean it.
     */
    const live = prior.filter((p) => !isUndelivered(p.state));
    if (live.length > 0 && input.resend !== true) {
      const last = live[live.length - 1]!;
      throw new ConflictError(
        `Invoice ${invoice.number} was already sent to ${last.destination ?? "a link"} on `
        + `${last.createdAt.toISOString().slice(0, 10)} and the send is `
        + `${last.state}. Pass resend to send it again.`,
      );
    }

    const attempt = prior.length + 1;
    const identity = await identityOf(tx, ctx.actor.organizationId);

    /**
     * The link is minted inside this transaction, through the portal's own
     * token mechanism. If anything below fails, the grant rolls back with it
     * rather than leaving a live link to a document nobody sent.
     */
    const days = Math.min(input.linkExpiresInDays ?? LINK_DAYS, MAX_LINK_DAYS);
    const grant = await mintGrant(tx, {
      organizationId: ctx.actor.organizationId,
      /**
       * The grant belongs to the PAYER when there is one. The portal resolves
       * who a caller is from the grant, so pointing it at the customer on a
       * warranty job would show the homeowner's name on a document the
       * warranty company is paying.
       */
      customerId: invoice.payerCustomerId ?? invoice.customerId,
      scope: "invoice",
      subjectId: invoice.id,
      expiresInDays: days,
      /**
       * No use limit. A customer opens an invoice, goes to find a card, and
       * comes back, and every refresh of the page would otherwise burn one.
       * The expiry and `portal:revoke` are the controls that work here.
       */
      maxUses: null,
    });

    const payable = m.isPositive(m.money(invoice.balance, invoice.currency));

    if (channel === "portal_link") {
      const [row] = await tx.insert(schema.invoiceDelivery).values({
        organizationId: ctx.actor.organizationId,
        invoiceId: invoice.id,
        channel: "portal_link",
        /**
         * Null, on purpose. Nobody knows where the operator is about to paste
         * this, and inventing an address would make the delivery log claim
         * something it cannot stand behind.
         */
        destination: null,
        portalGrantId: grant.row.id,
        submittedAt: new Date(),
      }).returning({ id: schema.invoiceDelivery.id });

      await recordSendEvent(tx, ctx, invoice, row!.id, { channel: "portal_link", to: null, attempt });

      return {
        deliveryId: row!.id,
        invoiceId: invoice.id,
        channel: "portal_link",
        attempt,
        destination: null,
        state: "link_issued",
        portalUrl: grant.url,
        messageId: null,
        reason: null,
        explanation: null,
      };
    }

    const to = (input.to ?? invoice.payerEmail ?? invoice.customerEmail ?? "").trim();
    if (to === "") {
      /**
       * Thrown rather than recorded. There is no address, so there is no
       * attempt: writing a delivery row with a null destination here would
       * put a row in the log that looks like a send to nowhere, and the real
       * answer is that somebody has to put an email address on the customer.
       */
      throw new ConflictError(
        `${invoice.customerName} has no email address on file and none was given, so there is `
        + "nowhere to send this. Add one, or issue a portal link and hand it over another way.",
      );
    }

    /**
     * THE ROW IS WRITTEN BEFORE THE TRANSPORT IS CALLED, in the same
     * transaction. The insert is first so that there is no ordering in which
     * a message exists and the delivery that explains it does not.
     */
    const [row] = await tx.insert(schema.invoiceDelivery).values({
      organizationId: ctx.actor.organizationId,
      invoiceId: invoice.id,
      channel: "email",
      destination: to,
      portalGrantId: grant.row.id,
    }).returning({ id: schema.invoiceDelivery.id });
    const deliveryId = row!.id;

    const composed = compose({
      invoice,
      organizationName: identity.name,
      color: identity.color,
      on: identity.on,
      url: grant.url,
      note: input.note?.trim() ? input.note.trim() : null,
      payable,
    });

    /**
     * TRANSACTIONAL, AND THERE IS NO UNSUBSCRIBE LINK ON IT.
     *
     * An invoice is implied by the work, exactly as an appointment
     * confirmation is, so it goes without a marketing consent row. An
     * unsubscribe control on an invoice would offer a choice the company
     * cannot honour, because it still has to send the next one. A revocation
     * or a suppression still stops it, which is handled inside `email.queue`
     * and is why the refusal below is a real outcome rather than a
     * formality.
     */
    const outcome = await email.queue(transportContext(ctx, tx), {
      to,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      purpose: "transactional",
      customerId: invoice.payerCustomerId ?? invoice.customerId,
    });

    if (!outcome.queued) {
      await tx.update(schema.invoiceDelivery).set({
        error: `${outcome.reason}: ${outcome.explanation}`,
        updatedAt: new Date(),
      }).where(eq(schema.invoiceDelivery.id, deliveryId));

      await audit(tx, ctx, "invoice.delivery_refused", "invoice", invoice.id, null, {
        deliveryId, channel: "email", to, attempt, reason: outcome.reason,
      });

      return {
        deliveryId,
        invoiceId: invoice.id,
        channel: "email",
        attempt,
        destination: to,
        state: "refused",
        portalUrl: grant.url,
        messageId: null,
        reason: outcome.reason,
        explanation: outcome.explanation,
      };
    }

    await tx.update(schema.invoiceDelivery).set({
      messageId: outcome.messageId,
      submittedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.invoiceDelivery.id, deliveryId));

    await recordSendEvent(tx, ctx, invoice, deliveryId, { channel: "email", to, attempt });

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "invoice.send",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "invoice_delivery", entityId: deliveryId,
      });
    }

    return {
      deliveryId,
      invoiceId: invoice.id,
      channel: "email",
      attempt,
      destination: to,
      state: "queued",
      portalUrl: grant.url,
      messageId: outcome.messageId,
      reason: null,
      explanation: null,
    };
  });
}

/**
 * The audit line and the customer's own timeline, written together.
 *
 * `portal_event` is only written when the invoice belongs to a job, because
 * the tracking page is keyed on one. An invoice raised against no job has
 * nowhere to show it, and writing a row with a null job id would put an entry
 * in a table whose only reader filters by job.
 */
async function recordSendEvent(
  tx: Database, ctx: ServiceContext, invoice: InvoiceForSend, deliveryId: string,
  detail: { channel: string; to: string | null; attempt: number },
): Promise<void> {
  await audit(tx, ctx, "invoice.sent", "invoice", invoice.id, null, {
    deliveryId, ...detail,
  });

  if (invoice.jobId) {
    await tx.insert(schema.portalEvent).values({
      organizationId: ctx.actor.organizationId,
      customerId: invoice.payerCustomerId ?? invoice.customerId,
      jobId: invoice.jobId,
      kind: "invoice_sent",
      headline: `Invoice ${invoice.number} sent`,
      isCustomerVisible: true,
    });
  }
}

interface Attempt {
  id: string;
  channel: string;
  destination: string | null;
  createdAt: Date;
  state: DeliveryState;
}

/** Every attempt for one invoice, oldest first, with its derived state. */
async function attemptsFor(tx: Database, invoiceId: string): Promise<Attempt[]> {
  const rows = await tx.select({
    id: schema.invoiceDelivery.id,
    channel: schema.invoiceDelivery.channel,
    destination: schema.invoiceDelivery.destination,
    createdAt: schema.invoiceDelivery.createdAt,
    submittedAt: schema.invoiceDelivery.submittedAt,
    error: schema.invoiceDelivery.error,
    messageId: schema.invoiceDelivery.messageId,
    messageStatus: schema.message.status,
  })
    .from(schema.invoiceDelivery)
    .leftJoin(schema.message, eq(schema.message.id, schema.invoiceDelivery.messageId))
    /**
     * No `deleted_at is null`, and that is deliberate rather than forgotten.
     * A delivery attempt is something that happened, so nothing in this
     * product deletes one and no surface offers to. A filter on a column
     * nothing ever writes is decoration that reads as a safeguard, and the
     * next person adds a second one beside it.
     */
    .where(eq(schema.invoiceDelivery.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceDelivery.createdAt));

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    destination: row.destination,
    createdAt: row.createdAt,
    state: stateOf(row),
  }));
}

/** What a retry of the same request answers with, built from the recorded row. */
async function replay(tx: Database, deliveryId: string): Promise<SendInvoiceResult> {
  const [row] = await tx.select({
    id: schema.invoiceDelivery.id,
    invoiceId: schema.invoiceDelivery.invoiceId,
    channel: schema.invoiceDelivery.channel,
    destination: schema.invoiceDelivery.destination,
    submittedAt: schema.invoiceDelivery.submittedAt,
    error: schema.invoiceDelivery.error,
    messageId: schema.invoiceDelivery.messageId,
    createdAt: schema.invoiceDelivery.createdAt,
    messageStatus: schema.message.status,
  })
    .from(schema.invoiceDelivery)
    .leftJoin(schema.message, eq(schema.message.id, schema.invoiceDelivery.messageId))
    .where(eq(schema.invoiceDelivery.id, deliveryId))
    .limit(1);

  if (!row) throw new NotFoundError("Invoice delivery");

  const earlier = await tx.select({ id: schema.invoiceDelivery.id })
    .from(schema.invoiceDelivery)
    .where(eq(schema.invoiceDelivery.invoiceId, row.invoiceId))
    .orderBy(asc(schema.invoiceDelivery.createdAt));

  return {
    deliveryId: row.id,
    invoiceId: row.invoiceId,
    channel: row.channel === "portal_link" ? "portal_link" : "email",
    attempt: Math.max(1, earlier.findIndex((e) => e.id === row.id) + 1),
    destination: row.destination,
    state: stateOf(row),
    /**
     * EMPTY ON A REPLAY, and that is not an oversight. The token exists once,
     * at the moment it is minted, and only its hash is stored. A retry cannot
     * be handed the link again, and inventing a second grant for it would
     * turn one retried request into two live links to the same document.
     */
    portalUrl: "",
    messageId: row.messageId,
    reason: null,
    explanation: null,
  };
}

/* ---------------------------------------------------------------- reading */

export interface DeliveryRecord {
  id: string;
  invoiceId: string;
  attempt: number;
  channel: string;
  destination: string | null;
  state: DeliveryState;
  /** Set when the transport refused this attempt before anything left. */
  error: string | null;
  /** When it was handed to a transport. Null on an interrupted or refused attempt. */
  submittedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  /** The provider's own words about why it did not arrive. */
  failureReason: string | null;
  /**
   * Somebody marked this email as spam. NOT a delivery failure: the message
   * arrived and a human read enough of it to press a button, so it is carried
   * beside the state rather than folded into it.
   */
  complained: boolean;
  messageId: string | null;
  portalGrantId: string | null;
  /** The link is dead, whether it expired or somebody withdrew it. */
  linkActive: boolean;
  createdAt: string;
}

/**
 * Every attempt on one invoice.
 *
 * `invoice:read` rather than `invoice:send`, because this answers a question
 * about the invoice. Somebody chasing a payment has to be able to see that
 * the invoice bounced without also being able to send it.
 */
export function history(ctx: ServiceContext, input: { invoiceId: string }) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const rows = await deliveriesFor(tx, input.invoiceId);
    return { deliveries: rows };
  });
}

async function deliveriesFor(tx: Database, invoiceId: string): Promise<DeliveryRecord[]> {
  const rows = await tx.select({
    id: schema.invoiceDelivery.id,
    invoiceId: schema.invoiceDelivery.invoiceId,
    channel: schema.invoiceDelivery.channel,
    destination: schema.invoiceDelivery.destination,
    submittedAt: schema.invoiceDelivery.submittedAt,
    error: schema.invoiceDelivery.error,
    messageId: schema.invoiceDelivery.messageId,
    portalGrantId: schema.invoiceDelivery.portalGrantId,
    createdAt: schema.invoiceDelivery.createdAt,
    messageStatus: schema.message.status,
    sentAt: schema.message.sentAt,
    deliveredAt: schema.message.deliveredAt,
    errorMessage: schema.message.errorMessage,
    errorCode: schema.message.errorCode,
    grantExpiresAt: schema.portalGrant.expiresAt,
    grantRevokedAt: schema.portalGrant.revokedAt,
  })
    .from(schema.invoiceDelivery)
    .leftJoin(schema.message, eq(schema.message.id, schema.invoiceDelivery.messageId))
    .leftJoin(schema.portalGrant, eq(schema.portalGrant.id, schema.invoiceDelivery.portalGrantId))
    /** Never filtered on `deleted_at`. See `attemptsFor`. */
    .where(eq(schema.invoiceDelivery.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceDelivery.createdAt));

  /**
   * A spam complaint changes no message status, by design in
   * `services/email.ts`: the message arrived, and overwriting that with
   * "undelivered" would hide the one signal that predicts a sending domain
   * being blocked. So it is read from the suppression the complaint wrote,
   * which is the only record of it.
   */
  const messageIds = rows.map((r) => r.messageId).filter((id): id is string => id !== null);
  const complaints = new Set<string>();
  if (messageIds.length > 0) {
    const found = await tx.select({ sourceMessageId: schema.suppression.sourceMessageId })
      .from(schema.suppression)
      .where(and(
        eq(schema.suppression.reason, "spam_complaint"),
        inArray(schema.suppression.sourceMessageId, messageIds),
      ));
    for (const row of found) {
      if (row.sourceMessageId) complaints.add(row.sourceMessageId);
    }
  }

  const now = Date.now();
  return rows.map((row, index) => ({
    id: row.id,
    invoiceId: row.invoiceId,
    attempt: index + 1,
    channel: row.channel,
    destination: row.destination,
    state: stateOf(row),
    error: row.error,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    failureReason: row.errorMessage ?? row.errorCode ?? null,
    complained: row.messageId !== null && complaints.has(row.messageId),
    messageId: row.messageId,
    portalGrantId: row.portalGrantId,
    linkActive: row.grantExpiresAt !== null && row.grantExpiresAt !== undefined
      && row.grantRevokedAt === null && row.grantExpiresAt.getTime() > now,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * A timestamp out of a raw `execute`, whatever the driver decoded it as.
 *
 * Drizzle's typed query builder hands back a Date. `execute` hands back
 * whatever the underlying driver produced for the column, which for a
 * timestamptz may be a string, and calling `toISOString` on one of those
 * throws inside the map rather than at the query. The query below is written
 * out by hand because it needs a lateral join, so it does not get the
 * builder's decoding and has to do this itself.
 */
function asDate(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export interface UndeliveredInvoice {
  invoiceId: string;
  number: number;
  customerId: string;
  customerName: string;
  balance: string;
  currency: string;
  dueOn: string | null;
  /** Null when nothing was ever attempted. */
  deliveryId: string | null;
  channel: string | null;
  destination: string | null;
  state: DeliveryState | "never_attempted";
  failureReason: string | null;
  lastAttemptAt: string | null;
}

/**
 * MONEY OUTSTANDING THAT THE CUSTOMER MAY NEVER HAVE SEEN.
 *
 * This is the screen the whole feature is for. A bounced invoice and a late
 * payer look identical on an ageing report: both are an open balance past its
 * due date. They need opposite responses. The late payer gets chased. The
 * bounced one gets a correct address, because chasing somebody for an invoice
 * that never reached them is how a company loses a customer it was in the
 * right with.
 *
 * It is ordered by due date because that is the order the money is owed in,
 * and it includes invoices with NO delivery attempt at all, which is the
 * quietest version of the same problem: nobody even tried.
 */
export function undelivered(ctx: ServiceContext, input: { limit?: number | undefined } = {}) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    /**
     * Written out rather than assembled in drizzle, because the shape is a
     * lateral join to the most recent attempt per invoice and there is no
     * honest way to express "the latest one" as a plain join. Row level
     * security applies to every table named here exactly as it does to a
     * drizzle query: this runs inside the tenant transaction.
     */
    const rows = await tx.execute<{
      invoice_id: string;
      number: number;
      customer_id: string;
      customer_name: string;
      balance: string;
      currency: string;
      due_on: string | null;
      delivery_id: string | null;
      channel: string | null;
      destination: string | null;
      submitted_at: string | Date | null;
      error: string | null;
      message_id: string | null;
      message_status: string | null;
      failure_reason: string | null;
      created_at: string | Date | null;
    }>(sql`
      select i.id as invoice_id, i.number, i.customer_id, c.name as customer_name,
             i.balance::text as balance, i.currency, i.due_on::text as due_on,
             d.id as delivery_id, d.channel::text as channel, d.destination,
             d.submitted_at, d.error, d.message_id, d.created_at,
             mm.status::text as message_status,
             coalesce(mm.error_message, mm.error_code) as failure_reason
      from public.invoice i
      join public.customer c on c.id = i.customer_id
      left join lateral (
        select dd.* from public.invoice_delivery dd
        where dd.invoice_id = i.id
        order by dd.created_at desc
        limit 1
      ) d on true
      left join public.message mm on mm.id = d.message_id
      where i.deleted_at is null
        and i.status in ('open', 'partially_paid')
        and i.balance > 0
        and (
          d.id is null
          or d.error is not null
          or d.submitted_at is null
          or mm.status in ('undelivered', 'failed')
        )
      order by i.due_on asc nulls last, i.number asc
      limit ${limit}
    `);

    return {
      invoices: rows.map((row): UndeliveredInvoice => ({
        invoiceId: row.invoice_id,
        number: row.number,
        customerId: row.customer_id,
        customerName: row.customer_name,
        balance: row.balance,
        currency: row.currency,
        dueOn: row.due_on,
        deliveryId: row.delivery_id,
        channel: row.channel,
        destination: row.destination,
        state: row.delivery_id === null ? "never_attempted" : stateOf({
          channel: row.channel ?? "email",
          submittedAt: asDate(row.submitted_at),
          error: row.error,
          messageId: row.message_id,
          messageStatus: row.message_status,
        }),
        failureReason: row.failure_reason,
        lastAttemptAt: asDate(row.created_at)?.toISOString() ?? null,
      })),
    };
  });
}

/* ----------------------------------------------------------- the customer */

/**
 * THE CUSTOMER SIDE
 *
 * Everything below runs for somebody with no account, holding a link. The
 * rules are the portal's, not this file's: the subject comes from the grant
 * and never from the request, resolution runs through the SECURITY DEFINER
 * function that takes a hash the caller must already hold, and everything
 * afterwards runs inside the tenant boundary. `portal.inGrant` is called
 * rather than copied, because the one time that boundary was reimplemented it
 * left out the role switch and row level security was silently off for every
 * portal read.
 */

export interface PortalInvoiceLine {
  id: string;
  name: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

export interface PortalInvoice {
  organizationName: string;
  number: number;
  status: string;
  issuedOn: string | null;
  dueOn: string | null;
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balance: string;
  propertyAddress: string;
  lines: PortalInvoiceLine[];
  /** Whether the pay button should appear at all. */
  payable: boolean;
  /** False when the company has connected no processor. Nothing to click. */
  onlinePaymentAvailable: boolean;
}

/**
 * The invoice as the customer may see it.
 *
 * Built field by field rather than redacted from the office shape, exactly as
 * `shapeForCustomer` is in `portal.ts`. `unit_cost` is on every invoice line
 * and is not the customer's to have, and a shape built by deleting fields
 * leaks the next one somebody adds.
 */
export async function viewInvoice(db: Database, input: { token: string }): Promise<PortalInvoice> {
  /**
   * `peek`, not `consume`. A customer opens the invoice, goes to find a card
   * and comes back, and every refresh would otherwise spend a use.
   */
  const grant = await peek(db, input.token);
  const invoiceId = requireScope(grant, "invoice");

  return inGrant(db, grant, async (tx) => {
    const [invoice] = await tx.select({
      number: schema.invoice.number,
      status: schema.invoice.status,
      issuedOn: schema.invoice.issuedOn,
      dueOn: schema.invoice.dueOn,
      currency: schema.invoice.currency,
      subtotal: schema.invoice.subtotal,
      discountTotal: schema.invoice.discountTotal,
      taxTotal: schema.invoice.taxTotal,
      total: schema.invoice.total,
      amountPaid: schema.invoice.amountPaid,
      balance: schema.invoice.balance,
      propertyId: schema.invoice.propertyId,
    })
      .from(schema.invoice)
      .where(and(eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt)))
      .limit(1);
    if (!invoice) throw new NotFoundError("Invoice");

    const [org] = await tx.select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, grant.organizationId))
      .limit(1);

    const lines = await tx.select({
      id: schema.invoiceLine.id,
      name: schema.invoiceLine.name,
      description: schema.invoiceLine.description,
      quantity: schema.invoiceLine.quantity,
      unitPrice: schema.invoiceLine.unitPrice,
      lineTotal: schema.invoiceLine.lineTotal,
    })
      .from(schema.invoiceLine)
      .where(eq(schema.invoiceLine.invoiceId, invoiceId))
      .orderBy(asc(schema.invoiceLine.sortOrder));

    let propertyAddress = "";
    if (invoice.propertyId) {
      const [property] = await tx.select({
        line1: schema.property.addressLine1,
        city: schema.property.city,
        state: schema.property.state,
      })
        .from(schema.property)
        .where(eq(schema.property.id, invoice.propertyId))
        .limit(1);
      propertyAddress = [property?.line1, property?.city, property?.state]
        .filter(Boolean).join(", ");
    }

    const payable = m.isPositive(m.money(invoice.balance, invoice.currency));

    return {
      organizationName: org?.name ?? "",
      number: invoice.number,
      status: invoice.status,
      issuedOn: invoice.issuedOn,
      dueOn: invoice.dueOn,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      discountTotal: invoice.discountTotal,
      taxTotal: invoice.taxTotal,
      total: invoice.total,
      amountPaid: invoice.amountPaid,
      balance: invoice.balance,
      propertyAddress,
      lines,
      payable,
      onlinePaymentAvailable: payable && await processorConnected(tx),
    };
  });
}

/** Whether a pay button would lead anywhere. One indexed read. */
async function processorConnected(tx: Database): Promise<boolean> {
  const [row] = await tx.select({ id: schema.integrationConnection.id })
    .from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.capability, "payments"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    ))
    .limit(1);
  return row !== undefined;
}

/**
 * The actor a pay-now click runs as.
 *
 * IT HOLDS EXACTLY ONE PERMISSION, and this is the only place in the portal
 * where an actor holds any at all, so the reasoning is worth stating.
 *
 * `payments.intent` is guarded by `payment:collect`. A portal caller cannot
 * hold a permission, so without this there are two ways to build a pay link:
 * give the grant a permission, or write a second charge path that does not go
 * through `payments.intent`. The second is strictly worse, because that
 * function is where the amount is read from the invoice balance rather than
 * taken from the browser, and a second path would be the one that trusts the
 * number a browser sent.
 *
 * What this actor can actually do is bounded by the grant above it and by
 * `intent` below it. The invoice id comes from the grant, never from the
 * request, so there is no id to tamper with. `intent` reads the amount from
 * that invoice's balance. And `intent` creates no payment: the processor's
 * signed webhook is the only thing in this product that marks money as having
 * moved, so the worst a forged request can achieve is a Stripe intent against
 * an invoice the holder of the link was already entitled to pay.
 *
 * `portalGrantId` is set, so the audit line names the grant rather than
 * attributing a payment attempt to a user who was asleep.
 */
function payerContext(db: Database, grant: ResolvedGrant): ServiceContext {
  const actor = {
    userId: `portal:${grant.grantId}`,
    organizationId: grant.organizationId,
    roles: [],
    grants: ["payment:collect"],
    revocations: [],
  } as unknown as Actor;
  return { actor, db, portalGrantId: grant.grantId };
}

export interface PortalPaymentStart {
  intentId: string;
  clientSecret: string;
  publishableKey: string | null;
  amount: string;
  currency: string;
}

/**
 * Pay this invoice, from the link.
 *
 * `consume` rather than `peek`, because this is the action rather than the
 * page: it records the use and the IP it came from, which is what an operator
 * has to look at if a payment is later disputed. An invoice grant carries no
 * use limit, so consuming does not lock the customer out of trying again.
 */
export async function startPayment(
  db: Database,
  input: { token: string },
  meta?: { ip?: string | undefined } | undefined,
  /**
   * Passed straight through to `payments.intent`. Injected for the same
   * reason it is injected there: a test that reaches a processor is a test
   * that charges somebody the first time a fixture is fat fingered.
   */
  deps?: payments.PaymentDeps | undefined,
): Promise<PortalPaymentStart> {
  const grant = await consume(db, input.token, meta?.ip);
  const invoiceId = requireScope(grant, "invoice");

  /**
   * The customer and the balance are read inside the grant's own tenant
   * boundary before any charge is started, so the id handed to `intent` is
   * one row level security already agreed this link can reach.
   */
  const invoice = await inGrant(db, grant, async (tx) => {
    const [row] = await tx.select({
      customerId: schema.invoice.customerId,
      payerCustomerId: schema.invoice.payerCustomerId,
      number: schema.invoice.number,
      balance: schema.invoice.balance,
      currency: schema.invoice.currency,
      status: schema.invoice.status,
    })
      .from(schema.invoice)
      .where(and(eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundError("Invoice");
    return row;
  });

  if (!m.isPositive(m.money(invoice.balance, invoice.currency))) {
    throw new ConflictError(
      `Invoice ${invoice.number} has nothing outstanding. It may already have been paid.`,
    );
  }

  const result = await payments.intent(payerContext(db, grant), {
    /**
     * The payer when there is one. A warranty company's card should not
     * produce a payment attributed to the homeowner, because the money is
     * then allocated against the wrong customer's ledger.
     */
    customerId: invoice.payerCustomerId ?? invoice.customerId,
    /**
     * NAMED, so the amount is read from this invoice's balance rather than
     * accepted from the browser, and so the money lands on the invoice the
     * customer thought they were paying rather than oldest balance first.
     */
    invoiceIds: [invoiceId],
    description: `Invoice ${invoice.number}`,
  }, deps);

  return {
    intentId: result.intentId,
    clientSecret: result.clientSecret,
    publishableKey: result.publishableKey,
    amount: result.amount,
    currency: result.currency,
  };
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  sendInvoice: (ctx: ServiceContext, input: {
    invoiceId: string;
    to?: string | undefined;
    channel?: "email" | "portal_link" | undefined;
    resend?: boolean | undefined;
    note?: string | undefined;
    linkExpiresInDays?: number | undefined;
  }): Promise<SendInvoiceResult> => send(ctx, {
    invoiceId: input.invoiceId,
    ...(input.to ? { to: input.to } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.resend === undefined ? {} : { resend: input.resend }),
    ...(input.note ? { note: input.note } : {}),
    ...(input.linkExpiresInDays === undefined
      ? {} : { linkExpiresInDays: input.linkExpiresInDays }),
  }),

  listInvoiceDeliveries: (ctx: ServiceContext, input: { invoiceId: string }) =>
    history(ctx, input),

  listUndeliveredInvoices: (ctx: ServiceContext, input: { limit?: number | undefined }) =>
    undelivered(ctx, input),

  /**
   * The two grant handlers. `db` first and no ServiceContext, which is the
   * signature that admits a caller with no session.
   */
  viewPortalInvoice: (db: Database, input: { token: string }) => viewInvoice(db, input),

  payPortalInvoice: (db: Database, input: { token: string }, meta?: { ip?: string | undefined }) =>
    startPayment(db, input, meta),
} as const;
