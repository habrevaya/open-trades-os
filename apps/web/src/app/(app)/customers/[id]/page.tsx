import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, creditNotes, estimates as estimateService, customers, jobs, properties as propertyService, contacts as contactService, consent as consentService, customerLifecycle, comms, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Phone } from "@opentradesos/ui";
import { JOB_STATUS, INVOICE_STATUS, INVOICE_TONE, ESTIMATE_STATUS, ESTIMATE_TONE, label, tone } from "@/lib/labels";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td, Empty } from "@/components/Table";
import { Money } from "@opentradesos/ui";
import { Consent } from "./Consent";
import { Contacts } from "./Contacts";
import { Lifecycle } from "./Lifecycle";
import { TextCustomer } from "./Messages";
import { ThreadList } from "../../inbox/ThreadList";
import { Payments } from "./Payments";
import { applyHeld, refund } from "../../payments/actions";
import { accountLink, removeCustomer, mergeCustomer } from "./actions";
import { ActionForm } from "@/components/ActionForm";
import { formatDay, todayIn } from "@/lib/dates";
import { CREDIT_STATUS, CREDIT_TONE } from "../../invoices/credit-notes/labels";

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
  /**
   * THE RECORDS THAT LOOK LIKE THIS PERSON, not the first fifty customers.
   *
   * This read used to be `customers.list({ limit: 50 })`, which offered whichever
   * fifty records came back first as things to merge this one into. That is the
   * wrong affordance twice over: the real duplicate is usually not among them, and
   * a dropdown of fifty unrelated people is a dropdown somebody picks the wrong
   * entry from. A merge is irreversible in practice, so the one mistake this
   * control must not make easy is joining two different people.
   *
   * `likelyDuplicates` matches instead of listing: a shared phone, a shared email,
   * or a name close enough that a person should look. Each candidate carries WHY,
   * which is what the operator actually decides on.
   */
  const mergeable = can(user.actor, "customer:merge")
    ? await customerLifecycle.likelyDuplicates(ctx, { id })
    : [];

  /**
   * Everything said to and from them, here rather than only in the inbox,
   * which is the first place somebody looks when the customer rings.
   */
  const conversations = can(user.actor, "message:read")
    ? (await comms.threads(ctx, { limit: 5, customerId: id })).data
    : null;

  const people = await contactService.list(ctx, { customerId: id });
  const invoices = can(user.actor, "invoice:read")
    ? (await billing.list(ctx, { limit: 50, customerId: id })).data
    : null;
  /** Credit given to this customer, and how much of it is still theirs to use. */
  const credits = can(user.actor, "invoice:read")
    ? (await creditNotes.list(ctx, { limit: 50, customerId: id })).data
    : null;
  const creditOnAccount = (credits ?? [])
    .filter((n) => n.status === "open" || n.status === "partially_applied")
    .reduce((sum, n) => sum + Number(n.balance), 0);
  const quotes = can(user.actor, "estimate:read")
    ? (await estimateService.list(ctx, { limit: 50, customerId: id })).data
    : null;
  const paid = can(user.actor, "payment:read")
    ? (await billing.pagePayments(ctx, { limit: 50, customerId: id, unappliedOnly: false })).data
    : null;
  const numberOf = new Map((invoices ?? []).map((inv) => [inv.id, inv.number]));
  const owing = (invoices ?? [])
    .filter((inv) => inv.status === "open" || inv.status === "partially_paid")
    .map((inv) => ({ id: inv.id, number: inv.number, balance: inv.balance ?? "0" }));
  const dayOf = (at: string | Date) =>
    formatDay(todayIn(user.organizationTimezone, new Date(at)), user.organizationTimezone);
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
          removeAction={removeCustomer}
          mergeAction={mergeCustomer}
          id={id}
          name={customer.name}
          deletable={removable?.deletable ?? false}
          blockedBy={removable?.blockedBy ?? []}
          wouldRemove={removable?.wouldRemove ?? []}
          candidates={mergeable.map((row) => ({ id: row.id, name: row.name, because: row.because }))}
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

      {conversations && (
        <div className="mt-10">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">Messages</h2>
            {conversations.length > 0 && (
              <a href={`/inbox?customer=${id}`} className="text-sm text-ink-700 underline underline-offset-4">All of them</a>
            )}
          </div>
          {conversations.length > 0 ? (
            <div className="mt-3"><ThreadList threads={conversations} timezone={user.organizationTimezone} /></div>
          ) : (
            <p className="mt-2 text-sm text-ink-500">No texts with them yet.</p>
          )}
          {can(user.actor, "message:send") && (
            customer.phone
              ? <TextCustomer customerId={id} />
              : <p className="mt-2 text-sm text-ink-500">Add a phone number to text them.</p>
          )}
        </div>
      )}

      <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">Work</h2>
        {can(user.actor, "job:write") && addresses.length > 0 && (
          <a href={`/jobs/new?customer=${id}`}
             className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">
            Book a job
          </a>
        )}
      </div>
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

      {can(user.actor, "portal:grant") && (
        <section aria-label="Their link" className="mt-10">
          <h2 className="text-base font-semibold">Their link</h2>
          <ActionForm action={accountLink} submit="Get their account link" tone="quiet"
                      hidden={{ customerId: id }} className="mt-2 space-y-2" />
        </section>
      )}

      {quotes && (
        <section aria-label="Estimates">
          <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">Estimates</h2>
            {can(user.actor, "estimate:write") && addresses.length > 0 && (
              <a href={`/estimates/new?customer=${id}`}
                 className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
                New estimate
              </a>
            )}
          </div>
          {quotes.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">None yet.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {quotes.map((q) => (
                <li key={q.id as string} className="flex flex-wrap items-center gap-3">
                  <a href={`/estimates/${q.id as string}`} className="hover:underline">
                    <span className="font-mono tabular-nums">{q.number as number}</span> {(q.title as string | null) ?? "Estimate"}
                  </a>
                  <Money value={q.total as string} />
                  <Chip tone={tone(ESTIMATE_TONE, q.status as string)}>{label(ESTIMATE_STATUS, q.status as string)}</Chip>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {paid && (
        <Payments
          customerId={id}
          payments={paid.map((p) => ({
            id: p.id, method: p.method, amount: p.amount ?? "0", refundedAmount: p.refundedAmount ?? "0",
            unappliedAmount: p.unappliedAmount, receivedOn: dayOf(p.receivedAt),
            checkNumber: p.checkNumber ?? null, processorPaymentId: p.processorPaymentId ?? null,
            allocations: p.allocations.map((a) => ({ invoiceNumber: numberOf.get(a.invoiceId) ?? null, amount: a.amount })),
          }))}
          open={owing}
          apply={applyHeld}
          refund={refund}
          canCollect={can(user.actor, "payment:collect")}
          canRefund={can(user.actor, "payment:refund")}
        />
      )}

      {credits && (credits.length > 0 || can(user.actor, "invoice:credit")) && (
        <section aria-label="Credit">
          <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">Credit</h2>
            {can(user.actor, "invoice:credit") && (
              <a href={`/invoices/credit-notes/new?customer=${id}`}
                 className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
                Give a credit
              </a>
            )}
          </div>
          {creditOnAccount > 0 && (
            <p className="mt-2 text-sm text-ink-700">
              <Money value={creditOnAccount.toFixed(2)} /> on account, not yet used against an invoice.
            </p>
          )}
          {credits.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">None given.</p>
          ) : (
            <Table label="Credit notes" head={<><Th className="w-20">Number</Th><Th>Status</Th><Th className="text-right">Credit</Th><Th className="text-right">Unused</Th></>}>
              {credits.map((n) => (
                <tr key={n.id} className="hover:bg-steel-100">
                  <Td className="font-mono tabular-nums">
                    <a href={`/invoices/credit-notes/${n.id}`} className="hover:underline">{n.number}</a>
                  </Td>
                  <Td><Chip tone={tone(CREDIT_TONE, n.status)}>{label(CREDIT_STATUS, n.status)}</Chip></Td>
                  <Td className="text-right"><Money value={n.total} /></Td>
                  <Td className="text-right"><Money value={n.balance} muted={Number(n.balance) === 0} /></Td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      )}

      {invoices && (
        <section aria-label="Invoices">
          <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">Invoices</h2>
            {can(user.actor, "invoice:write") && (
              <a href={`/invoices/new?customer=${id}`}
                 className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
                New invoice
              </a>
            )}
          </div>
          {invoices.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">None yet.</p>
          ) : (
            <Table head={<><Th className="w-20">Number</Th><Th>Status</Th><Th className="text-right">Total</Th><Th className="text-right">Balance</Th></>}>
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-steel-100">
                  <Td className="font-mono tabular-nums">
                    <a href={`/invoices/${inv.id}`} className="hover:underline">{inv.number}</a>
                  </Td>
                  <Td><Chip tone={tone(INVOICE_TONE, inv.status)}>{label(INVOICE_STATUS, inv.status)}</Chip></Td>
                  <Td className="text-right"><Money value={inv.total} /></Td>
                  <Td className="text-right"><Money value={inv.balance} muted={Number(inv.balance) === 0} /></Td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      )}
    </div>
  );
}
