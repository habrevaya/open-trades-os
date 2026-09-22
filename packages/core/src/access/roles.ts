import { ALL_PERMISSIONS, type Permission } from "./permissions";

/**
 * ROLE PRESETS
 *
 * A role is a named set of permissions and nothing more. These nine cover the
 * way home services companies actually divide work, which is not the way
 * generic SaaS RBAC assumes:
 *
 *   owner            sees everything including payroll and the ledger
 *   admin            runs the system, but payroll and the ledger are opt in
 *   office_manager   back office: customers, jobs, invoicing, purchasing
 *   dispatcher       the board, and nothing that touches money
 *   csr              books work and talks to customers, cannot dispatch
 *   technician       their own work, their own time, and no cost or margin
 *   crew_lead        a technician who can also see the crew's day
 *   accountant       finance: the ledger, payroll, reconciliation, no dispatch
 *   readonly         looks, touches nothing
 *
 * The three the founder named map like this: back office is office_manager,
 * finance is accountant, technicians is technician plus crew_lead.
 *
 * A customer can build any other role they want. These are starting points, and
 * `permissions` on a membership row adds or removes from the preset rather than
 * replacing it, so a preset stays meaningful after it is customized.
 */
export type RoleId =
  | "owner" | "admin" | "office_manager" | "dispatcher" | "csr"
  | "technician" | "crew_lead" | "accountant" | "readonly";

const OFFICE_BASE: Permission[] = [
  "customer:read", "customer:write", "property:read", "property:write",
  "equipment:read", "equipment:write",
  "pricebook:read",
  "job:read", "job:write", "job:complete",
  "visit:read", "visit:write",
  "servicereport:read", "servicereport:publish",
  "estimate:read", "estimate:write", "estimate:send",
  "membership:read", "membership:write",
  "invoice:read", "invoice:write", "invoice:send",
  "payment:read", "payment:collect",
  "message:read", "message:send",
  "report:read",
  "asset:read", "document:read",
];

const TECHNICIAN_BASE: Permission[] = [
  // Reads the customer and the property, but never their financial standing.
  "customer:read", "property:read",
  "equipment:read", "equipment:write",
  // Reads the price book to quote on site. Cost and margin are NOT here.
  "pricebook:read",
  "job:read", "job:complete",
  "visit:read",
  "servicereport:read", "servicereport:write",
  "estimate:read", "estimate:write", "estimate:send",
  "invoice:read", "payment:collect",
  "message:read", "message:send",
  "timeclock:own",
  "inventory:read",
  "asset:read", "asset:checkout",
  "document:read",
];

export const ROLE_PRESETS: Record<RoleId, { label: string; description: string; permissions: Permission[] }> = {
  owner: {
    label: "Owner",
    description: "Everything, including payroll, the ledger and billing.",
    permissions: [...ALL_PERMISSIONS],
  },

  admin: {
    label: "Administrator",
    description: "Runs the system. Payroll and the ledger are deliberately not included; grant them explicitly.",
    permissions: ALL_PERMISSIONS.filter((p) => ![
      "payroll:read", "payroll:export", "ledger:post", "accounting:close",
      "billing:manage", "data:export",
    ].includes(p)),
  },

  office_manager: {
    label: "Office manager",
    description: "Back office. Customers, jobs, invoicing, purchasing and the schedule.",
    permissions: [
      ...OFFICE_BASE,
      "customer:merge", "customer.financials:read",
      "visit:dispatch", "visit:reschedule",
      "estimate:discount",
      "invoice:void",
      "vendor:read", "vendor:write", "po:read", "po:write",
      "inventory:read", "inventory:adjust",
      "timesheet:read",
      "campaign:read",
      "user:read", "user:invite",
      "settings:read",
      "job.cost:read", "pricebook.cost:read",
    ],
  },

  dispatcher: {
    label: "Dispatcher",
    description: "The board. Assigns, sequences and reschedules. Nothing that touches money.",
    permissions: [
      "customer:read", "property:read", "equipment:read",
      "job:read", "job:write",
      "visit:read", "visit:write", "visit:dispatch", "visit:reschedule",
      "servicereport:read",
      "message:read", "message:send",
      "timesheet:read",
      "asset:read", "inventory:read",
      "report:read",
      "pricebook:read",
    ],
  },

  csr: {
    label: "Customer service",
    description: "Books work and talks to customers. Cannot dispatch and cannot void anything.",
    permissions: [
      "customer:read", "customer:write", "property:read", "property:write",
      "equipment:read",
      "pricebook:read",
      "job:read", "job:write",
      "visit:read", "visit:write",
      "servicereport:read",
      "estimate:read", "estimate:write", "estimate:send",
      "membership:read", "membership:write",
      "invoice:read", "invoice:send",
      "payment:read", "payment:collect",
      "message:read", "message:send",
      "report:read",
    ],
  },

  technician: {
    label: "Technician",
    description: "Their own work and their own time. Sees price, never cost or margin.",
    permissions: TECHNICIAN_BASE,
  },

  crew_lead: {
    label: "Crew lead",
    description: "A technician who also sees the crew's day and approves the crew's time.",
    permissions: [
      ...TECHNICIAN_BASE,
      "visit:reschedule",
      "timesheet:read",
      "po:write",
      "inventory:adjust",
    ],
  },

  accountant: {
    label: "Finance",
    description: "The ledger, payroll, reconciliation and reporting. No dispatch, no customer editing.",
    permissions: [
      "customer:read", "customer.financials:read",
      "property:read",
      "pricebook:read", "pricebook.cost:read",
      "job:read", "job.cost:read",
      "visit:read",
      "estimate:read",
      "membership:read",
      "invoice:read", "invoice:write", "invoice:send", "invoice:void", "invoice:writeoff",
      "payment:read", "payment:collect", "payment:refund",
      "ledger:read", "ledger:post", "accounting:sync", "accounting:close",
      "report.financial:read", "report:read", "report:build",
      "vendor:read", "vendor:write", "po:read", "po:approve",
      "inventory:read",
      "timesheet:read", "timesheet:approve",
      "payroll:read", "payroll:export",
      "commission:read", "commission:configure",
      "adspend:read",
      "audit:read",
      "data:export",
    ],
  },

  readonly: {
    label: "Read only",
    description: "Looks, touches nothing. No cost, margin, payroll or ledger.",
    permissions: [
      "customer:read", "property:read", "equipment:read",
      "pricebook:read",
      "job:read", "visit:read", "servicereport:read",
      "estimate:read", "membership:read",
      "invoice:read", "payment:read",
      "report:read", "asset:read", "document:read",
    ],
  },
};

export const ROLE_IDS = Object.keys(ROLE_PRESETS) as RoleId[];
