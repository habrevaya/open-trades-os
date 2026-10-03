import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  SYSTEM_USER_ID, inventory as inv, money as m, type Actor,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as email from "./email";
import * as once from "./once";
import { assertSubmittable, submitWithin } from "./inventory";
import { totalOf } from "./purchase-approvals";
import { inForceAt } from "./pricebook";
import { portalBase } from "../lib/portal-base";

/**
 * A PURCHASE ORDER, EMAILED TO THE VENDOR
 *
 * An order used to be printed or read down the phone, and the record of
 * having sent it was a status somebody clicked. This sends it through the
 * company's own email path, with every line in the body and a link that
 * opens the order printable as the vendor reads it, and writes a row for
 * every attempt on the order, whether it went or not.
 *
 * A LINK, NOT A PDF. The link opens the same page the office prints from,
 * kept current as the order is received against, and the email body carries
 * the lines in plain text for a counter that never clicks. A generated PDF
 * attachment is not built; the docs say so.
 *
 * SENDING A DRAFT SUBMITS IT. Emailing the vendor IS sending the order, so a
 * draft goes through exactly the approval check the status change does
 * (`inventory.submitWithin`), BEFORE the email is queued, and is marked sent
 * only when the email was. An email the provider refused leaves the order a
 * draft and says why, because a vendor who never got it owes us nothing.
 * Emailing an order already sent is a copy, and changes nothing else.
 *
 * `po:write` is the authority, and the transport's `message:send` is passed
 * down beneath it as `statement-delivery.ts` does: a buyer sends orders and
 * has no business texting customers.
 */

/** How long the printable link opens the order. */
const LINK_DAYS = 90;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function transportContext(ctx: ServiceContext, tx: Database): ServiceContext {
  const actor: Actor = { ...ctx.actor, grants: [...(ctx.actor.grants ?? []), "message:send"] };
  return { ...ctx, actor, db: tx };
}

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface PrintableOrder {
  organizationName: string;
  number: number;
  status: string;
  vendorName: string;
  vendorAccount: string | null;
  submittedAt: string | null;
  expectedAt: string | null;
  notes: string | null;
  total: string;
  lines: {
    vendorPartNumber: string | null; itemCode: string; itemName: string;
    quantityOrdered: string; quantityReceived: string; unitPrice: string; lineTotal: string;
    deliverTo: string;
  }[];
}

