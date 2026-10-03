import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { proposals, NotFoundError } from "@opentradesos/api/services";
import { Crumb } from "@/components/Detail";
import { PrintButton } from "@/components/PrintButton";
import { ProposalView } from "@/components/Proposal";

export const dynamic = "force-dynamic";

/**
 * THE PROPOSAL, from the office: to read over before it goes, to print and
 * leave on the table, or to save as a PDF from the browser's print dialog.
 * The same document the customer's link shows, from the same function.
 */
export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const proposal = await proposals.proposal({ actor: user.actor, db: getDb() }, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6 print:max-w-none print:p-0">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Crumb href={`/estimates/${id}`}>Estimate {proposal.number}</Crumb>
        <div className="flex items-center gap-3">
          <a href={`/estimates/${id}/pdf`} className="text-sm underline underline-offset-4">Download PDF</a>
          <PrintButton label="Print" />
        </div>
      </div>
      <ProposalView
        proposal={proposal}
        logoSrc={proposal.company.hasLogo ? `/brand/logo?v=${proposal.company.version}` : null}
        timezone={user.organizationTimezone}
      />
    </div>
  );
}
