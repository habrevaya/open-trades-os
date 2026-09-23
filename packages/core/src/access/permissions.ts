/**
 * THE PERMISSION CATALOGUE
 *
 * Every permission in the system, as a flat list of `resource:action` strings.
 * Roles are presets over this list, never a parallel concept: a role is a named
 * set of these strings and nothing more. That keeps authorization decidable
 * with a set membership check rather than a tangle of special cases, and it
 * means a customer can build a role we never anticipated without us shipping
 * code.
 *
 * Three kinds of permission appear here and the distinction matters:
 *
 *   resource:action        can this person do the thing at all
 *   resource.field:read    can this person see this FIELD of the thing
 *   scope:*                WHICH records of the thing, see scopes.ts
 *
 * The field-level ones exist because of a specific, universal requirement in
 * this industry: a technician must be able to open a job and read the price,
 * and must not be able to read the cost or the margin. Every field service
 * platform that treats permissions as purely resource-level ends up either
 * leaking margin to technicians or building a second, worse UI for them.
 */

export const PERMISSIONS = {
  // --- CRM -----------------------------------------------------------------
  "customer:read": "View customers",
  "customer:write": "Create and edit customers",
  "customer:delete": "Delete customers",
  "customer:merge": "Merge duplicate customers",
  "customer.financials:read": "See a customer's balance, credit limit and payment history",
  "property:read": "View properties",
  "property:write": "Create and edit properties",
  "equipment:read": "View installed equipment and service history",
  "equipment:write": "Add and edit equipment records",

  // --- Price book ----------------------------------------------------------
  "pricebook:read": "View the price book",
  "pricebook:write": "Add and edit price book items",
  "pricebook.cost:read": "See item cost and margin",
  "pricebook:publish": "Publish a new price book version",

  // --- Work ----------------------------------------------------------------
  "job:read": "View jobs",
  "job:write": "Create and edit jobs",
  "job:delete": "Delete jobs",
  "job:complete": "Mark a job complete",
  "job.cost:read": "See job cost, gross margin and profitability",
  "visit:read": "View visits",
  "visit:write": "Create and edit visits",
  "visit:dispatch": "Assign and dispatch visits",
  "visit:reschedule": "Move a visit on the board",
  "servicereport:read": "View service reports",
  "servicereport:write": "Record service reports and readings",
  "servicereport:publish": "Publish a service report to the customer portal",

  // --- Sell ----------------------------------------------------------------
  "estimate:read": "View estimates",
  "estimate:write": "Create and edit estimates",
  "estimate:send": "Send an estimate to a customer",
  "estimate:discount": "Apply a discount",
  "estimate.discount.unlimited": "Apply a discount above the configured cap",
  "estimate:approve": "Approve or decline an estimate on the customer's behalf",
  "booking:read": "View booking requests from the website",
  "booking:decide": "Confirm or decline a booking request",
  "booking:configure": "Choose what the public may book, and on what terms",
  "portal:grant": "Issue a customer a link to approve, pay or track without an account",
  "portal:revoke": "Withdraw a customer link",
  "membership:read": "View memberships and agreements",
  "membership:write": "Sell and edit memberships",

  // --- Money ---------------------------------------------------------------
  "invoice:read": "View invoices",
  "invoice:write": "Create and edit invoices",
  "invoice:send": "Send an invoice",
  "invoice:void": "Void an invoice",
  "invoice:writeoff": "Write off a balance",
  "payment:read": "View payments",
  "payment:collect": "Take a payment",
  "payment:refund": "Issue a refund",
  "deposit:read": "View deposits held",
  "deposit:collect": "Request and take a deposit",
  "deposit:refund": "Return or forfeit a deposit",
  "ledger:read": "View the general ledger",
  "ledger:post": "Post journal entries and adjustments",
  "accounting:sync": "Run and configure the accounting sync",
  "accounting:close": "Close an accounting period",
  "report.financial:read": "View financial reports and P and L",

  // --- Purchasing and inventory -------------------------------------------
  "vendor:read": "View vendors",
  "vendor:write": "Create and edit vendors",
  "po:read": "View purchase orders",
  "po:write": "Create purchase orders",
  "po:approve": "Approve a purchase order",
  "inventory:read": "View inventory and truck stock",
  "inventory:adjust": "Adjust stock and record counts",

  // --- Workforce -----------------------------------------------------------
  "field:sync": "Use the field app and submit work from it",
  "timeclock:own": "Clock in and out",
  "timesheet:read": "View timesheets",
  "timesheet:approve": "Approve timesheets",
  "payroll:read": "View pay rates and payroll data",
  "payroll:export": "Run a payroll export",
  "commission:read": "View commission calculations",
  "commission:configure": "Create and edit commission plans",

  // --- Grow ----------------------------------------------------------------
  "message:read": "View customer messages and call history",
  "message:send": "Send messages to customers",
  "campaign:read": "View marketing campaigns",
  "campaign:write": "Create and send marketing campaigns",
  "adspend:read": "View ad spend and attribution",
  "adspend:write": "Configure ad spend sources",
  "review:respond": "Respond to reviews",
  "report:read": "View operational reports and dashboards",
  "report:build": "Create and edit custom reports",

  // --- Company -------------------------------------------------------------
  "asset:read": "View fleet, tools and company assets",
  "asset:write": "Manage fleet, tools and company assets",
  "asset:checkout": "Check equipment in and out",
  "document:read": "View company documents",
  "document:write": "Manage company documents",
  "compliance:read": "View licences, insurance and compliance records",
  "compliance:write": "Manage licences, insurance and compliance records",

  // --- Administration ------------------------------------------------------
  "user:read": "View users",
  "user:invite": "Invite users",
  "user:write": "Edit users and assign roles",
  "role:write": "Create and edit custom roles",
  /**
   * The office work queue. Read is separate from write because a technician
   * can be given a task without being able to create work for other people,
   * and a queue anybody can add to stops being a queue anybody reads.
   */
  "task:read": "View tasks and the office queue",
  "task:write": "Create, assign and complete tasks",
  "settings:read": "View company settings",
  "settings:write": "Edit company settings",
  "integration:read": "View connected integrations",
  "integration:write": "Connect and disconnect integrations",
  "apikey:write": "Create and revoke API keys",
  "audit:read": "View the audit log",
  "customfield:write": "Define custom fields and objects",
  /**
   * Seeing what is automated is a different question from being able to
   * change it. An owner asking "why did this customer get that text" needs
   * the first; the answer to the second is a much smaller list of people.
   */
  "workflow:read": "See automations, their runs and why they did what they did",
  "workflow:write": "Create and edit automation workflows",
  "agent:configure": "Configure AI agents",
  "data:export": "Export all company data in bulk",
  "billing:manage": "Manage the OpenTradesOS subscription",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Permissions that expose money the company does not want on a technician's
 * phone. Grouped so a customer building a custom role can reason about the
 * blast radius in one place rather than discovering it a field at a time.
 */
export const SENSITIVE_PERMISSIONS: Permission[] = [
  "pricebook.cost:read",
  "job.cost:read",
  "customer.financials:read",
  "payroll:read",
  "commission:read",
  "ledger:read",
  "report.financial:read",
  "data:export",
];
