import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, money as m, project as plan } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, InvalidGrantError, NotFoundError,
  type ServiceContext,
} from "./context";
import * as contracts from "./contracts";
import * as email from "./email";
import { inForceAt } from "./pricebook";
import { consume, inGrant, mintGrant, peek, requireScope } from "./portal";
import { identityOf, transportContext } from "./estimate-delivery";
import {
  billedAgainstPhase, billedToDate, loadProjectIn, phaseTotal, rememberKey, seenKey,
} from "./project-position";

/**
 * M12. CHANGE ORDERS.
 *
 * Extra work on a project, priced, put in front of the customer through the
 * same kind of link an estimate is approved through, signed, and only then
 * folded into the contract and the budget. The life of one is on
 * `schema.projectChangeOrder`; the arithmetic of folding one in, and the
 * changes that cannot be agreed as written, is core's `foldChangeOrder`.
 *
 * THE PERMISSIONS ARE THE ESTIMATE'S, because a change order is a quote for
 * work that was not in the first one. Anybody running the job (`job:write`)
 * can log that the customer asked for something; pricing it is
 * `estimate:write`, sending it is `estimate:send`, and recording a yes or a
 * no given in person is `estimate:approve`, which is exactly what that
 * permission says it is. Reading one is `job:read`, like the contract value
 * it changes, and the cost on it is shown only to a caller holding
 * `job.cost:read`.
 *
 * APPROVAL CHANGES THE CONTRACT IN THE SAME TRANSACTION AS THE SIGNATURE.
 * There is no state in which a change order is approved and the contract
 * has not moved, or the contract has moved and nobody signed anything,
 * whichever door the approval came through.
 */

type ChangeOrderRow = typeof schema.projectChangeOrder.$inferSelect;
type LineRow = typeof schema.projectChangeOrderLine.$inferSelect;

const EDITABLE = ["requested", "priced"] as const;
const SENDABLE = ["priced", "sent"] as const;

/* ------------------------------------------------------------------ reading */

export interface ChangeOrderView {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string | null;
  requestedBy: string | null;
  reason: string | null;
  status: ChangeOrderRow["status"];
  projectPhaseId: string | null;
  phaseName: string | null;
  scheduleDays: number | null;
  amount: string;
  /** Null for a caller who may not read cost, and when a line's cost is unknown. */
  cost: string | null;
  sentAt: Date | null;
  decidedAt: Date | null;
  decidedVia: string | null;
  signerName: string | null;
  declineReason: string | null;
  contractValueBefore: string | null;
  contractValueAfter: string | null;
  voidReason: string | null;
  createdAt: Date;
  lines: {
    id: string; name: string; description: string | null; quantity: string;
    unitPrice: string; lineTotal: string; priceSource: string;
    priceBookItemId: string | null; unitCost: string | null;
  }[];
}

function shape(
  ctx: ServiceContext, row: ChangeOrderRow, lines: LineRow[], phaseName: string | null,
): ChangeOrderView {
  /**
   * Cost is margin, and `job.cost:read` is the permission that keeps it off a
   * technician's phone. Left out rather than zeroed, so a missing figure is
   * never read as a free change.
   */
  const seesCost = can(ctx.actor, "job.cost:read");
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    description: row.description,
    requestedBy: row.requestedBy,
    reason: row.reason,
    status: row.status,
    projectPhaseId: row.projectPhaseId,
    phaseName,
    scheduleDays: row.scheduleDays,
    amount: row.amount,
    cost: seesCost ? row.cost : null,
    sentAt: row.sentAt,
    decidedAt: row.decidedAt,
    decidedVia: row.decidedVia,
    signerName: row.signerName,
    declineReason: row.declineReason,
    contractValueBefore: row.contractValueBefore,
    contractValueAfter: row.contractValueAfter,
    voidReason: row.voidReason,
    createdAt: row.createdAt,
    lines: lines.map((line) => ({
      id: line.id,
      name: line.name,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      priceSource: line.priceSource,
      priceBookItemId: line.priceBookItemId,
      unitCost: seesCost ? line.unitCost : null,
    })),
  };
}

async function linesOf(tx: Database, ids: string[]): Promise<LineRow[]> {
  if (ids.length === 0) return [];
  return tx.select().from(schema.projectChangeOrderLine)
    .where(inArray(schema.projectChangeOrderLine.changeOrderId, ids))
    .orderBy(asc(schema.projectChangeOrderLine.sortOrder), asc(schema.projectChangeOrderLine.createdAt));
}

async function phaseNames(tx: Database, projectId: string): Promise<Map<string, string>> {
  const rows = await tx.select({ id: schema.projectPhase.id, name: schema.projectPhase.name })
    .from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The change order log: every one on the project, in the order they were raised. */
export async function list(ctx: ServiceContext, input: { projectId: string }): Promise<ChangeOrderView[]> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const project = await loadProjectIn(tx, ctx.actor.organizationId, input.projectId);
    const rows = await tx.select().from(schema.projectChangeOrder)
      .where(eq(schema.projectChangeOrder.projectId, project.id))
      .orderBy(asc(schema.projectChangeOrder.number));
    const lines = await linesOf(tx, rows.map((r) => r.id));
    const names = await phaseNames(tx, project.id);
    return rows.map((row) => shape(
      ctx, row, lines.filter((l) => l.changeOrderId === row.id),
      row.projectPhaseId ? names.get(row.projectPhaseId) ?? null : null,
    ));
  });
}

