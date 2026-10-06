import { ALL_PERMISSIONS, type Permission } from "./permissions";

/**
 * ROLE PRESETS
 *
 * A role is a named set of permissions and nothing more. These ten cover the
 * way home services companies actually divide work, which is not the way
 * generic SaaS RBAC assumes:
 *
 *   owner            sees everything including payroll and the ledger
 *   admin            runs the system, but payroll and the ledger are opt in
 *   office_manager   back office: customers, jobs, invoicing, purchasing
 *   branch_manager   an office manager for one branch, seeing that branch only
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
  | "owner" | "admin" | "office_manager" | "branch_manager" | "dispatcher" | "csr"
  | "technician" | "crew_lead" | "accountant" | "readonly";

/**
 * WHAT EVERYBODY HOLDS ABOUT THEMSELVES. Their own record and their own pay
 * statements. In every preset rather than in a base the presets share,
 * because the presets share nothing else, and a person who cannot see the
 * emergency contacts they gave the office is a person who rings to ask.
 */
const SELF: Permission[] = ["profile:own", "payroll:own"];

const OFFICE_BASE: Permission[] = [
  "task:read", "task:write",
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
  "deposit:read", "deposit:collect",
  "booking:read", "booking:decide",
  "portal:grant", "portal:read",
  "message:read", "message:send", "call:place",
  "report:read",
  "asset:read", "document:read",
  "safety:report",
  "record:read", "record:write",
  ...SELF,
];

const TECHNICIAN_BASE: Permission[] = [
  /**
   * Reads tasks, does not create them.
   *
   * A technician can be handed a task and complete it. Letting them create
   * work for other people is a different thing, and a queue anybody can add
   * to stops being a queue anybody reads.
   */
  "task:read",
  // Reads the customer and the property, but never their financial standing.
  "customer:read", "property:read",
  "equipment:read", "equipment:write",
  // Reads the price book to quote on site. Cost and margin are NOT here.
  "pricebook:read",
  "job:read", "job:complete",
  "visit:read",
  "servicereport:read", "servicereport:write",
  "estimate:read", "estimate:write", "estimate:send",
  /**
   * The sale at the kitchen table: the customer chooses and signs on the
   * technician's screen. Not `estimate:approve`, which records a yes on the
   * customer's behalf; here the customer gives it themselves.
   */
  "estimate:present",
  "invoice:read", "payment:collect",
  /**
   * The bill for their own visit's work, raised and signed for on site.
   * Not `invoice:write`, which would let them raise and edit any invoice.
   */
  "invoice:raise_on_site",
  "deposit:collect",
  // Hands the customer a link to approve on their own phone. A technician
  // approving on the customer's behalf is a different thing, and is not here.
  "portal:grant",
  "message:read", "message:send",
  "field:sync",
  "timeclock:own",
  "inventory:read",
  "asset:read", "asset:checkout",
  "document:read",
  // Anybody on a job can report what went wrong on it. Reading the register is not here.
  "safety:report",
  /**
   * Reads the company's own records, the permit on the job they are at.
   * Adding one is the office's unless a kind says otherwise: a truck
   * inspection can name a permission technicians hold.
   */
  "record:read",
  ...SELF,
];

