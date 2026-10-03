import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements, customers, priceBook, properties, NotFoundError } from "@opentradesos/api/services";
import { assertCan, can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { EstimateComposer } from "../Composer";
import { writeEstimate } from "../actions";

export const dynamic = "force-dynamic";

/** A NEW ESTIMATE for a customer, at one of their addresses. */
export default async function NewEstimatePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; property?: string; job?: string }>;
}) {
  const user = await requireSetupUser();
  assertCan(user.actor, "estimate:write");
  const ctx = { actor: user.actor, db: getDb() };
  const { customer: customerId, property, job } = await searchParams;
  if (!customerId) notFound();
  const customer = await customers.get(ctx, { id: customerId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const addresses = (await properties.list(ctx, { limit: 50, customerId })).data;
  /**
   * Said before the save, so nobody is surprised by a total lower than the
   * lines they typed: which addresses are covered by a plan with a discount,
   * and how much it takes off. The service applies it either way.
   */
  const members = can(user.actor, "customer:read")
    ? (await Promise.all(addresses.map(async (p) => ({
      address: [p.addressLine1, p.city].filter(Boolean).join(", "),
      pricing: await agreements.memberPricing(ctx, { customerId, propertyId: p.id }),
    })))).filter((m) => m.pricing.applies)
    : [];
  const items = can(user.actor, "pricebook:read")
    ? (await priceBook.list(ctx, { limit: 200, includeInactive: false })).data
      .map((i) => ({ id: i.id, name: i.name, price: i.price }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={`/customers/${customerId}`}>{customer.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">New estimate for {customer.name}</h1>
      {members.length > 0 ? (
        <p role="note" className="mt-3 rounded border border-steel-200 bg-canvas-raised p-3 text-sm text-ink-700">
          {customer.name} is a member.{" "}
          {members.map((m) => `${m.pricing.planName} takes ${m.pricing.percent} off each eligible line at ${m.address}.`).join(" ")}
          {" "}It is taken off when the estimate is saved and shown on each line.
        </p>
      ) : null}
      {addresses.length === 0 ? (
        <p className="mt-4 text-sm text-ink-700">
          An estimate is for work at an address, and {customer.name} has none on file yet.
        </p>
      ) : (
        <EstimateComposer
          action={writeEstimate}
          hidden={{ customerId, ...(job ? { jobId: job } : {}) }}
          properties={addresses.map((p) => ({ id: p.id, label: [p.addressLine1, p.city].filter(Boolean).join(", ") }))}
          defaultPropertyId={property}
          items={items}
        />
      )}
    </div>
  );
}
