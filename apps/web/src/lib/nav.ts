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
    ],
  },
  {
    label: "Work",
    items: [
      { href: "/schedule", label: "Schedule", permission: "visit:read", icon: "schedule" },
      { href: "/jobs", label: "Jobs", permission: "job:read", icon: "jobs" },
      { href: "/tasks", label: "Tasks", permission: "task:read", icon: "tasks" },
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
      { href: "/customers", label: "Customers", permission: "customer:read", icon: "customers" },
      /**
       * Under Customers rather than under Money, because the question it
       * answers is about a client ("whose price governs for them?") rather
       * than about a number. Somebody opens this before quoting, not while
       * invoicing.
       */
      { href: "/contracts", label: "Contracts", permission: "contract:read", icon: "contracts" },
      { href: "/inbox", label: "Inbox", permission: "message:read", icon: "inbox" },
    ],
  },
  {
    label: "Money",
    items: [
      { href: "/estimates", label: "Estimates", permission: "estimate:read", icon: "estimates" },
      { href: "/invoices", label: "Invoices", permission: "invoice:read", icon: "invoices" },
      { href: "/agreements", label: "Agreements", permission: "membership:read", icon: "agreements" },
      { href: "/pricebook", label: "Price book", permission: "pricebook:read", icon: "pricebook" },
      { href: "/inventory", label: "Inventory", permission: "inventory:read", icon: "inventory" },
      { href: "/purchasing", label: "Purchasing", permission: "po:read", icon: "purchasing" },
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
        ],
      },
      { href: "/timesheets", label: "Timesheets", permission: "timesheet:read", icon: "timesheets" },
      /**
       * Beside timesheets, because it is what the hours become: a closed
       * period, a register somebody can check line by line, and the file the
       * bureau takes.
       */
      { href: "/payroll", label: "Payroll", permission: "payroll:read", icon: "payroll" },
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
          { href: "/reports/new", label: "Build one" },
        ],
      },
      { href: "/reviews", label: "Reviews", permission: "review:respond", icon: "reviews" },
      /** The company's own licences, insurance and filings. Business, because it is about the company rather than a job. */
      { href: "/compliance", label: "Compliance", permission: "document:read", icon: "compliance" },
      {
        href: "/marketing", label: "Marketing", permission: "adspend:read", icon: "marketing",
        children: [
          { href: "/marketing", label: "What it cost" },
          { href: "/marketing/connectors", label: "Connectors" },
        ],
      },
      { href: "/automations", label: "Automations", permission: "workflow:read", icon: "automations" },
      {
        href: "/settings", label: "Settings", permission: "settings:read", icon: "settings",
        children: [
          { href: "/settings", label: "Company" },
          { href: "/settings/integrations", label: "Integrations" },
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