/** The office manager's permissions, which the branch manager holds too. */
const OFFICE_MANAGER: Permission[] = [
  ...OFFICE_BASE,
  "customer:merge", "customer.financials:read", "customer.financials:write",
  "contract:read", "contract:write",
  "visit:dispatch", "visit:reschedule",
  /**
   * The office manager answers for who was sent where, so the override
   * sits with them. A dispatcher is given it by name when the company
   * wants the person at the board to make that call.
   */
  "visit:assign_unqualified",
  "estimate:discount", "estimate:approve",
  "booking:configure",
  "portal:revoke",
  "invoice:void", "invoice:credit",
  /** A saved card charged from the invoice, only where the customer agreed to it. */
  "payment:charge_saved",
  "vendor:read", "vendor:write", "po:read", "po:write",
  "inventory:read", "inventory:adjust",
  "timesheet:read",
  "campaign:read",
  "user:read", "user:invite",
  "settings:read",
  /**
   * Reading, not writing. The office manager is the person who gets
   * asked why a customer received a text, and the run log is the only
   * place that answers it.
   */
  "workflow:read",
  "job.cost:read", "pricebook.cost:read",
  "safety:read", "safety:write",
  /** The service manager writes down how the company does things, for the field assistant. */
  "knowledge:write",
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
      "payroll:read", "payroll:export", "payroll:configure",
      "ledger:post", "accounting:close",
      "billing:manage", "data:export", "data:import",
    ].includes(p)),
  },

  office_manager: {
    label: "Office manager",
    description: "Back office. Customers, jobs, invoicing, purchasing and the schedule.",
    permissions: OFFICE_MANAGER,
  },

  /**
   * THE OFFICE MANAGER OF ONE BRANCH. The same permissions, and every scoped
   * record limited to their branch (`DEFAULT_SCOPES` says so): its jobs and
   * what hangs off them, its board, its people's timesheets and time off.
   *
   * A preset because every company with two shops builds this role, and a
   * company that had to build it itself built it slightly wrong: a branch
   * scope on jobs and not on conversations is a manager who reads the other
   * shop's inbox. It cannot be held without a branch, because a branch scope
   * with no branch matches nothing and reads as an empty company.
   */
  branch_manager: {
    label: "Branch manager",
    description: "An office manager for one branch. Their branch's work, board and people's time, and nothing from other branches.",
    permissions: OFFICE_MANAGER,
  },

  dispatcher: {
    label: "Dispatcher",
    description: "The board. Assigns, sequences and reschedules. Nothing that touches money.",
    permissions: [
      "customer:read", "property:read", "equipment:read",
      "job:read", "job:write",
      "visit:read", "visit:write", "visit:dispatch", "visit:reschedule",
      "servicereport:read",
      "booking:read", "booking:decide",
      "message:read", "message:send", "call:place",
      "timesheet:read",
      "asset:read", "inventory:read",
      "report:read",
      "pricebook:read",
      "safety:report",
      "record:read",
      ...SELF,
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
      "estimate:read", "estimate:write", "estimate:send", "estimate:approve",
      "membership:read", "membership:write",
      "invoice:read", "invoice:send",
      "payment:read", "payment:collect",
      "deposit:read", "deposit:collect",
      "booking:read", "booking:decide",
      "portal:grant", "portal:read",
      "message:read", "message:send", "call:place",
      "report:read",
      "safety:report",
      "record:read", "record:write",
      ...SELF,
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
      // The crew lead runs the morning toolbox talk and is first to hear about a near miss.
      "safety:read", "safety:write",
    ],
  },

  accountant: {
    label: "Finance",
    description: "The ledger, payroll, reconciliation and reporting. No dispatch, no customer editing.",
    permissions: [
      "customer:read", "customer.financials:read",
      "contract:read",
      "property:read",
      "pricebook:read", "pricebook.cost:read",
      "job:read", "job.cost:read",
      "visit:read",
      "estimate:read",
      "membership:read",
      "invoice:read", "invoice:write", "invoice:send", "invoice:void", "invoice:writeoff",
      "invoice:credit",
      "payment:read", "payment:collect", "payment:refund", "payment:charge_saved",
      "deposit:read", "deposit:refund",
      "ledger:read", "ledger:post", "accounting:sync", "accounting:close",
      "report.financial:read", "report:read", "report:build",
      "finance:configure",
      "vendor:read", "vendor:write", "po:read", "po:approve",
      "inventory:read",
      "timesheet:read", "timesheet:approve",
      "payroll:read", "payroll:export", "payroll:configure",
      "commission:read", "commission:configure",
      "adspend:read",
      "audit:read",
      "data:export",
      ...SELF,
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
      "invoice:read", "payment:read", "deposit:read",
      "booking:read",
      "report:read", "asset:read", "document:read",
      "record:read",
      ...SELF,
    ],
  },
};

export const ROLE_IDS = Object.keys(ROLE_PRESETS) as RoleId[];
