import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs, commercial, entitlements, NotFoundError } from "@opentradesos/api/services";
import { can, coverage as cov, work } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Authorize, Coverage } from "./Commercial";
import { Priority } from "./Priority";
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

  const [parties, authorization, entitlement] = await Promise.all([
    commercial.parties(ctx, { jobId: id }),
    commercial.authorizationFor(ctx, { jobId: id }),
    entitlements.forJob(ctx, { jobId: id }),
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
        WHO IS INVOLVED, AND WHAT THEY AUTHORISED.
        Both decisions are made before anybody invoices and usually by
        somebody else, and whoever raises the invoice finds out about them by
        being refused, which is the wrong moment unless the job says so first.
      */}
      <h2 className="mt-10 text-base font-semibold">Who is paying</h2>
      {parties.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-700">
          {parties.map((row) => (
            <li key={row.party.id}>
              <span className="text-ink-500">{row.party.role.replace(/_/g, " ")}</span>{" "}
              {row.customerName ?? row.party.externalName}
              {row.party.externalReference ? (
                <span className="text-ink-500"> ({row.party.externalReference})</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-500">
          Nobody named, so the customer is all of them. That is the ordinary
          residential case and nothing about it is missing.
        </p>
      )}

      {entitlement ? (
        <p className="mt-2 text-sm text-ink-700">
          {entitlement.profile.description}
        </p>
      ) : null}

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
            amount: authorization.amount,
            grantedByName: null,
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
