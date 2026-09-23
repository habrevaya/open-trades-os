import type { Permission } from "@opentradesos/core";

/**
 * THE NAVIGATION, AS DATA
 *
 * Separate from the component that draws it so the route test can read it,
 * and so the active-state logic is a function with its own tests rather than
 * a ternary inside markup.
 *
 * Grouped because a flat list of eleven is a list somebody reads top to
 * bottom every time. The groups are the way a contractor already thinks about
 * their day: what is happening now, the work, the people, the money, and the
 * things you set up once.
 */
export interface NavItem {
  href: string;
  label: string;
  permission: Permission;
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
      { href: "/my-day", label: "My day", permission: "field:sync" },
      { href: "/", label: "Today", permission: "job:read" },
    ],
  },
  {
    label: "Work",
    items: [
      { href: "/schedule", label: "Schedule", permission: "visit:read" },
      { href: "/jobs", label: "Jobs", permission: "job:read" },
      { href: "/tasks", label: "Tasks", permission: "task:read" },
    ],
  },
  {
    label: "Customers",
    items: [
      { href: "/customers", label: "Customers", permission: "customer:read" },
      { href: "/inbox", label: "Inbox", permission: "message:read" },
    ],
  },
  {
    label: "Money",
    items: [
      { href: "/invoices", label: "Invoices", permission: "invoice:read" },
      { href: "/pricebook", label: "Price book", permission: "pricebook:read" },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/reports", label: "Reports", permission: "report:read" },
      { href: "/settings", label: "Settings", permission: "settings:read" },
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
