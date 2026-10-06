import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { visitChanges } from "@opentradesos/api/services";
import { PortalBrand } from "../../../PortalBrand";
import { VisitChange } from "../../../VisitChange";

export const dynamic = "force-dynamic";

/**
 * Moving or cancelling the visit a job link is about.
 *
 * The next visit still to come, the same one the tracking page shows, or
 * the one named by `?visit=` when the office's offer links to it. Every
 * failure to resolve the link is the same 404, like every other portal page.
 */
export default async function ChangeJobVisitPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  /** `visit` names one visit of the job, as the office's offer of another time links to it. */
  searchParams: Promise<{ visit?: string }>;
}) {
  const { token } = await params;
  const { visit } = await searchParams;
  const visitId = visit && /^[0-9a-f-]{36}$/i.test(visit) ? visit : undefined;
  let options: Awaited<ReturnType<typeof visitChanges.options>>;
  try {
    options = await visitChanges.options(getDb(), { token, ...(visitId ? { visitId } : {}) });
  } catch {
    notFound();
  }
  const path = `/j/${token}/change${visitId ? `?visit=${visitId}` : ""}`;
  return (
    <PortalBrand token={token}>
      <VisitChange token={token} options={options} path={path} {...(visitId ? { visitId } : {})} />
      <p className="text-center text-sm">
        <a href={`/j/${token}`} className="text-ink-700 underline underline-offset-4">Back to your visit</a>
      </p>
    </PortalBrand>
  );
}
