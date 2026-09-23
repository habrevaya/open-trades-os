import { headers } from "next/headers";
import { Logo } from "./Logo";
import { NavIcon } from "./NavIcon";
import { signOut } from "@/app/(auth)/actions";
import { setRail } from "@/app/(app)/actions";
import type { CurrentUser } from "@/lib/auth";
import { railCollapsed } from "@/lib/rail";
import { NAV, isActive, isOpen, activeChild, type NavGroup, type NavItem } from "@/lib/nav";
import { can } from "@opentradesos/core";

/**
 * THE SHELL
 *
 * A left rail on a desktop, because this is a system somebody sits in for
 * eight hours rather than a site they visit. A horizontal bar has room for
 * about seven items before it wraps or scrolls, and this product already has
 * fourteen and will have forty: the rail grows down, which is a direction a
 * screen has.
 *
 * It also gives the sections somewhere to live. A flat row of fourteen links
 * is a list somebody reads top to bottom every time they look for one.
 *
 * AND IT COLLAPSES, because the rail is not what anybody opened the product
 * for. The dispatch board is as wide as the company has technicians and the
 * rail is two hundred and forty pixels of that. Collapsed it keeps the icons
 * in the same order, so "third one down" still means the same screen, which
 * is what stops a collapsed rail being a different product.
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
  const collapsed = await railCollapsed();

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
      <aside
        data-rail={collapsed ? "collapsed" : "expanded"}
        className={`hidden shrink-0 border-r border-steel-200 bg-canvas lg:flex lg:h-screen lg:flex-col lg:sticky lg:top-0 ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <a
          href="/"
          title={collapsed ? user.organizationName : undefined}
          className={`flex items-center gap-2.5 border-b border-steel-200 py-4 ${
            collapsed ? "justify-center px-0" : "px-5"
          }`}
        >
          <Logo className="h-6 w-6 shrink-0" />
          {!collapsed && (
            <span className="truncate text-base font-semibold tracking-[-0.01em]">
              {user.organizationName}
            </span>
          )}
        </a>

        <nav className={`flex-1 overflow-y-auto py-4 ${collapsed ? "px-2" : "px-3"}`}>
          {groups.map((group, index) => (
            <div key={group.label ?? "top"} className="mb-5 last:mb-0">
              {group.label && (collapsed ? (
                /*
                  The heading becomes a rule. There is no room for the word
                  and the grouping is still worth keeping: it is what makes
                  the vertical order identical in both states. The first group
                  has no heading, so it gets no rule either.
                */
                index > 0 ? <hr className="mx-2 mb-2 border-steel-200" /> : null
              ) : (
                <p className="px-2 pb-1.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-500">
                  {group.label}
                </p>
              ))}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <RailLink item={item} pathname={pathname} collapsed={collapsed} />
                    {/*
                      Children are dropped entirely when collapsed rather than
                      indented into a sixteen pixel strip, where they would be
                      identical unlabelled marks under one another.
                    */}
                    {!collapsed && isOpen(item, pathname) && (
                      <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-steel-200 pl-3">
                        {item.children?.map((child) => (
                          <li key={child.href}>
                            <a
                              href={child.href}
                              aria-current={activeChild(item, pathname) === child.href ? "page" : undefined}
                              className={`block rounded px-2 py-1 text-sm transition-colors ${
                                activeChild(item, pathname) === child.href
                                  ? "font-medium text-ink-900"
                                  : "text-ink-500 hover:bg-steel-100 hover:text-ink-700"
                              }`}
                            >
                              {child.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className={`border-t border-steel-200 py-3 ${collapsed ? "px-2" : "px-3"}`}>
          {!collapsed && (
            <p className="truncate px-2 pb-1 text-sm text-ink-700">{user.name ?? user.email}</p>
          )}
          <form action={setRail}>
            {/*
              The next state travels with the request rather than being read
              and flipped on the server, so two tabs open on the same rail
              cannot each undo what the other just wrote.
            */}
            <input type="hidden" name="next" value={collapsed ? "expanded" : "collapsed"} />
            <button
              type="submit"
              title={collapsed ? "Expand the menu" : "Collapse the menu"}
              aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
              className={`flex w-full items-center gap-2.5 rounded py-1.5 text-sm text-ink-500 transition-colors hover:bg-steel-100 hover:text-ink-900 ${
                collapsed ? "justify-center px-0" : "px-2"
              }`}
            >
              <Chevron pointing={collapsed ? "right" : "left"} />
              {!collapsed && <span>Collapse</span>}
            </button>
          </form>
          <form action={signOut}>
            <button
              type="submit"
              title={collapsed ? "Sign out" : undefined}
              aria-label="Sign out"
              className={`flex w-full items-center gap-2.5 rounded py-1.5 text-sm text-ink-500 transition-colors hover:bg-steel-100 hover:text-ink-900 ${
                collapsed ? "justify-center px-0" : "px-2"
              }`}
            >
              <SignOutMark />
              {!collapsed && <span>Sign out</span>}
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

          It does not collapse. A phone menu is already closed by default, and
          a second narrower state for it would be a strip of icons on the one
          screen size where the tap target is the scarce thing.
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
                           className={`flex items-center gap-2.5 rounded px-2 py-2 text-sm ${
                             isActive(item.href, pathname)
                               ? "bg-steel-100 font-medium text-ink-900"
                               : "text-ink-700"
                           }`}>
                          <NavIcon name={item.icon} />
                          {item.label}
                        </a>
                        {isOpen(item, pathname) && (
                          <ul className="ml-[30px] space-y-0.5 border-l border-steel-200 pl-3">
                            {item.children?.map((child) => (
                              <li key={child.href}>
                                <a href={child.href}
                                   aria-current={activeChild(item, pathname) === child.href ? "page" : undefined}
                                   className={`block rounded px-2 py-2 text-sm ${
                                     activeChild(item, pathname) === child.href
                                       ? "font-medium text-ink-900"
                                       : "text-ink-500"
                                   }`}>
                                  {child.label}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
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

function RailLink({ item, pathname, collapsed }: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const active = isActive(item.href, pathname);
  return (
    <a
      href={item.href}
      aria-current={active ? "page" : undefined}
      /*
        The label survives the collapse as a tooltip and as the accessible
        name. Collapsed, the icon is the only visible label, and an icon with
        no name is a link a screen reader announces as its URL.
      */
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={`flex items-center gap-2.5 rounded py-1.5 text-sm transition-colors ${
        collapsed ? "justify-center px-0" : "px-2"
      } ${active ? "bg-steel-100 font-medium text-ink-900" : "text-ink-700 hover:bg-steel-100"}`}
    >
      <NavIcon name={item.icon} />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </a>
  );
}

function Chevron({ pointing }: { pointing: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" aria-hidden
      fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d={pointing === "left" ? "M14.5 6 8.5 12l6 6" : "M9.5 6l6 6-6 6"} />
    </svg>
  );
}

function SignOutMark() {
  return (
    <svg
      viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" aria-hidden
      fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
      <path d="M10 8.2 13.8 12 10 15.8M13.4 12H4.5" />
    </svg>
  );
}
