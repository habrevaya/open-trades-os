import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs, customers, commercial, entitlements, NotFoundError } from "@opentradesos/api/services";
import { can, coverage as cov, money, parties as roles, work } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Authorize, Coverage } from "./Commercial";
import { Priority } from "./Priority";
import { Parties } from "./Parties";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td, Empty } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { JOB_STATUS, VISIT_STATUS, JOB_TONE, VISIT_TONE, label, tone } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;

  const ctx = { actor: user.actor, db: getDb() };

  const job = await jobs.get(ctx, { id })
    .catch((error: unknown) => {
      // Out of scope reads as missing, not as forbidden. "You may not see
      // this job" answers a question the caller was not allowed to ask.
      if (error instanceof NotFoundError) notFound();
      throw error;
    });

  const [parties, authorization, entitlement, customer] = await Promise.all([
    commercial.parties(ctx, { jobId: id }),
    commercial.authorizationFor(ctx, { jobId: id }),
    entitlements.forJob(ctx, { jobId: id }),
    customers.get(ctx, { id: job.customerId }),
  ]);
  const writes = can(user.actor, "job:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/jobs">Jobs</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <span className="font-mono tabular-nums text-ink-500">{job.number}</span>{" "}
          {job.summary ?? "Untitled"}
        </h1>
        <Chip tone={tone(JOB_TONE, job.status)}>
          {label(JOB_STATUS, job.status)}
        </Chip>
      </div>

      <Facts>
        {/*
          Hidden when it is normal. Normal is the absence of urgency rather
          than a choice, and a line on every job saying so is a line nobody
          reads. An integer with no scale was worse: this rendered a bare
          "0" for every job in the company.
        */}
        <Fact label="Priority">
          {job.priority === work.NORMAL_PRIORITY ? null : work.priorityLabel(job.priority)}
        </Fact>
        <Fact label="Description">{job.description}</Fact>
        <Fact label="Customer said">{job.customerComplaint}</Fact>
        <Fact label="PO number">{job.purchaseOrderNumber}</Fact>
      </Facts>

      {writes ? <Priority jobId={id} current={job.priority} /> : null}

      {/*
        WHO IS INVOLVED, WHO IS PAYING, AND WHAT THEY AUTHORISED.
        All three are decided before anybody invoices and usually by somebody
        else, and whoever raises the invoice finds out about them by being
        refused, which is the wrong moment unless the job says so first.
      */}
      <h2 className="mt-10 text-base font-semibold">Who is involved</h2>
      {parties.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">
          Nobody named, so the customer is all of them. That is the ordinary
          residential case and nothing about it is missing.
        </p>
      ) : null}

      {/*
        The list or the form, never both. The form carries the same names in
        its own boxes, and a screen that states the same fact twice in two
        shapes is one where the two eventually disagree.
      */}
      {!writes ? (
        parties.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-700">
            {parties.map((row) => (
              <li key={row.party.id}>
                <span className="text-ink-500">{roles.roleLabel(row.party.role)}</span>{" "}
                {row.customerName ?? row.party.externalName}
                {row.party.externalReference ? (
                  <span className="text-ink-500"> ({row.party.externalReference})</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null
      ) : (
        <Parties
          jobId={id}
          customerId={job.customerId}
          customerName={customer.name}
          roles={roles.PARTY_ROLES.map((role) => {
            const held = parties.find((row) => row.party.role === role.key);
            return {
              key: role.key,
              label: role.label,
              meaning: role.meaning,
              current: held
                ? {
                    isCustomer: held.party.customerId !== null,
                    name: held.customerName ?? held.party.externalName ?? "",
                    reference: held.party.externalReference ?? "",
                  }
                : null,
            };
          })}
        />
      )}

      <h2 className="mt-10 text-base font-semibold">Who is paying, and why</h2>
      {entitlement ? (
        <p className="mt-2 text-sm text-ink-700">
          {entitlement.profile.description}
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-500">
          Nobody decided, so the customer is billed for it.
        </p>
      )}

      {writes ? (
        <Coverage
          jobId={id}
          sources={cov.SOURCES.map((key) => ({
            key, label: cov.COVERAGE[key].label, description: cov.COVERAGE[key].description,
          }))}
          current={entitlement
            ? { source: entitlement.source, externalReference: entitlement.externalReference }
            : null}
        />
      ) : null}

      <h2 className="mt-10 text-base font-semibold">Authorised</h2>
      {authorization ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-4 text-sm text-ink-700">
          <span>
            {authorization.amount
              ? <>Up to <Money value={authorization.amount} /></>
              : "No stated limit"}
          </span>
          <span>Billed <Money value={authorization.consumed} /></span>
          {authorization.remaining ? (
            <span className={authorization.remaining === "0.0000" ? "text-red-600" : undefined}>
              <Money value={authorization.remaining} /> left
            </span>
          ) : null}
          {authorization.externalReference ? (
            <span className="text-ink-500">{authorization.externalReference}</span>
          ) : null}
          {authorization.state !== "granted" ? (
            <span className="text-red-600">{authorization.state}</span>
          ) : null}
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-500">
          Nobody set a ceiling, so this job bills what it costs. A commercial
          client who authorised an amount will dispute anything above it.
        </p>
      )}

      {writes ? <Authorize jobId={id} current={authorization
        ? {
            /**
             * Trimmed for the box. The column keeps four decimal places
             * because allocation needs them, and "2500.0000" in an input a
             * person is about to retype is the storage format leaking onto
             * a form.
             */
            amount: authorization.amount ? money.edit(money.money(authorization.amount, "USD")) : null,
            grantedByName: authorization.grantedByName,
            externalReference: authorization.externalReference,
          }
        : null} /> : null}

      <h2 className="mt-10 text-base font-semibold">Visits</h2>
      {job.visits.length === 0 ? (
        <Empty title="Not scheduled yet">
          A job becomes work when it has a visit on the board.
        </Empty>
      ) : (
        <Table head={<><Th className="w-16">#</Th><Th>Window</Th><Th>Status</Th></>}>
          {job.visits.map((visit) => (
            <tr key={visit.id}>
              <Td className="font-mono tabular-nums text-ink-700">{visit.sequence}</Td>
              <Td className="text-ink-700">
                {/*
                  In the company's timezone, always. A dispatcher in Denver
                  looking at a Texas company has to see the window the Texas
                  customer was given, and formatting in the viewer's zone
                  silently shows them a different appointment.
                */}
                {visit.windowStart
                  ? formatIn(visit.windowStart, user.organizationTimezone)
                  : "Unscheduled"}
              </Td>
              <Td>
                <Chip tone={tone(VISIT_TONE, visit.status)}>
                  {label(VISIT_STATUS, visit.status)}
                </Chip>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
