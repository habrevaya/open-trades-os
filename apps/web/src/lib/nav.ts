import type { Permission } from "@opentradesos/core";
import type { IconName } from "@/components/NavIcon";

/**
 * THE NAVIGATION, AS DATA
 *
 * Separate from the component that draws it so the route test can read it,
 * and so the active-state logic is a function with its own tests rather than
 * a ternary inside markup.
 *
 * Grouped because a flat list of fourteen is a list somebody reads top to
 * bottom every time. The groups are the way a contractor already thinks about
 * their day: what is happening now, the work, the people, the money, and the
 * things you set up once.
 *
 * THREE LEVELS AND NOT FOUR. Group, item, child. A fourth level is a menu
 * somebody navigates rather than reads, and a product that needs one usually
 * has a naming problem rather than a navigation problem.
 */
export interface NavChild {
  href: string;
  label: string;
}

export interface NavItem {
  href: string;
  label: string;
  permission: Permission;
  /**
   * Required, not optional, because the rail collapses to icons only and an
   * item with no icon is invisible in that state rather than plain.
   */
  icon: IconName;
  /**
   * Screens that belong under this one.
   *
   * They inherit the parent's permission rather than declaring their own. A
   * child under a parent somebody cannot open is a door behind a wall, and a
   * child that genuinely needs a different permission is a top level item
   * filed in the wrong place.
   */
  children?: NavChild[];
}

