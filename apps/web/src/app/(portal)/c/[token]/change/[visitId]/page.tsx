import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { visitChanges } from "@opentradesos/api/services";
import { PortalBrand } from "../../../../PortalBrand";
import { VisitChange } from "../../../../VisitChange";

export const dynamic = "force-dynamic";

/**
 * Moving or cancelling one of the visits on a customer's account link.
 *
 * The visit id is from the URL, so the service checks it belongs to the
 * customer the link names; another customer's visit is the same 404 as one
 * that does not exist.
 */
export default async function ChangeAccountVisitPage({
  params,
}: {
  params: Promise<{ token: string; visitId: string }>;
}) {
  const { token, visitId } = await params;
  let options: Awaited<ReturnType<typeof visitChanges.options>>;
  try {
    options = await visitChanges.options(getDb(), { token, visitId });
  } catch {
    notFound();
  }
  return (
    <PortalBrand token={token}>
      <VisitChange token={token} options={options} visitId={visitId} path={`/c/${token}/change/${visitId}`} />
      <p className="text-center text-sm">
        <a href={`/c/${token}`} className="text-ink-700 underline underline-offset-4">Back to your account</a>
      </p>
    </PortalBrand>
  );
}
