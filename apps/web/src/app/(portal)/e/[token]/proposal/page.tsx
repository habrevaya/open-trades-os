import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { proposals } from "@opentradesos/api/services";
import { PrintButton } from "@/components/PrintButton";
import { ProposalView } from "@/components/Proposal";

export const dynamic = "force-dynamic";

/**
 * THE CUSTOMER'S PROPOSAL, TO PRINT
 *
 * From the same link as the approval page and reading the same grant without
 * spending it, so printing the proposal to show the other person in the house
 * does not use up the link they will approve with. Every failure is the same
 * 404, like every other page behind a link.
 */
export default async function PortalProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let proposal: Awaited<ReturnType<typeof proposals.proposalForToken>>;
  try {
    proposal = await proposals.proposalForToken(getDb(), token);
  } catch {
    notFound();
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={`/e/${token}`} className="text-sm text-ink-500 hover:underline">Back to choose and approve</a>
        <span className="flex items-center gap-3">
          <a href={`/e/${token}/pdf`} className="text-sm underline underline-offset-4">Download PDF</a>
          <PrintButton label="Print" />
        </span>
      </div>
      <div className="rounded-md border border-steel-200 bg-canvas p-5 print:border-0 print:p-0">
        <ProposalView
          proposal={proposal}
          logoSrc={proposal.company.hasLogo
            ? `/brand/logo?t=${encodeURIComponent(token)}&v=${proposal.company.version}` : null}
          timezone={proposal.company.timezone}
        />
      </div>
    </div>
  );
}