export interface NavGroup {
  /** Null for the first group, which needs no heading above the first item. */
  label: string | null;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      /**
       * A technician's own day, first. For the person who holds this
       * permission it is the only screen they open, and anything above it is
       * a thing they scroll past every morning.
       */
      { href: "/my-day", label: "My day", permission: "field:sync", icon: "day" },
      { href: "/", label: "Today", permission: "job:read", icon: "today" },
      /**
       * A person's own record, for everybody: the documents waiting for their
       * signature, their onboarding, the people to ring, their certifications,
       * their pay for closed periods and their time off. Up here rather than
       * under People, which is everybody's record and needs `user:read`.
       */
      {
        href: "/me", label: "My record", permission: "profile:own", icon: "me",
        children: [
          { href: "/me", label: "About me" },
          /** Inherits `profile:own` to be SHOWN; the page itself needs `payroll:own`. */
          { href: "/me/pay", label: "My pay" },
          { href: "/me/time-off", label: "Time off" },
        ],
      },
    ],
  },
  {
    label: "Work",
    items: [
      {
        href: "/schedule", label: "Schedule", permission: "visit:read", icon: "schedule",
        children: [
          { href: "/schedule", label: "The board" },
          /**
           * Who is working, from two ends: the crews that take work one person
           * cannot do, and who has the phone when the office is shut. Both were
           * in the API with no screen.
           */
          { href: "/schedule/crews", label: "Crews and on call" },
          /**
           * The template a route business runs its week on. Under Schedule
           * rather than under Recurring, because a route is a weekday and a
           * servicer before it is a cadence.
           */
          { href: "/schedule/routes", label: "Routes" },
          /**
           * What each person is recorded as doing and where their day starts:
           * the two things the board's qualification check and the route
           * optimiser read, and that had no screen.
           */
          { href: "/schedule/technicians", label: "Technicians" },
          /** The board's own answer for the day's open visits, explained, for a dispatcher to apply. */
          { href: "/schedule/copilot", label: "Copilot" },
        ],
      },
      { href: "/jobs", label: "Jobs", permission: "job:read", icon: "jobs" },
      {
        href: "/tasks", label: "Tasks", permission: "task:read", icon: "tasks",
        children: [
          { href: "/tasks", label: "The queue" },
          /** Work that comes round daily, weekly or monthly, raised by the worker. */
          { href: "/tasks/recurring", label: "Recurring" },
          /** Who hears about a task that stays late, and who takes it over. */
          { href: "/tasks/escalation", label: "Escalation" },
        ],
      },
      { href: "/recurring", label: "Recurring", permission: "job:read", icon: "recurring" },
      /** Phased work under one contract, billed in draws. Work, because it is jobs. */
      { href: "/projects", label: "Projects", permission: "job:read", icon: "projects" },
      /**
       * Under Work rather than Business, because a deficiency backlog is a
       * list of jobs that have not been booked yet. Filing it as a report
       * would make it something somebody reads rather than works.
       */
      { href: "/inspections", label: "Inspections", permission: "compliance:read", icon: "inspections" },
      /**
       * Beside inspections, because both answer "may this work go ahead":
       * one about the equipment, this one about the person sent to it.
       */
      { href: "/certifications", label: "Certifications", permission: "compliance:read", icon: "certifications" },
    ],
  },
  {
    label: "Customers",
    items: [
      {
        href: "/customers", label: "Customers", permission: "customer:read", icon: "customers",
        children: [
          { href: "/customers", label: "All customers" },
          /** The company's tags with counts, and the rename and merge every tag list needs. */
          { href: "/customers/tags", label: "Tags" },
          /** The per customer matcher run over the whole book, for whoever may merge. */
          { href: "/customers/duplicates", label: "Likely duplicates" },
          /**
           * Equipment cover running out, by customer. Under Customers rather than
           * a register of its own, because the list is a list of people to ring.
           */
          { href: "/customers/warranties", label: "Warranties" },
        ],
      },
      /**
       * The company's own kinds of record: permits, registrations, the truck
       * inspection. Under Customers because most of them are about a
       * customer, an address or a job; the kinds themselves are the
       * company's, so this is one door to a page listing them rather than an
       * item per kind the rail cannot know about.
       */
      { href: "/records", label: "Records", permission: "record:read", icon: "records" },
      /**
       * Under Customers rather than under Money, because the question it
       * answers is about a client ("whose price governs for them?") rather
       * than about a number. Somebody opens this before quoting, not while
       * invoicing.
       */
      {
        href: "/contracts", label: "Contracts", permission: "contract:read", icon: "contracts",
        children: [
          { href: "/contracts", label: "Rate cards" },
          /**
           * The other direction: work that arrives from somebody else's system,
           * where theirs is the record and ours is the mirror. Under Contracts
           * because both answer "what did we agree with this client", one as a
           * price and one as a queue.
           */
          { href: "/contracts/external", label: "Work from other systems" },
          /**
           * The clocks every contract starts, soonest first. Under Contracts
           * because each one is a promise in one of them; the same deadlines
           * also raise tasks in the office queue before they run out.
           */
          { href: "/contracts/deadlines", label: "Deadlines" },
        ],
      },
      {
        href: "/inbox", label: "Inbox", permission: "message:read", icon: "inbox",
        children: [
          { href: "/inbox", label: "Conversations" },
          /**
           * What the intake agent drafted from texts, emails, calls and forms,
           * each bookable with one click. Under the inbox because it is the
           * inbox's messages, read.
           */
          { href: "/inbox/drafts", label: "Booking drafts" },
        ],
      },
      /**
       * Calls made and taken in the browser. Its own screen rather than a
       * phone in every page's corner, because every link in the rail is a
       * full page load and a call in progress would end with it.
       */
      { href: "/phone", label: "Phone", permission: "call:place", icon: "phone" },
    ],
  },
  {
    label: "Money",
    items: [
      {
        href: "/estimates", label: "Estimates", permission: "estimate:read", icon: "estimates",
        children: [
          { href: "/estimates", label: "Estimates" },
          /** The small print copied onto every proposal when it is written. */
          { href: "/estimates/terms", label: "Proposal terms" },
          /** How the proposal reads: a cover, the sections in the company's order, saved per job type. */
          { href: "/estimates/templates", label: "Proposal layouts" },
        ],
      },
      {
        href: "/invoices", label: "Invoices", permission: "invoice:read", icon: "invoices",
        children: [
          { href: "/invoices", label: "Invoices" },
          { href: "/invoices/credit-notes", label: "Credit notes" },
          /**
           * Statements sent, and the monthly run that sends them. Under
           * Invoices because a statement is the invoices a customer owes on,
           * added up, and the person who sends one is the person who sends
           * those.
           */
          { href: "/invoices/statements", label: "Statements" },
          /** Overdue reminders the collections agent drafted, to send, edit or set aside. */
          { href: "/invoices/reminders", label: "Reminders" },
          /**
           * Claims on home warranty companies, manufacturers and carriers.
           * Under Invoices because a claim is the conversation about an
           * invoice to a third party, and it is chased by whoever chases those.
           */
          { href: "/invoices/claims", label: "Claims" },
          /**
           * Loan applications customers were sent, and what financing brought
           * in. Under Invoices because a funded loan is how an invoice gets
           * paid, and it is chased by whoever chases those.
           */
          { href: "/invoices/financing", label: "Financing" },
        ],
      },
      {
        href: "/agreements", label: "Agreements", permission: "membership:read", icon: "agreements",
        children: [
          { href: "/agreements", label: "The book" },
          /** Selling one to a customer: pick the plan, the address and the start. */
          { href: "/agreements/new", label: "Sell one" },
          /** What is on sale: the price, the visits, the discount and the perks. */
          { href: "/agreements/plans", label: "Plans" },
          /** The renewal conversation starts here: who ends in the next thirty days. */
          { href: "/agreements/renewals", label: "Ending soon" },
        ],
      },
      {
        href: "/pricebook", label: "Price book", permission: "pricebook:read", icon: "pricebook",
        children: [
          { href: "/pricebook", label: "Items" },
          /** The shelves a technician browses by, which nothing could reorganise. */
          { href: "/pricebook/categories", label: "Categories" },
          /** Many prices at once, previewed, written as new versions and undoable. */
          { href: "/pricebook/changes", label: "Change prices" },
          { href: "/pricebook/tax", label: "Sales tax" },
        ],
      },
      {
        href: "/inventory", label: "Inventory", permission: "inventory:read", icon: "inventory",
        children: [
          { href: "/inventory", label: "Stock" },
          /** Every serial and lot, and the trace from the order it came on to the customer it went to. */
          { href: "/inventory/serials", label: "Serials and lots" },
          /** What each truck should carry, and filling it from the warehouse. */
          { href: "/inventory/trucks", label: "Truck stock" },
        ],
      },
      {
        href: "/purchasing", label: "Purchasing", permission: "po:read", icon: "purchasing",
        children: [
          { href: "/purchasing", label: "Orders" },
          /** A supplier's spreadsheet, previewed and then applied to the price book and their part numbers. */
          { href: "/purchasing/catalogue", label: "Supplier catalogue" },
          /**
           * Who has to say yes before a large order goes out. It inherits
           * `po:read` to be SHOWN, so a buyer can see why their order waits,
           * and changing a step needs `settings:write`.
           */
          { href: "/purchasing/approvals", label: "Approval steps" },
          /** Units sent back to a vendor by number, and the credit each one owes. */
          { href: "/purchasing/returns", label: "Returns to vendors" },
        ],
      },
      /** What the company owns and who has it. Under Money, because a van is the biggest thing on the balance sheet. */
      {
        href: "/fleet", label: "Fleet", permission: "asset:read", icon: "fleet",
        children: [
          { href: "/fleet", label: "Vans and tools" },
          /**
           * The container fleet, which is a different question from the van
           * register rather than a filter on it: a chipper is checked out to a
           * person, a container is hired to an address, bills on two meters and
           * has a utilisation rate. Two tables in the schema for that reason, and
           * two screens here for the same one.
           */
          { href: "/fleet/containers", label: "Containers" },
          /** A facility's file of scale tickets, matched to the hauls they weighed. */
          { href: "/fleet/containers/tickets", label: "Scale tickets" },
        ],
      },
      /**
       * The accountant's own screens: journal entries for what has no
       * document here, and the year's budget against the ledger. Shown to
       * whoever may read the ledger; the budget page itself needs
       * `report.financial:read`, which every role holding the ledger has.
       */
      {
        href: "/books", label: "Books", permission: "ledger:read", icon: "books",
        children: [
          { href: "/books", label: "Journal entries" },
          { href: "/books/budget", label: "Budget" },
        ],
      },
      {
        href: "/timesheets", label: "Timesheets", permission: "timesheet:read", icon: "timesheets",
        children: [
          { href: "/timesheets", label: "Hours" },
          /**
           * Requests to answer and leave already granted, for the people the
           * reader answers for. Under Timesheets because whoever approves the
           * hours approves the days off; answering needs `timesheet:approve`.
           */
          { href: "/timesheets/time-off", label: "Time off" },
        ],
      },
      /**
       * Beside timesheets, because it is what the hours become: a closed
       * period, a register somebody can check line by line, and the file the
       * bureau takes.
       */
      {
        href: "/payroll", label: "Payroll", permission: "payroll:read", icon: "payroll",
        children: [
          { href: "/payroll", label: "Pay periods" },
          /**
           * The rule behind the commission lines already on the register. It
           * inherits `payroll:read` to be SHOWN and the page itself needs
           * `commission:read`, because the person who runs the export is usually
           * not the person entitled to decide what people are paid.
           */
          { href: "/payroll/commissions", label: "Commission plans" },
          /**
           * When overtime starts and what each classification is paid. It
           * inherits `payroll:read` to be SHOWN and the page needs
           * `timesheet:read` to read and `payroll:configure` to change, for the
           * reason commission plans give: declaring what people are owed is
           * not the same job as paying them.
           */
          { href: "/payroll/pay-rules", label: "Pay rules" },
        ],
      },
      { href: "/booking", label: "Online booking", permission: "booking:configure", icon: "booking" },
    ],
  },
  {
    label: "Business",
    items: [
      {
        href: "/dashboards", label: "Dashboards", permission: "report:read", icon: "dashboards",
        children: [
          { href: "/dashboards", label: "All dashboards" },
          { href: "/dashboards/new", label: "Build one" },
        ],
      },
      {
        href: "/reports", label: "Reports", permission: "report:read", icon: "reports",
        children: [
          { href: "/reports", label: "All reports" },
          /**
           * Under Reports rather than beside it, because it is a reading
           * somebody does from the same place, and a top level item for one
           * screen is how a rail becomes a list of every screen. It is not a
           * report, though, which is why it is its own child and not one of
           * the eight: a report shows rows grouped a way you chose, and this
           * shows the numbers your trade already said it runs on.
           */
          { href: "/reports/scorecard", label: "Trade scorecard" },
          /**
           * Reports that arrive on their own. A child rather than a tab on
           * each report, because "what am I sending, to whom, and did it go"
           * is a question about all of them at once.
           */
          { href: "/reports/schedules", label: "Schedules" },
          { href: "/reports/new", label: "Build one" },
        ],
      },
      { href: "/reviews", label: "Reviews", permission: "review:respond", icon: "reviews" },
      /**
       * The people who work here as the office keeps them: onboarding, who to
       * ring, the facts of their employment and their skills. Business rather
       * than Work, because it is about the company's own staff; their licences
       * stay under Certifications, beside the work they unlock.
       */
      {
        href: "/people", label: "People", permission: "user:read", icon: "people",
        children: [
          { href: "/people", label: "Everybody" },
          { href: "/people/onboarding", label: "Onboarding" },
          /** What the company asks its people to sign, and who has. */
          { href: "/people/documents", label: "Documents to sign" },
        ],
      },
      /** The company's own licences, insurance and filings. Business, because it is about the company rather than a job. */
      {
        href: "/compliance", label: "Compliance", permission: "document:read", icon: "compliance",
        children: [
          { href: "/compliance", label: "Documents and filings" },
          /**
           * The two safety records. They inherit `document:read` to be SHOWN and
           * each page reads `safety:read`, except that anybody who can report
           * sees their own incident reports and the form to make one.
           */
          { href: "/compliance/safety", label: "Toolbox talks" },
          { href: "/compliance/incidents", label: "Incidents" },
          /**
           * The retention rules, what a purge would remove, and holds. It needs
           * `compliance:read`, the owner's and the administrator's, because it is
           * the one screen from which records are destroyed.
           */
          { href: "/compliance/retention", label: "Keeping records" },
        ],
      },
      {
        href: "/marketing", label: "Marketing", permission: "adspend:read", icon: "marketing",
        children: [
          /**
           * The funnel first: what each channel, campaign and number cost and
           * what came back, every figure opening into its rows. Then the
           * worklists behind it (the calls and the marketplace offers), then
           * what is set up once (channels, tracking campaigns, spend), then
           * what goes back out to the ad accounts.
           */
          { href: "/marketing", label: "Funnel" },
          /**
           * What Google saw (sessions from Analytics, searches from Search
           * Console) beside the leads and jobs each source brought.
           */
          { href: "/marketing/overview", label: "Overview" },
          /** The funnel's money columns, with where the spend came from and how fresh each platform's pull is. */
          { href: "/marketing/roi", label: "Return on spend" },
          { href: "/marketing/calls", label: "Calls" },
          { href: "/marketing/leads", label: "Lead offers" },
          { href: "/marketing/tracking", label: "Tracking campaigns" },
          { href: "/marketing/channels", label: "Channels" },
          { href: "/marketing/spend", label: "Spend" },
          { href: "/marketing/conversions", label: "Conversions" },
          /**
           * The connected ad accounts: what each pulled and sent, their
           * campaigns mapped onto the tracking campaigns, and every job told
           * back. Beside Conversions, which is the file the connection replaces.
           */
          { href: "/marketing/platforms", label: "Ad platforms" },
          /**
           * The other half of marketing: what you send to the list you already
           * own. Under Marketing rather than beside it, and it inherits
           * `adspend:read` to be SHOWN while the page itself needs
           * `campaign:read`, which is the same arrangement as Take a copy under
           * Settings and for the same reason. Called "Texts and emails" so it
           * cannot be mistaken for the tracking campaigns two lines up.
           */
          { href: "/marketing/campaigns", label: "Texts and emails" },
          /** Postcards and letters to the same audiences, each with its own address; `campaign:read` on the page, like texts. */
          { href: "/marketing/mail", label: "Direct mail" },
          /**
           * The forms the website and the hosted pages collect leads with, and
           * the customers who send other customers. Beside the calls and the
           * lead offers, because both are where leads come from.
           */
          { href: "/marketing/forms", label: "Lead forms" },
          { href: "/marketing/referrals", label: "Referrals" },
          { href: "/marketing/connectors", label: "Connectors" },
        ],
      },
      { href: "/automations", label: "Automations", permission: "workflow:read", icon: "automations" },
      {
        href: "/settings", label: "Settings", permission: "settings:read", icon: "settings",
        children: [
          { href: "/settings", label: "Company" },
          /**
           * Where the company works. Under Settings rather than under the
           * schedule because it is declared once and then read by everything
           * else: a property gets its territory when it is created, and the trip
           * charge follows from that rather than from anything on the board.
           */
          { href: "/settings/team", label: "Team" },
          { href: "/settings/branches", label: "Branches" },
          { href: "/settings/roles", label: "Roles" },
          { href: "/settings/custom-fields", label: "Custom fields" },
          /** The company's own kinds of record and their fields. Beside the fields, because they are defined the same way. */
          { href: "/settings/records", label: "Kinds of record" },
          { href: "/settings/service-area", label: "Service area" },
          /**
           * Labour burden and overhead rates, with their dates, which turn the
           * direct margin on job costing into the fully loaded one beside it.
           * Inherits `settings:read` to be shown; the page reads with
           * `job.cost:read` and changes with `finance:configure`.
           */
          { href: "/settings/costing", label: "Costing" },
          { href: "/settings/integrations", label: "Integrations" },
          /**
           * The agents that run on the model connected above: on or off, who
           * each acts as, and the log of what they did. Beside Integrations,
           * because the key it spends is set up there.
           */
          { href: "/settings/agents", label: "AI agents" },
          /**
           * How the company's own number answers: the menu, the groups of
           * phones it rings and who answers on which phone. Under Settings
           * beside Integrations, because it is set up once and read by every
           * call.
           */
          { href: "/settings/phone", label: "Phone menus" },
          /**
           * The phones each technician has signed in on, the number a sign in
           * code is texted to, and taking a lost phone away. It inherits
           * `settings:read` to be shown and needs `user:read` to be read,
           * because a phone is part of who somebody is in the company.
           */
          { href: "/settings/phones", label: "Phones" },
          /**
           * The snippet a company pastes into its own site and the pool of
           * numbers it swaps in. Under Settings because it is set up once.
           */
          { href: "/settings/website", label: "Website" },
          /**
           * What a customer can do on their own: where they sign in, whether
           * they can tip, which job photographs they see. Beside Website,
           * because the sign in address is the other thing a company puts on it.
           */
          { href: "/settings/portal", label: "Customer portal" },
          /**
           * The applications a company has let in, which is a different list from
           * the integrations this product ships: one is somebody else's software
           * acting with a grant, the other is an adapter written here. Keeping
           * them apart matters because the question asked of this one is "what is
           * reading my customer list", and that is not a question about Stripe.
           */
          { href: "/settings/apps", label: "Applications" },
          /**
           * Where this company's events are sent, and what each receiver said
           * back. Beside Applications because both are about other software,
           * and apart from it because an application reads from here and a
           * webhook is told.
           */
          { href: "/settings/webhooks", label: "Webhooks" },
          /**
           * The group this company is in, and what it has agreed to let the
           * group's operator see. Under Settings because it is a standing
           * decision rather than something anybody opens weekly, and it is the
           * member's own screen: the operator's roster is the other half of it.
           */
          { href: "/settings/network", label: "Group" },
          /**
           * Taking a copy. A child of Settings rather than a top level item,
           * and it inherits `settings:read` to be SHOWN while the page itself
           * needs `data:export` to be read, which is the one place in this rail
           * where a door is narrower than the corridor. The alternative was a
           * top level item most roles cannot open, which is worse: a rail that
           * lists what you may not have is how a product feels like it is
           * withholding.
           */
          { href: "/settings/export", label: "Take a copy" },
          /**
           * The same copy on a clock, into the owner's own bucket. Beside Take
           * a copy and narrower than its corridor for the same reason: shown
           * under `settings:read`, read under `data:export`.
           */
          { href: "/settings/backups", label: "Backups" },
          /**
           * A practice copy of the settings to try things in, and copying
           * chosen settings back. Shown under `settings:read`; making one
           * needs `sandbox:manage`, and the page says so.
           */
          { href: "/settings/sandbox", label: "Sandbox" },
        ],
      },
    ],
  },
];