/** The order as the vendor reads it, inside a tenant transaction. */
async function printable(tx: Database, orderId: string): Promise<PrintableOrder> {
  const [row] = await tx.select({
    order: schema.purchaseOrder, vendorName: schema.vendor.name, vendorAccount: schema.vendor.accountNumber,
    organizationName: schema.organization.name,
  }).from(schema.purchaseOrder)
    .innerJoin(schema.vendor, eq(schema.vendor.id, schema.purchaseOrder.vendorId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.purchaseOrder.organizationId))
    .where(and(eq(schema.purchaseOrder.id, orderId), isNull(schema.purchaseOrder.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("Purchase order");

  const lines = await tx.select({
    line: schema.purchaseOrderLine, itemCode: schema.priceBookItem.code, location: schema.location,
  }).from(schema.purchaseOrderLine)
    .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.purchaseOrderLine.itemId))
    .innerJoin(schema.location, eq(schema.location.id, schema.purchaseOrderLine.locationId))
    .where(eq(schema.purchaseOrderLine.purchaseOrderId, orderId))
    .orderBy(asc(schema.purchaseOrderLine.sortOrder));
  const itemIds = [...new Set(lines.map((l) => l.line.itemId))];
  const names = itemIds.length === 0 ? [] : await tx.select({
    itemId: schema.priceBookItemVersion.itemId, name: schema.priceBookItemVersion.name,
  }).from(schema.priceBookItemVersion)
    .where(and(inArray(schema.priceBookItemVersion.itemId, itemIds), inForceAt()));
  const nameOf = new Map(names.map((n) => [n.itemId, n.name]));

  return {
    organizationName: row.organizationName,
    number: row.order.number,
    status: row.order.status,
    vendorName: row.vendorName,
    vendorAccount: row.vendorAccount,
    submittedAt: row.order.submittedAt?.toISOString() ?? null,
    expectedAt: row.order.expectedAt?.toISOString() ?? null,
    notes: row.order.notes,
    total: m.toString(totalOf(lines.map((l) => l.line))),
    lines: lines.map(({ line, itemCode, location }) => ({
      vendorPartNumber: line.vendorPartNumber,
      itemCode,
      itemName: nameOf.get(line.itemId) ?? itemCode,
      quantityOrdered: inv.quantityLabel(inv.quantity(line.quantityOrdered)),
      quantityReceived: inv.quantityLabel(inv.quantity(line.quantityReceived)),
      unitPrice: line.unitPrice,
      lineTotal: m.toString(m.round(m.multiply(m.money(line.unitPrice), inv.quantityToString(inv.quantity(line.quantityOrdered))), 2)),
      /**
       * Where it is going, as a driver needs it: the name and the street.
       * A vendor delivering "to Van 4" needs to know where Van 4 will be.
       */
      deliverTo: [location.name, location.addressLine1, location.city, location.state]
        .filter((part) => part).join(", "),
    })),
  };
}

/** The email: who it is from, the order number, every line, and the link. */
export function composeOrderEmail(order: PrintableOrder, input: { url: string; message: string | null }) {
  const subject = `Purchase order ${order.number} from ${order.organizationName}`;
  const money = (v: string) => m.format(m.money(v));
  const lineText = order.lines.map((l) =>
    `  ${l.quantityOrdered} x ${l.vendorPartNumber ?? l.itemCode}  ${l.itemName}  at ${money(l.unitPrice)}  = ${money(l.lineTotal)}  (deliver to ${l.deliverTo})`);
  const text = [
    `Purchase order ${order.number}`,
    `From ${order.organizationName}${order.vendorAccount ? `, account ${order.vendorAccount}` : ""}`,
    "",
    ...(input.message ? [input.message, ""] : []),
    ...lineText,
    "",
    `Total ${money(order.total)}`,
    ...(order.notes ? ["", order.notes] : []),
    "",
    `Open or print the order: ${input.url}`,
    "",
    "Please reply to confirm the order and when it will ship.",
    "",
    order.organizationName,
  ].join("\n");
  const rows = order.lines.map((l) => `<tr>`
    + `<td style="padding:4px 8px;font-family:monospace">${escapeHtml(l.vendorPartNumber ?? l.itemCode)}</td>`
    + `<td style="padding:4px 8px">${escapeHtml(l.itemName)}</td>`
    + `<td style="padding:4px 8px;text-align:right">${escapeHtml(l.quantityOrdered)}</td>`
    + `<td style="padding:4px 8px;text-align:right">${escapeHtml(money(l.unitPrice))}</td>`
    + `<td style="padding:4px 8px;text-align:right">${escapeHtml(money(l.lineTotal))}</td>`
    + `<td style="padding:4px 8px">${escapeHtml(l.deliverTo)}</td></tr>`).join("");
  const html = [
    `<div style="font-family:system-ui,sans-serif;color:#111827;max-width:720px">`,
    `<p><strong>Purchase order ${order.number}</strong> from ${escapeHtml(order.organizationName)}`
    + `${order.vendorAccount ? `, account ${escapeHtml(order.vendorAccount)}` : ""}.</p>`,
    input.message ? `<p>${escapeHtml(input.message)}</p>` : "",
    `<table style="border-collapse:collapse;font-size:14px"><thead><tr>`
    + `<th style="padding:4px 8px;text-align:left">Part</th><th style="padding:4px 8px;text-align:left">Description</th>`
    + `<th style="padding:4px 8px;text-align:right">Qty</th><th style="padding:4px 8px;text-align:right">Each</th>`
    + `<th style="padding:4px 8px;text-align:right">Line</th><th style="padding:4px 8px;text-align:left">Deliver to</th>`
    + `</tr></thead><tbody>${rows}</tbody></table>`,
    `<p><strong>Total ${escapeHtml(money(order.total))}</strong></p>`,
    order.notes ? `<p style="white-space:pre-line">${escapeHtml(order.notes)}</p>` : "",
    `<p><a href="${escapeHtml(input.url)}">Open or print the order</a></p>`,
    `<p style="font-size:14px;color:#4b5563">Please reply to confirm the order and when it will ship.</p>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}

export interface OrderSendResult {
  sendId: string;
  state: "queued" | "refused";
  destination: string;
  explanation: string | null;
  /** The order's status afterwards: a draft that went out is submitted. */
  status: string;
  /** Empty on a replay: the token exists once, at the moment it is minted. */
  link: string;
}

/**
 * Email an order to its vendor, or to the address given.
 */
export function emailOrder(ctx: ServiceContext, input: { id: string; to?: string | null | undefined; message?: string | null | undefined }) {
  return guardedWrite(ctx, "po:write", async (tx): Promise<OrderSendResult> => {
    const seen = await once.replayed<OrderSendResult>(tx, ctx, "purchase_order_send");
    if (seen) return { ...seen, link: "" };

    const [order] = await tx.select().from(schema.purchaseOrder)
      .where(and(eq(schema.purchaseOrder.id, input.id), isNull(schema.purchaseOrder.deletedAt))).limit(1);
    if (!order) throw new NotFoundError("Purchase order");
    if (order.status === "received" || order.status === "cancelled") {
      throw new ConflictError(`This order is ${inv.PURCHASE_ORDER_STATUS[order.status].label.toLowerCase()}. There is nothing to send the vendor.`);
    }
    /** Approval first, before anything leaves: a draft that may not go out does not reach the outbox. */
    if (order.status === "draft") await assertSubmittable(tx, ctx, order);

    const [vendor] = await tx.select({ name: schema.vendor.name, email: schema.vendor.email })
      .from(schema.vendor).where(eq(schema.vendor.id, order.vendorId)).limit(1);
    const destination = (input.to?.trim() || vendor?.email?.trim() || "");
    if (destination === "") {
      throw new ConflictError(
        `${vendor?.name ?? "This vendor"} has no email address on file. Add one to the vendor, or type where to send it.`,
      );
    }

    const token = randomBytes(32).toString("base64url");
    const url = `${portalBase()}/po/${token}`;
    const composed = composeOrderEmail(await printable(tx, order.id), { url, message: input.message?.trim() || null });
    const outcome = await email.queue(transportContext(ctx, tx), {
      to: destination,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      purpose: "transactional",
    });

    /**
     * A refused send keeps no live link: a token that was never sent is a
     * key to an order lying in a table, so none is written.
     */
    const [row] = await tx.insert(schema.purchaseOrderSend).values({
      organizationId: ctx.actor.organizationId,
      purchaseOrderId: order.id,
      destination: email.normalizeAddress(destination),
      state: outcome.queued ? "queued" : "refused",
      explanation: outcome.queued ? null : outcome.explanation,
      messageId: outcome.queued ? outcome.messageId : null,
      linkTokenHash: outcome.queued ? hash(token) : null,
      linkExpiresAt: outcome.queued ? new Date(Date.now() + LINK_DAYS * 864e5) : null,
      sentByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    }).returning({ id: schema.purchaseOrderSend.id });

    let status: string = order.status;
    if (outcome.queued && order.status === "draft") {
      await submitWithin(tx, ctx, order);
      status = "submitted";
    }
    await audit(tx, ctx, "purchase_order.emailed", "purchase_order", order.id, null, {
      to: destination, queued: outcome.queued, sendId: row!.id,
    });
    const answer: OrderSendResult = {
      sendId: row!.id,
      state: outcome.queued ? "queued" : "refused",
      destination: email.normalizeAddress(destination),
      explanation: outcome.queued ? null : outcome.explanation,
      status,
      link: outcome.queued ? url : "",
    };
    await once.remember(tx, ctx, "purchase_order_send", row!.id, { ...answer, link: "" });
    return answer;
  });
}

export interface OrderSendView {
  id: string;
  destination: string | null;
  state: string;
  explanation: string | null;
  sentAt: string;
  sentBy: string | null;
  linkExpiresAt: string | null;
}

/** Every attempt to send this order, newest first. */
export async function sendsWithin(tx: Database, orderId: string): Promise<OrderSendView[]> {
  const rows = await tx.select().from(schema.purchaseOrderSend)
    .where(eq(schema.purchaseOrderSend.purchaseOrderId, orderId))
    .orderBy(desc(schema.purchaseOrderSend.createdAt));
  const people = rows.length === 0 ? [] : await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  const who = new Map(people.map((p) => [p.user_id, p.name ?? p.email]));
  return rows.map((row) => ({
    id: row.id,
    destination: row.destination,
    state: row.state,
    explanation: row.explanation,
    sentAt: row.createdAt.toISOString(),
    sentBy: row.sentByUserId ? who.get(row.sentByUserId) ?? null : null,
    linkExpiresAt: row.linkExpiresAt?.toISOString() ?? null,
  }));
}

export function sends(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "po:read", (tx) => sendsWithin(tx, input.id));
}

/**
 * The order behind a link, for the vendor's page. No session: the token
 * names the company and the order through `app.purchase_order_link`, and the
 * read runs in that company's tenant with no permissions, reading the one
 * order and nothing else.
 */
export async function forVendor(db: Database, input: { token: string }): Promise<PrintableOrder> {
  const rows = await db.execute<{ organization_id: string; purchase_order_id: string }>(
    sql`select organization_id, purchase_order_id from app.purchase_order_link(${hash(input.token)})`,
  );
  const link = rows[0];
  if (!link) throw new NotFoundError("Purchase order");
  return inTenant(
    { actor: { userId: SYSTEM_USER_ID, organizationId: link.organization_id, roles: [] }, db },
    (tx) => printable(tx, link.purchase_order_id),
  );
}

export const handlers = {
  emailPurchaseOrder: (ctx: ServiceContext, input: {
    id: string; to?: string | null | undefined; message?: string | null | undefined;
  }): Promise<OrderSendResult> => emailOrder(ctx, input),
  listPurchaseOrderSends: async (ctx: ServiceContext, input: { id: string }): Promise<{ sends: OrderSendView[] }> =>
    ({ sends: await sends(ctx, input) }),
} as const;
