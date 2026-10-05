import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ROLE_PRESETS, SYSTEM_USER_ID, inventory as inv, money as m, type Actor, type RoleId } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as once from "./once";
import * as email from "./email";

/**
 * WHO HAS TO SAY YES BEFORE AN ORDER GOES OUT
 *
 * The rules are `inv.approvalPlan` in core. This file keeps the steps a
 * company declares and the decisions people make, and answers for one order
 * where it stands.
 *
 * PERMISSIONS. Declaring the steps is `settings:write`: it is company policy
 * about who may commit money, set once by an owner or an administrator, and
 * the office manager who buys every week is exactly the person it must not
 * be left to. Deciding a step is `po:approve` AND holding the role the step
 * names, read from the person's membership rather than from the session's
 * role list, because a custom role replaces the preset it was copied from.
 * Reading the steps and an order's approvals is `po:read`, because a buyer
 * needs to see why their order is waiting.
 */

export interface ApprovalRuleView {
  id: string;
  step: number;
  minimumTotal: string;
  approverRole: string | null;
  approverRoleId: string | null;
  roleLabel: string;
  /** Orders to this vendor only, with a line from this category, or for this location. Null is any. */
  vendorId: string | null;
  categoryId: string | null;
  locationId: string | null;
  /** The scope in words: "orders from Ferguson, with a line from Refrigerant". Empty for every order. */
  scopeLabel: string;
}

const presetLabel = (role: string) => ROLE_PRESETS[role as RoleId]?.label ?? role;

async function rulesWithin(tx: Database): Promise<ApprovalRuleView[]> {
  const rows = await tx.select({
    rule: schema.purchaseApprovalRule, roleName: schema.role.name,
    vendorName: schema.vendor.name, categoryName: schema.priceBookCategory.name, locationName: schema.location.name,
  })
    .from(schema.purchaseApprovalRule)
    .leftJoin(schema.role, eq(schema.role.id, schema.purchaseApprovalRule.approverRoleId))
    .leftJoin(schema.vendor, eq(schema.vendor.id, schema.purchaseApprovalRule.vendorId))
    .leftJoin(schema.priceBookCategory, eq(schema.priceBookCategory.id, schema.purchaseApprovalRule.categoryId))
    .leftJoin(schema.location, eq(schema.location.id, schema.purchaseApprovalRule.locationId))
    .where(isNull(schema.purchaseApprovalRule.deletedAt))
    .orderBy(asc(schema.purchaseApprovalRule.step));
  return rows.map(({ rule, roleName, vendorName, categoryName, locationName }) => ({
    id: rule.id,
    step: rule.step,
    minimumTotal: m.toString(m.round(m.money(rule.minimumTotal), 2)),
    approverRole: rule.approverRole,
    approverRoleId: rule.approverRoleId,
    roleLabel: rule.approverRole ? presetLabel(rule.approverRole) : roleName ?? "A role that was removed",
    vendorId: rule.vendorId,
    categoryId: rule.categoryId,
    locationId: rule.locationId,
    scopeLabel: scopeLabel({ vendorName, categoryName, locationName }),
  }));
}