/**
 * Whether a navigation item is the one you are looking at.
 *
 * A prefix match, so `/jobs/8f2a` still marks Jobs, which is what somebody
 * three clicks deep expects. `/` is the exception and has to be exact: every
 * path starts with a slash, so a prefix match would light up Today on every
 * screen in the product.
 */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Whether an item's children should be showing.
 *
 * Open when you are anywhere under the parent, closed otherwise. A section
 * that stays open after you leave it turns the rail into a list of every
 * screen in the product, which is what the groups exist to prevent.
 *
 * It asks about the parent's own href rather than any child's, because
 * `/reports/saved/8f2a` matches no child exactly and still belongs open.
 */
export function isOpen(item: NavItem, pathname: string): boolean {
  return item.children !== undefined && isActive(item.href, pathname);
}

/**
 * Which child is the one you are looking at, when more than one matches.
 *
 * Longest href wins, for the same reason the parent uses a prefix: somebody
 * on `/settings/people/abc` is in People, and `/settings/people` being a
 * prefix of nothing else should not stop it saying so. Testing each child on
 * its own would light both it and any shorter sibling, and a rail claiming
 * you are in two places is worse than one claiming nothing.
 *
 * WITH ONE EXCEPTION, which is the child that is its parent's own landing
 * page. "All reports" is `/reports` and so is Reports itself, so a prefix
 * match lights it on every screen under Reports: open one saved report and
 * the rail says you are looking at the list of them. An index is the active
 * child only when it is exactly the page, and the parent stays marked either
 * way, so nothing is lost by it going quiet.
 */
export function activeChild(item: NavItem, pathname: string): string | null {
  const matches = (item.children ?? []).filter((child) =>
    child.href === item.href ? pathname === child.href : isActive(child.href, pathname));
  const best = matches.reduce<NavChild | null>(
    (winner, child) => (winner && winner.href.length >= child.href.length ? winner : child),
    null,
  );
  return best?.href ?? null;
}
