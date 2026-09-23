import { Logo } from "./Logo";
import { signOut } from "@/app/(auth)/actions";
import type { CurrentUser } from "@/lib/auth";
import { can, type Permission } from "@opentradesos/core";

/**
 * Navigation is filtered by permission, not merely disabled.
 *
 * A dispatcher does not see an Invoicing link they cannot open, and a
 * technician does not see Reports. Showing a door somebody cannot walk
 * through is how a product feels like it is withholding rather than fitting,
 * and it also leaks the shape of the system to people who should not have it.
 */
const NAV: { href: string; label: string; permission: Permission }[] = [
  /**
   * A technician's own day, first. For the person who holds this permission it
   * is the only screen they open, and on a phone the row scrolls, so anything
   * ahead of it is a swipe they should not have to make.
   */
  { href: "/my-day", label: "My day", permission: "field:sync" },
  { href: "/", label: "Today", permission: "job:read" },
  { href: "/schedule", label: "Schedule", permission: "visit:read" },
  { href: "/jobs", label: "Jobs", permission: "job:read" },
  { href: "/customers", label: "Customers", permission: "customer:read" },
  { href: "/inbox", label: "Inbox", permission: "message:read" },
  { href: "/pricebook", label: "Price book", permission: "pricebook:read" },
  { href: "/invoices", label: "Invoices", permission: "invoice:read" },
  /**
   * Reports is absent on purpose rather than pending.
   *
   * It was in this list with no route behind it, along with five others, so
   * the navigation 404ed for anybody who clicked. A door that leads nowhere
   * is worse than a missing feature: the product reads as broken rather than
   * unfinished. It goes back the day there is something behind it, and
   * test/routes.test.ts fails if anything here ever gets ahead of the routes
   * again.
   */
  { href: "/settings", label: "Settings", permission: "settings:read" },
];

export function AppShell({ user, children }: { user: CurrentUser; children: React.ReactNode }) {
  const items = NAV.filter((item) => can(user.actor, item.permission));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-steel-200 bg-canvas">
        <div className="flex h-14 items-center gap-6 px-4 lg:px-6">
          <a href="/" className="flex items-center gap-2.5">
            <Logo className="h-6 w-6" />
            <span className="hidden text-base font-semibold tracking-[-0.01em] sm:inline">
              {user.organizationName}
            </span>
          </a>

          <nav className="hidden flex-1 items-center gap-1 lg:flex">
            {items.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-steel-100"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-ink-500 sm:inline">{user.name ?? user.email}</span>
            <form action={signOut}>
              <button type="submit" className="rounded px-3 py-1.5 text-sm text-ink-700 transition-colors hover:bg-steel-100">
                Sign out
              </button>
            </form>
          </div>
        </div>

        {/* The same links, scrollable, on a phone. */}
        <nav className="flex gap-1 overflow-x-auto border-t border-steel-200 px-4 py-2 lg:hidden">
          {items.map((item) => (
            <a key={item.href} href={item.href}
               className="whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium text-ink-700">
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      <main className="flex-1 bg-canvas-raised">{children}</main>
    </div>
  );
}
