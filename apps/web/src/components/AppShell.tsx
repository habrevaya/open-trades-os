import { headers } from "next/headers";
import { Logo } from "./Logo";
import { signOut } from "@/app/(auth)/actions";
import type { CurrentUser } from "@/lib/auth";
import { NAV, isActive, type NavGroup } from "@/lib/nav";
import { can } from "@opentradesos/core";

/**
 * THE SHELL
 *
 * A left rail on a desktop, because this is a system somebody sits in for
 * eight hours rather than a site they visit. A horizontal bar has room for
 * about seven items before it wraps or scrolls, and this product already has
 * eleven and will have thirty: the rail grows down, which is a direction a
 * screen has.
 *
 * It also gives the sections somewhere to live. A flat row of eleven links is
 * a list somebody reads top to bottom every time they look for one.
 *
 * NAVIGATION IS FILTERED BY PERMISSION, NOT DISABLED. A dispatcher does not
 * see an Invoices link they cannot open. Showing a door somebody cannot walk
 * through is how a product feels like it is withholding rather than fitting,
 * and it leaks the shape of the system to people who should not have it.
 */
export async function AppShell({
  user, children,
}: { user: CurrentUser; children: React.ReactNode }) {
  // Set by middleware, because a server component cannot ask for its own URL.
  const pathname = (await headers()).get("x-pathname") ?? "/";

  const groups: NavGroup[] = NAV
    .map((group) => ({ ...group, items: group.items.filter((i) => can(user.actor, i.permission)) }))
    // A heading with nothing under it is a section somebody was refused.
    .filter((group) => group.items.length > 0);

  return (
    <div className="min-h-screen lg:flex">
      {/*
        The rail. Fixed height and its own scroll, so a long list does not
        push the sign out button off the bottom and the main column scrolls
        independently, which is what a person switching between a long board
        and a short form expects.
      */}
      <aside className="hidden w-60 shrink-0 border-r border-steel-200 bg-canvas lg:flex lg:h-screen lg:flex-col lg:sticky lg:top-0">
        <a href="/" className="flex items-center gap-2.5 border-b border-steel-200 px-5 py-4">
          <Logo className="h-6 w-6 shrink-0" />
          <span className="truncate text-base font-semibold tracking-[-0.01em]">
            {user.organizationName}
          </span>
        </a>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {groups.map((group) => (
            <div key={group.label ?? "top"} className="mb-5 last:mb-0">
              {group.label && (
                <p className="px-2 pb-1.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-500">
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      aria-current={isActive(item.href, pathname) ? "page" : undefined}
                      className={`block rounded px-2 py-1.5 text-sm transition-colors ${
                        isActive(item.href, pathname)
                          ? "bg-steel-100 font-medium text-ink-900"
                          : "text-ink-700 hover:bg-steel-100"
                      }`}
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-steel-200 px-3 py-3">
          <p className="truncate px-2 pb-1 text-sm text-ink-700">{user.name ?? user.email}</p>
          <form action={signOut}>
            <button type="submit"
                    className="w-full rounded px-2 py-1.5 text-left text-sm text-ink-500 transition-colors hover:bg-steel-100 hover:text-ink-900">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          On a phone the rail becomes a disclosure under the header. `details`
          rather than a state hook, so the shell stays a server component and
          the menu works before any JavaScript has loaded, which on a phone in
          a driveway is most of the time.
        */}
        <header className="sticky top-0 z-40 border-b border-steel-200 bg-canvas lg:hidden">
          <details className="group">
            <summary className="flex h-14 cursor-pointer list-none items-center gap-3 px-4">
              <Logo className="h-6 w-6 shrink-0" />
              <span className="truncate text-base font-semibold">{user.organizationName}</span>
              <span className="ml-auto text-sm text-ink-500 group-open:hidden">Menu</span>
              <span className="ml-auto hidden text-sm text-ink-500 group-open:inline">Close</span>
            </summary>

            <nav className="border-t border-steel-200 px-3 py-3">
              {groups.map((group) => (
                <div key={group.label ?? "top"} className="mb-4 last:mb-0">
                  {group.label && (
                    <p className="px-2 pb-1 text-xs font-medium uppercase tracking-[0.08em] text-ink-500">
                      {group.label}
                    </p>
                  )}
                  <ul className="space-y-0.5">
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <a href={item.href}
                           aria-current={isActive(item.href, pathname) ? "page" : undefined}
                           className={`block rounded px-2 py-2 text-sm ${
                             isActive(item.href, pathname)
                               ? "bg-steel-100 font-medium text-ink-900"
                               : "text-ink-700"
                           }`}>
                          {item.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <form action={signOut} className="border-t border-steel-200 pt-3">
                <button type="submit" className="px-2 py-2 text-sm text-ink-500">Sign out</button>
              </form>
            </nav>
          </details>
        </header>

        <main className="flex-1 bg-canvas-raised">{children}</main>
      </div>
    </div>
  );
}
