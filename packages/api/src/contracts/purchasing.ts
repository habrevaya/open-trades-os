import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";
import { PurchaseOrderApprovalState, PurchaseOrderStatus, QuantityString, StockUnitInput } from "./inventory";

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
  /** Orders to this vendor only. Null is any vendor. */
  vendorId: Uuid.nullable(),
  /** Orders with a line from this price book category. Null is any. */
  categoryId: Uuid.nullable(),
  /** Orders delivering anywhere to this location. Null is any. */
  locationId: Uuid.nullable(),
  /** The scope in words: "orders from Ferguson, with a line from Refrigerant". Empty for every order. */
  scopeLabel: z.string(),
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
    "Orders at or over `minimumTotal` need this step, approved by somebody holding the role: a preset (`approverRole`) or one of the company's own roles (`approverRoleId`), exactly one. A step can be for some orders only: to one vendor (`vendorId`), with any line from one price book category (`categoryId`), or delivering to one location (`locationId`), all that are given holding; the amount is always the whole order's total. Among steps for every order, a later step may not start below an earlier one. Company policy about who may commit money, so `settings:write`.",
  module: "M16",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    step: z.number().int().min(1).max(20).optional(),
    minimumTotal: MoneyString,
    approverRole: RoleName.nullable().optional(),
    approverRoleId: Uuid.nullable().optional(),
    vendorId: Uuid.nullable().optional(),
    categoryId: Uuid.nullable().optional(),
    locationId: Uuid.nullable().optional(),
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
    "Needs `po:approve` and the role the waiting step names, read from the person's membership: a custom role replaces the preset it was copied from. Nobody decides two steps of one order. A rejection needs a reason and ends it: the order is cancelled and a corrected one raised, rather than asked again until somebody says yes. An approval that leaves another step waiting emails that step's approvers.",
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
    "To the vendor's address on file, or `to`. The email carries every line, the order as a PDF attachment, and a link to the order printable as the vendor reads it. Emailing a draft SENDS it: approval is checked first exactly as submitting does, and the order is marked sent only when the email was queued. Emailing an order already sent is a copy. Every attempt is recorded on the order; one the mail provider would not take says why and leaves a draft a draft. Queued is not delivered, and the order says queued.",
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

export const recordLateLandedCost = defineRoute({
  method: "post",
  path: "/v1/purchase-order-receipts/{id}/late-charges",
  summary: "Spread a freight or duty bill that came after the delivery",
  description:
    "For one delivery received against an order. The bill is spread over that delivery's lines by value or quantity (`basis`, the delivery's own when left out) to the cent, and each line's share follows its parts: onto the shelf where they still are, raising its value; onto each job that used them, as that job's cost of goods sold, which job costing reads; and onto stock already scrapped, counted short or sent back, as a cost with no job. Leftover cents land by a fixed rule, so the same bill on the same history lands the same way. One balanced ledger posting: inventory, cost of goods sold by job, cost of goods sold, and the whole bill in accounts payable. Refused when the history cannot account for every part that arrived.",
  module: "M16",
  permissions: ["po:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    charges: z.array(z.object({ description: z.string().min(1).max(200), amount: MoneyString })).min(1).max(20),
    basis: z.enum(["value", "quantity"]).optional(),
    reference: z.string().max(100).nullable().optional(),
  }),
  output: z.object({
    id: Uuid,
    receiptId: Uuid,
    purchaseOrderId: Uuid,
    total: MoneyString,
    onShelf: MoneyString,
    onJobs: MoneyString,
    onGone: MoneyString,
    jobs: z.array(z.object({ jobId: Uuid, jobNumber: z.number().int().nullable(), amount: MoneyString })),
  }),
});

const VendorReturn = z.object({
  id: Uuid,
  number: z.number().int(),
  vendorId: Uuid,
  vendorName: z.string(),
  /** `awaiting_credit` until the vendor's credit memo is recorded. */
  status: z.enum(["awaiting_credit", "credited"]),
  reason: z.string(),
  /** The vendor's return authorisation number. */
  reference: z.string().nullable(),
  creditExpected: MoneyString,
  creditReceived: MoneyString.nullable(),
  creditReceivedAt: z.string().datetime().nullable(),
  creditReference: z.string().nullable(),
  createdAt: z.string().datetime(),
  units: z.array(z.object({
    itemId: Uuid, itemName: z.string(), number: z.string(), quantity: QuantityString, locationName: z.string(),
  })),
});

export const listVendorReturns = defineRoute({
  method: "get",
  path: "/v1/vendor-returns",
  summary: "Units sent back to vendors, and the credit each owes",
  module: "M16",
  permissions: ["po:read"],
  input: z.object({ status: z.enum(["awaiting_credit", "credited"]).optional() }),
  output: z.object({ returns: z.array(VendorReturn) }),
});

export const createVendorReturn = defineRoute({
  method: "post",
  path: "/v1/vendor-returns",
  summary: "Send serials or lots back to a vendor for credit",
  description:
    "By number, from the location named. The units leave stock; the return expects a credit from the vendor of what the goods cost on the order they came on, without freight, unless `creditExpected` says otherwise (a restocking fee). A unit that arrived on another vendor's order is refused. Nothing about the credit posts to the ledger, because receiving stock does not; late freight the units carried leaves stock as for any loss. Needs `po:write` and `inventory:adjust`: it is a dealing with a vendor and a move off the shelf.",
  module: "M16",
  permissions: ["po:write", "inventory:adjust"],
  idempotent: true,
  input: z.object({
    vendorId: Uuid,
    itemId: Uuid,
    locationId: Uuid,
    units: z.array(StockUnitInput.pick({ number: true, quantity: true })).min(1).max(500),
    reason: z.string().min(1).max(500),
    reference: z.string().max(100).nullable().optional(),
    creditExpected: MoneyString.nullable().optional(),
  }),
  output: VendorReturn,
});

export const recordVendorCredit = defineRoute({
  method: "post",
  path: "/v1/vendor-returns/{id}/credit",
  summary: "Record the vendor's credit for a return",
  description: "What the credit memo gave, beside what was expected, so a credit short by a fee nobody agreed to is visible.",
  module: "M16",
  permissions: ["po:write"],
  idempotent: true,
  input: z.object({ id: Uuid, amount: MoneyString, reference: z.string().max(100).nullable().optional() }),
  output: VendorReturn,
});

export const purchasingRoutes = {
  listPurchaseApprovalRules, addPurchaseApprovalRule, removePurchaseApprovalRule,
  getPurchaseOrderApprovals, decidePurchaseOrder, emailPurchaseOrder, listPurchaseOrderSends,
  recordLateLandedCost, listVendorReturns, createVendorReturn, recordVendorCredit,
} as const;
