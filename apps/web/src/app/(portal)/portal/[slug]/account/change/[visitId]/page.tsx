import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { visitChanges } from "@opentradesos/api/services";
import { requirePortalSession } from "@/lib/portal-session";
import { PortalBrand } from "../../../../../PortalBrand";
import { VisitChange } from "../../../../../VisitChange";
import { answerSessionVisitChangeProposal, requestSessionVisitChange } from "../../actions";

export const dynamic = "force-dynamic";

/**
 * Moving or cancelling one of a signed in customer's visits.
 *
 * The same component and the same service as the account link's page. The
 * visit id is from the URL, so the service checks it belongs to the
 * customer the sign in names, and the form asks through an action bound to
 * the company rather than one holding a token.
 */
export default async function SignedInChangeVisitPage({
  params,
}: {
  params: Promise<{ slug: string; visitId: string }>;
}) {
  const { slug, visitId } = await params;
  const session = await requirePortalSession(slug);
  let options: Awaited<ReturnType<typeof visitChanges.options>>;
  try {
    options = await visitChanges.options(getDb(), { token: session.token, visitId });
  } catch {
    notFound();
  }
  const base = `/portal/${encodeURIComponent(slug)}`;
  return (
    <PortalBrand token={session.token} logoHref={`${base}/logo`}>
      <VisitChange
        send={requestSessionVisitChange.bind(null, slug)}
        answer={answerSessionVisitChangeProposal.bind(null, slug)}
        options={options}
        visitId={visitId}
        path={`${base}/account/change/${visitId}`}
      />
      <p className="text-center text-sm">
        <a href={`${base}/account`} className="text-ink-700 underline underline-offset-4">Back to your account</a>
      </p>
    </PortalBrand>
  );
}
