import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { claims as claimService, NotFoundError } from "@opentradesos/api/services";
import { can, claims } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb, Facts, Fact } from "@/components/Detail";
import { ActionForm, TextField, Select, TextArea } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { CLAIM_TONE } from "../labels";
import { decideClaim, recordClaimPayment } from "../actions";

export const dynamic = "force-dynamic";

/**
 * ONE CLAIM
 *
 * What we asked them for, what they agreed, what has arrived, and what is
 * left: the four numbers anybody on the phone with a warranty administrator
 * needs in front of them. Their decision and their money are recorded here;
 * a shortfall they will not pay stays on the invoice, where it is chased or
 * written off like any other balance.
 */
export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const claim = await claimService.get({ actor: user.actor, db: getDb() }, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const decides = can(user.actor, "invoice:write") && (claim.status === "submitted" || claim.status === "approved")
    && claim.paidAmount === "0.0000";
  const collects = can(user.actor, "payment:collect") && claim.status !== "denied" && claim.status !== "paid";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/invoices/claims">Claims</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-semibold">Claim on {claim.payerName}</h1>
        <Chip tone={CLAIM_TONE[claim.status]}>{claims.CLAIM_STATUS_LABEL[claim.status]}</Chip>
      </div>
      <Facts>
        <Fact label="Their reference">{claim.externalReference}</Fact>
        <Fact label="Why they pay">{claim.sourceLabel}</Fact>
        <Fact label="Job"><a href={`/jobs/${claim.jobId}`} className="hover:underline">Job {claim.jobNumber}</a></Fact>
        <Fact label="Invoice"><a href={`/invoices/${claim.invoiceId}`} className="hover:underline">Invoice {claim.invoiceNumber}</a></Fact>
        <Fact label="Claimed"><Money value={claim.claimedAmount} /></Fact>
        <Fact label="Approved">{claim.approvedAmount ? <Money value={claim.approvedAmount} /> : null}</Fact>
        <Fact label="Paid"><Money value={claim.paidAmount} /></Fact>
        <Fact label="Still expected"><Money value={claim.outstanding} /></Fact>
        <Fact label="Filed">{formatIn(claim.submittedAt, user.organizationTimezone)}</Fact>
        <Fact label="Their note">{claim.decisionNote}</Fact>
      </Facts>

      {Number(claim.shortfall) > 0 && (
        <p className="mt-4 rounded-md border border-amber-700/20 bg-amber-tint p-3 text-sm text-ink-900">
          They will not pay <Money value={claim.shortfall} /> of this. It is still on{" "}
          <a href={`/invoices/${claim.invoiceId}`} className="underline">the invoice</a>, to chase or write off there.
        </p>
      )}

      {decides && (
        <section aria-label="Their decision" className="mt-8">
          <h2 className="text-base font-semibold">What they decided</h2>
          <ActionForm action={decideClaim} submit="Record their decision" hidden={{ claimId: claim.id }} done="Recorded.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label="Decision" name="outcome"
                      options={[{ value: "approved", label: "Approved" }, { value: "denied", label: "Denied" }]} />
              <TextField label="Approved for (empty for the full claim)" name="amount" inputMode="decimal" />
              <TextField label="Their reference" name="externalReference" defaultValue={claim.externalReference ?? ""} />
            </div>
            <TextArea label="Their reason, in their words" name="note" rows={2} />
          </ActionForm>
        </section>
      )}

      {collects && (
        <section aria-label="Their payment" className="mt-8">
          <h2 className="text-base font-semibold">Money from them</h2>
          {/*
            Keyed by what is still expected, so the amount box shows the new
            figure after they approve less, rather than the one it was first
            drawn with.
          */}
          <ActionForm key={`${claim.status}:${claim.outstanding}`} action={recordClaimPayment}
                      submit="Record their payment" hidden={{ claimId: claim.id }} done="Recorded.">
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Amount" name="amount" inputMode="decimal" required defaultValue={Number(claim.outstanding).toFixed(2)} />
              <Select label="How" name="method" options={[
                { value: "check", label: "Cheque" }, { value: "ach", label: "Bank transfer" },
                { value: "card", label: "Card" }, { value: "other", label: "Other" },
              ]} />
              <TextField label="Their payment reference" name="reference" />
            </div>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
