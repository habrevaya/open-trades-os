import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { formatDay } from "@/lib/dates";
import { PageHeader, Table, Th, Td } from "@/components/Table";
import { VisitActions } from "../VisitActions";
import { BillButton } from "../BillButton";
import { CancelForm } from "../CancelForm";

export const dynamic = "force-dynamic";

const BILLING_TONE = {
  scheduled: "neutral", invoiced: "info", paid: "success",
  failed: "danger", skipped: "neutral", cancelled: "neutral",
} as const;

/**
 * One agreement: what it owes, what it bills, and what is still unearned.
 *
 * The two schedules are shown side by side and separately on purpose. A
 * customer can pay monthly and be visited twice a year, and every product
 * that ties the two together breaks the moment somebody prepays annually.
 */
export default async function AgreementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "membership:read")) notFound();

  let data;
  try {
    data = await agreements.get(ctx, { id });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const writes = can(user.actor, "membership:write");
  const { agreement, plan } = data;
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <a href="/agreements" className="text-sm text-ink-500 hover:underline">Agreements</a>
      <div className="mt-2">
        <PageHeader title={data.customerName} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-ink-700">
        <Chip tone={agreement.status === "active" ? "success" : "neutral"}>
          {agreement.status.replace(/_/g, " ")}
        </Chip>
        <span>{plan.name}</span>
        <span>
          {formatDay(agreement.startedOn, zone)}
          {agreement.endsOn ? ` to ${formatDay(agreement.endsOn, zone)}` : ""}
        </span>
        <span><Money value={agreement.price} /> {agreement.billingFrequency.replace(/_/g, " ")}</span>
      </div>

      {agreement.cancellationReason ? (
        <p className="mt-2 text-sm text-ink-700">
          Cancelled{agreement.cancelledOn ? ` on ${formatDay(agreement.cancelledOn, zone)}` : ""}:{" "}
          {agreement.cancellationReason}
        </p>
      ) : null}

      <div className="mt-4 rounded-md border border-steel-200 bg-canvas p-4">
        {/*
          Money billed is not money earned. Twelve months collected up front
          is a liability that unwinds as visits are delivered, and a company
          that recognises it on receipt shows a spectacular month followed by
          eleven months of servicing work with no revenue attached.
        */}
        <p className="text-sm text-ink-500">Billed and not yet earned</p>
        <p className="mt-1 text-2xl font-semibold"><Money value={data.unearned} /></p>
      </div>

      <h2 className="mt-8 text-sm font-medium text-ink-700">What we owe them</h2>
      <p className="mt-1 text-xs text-ink-500">
        These exist from the moment the agreement was sold, not from when
        somebody remembers. That is the difference between a book that renews
        and one that quietly does not.
      </p>
      <Table head={<><Th>Due</Th><Th>Visit</Th><Th>State</Th><Th className="text-right">Worth</Th><Th /></>}>
        {data.visits.map((visit) => (
          <tr key={visit.id}>
            <Td className="tabular-nums">{formatDay(visit.dueOn, zone)}</Td>
            <Td className="text-ink-500">{visit.sequence}</Td>
            <Td>
              {visit.deliveredOn
                ? <Chip tone="success">delivered</Chip>
                : visit.skippedOn
                  ? <Chip tone="neutral">skipped</Chip>
                  : visit.jobId
                    ? <a href={`/jobs/${visit.jobId}`} className="text-ink-700 hover:underline">booked</a>
                    : <Chip tone="warning">owed</Chip>}
            </Td>
            <Td className="text-right"><Money value={visit.recognitionAmount} /></Td>
            <Td>
              {writes && !visit.skippedOn ? (
                <VisitActions
                  agreementId={agreement.id}
                  agreementVisitId={visit.id}
                  booked={visit.jobId !== null}
                  delivered={visit.deliveredOn !== null}
                />
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>

      <h2 className="mt-10 text-sm font-medium text-ink-700">What they pay</h2>
      <p className="mt-1 text-xs text-ink-500">
        A separate schedule, deliberately. Pay monthly, visited twice a year.
      </p>
      <Table head={<><Th>Due</Th><Th>Instalment</Th><Th>State</Th><Th className="text-right">Amount</Th><Th /></>}>
        {data.billing.map((instalment) => (
          <tr key={instalment.id}>
            <Td className="tabular-nums">{formatDay(instalment.dueOn, zone)}</Td>
            <Td className="text-ink-500">{instalment.sequence}</Td>
            <Td>
              {instalment.invoiceId ? (
                <a href={`/invoices/${instalment.invoiceId}`} className="text-ink-700 hover:underline">
                  {instalment.status}
                </a>
              ) : (
                <Chip tone={BILLING_TONE[instalment.status]}>{instalment.status}</Chip>
              )}
            </Td>
            <Td className="text-right"><Money value={instalment.amount} /></Td>
            <Td>
              {writes && instalment.status === "scheduled" ? (
                <BillButton agreementId={agreement.id} agreementBillingId={instalment.id} />
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>

      {writes && agreement.status !== "cancelled" ? (
        <div className="mt-10 border-t border-steel-200 pt-4">
          <h2 className="text-sm font-medium text-ink-700">Cancel</h2>
          <p className="mt-1 text-xs text-ink-500">
            Whatever has been billed and not earned is released. Instalments
            nobody has invoiced yet are cancelled; an invoiced one stands,
            because voiding an issued invoice is a decision made on the
            invoice.
          </p>
          <CancelForm id={agreement.id} />
        </div>
      ) : null}
    </div>
  );
}
