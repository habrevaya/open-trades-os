import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements, customers, customFields, deposits, estimates, financing, fieldSales, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { CustomFieldsPanel } from "@/components/CustomFieldsPanel";
import { ProposalLayoutPanel } from "./ProposalLayoutPanel";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { ESTIMATE_STATUS, ESTIMATE_TONE, label, tone } from "@/lib/labels";
import { formatDay, formatIn } from "@/lib/dates";
import { Deliveries, EstimateActions, Options, type EstimateView } from "./Panels";
import { actOnEstimate, extendEstimate } from "../actions";
import { ActionForm, TextField } from "@/components/ActionForm";
import { todayIn } from "@/lib/dates";
import { FinancingPanel } from "@/components/FinancingPanel";

export const dynamic = "force-dynamic";

export default async function EstimatePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  const raw = await estimates.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }) as Record<string, unknown>;
  const estimate = raw as unknown as EstimateView & {
    number: number; title: string | null; expiresOn: string | null; signerName: string | null;
    selectedOptionId: string | null;
  };
  const [customer, held, sent] = await Promise.all([
    customers.get(ctx, { id: estimate.customerId }).catch(() => null),
    can(user.actor, "deposit:read") ? deposits.list(ctx, { estimateId: id }).then((r) => r.deposits) : [],
    estimates.deliveries(ctx, { id }),
  ]);
  const chosen = estimate.options.find((o) => o.id === estimate.selectedOptionId);
  const memberIds = estimate.options.flatMap((o) => o.lines)
    .map((l) => l.memberAgreementId).filter((x): x is string => Boolean(x));
  const plans = memberIds.length > 0 && can(user.actor, "customer:read")
    ? await agreements.planNamesFor(ctx, { agreementIds: memberIds })
    : new Map<string, string>();

  /** Financing: a monthly figure per option and every application, once the estimate has gone out. */
  const loan = (estimate as { status: string }).status === "draft" ? null : await financing.forEstimate(ctx, { estimateId: id });
  /** The customer's drawn signature, when they chose and signed on the technician's phone. */
  const signed = await fieldSales.signatureOn(ctx, { subject: "estimate", subjectId: id });
  const offersFinancing = loan !== null && (loan.connected
    ? loan.options.some((o) => o.applicable) || loan.applications.length > 0
    : can(user.actor, "payment:collect"));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/estimates">Estimates</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <span className="font-mono tabular-nums text-ink-500">{estimate.number}</span>{" "}
          {estimate.title ?? "Estimate"}
        </h1>
        <div className="flex items-center gap-3">
          <a href={`/estimates/${id}/proposal`} className="text-sm underline underline-offset-4">Proposal to print</a>
          <a href={`/estimates/${id}/pdf`} className="text-sm underline underline-offset-4">Download PDF</a>
          <Chip tone={tone(ESTIMATE_TONE, estimate.status)}>{label(ESTIMATE_STATUS, estimate.status)}</Chip>
        </div>
      </div>
      <Facts>
        <Fact label="Customer">
          {customer ? <a href={`/customers/${customer.id}`} className="hover:underline">{customer.name}</a> : null}
        </Fact>
        <Fact label="Good until">{estimate.expiresOn ? formatDay(estimate.expiresOn, user.organizationTimezone) : null}</Fact>
        <Fact label="Chosen">{chosen?.name}</Fact>
        <Fact label="Signed by">
          {estimate.signerName}
          {signed?.onSite ? `, on the technician's phone, ${formatIn(signed.signedAt, user.organizationTimezone)}` : null}
          {signed?.imageKey
            ? <> (<a href={`/files/${signed.imageKey}`} className="text-blue-600 underline underline-offset-4">signature</a>)</>
            : null}
        </Fact>
      </Facts>

      {estimate.status === "expired" ? (
        <p role="note" className="mt-4 max-w-prose rounded border border-steel-200 bg-steel-100 p-3 text-sm text-ink-700">
          {estimate.expiresOn ? `This estimate was good until ${formatDay(estimate.expiresOn, user.organizationTimezone)}. ` : ""}
          It is out of the unsold list and cannot be financed. The customer can still say yes, and you can
          still record it below.
        </p>
      ) : null}

      {/*
        Giving the customer longer: the date moves later, with a reason, and
        nothing priced changes. Only while they have it and have not answered.
      */}
      {can(user.actor, "estimate:write") && estimate.expiresOn
        && ["sent", "viewed", "expired"].includes(estimate.status) ? (
          <details className="mt-4 max-w-prose rounded border border-steel-200 bg-canvas p-3">
            <summary className="cursor-pointer text-sm font-medium">Give them longer to answer</summary>
            <ActionForm action={extendEstimate} submit="Move the date" hidden={{ estimateId: id }} className="mt-3 space-y-3">
              <p className="text-sm text-ink-700">
                Only the good until date changes. The prices, the options and the terms stay as they were sent. The link
                they were sent works until the new date.
                The follow up starts again from today, so the customer is chased after the same wait as when it was
                first sent. Tick the box below if you would rather it left them alone.
              </p>
              <TextField label="New good until date" name="expiresOn" type="date" required min={todayIn(user.organizationTimezone)} />
              <TextField label="Why" name="reason" required maxLength={500} placeholder="They asked us to hold the price until their insurer replies." />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="leaveFollowUpAlone" className="mt-1" />
                <span>
                  Leave the follow up alone.
                  <span className="block text-xs text-ink-500">
                    Nobody is texted or emailed about this estimate until you send it again.
                  </span>
                </span>
              </label>
            </ActionForm>
          </details>
        ) : null}

      <Options estimate={estimate} plans={plans} />

      <Deliveries deliveries={sent} when={(at) => formatIn(at, user.organizationTimezone)} />

      <EstimateActions
        action={actOnEstimate}
        estimate={estimate}
        deposits={held.map((d) => ({
          id: d.id, status: d.status, amountRequested: d.amountRequested, amountReceived: d.amountReceived,
        }))}
        contact={{ email: customer?.email ?? null, phone: customer?.phone ?? null }}
        allowed={{
          send: can(user.actor, "estimate:send") && can(user.actor, "portal:grant"),
          deposit: can(user.actor, "deposit:collect"),
          approve: can(user.actor, "estimate:approve"),
          write: can(user.actor, "estimate:write"),
          convert: can(user.actor, "estimate:write") && can(user.actor, "job:write"),
        }}
      />

      {loan && offersFinancing ? (
        <FinancingPanel
          subject={{ estimateId: id }}
          connected={loan.connected}
          lender={loan.lender}
          offers={loan.options.map((o) => ({
            optionId: o.optionId, name: o.name, total: o.total,
            sentence: o.offer?.sentence ?? null, applicable: o.applicable,
          }))}
          applications={loan.applications}
          canSend={can(user.actor, "payment:collect")}
          timezone={user.organizationTimezone}
        />
      ) : null}
      <ProposalLayoutPanel ctx={ctx} estimateId={id} status={estimate.status}
                           canWrite={can(user.actor, "estimate:write")} />
      <CustomFieldsPanel
        entityType="estimate" id={id}
        definitions={await customFields.formFields(ctx, "estimate")}
        values={await customFields.valuesFor(ctx, { entityType: "estimate", id })}
        canWrite={can(user.actor, "estimate:write")}
        back={`/estimates/${id}`}
      />
    </div>
  );
}
