import Script from "next/script";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { websiteTracking, phoneNumbers } from "@opentradesos/api/services";
import { assertCan } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";

export const dynamic = "force-dynamic";

/**
 * A PAGE WITH YOUR NUMBERS ON IT, AND THE SNIPPET
 *
 * The company's main and tracking numbers written the ways websites write
 * them, a phone link, and a link to the booking page, with the real snippet
 * loaded. With pool numbers bought, the numbers below change to one of them
 * and keep their formatting; the booking link gains the visitor id.
 */
export default async function WebsiteTestPage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "settings:read");
  const ctx = { actor: user.actor, db: getDb() };
  const view = await websiteTracking.overview(ctx);
  const numbers = (await phoneNumbers.list(ctx, {})).filter((n) => n.purpose === "main" || n.purpose === "tracking");
  const main = numbers[0]?.e164 ?? null;
  const national = main ? main.replace(/^\+1/, "") : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/settings/website">Website</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Test page</h1>
      {national ? (
        <div className="mt-4 space-y-2 text-sm" data-testid="swap-sample">
          <p>Call us: <span data-number="plain">({national.slice(0, 3)}) {national.slice(3, 6)}-{national.slice(6)}</span></p>
          <p>Or: <span data-number="dots">{national.slice(0, 3)}.{national.slice(3, 6)}.{national.slice(6)}</span></p>
          <p><a href={`tel:${main}`} data-number="link">Tap to call</a></p>
          <p><a href={`${(process.env["PUBLIC_URL"] ?? "").replace(/\/$/, "")}/book/${view.companyKey}`} data-link="book">Book online</a></p>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-700">Add your main number under Settings first, so there is something to swap.</p>
      )}
      <p className="mt-6 text-xs text-ink-500">
        This page loads the snippet exactly as your website will. Visiting it counts as a visit.
      </p>
      {/*
        After the page is idle, as the snippet runs on a website: after the
        page has drawn. Earlier, it would change the numbers while React was
        still matching the page it rendered, and React would put them back.
      */}
      <Script src={`/t.js?c=${view.companyKey}`} strategy="lazyOnload" />
    </div>
  );
}
