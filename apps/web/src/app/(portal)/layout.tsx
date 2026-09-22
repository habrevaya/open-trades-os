/**
 * THE CUSTOMER SIDE
 *
 * A separate route group because none of the app shell belongs here. There is
 * no navigation, no account menu and no way into the rest of the product: the
 * person on these pages holds a link, not a login, and every affordance that
 * suggests otherwise is a dead end they will try.
 *
 * It is also the only part of the product a stranger can reach, so it is kept
 * deliberately small.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-steel-100">
      <main className="mx-auto max-w-2xl px-4 py-8 sm:py-12">{children}</main>
      <footer className="pb-10 text-center text-xs text-ink-500">
        Powered by OpenTradesOS
      </footer>
    </div>
  );
}
