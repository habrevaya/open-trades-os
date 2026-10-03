import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { claims as claimService } from "@opentradesos/api/services";
import { claims } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { CLAIM_TONE } from "./labels";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "waiting", label: "Waiting on them", status: ["submitted", "approved"] as claims.ClaimStatus[] },
  { key: "short", label: "Short paid or denied", status: ["short_paid", "denied"] as claims.ClaimStatus[] },
  { key: "all", label: "All", status: undefined },
] as const;

/**
 * CLAIMS ON THIRD PARTIES
 *
 * Every claim filed with a home warranty company, a manufacturer or a
 * carrier, newest first, and what each one still owes. Waiting on them is
 * the default view because that is the list somebody works on the phone; the
 * short paid and denied ones are the ones to decide about, chase or write off.
 */
export default async function ClaimsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await requireSetupUser();
  const { view } = await searchParams;
  const current = VIEWS.find((v) => v.key === view) ?? VIEWS[0];
  const rows = await claimService.list({ actor: user.actor, db: getDb() },
    current.status ? { status: [...current.status] } : {});
  const owed = rows.reduce((sum, c) => sum + Number(c.outstanding), 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Claims" count={rows.length} />
      {owed > 0 && (
        <p className="mt-2 text-sm text-ink-700"><Money value={owed.toFixed(2)} /> still expected from them.</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <a key={v.key} href={`/invoices/claims?view=${v.key}`}
             className={`inline-flex h-8 items-center rounded px-3 text-sm ${v.key === current.key
               ? "bg-ink-900 font-medium text-white" : "border border-steel-300 text-ink-700 hover:bg-steel-100"}`}>
            {v.label}
          </a>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty title="No claims here">
          A claim is filed from the invoice to whoever covers the work, once a
          job covered by a home warranty, a manufacturer or a carrier is billed.
        </Empty>
      ) : (
        <Table label="Claims" head={<>
          <Th>Payer</Th><Th>Their reference</Th><Th>Job</Th><Th>Status</Th>
          <Th className="text-right">Claimed</Th><Th className="text-right">Still expected</Th><Th>Filed</Th>
        </>}>
          {rows.map((claim) => (
            <tr key={claim.id} className="hover:bg-steel-100">
              <Td><a href={`/invoices/claims/${claim.id}`} className="font-medium text-ink-900 hover:underline">{claim.payerName}</a></Td>
              <Td className="font-mono text-xs">{claim.externalReference ?? ""}</Td>
              <Td><a href={`/jobs/${claim.jobId}`} className="tabular-nums hover:underline">{claim.jobNumber}</a></Td>
              <Td><Chip tone={CLAIM_TONE[claim.status]}>{claims.CLAIM_STATUS_LABEL[claim.status]}</Chip></Td>
              <Td className="text-right"><Money value={claim.claimedAmount} /></Td>
              <Td className="text-right"><Money value={claim.outstanding} /></Td>
              <Td className="text-ink-700">{formatIn(claim.submittedAt, user.organizationTimezone)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
