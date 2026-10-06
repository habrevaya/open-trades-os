import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ROLE_PRESETS, inventory as inv, money as m, type RoleId } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as once from "./once";

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
}

const presetLabel = (role: string) => ROLE_PRESETS[role as RoleId]?.label ?? role;

async function rulesWithin(tx: Database): Promise<ApprovalRuleView[]> {
  const rows = await tx.select({ rule: schema.purchaseApprovalRule, roleName: schema.role.name })
    .from(schema.purchaseApprovalRule)
    .leftJoin(schema.role, eq(schema.role.id, schema.purchaseApprovalRule.approverRoleId))
    .where(isNull(schema.purchaseApprovalRule.deletedAt))
    .orderBy(asc(schema.purchaseApprovalRule.step));
  return rows.map(({ rule, roleName }) => ({
    id: rule.id,
    step: rule.step,
    minimumTotal: m.toString(m.round(m.money(rule.minimumTotal), 2)),
    approverRole: rule.approverRole,
    approverRoleId: rule.approverRoleId,
    roleLabel: rule.approverRole ? presetLabel(rule.approverRole) : roleName ?? "A role that was removed",
  }));
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

    const existing = await rulesWithin(tx);
    const step = input.step ?? (existing.at(-1)?.step ?? 0) + 1;
    if (!Number.isInteger(step) || step < 1) throw new ConflictError("A step is a whole number from one.");
    if (existing.some((r) => r.step === step)) {
      throw new ConflictError(`There is already a step ${step}. Remove it first, or number this one after it.`);
    }
    const before = existing.filter((r) => r.step < step).at(-1);
    const after = existing.find((r) => r.step > step);
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

/** An order's total, from its lines, as every screen and the email show it. */
export function totalOf(lines: readonly { unitPrice: string; quantityOrdered: string }[]): m.Money {
  return m.round(m.sum(lines.map((l) =>
    m.multiply(m.money(l.unitPrice), inv.quantityToString(inv.quantity(l.quantityOrdered))))), 2);
}

export interface PlanView {
  state: inv.ApprovalPlan["state"];
  sentence: string;
  steps: {
    step: number; minimumTotal: string; roleLabel: string;
    state: "approved" | "rejected" | "waiting" | "later";
    decidedBy: string | null; decidedAt: string | null; note: string | null;
  }[];
}

/**
 * Where one order stands, inside a caller's transaction. Read by sending,
 * by the order's screen, and by deciding a step.
 */
export async function planWithin(tx: Database, orderId: string): Promise<{ plan: inv.ApprovalPlan; view: PlanView; total: m.Money }> {
  const lines = await tx.select({
    unitPrice: schema.purchaseOrderLine.unitPrice, quantityOrdered: schema.purchaseOrderLine.quantityOrdered,
  }).from(schema.purchaseOrderLine).where(eq(schema.purchaseOrderLine.purchaseOrderId, orderId));
  const total = totalOf(lines);
  const rules = await rulesWithin(tx);
  const decisions = await tx.select().from(schema.purchaseOrderApproval)
    .where(eq(schema.purchaseOrderApproval.purchaseOrderId, orderId))
    .orderBy(asc(schema.purchaseOrderApproval.step));

  const plan = inv.approvalPlan({
    rules: rules.map((r) => ({
      id: r.id, step: r.step, minimumTotal: m.money(r.minimumTotal), roleLabel: r.roleLabel,
      role: r.approverRole, roleId: r.approverRoleId,
    })),
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
    const view = (await planWithin(tx, order.id)).view;
    await once.remember(tx, ctx, "purchase_order_approval", order.id, view);
    return view;
  });
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
  }): Promise<ApprovalRuleView> => addRule(ctx, input),
  removePurchaseApprovalRule: (ctx: ServiceContext, input: { id: string }): Promise<{ id: string; removed: true }> =>
    removeRule(ctx, input),
  getPurchaseOrderApprovals: (ctx: ServiceContext, input: { id: string }): Promise<PlanView> => approvalsFor(ctx, input),
  decidePurchaseOrder: (ctx: ServiceContext, input: {
    id: string; decision: "approved" | "rejected"; note?: string | null | undefined;
  }): Promise<PlanView> => decide(ctx, input),
} as const;
