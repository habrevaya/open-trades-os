import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";
import { PurchaseOrderApprovalState, PurchaseOrderStatus } from "./inventory";

/**
 * APPROVING AN ORDER, AND SENDING IT
 *
 * A company declares approval STEPS: an order at or over an amount needs
 * somebody holding a named role to approve it, the steps taken in order, and
 * no person deciding two steps of one order. An order no step applies to
 * goes out on its sender's own `po:approve`, as it always did.
 *
 * Sending is by email, through the company's own mail path, with every line
 * in the body and a link that opens the order printable as the vendor reads
 * it. Every attempt is recorded on the order, whether it went or not.
 */

const RoleName = z.enum([
  "owner", "admin", "office_manager", "branch_manager", "dispatcher", "csr", "technician", "crew_lead", "accountant", "readonly",
]);

const Rule = z.object({
  id: Uuid,
  step: z.number().int(),
  minimumTotal: MoneyString,
  approverRole: z.string().nullable(),
  approverRoleId: Uuid.nullable(),
  roleLabel: z.string(),
});

export const listPurchaseApprovalRules = defineRoute({
  method: "get",
  path: "/v1/purchase-approval-rules",
  summary: "The approval steps for purchase orders",
  module: "M16",
  permissions: ["po:read"],
  input: z.object({}),
  output: z.object({ rules: z.array(Rule) }),
});

export const addPurchaseApprovalRule = defineRoute({
  method: "post",
  path: "/v1/purchase-approval-rules",
  summary: "Add an approval step",
  description:
    "Orders at or over `minimumTotal` need this step, approved by somebody holding the role: a preset (`approverRole`) or one of the company's own roles (`approverRoleId`), exactly one. A later step may not start below an earlier one. Company policy about who may commit money, so `settings:write`.",
  module: "M16",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    step: z.number().int().min(1).max(20).optional(),
    minimumTotal: MoneyString,
    approverRole: RoleName.nullable().optional(),
    approverRoleId: Uuid.nullable().optional(),
  }),
  output: Rule,
});

export const removePurchaseApprovalRule = defineRoute({
  method: "post",
  path: "/v1/purchase-approval-rules/{id}/remove",
  summary: "Stop asking for an approval step",
  description: "Decisions already made on orders stand: each copied what was asked. An order still waiting stops waiting on this step.",
  module: "M16",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.boolean() }),
});

export const getPurchaseOrderApprovals = defineRoute({
  method: "get",
  path: "/v1/purchase-orders/{id}/approvals",
  summary: "Where an order stands against the approval steps",
  module: "M16",
  permissions: ["po:read"],
  input: z.object({ id: Uuid }),
  output: PurchaseOrderApprovalState,
});

export const decidePurchaseOrder = defineRoute({
  method: "post",
  path: "/v1/purchase-orders/{id}/approvals",
  summary: "Approve or reject the step that is waiting",
  description:
    "Needs `po:approve` and the role the waiting step names, read from the person's membership: a custom role replaces the preset it was copied from. Nobody decides two steps of one order. A rejection needs a reason and ends it: the order is cancelled and a corrected one raised, rather than asked again until somebody says yes.",
  module: "M16",
  permissions: ["po:approve"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    decision: z.enum(["approved", "rejected"]),
    note: z.string().max(1000).nullable().optional(),
  }),
  output: PurchaseOrderApprovalState,
});

export const emailPurchaseOrder = defineRoute({
  method: "post",
  path: "/v1/purchase-orders/{id}/email",
  summary: "Email an order to the vendor",
  description:
    "To the vendor's address on file, or `to`. The email carries every line and a link to the order printable as the vendor reads it. Emailing a draft SENDS it: approval is checked first exactly as submitting does, and the order is marked sent only when the email was queued. Emailing an order already sent is a copy. Every attempt is recorded on the order; one the mail provider would not take says why and leaves a draft a draft. Queued is not delivered, and the order says queued.",
  module: "M16",
  permissions: ["po:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    to: z.string().email().max(320).nullable().optional(),
    message: z.string().max(2000).nullable().optional(),
  }),
  output: z.object({
    sendId: Uuid,
    state: z.enum(["queued", "refused"]),
    destination: z.string(),
    explanation: z.string().nullable(),
    status: PurchaseOrderStatus,
    /** The printable link, once. Empty on a replay, because only its hash is kept. */
    link: z.string(),
  }),
});

export const listPurchaseOrderSends = defineRoute({
  method: "get",
  path: "/v1/purchase-orders/{id}/sends",
  summary: "Every time an order was emailed",
  module: "M16",
  permissions: ["po:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    sends: z.array(z.object({
      id: Uuid, destination: z.string().nullable(), state: z.string(), explanation: z.string().nullable(),
      sentAt: z.string().datetime(), sentBy: z.string().nullable(), linkExpiresAt: z.string().datetime().nullable(),
    })),
  }),
});

export const purchasingRoutes = {
  listPurchaseApprovalRules, addPurchaseApprovalRule, removePurchaseApprovalRule,
  getPurchaseOrderApprovals, decidePurchaseOrder, emailPurchaseOrder, listPurchaseOrderSends,
} as const;
