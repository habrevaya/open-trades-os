import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { portal } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * The link handed out at the moment of booking.
 *
 * At that moment there is no customer and no job, only a request, so the grant
 * is scoped to the request. Confirming repoints the same grant at the job,
 * which is why this page checks the scope rather than assuming one: the link
 * in someone's inbox does not change when the office confirms, and it has to
 * keep working either way.
 */
export default async function BookingTrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let session: Awaited<ReturnType<typeof portal.openLink>>;
  try {
    session = await portal.openLink(getDb(), { token });
  } catch {
    notFound();
  }

  if (session.scope === "job") redirect(`/j/${token}`);

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{session.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Request received</h1>
      </header>

      <div className="rounded-md border border-steel-200 bg-canvas p-8 text-center">
        <p className="font-medium">We have your request.</p>
        <p className="mx-auto mt-3 max-w-sm text-sm text-ink-700">
          Someone is looking at the schedule now. As soon as it is confirmed, this page
          will show your appointment and who is coming.
        </p>
      </div>
    </div>
  );
}