export async function get(ctx: ServiceContext, input: { id: string }): Promise<ChangeOrderView> {
  return guardedRead(ctx, "job:read", async (tx) => viewIn(tx, ctx, input.id));
}

async function viewIn(tx: Database, ctx: ServiceContext, id: string): Promise<ChangeOrderView> {
  const row = await loadIn(tx, ctx.actor.organizationId, id);
  const lines = await linesOf(tx, [row.id]);
  const names = await phaseNames(tx, row.projectId);
  return shape(ctx, row, lines, row.projectPhaseId ? names.get(row.projectPhaseId) ?? null : null);
}

async function loadIn(tx: Database, organizationId: string, id: string): Promise<ChangeOrderRow> {
  const [row] = await tx.select().from(schema.projectChangeOrder)
    .where(and(
      eq(schema.projectChangeOrder.id, id),
      eq(schema.projectChangeOrder.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Change order");
  return row;
}

/* ----------------------------------------------------------------- raising */

export type ChangeOrderUpdate = {
  [K in keyof Omit<ChangeOrderInput, "projectId">]?: ChangeOrderInput[K] | undefined;
} & { id: string };

export interface ChangeOrderInput {
  projectId: string;
  title: string;
  description?: string | null | undefined;
  requestedBy?: string | null | undefined;
  reason?: string | null | undefined;
  phaseId?: string | null | undefined;
  scheduleDays?: number | null | undefined;
}

/**
 * Log that somebody asked for a change. Nothing is priced yet, which is a
 * real state: the customer asked on site on Tuesday and the office prices it
 * on Thursday, and the request existing in between is what stops it being
 * forgotten.
 *
 * Numbered per project under a lock, so two people logging a change at once
 * get 3 and 4 rather than a collision. Idempotent on the caller's key, so a
 * double tap logs one change.
 */
export async function request(ctx: ServiceContext, input: ChangeOrderInput): Promise<ChangeOrderView> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const seen = await seenKey(tx, ctx, "project_change_order");
    if (seen) return viewIn(tx, ctx, seen);

    const project = await loadProjectIn(tx, ctx.actor.organizationId, input.projectId);
    if (project.status === "cancelled" || project.status === "completed") {
      throw new ConflictError(`This project is ${project.status}, so there is no contract left to change.`);
    }
    const title = input.title.trim();
    if (title === "") throw new ConflictError("A change order needs a title. It heads the page the customer signs.");
    if (input.phaseId) await assertPhaseOf(tx, project.id, input.phaseId);

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`change_order:${project.id}`}))`);
    const [top] = await tx.select({ number: sql<number>`coalesce(max(${schema.projectChangeOrder.number}), 0)` })
      .from(schema.projectChangeOrder).where(eq(schema.projectChangeOrder.projectId, project.id));

    const [row] = await tx.insert(schema.projectChangeOrder).values({
      organizationId: ctx.actor.organizationId,
      projectId: project.id,
      number: Number(top?.number ?? 0) + 1,
      title,
      description: input.description?.trim() || null,
      requestedBy: input.requestedBy?.trim() || null,
      reason: input.reason?.trim() || null,
      projectPhaseId: input.phaseId ?? null,
      scheduleDays: input.scheduleDays ?? null,
      status: "requested",
    }).returning();

    await rememberKey(tx, ctx, "project_change_order.request", "project_change_order", row!.id);
    await audit(tx, ctx, "project_change_order.requested", "project_change_order", row!.id, null, row!);
    return viewIn(tx, ctx, row!.id);
  });
}

async function assertPhaseOf(tx: Database, projectId: string, phaseId: string): Promise<void> {
  const [phase] = await tx.select({ id: schema.projectPhase.id }).from(schema.projectPhase)
    .where(and(eq(schema.projectPhase.id, phaseId), eq(schema.projectPhase.projectId, projectId)))
    .limit(1);
  if (!phase) throw new ConflictError("That phase is not part of this project.");
}

/** Change what it says, while nobody has been asked to sign it. */
export async function update(
  ctx: ServiceContext,
  input: ChangeOrderUpdate,
): Promise<ChangeOrderView> {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const before = await loadIn(tx, ctx.actor.organizationId, input.id);
    assertEditable(before);
    if (input.phaseId) await assertPhaseOf(tx, before.projectId, input.phaseId);
    if (input.title !== undefined && input.title.trim() === "") {
      throw new ConflictError("A change order needs a title.");
    }
    const [after] = await tx.update(schema.projectChangeOrder).set({
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy?.trim() || null } : {}),
      ...(input.reason !== undefined ? { reason: input.reason?.trim() || null } : {}),
      ...(input.phaseId !== undefined ? { projectPhaseId: input.phaseId } : {}),
      ...(input.scheduleDays !== undefined ? { scheduleDays: input.scheduleDays } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.projectChangeOrder.id, before.id)).returning();
    await audit(tx, ctx, "project_change_order.updated", "project_change_order", before.id, before, after!);
    return viewIn(tx, ctx, before.id);
  });
}

/**
 * A change order already in front of the customer cannot change under them.
 * The link they hold shows a page, the signature covers a hash of that page,
 * and a line edited after sending would make the hash cover something they
 * never saw. Withdraw it and raise another.
 */
function assertEditable(row: ChangeOrderRow): void {
  if (!(EDITABLE as readonly string[]).includes(row.status)) {
    throw new ConflictError(
      `Change order ${row.number} is ${row.status}, so it cannot be changed. `
      + (row.status === "sent"
        ? "The customer has a link to the page as it is. Withdraw it and raise a new one."
        : "It is part of the project's record as it stands."),
    );
  }
}

/* ------------------------------------------------------------------ pricing */

export interface LineInput {
  changeOrderId: string;
  /** Priced from the price book, or from the customer's rate card where one covers it. */
  priceBookItemId?: string | null | undefined;
  /** For a line typed by hand. Ignored for a price book line, which takes its own name. */
  name?: string | null | undefined;
  description?: string | null | undefined;
  /** Signed: "-2" takes two out. */
  quantity: string;
  /** For a line typed by hand only. */
  unitPrice?: string | null | undefined;
  unitCost?: string | null | undefined;
}

/**
 * PRICE A LINE: FROM THE PRICE BOOK, FROM A RATE CARD, OR BY HAND.
 *
 * A price book item takes the version in force today and that version's
 * cost. Where the customer holds a contract with a rate card, the card's
 * price governs instead, through the same `contracts.priceFor` the invoices
 * use, so a change order on commercial work is priced at the rate the client
 * will pay rather than at our list price they will reject.
 *
 * AN ITEM THE CARD DOES NOT COVER IS REFUSED, not priced at list. A card
 * applying and the item not being on it means somebody has to ask the
 * client what they will pay before the work is agreed; pricing it at list
 * anyway is how a signed change order gets disputed. Type the price by hand
 * once it is agreed.
 *
 * A price book line's price is never taken from the request, for the reason
 * billing gives: a client that can name its own price is a client that will.
 */
export async function addLine(ctx: ServiceContext, input: LineInput): Promise<ChangeOrderView> {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const order = await loadIn(tx, ctx.actor.organizationId, input.changeOrderId);
    /** A retried add is one line, not two. */
    if (await seenKey(tx, ctx, "project_change_order_line") === order.id) return viewIn(tx, ctx, order.id);
    assertEditable(order);
    const project = await loadProjectIn(tx, ctx.actor.organizationId, order.projectId);

    let quantity: m.Money;
    try {
      quantity = m.money(input.quantity);
    } catch {
      throw new ConflictError(`${input.quantity} is not a quantity.`);
    }
    if (m.isZero(quantity)) throw new ConflictError("A line for none of something is not a line.");

    let line: Omit<typeof schema.projectChangeOrderLine.$inferInsert, "organizationId" | "changeOrderId" | "lineTotal">;
    if (input.priceBookItemId) {
      if (input.unitPrice !== undefined && input.unitPrice !== null && input.unitPrice !== "") {
        throw new ConflictError(
          "A price book line takes its price from the price book or the customer's rate card. "
          + "Leave the price off, or add the line by hand with the price agreed.",
        );
      }
      const [version] = await tx.select({
        itemId: schema.priceBookItemVersion.itemId,
        versionId: schema.priceBookItemVersion.id,
        name: schema.priceBookItemVersion.name,
        description: schema.priceBookItemVersion.description,
        price: schema.priceBookItemVersion.price,
        cost: schema.priceBookItemVersion.cost,
      }).from(schema.priceBookItemVersion)
        .where(and(eq(schema.priceBookItemVersion.itemId, input.priceBookItemId), inForceAt()))
        .limit(1);
      if (!version) throw new NotFoundError("Price book item");

      const resolution = await contracts.priceFor({ ...ctx, db: tx }, {
        customerId: project.customerId, priceBookItemId: input.priceBookItemId,
      });
      if (!resolution.covered && resolution.cardApplies) throw new ConflictError(resolution.reason);

      line = {
        priceBookItemId: version.itemId,
        priceBookItemVersionId: version.versionId,
        rateCardId: resolution.covered ? resolution.rateCardId : null,
        priceSource: resolution.covered ? "rate_card" : "price_book",
        name: version.name,
        description: input.description?.trim() || version.description || null,
        quantity: m.toString(quantity),
        unitPrice: resolution.covered ? resolution.price : version.price,
        /** Cost is never the card's. The price is theirs and the cost is ours. */
        unitCost: version.cost,
      };
    } else {
      const name = input.name?.trim() ?? "";
      if (name === "") throw new ConflictError("A line typed by hand needs a name. It goes on the page the customer signs.");
      if (input.unitPrice === undefined || input.unitPrice === null || input.unitPrice === "") {
        throw new ConflictError("A line typed by hand needs a price.");
      }
      let price: m.Money;
      try {
        price = m.money(input.unitPrice);
      } catch {
        throw new ConflictError(`${input.unitPrice} is not an amount of money.`);
      }
      if (m.isNegative(price)) {
        throw new ConflictError("A price is never negative. Take work out with a negative quantity instead.");
      }
      line = {
        priceBookItemId: null,
        priceBookItemVersionId: null,
        rateCardId: null,
        priceSource: "manual",
        name,
        description: input.description?.trim() || null,
        quantity: m.toString(quantity),
        unitPrice: m.toString(price),
        unitCost: input.unitCost === undefined || input.unitCost === null || input.unitCost === ""
          ? null : m.toString(m.money(input.unitCost)),
      };
    }

    const [{ total } = { total: 0 }] = await tx.select({ total: sql<number>`count(*)::int` })
      .from(schema.projectChangeOrderLine)
      .where(eq(schema.projectChangeOrderLine.changeOrderId, order.id));

    const [lineTotal] = plan.changeOrderTotals([{
      quantity: line.quantity!, unitPrice: line.unitPrice, unitCost: line.unitCost ?? null,
    }]).lineTotals;

    await tx.insert(schema.projectChangeOrderLine).values({
      ...line,
      organizationId: ctx.actor.organizationId,
      changeOrderId: order.id,
      sortOrder: Number(total) + 1,
      lineTotal: lineTotal!,
    });

    await retotal(tx, order.id);
    await rememberKey(tx, ctx, "project_change_order.line_add", "project_change_order_line", order.id);
    await audit(tx, ctx, "project_change_order.line_added", "project_change_order", order.id, null, line);
    return viewIn(tx, ctx, order.id);
  });
}

export async function removeLine(
  ctx: ServiceContext, input: { changeOrderId: string; lineId: string },
): Promise<ChangeOrderView> {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const order = await loadIn(tx, ctx.actor.organizationId, input.changeOrderId);
    assertEditable(order);
    const removed = await tx.delete(schema.projectChangeOrderLine)
      .where(and(
        eq(schema.projectChangeOrderLine.id, input.lineId),
        eq(schema.projectChangeOrderLine.changeOrderId, order.id),
      )).returning();
    /** Already gone is the state that was asked for, which is what a retry finds. */
    if (removed.length === 0) return viewIn(tx, ctx, order.id);
    await retotal(tx, order.id);
    await audit(tx, ctx, "project_change_order.line_removed", "project_change_order", order.id, removed[0], null);
    return viewIn(tx, ctx, order.id);
  });
}

/**
 * The totals from the lines, through core, and the status that follows: a
 * change order with a priced line is priced, and one with none is back to
 * requested. The cost is null when any line's cost is unknown, because a
 * cost that silently left out the line nobody costed is an overstatement of
 * margin on exactly the work that was improvised.
 */
async function retotal(tx: Database, changeOrderId: string): Promise<void> {
  const lines = await linesOf(tx, [changeOrderId]);
  const totals = plan.changeOrderTotals(lines.map((l) => ({
    quantity: l.quantity, unitPrice: l.unitPrice, unitCost: l.unitCost,
  })));
  await tx.update(schema.projectChangeOrder).set({
    amount: totals.amount,
    cost: lines.length > 0 && totals.costKnown ? totals.cost : null,
    status: lines.length > 0 ? "priced" : "requested",
    updatedAt: new Date(),
  }).where(eq(schema.projectChangeOrder.id, changeOrderId));
}

/* ------------------------------------------------------------------ sending */

/**
 * What the customer signs, as a hash.
 *
 * The number, the title, the description, the phase, the days, every line
 * and the total. Recomputed when it is approved through the link, and a
 * mismatch is refused: the signature has to cover the page as shown.
 */
function documentHashOf(row: ChangeOrderRow, lines: LineRow[]): string {
  const canonical = JSON.stringify({
    number: row.number,
    title: row.title,
    description: row.description,
    reason: row.reason,
    phase: row.projectPhaseId,
    scheduleDays: row.scheduleDays,
    amount: m.toString(m.money(row.amount)),
    lines: lines.map((l) => ({
      name: l.name, description: l.description,
      quantity: m.toString(m.money(l.quantity)),
      unitPrice: m.toString(m.money(l.unitPrice)),
      lineTotal: m.toString(m.money(l.lineTotal)),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface SendResult {
  id: string;
  status: ChangeOrderRow["status"];
  /** The approval link. Shown once: only its hash is kept, so a replayed request gets null. */
  url: string | null;
  emailed: boolean;
  /** Why it was not emailed, when it was asked to be. */
  reason: string | null;
}

/**
 * PUT IT IN FRONT OF THE CUSTOMER.
 *
 * Mints a link for this change order alone, through the same grant machinery
 * an estimate's approval link uses: a single purpose token, hashed at rest,
 * that cannot reach anything else. Emailed to the customer when asked, or
 * handed back to copy and send.
 *
 * Checked against the project NOW, through the same fold the approval will
 * run, so a credit that cannot be agreed is refused before the customer is
 * asked to sign it rather than after. Sending again withdraws the earlier
 * link, so there is one live page for one change.
 */
export async function send(
  ctx: ServiceContext,
  input: { id: string; channel?: "link" | "email" | undefined; expiresInDays?: number | undefined },
): Promise<SendResult> {
  assertCan(ctx.actor, "portal:grant");
  return guardedWrite(ctx, "estimate:send", async (tx) => {
    const order = await loadIn(tx, ctx.actor.organizationId, input.id);
    /**
     * A replay under the same key changes nothing and emails nobody twice.
     * The link the first request returned is the live one; its plaintext was
     * never stored, so the replay answers with no link rather than minting a
     * second and killing the first.
     */
    if (await seenKey(tx, ctx, "project_change_order_send") === order.id) {
      return { id: order.id, status: order.status, url: null, emailed: false, reason: "Already sent by an earlier request with this key." };
    }
    if (!(SENDABLE as readonly string[]).includes(order.status)) {
      throw new ConflictError(
        order.status === "requested"
          ? `Change order ${order.number} has nothing priced on it yet, so there is nothing to agree to.`
          : `Change order ${order.number} is ${order.status}, so there is nothing to send.`,
      );
    }
    const lines = await linesOf(tx, [order.id]);
    const project = await loadProjectIn(tx, ctx.actor.organizationId, order.projectId);
    const folded = plan.foldChangeOrder(await positionOf(tx, project, order), {
      amount: order.amount, cost: order.cost,
    });
    if (!folded.ok) throw new ConflictError(folded.reason);

    /** One live link per change order: an earlier one stops working. */
    await tx.update(schema.portalGrant).set({ revokedAt: new Date() })
      .where(and(
        eq(schema.portalGrant.scope, "change_order"),
        eq(schema.portalGrant.subjectId, order.id),
        isNull(schema.portalGrant.revokedAt),
      ));
    const { url } = await mintGrant(tx, {
      organizationId: ctx.actor.organizationId,
      customerId: project.customerId,
      scope: "change_order",
      subjectId: order.id,
      expiresInDays: input.expiresInDays ?? 30,
    });

    const hash = documentHashOf(order, lines);
    await tx.update(schema.projectChangeOrder).set({
      status: "sent", sentAt: new Date(), documentHash: hash, updatedAt: new Date(),
    }).where(eq(schema.projectChangeOrder.id, order.id));

    let emailed = false;
    let reason: string | null = null;
    if (input.channel === "email") {
      const [customer] = await tx.select({ name: schema.customer.name, email: schema.customer.email })
        .from(schema.customer).where(eq(schema.customer.id, project.customerId)).limit(1);
      if (!customer?.email) {
        reason = "The customer has no email address on file, so the link was not emailed.";
      } else {
        const identity = await identityOf(tx, ctx.actor.organizationId);
        const composed = composeEmail({
          company: identity.name, customerName: customer.name, projectName: project.name,
          number: order.number, title: order.title, amount: order.amount, url,
        });
        const outcome = await email.queueIn(tx, transportContext(ctx, tx), {
          to: customer.email,
          subject: composed.subject,
          text: composed.text,
          purpose: "transactional",
          customerId: project.customerId,
        });
        emailed = outcome.queued;
        reason = outcome.queued ? null : outcome.explanation;
      }
    }

    await rememberKey(tx, ctx, "project_change_order.send", "project_change_order_send", order.id);
    await audit(tx, ctx, "project_change_order.sent", "project_change_order", order.id,
      { status: order.status }, { status: "sent", documentHash: hash, channel: input.channel ?? "link", emailed });
    return { id: order.id, status: "sent", url, emailed, reason };
  });
}

/** Plain text only: a change order email is a sentence and a link, and needs nothing else. */
export function composeEmail(input: {
  company: string; customerName: string; projectName: string;
  number: number; title: string; amount: string; url: string;
}): { subject: string; text: string } {
  const amount = m.money(input.amount);
  const effect = m.isNegative(amount)
    ? `It takes ${m.format(m.abs(amount))} off your contract.`
    : `It adds ${m.format(amount)} to your contract.`;
  return {
    subject: `Change order ${input.number} for ${input.projectName}: ${input.title}`,
    text: [
      `Hello ${input.customerName},`,
      "",
      `${input.company} has written change order ${input.number} for ${input.projectName}: ${input.title}.`,
      effect,
      "",
      "Review it, and approve and sign it or decline it, here:",
      input.url,
      "",
      "Nothing changes on your contract unless you approve it. Reply to this email with any questions.",
      input.company,
    ].join("\n"),
  };
}

/* ----------------------------------------------------------------- deciding */

/**
 * Where the project stands, in the shape core's fold reads.
 */
async function positionOf(
  tx: Database,
  project: typeof schema.project.$inferSelect,
  order: ChangeOrderRow,
): Promise<plan.ContractPosition> {
  let phase: plan.ContractPosition["phase"] = null;
  if (order.projectPhaseId) {
    const [row] = await tx.select().from(schema.projectPhase)
      .where(eq(schema.projectPhase.id, order.projectPhaseId)).limit(1);
    if (row) {
      phase = {
        name: row.name,
        billingValue: row.billingValue,
        budgetCost: row.budgetCost,
        billedAgainst: m.toString(await billedAgainstPhase(tx, project.id, row.id)),
      };
    }
  }
  return {
    contractValue: project.contractValue,
    budgetCost: project.budgetCost,
    billedToDate: m.toString(await billedToDate(tx, project.id)),
    scheduledValue: m.toString(await phaseTotal(tx, project.id)),
    phase,
  };
}

interface Signer {
  signerName: string;
  via: "portal" | "office";
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * THE YES, AND WHAT IT CHANGES, IN ONE TRANSACTION.
 *
 * Runs unguarded on purpose: the office reaches it through `estimate:approve`
 * and the customer through their link, and each door checks its own
 * authority before calling this. Everything that makes the yes count is
 * here, so the two doors cannot disagree about what a yes does.
 */
async function approveIn(
  tx: Database, ctx: ServiceContext, order: ChangeOrderRow, signer: Signer,
): Promise<void> {
  const name = signer.signerName.trim();
  if (name === "") throw new ConflictError("A signature needs the name of whoever is signing.");

  const lines = await linesOf(tx, [order.id]);
  if (signer.via === "portal" && order.documentHash !== documentHashOf(order, lines)) {
    throw new ConflictError("This change order changed after it was sent, so it cannot be approved from this link.");
  }

  /** Locked, so two approvals of two change orders on one project cannot both read the old contract. */
  await tx.execute(sql`select 1 from public.project where id = ${order.projectId} for update`);
  const project = await loadProjectIn(tx, ctx.actor.organizationId, order.projectId);
  const folded = plan.foldChangeOrder(await positionOf(tx, project, order), {
    amount: order.amount, cost: order.cost,
  });
  if (!folded.ok) throw new ConflictError(folded.reason);

  await tx.update(schema.project).set({
    contractValue: folded.contractValue,
    budgetCost: folded.budgetCost,
    updatedAt: new Date(),
  }).where(eq(schema.project.id, project.id));
  if (order.projectPhaseId && folded.phaseBillingValue !== null) {
    await tx.update(schema.projectPhase).set({
      billingValue: folded.phaseBillingValue,
      budgetCost: folded.phaseBudgetCost,
      updatedAt: new Date(),
    }).where(eq(schema.projectPhase.id, order.projectPhaseId));
  }

  const hash = documentHashOf(order, lines);
  await tx.insert(schema.documentSignature).values({
    organizationId: ctx.actor.organizationId,
    subject: "change_order",
    subjectId: order.id,
    signerName: name,
    documentHash: hash,
    ipAddress: signer.ipAddress ?? null,
    userAgent: signer.userAgent ?? null,
  });

  const [after] = await tx.update(schema.projectChangeOrder).set({
    status: "approved",
    decidedAt: new Date(),
    decidedVia: signer.via,
    signerName: name,
    documentHash: hash,
    contractValueBefore: project.contractValue,
    contractValueAfter: folded.contractValue,
    updatedAt: new Date(),
  }).where(eq(schema.projectChangeOrder.id, order.id)).returning();

  /** The link has done its job. */
  await tx.update(schema.portalGrant).set({ revokedAt: new Date() })
    .where(and(
      eq(schema.portalGrant.scope, "change_order"),
      eq(schema.portalGrant.subjectId, order.id),
      isNull(schema.portalGrant.revokedAt),
    ));

  await audit(tx, ctx, "project_change_order.approved", "project_change_order", order.id,
    { status: order.status, contractValue: project.contractValue },
    { status: "approved", contractValue: folded.contractValue, signerName: name, via: signer.via, row: after });
}

async function declineIn(
  tx: Database, ctx: ServiceContext, order: ChangeOrderRow,
  input: { reason: string | null; via: "portal" | "office"; signerName?: string | null },
): Promise<void> {
  await tx.update(schema.projectChangeOrder).set({
    status: "declined",
    decidedAt: new Date(),
    decidedVia: input.via,
    signerName: input.signerName?.trim() || null,
    declineReason: input.reason?.trim() || null,
    updatedAt: new Date(),
  }).where(eq(schema.projectChangeOrder.id, order.id));
  await tx.update(schema.portalGrant).set({ revokedAt: new Date() })
    .where(and(
      eq(schema.portalGrant.scope, "change_order"),
      eq(schema.portalGrant.subjectId, order.id),
      isNull(schema.portalGrant.revokedAt),
    ));
  await audit(tx, ctx, "project_change_order.declined", "project_change_order", order.id,
    { status: order.status }, { status: "declined", reason: input.reason, via: input.via });
}

/**
 * The office records the customer's answer: signed on paper on site, or
 * agreed on the phone and confirmed in writing. `estimate:approve`, which is
 * the permission for exactly this.
 *
 * Idempotent in the way an estimate's approval is: recording the same answer
 * twice is a no-op, and recording the opposite one is refused, because that
 * is a contradiction rather than a retry.
 */
export async function decide(
  ctx: ServiceContext,
  input: { id: string; decision: "approved" | "declined"; signerName?: string | null | undefined; reason?: string | null | undefined },
): Promise<ChangeOrderView> {
  return guardedWrite(ctx, "estimate:approve", async (tx) => {
    const order = await loadIn(tx, ctx.actor.organizationId, input.id);
    if (order.status === input.decision) return viewIn(tx, ctx, order.id);
    if (order.status !== "priced" && order.status !== "sent") {
      throw new ConflictError(
        order.status === "requested"
          ? `Change order ${order.number} has nothing priced on it, so there is nothing to agree to.`
          : `Change order ${order.number} is already ${order.status}.`,
      );
    }
    if (input.decision === "approved") {
      await approveIn(tx, ctx, order, { signerName: input.signerName ?? "", via: "office" });
    } else {
      await declineIn(tx, ctx, order, { reason: input.reason ?? null, via: "office", signerName: input.signerName ?? null });
    }
    return viewIn(tx, ctx, order.id);
  });
}

/** Withdraw it before anybody agreed to it. The reason is kept, and the link stops working. */
export async function withdraw(ctx: ServiceContext, input: { id: string; reason: string }): Promise<ChangeOrderView> {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const order = await loadIn(tx, ctx.actor.organizationId, input.id);
    if (order.status === "void") return viewIn(tx, ctx, order.id);
    if (order.status === "approved" || order.status === "declined") {
      throw new ConflictError(
        `Change order ${order.number} is ${order.status}. `
        + (order.status === "approved"
          ? "Undoing an agreed change is a new change order, a credit, so the record shows both."
          : "The customer's answer is part of the record."),
      );
    }
    const reason = input.reason.trim();
    if (reason === "") throw new ConflictError("Say why it is being withdrawn. It stays on the change order log.");
    await tx.update(schema.projectChangeOrder).set({
      status: "void", voidReason: reason, updatedAt: new Date(),
    }).where(eq(schema.projectChangeOrder.id, order.id));
    await tx.update(schema.portalGrant).set({ revokedAt: new Date() })
      .where(and(
        eq(schema.portalGrant.scope, "change_order"),
        eq(schema.portalGrant.subjectId, order.id),
        isNull(schema.portalGrant.revokedAt),
      ));
    await audit(tx, ctx, "project_change_order.withdrawn", "project_change_order", order.id,
      { status: order.status }, { status: "void", reason });
    return viewIn(tx, ctx, order.id);
  });
}

/* --------------------------------------------------------- the customer side */

export interface CustomerChangeOrder {
  organizationName: string;
  projectName: string;
  propertyAddress: string;
  customerName: string;
  number: number;
  title: string;
  description: string | null;
  reason: string | null;
  phaseName: string | null;
  scheduleDays: number | null;
  status: ChangeOrderRow["status"];
  lines: { name: string; description: string | null; quantity: string; unitPrice: string; lineTotal: string }[];
  amount: string;
  /** The contract as it stands now, and as it would be once this is agreed. */
  contractValue: string | null;
  contractValueAfter: string | null;
  signerName: string | null;
  decidedAt: string | null;
}

/**
 * What the customer sees. Built field by field from what they are entitled
 * to, never by deleting from the office's view: no cost, no margin, no
 * price source, nothing a field added to the office view later could leak.
 */
async function customerView(tx: Database, order: ChangeOrderRow): Promise<CustomerChangeOrder> {
  const lines = await linesOf(tx, [order.id]);
  const [project] = await tx.select().from(schema.project)
    .where(eq(schema.project.id, order.projectId)).limit(1);
  if (!project) throw new NotFoundError("Project");
  const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
    .where(eq(schema.organization.id, order.organizationId)).limit(1);
  const [property] = await tx.select().from(schema.property)
    .where(eq(schema.property.id, project.propertyId)).limit(1);
  const [customer] = await tx.select({ name: schema.customer.name }).from(schema.customer)
    .where(eq(schema.customer.id, project.customerId)).limit(1);
  const [phase] = order.projectPhaseId
    ? await tx.select({ name: schema.projectPhase.name }).from(schema.projectPhase)
      .where(eq(schema.projectPhase.id, order.projectPhaseId)).limit(1)
    : [];

  const decided = order.status === "approved" || order.status === "declined";
  const contractValue = order.status === "approved" ? order.contractValueBefore : project.contractValue;
  return {
    organizationName: org?.name ?? "",
    projectName: project.name,
    propertyAddress: property
      ? [property.addressLine1, property.city, [property.state, property.postalCode].filter(Boolean).join(" ")]
        .filter(Boolean).join(", ")
      : "",
    customerName: customer?.name ?? "",
    number: order.number,
    title: order.title,
    description: order.description,
    reason: order.reason,
    phaseName: phase?.name ?? null,
    scheduleDays: order.scheduleDays,
    status: order.status,
    lines: lines.map((l) => ({
      name: l.name, description: l.description, quantity: l.quantity,
      unitPrice: l.unitPrice, lineTotal: l.lineTotal,
    })),
    amount: order.amount,
    contractValue,
    contractValueAfter: order.status === "approved"
      ? order.contractValueAfter
      : contractValue === null ? null : m.toString(m.add(m.money(contractValue), m.money(order.amount))),
    signerName: decided ? order.signerName : null,
    decidedAt: decided ? order.decidedAt?.toISOString() ?? null : null,
  };
}

async function orderForGrant(tx: Database, id: string): Promise<ChangeOrderRow> {
  const [row] = await tx.select().from(schema.projectChangeOrder)
    .where(eq(schema.projectChangeOrder.id, id)).limit(1);
  if (!row) throw new InvalidGrantError();
  return row;
}

/** Reading does not spend the link: the customer will open it more than once before signing. */
export async function viewForCustomer(db: Database, input: { token: string }): Promise<CustomerChangeOrder> {
  const grant = await peek(db, input.token);
  const id = requireScope(grant, "change_order");
  return inGrant(db, grant, async (tx) => customerView(tx, await orderForGrant(tx, id)));
}

/**
 * The customer signs. Spends the link, the way an estimate's approval does,
 * and runs the same `approveIn` the office's door runs. A change that can no
 * longer be agreed as written (the project billed more in the meantime) is
 * refused with the reason, and nothing changes.
 */
export async function approveForCustomer(
  db: Database,
  input: { token: string; signerName: string; acceptedTerms: true },
  request?: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<CustomerChangeOrder> {
  const grant = await consume(db, input.token, request?.ip);
  const id = requireScope(grant, "change_order");
  return inGrant(db, grant, async (tx, ctx) => {
    const order = await orderForGrant(tx, id);
    if (order.status === "approved") return customerView(tx, order);
    if (order.status !== "sent") throw new InvalidGrantError();
    await approveIn(tx, ctx, order, {
      signerName: input.signerName, via: "portal", ipAddress: request?.ip, userAgent: request?.userAgent,
    });
    return customerView(tx, await orderForGrant(tx, id));
  });
}

export async function declineForCustomer(
  db: Database, input: { token: string; reason?: string | undefined },
): Promise<{ ok: true }> {
  const grant = await consume(db, input.token);
  const id = requireScope(grant, "change_order");
  return inGrant(db, grant, async (tx, ctx) => {
    const order = await orderForGrant(tx, id);
    if (order.status === "declined") return { ok: true as const };
    if (order.status !== "sent") throw new InvalidGrantError();
    await declineIn(tx, ctx, order, { reason: input.reason ?? null, via: "portal" });
    return { ok: true as const };
  });
}

/**
 * Everything the printed change order needs: the office's view of it, and
 * the names and address that head the page. The figures are the customer's
 * view's, so the paper and the link cannot disagree about what the change
 * does to the contract.
 */
export async function documentFor(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const order = await loadIn(tx, ctx.actor.organizationId, input.id);
    const view = await viewIn(tx, ctx, order.id);
    const customer = await customerView(tx, order);
    const [signature] = await tx.select({ signedAt: schema.documentSignature.signedAt })
      .from(schema.documentSignature)
      .where(and(
        eq(schema.documentSignature.subject, "change_order"),
        eq(schema.documentSignature.subjectId, order.id),
      ))
      .orderBy(asc(schema.documentSignature.signedAt)).limit(1);
    return {
      ...view,
      organizationName: customer.organizationName,
      projectName: customer.projectName,
      customerName: customer.customerName,
      propertyAddress: customer.propertyAddress,
      contractValueNow: customer.contractValue,
      contractValueIfAgreed: customer.contractValueAfter,
      signedAt: signature?.signedAt ?? null,
      documentHash: order.documentHash,
    };
  });
}

/* ------------------------------------------------------------------ handlers */

export const handlers = {
  listChangeOrders: async (ctx: ServiceContext, input: { projectId: string }) =>
    ({ changeOrders: await list(ctx, input) }),
  getChangeOrder: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  requestChangeOrder: (ctx: ServiceContext, input: ChangeOrderInput) => request(ctx, input),
  updateChangeOrder: (ctx: ServiceContext, input: ChangeOrderUpdate) =>
    update(ctx, input),
  addChangeOrderLine: (ctx: ServiceContext, input: LineInput) => addLine(ctx, input),
  removeChangeOrderLine: (ctx: ServiceContext, input: { changeOrderId: string; lineId: string }) =>
    removeLine(ctx, input),
  sendChangeOrder: (ctx: ServiceContext, input: { id: string; channel?: "link" | "email" | undefined; expiresInDays?: number | undefined }) =>
    send(ctx, input),
  decideChangeOrder: (ctx: ServiceContext, input: {
    id: string; decision: "approved" | "declined"; signerName?: string | null | undefined; reason?: string | null | undefined;
  }) => decide(ctx, input),
  withdrawChangeOrder: (ctx: ServiceContext, input: { id: string; reason: string }) => withdraw(ctx, input),
} as const;
