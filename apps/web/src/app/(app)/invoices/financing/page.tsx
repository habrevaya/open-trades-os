import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { financing } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { FINANCING_TONE } from "@/components/FinancingPanel";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * FINANCING
 *
 * Every loan application customers were sent, where each stands, and, for
 * whoever reads the financial reports, what financing has brought in: the
 * approval rate over the lender's decisions, the volume funded and what the
 * lender kept for it.
 */
export default async function FinancingPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const tz = user.organizationTimezone;

  if (!can(user.actor, "payment:read")) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
        <PageHeader title="Financing" />
        <Empty title="Not shown to your role">Loan applications need the View payments permission.</Empty>
      </div>
    );
  }

  const [{ applications }, report] = await Promise.all([
    financing.list(ctx, { limit: 200 }),
    can(user.actor, "report.financial:read") ? financing.report(ctx, {}) : null,
  ]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Financing" count={applications.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Applications customers were sent from an estimate or an invoice. The status is what the lender last
        said; nothing about a customer&rsquo;s credit is kept beyond it. When a loan is funded the payment is on
        the invoice and the lender&rsquo;s fee is booked as an expense.
      </p>

      {report ? (
        <section aria-label="Financing report" className="mt-6">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Applications">{report.applications}</Stat>
            <Stat label="Approval rate">
              {report.approvalRate === null ? "No decisions yet" : `${report.approvalRate}%`}
              <span className="block text-xs font-normal text-ink-500">of {report.decided} decided</span>
            </Stat>
            <Stat label="Funded"><Money value={report.fundedVolume} /><span className="block text-xs font-normal text-ink-500">{report.fundedCount} loans</span></Stat>
            <Stat label="Lender fees">
              <Money value={report.fees} />
              <span className="block text-xs font-normal text-ink-500">
                {report.feePercent === null ? "" : `${report.feePercent}% of funded`}
                {report.feesUnknown > 0 ? ` ${report.feesUnknown} not reported` : ""}
              </span>
            </Stat>
            <Stat label="Waiting on the customer or lender"><Money value={report.pendingVolume} /></Stat>
            <Stat label="Declined">{report.byStatus.declined}</Stat>
          </dl>
        </section>
      ) : null}

      {applications.length === 0 ? (
        <Empty title="No applications yet">
          Offer financing from an estimate or an invoice once a lender is connected under Settings, Integrations.
        </Empty>
      ) : (
        <Table label="Financing applications" head={
          <><Th>Opened</Th><Th>Customer</Th><Th>For</Th><Th>Status</Th><Th className="text-right">Asked</Th><Th className="text-right">Approved</Th><Th className="text-right">Funded</Th><Th className="text-right">Fee</Th></>
        }>
          {applications.map((a) => (
            <tr key={a.id}>
              <Td>{formatIn(a.createdAt, tz, { dateStyle: "medium" })}</Td>
              <Td>{a.customerName}</Td>
              <Td>
                {a.invoiceId
                  ? <a href={`/invoices/${a.invoiceId}`} className="hover:underline">Invoice {a.invoiceNumber}</a>
                  : <a href={`/estimates/${a.estimateId}`} className="hover:underline">Estimate {a.estimateNumber}</a>}
              </Td>
              <Td>
                <Chip tone={FINANCING_TONE[a.status] ?? "neutral"}>{a.statusLabel}</Chip>
                {a.attention ? <span className="mt-1 block text-xs text-amber-700">{a.attention}</span> : null}
              </Td>
              <Td className="text-right"><Money value={a.amount} /></Td>
              <Td className="text-right">{a.approvedAmount ? <Money value={a.approvedAmount} /> : null}</Td>
              <Td className="text-right">{a.fundedAmount ? <Money value={a.fundedAmount} /> : null}</Td>
              <Td className="text-right">{a.status === "funded" ? (a.feeAmount ? <Money value={a.feeAmount} /> : "Not reported") : null}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-steel-200 p-3">
      <dt className="text-xs uppercase tracking-[0.08em] text-ink-500">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{children}</dd>
    </div>
  );
}
