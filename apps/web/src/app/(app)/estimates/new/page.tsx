import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, priceBook, properties, NotFoundError } from "@opentradesos/api/services";
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
  const items = can(user.actor, "pricebook:read")
    ? (await priceBook.list(ctx, { limit: 200, includeInactive: false })).data
      .map((i) => ({ id: i.id, name: i.name, price: i.price }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={`/customers/${customerId}`}>{customer.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">New estimate for {customer.name}</h1>
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
