import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements, NotFoundError } from "@opentradesos/api/services";
import { can, money, membership } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { formatDay, formatIn } from "@/lib/dates";
import { ActionForm, TextField } from "@/components/ActionForm";
import { PageHeader, Table, Th, Td } from "@/components/Table";
import { VisitActions } from "../VisitActions";
import { BillButton } from "../BillButton";
import { CancelForm } from "../CancelForm";
import { renewAgreement } from "../actions";

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
  /** A term column only once there is more than one term to tell apart. */
  const renewed = agreement.renewalCount > 0;

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

      {/*
        The member benefit, said where somebody looks it up. It is applied to
        estimates and invoices for this customer at this address while the
        agreement is running, as a discount on each line naming this plan.
      */}
      {agreement.discountRate && Number(agreement.discountRate) > 0 ? (
        <p className="mt-2 text-sm text-ink-700">
          Members get {agreements.percentOf(agreement.discountRate)} off eligible work, taken off each line of their
          estimates and invoices{data.leavesOut.length > 0 ? `, except ${data.leavesOut.join(", ")}` : ""}. Fixed when
          this agreement was sold, so a change to the plan does not reach it.
        </p>
      ) : null}
      {/*
        The perks, read from the plan as it stands: they are the company's
        standing promise to everybody on it, which the plan screen says.
      */}
      {plan.priorityDispatch || plan.waivesDiagnosticFee || plan.waivesAfterHoursRate ? (
        <p className="mt-1 text-sm text-ink-700">
          Perks: {[
            plan.priorityDispatch ? "seen first on the board" : null,
            plan.waivesDiagnosticFee ? "no diagnostic fee" : null,
            plan.waivesAfterHoursRate ? "no after hours rate" : null,
          ].filter(Boolean).join(", ")}.
        </p>
      ) : null}
      {writes ? (
        <p className="mt-1 text-sm"><a href={`/agreements/plans/${plan.id}`} className="underline underline-offset-4">The plan</a></p>
      ) : null}

      {agreement.cancellationReason ? (
        <p className="mt-2 text-sm text-ink-700">
          Cancelled{agreement.cancelledOn ? ` on ${formatDay(agreement.cancelledOn, zone)}` : ""}:{" "}
          {agreement.cancellationCode
            ? (membership.CANCELLATION_LABEL[agreement.cancellationCode] === agreement.cancellationReason
              ? agreement.cancellationReason
              : `${membership.CANCELLATION_LABEL[agreement.cancellationCode]}. ${agreement.cancellationReason}`)
            : `${agreement.cancellationReason} (cancelled before reasons were chosen from a list)`}
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
      <Table head={<><Th>Due</Th><Th>Visit</Th>{renewed ? <Th>Term</Th> : null}<Th>State</Th><Th className="text-right">Worth</Th><Th /></>}>
        {data.visits.map((visit) => (
          <tr key={visit.id}>
            <Td className="tabular-nums">{formatDay(visit.dueOn, zone)}</Td>
            <Td className="text-ink-500">{visit.sequence}</Td>
            {renewed ? <Td className="text-ink-500">{visit.term}</Td> : null}
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
              {/*
                Rendered for a skipped visit too, which it was not before.
                The row said "skipped" and offered nothing, so a member
                ringing back to reinstate the visit they cancelled had no
                path through this screen at all.
              */}
              {writes ? (
                <VisitActions
                  agreementId={agreement.id}
                  agreementVisitId={visit.id}
                  booked={visit.jobId !== null}
                  delivered={visit.deliveredOn !== null}
                  skipped={visit.skippedOn !== null}
                  skipReason={visit.skipReason}
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

      <section aria-labelledby="renewal" className="mt-10 border-t border-steel-200 pt-4">
        <h2 id="renewal" className="text-sm font-medium text-ink-700">Renewal</h2>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <dt className="text-ink-500">Term</dt>
          <dd>{agreement.renewalCount + 1}{agreement.lastRenewedOn ? `, renewed ${formatDay(agreement.lastRenewedOn, zone)}` : ""}</dd>
          <dt className="text-ink-500">Renews on its own</dt>
          <dd>
            {/*
              Both switches, because they mean different things and a member
              asking "will I be charged again" needs the one that applies. The
              plan's says the company sells it as continuing; the agreement's
              is this member, and a cancellation turns it off.
            */}
            {plan.autoRenews && agreement.autoRenews
              ? `Yes, on ${agreement.endsOn ? formatDay(agreement.endsOn, zone) : "its end date"}, at the same price`
              : !plan.autoRenews
                ? "No. This plan does not renew on its own, so somebody has to renew it"
                : "No. This member's agreement is set not to"}
          </dd>
          <dt className="text-ink-500">Notice before it ends</dt>
          <dd>
            {plan.renewalNoticeDays <= 0
              ? "The plan owes none"
              : agreement.renewalNoticeSentAt === null
                ? `${plan.renewalNoticeDays} days before the end, the way set under Renewal notices`
                : agreement.renewalNoticeOutcome === "queued"
                  ? `Sent ${formatIn(agreement.renewalNoticeSentAt, zone)}`
                  : agreement.renewalNoticeOutcome?.startsWith("Sent by")
                    ? `${agreement.renewalNoticeOutcome} (${formatIn(agreement.renewalNoticeSentAt, zone)})`
                    : <span className="text-red-600">Could not be sent. {agreement.renewalNoticeOutcome}</span>}
          </dd>
        </dl>
        {writes && (agreement.status === "active" || agreement.status === "lapsed") ? (
          <ActionForm
            action={renewAgreement}
            submit="Renew for another term"
            hidden={{ id: agreement.id }}
            className="mt-3 flex flex-wrap items-end gap-3"
          >
            <TextField
              label="New price, if it changes"
              name="price"
              placeholder={money.edit(money.money(agreement.price))}
              inputMode="decimal"
              className="block w-56"
            />
          </ActionForm>
        ) : null}
        <p className="mt-2 text-xs text-ink-500">
          The next term starts the day this one ends, and owes its own visits and
          instalments. Leave the price blank to keep this member&apos;s price.
        </p>
      </section>

      {data.terms.length > 0 ? (
        <section aria-labelledby="terms" className="mt-10 border-t border-steel-200 pt-4">
          <h2 id="terms" className="text-sm font-medium text-ink-700">Terms</h2>
          {/*
            Breakage, said where it happened. What a term's visits never taken
            were worth is moved from unearned to earned on the day the term
            ends, and never before; the visit stays owed.
          */}
          <p className="mt-1 text-xs text-ink-500">
            When a term ends, the money for any visits they never took is counted as earned. Never before the end.
            Those visits stay on the list if you still want to do them, and doing one later adds nothing to the books.
          </p>
          <Table head={<><Th>Term</Th><Th>Ran</Th><Th>At the end</Th><Th className="text-right">Earned at the end</Th></>}>
            {data.terms.map((t) => (
              <tr key={t.id}>
                <Td>{t.term}</Td>
                <Td className="tabular-nums">
                  {t.startsOn ? `${formatDay(t.startsOn, zone)} to ` : "Until "}{formatDay(t.endsOn, zone)}
                </Td>
                <Td className="text-ink-700">
                  {t.breakageReleasedOn === null
                    ? "Still running"
                    : Number(t.breakageAmount ?? "0") > 0
                      ? `${t.breakageVisits === 1 ? "1 visit" : `${t.breakageVisits ?? 0} visits`} not taken, counted ${formatDay(t.breakageReleasedOn, zone)}`
                      : "Nothing left to count"}
                </Td>
                <Td className="text-right">{t.breakageReleasedOn ? <Money value={t.breakageAmount ?? "0"} /> : null}</Td>
              </tr>
            ))}
          </Table>
        </section>
      ) : null}

      {writes && agreement.status !== "cancelled" ? (
        <div className="mt-10 border-t border-steel-200 pt-4">
          <h2 className="text-sm font-medium text-ink-700">Cancel</h2>
          <p className="mt-1 text-xs text-ink-500">
            Whatever has been billed and not earned is released. Instalments
            nobody has invoiced yet are cancelled; an invoiced one stands,
            because voiding an issued invoice is a decision made on the
            invoice.
          </p>
          <CancelForm id={agreement.id} coversAnAddress={agreement.propertyId !== null} />
        </div>
      ) : null}
    </div>
  );
}
