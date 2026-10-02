/**
 * THE DEMO SAYS IT IS ONE, ON EVERY SCREEN.
 *
 * In the shell rather than on a page, so there is no screen of the demo that
 * forgets to say it, and not dismissible, because the one visitor who closes
 * it is the one who then types a customer in and wonders where it went. The
 * read only guarantee is not this banner's job: the session is read only on
 * the server whatever the screen shows.
 */
export function DemoBanner({ website = process.env["DEMO_WEBSITE_URL"] || "https://opentradesos.com" }: {
  /** Where "Back to the website" goes. DEMO_WEBSITE_URL, or the project's site. */
  website?: string;
}) {
  return (
    <div
      role="note"
      aria-label="Demo"
      data-demo-banner
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-700 bg-amber-tint px-4 py-2 text-sm text-ink-900"
    >
      <span>You&rsquo;re viewing a demo company. Nothing you do here is saved.</span>
      <a href={website} className="font-medium underline underline-offset-2">Back to the website</a>
    </div>
  );
}