/** "orders from Ferguson, with a line from Refrigerant, for North yard", or empty for every order. */
function scopeLabel(scope: { vendorName: string | null; categoryName: string | null; locationName: string | null }): string {
  const parts = [
    scope.vendorName ? `from ${scope.vendorName}` : null,
    scope.categoryName ? `with a line from ${scope.categoryName}` : null,
    scope.locationName ? `for ${scope.locationName}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? "" : `orders ${parts.join(", ")}`;
}

export function listRules(ctx: ServiceContext) {
  return guardedRead(ctx, "po:read", (tx) => rulesWithin(tx));
}

/**
 * Declare a step. Given no step number it goes after the last one.
 *
 * A LATER STEP MAY NOT ASK LESS THAN AN EARLIER ONE. Step two at five
 * hundred and step one at a thousand would mean a seven hundred dollar order
 * waits on step two's approver while step one, which comes first, does not
 * apply, and nobody could say what the company meant.
 */
export function addRule(ctx: ServiceContext, input: {
  step?: number | undefined;
  minimumTotal: string;
  approverRole?: string | null | undefined;
  approverRoleId?: string | null | undefined;
  vendorId?: string | null | undefined;
  categoryId?: string | null | undefined;
  locationId?: string | null | undefined;
}) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const seen = await once.replayed<ApprovalRuleView>(tx, ctx, "purchase_approval_rule");
    if (seen) return seen;

    const role = input.approverRole ?? null;
    const roleId = input.approverRoleId ?? null;
    if ((role === null) === (roleId === null)) {
      throw new ConflictError("Name one role for the step: a preset, or one of the company's own roles.");
    }
    if (role !== null && !(role in ROLE_PRESETS)) throw new ConflictError(`"${role}" is not a role.`);
    if (roleId !== null) {
      const [found] = await tx.select({ id: schema.role.id }).from(schema.role)
        .where(and(eq(schema.role.id, roleId), isNull(schema.role.deletedAt))).limit(1);
      if (!found) throw new NotFoundError("Role");
    }
    const minimum = m.money(input.minimumTotal);
    if (m.isNegative(minimum)) throw new ConflictError("An approval threshold cannot be below zero.");

    const vendorId = input.vendorId ?? null;
    const categoryId = input.categoryId ?? null;
    const locationId = input.locationId ?? null;
    if (vendorId) {
      const [found] = await tx.select({ id: schema.vendor.id }).from(schema.vendor)
        .where(and(eq(schema.vendor.id, vendorId), isNull(schema.vendor.deletedAt))).limit(1);
      if (!found) throw new NotFoundError("Vendor");
    }
    if (categoryId) {
      const [found] = await tx.select({ id: schema.priceBookCategory.id }).from(schema.priceBookCategory)
        .where(and(eq(schema.priceBookCategory.id, categoryId), isNull(schema.priceBookCategory.deletedAt))).limit(1);
      if (!found) throw new NotFoundError("Category");
    }
    if (locationId) {
      const [found] = await tx.select({ id: schema.location.id }).from(schema.location)
        .where(eq(schema.location.id, locationId)).limit(1);
      if (!found) throw new NotFoundError("Location");
    }
    const scoped = vendorId !== null || categoryId !== null || locationId !== null;

    const existing = await rulesWithin(tx);
    const step = input.step ?? (existing.at(-1)?.step ?? 0) + 1;
    if (!Number.isInteger(step) || step < 1) throw new ConflictError("A step is a whole number from one.");
    if (existing.some((r) => r.step === step)) {
      throw new ConflictError(`There is already a step ${step}. Remove it first, or number this one after it.`);
    }
    /**
     * The order of amounts is a rule among steps for EVERY order. A step for
     * one vendor or one category applies to some orders only, so whether it
     * comes before or after an unscoped step at a different amount says
     * nothing contradictory, and it is not held to the order.
     */
    const unscoped = scoped ? [] : existing.filter((r) => !r.vendorId && !r.categoryId && !r.locationId);
    const before = unscoped.filter((r) => r.step < step).at(-1);
    const after = unscoped.find((r) => r.step > step);
    if (before && m.compare(minimum, m.money(before.minimumTotal)) < 0) {
      throw new ConflictError(
        `Step ${step} would start below step ${before.step} (${m.format(m.money(before.minimumTotal))}). `
        + "A later step asks for more, never less, or an order could wait on step two while step one does not apply.",
      );
    }
    if (after && m.compare(minimum, m.money(after.minimumTotal)) > 0) {
      throw new ConflictError(
        `Step ${step} would start above step ${after.step} (${m.format(m.money(after.minimumTotal))}), which comes after it.`,
      );
    }

    const [row] = await tx.insert(schema.purchaseApprovalRule).values({
      organizationId: ctx.actor.organizationId,
      step,
      minimumTotal: m.toString(minimum),
      approverRole: role as typeof schema.memberRole.enumValues[number] | null,
      approverRoleId: roleId,
      vendorId,
      categoryId,
      locationId,
      createdByUserId: ctx.actor.userId,
    }).returning();
    await audit(tx, ctx, "purchase_approval_rule.added", "purchase_approval_rule", row!.id, null, row!);
    const answer = (await rulesWithin(tx)).find((r) => r.id === row!.id)!;
    await once.remember(tx, ctx, "purchase_approval_rule", row!.id, answer);
    return answer;
  });
}

/**
 * Stop asking for a step. Orders already decided keep the decisions, which
 * copied what was asked; an order still waiting stops waiting on it.
 */
export function removeRule(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [row] = await tx.update(schema.purchaseApprovalRule)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.purchaseApprovalRule.id, input.id), isNull(schema.purchaseApprovalRule.deletedAt)))
      .returning();
    if (!row) throw new NotFoundError("Approval step");
    await audit(tx, ctx, "purchase_approval_rule.removed", "purchase_approval_rule", row.id, row, null);
    return { id: row.id, removed: true as const };
  });
}

/**
 * An order's total, from its lines, as every screen and the email show it. A
 * line bought by the pack is its packs at the pack price, exactly.
 */
export function totalOf(lines: readonly {
  unitPrice: string; quantityOrdered: string; packQuantity?: string | null; packPrice?: string | null;
}[]): m.Money {
  return m.round(m.sum(lines.map((l) => inv.lineCost({
    unitPrice: m.money(l.unitPrice),
    ...(l.packQuantity ? { packQuantity: inv.quantity(l.packQuantity) } : {}),
    ...(l.packPrice ? { packPrice: m.money(l.packPrice) } : {}),
  }, inv.quantity(l.quantityOrdered)))), 2);
}

export interface PlanView {
  state: inv.ApprovalPlan["state"];
  sentence: string;
  steps: {
    step: number; minimumTotal: string; roleLabel: string;
    state: "approved" | "rejected" | "waiting" | "later";
    decidedBy: string | null; decidedAt: string | null; note: string | null;
    /** Which orders the step is for, in words. Empty for every order. */
    scopeLabel: string;
  }[];
}

/**
 * Where one order stands, inside a caller's transaction. Read by sending,
 * by the order's screen, and by deciding a step.
 */
export async function planWithin(tx: Database, orderId: string): Promise<{ plan: inv.ApprovalPlan; view: PlanView; total: m.Money }> {
  const lines = await tx.select({
    unitPrice: schema.purchaseOrderLine.unitPrice, quantityOrdered: schema.purchaseOrderLine.quantityOrdered,
    packQuantity: schema.purchaseOrderLine.packQuantity, packPrice: schema.purchaseOrderLine.packPrice,
    locationId: schema.purchaseOrderLine.locationId, categoryId: schema.priceBookItem.categoryId,
  }).from(schema.purchaseOrderLine)
    .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.purchaseOrderLine.itemId))
    .where(eq(schema.purchaseOrderLine.purchaseOrderId, orderId));
  const [order] = await tx.select({ vendorId: schema.purchaseOrder.vendorId }).from(schema.purchaseOrder)
    .where(eq(schema.purchaseOrder.id, orderId)).limit(1);
  const total = totalOf(lines);
  const rules = await rulesWithin(tx);
  /** Decisions an edit set aside are kept as the record and asked of nobody. */
  const decisions = await tx.select().from(schema.purchaseOrderApproval)
    .where(and(eq(schema.purchaseOrderApproval.purchaseOrderId, orderId), isNull(schema.purchaseOrderApproval.supersededAt)))
    .orderBy(asc(schema.purchaseOrderApproval.step));

  const plan = inv.approvalPlan({
    rules: rules.map((r) => ({
      id: r.id, step: r.step, minimumTotal: m.money(r.minimumTotal), roleLabel: r.roleLabel,
      role: r.approverRole, roleId: r.approverRoleId,
      vendorId: r.vendorId, categoryId: r.categoryId, locationId: r.locationId, scopeLabel: r.scopeLabel,
    })),
    order: {
      vendorId: order?.vendorId ?? "",
      categoryIds: [...new Set(lines.map((l) => l.categoryId).filter((id): id is string => id !== null))],
      locationIds: [...new Set(lines.map((l) => l.locationId))],
    },
    total,
    approvals: decisions.map((d) => ({
      step: d.step, decision: d.decision, decidedByUserId: d.decidedByUserId,
      roleLabel: d.roleLabel, minimumTotal: m.money(d.minimumTotal),
    })),
  });

  const names = await namesOf(tx, decisions.map((d) => d.decidedByUserId).filter((id): id is string => id !== null));
  return {
    plan,
    total,
    view: {
      state: plan.state,
      sentence: plan.sentence,
      steps: plan.steps.map((s) => {
        const d = decisions.find((row) => row.step === s.step);
        return {
          step: s.step,
          minimumTotal: m.toString(m.round(s.minimumTotal, 2)),
          roleLabel: s.roleLabel,
          state: s.state,
          decidedBy: d?.decidedByUserId ? names.get(d.decidedByUserId) ?? "Somebody who has left" : null,
          decidedAt: d?.createdAt.toISOString() ?? null,
          note: d?.note ?? null,
          scopeLabel: s.scopeLabel,
        };
      }),
    },
  };
}

const sqlPeople = sql`select user_id, name, email from app.organization_people()`;

/**
 * Colleagues' names, through the directory function rather than a join to
 * `user`, whose row level security returns only the caller's own row.
 */
async function namesOf(tx: Database, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sqlPeople,
  );
  return new Map(rows.filter((r) => userIds.includes(r.user_id)).map((r) => [r.user_id, r.name ?? r.email]));
}

/**
 * Approve or reject the step that is waiting.
 *
 * `po:approve` first, then the role the step names, read from the person's
 * own membership. Nobody decides two steps of one order: see core.
 */
export function decide(ctx: ServiceContext, input: {
  id: string; decision: "approved" | "rejected"; note?: string | null | undefined;
}) {
  return guardedWrite(ctx, "po:approve", async (tx) => {
    const seen = await once.replayed<PlanView>(tx, ctx, "purchase_order_approval");
    if (seen) return seen;
    const [order] = await tx.select().from(schema.purchaseOrder)
      .where(and(eq(schema.purchaseOrder.id, input.id), isNull(schema.purchaseOrder.deletedAt))).limit(1);
    if (!order) throw new NotFoundError("Purchase order");
    if (order.status !== "draft") {
      throw new ConflictError("This order has already gone to the vendor, or been closed, so there is nothing left to approve.");
    }
    const note = input.note?.trim() || null;
    if (input.decision === "rejected" && !note) {
      throw new ConflictError("Say why it is rejected. The buyer has to know what to change before raising it again.");
    }

    const [member] = await tx.select({ role: schema.membership.role, roleId: schema.membership.roleId })
      .from(schema.membership)
      .where(and(eq(schema.membership.userId, ctx.actor.userId), eq(schema.membership.active, true)))
      .limit(1);
    if (!member) throw new ConflictError("Only somebody on the team can approve an order.");

    const { plan, total } = await planWithin(tx, order.id);
    const check = inv.checkDecision({
      plan,
      userId: ctx.actor.userId,
      holds: (step) => step.roleId !== null
        ? member.roleId === step.roleId
        : member.roleId === null && member.role === step.role,
    });
    if (!check.ok) throw new ConflictError(check.message);

    await tx.insert(schema.purchaseOrderApproval).values({
      organizationId: ctx.actor.organizationId,
      purchaseOrderId: order.id,
      ruleId: check.step.ruleId,
      step: check.step.step,
      minimumTotal: m.toString(check.step.minimumTotal),
      roleLabel: check.step.roleLabel,
      orderTotal: m.toString(total),
      decision: input.decision,
      decidedByUserId: ctx.actor.userId,
      note,
    });
    await audit(tx, ctx, `purchase_order.${input.decision}`, "purchase_order", order.id, null, {
      step: check.step.step, total: m.toString(total), note,
    });
    /** The next step's approvers are told it is their turn. */
    if (input.decision === "approved") await tellApproversWithin(tx, ctx, order.id);
    const view = (await planWithin(tx, order.id)).view;
    await once.remember(tx, ctx, "purchase_order_approval", order.id, view);
    return view;
  });
}

/**
 * After an edit, set aside every approval the new total is above. They stay
 * as the record that they were given; the steps ask again. Returns which.
 */
export async function setAsideAbove(tx: Database, orderId: string): Promise<number[]> {
  const { total } = await planWithin(tx, orderId);
  const standing = await tx.select().from(schema.purchaseOrderApproval)
    .where(and(eq(schema.purchaseOrderApproval.purchaseOrderId, orderId), isNull(schema.purchaseOrderApproval.supersededAt)));
  const steps = inv.approvalsUndoneBy(total, standing.map((d) => ({
    step: d.step, decision: d.decision, orderTotal: m.money(d.orderTotal),
  })));
  if (steps.length > 0) {
    await tx.update(schema.purchaseOrderApproval).set({ supersededAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.purchaseOrderApproval.purchaseOrderId, orderId),
        isNull(schema.purchaseOrderApproval.supersededAt),
        inArray(schema.purchaseOrderApproval.step, steps),
      ));
  }
  return steps;
}

/* ------------------------------------------------- telling the approvers */

export interface NoticeView {
  step: number;
  name: string;
  destination: string;
  state: string;
  explanation: string | null;
  at: string;
}

/**
 * A buyer's context with the transport's `message:send` beneath it, as the
 * order email does: a buyer tells colleagues an order waits for them, and
 * has no business texting customers.
 */
function transportContext(ctx: ServiceContext, tx: Database): ServiceContext {
  const actor: Actor = { ...ctx.actor, grants: [...(ctx.actor.grants ?? []), "message:send"] };
  return { ...ctx, actor, db: tx };
}

/** Where the office's own pages are, for a link in a colleague's email. Null when the deployment has not said. */
const officeBase = (env: Record<string, string | undefined> = process.env): string | null =>
  (env["PUBLIC_URL"] || env["AUTH_URL"] || "").replace(/\/+$/, "") || null;

/**
 * TELL THE PEOPLE AN ORDER IS WAITING FOR.
 *
 * Everybody holding the role the waiting step names, by email, through the
 * company's own email path. Not the people who already decided a step of
 * this order, because they cannot decide another. Once per person per step
 * per round: a step asked again after an edit is a new round and tells them
 * again, and anything else that calls this twice tells nobody twice.
 *
 * Every attempt is a row on the order, whether the email went or not. With
 * no email connected each is refused in words, and the order's page says so,
 * because "I assumed the owner had been told" is how an order sits a week.
 * A refusal never stops the order being written: the approver can still find
 * it on the purchasing list.
 */
export async function tellApproversWithin(tx: Database, ctx: ServiceContext, orderId: string): Promise<void> {
  const { plan, total } = await planWithin(tx, orderId);
  if (plan.state !== "waiting" || !plan.next) return;
  const step = plan.next;

  const members = await tx.select({
    id: schema.membership.id, userId: schema.membership.userId, role: schema.membership.role, roleId: schema.membership.roleId,
  }).from(schema.membership).where(eq(schema.membership.active, true));
  const holders = members.filter((member) => (step.roleId !== null
    ? member.roleId === step.roleId
    : member.roleId === null && member.role === step.role));
  const decided = new Set(plan.steps.filter((s) => s.state !== "waiting" && s.decidedByUserId).map((s) => s.decidedByUserId!));
  const people = await tx.execute<{ user_id: string; name: string | null; email: string }>(sqlPeople);
  const personOf = new Map(people.map((p) => [p.user_id, p]));

  /** The latest edit that asked again starts a new round. */
  const [round] = await tx.select({ at: sql<Date | null>`max(${schema.purchaseOrderApproval.supersededAt})` })
    .from(schema.purchaseOrderApproval).where(eq(schema.purchaseOrderApproval.purchaseOrderId, orderId));
  const roundStart = round?.at ? new Date(round.at) : new Date(0);
  const told = await tx.select({ userId: schema.purchaseOrderApprovalNotice.userId, at: schema.purchaseOrderApprovalNotice.createdAt })
    .from(schema.purchaseOrderApprovalNotice)
    .where(and(eq(schema.purchaseOrderApprovalNotice.purchaseOrderId, orderId), eq(schema.purchaseOrderApprovalNotice.step, step.step)));
  const toldNow = new Set(told.filter((t) => t.at > roundStart).map((t) => t.userId));

  const [order] = await tx.select({ number: schema.purchaseOrder.number, vendorName: schema.vendor.name })
    .from(schema.purchaseOrder).innerJoin(schema.vendor, eq(schema.vendor.id, schema.purchaseOrder.vendorId))
    .where(eq(schema.purchaseOrder.id, orderId)).limit(1);
  if (!order) return;
  const base = officeBase();
  const link = base ? `${base}/purchasing/${orderId}` : null;

  for (const holder of holders) {
    if (decided.has(holder.userId) || toldNow.has(holder.userId)) continue;
    const person = personOf.get(holder.userId);
    if (!person?.email) continue;
    const subject = `Purchase order ${order.number} is waiting for your approval`;
    const text = [
      `Purchase order ${order.number} to ${order.vendorName}, for ${m.format(total)}, is waiting for you to approve it.`,
      "",
      plan.sentence,
      "",
      link ? `Open it: ${link}` : `Open it from Purchasing: order ${order.number}.`,
    ].join("\n");
    const html = `<p>Purchase order <strong>${order.number}</strong> to ${escapeHtml(order.vendorName)}, for ${escapeHtml(m.format(total))}, is waiting for you to approve it.</p>`
      + `<p>${escapeHtml(plan.sentence)}</p>`
      + (link ? `<p><a href="${escapeHtml(link)}">Open the order</a></p>` : `<p>Open it from Purchasing: order ${order.number}.</p>`);
    const outcome = await email.queue(transportContext(ctx, tx), {
      to: person.email, subject, text, html, purpose: "transactional",
    });
    await tx.insert(schema.purchaseOrderApprovalNotice).values({
      organizationId: ctx.actor.organizationId,
      purchaseOrderId: orderId,
      step: step.step,
      userId: holder.userId,
      destination: email.normalizeAddress(person.email),
      state: outcome.queued ? "queued" : "refused",
      explanation: outcome.queued ? null : outcome.explanation,
      messageId: outcome.queued ? outcome.messageId : null,
    });
  }
  await audit(tx, ctx, "purchase_order.approvers_told", "purchase_order", orderId, null, {
    step: step.step, actor: ctx.actor.userId === SYSTEM_USER_ID ? "system" : "user",
  });
}

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Who was told an order waits for them, newest first. */
export async function noticesWithin(tx: Database, orderId: string): Promise<NoticeView[]> {
  const rows = await tx.select().from(schema.purchaseOrderApprovalNotice)
    .where(eq(schema.purchaseOrderApprovalNotice.purchaseOrderId, orderId))
    .orderBy(sql`${schema.purchaseOrderApprovalNotice.createdAt} desc`);
  const names = await namesOf(tx, rows.map((r) => r.userId).filter((id): id is string => id !== null));
  return rows.map((r) => ({
    step: r.step,
    name: r.userId ? names.get(r.userId) ?? r.destination : r.destination,
    destination: r.destination,
    state: r.state,
    explanation: r.explanation,
    at: r.createdAt.toISOString(),
  }));
}

/** One order's approval state, for a screen or the API. */
export function approvalsFor(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "po:read", async (tx) => {
    const [order] = await tx.select({ id: schema.purchaseOrder.id }).from(schema.purchaseOrder)
      .where(and(eq(schema.purchaseOrder.id, input.id), isNull(schema.purchaseOrder.deletedAt))).limit(1);
    if (!order) throw new NotFoundError("Purchase order");
    return (await planWithin(tx, order.id)).view;
  });
}

export const handlers = {
  listPurchaseApprovalRules: async (ctx: ServiceContext): Promise<{ rules: ApprovalRuleView[] }> =>
    ({ rules: await listRules(ctx) }),
  addPurchaseApprovalRule: (ctx: ServiceContext, input: {
    step?: number | undefined; minimumTotal: string;
    approverRole?: string | null | undefined; approverRoleId?: string | null | undefined;
    vendorId?: string | null | undefined; categoryId?: string | null | undefined; locationId?: string | null | undefined;
  }): Promise<ApprovalRuleView> => addRule(ctx, input),
  removePurchaseApprovalRule: (ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> =>
    removeRule(ctx, input),
  getPurchaseOrderApprovals: (ctx: ServiceContext, input: { id: string }): Promise<PlanView> => approvalsFor(ctx, input),
  decidePurchaseOrder: (ctx: ServiceContext, input: {
    id: string; decision: "approved" | "rejected"; note?: string | null | undefined;
  }): Promise<PlanView> => decide(ctx, input),
} as const;
