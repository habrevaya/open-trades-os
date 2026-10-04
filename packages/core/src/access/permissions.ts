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
  "customer.financials:read": "See a customer's balance and payment history",
  /**
   * Separate from `customer:write`, because a standing discount is a price
   * change on every future invoice for that customer. The person who
   * corrects a phone number is not always the person who may do that.
   */
  "customer.financials:write": "Set a customer's standing discount",
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
  /**
   * Sending somebody to work they are not recorded as qualified for.
   *
   * A separate grant because it is a separate decision: the dispatcher who
   * puts people on the board is not automatically the person who may send an
   * apprentice to a gas job because nobody else is free. It never skips the
   * check; it lets a refusal be overridden with a reason, and the audit log
   * keeps the reason beside what was refused.
   */
  "visit:assign_unqualified": "Send somebody to work they are not recorded as qualified for, with a reason",
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
  /**
   * The customer choosing and signing on the technician's own screen, at the
   * kitchen table, rather than on their phone through a link. Narrower than
   * `estimate:approve` and different in kind: the person holding it records
   * nothing on the customer's behalf. The customer picks the option and
   * draws the signature, and the phone only carries it, for a visit on the
   * technician's own day. A technician holds this and not `estimate:approve`.
   */
  "estimate:present": "Show a customer an estimate on your screen and take their choice and signature",
  "booking:read": "View booking requests from the website",
  "booking:decide": "Confirm or decline a booking request",
  "booking:configure": "Choose what the public may book, and on what terms",
  "portal:grant": "Issue a customer a link to approve, pay or track without an account",
  "portal:revoke": "Withdraw a customer link, end a customer's sign in, and choose which contacts may sign in",
  /**
   * Separate from `portal:grant` because a technician holds that one, to hand
   * a customer a link on their own phone, and a technician has no business
   * reading which addresses a customer signs in from or when somebody failed
   * to. The person who answers "the code never came" is in the office.
   */
  "portal:read": "See customers' portal sign ins and failed sign in codes",
  "membership:read": "View memberships and agreements",
  "membership:write": "Sell and edit memberships",
  /**
   * A commercial contract, which is a different thing from a consumer
   * membership and is usually a different person's job. An MSA carries a
   * rate card that becomes the price authority for that client, so editing
   * one changes what every future job for them may be charged at.
   */
  "contract:read": "View commercial contracts and their rate cards",
  "contract:write": "Create and edit commercial contracts",

  // --- Money ---------------------------------------------------------------
  "invoice:read": "View invoices",
  "invoice:write": "Create and edit invoices",
  /**
   * Raising the bill for the work in front of you, on site, and nothing
   * else. `invoice:write` raises, edits and issues any invoice for any job,
   * which is the office's power; this raises and issues ONE invoice, from
   * the work recorded on a visit on the holder's own day or the option the
   * customer signed for, priced by the same rules the office's would be.
   */
  "invoice:raise_on_site": "Raise and issue the invoice for the work on your own visit",
  "invoice:send": "Send an invoice",
  "invoice:void": "Void an invoice",
  "invoice:writeoff": "Write off a balance",
  "invoice:credit": "Issue, apply and void a credit note",
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
  /**
   * The rates that turn a direct margin into a fully loaded one (labour
   * burden and overhead) and the company's yearly budget. Separate from
   * `settings:write` because these change what every margin and every
   * budget report says, which is finance's decision, and the accountant who
   * makes it should not need the power to change the company's settings.
   */
  "finance:configure": "Set labour burden, overhead rates and the company budget",

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
  /**
   * The company's own how-to notes (how this company bleeds a boiler, which
   * filter the Johnsons' unit takes), which the field assistant answers from.
   * Separate from settings because the person who knows the procedure is a
   * lead technician or a service manager, not whoever runs the system.
   */
  "knowledge:write": "Write the company's how-to notes the field assistant answers from",
  "timeclock:own": "Clock in and out",
  "timesheet:read": "View timesheets",
  "timesheet:approve": "Approve timesheets",
  "payroll:read": "View pay rates and payroll data",
  "payroll:export": "Run a payroll export",
  /**
   * Separate from reading payroll and from running an export, because it is
   * neither. Declaring the overtime policy and loading a wage scale is
   * stating what people are owed, and the person who runs the export is
   * usually not the person entitled to decide that.
   */
  "payroll:configure": "Declare the overtime policy and load wage scales",
  "commission:read": "View commission calculations",
  "commission:configure": "Create and edit commission plans",

  // --- Grow ----------------------------------------------------------------
  "message:read": "View customer messages and call history",
  "message:send": "Send messages to customers",
  /**
   * Its own grant rather than part of sending messages, because a technician
   * texts from the field and holds `message:send` for it, and ringing anybody
   * from the browser as the company's number is a different thing: it puts the
   * company's caller id on the call and the minutes on the company's bill. It
   * is also what lets a browser ring when a customer calls.
   */
  "call:place": "Make and take calls from the company's numbers in the browser",
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
  /**
   * SAFETY RECORDS ARE THEIR OWN GRANT, and the reason is what is in them. An
   * incident report names who was hurt and how, which is a narrower audience
   * than the company's insurance certificate, and a toolbox talk sign in sheet
   * is run by a foreman who has no business in the filings.
   *
   * Reporting is separate from reading on purpose. Everybody should be able
   * to report the ladder that nearly slipped, and a form that also shows them
   * every injury their colleagues ever had is a form nobody may be given.
   */
  "safety:read": "View toolbox talks and incident reports",
  "safety:write": "Hold toolbox talks and follow up incident reports",
  "safety:report": "Report an incident or a near miss",

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
  /**
   * THERE IS NO `apikey:write`, AND THERE WAS ONE.
   *
   * It read "Create and revoke API keys" and nothing checked it, because this
   * product has no bare API keys to create. M26 issues a token to a CONNECTED
   * APP: a named integration with its own permission list, its own audit
   * attribution and its own revocation, so "who may call us" is answerable
   * without anybody holding a string that is equivalent to a password and
   * belongs to nobody in particular.
   *
   * That is not a feature waiting to be built, it is the feature instead of it.
   * A permission here named for the thing we decided against is a claim that an
   * owner can restrict something, and a custom role could be given it: the owner
   * would believe they had applied a restriction on a surface that does not
   * exist. `integration:write` is the real one: connecting an app, issuing it a
   * token and revoking it are all guarded by it, which is right because they
   * are the same decision.
   *
   * The guard test in `permissions-enforced.test.ts` carried this name on its
   * excused list for exactly as long as the permission did.
   */
  "audit:read": "View the audit log",
  "customfield:write": "Define custom fields and objects",
  /**
   * THE COMPANY'S OWN KINDS OF RECORD: permits, warranty registrations, truck
   * inspections. The defaults each kind starts with; a kind can name any
   * other permission instead, so "only the office sees permits" and
   * "technicians file the truck inspection" are a choice on the definition
   * rather than a new role.
   */
  "record:read": "View the company's own kinds of record, like permits",
  "record:write": "Add and change the company's own kinds of record",
  /**
   * A practice copy of the company's settings, and copying chosen settings
   * back. Its own permission because the copy back changes how the real
   * company runs, in one press, from somewhere nobody else is looking.
   */
  "sandbox:manage": "Make a practice copy of the company's settings and copy chosen settings back",
  /**
   * Seeing what is automated is a different question from being able to
   * change it. An owner asking "why did this customer get that text" needs
   * the first; the answer to the second is a much smaller list of people.
   */
  "workflow:read": "See automations, their runs and why they did what they did",
  "workflow:write": "Create and edit automation workflows",
  "agent:configure": "Configure AI agents",
  "data:export": "Export all company data in bulk",
  /**
   * Recording history rather than making it: an invoice issued in 2019, a
   * cheque received last year, tax as another system charged it, the source
   * document's own number. Every one of those is also how books are cooked,
   * so it is its own permission, held by the owner and by nobody else unless
   * the owner says so. A migration's app token is given it for the length of
   * the migration; an office manager is not given it to fix a date.
   */
  "data:import": "Load history from another system: back-dated documents, tax as charged, source numbers",
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
