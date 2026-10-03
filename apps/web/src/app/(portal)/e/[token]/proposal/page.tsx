import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { financing, proposals } from "@opentradesos/api/services";
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
  /**
   * The monthly figures, printed with their sentence, because a proposal on
   * the kitchen table is where "what is that a month" gets asked.
   */
  const loan = await financing.portalEstimate(getDb(), { token }).catch(() => null);
  const offers = loan?.options.filter((o) => o.offer) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={`/e/${token}`} className="text-sm text-ink-500 hover:underline">Back to choose and approve</a>
        <PrintButton label="Print or save as PDF" />
      </div>
      <div className="rounded-md border border-steel-200 bg-canvas p-5 print:border-0 print:p-0">
        <ProposalView
          proposal={proposal}
          logoSrc={proposal.company.hasLogo
            ? `/brand/logo?t=${encodeURIComponent(token)}&v=${proposal.company.version}` : null}
          timezone={proposal.company.timezone}
        />
      </div>
      {offers.length > 0 ? (
        <section aria-label="Pay over time" className="rounded-md border border-steel-200 bg-canvas p-5 text-sm print:border-0 print:p-0">
          <h2 className="text-xs uppercase tracking-[0.08em] text-ink-500">Pay over time</h2>
          <ul className="mt-2 space-y-1 text-ink-700">
            {offers.map((o) => (
              <li key={o.optionId}><span className="font-medium text-ink-900">{o.name}: </span>{o.offer!.sentence}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
