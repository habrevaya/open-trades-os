import { getDb } from "@/lib/db";
import { portalBooking } from "@opentradesos/api/services";
import { requirePortalSession } from "@/lib/portal-session";
import { PortalBrand } from "../../../../PortalBrand";
import { BookVisit } from "./BookVisit";
import { bookFromAccount, loadAccountSlots } from "./actions";

export const dynamic = "force-dynamic";

/**
 * A SIGNED IN CUSTOMER ASKING FOR A VISIT
 *
 * What the company takes online, at one of their own addresses, from
 * anybody or from somebody who has been before, in a window somebody is
 * actually free for. The office still books it, as it books one from the
 * website.
 */
export default async function BookFromAccountPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requirePortalSession(slug);
  const choices = await portalBooking.options(getDb(), { token: session.token });
  const base = `/portal/${encodeURIComponent(slug)}`;

  return (
    <PortalBrand token={session.token} logoHref={`${base}/logo`}>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{session.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Book a visit</h1>
        <a href={`${base}/account`} className="mt-2 inline-block text-sm text-ink-700 underline underline-offset-4">
          Back to your account
        </a>
      </header>
      {choices.services.length === 0 || choices.properties.length === 0 ? (
        <p className="rounded-md border border-steel-200 bg-canvas p-5 text-sm text-ink-700">
          {choices.services.length === 0
            ? `${session.organizationName} does not take bookings online. Reply to any message from them to book.`
            : `We do not have an address for you yet. Reply to any message from ${session.organizationName} to book.`}
        </p>
      ) : (
        <BookVisit
          services={choices.services}
          properties={choices.properties}
          technicians={choices.technicians}
          load={loadAccountSlots.bind(null, slug)}
          book={bookFromAccount.bind(null, slug)}
        />
      )}
    </PortalBrand>
  );
}
