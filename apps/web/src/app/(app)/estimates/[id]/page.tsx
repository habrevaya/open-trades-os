import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, deposits, estimates, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { ESTIMATE_STATUS, ESTIMATE_TONE, label, tone } from "@/lib/labels";
import { formatDay } from "@/lib/dates";
import { EstimateActions, Options, type EstimateView } from "./Panels";
import { actOnEstimate } from "../actions";

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
  const [customer, held] = await Promise.all([
    customers.get(ctx, { id: estimate.customerId }).catch(() => null),
    can(user.actor, "deposit:read") ? deposits.list(ctx, { estimateId: id }).then((r) => r.deposits) : [],
  ]);
  const chosen = estimate.options.find((o) => o.id === estimate.selectedOptionId);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/estimates">Estimates</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <span className="font-mono tabular-nums text-ink-500">{estimate.number}</span>{" "}
          {estimate.title ?? "Estimate"}
        </h1>
        <Chip tone={tone(ESTIMATE_TONE, estimate.status)}>{label(ESTIMATE_STATUS, estimate.status)}</Chip>
      </div>
      <Facts>
        <Fact label="Customer">
          {customer ? <a href={`/customers/${customer.id}`} className="hover:underline">{customer.name}</a> : null}
        </Fact>
        <Fact label="Good until">{estimate.expiresOn ? formatDay(estimate.expiresOn, user.organizationTimezone) : null}</Fact>
        <Fact label="Chosen">{chosen?.name}</Fact>
        <Fact label="Signed by">{estimate.signerName}</Fact>
      </Facts>

      <Options estimate={estimate} />

      <EstimateActions
        action={actOnEstimate}
        estimate={estimate}
        deposits={held.map((d) => ({
          id: d.id, status: d.status, amountRequested: d.amountRequested, amountReceived: d.amountReceived,
        }))}
        allowed={{
          send: can(user.actor, "estimate:send") && can(user.actor, "portal:grant"),
          deposit: can(user.actor, "deposit:collect"),
          approve: can(user.actor, "estimate:approve"),
          write: can(user.actor, "estimate:write"),
          convert: can(user.actor, "estimate:write") && can(user.actor, "job:write"),
        }}
      />
    </div>
  );
}
