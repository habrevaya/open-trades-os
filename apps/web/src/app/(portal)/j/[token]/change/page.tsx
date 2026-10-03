import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { visitChanges } from "@opentradesos/api/services";
import { PortalBrand } from "../../../PortalBrand";
import { VisitChange } from "../../../VisitChange";

export const dynamic = "force-dynamic";

/**
 * Moving or cancelling the visit a job link is about.
 *
 * The next visit still to come, the same one the tracking page shows. Every
 * failure to resolve the link is the same 404, like every other portal page.
 */
export default async function ChangeJobVisitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let options: Awaited<ReturnType<typeof visitChanges.options>>;
  try {
    options = await visitChanges.options(getDb(), { token });
  } catch {
    notFound();
  }
  return (
    <PortalBrand token={token}>
      <VisitChange token={token} options={options} path={`/j/${token}/change`} />
      <p className="text-center text-sm">
        <a href={`/j/${token}`} className="text-ink-700 underline underline-offset-4">Back to your visit</a>
      </p>
    </PortalBrand>
  );
}
