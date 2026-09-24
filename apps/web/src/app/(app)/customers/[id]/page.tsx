import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, jobs, properties as propertyService, contacts as contactService, consent as consentService, customerLifecycle, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Phone } from "@opentradesos/ui";
import { JOB_STATUS, label } from "@/lib/labels";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td, Empty } from "@/components/Table";
import { Money } from "@opentradesos/ui";
import { Consent } from "./Consent";
import { Contacts } from "./Contacts";
import { Lifecycle } from "./Lifecycle";

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

  /**
   * Whether this number may be texted about offers, asked of the same
   * function the sender asks. Reimplementing the rule here is how a screen
   * comes to say yes while the sender says no.
   */
  const contactable = customer.phone && can(user.actor, "message:read")
    ? await consentService.marketable(ctx, { address: customer.phone })
    : null;
  const consentRows = customer.phone && can(user.actor, "message:read")
    ? await consentService.history(ctx, { address: customer.phone })
    : [];

  /**
   * The people at this customer's addresses, and the addresses to attach a
   * new one to. Both behind `customer:read`, which the page already needed
   * to render at all.
   */
  /**
   * Whether this record can go, and what a merge could join it to. Both
   * behind the permissions that do the work, so the section is absent rather
   * than present and refusing.
   */
  const removable = can(user.actor, "customer:delete")
    ? await customerLifecycle.deletability(ctx, { id })
    : null;
  const mergeable = can(user.actor, "customer:merge")
    ? (await customers.list(ctx, { limit: 50, includeInactive: false })).data.filter((row) => row.id !== id)
    : [];

  const people = await contactService.list(ctx, { customerId: id });
  const addresses = can(user.actor, "property:read")
    ? (await propertyService.list(ctx, { limit: 50, customerId: id })).data
    : [];

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
        <Fact label="Phone"><Phone value={customer.phone} /></Fact>
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
        */}
        {seesMoney && customer.discountRate
          ? <Fact label="Discount">{`${(Number(customer.discountRate) * 100).toFixed(0)}%`}</Fact>
          : null}
        {/*
          The balance IS shown now. It used to say here that nothing computed
          one, which stopped being true when `get` started summing the open
          invoices by payer, and a comment explaining an absence outlives the
          absence more reliably than anything else in a file.

          Summed live rather than stored, so it is the invoices talking. It
          is redacted by the same rule as the discount, hence the same guard.
        */}
        {seesMoney && customer.balance != null
          ? <Fact label="Balance"><Money value={customer.balance} /></Fact>
          : null}
      </Facts>

      {addresses.length > 0 && (
        <div className="mt-10">
          <h2 className="text-base font-semibold">Addresses</h2>
          {/*
            Linked now, where the list was only ever a dropdown on the
            contact form. The property page is where the equipment register
            lives, and the register was unreachable from anywhere.
          */}
          <ul className="mt-2 space-y-1 text-sm">
            {addresses.map((property) => (
              <li key={property.id}>
                <a href={`/properties/${property.id}`} className="hover:underline">
                  {[property.addressLine1, property.city].filter(Boolean).join(", ")}
                </a>
                {property.equipmentCount > 0 && (
                  <span className="ml-2 text-xs text-ink-500">
                    {property.equipmentCount === 1
                      ? "1 unit"
                      : `${property.equipmentCount} units`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Contacts
        customerId={id}
        contacts={people}
        properties={addresses.map((property) => ({
          id: property.id,
          label: [property.addressLine1, property.city].filter(Boolean).join(", "),
        }))}
      />

      {(removable || mergeable.length > 0) && (
        <Lifecycle
          id={id}
          name={customer.name}
          deletable={removable?.deletable ?? false}
          blockedBy={removable?.blockedBy ?? []}
          wouldRemove={removable?.wouldRemove ?? []}
          candidates={mergeable.map((row) => ({ id: row.id, name: row.name }))}
        />
      )}

      {contactable ? (
        <Consent
          address={customer.phone!}
          allowed={contactable.allowed}
          reason={contactable.reason}
          hasRecord={consentRows.some((row) => row.current && row.purpose === "marketing")}
        />
      ) : null}

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
              <Td className="text-ink-700">{label(JOB_STATUS, job.status)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
