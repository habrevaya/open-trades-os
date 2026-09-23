import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, jobs, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td, Empty } from "@/components/Table";

export const dynamic = "force-dynamic";

export default async function CustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  /**
   * A record outside the caller's scope is a 404, not a 403.
   *
   * A technician asking for a customer they were never sent to must not be
   * told that the customer exists. "Forbidden" answers the question they were
   * not allowed to ask.
   */
  const customer = await customers.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const work = await jobs.list(ctx, { limit: 20, customerId: id });
  const seesMoney = can(user.actor, "customer.financials:read");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/customers">Customers</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">{customer.name}</h1>
        <Chip tone={customer.type === "commercial" ? "info" : "neutral"}>
          {customer.type === "commercial" ? "Commercial" : "Residential"}
        </Chip>
      </div>

      <Facts>
        <Fact label="Phone">
          {customer.phone ? <span className="font-mono">{customer.phone}</span> : null}
        </Fact>
        <Fact label="Email">{customer.email}</Fact>
        <Fact label="Payment terms">
          {/* Stored as a decimal string, like every other number that has to
              survive a round trip without a float rounding it. */}
          {Number(customer.paymentTermsDays) === 0
            ? "Due on receipt"
            : `Net ${customer.paymentTermsDays}`}
        </Fact>
        <Fact label="Lead source">{customer.leadSource}</Fact>
        {/*
          The discount rate is stripped by the service for anyone without
          customer.financials:read, so this check is not the guard: it is what
          stops the page rendering an empty heading where a number the caller
          may not see would have gone.

          A balance would belong here and is not shown, because nothing
          computes one yet and a hardcoded zero on a customer record is worse
          than an absent row: somebody will believe it.
        */}
        {seesMoney && customer.discountRate
          ? <Fact label="Discount">{`${(Number(customer.discountRate) * 100).toFixed(0)}%`}</Fact>
          : null}
      </Facts>

      <h2 className="mt-10 text-base font-semibold">Work</h2>
      {work.data.length === 0 ? (
        <Empty title="No jobs for this customer yet" />
      ) : (
        <Table head={<><Th className="w-20">Number</Th><Th>Summary</Th><Th>Status</Th></>}>
          {work.data.map((job) => (
            <tr key={job.id} className="hover:bg-steel-100">
              <Td className="font-mono tabular-nums text-ink-700">{job.number}</Td>
              <Td>
                <a href={`/jobs/${job.id}`} className="font-medium hover:underline">
                  {job.summary ?? "Untitled"}
                </a>
              </Td>
              <Td className="text-ink-700">{job.status}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
