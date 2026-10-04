import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { directMail } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * A POSTCARD'S OWN WEB ADDRESS
 *
 * The address printed on one piece of a mailing, and the one its QR code
 * opens. Public, because the person holding the card has no login, and the
 * code is the whole of the address. Opening it is counted on the piece and
 * recorded as a touch on the mailing for the customer it was addressed to,
 * so the job they book is credited to the mailing. What it shows is the
 * mailing's own words, the number to ring (the mailing's tracking number, so
 * a call from here is credited to it too) and a way to book online.
 */
export default async function MailPiecePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const page = await directMail.visit(getDb(), { code }).catch(() => null);
  if (!page) notFound();

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="text-sm text-ink-500">{page.companyName}</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {page.headline ?? (page.firstName ? `Hello ${page.firstName}` : `Hello from ${page.companyName}`)}
        </h1>
      </header>
      <section className="rounded-md border border-steel-200 bg-canvas p-6">
        {page.body ? (
          <p className="whitespace-pre-line text-ink-700">{page.body}</p>
        ) : (
          <p className="text-ink-700">Thanks for looking us up. Ring us or book a time below and we will take it from there.</p>
        )}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          {page.phone ? (
            <a href={`tel:${page.phone.replace(/[^\d+]/g, "")}`}
               className="inline-flex h-12 items-center justify-center rounded bg-ink-900 px-5 text-base font-medium text-white hover:bg-ink-700">
              Call {page.phone}
            </a>
          ) : null}
          {page.bookingPath ? (
            <a href={page.bookingPath} className="inline-flex h-12 items-center justify-center rounded border border-steel-300 px-5 text-base font-medium">
              Book online
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}
